import type { Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express, { type Express } from "express";
import { AuditService } from "./auditService.js";
import { CaseService } from "./caseService.js";
import { MatchOrchestrator } from "./matchOrchestrator.js";
import { computeMetrics } from "./metricsService.js";
import { OrderService, type SimulatorClock } from "./orderService.js";
import { DEFAULT_SHIELD_DATA_DIR, openJsonPersistence } from "./persistence/index.js";
import type { ShieldPersistence } from "./persistence/types.js";
import { ProviderDispatcher } from "./providerDispatcher.js";
import { QualyDataClient } from "./qualydataClient.js";
import { requireJudge, requireJwtSecret, ShieldAuthService } from "./shieldAuth.js";
import { instrumentPersistence, ShieldEventBus } from "./shieldRealtime.js";
import { attachShieldSocket, SHIELD_SOCKET_PATH, type ShieldSocketHandle } from "./shieldSocket.js";
import { createShieldRouter, type ShieldSimApi } from "./shieldRoutes.js";
import { ShiftGuard } from "./shiftGuard.js";
import { SigningService } from "./signingService.js";
import { OrderStatusTracker } from "./statusTracker.js";

// Standalone Shield dev server (S4): the judicial API runs WITHOUT the
// editorial base app — smaller surface, faster boot. It starts even when the
// simulator is unreachable: read endpoints degrade with a clear message and
// signing stays fail-closed (no clock, no shift proof, no signature).

/** S5 background services: ISP fan-out + provider-state tracking. */
export interface DispatchRuntime {
    dispatcher: ProviderDispatcher;
    tracker: OrderStatusTracker;
}

export interface ShieldAppDeps {
    persistence: ShieldPersistence;
    /** Simulator surface; null -> all sim-backed endpoints degrade to 503. */
    sim: ShieldSimApi | null;
    /** Judicial clock used by the order path — usually `sim`. */
    clock: SimulatorClock;
    signing: SigningService;
    jwtSecret: string;
    orchestrator?: MatchOrchestrator | null;
    dispatch?: DispatchRuntime | null;
    now?: () => Date;
}

export function createShieldApp(deps: ShieldAppDeps): Express {
    const audit = new AuditService(deps.persistence.audit, deps.now);
    const caseService = new CaseService({
        cases: deps.persistence.cases,
        evidence: deps.persistence.evidence,
        audit,
        now: deps.now,
    });
    const guard = new ShiftGuard({
        cases: deps.persistence.cases,
        audit,
        turnos: () => deps.signing.turnos(),
    });
    const orderService = new OrderService({
        clock: deps.clock,
        guard,
        signing: deps.signing,
        cases: caseService,
        orders: deps.persistence.orders,
        audit,
        now: deps.now,
    });
    const auth = new ShieldAuthService({
        users: deps.persistence.users,
        audit,
        jwtSecret: deps.jwtSecret,
    });

    const app = express();
    app.disable("x-powered-by");
    app.use(cors());
    app.use(express.json());
    app.use(
        "/api/shield",
        createShieldRouter({
            persistence: deps.persistence,
            auth,
            jwtSecret: deps.jwtSecret,
            sim: deps.sim,
            guard,
            orderService,
            caseService,
            orchestrator: deps.orchestrator ?? null,
            dispatch: deps.dispatch ?? null,
        }),
    );
    // Shift table for the tray countdown — /api/shield routes fall through to
    // here only when the mounted router didn't handle them (router still runs
    // requireJudge first on every /api/shield/* request).
    app.get("/api/shield/turnos", requireJudge(deps.jwtSecret), (_req, res) => {
        res.json({ turnos: deps.signing.turnos() });
    });
    app.get("/api/shield-health", (_req, res) => {
        res.json({ ok: true, simulador: deps.sim !== null });
    });
    // Malformed JSON bodies must answer JSON too (body-parser throws before routes).
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
            res.status(400).json({ error: "BAD_JSON", detail: "cuerpo JSON inválido" });
            return;
        }
        next(err);
    });
    return app;
}

export interface DevServerOptions {
    dataDir?: string;
    /** Pre-opened persistence (E2E seeds users on it first); default opens dataDir. */
    persistence?: ShieldPersistence;
    /** Pre-built sim surface (tests inject fakes); default builds QualyDataClient from env. */
    sim?: ShieldSimApi | null;
    clock?: SimulatorClock;
    orchestrator?: MatchOrchestrator | null;
    /** Explicit dispatch runtime; default builds one when sim is a QualyDataClient. */
    dispatch?: DispatchRuntime | null;
    /** Realtime bus; a fresh one is created when not supplied. */
    events?: ShieldEventBus;
    dispatcherIntervalMs?: number;
    trackerIntervalMs?: number;
    retryDelayMs?: number;
}

/** Everything the runtime owns — the E2E driver needs these handles. */
export interface ShieldRuntime {
    app: Express;
    persistence: ShieldPersistence;
    sim: ShieldSimApi | null;
    signing: SigningService;
    jwtSecret: string;
    orchestrator: MatchOrchestrator | null;
    dispatch: DispatchRuntime | null;
    /** Domain-event bus feeding Socket.IO; already wired into persistence. */
    events: ShieldEventBus;
}

/**
 * Wires the production bundle from env: persistence + signing + sim +
 * orchestrator (detections) + dispatch (orders). `run/start` drives the loops.
 */
