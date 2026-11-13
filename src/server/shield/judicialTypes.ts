import { z } from "zod";
import { blockOrderSchema, type BlockOrder, type ProviderOrder } from "./types.js";

// Judicial entities (spec §9, §12). A ShieldUser is a DEMO account bound to a
// judge id from config/juzgados.demo.json; a ShieldOrder is the signed order
// composed after an explicit judicial approval — S5 dispatches it, S4 never
// sends anything to providers.

export const JUEZ_ROLE = "juez" as const;

export const shieldUserSchema = z.object({
    /** Login username — equals the judge id in the demo seed. */
    username: z.string(),
    juez_id: z.string(),
    juzgado_id: z.string(),
    nombre: z.string(),
    role: z.literal(JUEZ_ROLE),
    /** bcrypt hash — never plaintext, never serialized to a response. */
    password_hash: z.string(),
});
export type ShieldUser = z.infer<typeof shieldUserSchema>;

/** User shape safe to send over the wire: everything but the hash. */
export function publicUser(user: ShieldUser): Omit<ShieldUser, "password_hash"> {
    const { password_hash: _password_hash, ...rest } = user;
    return rest;
}

/** Identity extracted from a validated JWT — the only juez_id the app trusts. */
export interface JudicialIdentity {
    juez_id: string;
    juzgado_id: string;
    role: typeof JUEZ_ROLE;
}

// --- Orders -----------------------------------------------------------------

// pendiente_envio: signed and waiting for S5 dispatch. enviada: POST in flight
// (crash-safe mark — the tracker reconciles it against the provider). recibida
// .. levantada mirror the simulator's provider-side lifecycle. The last two are
// ours alone: rechazada_proveedor = the provider answered a contract 4xx (or the
// order can never satisfy local contract gates); bloqueada_turno = dispatch was
// stopped because the signing judge left shift with no window left in the match.
export const ESTADOS_ORDEN = [
    "pendiente_envio",
    "enviada",
    "recibida",
    "aplicada",
    "fallida",
    "vencida",
    "levantada",
    "rechazada_proveedor",
    "bloqueada_turno",
] as const;
export const estadoOrdenSchema = z.enum(ESTADOS_ORDEN);
export type EstadoOrden = z.infer<typeof estadoOrdenSchema>;

export const shieldOrderSchema = blockOrderSchema.extend({
    /** Provider this order targets (orden_id embeds it, kept explicit for queries). */
    proveedor_id: z.string(),
    estado: estadoOrdenSchema,
    /** Simulated minute the order was signed at (custody). */
    creada_min: z.number(),
    creada_en: z.string(),
    /** Attempt number — mirrors the -NN suffix of orden_id (01 = first send). */
    intento: z.number().int().optional(),
    /** Simulated minute the POST was dispatched. */
    enviada_min: z.number().optional(),
    /** Simulated minute the provider accepted it (202 -> recibida). */
    recibida_min: z.number().optional(),
    /** Simulated minute the provider reported it applied. */
    aplicada_min: z.number().optional(),
    /** Simulated minute the provider reported a terminal state (vencida/levantada/fallida). */
    finalizada_min: z.number().optional(),
    /** Provider motivo on fallida/rechazada, or our own terminal reason. */
    motivo: z.string().optional(),
    /** Epoch ms before which a scheduled retry must NOT be sent (real-time backoff). */
    proximo_intento_ms: z.number().optional(),
    /** No further attempts will ever be made for this order record. */
    final: z.boolean().optional(),
});
export type ShieldOrder = z.infer<typeof shieldOrderSchema>;

/** Orders the dispatcher may still POST; everything else already left our hands. */
export const ESTADOS_ORDEN_PENDIENTES = ["pendiente_envio"] as const;
/** Local states whose provider-side truth must be polled until terminal. */
export const ESTADOS_ORDEN_VIVAS = ["enviada", "recibida", "aplicada"] as const;
/** Terminal states reached via the provider (never rejected/blocked locally). */
export const ESTADOS_ORDEN_TERMINALES_PROVEEDOR = ["vencida", "levantada", "fallida"] as const;

/** The exact 8-field payload the simulator accepts (CAMPOS_ORDEN, servidor.py:23). */
export function toBlockOrder(order: ShieldOrder): BlockOrder {
    return {
        orden_id: order.orden_id,
        expediente_id: order.expediente_id,
        tipo: order.tipo,
        objetivo: order.objetivo,
        vence_min: order.vence_min,
        juzgado_id: order.juzgado_id,
        juez_id: order.juez_id,
        firma: order.firma,
    };
}

/**
 * Mirrors the provider's reported lifecycle into the local order. Only the
 * simulator's own estado drives aplicada/vencida/levantada/fallida — the app
 * never promotes recibida on its own (TEST 06).
 */
export function applyProviderView(order: ShieldOrder, view: ProviderOrder): void {
    order.estado = view.estado;
    if (view.recibida_min !== undefined) order.recibida_min = view.recibida_min;
    if (view.aplicada_min !== undefined) order.aplicada_min = view.aplicada_min;
    if (view.finalizada_min !== undefined) order.finalizada_min = view.finalizada_min;
    if (view.motivo !== undefined) order.motivo = view.motivo;
}

// --- Request bodies -----------------------------------------------------------

export const loginBodySchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const rejectBodySchema = z.object({
    motivo: z.string().min(1, "motivo es obligatorio para rechazar"),
});
export type RejectBody = z.infer<typeof rejectBodySchema>;
