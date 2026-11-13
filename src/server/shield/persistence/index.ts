import { promises as fs } from "node:fs";
import path from "node:path";
import { WriteQueue } from "./fileQueue.js";
import { FsEvidenceStore } from "./fsEvidenceStore.js";
import { JsonCaseRepository } from "./jsonCaseRepository.js";
import { JsonDetectionStore } from "./jsonDetectionStore.js";
import { JsonlAuditLog } from "./jsonlAuditLog.js";
import { JsonOrderRepository } from "./jsonOrderRepository.js";
import { JsonUserRepository } from "./jsonUserRepository.js";
import type { ShieldPersistence } from "./types.js";

export const DEFAULT_SHIELD_DATA_DIR = path.join("data", "shield");

/** Opens (or lazily creates) the JSON persistence bundle under `dir`. */
export async function openJsonPersistence(dir: string = DEFAULT_SHIELD_DATA_DIR): Promise<ShieldPersistence> {
    await fs.mkdir(dir, { recursive: true });
    const queue = new WriteQueue();
    return {
        dir,
        detections: new JsonDetectionStore(path.join(dir, "detections-seen.json"), queue),
        cases: new JsonCaseRepository(path.join(dir, "cases.json"), queue),
        audit: new JsonlAuditLog(path.join(dir, "audit.jsonl"), queue),
        evidence: new FsEvidenceStore(dir, queue),
        users: new JsonUserRepository(path.join(dir, "users.json"), queue),
        orders: new JsonOrderRepository(path.join(dir, "orders.json"), queue),
    };
}

export * from "./types.js";
export { WriteQueue } from "./fileQueue.js";
export { FsEvidenceStore } from "./fsEvidenceStore.js";
export { JsonCaseRepository } from "./jsonCaseRepository.js";
export { JsonDetectionStore } from "./jsonDetectionStore.js";
export { JsonlAuditLog } from "./jsonlAuditLog.js";
export { JsonOrderRepository } from "./jsonOrderRepository.js";
export { JsonUserRepository } from "./jsonUserRepository.js";
