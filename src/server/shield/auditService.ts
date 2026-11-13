import type { AuditEntry, AuditEventRecord, AuditLogWriter } from "./persistence/types.js";

// Append-only custody log (spec §8, §18): every detection, verdict, case and
// transition is recorded — including discards and failures. Custody invariant:
// datos carries sha256 + references only, never signing keys or capture bytes.

export const AUDIT_EVENTOS = [
    "detection_recibida",
    "detection_verificada",
    "detection_descartada",
    "detection_error",
    "expediente_creado",
    "expediente_actualizado",
    "expediente_descartado",
    "transicion_estado",
    "auth_login",
    "auth_login_rechazado",
    "expediente_reasignado",
    "expediente_aprobado",
    "expediente_rechazado",
    "orden_compuesta",
    "firma_bloqueada_fuera_de_turno",
    "orden_despachada",
    "orden_recibida",
    "orden_rechazada_proveedor",
    "orden_aplicada",
    "orden_fallida",
    "orden_reintentada",
    "orden_reintento_bloqueado",
    "orden_bloqueada_turno",
    "orden_no_despachada",
    "orden_vencida",
    "orden_levantada",
    "orden_estado_recuperado",
    "ip_activa_post_gracia",
] as const;
export type AuditEventName = (typeof AUDIT_EVENTOS)[number];

export interface AuditAppend {
    evento: AuditEventName;
    minSim: number | null;
    expedienteId?: string | null;
    /** Links detection -> verification -> case events of one processing chain. */
    correlationId: string;
    datos?: Record<string, unknown>;
}

export class AuditService {
    private readonly writer: AuditLogWriter;
    private readonly now: () => Date;

    constructor(writer: AuditLogWriter, now: () => Date = () => new Date()) {
        this.writer = writer;
        this.now = now;
    }

    append(input: AuditAppend): Promise<AuditEntry> {
        const record: AuditEventRecord = {
            ts_iso: this.now().toISOString(),
            min_sim: input.minSim,
            evento: input.evento,
            expediente_id: input.expedienteId ?? null,
            correlation_id: input.correlationId,
            datos: input.datos ?? {},
        };
        return this.writer.append(record);
    }

    tail(n: number): Promise<AuditEntry[]> {
        return this.writer.tail(n);
    }

    readAll(): Promise<AuditEntry[]> {
        return this.writer.readAll();
    }
}
