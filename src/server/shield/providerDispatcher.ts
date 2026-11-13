import type { AuditService } from "./auditService.js";
import { applyProviderView, toBlockOrder, type ShieldOrder } from "./judicialTypes.js";
import type { OrderRepository } from "./persistence/types.js";
import { SimulatorHttpError } from "./qualydataClient.js";
import { juecesDeTurno } from "./shiftGuard.js";
import type { BlockOrder, OrderAccepted, Provider, ProviderOrder, Shift, SimulatorState } from "./types.js";

// ISP fan-out (spec §10, S5 brief). Watches pendiente_envio orders and POSTs the
// exact 8-field contract to each provider. Parallel ACROSS providers — a slow
// ISP never stalls the others — with bounded concurrency inside each provider.
//
// Hard gates enforced here, independently of upstream policy:
//   - capability: a provider never receives a tipo outside its capacidades;
//   - vence_min: always the INTEGER fin_min of the current /estado — a stale
//     order is held terminally instead of sending a wrong expiry;
//   - shift: the signing judge must STILL be on shift at send time. Out of
//     shift with no later window -> bloqueada_turno, requires re-approval;
//   - idempotency: each orden_id POSTs once. A 409 means the provider already
//     has it -> adopt remote truth instead of retrying; a persisted `enviada`
//     is reconciled by the status tracker (remote 404 -> back to pendiente).
//
// Contract 4xx (non-409) marks rechazada_proveedor and is never retried
// blindly — the order is wrong by contract, not by luck.

/** Simulator surface the dispatcher consumes; QualyDataClient satisfies it. */
export interface DispatchSimApi {
    estado(): Promise<SimulatorState>;
    proveedores(): Promise<Provider[]>;
    enviarOrden(proveedorId: string, orden: BlockOrder): Promise<OrderAccepted>;
    /** Needed to adopt provider truth after a duplicate (409) response. */
    orden(proveedorId: string, ordenId: string): Promise<ProviderOrder>;
}

export interface ProviderDispatcherDeps {
    orders: OrderRepository;
    client: DispatchSimApi;
    audit: AuditService;
    /** Shift table provider — the signing bundle's turnos. */
    turnos: () => Shift[];
    /** Max concurrent POSTs inside ONE provider; providers always run in parallel. */
    maxConcurrentPorProveedor?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
    now?: () => Date;
}

export class ProviderDispatcher {
    private readonly orders: OrderRepository;
    private readonly client: DispatchSimApi;
    private readonly audit: AuditService;
    private readonly turnos: () => Shift[];
    private readonly maxConcurrent: number;
    private readonly intervalMs: number;
    private readonly onError: (error: unknown) => void;
    private readonly now: () => Date;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    /** Orders already audited for a non-terminal hold — avoids audit spam per cycle. */
    private readonly holdAudited = new Set<string>();

    constructor(deps: ProviderDispatcherDeps) {
        this.orders = deps.orders;
        this.client = deps.client;
        this.audit = deps.audit;
        this.turnos = deps.turnos;
        this.maxConcurrent = deps.maxConcurrentPorProveedor ?? 3;
        this.intervalMs = deps.intervalMs ?? 700;
        this.onError = deps.onError ?? ((error) => console.error("[providerDispatcher] cycle failed:", error));
        this.now = deps.now ?? (() => new Date());
    }

    get isRunning(): boolean {
        return this.running;
    }

    /**
     * One dispatch cycle. Groups due pendiente_envio orders per provider and
     * fans them out in parallel across providers, bounded inside each one.
     */
    async cycleOnce(): Promise<void> {
        const estado = await this.client.estado();
        const providers = new Map((await this.client.proveedores()).map((p) => [p.id, p]));
        const nowMs = this.now().getTime();
        const pendientes = (await this.orders.listByEstado("pendiente_envio")).filter(
            (order) => order.final !== true && (order.proximo_intento_ms === undefined || order.proximo_intento_ms <= nowMs),
        );

        const porProveedor = new Map<string, ShieldOrder[]>();
        for (const order of pendientes) {
            const group = porProveedor.get(order.proveedor_id) ?? [];
            group.push(order);
            porProveedor.set(order.proveedor_id, group);
        }

        await Promise.all(
            [...porProveedor.entries()].map(([proveedorId, group]) =>
                this.dispatchGroup(proveedorId, group, providers, estado),
            ),
        );
    }

