import { z } from "zod";

// Digital case file (spec §8): the persistent record a judge reviews. Built only
// from verified detections; evidence bytes live behind a controlled reference,
// never inline in the case JSON and never in logs.

export const ESTADOS_EXPEDIENTE = [
    "recibido",
    "verificado",
    "descartado",
    "pendiente_juez",
    "aprobado",
    "rechazado",
    "distribuyendo",
    "parcial",
    "aplicado",
    "vencido",
    "levantado",
] as const;
export const estadoExpedienteSchema = z.enum(ESTADOS_EXPEDIENTE);
export type EstadoExpediente = z.infer<typeof estadoExpedienteSchema>;

// Custody invariant: only these edges may ever be taken; every hop is written
// to audit.jsonl as `transicion_estado`. Terminal states have no outgoing edge.
export const TRANSICIONES_EXPEDIENTE: Readonly<Record<EstadoExpediente, readonly EstadoExpediente[]>> = {
    recibido: ["verificado", "descartado"],
    verificado: ["pendiente_juez", "descartado"],
    pendiente_juez: ["aprobado", "rechazado"],
    aprobado: ["distribuyendo"],
    distribuyendo: ["parcial", "aplicado"],
    parcial: ["aplicado", "vencido", "levantado"],
    aplicado: ["vencido", "levantado"],
    vencido: [],
    levantado: [],
    descartado: [],
    rechazado: [],
};

export function canTransition(desde: EstadoExpediente, hacia: EstadoExpediente): boolean {
    return TRANSICIONES_EXPEDIENTE[desde].includes(hacia);
}

export class InvalidTransitionError extends Error {
    readonly desde: EstadoExpediente;
    readonly hacia: EstadoExpediente;

    constructor(desde: EstadoExpediente, hacia: EstadoExpediente) {
        super(`Invalid expediente transition: ${desde} -> ${hacia}`);
        this.name = "InvalidTransitionError";
        this.desde = desde;
        this.hacia = hacia;
    }
}

export function assertTransition(desde: EstadoExpediente, hacia: EstadoExpediente): void {
    if (!canTransition(desde, hacia)) throw new InvalidTransitionError(desde, hacia);
}

export const transicionSchema = z.object({
    desde: estadoExpedienteSchema,
    hacia: estadoExpedienteSchema,
    min_sim: z.number().nullable(),
    ts_iso: z.string(),
    motivo: z.string().optional(),
});
export type Transicion = z.infer<typeof transicionSchema>;

export const medidaPorIspSchema = z.object({
    proveedorId: z.string(),
    tipo: z.enum(["dominio", "ip"]).nullable(),
    objetivo: z.string().nullable(),
    motivo: z.string(),
});

export const validacionMarcaSchema = z.object({
    marca_valida: z.boolean(),
    prefijo_coincidente: z.string().nullable(),
    licenciatario: z.string().nullable(),
});

export const dnsPasivoResultadoSchema = z.object({
    resuelto: z.boolean(),
    organizacion: z.string().nullable(),
    dominios: z.array(z.string()),
});

export const riesgoSchema = z.object({
    /** null when PASO C could not evaluate sharing risk (unknown = treated as shared upstream). */
    ip_compartida: z.boolean().nullable(),
    dns_resuelto: z.boolean(),
    asn: z.number().nullable(),
    organizacion: z.string().nullable(),
});

export const expedienteSchema = z.object({
    /** Format: EXP-<partido>-<secuencia>, sequence per match. */
    expediente_id: z.string(),
    partido_id: z.string(),
    /** Signal identity: page host. Survives host/IP migrations — the link between phases. */
    senal_key: z.string(),
    /** Phase identity: senal|host|ip. A migration creates a new fase_key. */
    fase_key: z.string(),
    /** fase_key of the immediately previous phase of the same signal, when this case is a migration. */
    fase_origen: z.string().nullable(),
    deteccion_ids: z.array(z.string()),
    /** Minute of the first detection consolidated into this case. */
    detectado_min: z.number(),
    /** Minute of the most recent detection consolidated into this case. */
    ultima_deteccion_min: z.number(),
    pagina: z.string(),
    stream_url: z.string(),
    host_stream: z.string(),
    ip_servidor: z.string(),
    asn: z.number().nullable(),
    marca_de_agua_extraida: z.string(),
    validacion_marca: validacionMarcaSchema,
    estado_licencia: z.string(),
    captura_sha256: z.string().nullable(),
    captura_capturada_min: z.number().nullable(),
    captura_formato: z.string().nullable(),
    captura_duracion_seg: z.number().nullable(),
    /** Controlled reference to the capture bytes (data/shield/evidence/<sha256>.bin). */
    captura_ref: z.string().nullable(),
    dns_pasivo: dnsPasivoResultadoSchema.nullable(),
    dominios_compartidos: z.array(z.string()),
    riesgo: riesgoSchema.nullable(),
    medidas_por_isp: z.array(medidaPorIspSchema),
    /** Proposed block expiry: the match's fin_min. */
    vence_min_propuesto: z.number(),
    estado: estadoExpedienteSchema,
    fuente: z.string(),
    /** Full verdict trail for custody: every reasonCode the engine emitted. */
    reason_codes: z.array(z.string()),
    creado_en: z.string(),
    /** Simulated minute at creation (poll's minuto_actual). */
    creado_min: z.number(),
    ultima_transicion: transicionSchema.nullable(),
});
export type Expediente = z.infer<typeof expedienteSchema>;
export type MedidaPorIsp = z.infer<typeof medidaPorIspSchema>;
export type ValidacionMarca = z.infer<typeof validacionMarcaSchema>;
export type DnsPasivoResultado = z.infer<typeof dnsPasivoResultadoSchema>;
export type RiesgoEvaluacion = z.infer<typeof riesgoSchema>;
