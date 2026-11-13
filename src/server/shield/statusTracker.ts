import type { AuditService } from "./auditService.js";
import { CaseService } from "./caseService.js";
import { TRANSICIONES_EXPEDIENTE, type EstadoExpediente } from "./expedienteTypes.js";
import { applyProviderView, type ShieldOrder } from "./judicialTypes.js";
import type { CaseRepository, OrderRepository } from "./persistence/types.js";
import { SimulatorHttpError } from "./qualydataClient.js";
import { juecesDeTurno } from "./shiftGuard.js";
import { SigningService } from "./signingService.js";
import type { ProviderOrder, SimulatorState } from "./types.js";

// Order status tracking (spec §10, S5 brief §2-§3-§5). Polls the provider-side
// lifecycle of every non-terminal order and mirrors it into orders.json —
// `recibida` is NEVER promoted to aplicada without the poll confirming it
// (TEST 06). On `fallida` it composes a RETRY: new orden_id (…-NN+1), new HMAC
// signature by the SAME approving judge — only while he is still on shift;
// otherwise the slot is closed demanding a fresh approval. Backoff is bounded
// real-time and retries never happen past fin_min.
//
// The expiry watcher lives here: past fin_min the simulator flips aplicada ->
// vencida and this poll observes it (never a local guess). At fin_min+GRACE a
// check asserts zero tipo=ip orders remain applied (TEST 12).
//
// It also folds per-order truth into the expediente aggregate state:
// aprobado -> distribuyendo (first send) -> parcial (>=1 aplicada) -> aplicado
// (every possible slot applied) -> vencido/levantado (all slots terminal).

/** Simulator surface the tracker consumes; QualyDataClient satisfies it. */
export interface TrackerSimApi {
    estado(): Promise<SimulatorState>;
    orden(proveedorId: string, ordenId: string): Promise<ProviderOrder>;
    /**
     * Optional per-provider batch listing (GET /proveedores/<id>/ordenes).
     * When present the tracker fetches ONE list per provider per cycle instead
     * of one request per live order — the resource-constrained simulator drops
     * connections under the per-order burst (observed ECONNREFUSED floods in
     * e2e), so the batch path materially reduces the failure surface.
     */
    ordenes?(proveedorId: string): Promise<ProviderOrder[]>;
}

export const DEFAULT_MAX_INTENTOS = 4;
export const DEFAULT_RETRY_DELAY_MS = 2_500;
export const DEFAULT_GRACE_MIN = 5;
/**
 * Sim-minutes an `enviada` order may be absent from the provider before the
 * tracker requeues it. The dispatcher saves enviada BEFORE the POST lands, so
 * an in-flight POST legitimately looks "missing remotely" — requeueing inside
 * this window duplicates the POST (the provider may then 409 it, but the
 * duplicate network call and stale-write regression already happened).
 */
export const DEFAULT_ENVIADA_REQUEUE_GRACE_MIN = 2;

/** Slot identity: one block target at one provider inside one expediente. */
function slotKey(order: Pick<ShieldOrder, "expediente_id" | "proveedor_id" | "objetivo">): string {
    return `${order.expediente_id}|${order.proveedor_id}|${order.objetivo}`;
}

/** Attempt number from the trailing -NN suffix of orden_id (`ord-<exp>-<isp>-02` -> 2). */
export function intentoDe(ordenId: string): number {
    const match = /-(\d+)$/.exec(ordenId);
    return match ? Number(match[1]) : 1;
}

export interface OrderStatusTrackerDeps {
    orders: OrderRepository;
    cases: CaseRepository;
    caseService: CaseService;
    client: TrackerSimApi;
    signing: SigningService;
    audit: AuditService;
    /** Judges on shift at a simulated minute — same table the guard uses. */
    turnos: () => { juez_id: string; desde_min: number; hasta_min: number }[];
    maxIntentos?: number;
    /** Real-ms base backoff; attempt n waits n*retryDelayMs before dispatch. */
    retryDelayMs?: number;
    /** Grace window after fin_min for the zero-ip-active check (TEST 12). */
    graceMin?: number;
    /** Sim-minutes an enviada order may be remote-missing before requeue. */
    enviadaRequeueGraceMin?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
    now?: () => Date;
}