    private async dispatchGroup(
        proveedorId: string,
        group: ShieldOrder[],
        providers: Map<string, Provider>,
        estado: SimulatorState,
    ): Promise<void> {
        let index = 0;
        const workers = Array.from({ length: Math.min(this.maxConcurrent, group.length) }, async () => {
            while (index < group.length) {
                const order = group[index++];
                try {
                    await this.dispatchOne(order, providers.get(proveedorId), estado);
                } catch (error) {
                    this.onError(error);
                }
            }
        });
        await Promise.all(workers);
    }

    private async dispatchOne(
        order: ShieldOrder,
        provider: Provider | undefined,
        estado: SimulatorState,
    ): Promise<void> {
        const minuto = estado.minuto_actual;
        const finMin = Math.floor(estado.fin_min);

        if (!provider) {
            await this.reject(order, "proveedor_desconocido", minuto);
            return;
        }
        if (!provider.capacidades.includes(order.tipo)) {
            await this.reject(order, `tipo_no_soportado:${order.tipo}`, minuto);
            return;
        }
        if (order.vence_min !== finMin) {
            await this.holdTerminal(order, minuto, `vence_distinto_de_fin_min:${order.vence_min}!=${finMin}`);
            return;
        }
        if (minuto >= order.vence_min || estado.finalizado) {
            await this.holdTerminal(order, minuto, "vence_min_alcanzado");
            return;
        }
        if (!juecesDeTurno(minuto, this.turnos()).includes(order.juez_id)) {
            if (this.hasFutureWindow(order, minuto)) {
                await this.auditHold(order, minuto, "juez_fuera_de_turno_espera_ventana");
            } else {
                order.estado = "bloqueada_turno";
                order.final = true;
                order.motivo = "juez_fuera_de_turno_sin_ventana_restante";
                await this.orders.save(order);
                await this.safeAudit({
                    evento: "orden_bloqueada_turno",
                    minSim: minuto,
                    expedienteId: order.expediente_id,
                    correlationId: `orden:${order.orden_id}`,
                    datos: { orden_id: order.orden_id, proveedor_id: order.proveedor_id, juez_id: order.juez_id },
                });
            }
            return;
        }

        order.estado = "enviada";
        order.enviada_min = minuto;
        await this.orders.save(order);
        await this.safeAudit({
            evento: "orden_despachada",
            minSim: minuto,
            expedienteId: order.expediente_id,
            correlationId: `orden:${order.orden_id}`,
            datos: {
                orden_id: order.orden_id,
                proveedor_id: order.proveedor_id,
                tipo: order.tipo,
                objetivo: order.objetivo,
                intento: order.intento ?? 1,
            },
        });

        try {
            await this.client.enviarOrden(order.proveedor_id, toBlockOrder(order));
            order.estado = "recibida";
            order.recibida_min = minuto;
            await this.orders.save(order);
            await this.safeAudit({
                evento: "orden_recibida",
                minSim: minuto,
                expedienteId: order.expediente_id,
                correlationId: `orden:${order.orden_id}`,
                datos: { orden_id: order.orden_id, proveedor_id: order.proveedor_id, recibida_min: minuto },
            });
        } catch (error) {
            if (error instanceof SimulatorHttpError) {
                if (error.status === 409) {
                    // Duplicate means the provider already accepted this orden_id:
                    // adopt its truth instead of inventing a rejection.
                    await this.adoptRemote(order, minuto);
                    return;
                }
                const motivo = httpMotivo(error) ?? `http_${error.status}`;
                await this.reject(order, motivo, minuto);
                return;
            }
            // Network/validation outcome is ambiguous — the POST may have landed.
            // Leave `enviada`; the status tracker reconciles it against the provider.
            this.onError(error);
        }
    }

