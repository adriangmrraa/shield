import * as dotenv from "dotenv";
dotenv.config();

import { DetectionPoller, InMemoryDetectionStore } from "../src/server/shield/detectionPoller.js";
import { QualyDataClient } from "../src/server/shield/qualydataClient.js";
import type { Detection } from "../src/server/shield/types.js";

const CYCLES = Number(process.env.SMOKE_CYCLES ?? 3);
const INTERVAL_MS = Number(process.env.SMOKE_INTERVAL_MS ?? 1_000);
const MAX_CYCLES = Number(process.env.SMOKE_MAX_CYCLES ?? 45);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printDetection(d: Detection): void {
    const summary = {
        id: d.id,
        minuto: d.minuto,
        host_stream: d.host_stream,
        ip_servidor: d.ip_servidor,
        asn: d.asn,
        marca_de_agua_extraida: d.marca_de_agua_extraida,
        captura_b64: `${d.captura.contenido_b64.slice(0, 16)}…(${d.captura.contenido_b64.length} chars)`,
    };
    console.log(`  ${JSON.stringify(summary)}`);
}

async function main(): Promise<void> {
    const client = new QualyDataClient();
    const estado = await client.estado();
    console.log(
        `partido=${estado.partido} minuto_actual=${estado.minuto_actual} ` +
            `fin_min=${estado.fin_min} finalizado=${estado.finalizado} acelerar=${estado.acelerar}`,
    );

    const poller = new DetectionPoller({
        client,
        store: new InMemoryDetectionStore(),
        intervalMs: INTERVAL_MS,
    });

    let sawDetections = false;
    let cycle = 0;
    while (cycle < MAX_CYCLES && (cycle < CYCLES || !sawDetections)) {
        cycle += 1;
        const { minute, detections } = await poller.pollOnce();
        sawDetections = sawDetections || detections.length > 0;
        console.log(`poll ${cycle}: minuto_actual=${minute} nuevas=${detections.length}`);
        detections.forEach(printDetection);
        if (cycle < MAX_CYCLES && (cycle < CYCLES || !sawDetections)) await sleep(INTERVAL_MS);
    }

    if (!sawDetections) {
        console.warn(`No detections after ${cycle} cycles — simulator may be earlier than minute 2.`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("shield-smoke failed:", error);
    process.exitCode = 1;
});
