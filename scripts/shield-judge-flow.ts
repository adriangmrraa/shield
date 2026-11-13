import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config();

import { buildPendienteJuezExpediente } from "../src/server/shield/demoSeed.js";
import { createShieldApp } from "../src/server/shield/devServer.js";
import { openJsonPersistence } from "../src/server/shield/persistence/index.js";
import { loadSigningBundle, SigningService } from "../src/server/shield/signingService.js";
import { juecesDeTurno } from "../src/server/shield/shiftGuard.js";
import { seedUsers } from "../src/server/shield/userSeed.js";
import type { CourtInfo, DetectionsPage, Provider, SimulatorState } from "../src/server/shield/types.js";

// S4 gate (brief §Gates.3): devServer on an ephemeral port + injected simulator
// clock. One pending expediente is approved by the judge ON shift (minute 10,
// Dra. Laura Ficticia) -> signed order + HMAC verification; then the same judge
// approves another pending case at minute 60 (Dr. Martín Ejemplo's shift)
// -> controlled 403, zero orders.

const JWT_SECRET = "judge-flow-demo-secret";

class FakeSim {
    minuto = 10;
    constructor(private readonly turnos: { juez_id: string; desde_min: number; hasta_min: number }[]) {}

    estado(): Promise<SimulatorState> {
        return Promise.resolve({
            partido: "judge-flow-demo",
            minuto_actual: this.minuto,
            fin_min: 105,
            finalizado: this.minuto >= 105,
            acelerar: 1,
            jueces_de_turno: juecesDeTurno(this.minuto, this.turnos),
        });
    }
    detecciones(): Promise<DetectionsPage> {
        return Promise.resolve({ minuto_actual: this.minuto, detecciones: [] });
    }
    proveedores(): Promise<Provider[]> {
        return Promise.resolve([]);
    }
    juzgados(): Promise<CourtInfo> {
        return Promise.resolve({ juzgados: [], turnos: this.turnos, de_turno_ahora: [] });
    }
}

async function postJson(base: string, path: string, body: unknown, token?: string) {
    const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function main(): Promise<void> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-judge-flow-"));
    const bundle = await loadSigningBundle();
    const persistence = await openJsonPersistence(dataDir);
    await seedUsers(persistence.users, bundle);
    const laura = bundle.jueces.get("jueza-laura-ficticia");
    if (!laura) throw new Error("bundle sin jueza-laura-ficticia");

    const exp1 = buildPendienteJuezExpediente({ expediente_id: "EXP-flow-0001" });
    const exp2 = buildPendienteJuezExpediente({ expediente_id: "EXP-flow-0002" });
    await persistence.cases.save(exp1);
    await persistence.cases.save(exp2);

    const sim = new FakeSim(bundle.turnos);
    const app = createShieldApp({
        persistence,
        sim,
        clock: sim,
        signing: await SigningService.fromEnv(),
        jwtSecret: JWT_SECRET,
    });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    console.log(`devServer: ${base} (data_dir=${dataDir})`);

    // --- Paso 1: juez DE TURNO aprueba -------------------------------------
    console.log(`\n[1] minuto_simulado=10 -> turno de jueza-laura-ficticia`);
    const login = await postJson(base, "/api/shield/auth/login", {
        username: "jueza-laura-ficticia",
        password: "demo-jueza-laura-ficticia-2026",
    });
    console.log(`login jueza-laura-ficticia -> ${login.status} (juez=${login.body.juez?.juez_id})`);
    const token = login.body.token as string;

    const approve = await postJson(base, "/api/shield/cases/EXP-flow-0001/approve", {}, token);
    console.log(`approve EXP-flow-0001 -> ${approve.status}`);
    const orden = approve.body.ordenes?.[0];
    console.log(`orden emitida: ${JSON.stringify(orden)}`);

    // Verificación HMAC: recomputo el string exacto del contrato con la clave.
    const esperada = createHmac("sha256", laura.clave)
        .update(`${orden.orden_id}|${orden.tipo}|${orden.objetivo}|${orden.vence_min}|${orden.juez_id}`, "utf8")
        .digest("hex");
    console.log(`firma=${orden.firma}`);
    console.log(`firma_verificada=${esperada === orden.firma}`);

    // --- Paso 2: MISMO juez FUERA DE TURNO ---------------------------------
    sim.minuto = 60;
    console.log(`\n[2] minuto_simulado=60 -> turno de juez-martin-ejemplo`);
    const blocked = await postJson(base, "/api/shield/cases/EXP-flow-0002/approve", {}, token);
    console.log(`approve EXP-flow-0002 (laura, fuera de turno) -> ${blocked.status}`);
    console.log(`respuesta: ${JSON.stringify(blocked.body)}`);
    const ordenes = await persistence.orders.list();
    console.log(`ordenes persistidas=${ordenes.length} (esperado: 1 — solo la del paso [1])`);

    server.close();
}

main().catch((error) => {
    console.error("shield-judge-flow failed:", error);
    process.exitCode = 1;
});
