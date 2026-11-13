import type { AuditService } from "./auditService.js";
import type { Expediente } from "./expedienteTypes.js";
import type { CaseRepository } from "./persistence/types.js";
import type { Shift } from "./types.js";

// Shift control (spec §9, TEST 08/09). One pure function decides who is on
// shift from the SIMULATED minute + the shifts table; it is evaluated twice per
// decision: once when the tray is served (can_sign) and again inside the
// approve/reject path against a fresh simulator clock read. Pending cases are
// always assigned to the judge on shift; a shift change reassigns them and the
// outgoing judge can no longer sign — both facts are audited.

/** All judges whose [desde_min, hasta_min) window contains minutoSim. */
export function juecesDeTurno(minutoSim: number, turnos: Shift[]): string[] {
    return turnos
        .filter((turno) => turno.desde_min <= minutoSim && minutoSim < turno.hasta_min)
        .map((turno) => turno.juez_id);
}

/** The judge a pendiente_juez case is assigned to: the first judge on shift. */
export function juezDeTurno(minutoSim: number, turnos: Shift[]): string | null {
    return juecesDeTurno(minutoSim, turnos)[0] ?? null;
}

export class OutOfShiftError extends Error {
    readonly code = "OUT_OF_SHIFT" as const;
    readonly juezId: string;
    readonly minutoSim: number;
    readonly deTurno: string[];

    constructor(juezId: string, minutoSim: number, deTurno: string[]) {
        super(`Judge ${juezId} is not on shift at minute ${minutoSim} (on shift: ${deTurno.join(", ") || "none"})`);
        this.name = "OutOfShiftError";
        this.juezId = juezId;
        this.minutoSim = minutoSim;
        this.deTurno = deTurno;
    }
}

export interface ShiftGuardDeps {
    cases: CaseRepository;
    audit: AuditService;
    /** Shift table provider — the signing bundle's turnos (config) by default. */
    turnos: () => Shift[];
}

export class ShiftGuard {
    private readonly cases: CaseRepository;
    private readonly audit: AuditService;
    private readonly turnos: () => Shift[];

    constructor(deps: ShiftGuardDeps) {
        this.cases = deps.cases;
        this.audit = deps.audit;
        this.turnos = deps.turnos;
    }

    deTurno(minutoSim: number): string[] {
        return juecesDeTurno(minutoSim, this.turnos());
    }

    /** Can `juezId` sign `expediente` right now? Used to render can_sign in the tray. */
    canSign(expediente: Expediente, juezId: string, minutoSim: number): boolean {
        if (expediente.estado !== "pendiente_juez") return false;
        if (expediente.asignado_juez_id !== juezId) return false;
        return this.deTurno(minutoSim).includes(juezId);
    }

    /** Hard gate before any signature: throws OutOfShiftError. */
    assertCanSign(juezId: string, minutoSim: number): void {
        const deTurno = this.deTurno(minutoSim);
        if (!deTurno.includes(juezId)) throw new OutOfShiftError(juezId, minutoSim, deTurno);
    }

    /**
     * Points every pendiente_juez case at the judge on shift NOW. A case whose
     * assignee changed is re-saved and audited as `expediente_reasignado` —
     * motivo `cambio_turno` when a previous judge loses it, `asignacion_inicial`
     * the first time a case meets the tray. Decided cases are never reassigned.
     */
    async syncAssignments(minutoSim: number): Promise<Expediente[]> {
        const entrante = juezDeTurno(minutoSim, this.turnos());
        if (entrante === null) return []; // nobody on shift: keep assignees; signing stays blocked

        const pendientes = await this.cases.listByEstado("pendiente_juez");
        const reassigned: Expediente[] = [];
        for (const expediente of pendientes) {
            if (expediente.asignado_juez_id === entrante) continue;
            const saliente = expediente.asignado_juez_id;
            expediente.asignado_juez_id = entrante;
            await this.cases.save(expediente);
            await this.audit.append({
                evento: "expediente_reasignado",
                minSim: minutoSim,
                expedienteId: expediente.expediente_id,
                correlationId: `reasignacion:${expediente.expediente_id}:${minutoSim}`,
                datos: {
                    desde_juez: saliente,
                    hacia_juez: entrante,
                    motivo: saliente === null ? "asignacion_inicial" : "cambio_turno",
                },
            });
            reassigned.push(expediente);
        }
        return reassigned;
    }
}