export interface GraceReport {
    verificado: boolean;
    minuto: number | null;
    ipActivas: Array<{ orden_id: string; proveedor_id: string; objetivo: string }>;
}

export class OrderStatusTracker {
    private readonly orders: OrderRepository;
    private readonly cases: CaseRepository;
    private readonly caseService: CaseService;
    private readonly client: TrackerSimApi;
    private readonly signing: SigningService;
    private readonly audit: AuditService;
    private readonly turnos: () => { juez_id: string; desde_min: number; hasta_min: number }[];
    private readonly maxIntentos: number;
    private readonly retryDelayMs: number;
    private readonly graceMin: number;
    private readonly enviadaRequeueGraceMin: number;
    private readonly intervalMs: number;
    private readonly onError: (error: unknown) => void;
    private readonly now: () => Date;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inCycle = false;
    private graceChecked = false;
    /** Expedientes already audited for an order-composition anomaly. */
    private readonly anomalyAudited = new Set<string>();
    private graceResult: GraceReport = { verificado: false, minuto: null, ipActivas: [] };

    constructor(deps: OrderStatusTrackerDeps) {
        this.orders = deps.orders;
        this.cases = deps.cases;
        this.caseService = deps.caseService;
        this.client = deps.client;
        this.signing = deps.signing;
        this.audit = deps.audit;
        this.turnos = deps.turnos;
        this.maxIntentos = deps.maxIntentos ?? DEFAULT_MAX_INTENTOS;
        this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.graceMin = deps.graceMin ?? DEFAULT_GRACE_MIN;
        this.enviadaRequeueGraceMin = deps.enviadaRequeueGraceMin ?? DEFAULT_ENVIADA_REQUEUE_GRACE_MIN;
        this.intervalMs = deps.intervalMs ?? 800;
        this.onError = deps.onError ?? ((error) => console.error("[statusTracker] cycle failed:", error));
        this.now = deps.now ?? (() => new Date());
    }

    get isRunning(): boolean {
        return this.running;
    }

    /** Post-grace residual check — the E2E report and tests read this. */
    get graceReport(): GraceReport {
        return this.graceResult;
    }

    /**
     * One tracking cycle: poll every live order, resolve retries for failed
     * slots, fold the aggregate into each open expediente, run the grace check.
     */
    async cycleOnce(): Promise<void> {
        // Reentrancy guard: the loop awaits each cycle, but cycleOnce is public
        // (scripts/tests call it directly) and overlapping cycles could double-
        // process the same orders (e.g. two retries spawned for one slot).
        if (this.inCycle) return;
        this.inCycle = true;
        try {
            await this.runCycle();
        } finally {
            this.inCycle = false;
        }
    }

