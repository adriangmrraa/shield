import { decodeCapture } from "./evidenceService.js";
import type { AuditService } from "./auditService.js";
import { signalKey } from "./phaseKey.js";
import {
    assertTransition,
    type EstadoExpediente,
    type Expediente,
} from "./expedienteTypes.js";
import type { CaseRepository, EvidenceStore } from "./persistence/types.js";
import type { Detection } from "./types.js";
import type { VerificationResult } from "./verificationEngine.js";

// Case business rules (spec §7 paso E, §8). A CANDIDATA_NO_AUTORIZADA opens a
// case for its phase (senal|host|ip); repeats of the same phase consolidate as
// new deteccion_ids on the existing case; a host or IP change opens a NEW case
// linked to the previous one by senal_key. Non-candidate verdicts never create
// cases — they are audited as discards with verdict + reasonCodes.

export const FUENTE_QUALYDATA_SIM = "qualydata-sim";
const ESTADO_LICENCIA_CANDIDATA = "candidata_no_autorizada";

export interface IngestContext {
    partidoId: string;
    /** Match fin_min — stored as vence_min_propuesto. */
    venceMin: number;
    /** Simulated minute at ingest time (poll's minuto_actual). */
    minSim: number;
    correlationId: string;
}

export type IngestOutcome = "created" | "updated" | "discarded";

export interface IngestResult {
    outcome: IngestOutcome;
    expediente: Expediente | null;
}

export class CaseNotFoundError extends Error {
    constructor(expedienteId: string) {
        super(`Expediente not found: ${expedienteId}`);
        this.name = "CaseNotFoundError";
    }
}

export interface TransitionMeta {
    minSim: number | null;
    motivo?: string;
    correlationId?: string;
}

export interface CaseServiceDeps {
    cases: CaseRepository;
    evidence: EvidenceStore;
    audit: AuditService;
    now?: () => Date;
}

export class CaseService {
    private readonly cases: CaseRepository;
    private readonly evidence: EvidenceStore;
    private readonly audit: AuditService;
    private readonly now: () => Date;

    constructor(deps: CaseServiceDeps) {
        this.cases = deps.cases;
        this.evidence = deps.evidence;
        this.audit = deps.audit;
        this.now = deps.now ?? (() => new Date());
    }

    async ingestVerification(
        detection: Detection,
        result: VerificationResult,
        ctx: IngestContext,
    ): Promise<IngestResult> {
        if (result.verdict !== "CANDIDATA_NO_AUTORIZADA") {
            await this.audit.append({
                evento: "detection_descartada",
                minSim: detection.minuto,
                correlationId: ctx.correlationId,
                datos: {
                    deteccion_id: detection.id,
                    fase_key: result.phaseKey,
                    verdict: result.verdict,
                    reason_codes: result.reasonCodes,
                },
            });
            return { outcome: "discarded", expediente: null };
        }

        const existing = await this.cases.findByPhaseKey(result.phaseKey);
        if (existing) {
            const added = !existing.deteccion_ids.includes(detection.id);
            if (added) existing.deteccion_ids.push(detection.id);
            existing.ultima_deteccion_min = Math.max(existing.ultima_deteccion_min, detection.minuto);
            await this.cases.save(existing);
            await this.audit.append({
                evento: "expediente_actualizado",
                minSim: detection.minuto,
                expedienteId: existing.expediente_id,
                correlationId: ctx.correlationId,
                datos: {
                    deteccion_id: detection.id,
                    deteccion_nueva: added,
                    deteccion_ids: existing.deteccion_ids.length,
                },
            });
            return { outcome: "updated", expediente: existing };
        }

        const expediente = await this.buildExpediente(detection, result, ctx);
        await this.cases.save(expediente);
        await this.audit.append({
            evento: "expediente_creado",
            minSim: detection.minuto,
            expedienteId: expediente.expediente_id,
            correlationId: ctx.correlationId,
            datos: {
                senal_key: expediente.senal_key,
                fase_key: expediente.fase_key,
                fase_origen: expediente.fase_origen,
                host_stream: expediente.host_stream,
                ip_servidor: expediente.ip_servidor,
                verdict: result.verdict,
                captura_sha256: expediente.captura_sha256,
                captura_ref: expediente.captura_ref,
            },
        });

        // recibido -> verificado -> pendiente_juez: the custody chain is explicit.
        await this.applyTransition(expediente, "verificado", ctx.minSim, ctx.correlationId);
        await this.applyTransition(expediente, "pendiente_juez", ctx.minSim, ctx.correlationId);
        return { outcome: "created", expediente };
    }

