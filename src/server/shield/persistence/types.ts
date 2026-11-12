import type { DetectionStore } from "../detectionPoller.js";
import type { Expediente, EstadoExpediente } from "../expedienteTypes.js";

// Persistence contracts. The JSON/JSONL implementation under data/shield/ is
// swappable for a Drizzle/Postgres backend later — domain code only sees these.

/** One audit line, before the store assigns its sequence number. */
export interface AuditEventRecord {
    ts_iso: string;
    /** Simulated match minute the event belongs to; null when none applies. */
    min_sim: number | null;
    evento: string;
    expediente_id: string | null;
    correlation_id: string;
    /** Free-form payload — sha256/refs only, never secrets or capture bytes. */
    datos: Record<string, unknown>;
}

export interface AuditEntry extends AuditEventRecord {
    /** Monotonic per audit.jsonl, assigned by the store at append time. */
    seq: number;
}

export interface AuditLogWriter {
    append(record: AuditEventRecord): Promise<AuditEntry>;
    tail(n: number): Promise<AuditEntry[]>;
    readAll(): Promise<AuditEntry[]>;
}

export interface CaseRepository {
    getById(expedienteId: string): Promise<Expediente | null>;
    /** The single open case for a phase identity (senal|host|ip), if any. */
    findByPhaseKey(faseKey: string): Promise<Expediente | null>;
    /** Most recently detected case of the same signal (migration linking). */
    findLatestBySignalKey(senalKey: string): Promise<Expediente | null>;
    list(): Promise<Expediente[]>;
    listByEstado(estado: EstadoExpediente): Promise<Expediente[]>;
    /** Upsert by expediente_id. */
    save(expediente: Expediente): Promise<void>;
    /** Per-match monotonic sequence used to build expediente_id. */
    nextSequence(partidoId: string): Promise<number>;
}

export interface EvidenceStore {
    /** Persists bytes under their sha256; returns the controlled reference. */
    put(sha256: string, bytes: Buffer): Promise<string>;
    get(ref: string): Promise<Buffer | null>;
}

export interface ShieldPersistence {
    dir: string;
    detections: DetectionStore;
    cases: CaseRepository;
    audit: AuditLogWriter;
    evidence: EvidenceStore;
}
