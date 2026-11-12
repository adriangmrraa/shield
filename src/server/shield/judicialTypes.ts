import { z } from "zod";
import { blockOrderSchema, type BlockOrder } from "./types.js";

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

// pendiente_envio: signed and waiting for S5 dispatch. The remaining states
// mirror the simulator's provider-side lifecycle for later slices.
export const ESTADOS_ORDEN = [
    "pendiente_envio",
    "enviada",
    "recibida",
    "aplicada",
    "fallida",
    "vencida",
    "levantada",
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
});
export type ShieldOrder = z.infer<typeof shieldOrderSchema>;

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
