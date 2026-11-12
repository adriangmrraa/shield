import * as dotenv from "dotenv";
dotenv.config();

import { DetectionPoller, InMemoryDetectionStore } from "../src/server/shield/detectionPoller.js";
import { QualyDataClient } from "../src/server/shield/qualydataClient.js";
import { VerificationEngine, type VerificationResult } from "../src/server/shield/verificationEngine.js";
import type { Detection } from "../src/server/shield/types.js";

const INTERVAL_MS = Number(process.env.CLASSIFY_INTERVAL_MS ?? 700);
const MAX_CYCLES = Number(process.env.CLASSIFY_MAX_CYCLES ?? 600);
const HASTA_MIN = Number(process.env.CLASSIFY_HASTA_MIN ?? 21);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printVerdict(d: Detection, r: VerificationResult): void {
    const line = {
        id: d.id,
        minuto: d.minuto,
        host_stream: r.assessment.host_stream,
        verdict: r.verdict,
        reasonCodes: r.reasonCodes,
        capturaSha256: r.evidence.capturaSha256?.slice(0, 12) ?? null,
        medidasPorIsp: r.medidasPorIsp,
    };
    console.log(JSON.stringify(line));
}

async function main(): Promise<void> {
    const client = new QualyDataClient();
    const engine = new VerificationEngine({ sources: client });
    const estado = await client.estado();
    console.log(
        `partido=${estado.partido} minuto_actual=${estado.minuto_actual} ` +
            `fin_min=${estado.fin_min} finalizado=${estado.finalizado} acelerar=${estado.acelerar}`,
    );

    const poller = new DetectionPoller({
        client,
        store: new InMemoryDetectionStore(),
        intervalMs: INTERVAL_MS,
        onDetections: async (detections) => {
            for (const detection of detections) {
                const result = await engine.classify(detection);
                printVerdict(detection, result);
            }
        },
    });

    let minute = estado.minuto_actual;
    for (let cycle = 1; cycle <= MAX_CYCLES && minute < HASTA_MIN; cycle += 1) {
        const poll = await poller.pollOnce();
        minute = poll.minute;
        await sleep(INTERVAL_MS);
    }

    if (minute < HASTA_MIN) {
        console.warn(`stopped at minuto_actual=${minute} before target ${HASTA_MIN} (cycle cap)`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("shield-classify failed:", error);
    process.exitCode = 1;
});
