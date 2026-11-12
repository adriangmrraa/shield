import type { AuditService } from "./auditService.js";
import { CaseNotFoundError, CaseService } from "./caseService.js";
import type { Expediente } from "./expedienteTypes.js";
import type { JudicialIdentity, ShieldOrder } from "./judicialTypes.js";
import type { OrderRepository } from "./persistence/types.js";
import { OutOfShiftError, ShiftGuard } from "./shiftGuard.js";
import { SigningService } from "./signingService.js";
import type { SimulatorState } from "./types.js";

// Order composition (spec §9-§10): an explicit judicial approval — by the
// authenticated judge ON SHIFT — transitions the case to `aprobado` and emits
// one signed ShieldOrder per `medidas_por_isp` entry with a concrete tipo.
// INVARIANT: nothing here ever signs without a fresh, server-side shift check
// against the simulator clock; a match that already ended cannot be signed for.
// Dispatch to providers is S5 — orders leave this service in pendiente_envio.

/** Injectable simulator clock; QualyDataClient.estado satisfies this. */
export interface SimulatorClock {
    estado(): Promise<SimulatorState>;
}

export class SimulatorUnavailableError extends Error {
    readonly code = "SIMULATOR_UNAVAILABLE" as const;

    constructor(cause: unknown) {
        super(
            `Simulator clock unreachable — shift cannot be verified, signing is fail-closed: ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
        );
        this.name = "SimulatorUnavailableError";
    }
}

export class CaseNotPendingError extends Error {
    readonly code = "CASE_NOT_PENDING" as const;

    constructor(expedienteId: string, estado: string) {
        super(`Expediente ${expedienteId} is '${estado}', not 'pendiente_juez'`);
        this.name = "CaseNotPendingError";
    }
}

export class MatchFinishedError extends Error {
    readonly code = "MATCH_FINISHED" as const;

    constructor(finMin: number, minutoActual: number) {
        super(`Match finished (fin_min=${finMin}, minuto_actual=${minutoActual}) — no order can be signed`);
        this.name = "MatchFinishedError";
    }
}

export class NotAssignedJudgeError extends Error {
    readonly code = "NOT_ASSIGNED_JUDGE" as const;

    constructor(expedienteId: string, juezId: string, asignado: string | null) {
        super(`Expediente ${expedienteId} is assigned to ${asignado ?? "nobody"}, not to ${juezId}`);
        this.name = "NotAssignedJudgeError";
    }
}

export interface OrderServiceDeps {
    clock: SimulatorClock;
    guard: ShiftGuard;
    signing: SigningService;
    cases: CaseService;
    orders: OrderRepository;
    audit: AuditService;
    now?: () => Date;
}

export interface ApproveResult {
    expediente: Expediente;
    ordenes: ShieldOrder[];
}

export class OrderService {
    private readonly clock: SimulatorClock;
    private readonly guard: ShiftGuard;
    private readonly signing: SigningService;
    private readonly cases: CaseService;
    private readonly orders: OrderRepository;
    private readonly audit: AuditService;
    private readonly now: () => Date;

    constructor(deps: OrderServiceDeps) {
        this.clock = deps.clock;
        this.guard = deps.guard;
        this.signing = deps.signing;
        this.cases = deps.cases;
        this.orders = deps.orders;
        this.audit = deps.audit;
        this.now = deps.now ?? (() => new Date());
    }

    /** Fresh clock read — every judicial decision re-validates against it. */
    private async estado(): Promise<SimulatorState> {
        try {
            return await this.clock.estado();
        } catch (error) {
            throw new SimulatorUnavailableError(error);
        }
    }

    /**
     * Explicit approval: re-checks the shift against a fresh clock read, syncs
     * pending assignments, transitions pendiente_juez -> aprobado persisting
     * approved_by/approved_min, then composes + signs one order per ISP measure.
     */
    async approve(expedienteId: string, juez: JudicialIdentity): Promise<ApproveResult> {
        const estado = await this.estado();
        const minuto = estado.minuto_actual;
        await this.guard.syncAssignments(minuto);
        await this.assertShift(juez.juez_id, minuto, expedienteId, "approve");

        const expediente = await this.loadPending(expedienteId);
        await this.assertAssignee(expediente, juez.juez_id, minuto, "approve");

        // vence_min = fin_min of /estado as an integer, strictly after now —
        // a finished match cannot be signed for (spec §9, contract: vence > ahora).
        const venceMin = Math.floor(estado.fin_min);
        if (estado.finalizado || venceMin <= minuto) {
            throw new MatchFinishedError(estado.fin_min, minuto);
        }

        const updated = await this.cases.transition(expedienteId, "aprobado", {
            minSim: minuto,
            motivo: `aprobado por ${juez.juez_id}`,
            correlationId: `decision:${expedienteId}:aprobado`,
            patch: { approved_by: juez.juez_id, approved_min: minuto },
        });
        await this.audit.append({
            evento: "expediente_aprobado",
            minSim: minuto,
            expedienteId,
            correlationId: `decision:${expedienteId}:aprobado`,
            datos: { juez_id: juez.juez_id, juzgado_id: juez.juzgado_id, approved_min: minuto, vence_min: venceMin },
        });

        const ordenes: ShieldOrder[] = [];
        for (const medida of updated.medidas_por_isp) {
            if (medida.tipo === null || medida.objetivo === null) continue; // sin medida segura -> nada que firmar
            const draft = {
                orden_id: `ord-${expedienteId}-${medida.proveedorId}-01`,
                expediente_id: expedienteId,
                tipo: medida.tipo,
                objetivo: medida.objetivo,
                vence_min: venceMin,
                juez_id: juez.juez_id,
            };
            const order: ShieldOrder = {
                ...draft,
                proveedor_id: medida.proveedorId,
                juzgado_id: juez.juzgado_id,
                firma: this.signing.signOrder(draft),
                estado: "pendiente_envio",
                creada_min: minuto,
                creada_en: this.now().toISOString(),
            };
            await this.orders.save(order);
            await this.audit.append({
                evento: "orden_compuesta",
                minSim: minuto,
                expedienteId,
                correlationId: `decision:${expedienteId}:aprobado`,
                datos: {
                    orden_id: order.orden_id,
                    proveedor_id: order.proveedor_id,
                    tipo: order.tipo,
                    objetivo: order.objetivo,
                    vence_min: order.vence_min,
                    juzgado_id: order.juzgado_id,
                    juez_id: order.juez_id,
                    firma: order.firma,
                },
            });
            ordenes.push(order);
        }
        return { expediente: updated, ordenes };
    }

    /**
     * Explicit rejection: same shift + assignee gates, motivo is mandatory and
     * persisted. A rejected case emits ZERO orders and keeps its audit trail.
     */
    async reject(expedienteId: string, juez: JudicialIdentity, motivo: string): Promise<ApproveResult> {
        const estado = await this.estado();
        const minuto = estado.minuto_actual;
        await this.guard.syncAssignments(minuto);
        await this.assertShift(juez.juez_id, minuto, expedienteId, "reject");

        const expediente = await this.loadPending(expedienteId);
        await this.assertAssignee(expediente, juez.juez_id, minuto, "reject");

        const updated = await this.cases.transition(expedienteId, "rechazado", {
            minSim: minuto,
            motivo,
            correlationId: `decision:${expedienteId}:rechazado`,
            patch: { rejected_by: juez.juez_id, rejected_min: minuto, reject_motivo: motivo },
        });
        await this.audit.append({
            evento: "expediente_rechazado",
            minSim: minuto,
            expedienteId,
            correlationId: `decision:${expedienteId}:rechazado`,
            datos: { juez_id: juez.juez_id, juzgado_id: juez.juzgado_id, motivo },
        });
        return { expediente: updated, ordenes: [] };
    }

    private async loadPending(expedienteId: string): Promise<Expediente> {
        const expediente = await this.cases.getById(expedienteId);
        if (!expediente) throw new CaseNotFoundError(expedienteId);
        if (expediente.estado !== "pendiente_juez") {
            throw new CaseNotPendingError(expedienteId, expediente.estado);
        }
        return expediente;
    }

    /** Shift gate with custody: a blocked attempt is audited before the 403 leaves. */
    private async assertShift(
        juezId: string,
        minuto: number,
        expedienteId: string,
        accion: "approve" | "reject",
    ): Promise<void> {
        try {
            this.guard.assertCanSign(juezId, minuto);
        } catch (error) {
            if (error instanceof OutOfShiftError) {
                await this.audit
                    .append({
                        evento: "firma_bloqueada_fuera_de_turno",
                        minSim: minuto,
                        expedienteId,
                        correlationId: `bloqueo:${expedienteId}:${accion}:${minuto}`,
                        datos: {
                            accion,
                            juez_id: juezId,
                            jueces_de_turno: error.deTurno,
                            motivo: "juez_fuera_de_turno",
                        },
                    })
                    .catch(() => {});
            }
            throw error;
        }
    }

    /**
     * Post-sync the assignee IS the judge on shift; a mismatch means the caller
     * is not the judge this case currently belongs to -> audited 403.
     */
    private async assertAssignee(
        expediente: Expediente,
        juezId: string,
        minuto: number,
        accion: "approve" | "reject",
    ): Promise<void> {
        if (expediente.asignado_juez_id === juezId) return;
        await this.audit
            .append({
                evento: "firma_bloqueada_fuera_de_turno",
                minSim: minuto,
                expedienteId: expediente.expediente_id,
                correlationId: `bloqueo:${expediente.expediente_id}:${accion}:${minuto}`,
                datos: {
                    accion,
                    juez_id: juezId,
                    asignado_a: expediente.asignado_juez_id,
                    motivo: "expediente_asignado_a_otro_juez",
                },
            })
            .catch(() => {});
        throw new NotAssignedJudgeError(expediente.expediente_id, juezId, expediente.asignado_juez_id);
    }
}
