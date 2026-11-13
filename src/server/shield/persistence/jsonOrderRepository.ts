import { z } from "zod";
import { shieldOrderSchema, type ShieldOrder } from "../judicialTypes.js";
import { readJsonRecovering, writeJsonAtomic, WriteQueue } from "./fileQueue.js";
import type { OrderRepository } from "./types.js";

// Signed orders in orders.json: whole file rewritten atomically per mutation —
// cheap at MVP scale and consistent with JsonCaseRepository. The firma field is
// the emitted HMAC (proof, not secret); claves never live here.

const fileSchema = z.object({
    orders: z.record(z.string(), shieldOrderSchema),
});

export class JsonOrderRepository implements OrderRepository {
    private readonly filePath: string;
    private readonly queue: WriteQueue;

    constructor(filePath: string, queue: WriteQueue) {
        this.filePath = filePath;
        this.queue = queue;
    }

    private async load(): Promise<Map<string, ShieldOrder>> {
        const loaded = await readJsonRecovering(this.filePath, fileSchema, { orders: {} });
        return new Map(Object.entries(loaded.orders));
    }

    async getById(ordenId: string): Promise<ShieldOrder | null> {
        return (await this.load()).get(ordenId) ?? null;
    }

    async list(): Promise<ShieldOrder[]> {
        return [...(await this.load()).values()];
    }

    async listByExpediente(expedienteId: string): Promise<ShieldOrder[]> {
        return (await this.list()).filter((order) => order.expediente_id === expedienteId);
    }

    async listByEstado(estado: ShieldOrder["estado"]): Promise<ShieldOrder[]> {
        return (await this.list()).filter((order) => order.estado === estado);
    }

    async save(order: ShieldOrder): Promise<void> {
        await this.queue.run(async () => {
            const state = await this.load();
            state.set(order.orden_id, order);
            await writeJsonAtomic(this.filePath, { orders: Object.fromEntries(state) });
        });
    }
}
