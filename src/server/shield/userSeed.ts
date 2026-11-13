import bcrypt from "bcryptjs";
import { JUEZ_ROLE, type ShieldUser } from "./judicialTypes.js";
import type { UserRepository } from "./persistence/types.js";
import type { SigningBundle } from "./signingService.js";

// DEMO judicial accounts (spec §9): one account per judge in the signing
// bundle, username = judge id, password a documented DEMO pattern. Only the
// bcrypt hash is persisted — plaintext never touches users.json.

export const BCRYPT_ROUNDS = 10;

/** Default DEMO password for a judge: `demo-<juez_id>-2026` (documented, fictitious). */
export function defaultDemoPassword(juezId: string): string {
    return `demo-${juezId}-2026`;
}

export interface SeedUsersResult {
    created: Array<{ username: string; juez_id: string; juzgado_id: string; password: string }>;
}

/**
 * Creates/updates one account per judge. `passwordFor` overrides the default
 * pattern (env-configurable in the seed script). Returns the plaintext
 * passwords ONCE for the operator to note — they are never stored.
 */
export async function seedUsers(
    users: UserRepository,
    bundle: SigningBundle,
    passwordFor: (juezId: string) => string = defaultDemoPassword,
): Promise<SeedUsersResult> {
    const created: SeedUsersResult["created"] = [];
    const records: ShieldUser[] = [];
    for (const juez of bundle.jueces.values()) {
        const password = passwordFor(juez.juez_id);
        records.push({
            username: juez.juez_id,
            juez_id: juez.juez_id,
            juzgado_id: juez.juzgado_id,
            nombre: juez.nombre,
            role: JUEZ_ROLE,
            password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        });
        created.push({ username: juez.juez_id, juez_id: juez.juez_id, juzgado_id: juez.juzgado_id, password });
    }
    await users.saveAll(records);
    return { created };
}
