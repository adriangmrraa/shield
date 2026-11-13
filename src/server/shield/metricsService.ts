import type { EstadoExpediente, Expediente } from "./expedienteTypes.js";
import type { EstadoOrden, ShieldOrder } from "./judicialTypes.js";
import { intentoDe } from "./statusTracker.js";
import type { BlockType, Provider } from "./types.js";

// ISP metrics + client-weighted coverage (spec §10, S5 brief §4). Pure functions
// over persisted orders/expedientes + the provider registry — no hidden state,
// easy to snapshot for /metrics and the E2E report.
//
// A "slot" is one (expediente, proveedor, objetivo) target; its state is the
// LATEST attempt. enviadas/reintentos count wire attempts, so a retried order
// shows both the attempts it took and the slot it finally resolved.

export interface IspMetrics {
    proveedorId: string;
    clientes: number;
    capacidades: BlockType[];
    /** POSTs actually dispatched (every attempt), excluding local holds. */
    enviadas: number;
    /** enviadas minus slots that got at least one send — i.e. extra attempts. */
    reintentos: number;
    /** Distinct (expediente, objetivo) targets addressed to this ISP. */
    slots: number;
    /** Slots whose latest attempt is provider-side aplicada right now. */
    aplicadas: number;
    fallidas: number;
    vencidas: number;
    levantadas: number;
    /** rechazada_proveedor | bloqueada_turno | pendiente definitivamente sin envío. */
    rechazadas: number;
    /** Slots still in flight (pendiente/enviada/recibida, retry pending). */
    en_curso: number;
    /** aplicada_min - expediente.detectado_min per applied slot. */
    demora_deteccion_a_aplicada_min: number[];
    demora_promedio_min: number | null;
    /** Estado of the most recently touched order for this ISP. */
    ultimo_estado: EstadoOrden | null;
}

export interface SlotView {
    proveedorId: string;
    objetivo: string;
    tipo: BlockType;
    estado: EstadoOrden;
    intento: number;
}

export interface ExpedienteCoverage {
    expediente_id: string;
    fase_key: string;
    estado: EstadoExpediente;
    /** Sum of clientes of ISPs holding a currently-aplicada order for this case. */
    clientes_cubiertos: number;
    /** Sum of clientes of ISPs whose order reached aplicada at some point (incl. already vencida). */
    clientes_alcanzados: number;
    clientes_totales: number;
    /** Vigente right now — 0 once every order expired (spec definition). */
    cobertura_pct: number;
    /** Was ever covered during the match — the figure the E2E report should show. */
    cobertura_alcanzada_pct: number;
    slots: SlotView[];
}

export interface MetricsSummary {
    por_isp: IspMetrics[];
    cobertura: {
        clientes_totales: number;
        /** Mean of per-expediente cobertura_pct (each phase weighs the same). */
        cobertura_ponderada_pct: number;
        /** Mean of per-expediente cobertura_alcanzada_pct. */
        cobertura_alcanzada_ponderada_pct: number;
        por_expediente: ExpedienteCoverage[];
    };
}

interface SlotGroup {
    latest: ShieldOrder;
    attempts: number;
    sentAttempts: number;
}

function groupSlots(orders: ShieldOrder[]): Map<string, SlotGroup> {
    const map = new Map<string, SlotGroup>();
    for (const order of orders) {
        const key = `${order.expediente_id}|${order.proveedor_id}|${order.objetivo}`;
        const group = map.get(key);
        const sent = order.enviada_min !== undefined || order.estado !== "pendiente_envio" ? 1 : 0;
        if (!group) {
            map.set(key, { latest: order, attempts: 1, sentAttempts: sent });
            continue;
        }
        group.attempts += 1;
        group.sentAttempts += sent;
        const a = group.latest.intento ?? intentoDe(group.latest.orden_id);
        const b = order.intento ?? intentoDe(order.orden_id);
        if (b > a) group.latest = order;
    }
    return map;
}

/** Slot latest state is provider-terminal failed (or will never be sent). */
function isTerminalFail(order: ShieldOrder): boolean {
    return (
        order.estado === "rechazada_proveedor" ||
        order.estado === "bloqueada_turno" ||
        order.final === true
    );
}

