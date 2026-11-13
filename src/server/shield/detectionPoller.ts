import type { Detection, DetectionsPage } from "./types.js";

/** Minimal slice of QualyDataClient the poller needs (structural typing: fakes welcome). */
export interface DetectionSource {
    detecciones(desde: number): Promise<DetectionsPage>;
}

/**
 * Cursor + dedup persistence. Async signatures allowed so a DB-backed store can
 * be dropped in later; the in-memory implementation below is synchronous.
 */
export interface DetectionStore {
    getCursor(): number | Promise<number>;
    saveCursor(minute: number): void | Promise<void>;
    hasSeen(id: string): boolean | Promise<boolean>;
    markSeen(id: string): void | Promise<void>;
    /** Optional listing of every seen id (metrics/status views). */
    seenIds?(): string[] | Promise<string[]>;
}

export class InMemoryDetectionStore implements DetectionStore {
    private cursor = -1;
    private readonly seen = new Set<string>();

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
    seenIds(): string[] {
        return [...this.seen];
    }
}

export interface PollResult {
    /** Simulator minute that becomes the next cursor (canonical clock). */
    minute: number;
    /** Only fresh detections, already deduplicated by id. */
    detections: Detection[];
}

export interface DetectionPollerDeps {
    client: DetectionSource;
    /** Batch handler for the running loop; optional when driving pollOnce() manually. */
    onDetections?: (detections: Detection[]) => void | Promise<void>;
    store?: DetectionStore;
    /** Real-time poll interval; at --acelerar 6, 1s real ≈ 0.1 simulated minute. */
    intervalMs?: number;
    onError?: (error: unknown) => void;
}

export class DetectionPoller {
    private readonly client: DetectionSource;
    private readonly onDetections: (detections: Detection[]) => void | Promise<void>;
    private readonly store: DetectionStore;
    private readonly intervalMs: number;
    private readonly onError: (error: unknown) => void;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    constructor(deps: DetectionPollerDeps) {
        this.client = deps.client;
        this.onDetections = deps.onDetections ?? (() => {});
        this.store = deps.store ?? new InMemoryDetectionStore();
        this.intervalMs = deps.intervalMs ?? 1_000;
        this.onError = deps.onError ?? ((error) => console.error("[detectionPoller] poll cycle failed:", error));
    }

    get isRunning(): boolean {
        return this.running;
    }

    async cursor(): Promise<number> {
        return this.store.getCursor();
    }

    /**
     * One poll cycle. Rejects on network/validation/handler failure and leaves the
     * cursor untouched, so the batch is re-fetched and re-delivered next cycle.
     */
    async pollOnce(): Promise<PollResult> {
        const desde = await this.store.getCursor();
        const page = await this.client.detecciones(desde);

        const fresh: Detection[] = [];
        for (const detection of page.detecciones) {
            if (!(await this.store.hasSeen(detection.id))) fresh.push(detection);
        }

        if (fresh.length > 0) {
            await this.onDetections(fresh);
            // Mark only after the handler succeeded: on failure the whole batch is
            // re-delivered (at-least-once), never partially skipped.
            for (const detection of fresh) await this.store.markSeen(detection.id);
        }

        // The response's minuto_actual IS the next cursor — the simulator filters
        // `desde < minuto <= corte`; never derive it from items or the local clock.
        await this.store.saveCursor(page.minuto_actual);
        return { minute: page.minuto_actual, detections: fresh };
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        void this.loop();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                await this.pollOnce();
            } catch (error) {
                // A bad cycle is logged and the loop survives; cursor is uncorrupted.
                this.onError(error);
            }
            if (!this.running) break;
            await new Promise<void>((resolve) => {
                this.timer = setTimeout(() => {
                    this.timer = null;
                    resolve();
                }, this.intervalMs);
            });
        }
    }
}
