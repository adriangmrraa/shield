import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { AuditService } from "./auditService.js";
import { CaseNotFoundError, CaseService } from "./caseService.js";
import { ESTADOS_EXPEDIENTE, InvalidTransitionError, type EstadoExpediente } from "./expedienteTypes.js";
import { loginBodySchema, rejectBodySchema, type JudicialIdentity } from "./judicialTypes.js";
import type { MatchOrchestrator } from "./matchOrchestrator.js";
import {
    CaseNotPendingError,
    MatchFinishedError,
    NotAssignedJudgeError,
    OrderService,
    SimulatorUnavailableError,
} from "./orderService.js";
import type { ShieldPersistence } from "./persistence/types.js";
import { SimulatorHttpError, SimulatorNetworkError } from "./qualydataClient.js";
import { requireJudge, ShieldAuthService } from "./shieldAuth.js";
import { OutOfShiftError, ShiftGuard } from "./shiftGuard.js";
import { SigningConfigError, SigningService, UnknownJudgeError } from "./signingService.js";
import type { CourtInfo, DetectionsPage, Provider, SimulatorState } from "./types.js";

// Own API (spec §12): /api/shield/*. POST /auth/login is the only public route;
// everything else sits behind requireJudge. Every judicial action re-validates
// the shift against a FRESH simulator clock read — the tray's can_sign is only
// a hint, never the authorization.

/** Simulator surface the routes consume; QualyDataClient satisfies it. */
export interface ShieldSimApi {
    estado(): Promise<SimulatorState>;
    detecciones(desde: number): Promise<DetectionsPage>;
    proveedores(): Promise<Provider[]>;
    juzgados(): Promise<CourtInfo>;
}

