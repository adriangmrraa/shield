import { z } from "zod";

// Contracts verified against tools/desafio-futbol/simulador/servidor.py (source of truth).
// Schemas strip unknown keys so additive API changes don't break the slice.

export const simulatorStateSchema = z.object({
    partido: z.string(),
    minuto_actual: z.number(),
    fin_min: z.number(),
    finalizado: z.boolean(),
    acelerar: z.number(),
    jueces_de_turno: z.array(z.string()),
});
export type SimulatorState = z.infer<typeof simulatorStateSchema>;

export const watermarkSchema = z.object({
    prefijo: z.string(),
    origen: z.string(),
});
export const licenseeSchema = z.object({
    nombre: z.string(),
    prefijo_marca: z.string(),
    dominios_autorizados: z.array(z.string()),
});
export const matchInfoSchema = z.object({
    id: z.string(),
    nombre: z.string(),
    titular_derechos: z.string(),
    inicio_iso: z.string(),
    fin_min: z.number(),
    marcas_de_agua_validas: z.array(watermarkSchema),
    licenciatarios: z.array(licenseeSchema),
});
export type MatchInfo = z.infer<typeof matchInfoSchema>;
export type Watermark = z.infer<typeof watermarkSchema>;
export type Licensee = z.infer<typeof licenseeSchema>;

export const captureSchema = z.object({
    capturada_min: z.number(),
    formato: z.string(),
    duracion_seg: z.number(),
    contenido_b64: z.string(),
});
export const promotionSchema = z.object({
    red: z.string(),
    url: z.string(),
    minuto: z.number(),
});
export const detectionSchema = z.object({
    id: z.string(),
    minuto: z.number(),
    pagina: z.string(),
    stream_url: z.string(),
    host_stream: z.string(),
    ip_servidor: z.string(),
    asn: z.number().int(),
    marca_de_agua_extraida: z.string(),
    captura: captureSchema,
    promocion: z.array(promotionSchema).optional(),
});
export type Detection = z.infer<typeof detectionSchema>;
export type Capture = z.infer<typeof captureSchema>;
export type Promotion = z.infer<typeof promotionSchema>;

// The simulator filters `desde < minuto <= corte`; the response's minuto_actual
// IS the next poll cursor — never derive it from items or the local clock.
export const detectionsPageSchema = z.object({
    minuto_actual: z.number(),
    detecciones: z.array(detectionSchema),
});
export type DetectionsPage = z.infer<typeof detectionsPageSchema>;

// asn/organizacion come from lookups that may miss -> server sends null.
export const passiveDnsByIpSchema = z.object({
    ip: z.string(),
    asn: z.number().int().nullable(),
    organizacion: z.string().nullable(),
    dominios: z.array(z.string()),
});
export const passiveDnsByDomainSchema = z.object({
    dominio: z.string(),
    ips: z.array(
        z.object({
            ip: z.string(),
            asn: z.number().int().nullable(),
            organizacion: z.string().nullable(),
        }),
    ),
});
export type PassiveDnsByIp = z.infer<typeof passiveDnsByIpSchema>;
export type PassiveDnsByDomain = z.infer<typeof passiveDnsByDomainSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

export const judgeSchema = z.object({ id: z.string(), nombre: z.string() });
export const courtSchema = z.object({
    id: z.string(),
    nombre: z.string(),
    jurisdiccion: z.string(),
    jueces: z.array(judgeSchema),
});
export const shiftSchema = z.object({
    juez_id: z.string(),
    desde_min: z.number(),
    hasta_min: z.number(),
});
export const courtInfoSchema = z.object({
    juzgados: z.array(courtSchema),
    turnos: z.array(shiftSchema),
    de_turno_ahora: z.array(z.string()),
});
export type CourtInfo = z.infer<typeof courtInfoSchema>;
export type Court = z.infer<typeof courtSchema>;
export type Judge = z.infer<typeof judgeSchema>;
export type Shift = z.infer<typeof shiftSchema>;

// GET /proveedores returns a bare array; `comportamiento` is never served.
export const blockTypeSchema = z.enum(["ip", "dominio"]);
export type BlockType = z.infer<typeof blockTypeSchema>;

export const providerSchema = z.object({
    id: z.string(),
    nombre: z.string(),
    tamano: z.string(),
    clientes: z.number(),
    capacidades: z.array(blockTypeSchema),
    ordenes: z.string(),
});
export const providerListSchema = z.array(providerSchema);
export type Provider = z.infer<typeof providerSchema>;

// vence_min must be an integer match minute (server rejects floats).
export const blockOrderSchema = z.object({
    orden_id: z.string(),
    expediente_id: z.string(),
    tipo: blockTypeSchema,
    objetivo: z.string(),
    vence_min: z.number().int(),
    juzgado_id: z.string(),
    juez_id: z.string(),
    firma: z.string(),
});
export type BlockOrder = z.infer<typeof blockOrderSchema>;

export const providerOrderStateSchema = z.enum([
    "recibida",
    "aplicada",
    "fallida",
    "vencida",
    "levantada",
]);
export type ProviderOrderState = z.infer<typeof providerOrderStateSchema>;

// Server-side order view: order fields without firma (and without _-internal keys).
export const providerOrderSchema = z.object({
    orden_id: z.string(),
    expediente_id: z.string(),
    tipo: blockTypeSchema,
    objetivo: z.string(),
    vence_min: z.number().int(),
    juzgado_id: z.string(),
    juez_id: z.string(),
    estado: providerOrderStateSchema,
    recibida_min: z.number().optional(),
    aplicada_min: z.number().optional(),
    finalizada_min: z.number().optional(),
    motivo: z.string().optional(),
});
export type ProviderOrder = z.infer<typeof providerOrderSchema>;

// POST /proveedores/<id>/ordenes -> 202
export const orderAcceptedSchema = z.object({
    orden_id: z.string(),
    estado: z.literal("recibida"),
    consultar: z.string(),
});
export type OrderAccepted = z.infer<typeof orderAcceptedSchema>;

// POST /proveedores/<id>/ordenes/<orden_id>/levantar body
export const liftOrderRequestSchema = z.object({
    juez_id: z.string(),
    firma: z.string(),
    motivo: z.string().optional(),
});
export type LiftOrderRequest = z.infer<typeof liftOrderRequestSchema>;

export const claimSchema = z.object({
    id: z.string(),
    minuto: z.number(),
    dominio: z.string(),
    proveedor: z.string(),
    mensaje: z.string(),
});
export const claimsPageSchema = z.object({
    minuto_actual: z.number(),
    reclamos: z.array(claimSchema),
});
export type Claim = z.infer<typeof claimSchema>;
export type ClaimsPage = z.infer<typeof claimsPageSchema>;
