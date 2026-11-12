import * as dotenv from "dotenv";
dotenv.config();

import { DEFAULT_SHIELD_DATA_DIR, openJsonPersistence } from "../src/server/shield/persistence/index.js";
import { loadSigningBundle } from "../src/server/shield/signingService.js";
import { defaultDemoPassword, seedUsers } from "../src/server/shield/userSeed.js";

// S4 seed: one DEMO judicial account per judge in the signing bundle.
// Passwords default to demo-<juez_id>-2026; override one account via env
// SHIELD_DEMO_PASSWORD_<JUEZ_ID_NORMALIZADO> (non-alphanumerics -> _) or all
// accounts via SHIELD_DEMO_PASSWORD. users.json stores bcrypt hashes only.

const DATA_DIR = process.env.SHIELD_DATA_DIR ?? DEFAULT_SHIELD_DATA_DIR;

function envPasswordFor(juezId: string): string {
    const perJudge = process.env[`SHIELD_DEMO_PASSWORD_${juezId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`];
    return perJudge ?? process.env.SHIELD_DEMO_PASSWORD ?? defaultDemoPassword(juezId);
}

async function main(): Promise<void> {
    const bundle = await loadSigningBundle();
    const persistence = await openJsonPersistence(DATA_DIR);
    const { created } = await seedUsers(persistence.users, bundle, envPasswordFor);

    console.log(`users -> ${DATA_DIR}/users.json (${created.length} cuentas DEMO, bcrypt hashes)`);
    for (const account of created) {
        console.log(`  ${account.juez_id} (${account.juzgado_id}) password=${account.password}`);
    }
    console.log("Nota: credenciales DEMO del kit — nunca usar como modelo real.");
}

main().catch((error) => {
    console.error("shield-seed-users failed:", error);
    process.exitCode = 1;
});