export interface ShieldRouterDeps {
    persistence: ShieldPersistence;
    auth: ShieldAuthService;
    jwtSecret: string;
    sim: ShieldSimApi | null;
    guard: ShiftGuard;
    orderService: OrderService;
    caseService: CaseService;
    signing: SigningService;
    orchestrator?: MatchOrchestrator | null;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Express 4 does not forward async rejections — wrap every handler. */
const h =
    (handler: AsyncHandler) =>
    (req: Request, res: Response, next: NextFunction): void => {
        handler(req, res, next).catch(next);
    };

function requireIdentity(req: Request): JudicialIdentity {
    // requireJudge ran first — absence means a wiring bug, not a client error.
    if (!req.juez) throw new Error("requireJudge did not populate req.juez");
    return req.juez;
}

interface TrayContext {
    minuto_actual: number | null;
    jueces_de_turno: string[] | null;
    juez_turno_actual: string | null;
    simulador_disponible: boolean;
}

export function createShieldRouter(deps: ShieldRouterDeps): Router {
    const router = Router();
    const { persistence, sim } = deps;

    /** Fresh clock read for tray views; degrades to "unavailable" instead of failing. */
    const trayContext = async (): Promise<TrayContext> => {
        if (!sim) {
            return {
                minuto_actual: null,
                jueces_de_turno: null,
                juez_turno_actual: null,
                simulador_disponible: false,
            };
        }
        try {
            const estado = await sim.estado();
            const deTurno = deps.guard.deTurno(estado.minuto_actual);
            await deps.guard.syncAssignments(estado.minuto_actual);
            return {
                minuto_actual: estado.minuto_actual,
                jueces_de_turno: deTurno,
                juez_turno_actual: deTurno[0] ?? null,
                simulador_disponible: true,
            };
        } catch {
            return {
                minuto_actual: null,
                jueces_de_turno: null,
                juez_turno_actual: null,
                simulador_disponible: false,
            };
        }
    };

    // --- public ------------------------------------------------------------

    router.post(
        "/auth/login",
        h(async (req, res) => {
            const body = loginBodySchema.parse(req.body ?? {});
            const result = await deps.auth.login(body.username, body.password);
            if (!result) {
                res.status(401).json({ error: "UNAUTHORIZED", detail: "Credenciales inválidas" });
                return;
            }
            res.json(result);
        }),
    );

    // --- authenticated judicial area ------------------------------------------

    router.use(requireJudge(deps.jwtSecret));

    router.get(
        "/status",
        h(async (_req, res) => {
            const ctx = await trayContext();
            let reloj: Pick<SimulatorState, "minuto_actual" | "fin_min" | "finalizado" | "acelerar"> | null = null;
            if (sim) {
                try {
                    const estado = await sim.estado();
                    reloj = {
                        minuto_actual: estado.minuto_actual,
                        fin_min: estado.fin_min,
                        finalizado: estado.finalizado,
                        acelerar: estado.acelerar,
                    };
                } catch {
                    reloj = null;
                }
            }
            res.json({
                ...ctx,
                reloj,
                contadores: await counters(persistence),
                orchestrator: { running: deps.orchestrator?.pollerRunning ?? false },
            });
        }),
    );

    router.get(
        "/detections",
        h(async (_req, res) => {
            if (!sim) throw new SimulatorUnavailableError(new Error("sim client not configured"));
            // desde=-1 replays every detection the simulator published so far.
            const page = await sim.detecciones(-1);
            const expByDet = new Map<string, string>();
            for (const exp of await persistence.cases.list()) {
                for (const detId of exp.deteccion_ids) expByDet.set(detId, exp.expediente_id);
            }
            res.json({
                minuto_actual: page.minuto_actual,
                detecciones: page.detecciones.map((d) => ({
                    ...d,
                    captura: { ...d.captura, contenido_b64: undefined },
                    expediente_id: expByDet.get(d.id) ?? null,
                })),
            });
        }),
    );

    router.get(
        "/cases",
        h(async (req, res) => {
            const ctx = await trayContext();
            const estadoParam = typeof req.query.estado === "string" ? req.query.estado : undefined;
            if (estadoParam !== undefined && !(ESTADOS_EXPEDIENTE as readonly string[]).includes(estadoParam)) {
                res.status(400).json({ error: "BAD_REQUEST", detail: `estado inválido: ${estadoParam}` });
                return;
            }
            const juez = requireIdentity(req);
            const cases = await deps.caseService.listByEstado(estadoParam as EstadoExpediente | undefined);
            res.json({
                ...ctx,
                cases: cases.map((exp) => ({
                    ...exp,
                    can_sign: ctx.minuto_actual !== null && deps.guard.canSign(exp, juez.juez_id, ctx.minuto_actual),
                })),
            });
        }),
    );

    router.get(
        "/cases/:id",
        h(async (req, res) => {
            const ctx = await trayContext();
            const juez = requireIdentity(req);
            const expediente = await deps.caseService.getById(req.params.id);
            if (!expediente) throw new CaseNotFoundError(req.params.id);
            const ordenes = await persistence.orders.listByExpediente(expediente.expediente_id);
            res.json({
                ...ctx,
                expediente,
                ordenes,
                can_sign: ctx.minuto_actual !== null && deps.guard.canSign(expediente, juez.juez_id, ctx.minuto_actual),
            });
        }),
    );

    router.post(
        "/cases/:id/approve",
        h(async (req, res) => {
            const juez = requireIdentity(req);
            const result = await deps.orderService.approve(req.params.id, juez);
            res.json(result);
        }),
    );

    router.post(
        "/cases/:id/reject",
        h(async (req, res) => {
            const juez = requireIdentity(req);
            const body = rejectBodySchema.parse(req.body ?? {});
            const result = await deps.orderService.reject(req.params.id, juez, body.motivo);
            res.json(result);
        }),
    );

    router.get(
        "/providers",
        h(async (_req, res) => {
            if (!sim) throw new SimulatorUnavailableError(new Error("sim client not configured"));
            const providers = await sim.proveedores();
            const orders = await persistence.orders.list();
            res.json({
                providers: providers.map((p) => ({
                    ...p,
                    ordenes_shield: orders.filter((o) => o.proveedor_id === p.id).length,
                })),
            });
        }),
    );

    router.get(
        "/orders",
        h(async (_req, res) => {
            res.json({ orders: await persistence.orders.list() });
        }),
    );

    router.get(
        "/audit",
        h(async (req, res) => {
            const n = Math.min(Math.max(Number(req.query.n ?? 50) || 50, 1), 500);
            res.json({ entries: await persistence.audit.tail(n) });
        }),
    );

    router.get(
        "/metrics",
        h(async (_req, res) => {
            const auditEntries = await persistence.audit.readAll();
            const porEvento: Record<string, number> = {};
            for (const entry of auditEntries) {
                porEvento[entry.evento] = (porEvento[entry.evento] ?? 0) + 1;
            }
            res.json({
                ...(await counters(persistence)),
                audit_eventos: porEvento,
                orchestrator: deps.orchestrator ? await deps.orchestrator.status() : null,
            });
        }),
    );

    router.post("/run/start", (_req, res) => {
        if (!deps.orchestrator) {
            res.status(503).json({ error: "SIMULATOR_UNAVAILABLE", detail: "Sin orquestador: simulador no configurado" });
            return;
        }
        deps.orchestrator.start();
        res.json({ running: true });
    });

    router.post("/run/stop", (_req, res) => {
        if (!deps.orchestrator) {
            res.status(503).json({ error: "SIMULATOR_UNAVAILABLE", detail: "Sin orquestador: simulador no configurado" });
            return;
        }
        deps.orchestrator.stop();
        res.json({ running: false });
    });

    // Single error mapper for the whole shield surface.
    router.use((error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
        const { status, body } = mapError(error);
        res.status(status).json(body);
    });

    return router;
}

async function counters(persistence: ShieldPersistence): Promise<{
    casos_por_estado: Record<string, number>;
    ordenes_por_estado: Record<string, number>;
    detecciones_vistas: number | null;
}> {
    const casos = await persistence.cases.list();
    const casosPorEstado: Record<string, number> = {};
    for (const exp of casos) casosPorEstado[exp.estado] = (casosPorEstado[exp.estado] ?? 0) + 1;
    const orders = await persistence.orders.list();
    const ordenesPorEstado: Record<string, number> = {};
    for (const order of orders) ordenesPorEstado[order.estado] = (ordenesPorEstado[order.estado] ?? 0) + 1;
    const seen = persistence.detections.seenIds ? await persistence.detections.seenIds() : null;
    return {
        casos_por_estado: casosPorEstado,
        ordenes_por_estado: ordenesPorEstado,
        detecciones_vistas: seen?.length ?? null,
    };
}

function mapError(error: unknown): { status: number; body: Record<string, unknown> } {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof OutOfShiftError) return { status: 403, body: { error: error.code, detail } };
    if (error instanceof NotAssignedJudgeError) return { status: 403, body: { error: error.code, detail } };
    if (error instanceof CaseNotFoundError) return { status: 404, body: { error: "CASE_NOT_FOUND", detail } };
    if (error instanceof CaseNotPendingError) return { status: 409, body: { error: error.code, detail } };
    if (error instanceof InvalidTransitionError) return { status: 409, body: { error: "INVALID_TRANSITION", detail } };
    if (error instanceof MatchFinishedError) return { status: 422, body: { error: error.code, detail } };
    if (error instanceof ZodError) {
        return { status: 400, body: { error: "BAD_REQUEST", detail, issues: error.issues } };
    }
    if (error instanceof SimulatorUnavailableError) return { status: 503, body: { error: error.code, detail } };
    if (error instanceof SimulatorNetworkError) return { status: 503, body: { error: "SIMULATOR_UNAVAILABLE", detail } };
    if (error instanceof SimulatorHttpError) {
        return { status: 502, body: { error: "SIMULATOR_HTTP_ERROR", detail, status_sim: error.status } };
    }
    if (error instanceof UnknownJudgeError) return { status: 403, body: { error: "UNKNOWN_JUDGE", detail } };
    if (error instanceof SigningConfigError) return { status: 500, body: { error: "SIGNING_CONFIG_ERROR", detail } };
    return { status: 500, body: { error: "INTERNAL_ERROR", detail } };
}