    private async runCycle(): Promise<void> {
        const estado = await this.client.estado();
        const minuto = estado.minuto_actual;

        // 1) Provider truth for every non-terminal sent order.
        const all = await this.orders.list();
        const vivas = all.filter((o) => o.estado === "enviada" || o.estado === "recibida" || o.estado === "aplicada");
        if (this.client.ordenes) {
            // Batch path: one request per provider, orders matched by orden_id.
            // A missing orden_id in the list is the 404 equivalent.
            const byProvider = new Map<string, ShieldOrder[]>();
            for (const order of vivas) {
                const list = byProvider.get(order.proveedor_id) ?? [];
                list.push(order);
                byProvider.set(order.proveedor_id, list);
            }
            await Promise.all(
                [...byProvider].map(async ([proveedorId, orders]) => {
                    let remoteList: ProviderOrder[];
                    try {
                        remoteList = await this.client.ordenes!(proveedorId);
                    } catch (error) {
                        this.onError(error);
                        // Batch failed (outage OR one schema-invalid row in the
                        // list, which rejects the whole array): fall back to the
                        // per-order path so a single bad row cannot stall every
                        // order at this provider.
                        for (const order of orders) {
                            try {
                                await this.pollOrder(order, minuto);
                            } catch (pollError) {
                                this.onError(pollError);
                            }
                        }
                        return;
                    }
                    const byId = new Map(remoteList.map((o) => [o.orden_id, o]));
                    for (const order of orders) {
                        try {
                            await this.pollOrderFromView(order, byId.get(order.orden_id) ?? null, minuto);
                        } catch (error) {
                            this.onError(error);
                        }
                    }
                }),
            );
        } else {
            await Promise.all(vivas.map((order) => this.pollOrder(order, minuto).catch((e) => this.onError(e))));
        }

        // 2) Slots whose latest attempt is fallida (not final) -> retry or close.
        const bySlot = groupBySlot(await this.orders.list());
        for (const slotOrders of bySlot.values()) {
            const latest = slotOrders[slotOrders.length - 1];
            if (latest.estado !== "fallida" || latest.final) continue;
            try {
                await this.resolveRetry(latest, slotOrders.length, estado);
            } catch (error) {
                this.onError(error);
            }
        }

        // 3) Expediente aggregate over every open case.
        await this.syncExpedientes(minuto);

        // 4) Grace window: zero tipo=ip orders still applied (TEST 12).
        if (!this.graceChecked && minuto >= estado.fin_min + this.graceMin) {
            await this.checkGrace(minuto);
        }
    }

    // --- provider polling -------------------------------------------------

    private async pollOrder(order: ShieldOrder, minuto: number): Promise<void> {
        let remote: ProviderOrder | null;
        try {
            remote = await this.client.orden(order.proveedor_id, order.orden_id);
        } catch (error) {
            if (error instanceof SimulatorHttpError && error.status === 404) {
                remote = null;
            } else {
                throw error;
            }
        }
        await this.pollOrderFromView(order, remote, minuto);
    }

    /**
     * Fold one provider view into the local order. `remote === null` is the
     * 404 equivalent (per-order 404 or absent from the provider's order list).
     */
    private async pollOrderFromView(order: ShieldOrder, remote: ProviderOrder | null, minuto: number): Promise<void> {
        if (remote === null) {
            if (order.estado === "enviada") {
                // The dispatcher persists enviada BEFORE the POST completes, so
                // remote absence inside the grace window is the normal in-flight
                // case — requeueing it now duplicates the POST. Only an enviada
                // older than the grace (crash window) goes back to pending.
                if (order.enviada_min !== undefined && minuto - order.enviada_min < this.enviadaRequeueGraceMin) {
                    return;
                }
                order.estado = "pendiente_envio";
                await this.orders.save(order);
                await this.safeAudit({
                    evento: "orden_estado_recuperado",
                    minSim: minuto,
                    expedienteId: order.expediente_id,
                    correlationId: `orden:${order.orden_id}`,
                    datos: {
                        orden_id: order.orden_id,
                        proveedor_id: order.proveedor_id,
                        motivo: "enviada_sin_registro_remoto_reencolada",
                    },
                });
                return;
            }
            // A provider-confirmed order vanished: anomaly, keep local truth.
            await this.safeAudit({
                evento: "orden_estado_recuperado",
                minSim: minuto,
                expedienteId: order.expediente_id,
                correlationId: `orden:${order.orden_id}`,
                datos: {
                    orden_id: order.orden_id,
                    proveedor_id: order.proveedor_id,
                    motivo: "remota_no_encontrada",
                    estado_local: order.estado,
                },
            });
            return;
        }

        const prev = order.estado;
        if (prev === remote.estado) return; // nothing new
        applyProviderView(order, remote);
        if (order.estado === "fallida" || order.estado === "vencida" || order.estado === "levantada") {
            order.finalizada_min ??= remote.finalizada_min ?? minuto;
        }
        await this.orders.save(order);
        await this.auditTransition(order, prev, remote, minuto);
    }

