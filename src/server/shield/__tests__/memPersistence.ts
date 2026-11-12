import type { EstadoExpediente, Expediente } from "../expedienteTypes.js";
import type {
    AuditEntry,
    AuditEventRecord,
    AuditLogWriter,
    CaseRepository,
    EvidenceStore,
    ShieldPersistence,
} from "../persistence/types.js";
import type { DetectionStore } from "../detectionPoller.js";

// In-memory fakes implementing the same persistence contracts as the JSON
// adapter — domain tests exercise the service layer without touching disk.

export class MemCaseRepository implements CaseRepository {
    readonly cases = new Map<string, Expediente>();
    private readonly sequences = new Map<string, number>();

    getById(expedienteId: string): Promise<Expediente | null> {
        return Promise.resolve(this.cases.get(expedienteId) ?? null);
    }

    findByPhaseKey(faseKey: string): Promise<Expediente | null> {
        for (const expediente of this.cases.values()) {
            if (expediente.fase_key === faseKey) return Promise.resolve(expediente);
        }
        return Promise.resolve(null);
    }

    findLatestBySignalKey(senalKey: string): Promise<Expediente | null> {
        let latest: Expediente | null = null;
        for (const expediente of this.cases.values()) {
            if (expediente.senal_key !== senalKey) continue;
            if (!latest || expediente.ultima_deteccion_min > latest.ultima_deteccion_min) latest = expediente;
        }
        return Promise.resolve(latest);
    }

    list(): Promise<Expediente[]> {
        return Promise.resolve([...this.cases.values()]);
    }

    listByEstado(estado: EstadoExpediente): Promise<Expediente[]> {
        return Promise.resolve([...this.cases.values()].filter((e) => e.estado === estado));
    }

    save(expediente: Expediente): Promise<void> {
        this.cases.set(expediente.expediente_id, expediente);
        return Promise.resolve();
    }

    nextSequence(partidoId: string): Promise<number> {
        const next = (this.sequences.get(partidoId) ?? 0) + 1;
        this.sequences.set(partidoId, next);
        return Promise.resolve(next);
    }
}

export class MemEvidenceStore implements EvidenceStore {
    readonly files = new Map<string, Buffer>();

    put(sha256: string, bytes: Buffer): Promise<string> {
        const ref = `evidence/${sha256}.bin`;
        this.files.set(ref, Buffer.from(bytes));
        return Promise.resolve(ref);
    }

    get(ref: string): Promise<Buffer | null> {
        return Promise.resolve(this.files.get(ref) ?? null);
    }
}

export class MemAuditLog implements AuditLogWriter {
    readonly entries: AuditEntry[] = [];

    append(record: AuditEventRecord): Promise<AuditEntry> {
        const entry = { seq: this.entries.length + 1, ...record };
        this.entries.push(entry);
        return Promise.resolve(entry);
    }

    tail(n: number): Promise<AuditEntry[]> {
        return Promise.resolve(this.entries.slice(-n));
    }

    readAll(): Promise<AuditEntry[]> {
        return Promise.resolve([...this.entries]);
    }

    byEvent(evento: string): AuditEntry[] {
        return this.entries.filter((e) => e.evento === evento);
    }
}

export class MemDetectionStore implements DetectionStore {
    cursor = -1;
    readonly seen = new Set<string>();

    getCursor(): number {
        return this.cursor;
    }
    saveCursor(minute: number): void {
        this.cursor = minute;
    }
    hasSeen(id: string): boolean {
        return this.seen.has(id);
    }
    markSeen(id: string): void {
        this.seen.add(id);
    }
}

export function memPersistence(): ShieldPersistence & { audit: MemAuditLog; cases: MemCaseRepository } {
    return {
        dir: ":memory:",
        detections: new MemDetectionStore(),
        cases: new MemCaseRepository(),
        audit: new MemAuditLog(),
        evidence: new MemEvidenceStore(),
    };
}
