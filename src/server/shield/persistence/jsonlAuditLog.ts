import { z } from "zod";
import { appendJsonl, readJsonl, WriteQueue } from "./fileQueue.js";
import type { AuditEntry, AuditEventRecord, AuditLogWriter } from "./types.js";

// Append-only audit log: one JSON object per line, never rewritten. seq is
// monotonic and survives restarts (hydrated from the highest seq on disk).

const auditEntrySchema = z.object({
    seq: z.number().int(),
    ts_iso: z.string(),
    min_sim: z.number().nullable(),
    evento: z.string(),
    expediente_id: z.string().nullable(),
    correlation_id: z.string(),
    datos: z.record(z.string(), z.unknown()),
});

export class JsonlAuditLog implements AuditLogWriter {
    private readonly filePath: string;
    private readonly queue: WriteQueue;

    constructor(filePath: string, queue: WriteQueue) {
        this.filePath = filePath;
        this.queue = queue;
    }

    private async lastSeq(): Promise<number> {
        const entries = await readJsonl(this.filePath, auditEntrySchema);
        return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    }

    append(record: AuditEventRecord): Promise<AuditEntry> {
        return this.queue.run(async () => {
            const entry: AuditEntry = { seq: (await this.lastSeq()) + 1, ...record };
            await appendJsonl(this.filePath, entry);
            return entry;
        });
    }

    async tail(n: number): Promise<AuditEntry[]> {
        return (await this.readAll()).slice(-n);
    }

    readAll(): Promise<AuditEntry[]> {
        return readJsonl(this.filePath, auditEntrySchema);
    }
}