    private async auditTransition(
        order: ShieldOrder,
        prev: string,
        remote: ProviderOrder,
        minuto: number,
    ): Promise<void> {
        const base = {
            orden_id: order.orden_id,
            proveedor_id: order.proveedor_id,
            desde: prev,
            hacia: remote.estado,
            intento: order.intento ?? intentoDe(order.orden_id),
        };
        const append = (evento: "orden_aplicada" | "orden_fallida" | "orden_vencida" | "orden_levantada", datos = {}) =>
            this.safeAudit({
                evento,
                minSim: minuto,
                expedienteId: order.expediente_id,
                correlationId: `orden:${order.orden_id}`,
                datos: { ...base, ...datos },
            });
        if (remote.estado === "aplicada") return append("orden_aplicada", { aplicada_min: remote.aplicada_min });
        if (remote.estado === "fallida") return append("orden_fallida", { motivo: remote.motivo ?? null });
        if (remote.estado === "vencida") return append("orden_vencida", { finalizada_min: remote.finalizada_min });
        if (remote.estado === "levantada") return append("orden_levantada", { motivo: remote.motivo ?? null });
    }

    // --- retries ------------------------------------------------------------

    /**
     * The slot's latest attempt is fallida: either spawn the next attempt
     * (new orden_id + new signature, delayed by bounded backoff) or close the
     * slot with the reason no retry may happen.
     */
    private async resolveRetry(
        failed: ShieldOrder,
        attemptsUsed: number,
        estado: SimulatorState,
    ): Promise<void> {
        const minuto = estado.minuto_actual;
        const intento = failed.intento ?? intentoDe(failed.orden_id);
        const bloquear = async (motivo: string, datos: Record<string, unknown> = {}) => {
            failed.final = true;
            await this.orders.save(failed);
            await this.safeAudit({
                evento: "orden_reintento_bloqueado",
                minSim: minuto,
                expedienteId: failed.expediente_id,
                correlationId: `orden:${failed.orden_id}`,
                datos: {
                    orden_id: failed.orden_id,
                    proveedor_id: failed.proveedor_id,
                    intento_n: intento,
                    motivo,
                    ...datos,
                },
            });
        };

        if (intento >= this.maxIntentos || attemptsUsed >= this.maxIntentos) {
            return bloquear("max_intentos_alcanzado");
        }
        if (estado.finalizado || minuto >= estado.fin_min) {
            return bloquear("fin_min_alcanzado");
        }
        // The signature may only come from the same approving judge ON shift.
        if (!juecesDeTurno(minuto, this.turnos()).includes(failed.juez_id)) {
            return bloquear("juez_fuera_de_turno_requiere_reaprobacion", { juez_id: failed.juez_id });
        }
        // A retry is signed with the CURRENT match's clock and fin_min. If the
        // simulator moved to a different partido, signing the old case's target
        // under the new match's expiry would emit a legally wrong order.
        const expediente = await this.cases.getById(failed.expediente_id);
        if (expediente && expediente.partido_id !== estado.partido) {
            return bloquear("partido_distinto_del_expediente", {
                partido_expediente: expediente.partido_id,
                partido_actual: estado.partido,
            });
        }

        const retryId = `ord-${failed.expediente_id}-${failed.proveedor_id}-${String(intento + 1).padStart(2, "0")}`;
        const venceMin = Math.floor(estado.fin_min);
        const draft = {
            orden_id: retryId,
            expediente_id: failed.expediente_id,
            tipo: failed.tipo,
            objetivo: failed.objetivo,
            vence_min: venceMin,
            juzgado_id: failed.juzgado_id,
            juez_id: failed.juez_id,
        };
        const retry: ShieldOrder = {
            ...draft,
            proveedor_id: failed.proveedor_id,
            firma: this.signing.signOrder(draft),
            estado: "pendiente_envio",
            creada_min: minuto,
            creada_en: this.now().toISOString(),
            intento: intento + 1,
            proximo_intento_ms: this.now().getTime() + this.retryDelayMs * intento,
        };
        await this.orders.save(retry);
        await this.safeAudit({
            evento: "orden_reintentada",
            minSim: minuto,
            expedienteId: failed.expediente_id,
            correlationId: `orden:${retry.orden_id}`,
            datos: {
                orden_id_anterior: failed.orden_id,
                orden_id: retry.orden_id,
                proveedor_id: failed.proveedor_id,
                intento_n: intento + 1,
                vence_min: venceMin,
                juez_id: retry.juez_id,
            },
        });
    }

