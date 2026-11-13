import { promises as fs } from "node:fs";
import path from "node:path";
import { WriteQueue } from "./fileQueue.js";
import type { EvidenceStore } from "./types.js";

// Evidence bytes live outside the case JSON, addressed by their sha256: the
// controlled reference is `evidence/<sha256>.bin` under the data dir. Content-
// addressed => put() is naturally idempotent.

let tmpCounter = 0;
const REF_PATTERN = /^evidence\/[0-9a-f]{64}\.bin$/;

export class FsEvidenceStore implements EvidenceStore {
    private readonly dir: string;
    private readonly queue: WriteQueue;

    constructor(dir: string, queue: WriteQueue) {
        this.dir = dir;
        this.queue = queue;
    }

    static refFor(sha256: string): string {
        return `evidence/${sha256}.bin`;
    }

    put(sha256: string, bytes: Buffer): Promise<string> {
        return this.queue.run(async () => {
            const ref = FsEvidenceStore.refFor(sha256);
            const target = path.join(this.dir, ref);
            await fs.mkdir(path.dirname(target), { recursive: true });
            const tmp = `${target}.tmp-${process.pid}-${tmpCounter++}`;
            await fs.writeFile(tmp, bytes);
            await fs.rename(tmp, target);
            return ref;
        });
    }

    async get(ref: string): Promise<Buffer | null> {
        // Path-traversal guard: refs are always evidence/<64-hex>.bin.
        if (!REF_PATTERN.test(ref)) return null;
        try {
            return await fs.readFile(path.join(this.dir, ref));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }
    }
}
