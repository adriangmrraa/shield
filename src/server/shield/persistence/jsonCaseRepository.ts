import { z } from "zod";
import { expedienteSchema, type EstadoExpediente, type Expediente } from "../expedienteTypes.js";
import { readJsonRecovering, writeJsonAtomic, WriteQueue } from "./fileQueue.js";
import type { CaseRepository } from "./types.js";

// All case files in one cases.json: {sequences per match, cases by id}. Whole
// file rewritten atomically on every mutation — cheap at MVP scale. Stateless:
// the file is re-read on every access so handles never serve stale cases.

const fileSchema = z.object({
    sequences: z.record(z.string(), z.number()),
    cases: z.record(z.string(), expedienteSchema),
});

interface RepoState {
    sequences: Map<string, number>;
    cases: Map<string, Expediente>;
}

export class JsonCaseRepository implements CaseRepository {
    private readonly filePath: string;
    private readonly queue: WriteQueue;

    constructor(filePath: string, queue: WriteQueue) {
        this.filePath = filePath;
        this.queue = queue;
    }

    private async load(): Promise<RepoState> {
        const loaded = await readJsonRecovering(this.filePath, fileSchema, { sequences: {}, cases: {} });
        return {
            sequences: new Map(Object.entries(loaded.sequences)),
            cases: new Map(Object.entries(loaded.cases)),
        };
    }

    async getById(expedienteId: string): Promise<Expediente | null> {
        return (await this.load()).cases.get(expedienteId) ?? null;
    }

    async findByPhaseKey(faseKey: string): Promise<Expediente | null> {
        const { cases } = await this.load();
        for (const expediente of cases.values()) {
            if (expediente.fase_key === faseKey) return expediente;
        }
        return null;
    }

    async findLatestBySignalKey(senalKey: string): Promise<Expediente | null> {
        const { cases } = await this.load();
        let latest: Expediente | null = null;
        for (const expediente of cases.values()) {
            if (expediente.senal_key !== senalKey) continue;
            if (!latest || expediente.ultima_deteccion_min > latest.ultima_deteccion_min) {
                latest = expediente;
            }
        }
        return latest;
    }

    async list(): Promise<Expediente[]> {
        return [...(await this.load()).cases.values()];
    }

    async listByEstado(estado: EstadoExpediente): Promise<Expediente[]> {
        return (await this.list()).filter((expediente) => expediente.estado === estado);
    }

    async save(expediente: Expediente): Promise<void> {
        await this.queue.run(async () => {
            const state = await this.load();
            state.cases.set(expediente.expediente_id, expediente);
            await this.persist(state);
        });
    }

    async nextSequence(partidoId: string): Promise<number> {
        return this.queue.run(async () => {
            const state = await this.load();
            const next = (state.sequences.get(partidoId) ?? 0) + 1;
            state.sequences.set(partidoId, next);
            await this.persist(state);
            return next;
        });
    }

    private async persist(state: RepoState): Promise<void> {
        await writeJsonAtomic(this.filePath, {
            sequences: Object.fromEntries(state.sequences),
            cases: Object.fromEntries(state.cases),
        });
    }
}