export async function createShieldRuntime(options: DevServerOptions = {}): Promise<ShieldRuntime> {
    const persistence =
        options.persistence ??
        (await openJsonPersistence(options.dataDir ?? process.env.SHIELD_DATA_DIR ?? DEFAULT_SHIELD_DATA_DIR));
    const signing = await SigningService.fromEnv();
    const jwtSecret = requireJwtSecret();
    // Instrument BEFORE building services: orchestrator/dispatch/routes must see
    // the wrapped audit + detection stores so their work publishes socket events.
    const events = options.events ?? new ShieldEventBus();
    instrumentPersistence(persistence, events);

    let sim: ShieldSimApi | null;
    if (options.sim !== undefined) {
        sim = options.sim;
    } else {
        try {
            sim = new QualyDataClient();
        } catch (error) {
            console.warn(`[shield:dev] simulador no configurado: ${(error as Error).message}`);
            sim = null;
        }
    }
    const clock =
        options.clock ??
        ({
            estado: () =>
                sim
                    ? sim.estado()
                    : Promise.reject(new Error("SIMULATOR_BASE_URL no configurado — reloj no disponible")),
        } satisfies SimulatorClock);

    let orchestrator = options.orchestrator ?? null;
    if (options.orchestrator === undefined && sim instanceof QualyDataClient) {
        const audit = new AuditService(persistence.audit);
        orchestrator = new MatchOrchestrator({ client: sim, persistence, audit });
    }

    let dispatch = options.dispatch ?? null;
    if (options.dispatch === undefined && sim instanceof QualyDataClient) {
        const audit = new AuditService(persistence.audit);
        const caseService = new CaseService({
            cases: persistence.cases,
            evidence: persistence.evidence,
            audit,
        });
        dispatch = {
            dispatcher: new ProviderDispatcher({
                orders: persistence.orders,
                client: sim,
                audit,
                turnos: () => signing.turnos(),
                intervalMs: options.dispatcherIntervalMs,
            }),
            tracker: new OrderStatusTracker({
                orders: persistence.orders,
                cases: persistence.cases,
                caseService,
                client: sim,
                signing,
                audit,
                turnos: () => signing.turnos(),
                intervalMs: options.trackerIntervalMs,
                retryDelayMs: options.retryDelayMs,
            }),
        };
    }

    const app = createShieldApp({
        persistence,
        sim,
        clock,
        signing,
        jwtSecret,
        orchestrator,
        dispatch,
    });
    return { app, persistence, sim, signing, jwtSecret, orchestrator, dispatch, events };
}

/** Wires the production bundle from env: persistence + signing + optional sim. */
export async function createDevServer(options: DevServerOptions = {}): Promise<Express> {
    return (await createShieldRuntime(options)).app;
}

/** Same report as GET /api/shield/metrics — periodic snapshot for shield:metrics. */
async function metricsSnapshot(
    persistence: ShieldPersistence,
    sim: ShieldSimApi | null,
    orchestrator: MatchOrchestrator | null,
): Promise<Record<string, unknown>> {
    const casos = await persistence.cases.list();
    const casosPorEstado: Record<string, number> = {};
    for (const exp of casos) casosPorEstado[exp.estado] = (casosPorEstado[exp.estado] ?? 0) + 1;
    const orders = await persistence.orders.list();
    const ordenesPorEstado: Record<string, number> = {};
    for (const order of orders) ordenesPorEstado[order.estado] = (ordenesPorEstado[order.estado] ?? 0) + 1;
    const seen = persistence.detections.seenIds ? await persistence.detections.seenIds() : null;
    const auditEventos: Record<string, number> = {};
    for (const entry of await persistence.audit.readAll()) {
        auditEventos[entry.evento] = (auditEventos[entry.evento] ?? 0) + 1;
    }
    return {
        casos_por_estado: casosPorEstado,
        ordenes_por_estado: ordenesPorEstado,
        detecciones_vistas: seen?.length ?? null,
        audit_eventos: auditEventos,
        orchestrator: orchestrator ? await orchestrator.status() : null,
        isp: sim ? computeMetrics({ orders, expedientes: casos, providers: await sim.proveedores() }) : null,
    };
}

/**
 * Socket.IO on the same HTTP server (S7). Returns the handle so callers own the
 * lifecycle; emissions stop with the run loops because they are all sourced
 * from the audited write path.
 */
export function attachShieldRealtime(
    httpServer: HttpServer,
    runtime: Pick<ShieldRuntime, "jwtSecret" | "persistence" | "sim" | "orchestrator" | "events">,
): ShieldSocketHandle {
    return attachShieldSocket(httpServer, {
        jwtSecret: runtime.jwtSecret,
        bus: runtime.events,
        metricsSnapshot: () => metricsSnapshot(runtime.persistence, runtime.sim, runtime.orchestrator),
        running: () => runtime.orchestrator?.pollerRunning ?? false,
        corsOrigin: process.env.SHIELD_SOCKET_ORIGIN ?? true,
    });
}

async function main(): Promise<void> {
    const { config } = await import("dotenv");
    config();

    const runtime = await createShieldRuntime();
    const port = Number(process.env.PORT ?? 3000);
    const server = runtime.app.listen(port, () => {
        console.log(`[shield:dev] API judicial en http://localhost:${port}/api/shield`);
        console.log(`[shield:dev] Socket.IO en http://localhost:${port}${SHIELD_SOCKET_PATH}`);
        console.log("[shield:dev] login: POST /api/shield/auth/login (seed: npm run shield:seed)");
    });
    attachShieldRealtime(server, runtime);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error("[shield:dev] arranque fallido:", error);
        process.exitCode = 1;
    });
}
