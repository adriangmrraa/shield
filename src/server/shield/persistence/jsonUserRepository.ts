import { z } from "zod";
import { shieldUserSchema, type ShieldUser } from "../judicialTypes.js";
import { readJsonRecovering, writeJsonAtomic, WriteQueue } from "./fileQueue.js";
import type { UserRepository } from "./types.js";

// Judicial accounts in users.json — bcrypt hashes only, seeded offline by
// scripts/shield-seed-users.ts. Stateless like the case repo: the file is the
// source of truth, re-read on every access.

const fileSchema = z.object({
    users: z.record(z.string(), shieldUserSchema),
});

export class JsonUserRepository implements UserRepository {
    private readonly filePath: string;
    private readonly queue: WriteQueue;

    constructor(filePath: string, queue: WriteQueue) {
        this.filePath = filePath;
        this.queue = queue;
    }

    private async load(): Promise<Map<string, ShieldUser>> {
        const loaded = await readJsonRecovering(this.filePath, fileSchema, { users: {} });
        return new Map(Object.entries(loaded.users));
    }

    async getByUsername(username: string): Promise<ShieldUser | null> {
        return (await this.load()).get(username) ?? null;
    }

    async getByJuezId(juezId: string): Promise<ShieldUser | null> {
        for (const user of (await this.load()).values()) {
            if (user.juez_id === juezId) return user;
        }
        return null;
    }

    async list(): Promise<ShieldUser[]> {
        return [...(await this.load()).values()];
    }

    async saveAll(users: ShieldUser[]): Promise<void> {
        await this.queue.run(async () => {
            await writeJsonAtomic(this.filePath, {
                users: Object.fromEntries(users.map((user) => [user.username, user])),
            });
        });
    }
}
