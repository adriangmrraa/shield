import { pathToFileURL } from "node:url";
import cors from "cors";
import express, { type Express } from "express";
import { AuditService } from "./auditService.js";
import { CaseService } from "./caseService.js";
import { MatchOrchestrator } from "./matchOrchestrator.js";
import { OrderService, type SimulatorClock } from "./orderService.js";
import { DEFAULT_SHIELD_DATA_DIR, openJsonPersistence } from "./persistence/index.js";
import type { ShieldPersistence } from "./persistence/types.js";
import { QualyDataClient } from "./qualydataClient.js";
import { requireJwtSecret, ShieldAuthService } from "./shieldAuth.js";
import { createShieldRouter, type ShieldSimApi } from "./shieldRoutes.js";
import { ShiftGuard } from "./shiftGuard.js";
import { SigningService } from "./signingService.js";

// Standalone Shield dev server (S4): the judicial API runs WITHOUT the
// editorial base app — smaller surface, faster boot. It starts even when the
// simulator is unreachable: read endpoints degrade with a clear message and
// signing stays fail-closed (no clock, no shift proof, no signature).

export interface ShieldAppDeps {
    persistence: ShieldPersistence;
    /** Simulator surface; null -> all sim-backed endpoints degrade to 503. */
    sim: ShieldSimApi | null;
    /** Judicial clock used by the order path — usually `sim`. */
    clock: SimulatorClock;
    signing: SigningService;
    jwtSecret: string;
    orchestrator?: MatchOrchestrator | null;
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
        }),
    );
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
    /** Pre-built sim surface (tests inject fakes); default builds QualyDataClient from env. */
    sim?: ShieldSimApi | null;
    clock?: SimulatorClock;
    orchestrator?: MatchOrchestrator | null;
}

/** Wires the production bundle from env: persistence + signing + optional sim. */
export async function createDevServer(options: DevServerOptions = {}): Promise<Express> {
    const persistence = await openJsonPersistence(options.dataDir ?? process.env.SHIELD_DATA_DIR ?? DEFAULT_SHIELD_DATA_DIR);
    const signing = await SigningService.fromEnv();
    const jwtSecret = requireJwtSecret();

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

    return createShieldApp({
        persistence,
        sim,
        clock,
        signing,
        jwtSecret,
        orchestrator,
    });
}

async function main(): Promise<void> {
    const { config } = await import("dotenv");
    config();

    const app = await createDevServer();
    const port = Number(process.env.PORT ?? 3000);
    app.listen(port, () => {
        console.log(`[shield:dev] API judicial en http://localhost:${port}/api/shield`);
        console.log("[shield:dev] login: POST /api/shield/auth/login (seed: npm run shield:seed)");
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error("[shield:dev] arranque fallido:", error);
        process.exitCode = 1;
    });
}
