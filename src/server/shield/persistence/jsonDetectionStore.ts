import { z } from "zod";
import type { DetectionStore } from "../detectionPoller.js";
import { readJsonRecovering, writeJsonAtomic, WriteQueue } from "./fileQueue.js";

// Poller cursor + seen ids persisted to detections-seen.json: restarting the
// app resumes the feed instead of reprocessing detections already ingested.
// Stateless: the file is the source of truth, re-read on every access so a
// second handle in the same process never sees stale data.

const stateSchema = z.object({
    cursor: z.number(),
    seen: z.array(z.string()),
});

interface StoreState {
    cursor: number;
    seen: Set<string>;
}

export class JsonDetectionStore implements DetectionStore {
    private readonly filePath: string;
    private readonly queue: WriteQueue;

    constructor(filePath: string, queue: WriteQueue) {
        this.filePath = filePath;
        this.queue = queue;
    }

    private async load(): Promise<StoreState> {
        const loaded = await readJsonRecovering(this.filePath, stateSchema, { cursor: -1, seen: [] });
        return { cursor: loaded.cursor, seen: new Set(loaded.seen) };
    }

    async getCursor(): Promise<number> {
        return (await this.load()).cursor;
    }

    async hasSeen(id: string): Promise<boolean> {
        return (await this.load()).seen.has(id);
    }

    async seenIds(): Promise<string[]> {
        return [...(await this.load()).seen];
    }

    saveCursor(minute: number): Promise<void> {
        return this.queue.run(async () => {
            const state = await this.load();
            state.cursor = minute;
            await writeJsonAtomic(this.filePath, { cursor: state.cursor, seen: [...state.seen] });
        });
    }

    markSeen(id: string): Promise<void> {
        return this.queue.run(async () => {
            const state = await this.load();
            state.seen.add(id);
            await writeJsonAtomic(this.filePath, { cursor: state.cursor, seen: [...state.seen] });
        });
    }
}