    // --- expediente aggregate (S5 §5) -----------------------------------------

    private async syncExpedientes(minuto: number): Promise<void> {
        const abiertos = (
            await Promise.all(
                (["aprobado", "distribuyendo", "parcial", "aplicado"] as const).map((e) =>
                    this.cases.listByEstado(e),
                ),
            )
        ).flat();
        for (const expediente of abiertos) {
            try {
                const ordenes = await this.orders.listByExpediente(expediente.expediente_id);
                // Approval persists the case transition BEFORE composing orders,
                // so a crash mid-approval can leave an open expediente with zero
                // or a subset of its signed orders — undetectable downstream
                // otherwise (aggregateTarget returns null and it hangs open).
                const esperadas = expediente.medidas_por_isp.filter((m) => m.tipo !== null && m.objetivo !== null).length;
                if (ordenes.length < esperadas && this.auditAnomalyOnce(`${expediente.expediente_id}:incompletas`)) {
                    await this.safeAudit({
                        evento: "expediente_ordenes_incompletas",
                        minSim: minuto,
                        expedienteId: expediente.expediente_id,
                        correlationId: `anomalia:${expediente.expediente_id}:ordenes`,
                        datos: {
                            expediente_id: expediente.expediente_id,
                            estado: expediente.estado,
                            ordenes_presentes: ordenes.length,
                            medidas_esperadas: esperadas,
                        },
                    });
                }
                const target = aggregateTarget(expediente.estado, ordenes);
                // The case graph has no terminal edge for "every measure failed
                // definitively" — such a case hangs open forever. Flag it once
                // instead of letting it sit invisible.
                if (target === null && ordenes.length > 0 && this.auditAnomalyOnce(`${expediente.expediente_id}:sin-terminal`)) {
                    await this.safeAudit({
                        evento: "expediente_sin_borde_terminal",
                        minSim: minuto,
                        expedienteId: expediente.expediente_id,
                        correlationId: `anomalia:${expediente.expediente_id}:terminal`,
                        datos: {
                            expediente_id: expediente.expediente_id,
                            estado: expediente.estado,
                            ordenes: ordenes.length,
                            motivo: "todos_los_slots_en_fallo_terminal",
                        },
                    });
                }
                if (target === null || target === expediente.estado) continue;
                // The custody graph only allows one hop per transition. When
                // orders advanced faster than these cycles (e.g. after a
                // restart), walk toward the target instead of getting stuck.
                const step = firstStepToward(expediente.estado, target);
                if (step === null) continue;
                await this.caseService.transition(expediente.expediente_id, step, {
                    minSim: minuto,
                    motivo: "sincronizacion_ordenes",
                    correlationId: `sync:${expediente.expediente_id}:${minuto}`,
                });
            } catch (error) {
                this.onError(error);
            }
        }
    }

    // --- grace window (TEST 12) ------------------------------------------------

    private async checkGrace(minuto: number): Promise<void> {
        this.graceChecked = true;
        const ipActivas = (await this.orders.list())
            .filter((o) => o.estado === "aplicada" && o.tipo === "ip")
            .map((o) => ({ orden_id: o.orden_id, proveedor_id: o.proveedor_id, objetivo: o.objetivo }));
        this.graceResult = { verificado: true, minuto, ipActivas };
        for (const residual of ipActivas) {
            await this.safeAudit({
                evento: "ip_activa_post_gracia",
                minSim: minuto,
                expedienteId: null,
                correlationId: `gracia:${residual.orden_id}`,
                datos: residual,
            });
        }
    }

