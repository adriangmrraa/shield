import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config();

import { createShieldRuntime } from "../src/server/shield/devServer.js";
import type { ShieldOrder } from "../src/server/shield/judicialTypes.js";
import { DEFAULT_SHIELD_DATA_DIR, openJsonPersistence } from "../src/server/shield/persistence/index.js";
import { QualyDataClient } from "../src/server/shield/qualydataClient.js";
import { loadSigningBundle } from "../src/server/shield/signingService.js";
import { seedUsers } from "../src/server/shield/userSeed.js";

// S5 end-to-end (brief §E2E): REAL simulator + REAL Shield dev server. The
// driver only plays the judge's role over the public API — it polls the
// pending tray, logs in as whichever judge is on shift, and approves cases
// through POST /cases/:id/approve (JWT + shift guard, no bypasses). The
// orchestrator, dispatcher and tracker loops do the rest.
//
// Run: simulator on :8080 (PYTHONUTF8=1, --acelerar 6), then `npm run shield:e2e`.
// Artifacts land in salida/artefactos/ before exit.

const SIM_URL = process.env.SIMULATOR_BASE_URL ?? "http://localhost:8080";
const DATA_DIR = process.env.SHIELD_DATA_DIR ?? DEFAULT_SHIELD_DATA_DIR;
const ARTIFACT_DIR = process.env.SHIELD_ARTIFACT_DIR ?? "salida/artefactos";
const SIM_LOG = process.env.SIMULATOR_LOG ?? "tools/desafio-futbol/salida/registro.jsonl";
const POLL_MS = Number(process.env.SHIELD_E2E_POLL_MS ?? 700);
const PASSWORD_ENV = "SHIELD_DEMO_PASSWORD";

process.env.SIMULATOR_BASE_URL = SIM_URL;
process.env.SHIELD_DATA_DIR = DATA_DIR;
process.env.SHIELD_JWT_SECRET ??= "shield-e2e-demo-secret";

interface Json {
    [key: string]: any;
}

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[e2e ${ts}] ${msg}`);
}

async function api(base: string, method: "GET" | "POST", urlPath: string, options: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${base}/api/shield${urlPath}`, {
        method,
        headers: {
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Json };
}

/** Exact port of servidor.py:fraccion — predicts which cumbre orders fail. */
function fraccion(...partes: string[]): number {
    const digest = createHash("sha256").update(partes.join("|"), "utf8").digest("hex");
    return parseInt(digest.slice(0, 8), 16) / 0x100000000;
}