export function computeMetrics(args: {
    orders: ShieldOrder[];
    expedientes: Expediente[];
    providers: Provider[];
}): MetricsSummary {
    const { orders, expedientes, providers } = args;
    const expById = new Map(expedientes.map((e) => [e.expediente_id, e]));
    const providerById = new Map(providers.map((p) => [p.id, p]));
    const clientesTotales = providers.reduce((acc, p) => acc + p.clientes, 0);
    const slots = groupSlots(orders);

    // --- per-ISP -------------------------------------------------------------
    const porIsp = new Map<string, IspMetrics>();
    for (const provider of providers) {
        porIsp.set(provider.id, {
            proveedorId: provider.id,
            clientes: provider.clientes,
            capacidades: provider.capacidades,
            enviadas: 0,
            reintentos: 0,
            slots: 0,
            aplicadas: 0,
            fallidas: 0,
            vencidas: 0,
            levantadas: 0,
            rechazadas: 0,
            en_curso: 0,
            demora_deteccion_a_aplicada_min: [],
            demora_promedio_min: null,
            ultimo_estado: null,
        });
    }
    const lastTouch = new Map<string, { min: number; estado: EstadoOrden }>();

    for (const group of slots.values()) {
        const order = group.latest;
        const metrics = porIsp.get(order.proveedor_id) ?? {
            proveedorId: order.proveedor_id,
            clientes: providerById.get(order.proveedor_id)?.clientes ?? 0,
            capacidades: providerById.get(order.proveedor_id)?.capacidades ?? [],
            enviadas: 0,
            reintentos: 0,
            slots: 0,
            aplicadas: 0,
            fallidas: 0,
            vencidas: 0,
            levantadas: 0,
            rechazadas: 0,
            en_curso: 0,
            demora_deteccion_a_aplicada_min: [],
            demora_promedio_min: null,
            ultimo_estado: null,
        };
        porIsp.set(order.proveedor_id, metrics);
        metrics.slots += 1;
        metrics.enviadas += group.sentAttempts;
        metrics.reintentos += Math.max(0, group.sentAttempts - 1);

        switch (order.estado) {
            case "aplicada":
                metrics.aplicadas += 1;
                break;
            case "vencida":
                metrics.vencidas += 1;
                break;
            case "levantada":
                metrics.levantadas += 1;
                break;
            case "fallida":
                metrics.fallidas += 1;
                break;
            case "rechazada_proveedor":
            case "bloqueada_turno":
                metrics.rechazadas += 1;
                break;
            default:
                if (isTerminalFail(order)) metrics.rechazadas += 1;
                else metrics.en_curso += 1;
        }

        const aplicadaMin = group.latest.aplicada_min;
        if (aplicadaMin !== undefined) {
            const det = expById.get(order.expediente_id)?.detectado_min;
            if (det !== undefined) metrics.demora_deteccion_a_aplicada_min.push(aplicadaMin - det);
        }

        const touch = order.finalizada_min ?? order.aplicada_min ?? order.recibida_min ?? order.enviada_min ?? order.creada_min;
        const prev = lastTouch.get(order.proveedor_id);
        if (!prev || touch >= prev.min) lastTouch.set(order.proveedor_id, { min: touch, estado: order.estado });
    }

    const por_isp = [...porIsp.values()].map((m) => {
        const demoras = m.demora_deteccion_a_aplicada_min;
        const ultimo = lastTouch.get(m.proveedorId);
        return {
            ...m,
            demora_promedio_min:
                demoras.length > 0 ? demoras.reduce((a, b) => a + b, 0) / demoras.length : null,
            ultimo_estado: ultimo?.estado ?? null,
        };
    });

    // --- client-weighted coverage per expediente ------------------------------
    const porExpediente: ExpedienteCoverage[] = expedientes
        .filter((e) => !["descartado", "rechazado", "recibido", "verificado", "pendiente_juez"].includes(e.estado))
        .map((exp) => {
            const expSlots = [...slots.entries()]
                .filter(([key]) => key.startsWith(`${exp.expediente_id}|`))
                .map(([, group]) => group.latest);
            const cubiertos = new Set(
                expSlots.filter((o) => o.estado === "aplicada").map((o) => o.proveedor_id),
            );
            const alcanzados = new Set(
                expSlots
                    .filter((o) => o.estado === "aplicada" || o.estado === "vencida" || o.estado === "levantada")
                    .map((o) => o.proveedor_id),
            );
            const clientesDe = (ids: Set<string>) =>
                [...ids].reduce((acc, pid) => acc + (providerById.get(pid)?.clientes ?? 0), 0);
            const clientesCubiertos = clientesDe(cubiertos);
            const clientesAlcanzados = clientesDe(alcanzados);
            return {
                expediente_id: exp.expediente_id,
                fase_key: exp.fase_key,
                estado: exp.estado,
                clientes_cubiertos: clientesCubiertos,
                clientes_alcanzados: clientesAlcanzados,
                clientes_totales: clientesTotales,
                cobertura_pct: clientesTotales > 0 ? (clientesCubiertos / clientesTotales) * 100 : 0,
                cobertura_alcanzada_pct: clientesTotales > 0 ? (clientesAlcanzados / clientesTotales) * 100 : 0,
                slots: expSlots.map((o) => ({
                    proveedorId: o.proveedor_id,
                    objetivo: o.objetivo,
                    tipo: o.tipo,
                    estado: o.estado,
                    intento: o.intento ?? intentoDe(o.orden_id),
                })),
            };
        });

    const coberturaPonderada =
        porExpediente.length > 0
            ? porExpediente.reduce((acc, e) => acc + e.cobertura_pct, 0) / porExpediente.length
            : 0;
    const coberturaAlcanzada =
        porExpediente.length > 0
            ? porExpediente.reduce((acc, e) => acc + e.cobertura_alcanzada_pct, 0) / porExpediente.length
            : 0;

    return {
        por_isp,
        cobertura: {
            clientes_totales: clientesTotales,
            cobertura_ponderada_pct: coberturaPonderada,
            cobertura_alcanzada_ponderada_pct: coberturaAlcanzada,
            por_expediente: porExpediente,
        },
    };
}