    private async safeAudit(entry: Parameters<AuditService["append"]>[0]): Promise<void> {
        await this.audit.append(entry).catch(() => {});
    }

    /** True once per key — keeps anomaly audits from spamming every cycle. */
    private auditAnomalyOnce(key: string): boolean {
        if (this.anomalyAudited.has(key)) return false;
        this.anomalyAudited.add(key);
        return true;
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

// --- aggregate (pure, exported for tests) -------------------------------------

/** BFS over TRANSICIONES_EXPEDIENTE: the first hop on the path desde -> target. */
export function firstStepToward(desde: EstadoExpediente, target: EstadoExpediente): EstadoExpediente | null {
    if (desde === target) return target;
    const queue: Array<{ estado: EstadoExpediente; first: EstadoExpediente }> = TRANSICIONES_EXPEDIENTE[
        desde
    ].map((estado) => ({ estado, first: estado }));
    const visited = new Set<EstadoExpediente>([desde]);
    while (queue.length > 0) {
        const { estado, first } = queue.shift()!;
        if (estado === target) return first;
        if (visited.has(estado)) continue;
        visited.add(estado);
        for (const next of TRANSICIONES_EXPEDIENTE[estado]) queue.push({ estado: next, first });
    }
    return null;
}

type SlotBucket = "in_flight" | "aplicada" | "success_terminal" | "terminal_fail";

function bucket(order: ShieldOrder): SlotBucket {
    switch (order.estado) {
        case "aplicada":
            return "aplicada";
        case "vencida":
        case "levantada":
            return "success_terminal";
        case "rechazada_proveedor":
        case "bloqueada_turno":
            return "terminal_fail";
        case "fallida":
            return order.final ? "terminal_fail" : "in_flight";
        default:
            // pendiente_envio | enviada | recibida — a final flag means it will never send.
            return order.final ? "terminal_fail" : "in_flight";
    }
}

function groupBySlot(orders: ShieldOrder[]): Map<string, ShieldOrder[]> {
    const map = new Map<string, ShieldOrder[]>();
    for (const order of orders) {
        const key = slotKey(order);
        const list = map.get(key) ?? [];
        list.push(order);
        map.set(key, list);
    }
    for (const list of map.values()) {
        list.sort((a, b) => (a.intento ?? intentoDe(a.orden_id)) - (b.intento ?? intentoDe(b.orden_id)));
    }
    return map;
}

/**
 * Desired expediente state from its order slots — null when no transition
 * applies (e.g. every slot failed terminally and the graph has no honest edge).
 * Returns the same state when already there; callers filter it out.
 */
export function aggregateTarget(current: EstadoExpediente, orders: ShieldOrder[]): EstadoExpediente | null {
    if (orders.length === 0) return null;
    const latests = [...groupBySlot(orders).values()].map((list) => list[list.length - 1]);
    const slots = latests.map(bucket);

    const inFlight = slots.filter((s) => s === "in_flight").length;
    const aplicadas = slots.filter((s) => s === "aplicada").length;
    const successTerminal = slots.filter((s) => s === "success_terminal").length;
    const terminalFail = slots.filter((s) => s === "terminal_fail").length;
    const levantadas = latests.some((o) => o.estado === "levantada");

    if (inFlight === 0 && successTerminal + terminalFail === slots.length) {
        // Every slot resolved: levantada outranks vencida; zero applied slots
        // means the case never took effect — no honest terminal edge exists.
        if (levantadas) return "levantado";
        if (successTerminal > 0) return "vencido";
        return null;
    }

    const posibles = slots.length - terminalFail;
    const satisfechas = aplicadas + successTerminal;
    if (satisfechas === posibles && posibles > 0) return "aplicado";
    if (satisfechas > 0) return "parcial";
    // Nothing applied yet: distribuyendo as soon as the first POST went out
    // (enviada_min is stamped before the wire call, so it survives a crash).
    if (orders.some((o) => o.enviada_min !== undefined)) return "distribuyendo";
    return current === "aprobado" ? null : current;
}
