import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";

// Low-level file primitives for the JSON persistence adapter. All mutations go
// through one shared WriteQueue per data dir so the poller and future routes
// serialize — there is exactly one writer and no interleaved partial files.

let tmpCounter = 0;

export class WriteQueue {
    private tail: Promise<unknown> = Promise.resolve();

    /** Runs `op` after every previously queued op settled (failures don't stall it). */
    run<T>(op: () => Promise<T>): Promise<T> {
        const next = this.tail.then(op, op);
        this.tail = next.catch(() => {});
        return next;
    }
}

/** tmp + rename: readers only ever see a complete file. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${tmpCounter++}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, filePath);
}

export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Loads and validates a JSON file. Missing file -> `fallback`. Parse or schema
 * failure -> the file is moved aside to `<name>.corrupt-<ts>` and `fallback` is
 * returned, so a truncated write never wedges the process. Other I/O errors
 * (permissions etc.) propagate — hiding them would fake a clean start.
 */
export async function readJsonRecovering<T>(
    filePath: string,
    schema: z.ZodType<T>,
    fallback: T,
): Promise<T> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw error;
    }

    let parsed: T;
    try {
        parsed = schema.parse(JSON.parse(raw));
    } catch (error) {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        await fs.rename(filePath, backup).catch(() => {});
        console.error(`[persistence] corrupt ${path.basename(filePath)} moved to ${path.basename(backup)}:`, error);
        return fallback;
    }
    return parsed;
}

/** Reads every line of a JSONL file; corrupt lines are reported and skipped. */
export async function readJsonl<T>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }

    const entries: T[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            entries.push(schema.parse(JSON.parse(line)));
        } catch (error) {
            console.error(`[persistence] skipping corrupt line ${i + 1} of ${path.basename(filePath)}:`, error);
        }
    }
    return entries;
}
