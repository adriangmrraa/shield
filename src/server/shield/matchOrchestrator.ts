import { AuditService } from "./auditService.js";
import { CaseService, type IngestOutcome } from "./caseService.js";
import { DetectionPoller, type DetectionSource, type PollResult } from "./detectionPoller.js";
import type { EstadoExpediente } from "./expedienteTypes.js";
import { phaseKey, signalKey } from "./phaseKey.js";
import type { ShieldPersistence } from "./persistence/types.js";
import type { Detection, MatchInfo } from "./types.js";
import { VerificationEngine, type Verdict, type VerificationSources } from "./verificationEngine.js";

// Match wiring (S3): poller -> engine -> caseService over persistent stores.
// Each detection is its own processing chain — a failure audits detection_error
// and never stalls the batch; a redelivery re-ingests idempotently (deteccion_ids
// dedup) instead of duplicating a case.

export type OrchestratorClient = DetectionSource & VerificationSources;

export interface MatchOrchestratorDeps {
    client: OrchestratorClient;
    persistence: ShieldPersistence;
    audit: AuditService;
    intervalMs?: number;
    onError?: (error: unknown) => void;
    now?: () => Date;
}

export interface OrchestratorStatus {
    minuto: number;
    running: boolean;
    casosPorEstado: Partial<Record<EstadoExpediente, number>>;
    contadores: {
        recibidas: number;
        verificadas: number;
        expedientesCreados: number;
        expedientesActualizados: number;
        descartadas: number;
        errores: number;
    };
    descartesPorVerdict: Partial<Record<Verdict, number>>;
}

export class MatchOrchestrator {
    private readonly client: OrchestratorClient;
    private readonly audit: AuditService;
    private readonly engine: VerificationEngine;
    private readonly caseService: CaseService;
    private readonly poller: DetectionPoller;
    private readonly onError: (error: unknown) => void;
    private matchPromise: Promise<MatchInfo> | null = null;
    private readonly contadores = {
        recibidas: 0,
        verificadas: 0,
        expedientesCreados: 0,
        expedientesActualizados: 0,
        descartadas: 0,
        errores: 0,
    };
    private readonly descartesPorVerdict = new Map<Verdict, number>();

    constructor(deps: MatchOrchestratorDeps) {
        this.client = deps.client;
        this.audit = deps.audit;
        this.onError = deps.onError ?? ((error) => console.error("[matchOrchestrator] detection failed:", error));
        this.engine = new VerificationEngine({ sources: deps.client });
        this.caseService = new CaseService({
            cases: deps.persistence.cases,
            evidence: deps.persistence.evidence,
            audit: deps.audit,
            now: deps.now,
        });
        this.poller = new DetectionPoller({
            client: deps.client,
            store: deps.persistence.detections,
            intervalMs: deps.intervalMs ?? 1_000,
            onDetections: (detections) => this.onDetections(detections),
            onError: this.onError,
        });
    }

    get caseSvc(): CaseService {
        return this.caseService;
    }

    get pollerRunning(): boolean {
        return this.poller.isRunning;
    }

    private match(): Promise<MatchInfo> {
        this.matchPromise ??= this.client.partido();
        return this.matchPromise;
    }

    /** Sequential per detection so the audit trail reads in feed order. */
    async onDetections(detections: Detection[]): Promise<void> {
        const match = await this.match();
        for (const detection of detections) {
            const correlationId = detection.id;
            try {
                this.contadores.recibidas += 1;
                await this.audit.append({
                    evento: "detection_recibida",
                    minSim: detection.minuto,
                    correlationId,
                    datos: {
                        deteccion_id: detection.id,
                        senal_key: signalKey(detection),
                        fase_key: phaseKey(detection),
                        host_stream: detection.host_stream,
                        ip_servidor: detection.ip_servidor,
                    },
                });

                const result = await this.engine.classify(detection);
                this.contadores.verificadas += 1;
                await this.audit.append({
                    evento: "detection_verificada",
                    minSim: detection.minuto,
                    correlationId,
                    datos: {
                        deteccion_id: detection.id,
                        fase_key: result.phaseKey,
                        verdict: result.verdict,
                        reason_codes: result.reasonCodes,
                        captura_sha256: result.evidence.capturaSha256,
                    },
                });

                const ingest = await this.caseService.ingestVerification(detection, result, {
                    partidoId: match.id,
                    venceMin: match.fin_min,
                    minSim: detection.minuto,
                    correlationId,
                });
                this.trackOutcome(ingest.outcome, result.verdict);
            } catch (error) {
                // One bad detection never stalls the batch — it is audited instead.
                this.contadores.errores += 1;
                await this.audit
                    .append({
                        evento: "detection_error",
                        minSim: detection.minuto,
                        correlationId,
                        datos: {
                            deteccion_id: detection.id,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    })
                    .catch(() => {});
                this.onError(error);
            }
        }
    }

    private trackOutcome(outcome: IngestOutcome, verdict: Verdict): void {
        if (outcome === "created") this.contadores.expedientesCreados += 1;
        else if (outcome === "updated") this.contadores.expedientesActualizados += 1;
        else {
            this.contadores.descartadas += 1;
            this.descartesPorVerdict.set(verdict, (this.descartesPorVerdict.get(verdict) ?? 0) + 1);
        }
    }

    start(): void {
        this.poller.start();
    }

    stop(): void {
        this.poller.stop();
    }

    /** One manual poll cycle — the script path; also used by tests. */
    async pollOnce(): Promise<PollResult> {
        return this.poller.pollOnce();
    }

    async status(): Promise<OrchestratorStatus> {
        const casos = await this.caseService.listByEstado();
        const casosPorEstado: Partial<Record<EstadoExpediente, number>> = {};
        for (const expediente of casos) {
            casosPorEstado[expediente.estado] = (casosPorEstado[expediente.estado] ?? 0) + 1;
        }
        return {
            // The persisted poller cursor IS the last minuto_actual served.
            minuto: await this.poller.cursor(),
            running: this.poller.isRunning,
            casosPorEstado,
            contadores: { ...this.contadores },
            descartesPorVerdict: Object.fromEntries(this.descartesPorVerdict),
        };
    }
}