    /** 409 -> GET the remote order and mirror whatever the provider reports. */
    private async adoptRemote(order: ShieldOrder, minuto: number): Promise<void> {
        try {
            const remote = await this.client.orden(order.proveedor_id, order.orden_id);
            applyProviderView(order, remote);
            if (order.estado === "enviada") order.estado = "recibida";
            await this.orders.save(order);
            await this.safeAudit({
                evento: "orden_estado_recuperado",
                minSim: minuto,
                expedienteId: order.expediente_id,
                correlationId: `orden:${order.orden_id}`,
                datos: {
                    orden_id: order.orden_id,
                    proveedor_id: order.proveedor_id,
                    motivo: "duplicada_orden_id_adoptada",
                    estado_remoto: remote.estado,
                },
            });
        } catch (error) {
            this.onError(error);
        }
    }

    /** Contract rejection: terminal for this order, never silently retried. */
    private async reject(order: ShieldOrder, motivo: string, minuto: number): Promise<void> {
        order.estado = "rechazada_proveedor";
        order.final = true;
        order.motivo = motivo;
        await this.orders.save(order);
        await this.safeAudit({
            evento: "orden_rechazada_proveedor",
            minSim: minuto,
            expedienteId: order.expediente_id,
            correlationId: `orden:${order.orden_id}`,
            datos: { orden_id: order.orden_id, proveedor_id: order.proveedor_id, motivo },
        });
    }

    /**
     * Terminal local hold: the order can never be sent as composed (expiry or
     * contract mismatch). Stays pendiente_envio+final so the record keeps saying
     * "never dispatched" — the aggregate treats it as a failed slot.
     */
    private async holdTerminal(order: ShieldOrder, minuto: number, motivo: string): Promise<void> {
        order.final = true;
        order.motivo = motivo;
        await this.orders.save(order);
        await this.safeAudit({
            evento: "orden_no_despachada",
            minSim: minuto,
            expedienteId: order.expediente_id,
            correlationId: `orden:${order.orden_id}`,
            datos: { orden_id: order.orden_id, proveedor_id: order.proveedor_id, motivo },
        });
    }

    /** The signing judge will be on shift again before this order expires. */
    private hasFutureWindow(order: ShieldOrder, minuto: number): boolean {
        return this.turnos().some(
            (turno) =>
                turno.juez_id === order.juez_id && turno.hasta_min > minuto && turno.desde_min < order.vence_min,
        );
    }

    /** Non-terminal hold (judge between windows): audit once per order, keep pending. */
    private async auditHold(order: ShieldOrder, minuto: number, motivo: string): Promise<void> {
        if (this.holdAudited.has(order.orden_id)) return;
        this.holdAudited.add(order.orden_id);
        await this.safeAudit({
            evento: "orden_no_despachada",
            minSim: minuto,
            expedienteId: order.expediente_id,
            correlationId: `orden:${order.orden_id}`,
            datos: { orden_id: order.orden_id, proveedor_id: order.proveedor_id, motivo },
        });
    }

    private async safeAudit(entry: Parameters<AuditService["append"]>[0]): Promise<void> {
        await this.audit.append(entry).catch(() => {});
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        void this.loop();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                await this.cycleOnce();
            } catch (error) {
                this.onError(error);
            }
            if (!this.running) break;
            await new Promise<void>((resolve) => {
                this.timer = setTimeout(() => {
                    this.timer = null;
                    resolve();
                }, this.intervalMs);
            });
        }
    }
}

/** Extracts the provider's {error} message from an HTTP rejection body. */
function httpMotivo(error: SimulatorHttpError): string | null {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body) {
        const motivo = (body as { error?: unknown }).error;
        if (typeof motivo === "string" && motivo.length > 0) return motivo;
    }
    return null;
}