function passwordFor(juezId: string): string {
    return process.env[`SHIELD_DEMO_PASSWORD_${juezId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`]
        ?? process.env[PASSWORD_ENV]
        ?? `demo-${juezId}-2026`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtPct = (v: unknown) => (typeof v === "number" ? v.toFixed(1) : "?");

async function copyArtifacts(dataDir: string): Promise<void> {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const copies: Array<[string, string]> = [
        [path.join(dataDir, "orders.json"), path.join(ARTIFACT_DIR, "orders.json")],
        [path.join(dataDir, "audit.jsonl"), path.join(ARTIFACT_DIR, "audit.jsonl")],
        [path.join(dataDir, "cases.json"), path.join(ARTIFACT_DIR, "cases.json")],
        [SIM_LOG, path.join(ARTIFACT_DIR, "simulador-registro.jsonl")],
    ];
    for (const [src, dst] of copies) {
        try {
            await fs.copyFile(src, dst);
            log(`artefacto: ${src} -> ${dst}`);
        } catch {
            log(`artefacto omitido (no existe): ${src}`);
        }
    }
}

async function main(): Promise<void> {
    const sim = new QualyDataClient({ baseUrl: SIM_URL });
    const estadoInicial = await sim.estado();
    log(`simulador OK: ${SIM_URL} minuto=${estadoInicial.minuto_actual} fin_min=${estadoInicial.fin_min}`);

    const bundle = await loadSigningBundle();
    const persistence = await openJsonPersistence(DATA_DIR);
    await seedUsers(persistence.users, bundle);

    const runtime = await createShieldRuntime({ persistence });
    if (!runtime.orchestrator || !runtime.dispatch) {
        throw new Error("createShieldRuntime no construyó orquestador+dispatch (¿SIMULATOR_BASE_URL mal?)");
    }
    const server = await new Promise<ReturnType<typeof runtime.app.listen>>((resolve) => {
        const s = runtime.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    log(`shield dev server: ${base} (data=${DATA_DIR})`);

    const tokens = new Map<string, string>();
    const login = async (juezId: string): Promise<string> => {
        const cached = tokens.get(juezId);
        if (cached) return cached;
        const res = await api(base, "POST", "/auth/login", {
            body: { username: juezId, password: passwordFor(juezId) },
        });
        if (res.status !== 200) throw new Error(`login ${juezId} -> ${res.status}: ${JSON.stringify(res.body)}`);
        tokens.set(juezId, res.body.token);
        return res.body.token;
    };

    // run/start is JWT-protected: any valid judge session starts the loops.
    const firstJudge = bundle.turnos[0]?.juez_id;
    if (!firstJudge) throw new Error("bundle.turnos vacío");
    const start = await api(base, "POST", "/run/start", { token: await login(firstJudge) });
    log(`run/start -> ${start.status}`);

    const aprobados = new Set<string>();
    const aprobaciones: Array<{ expediente: string; juez: string; minuto: number }> = [];
    let lastMinuto = -1;
    let pendientesSinTurno = 0;
    const deadline = Date.now() + 45 * 60_000;

    while (Date.now() < deadline) {
        const status = await api(base, "GET", "/status", { token: tokens.get(firstJudge) ?? (await login(firstJudge)) });
        const minuto = status.body.minuto_actual as number | null;
        const finMin = (status.body.reloj?.fin_min as number | undefined) ?? estadoInicial.fin_min;
        const finalizado = status.body.reloj?.finalizado === true;
        if (minuto !== null && Math.floor(minuto) !== lastMinuto) {
            lastMinuto = Math.floor(minuto);
            log(`minuto=${minuto.toFixed(1)}/${finMin} pendientes=${status.body.contadores?.casos_por_estado?.pendiente_juez ?? 0} ordenes=${JSON.stringify(status.body.contadores?.ordenes_por_estado ?? {})}`);
        }

        if (minuto !== null && (minuto >= finMin + 6 || (finalizado && minuto >= finMin + 6))) {
            log(`fin de partido + gracia alcanzada (minuto=${minuto.toFixed(1)}, fin=${finMin})`);
            break;
        }

        // Tray: the GET itself re-assigns pending cases to the on-duty judge.
        const juezDeTurno = status.body.juez_turno_actual as string | null;
        if (juezDeTurno) {
            const token = await login(juezDeTurno);
            const tray = await api(base, "GET", "/cases?estado=pendiente_juez", { token });
            const pendientes = (tray.body.cases ?? []) as Json[];
            pendientesSinTurno = 0;
            for (const exp of pendientes) {
                if (aprobados.has(exp.expediente_id)) continue;
                const res = await api(base, "POST", `/cases/${exp.expediente_id}/approve`, { token });
                if (res.status === 200) {
                    aprobados.add(exp.expediente_id);
                    aprobaciones.push({ expediente: exp.expediente_id, juez: juezDeTurno, minuto: Math.floor(minuto ?? -1) });
                    log(`APROBADO ${exp.expediente_id} por ${juezDeTurno} @min=${(minuto ?? -1).toFixed(0)} -> ${res.body.ordenes?.length ?? 0} órdenes`);
                } else {
                    log(`approve ${exp.expediente_id} -> ${res.status} ${res.body.error ?? ""}`);
                }
            }
        } else {
            pendientesSinTurno += 1;
            if (pendientesSinTurno % 20 === 1) log("sin juez de turno — esperando próxima ventana");
        }

        await sleep(POLL_MS);
    }

    const stop = await api(base, "POST", "/run/stop", { token: await login(firstJudge) });
    log(`run/stop -> ${stop.status}`);
    // Flush: let in-flight loops settle before the final read.
    await sleep(1_500);

    // --- Final report --------------------------------------------------------
    const orders = await persistence.orders.list();
    const casos = await persistence.cases.list();
    const providers = await sim.proveedores();
    const metrics = await api(base, "GET", "/metrics", { token: await login(firstJudge) });

    const porIsp = new Map<string, ShieldOrder[]>();
    for (const o of orders) {
        const list = porIsp.get(o.proveedor_id) ?? [];
        list.push(o);
        porIsp.set(o.proveedor_id, list);
    }
    const alcanzaronAplicada = (o: ShieldOrder) => o.aplicada_min !== undefined || ["aplicada", "vencida", "levantada"].includes(o.estado);

    console.log("\n===== REPORTE E2E — S5 =====");
    console.log(`aprobaciones realizadas: ${aprobaciones.length}`);
    for (const a of aprobaciones) console.log(`  ${a.expediente} juez=${a.juez} min=${a.minuto}`);

    console.log("\nórdenes por ISP:");
    const ispsConAplicada = new Set<string>();
    const retries = new Map<string, number>();
    for (const p of providers) {
        const list = porIsp.get(p.id) ?? [];
        const intentosMax = Math.max(0, ...list.map((o) => o.intento ?? 1));
        retries.set(p.id, Math.max(0, intentosMax - 1) * (list.length ? 1 : 0));
        if (list.some(alcanzaronAplicada)) ispsConAplicada.add(p.id);
        const conteo: Record<string, number> = {};
        for (const o of list) conteo[o.estado] = (conteo[o.estado] ?? 0) + 1;
        console.log(`  ${p.id.padEnd(8)} ordenes=${list.length} ${JSON.stringify(conteo)}`);
    }
    const reintentosTotales = orders.filter((o) => (o.intento ?? 1) > 1).length;
    console.log(`reintentos emitidos (intento>=2): ${reintentosTotales}`);

    console.log("\nexpedientes:");
    for (const c of casos) console.log(`  ${c.expediente_id} ${c.estado} (senal=${c.senal_key} host=${c.host_stream})`);

    const cob = metrics.body.isp?.cobertura;
    console.log(`\ncobertura ponderada vigente=${fmtPct(cob?.cobertura_ponderada_pct)}%  alcanzada=${fmtPct(cob?.cobertura_alcanzada_ponderada_pct)}%`);
    for (const m of (metrics.body.isp?.por_isp ?? []) as Json[]) {
        console.log(
            `  ${String(m.proveedorId).padEnd(8)} clientes=${m.clientes} enviadas=${m.enviadas} reintentos=${m.reintentos} slots=${m.slots} aplicadas=${m.aplicadas} vencidas=${m.vencidas} fallidas=${m.fallidas} rechazadas=${m.rechazadas} ultimo=${m.ultimo_estado ?? "-"} demora_media=${m.demora_promedio_min ?? "-"}min`,
        );
    }

    // --- Verifications --------------------------------------------------------
    const fallas: string[] = [];
    const ok = (cond: boolean, msg: string) => {
        console.log(`${cond ? "OK " : "FAIL"} ${msg}`);
        if (!cond) fallas.push(msg);
    };

    ok(ispsConAplicada.size >= 3, `>=3 ISPs con orden aplicada (got ${ispsConAplicada.size}: ${[...ispsConAplicada].join(",")})`);

    // Shared-IP targets must only ever produce dominio orders.
    const sharedSignals = new Set(casos.filter((c) => c.riesgo?.ip_compartida === true).map((c) => c.expediente_id));
    const ipOnShared = orders.filter((o) => o.tipo === "ip" && sharedSignals.has(o.expediente_id));
    ok(ipOnShared.length === 0, `IPs compartidas (golazo-libre/verpartido-hd) solo dominio (ip orders on shared: ${ipOnShared.length})`);

    const valleIp = orders.filter((o) => o.proveedor_id === "valle" && o.tipo === "ip");
    ok(valleIp.length === 0, `valle solo recibe dominio (ip orders: ${valleIp.length})`);

    // cumbre deterministic failure: predict via fraccion() which -01 orders fail.
    const cumbre = porIsp.get("cumbre") ?? [];
    const fallasEsperadas = cumbre.filter((o) => (o.intento ?? 1) === 1 && fraccion("cumbre", o.orden_id, "falla") < 0.35).length;
    const cumbreRetries = cumbre.filter((o) => (o.intento ?? 1) >= 2).length;
    log(`cumbre: fallas -01 esperadas por fraccion=${fallasEsperadas}, reintentos emitidos=${cumbreRetries}`);
    if (fallasEsperadas > 0) ok(cumbreRetries > 0, `cumbre retry -02+ emitido (esperadas=${fallasEsperadas})`);
    else log("cumbre: ningún orden_id -01 con fraccion<0.35 — retry no determinista en este escenario");

    const reintentosInvalidos = orders.filter((o) => (o.intento ?? 1) >= 2 && !/-(\d{2,})$/.test(o.orden_id));
    ok(reintentosInvalidos.length === 0, "reintentos usan sufijo -NN");

    // Simulator log: every provider-received order must carry juez_de_turno:true.
    let ordenesRecibidasSim = 0;
    let juezDeTurnoFalse = 0;
    try {
        const raw = await fs.readFile(SIM_LOG, "utf8");
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            const rec = JSON.parse(line) as Json;
            if (rec.evento === "orden_recibida" || rec.tipo === "orden_recibida" || rec.orden_id) {
                if (rec.evento === "orden_recibida" || rec.orden_id) {
                    ordenesRecibidasSim += 1;
                    if (rec.juez_de_turno === false) juezDeTurnoFalse += 1;
                }
            }
        }
    } catch {
        log(`WARN: no pude leer ${SIM_LOG}`);
    }
    ok(juezDeTurnoFalse === 0 && ordenesRecibidasSim > 0, `sim log: ${ordenesRecibidasSim} órdenes recibidas, juez_de_turno:false=${juezDeTurnoFalse}`);

    // Zero active IP orders anywhere post-grace (local truth + remote truth).
    const ipActivasLocal = orders.filter((o) => o.tipo === "ip" && o.estado === "aplicada");
    ok(ipActivasLocal.length === 0, `post-gracia: cero órdenes ip locales en aplicada (got ${ipActivasLocal.length})`);
    let ipActivasRemotas = 0;
    for (const p of providers) {
        const remotas = await sim.ordenes(p.id).catch(() => [] as Json[]);
        for (const r of remotas) if (r.tipo === "ip" && r.estado === "aplicada") ipActivasRemotas += 1;
    }
    ok(ipActivasRemotas === 0, `post-gracia: cero órdenes ip remotas en aplicada (got ${ipActivasRemotas})`);
    ok(runtime.dispatch.tracker.graceReport.verificado, "grace check ejecutado (fin_min+5)");

    await copyArtifacts(DATA_DIR);
    server.close();

    if (fallas.length > 0) {
        console.error(`\nE2E FAIL (${fallas.length}): ${fallas.join(" | ")}`);
        process.exitCode = 1;
    } else {
        console.log("\nE2E OK — todos los chequeos S5 pasaron");
    }
}

main().catch((error) => {
    console.error("shield-e2e failed:", error);
    process.exitCode = 1;
});
