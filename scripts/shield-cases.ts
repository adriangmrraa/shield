import * as dotenv from "dotenv";
dotenv.config();

import { AuditService } from "../src/server/shield/auditService.js";
import { MatchOrchestrator } from "../src/server/shield/matchOrchestrator.js";
import { DEFAULT_SHIELD_DATA_DIR, openJsonPersistence } from "../src/server/shield/persistence/index.js";
import { QualyDataClient } from "../src/server/shield/qualydataClient.js";

// S3 driver: runs the orchestrator against the real simulator until HASTA_MIN
// (default = match end), then prints created cases, discards by verdict and the
// audit tail. All state lands under data/shield/ (gitignored runtime artifact).

const DATA_DIR = process.env.SHIELD_DATA_DIR ?? DEFAULT_SHIELD_DATA_DIR;
const INTERVAL_MS = Number(process.env.CASES_INTERVAL_MS ?? 600);
const MAX_CYCLES = Number(process.env.CASES_MAX_CYCLES ?? 10_000);
const HASTA_MIN = Number(process.env.CASES_HASTA_MIN ?? 105);
const AUDIT_TAIL = Number(process.env.CASES_AUDIT_TAIL ?? 20);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
    const persistence = await openJsonPersistence(DATA_DIR);
    const audit = new AuditService(persistence.audit);
    const client = new QualyDataClient();
    const orchestrator = new MatchOrchestrator({ client, persistence, audit, intervalMs: INTERVAL_MS });

    const estado = await client.estado();
    console.log(
        `partido=${estado.partido} minuto_actual=${estado.minuto_actual} ` +
            `fin_min=${estado.fin_min} finalizado=${estado.finalizado} acelerar=${estado.acelerar} ` +
            `data_dir=${DATA_DIR} hasta_min=${HASTA_MIN}`,
    );

    let minute = estado.minuto_actual;
    for (let cycle = 1; cycle <= MAX_CYCLES && minute < HASTA_MIN; cycle += 1) {
        const poll = await orchestrator.pollOnce();
        minute = poll.minute;
        if (poll.detections.length > 0) {
            console.log(`poll ${cycle}: minuto_actual=${minute} nuevas=${poll.detections.length}`);
        }
        if (minute < HASTA_MIN) await sleep(INTERVAL_MS);
    }
    if (minute < HASTA_MIN) {
        console.warn(`stopped at minuto_actual=${minute} before target ${HASTA_MIN} (cycle cap)`);
    }

    const status = await orchestrator.status();
    const cases = await persistence.cases.list();
    cases.sort((a, b) => a.expediente_id.localeCompare(b.expediente_id));

    console.log(`\n=== EXPEDIENTES (${cases.length}) ===`);
    for (const c of cases) {
        console.log(
            `${c.expediente_id} estado=${c.estado} host=${c.host_stream} ip=${c.ip_servidor} ` +
                `fase=${c.fase_key} origen=${c.fase_origen ?? "-"} detecciones=${c.deteccion_ids.join(",")} ` +
                `sha256=${c.captura_sha256?.slice(0, 12) ?? "-"}… vence=${c.vence_min_propuesto}`,
        );
    }

    const discards = (await audit.readAll()).filter((e) => e.evento === "detection_descartada");
    const byVerdict = new Map<string, string[]>();
    for (const d of discards) {
        const verdict = String(d.datos.verdict);
        byVerdict.set(verdict, [...(byVerdict.get(verdict) ?? []), String(d.datos.deteccion_id)]);
    }
    console.log(`\n=== DESCARTES (${discards.length}) ===`);
    for (const [verdict, ids] of byVerdict) {
        console.log(`${verdict}: ${ids.length} -> ${ids.join(", ")}`);
    }

    console.log(`\n=== STATUS ===`);
    console.log(JSON.stringify(status, null, 2));

    console.log(`\n=== AUDIT TAIL (${AUDIT_TAIL}) ===`);
    for (const entry of await audit.tail(AUDIT_TAIL)) {
        console.log(JSON.stringify(entry));
    }
}

main().catch((error) => {
    console.error("shield-cases failed:", error);
    process.exitCode = 1;
});