    async transition(expedienteId: string, hacia: EstadoExpediente, meta: TransitionMeta): Promise<Expediente> {
        const expediente = await this.cases.getById(expedienteId);
        if (!expediente) throw new CaseNotFoundError(expedienteId);
        await this.applyTransition(
            expediente,
            hacia,
            meta.minSim,
            meta.correlationId ?? `${expedienteId}->${hacia}`,
            meta.motivo,
        );
        return expediente;
    }

    getById(expedienteId: string): Promise<Expediente | null> {
        return this.cases.getById(expedienteId);
    }

    listByEstado(estado?: EstadoExpediente): Promise<Expediente[]> {
        return estado === undefined ? this.cases.list() : this.cases.listByEstado(estado);
    }

    private async applyTransition(
        expediente: Expediente,
        hacia: EstadoExpediente,
        minSim: number | null,
        correlationId: string,
        motivo?: string,
    ): Promise<void> {
        const desde = expediente.estado;
        assertTransition(desde, hacia);
        expediente.estado = hacia;
        expediente.ultima_transicion = {
            desde,
            hacia,
            min_sim: minSim,
            ts_iso: this.now().toISOString(),
            ...(motivo ? { motivo } : {}),
        };
        await this.cases.save(expediente);
        await this.audit.append({
            evento: "transicion_estado",
            minSim,
            expedienteId: expediente.expediente_id,
            correlationId,
            datos: { desde, hacia, ...(motivo ? { motivo } : {}) },
        });
        if (hacia === "descartado") {
            await this.audit.append({
                evento: "expediente_descartado",
                minSim,
                expedienteId: expediente.expediente_id,
                correlationId,
                datos: { desde, motivo: motivo ?? null },
            });
        }
    }

    private async buildExpediente(
        detection: Detection,
        result: VerificationResult,
        ctx: IngestContext,
    ): Promise<Expediente> {
        const sequence = await this.cases.nextSequence(ctx.partidoId);
        const prevPhase = await this.cases.findLatestBySignalKey(signalKey(detection));

        let capturaRef: string | null = null;
        if (result.evidence.capturaSha256) {
            capturaRef = await this.evidence.put(
                result.evidence.capturaSha256,
                decodeCapture(detection.captura.contenido_b64),
            );
        }

        const assessment = result.assessment;
        return {
            expediente_id: `EXP-${ctx.partidoId}-${String(sequence).padStart(4, "0")}`,
            partido_id: ctx.partidoId,
            senal_key: signalKey(detection),
            fase_key: result.phaseKey,
            fase_origen: prevPhase && prevPhase.fase_key !== result.phaseKey ? prevPhase.fase_key : null,
            deteccion_ids: [detection.id],
            detectado_min: detection.minuto,
            ultima_deteccion_min: detection.minuto,
            pagina: detection.pagina,
            stream_url: detection.stream_url,
            host_stream: detection.host_stream,
            ip_servidor: detection.ip_servidor,
            asn: assessment.asn,
            marca_de_agua_extraida: detection.marca_de_agua_extraida,
            validacion_marca: {
                marca_valida: result.watermark.matchedPrefix !== null,
                prefijo_coincidente: result.watermark.matchedPrefix,
                licenciatario: result.watermark.licenciatario,
            },
            estado_licencia: ESTADO_LICENCIA_CANDIDATA,
            captura_sha256: result.evidence.capturaSha256,
            captura_capturada_min: result.evidence.capturadaMin,
            captura_formato: result.evidence.capturaFormato,
            captura_duracion_seg: result.evidence.duracionSeg,
            captura_ref: capturaRef,
            dns_pasivo: {
                resuelto: assessment.dnsResuelto,
                organizacion: assessment.organizacion,
                dominios: assessment.dominiosEnIp,
            },
            dominios_compartidos: assessment.dominiosCompartidos,
            riesgo: {
                ip_compartida: assessment.riesgoCompartido,
                dns_resuelto: assessment.dnsResuelto,
                asn: assessment.asn,
                organizacion: assessment.organizacion,
            },
            medidas_por_isp: result.medidasPorIsp.map((m) => ({
                proveedorId: m.proveedorId,
                tipo: m.tipo,
                objetivo: m.objetivo,
                motivo: m.motivo,
            })),
            vence_min_propuesto: ctx.venceMin,
            estado: "recibido",
            fuente: FUENTE_QUALYDATA_SIM,
            reason_codes: [...result.reasonCodes],
            creado_en: this.now().toISOString(),
            creado_min: ctx.minSim,
            ultima_transicion: null,
        };
    }
}
