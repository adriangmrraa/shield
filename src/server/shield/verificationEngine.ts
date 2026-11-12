import { assessCollateral } from "./collateralRisk.js";
import { validateEvidence } from "./evidenceService.js";
import { checkLicense } from "./licenseCheck.js";
import { recomendarMedidas, type MeasureRecommendation } from "./measurePolicy.js";
import { phaseKey } from "./phaseKey.js";
import type { Detection, MatchInfo, PassiveDnsByIp, Provider } from "./types.js";

// Verification engine: orchestrates PASO A→B→C→D. Pure domain logic behind
// injected interfaces — the real QualyDataClient satisfies VerificationSources
// structurally; tests inject fakes. No verdict produces orders or side effects.

export type Verdict = "CANDIDATA_NO_AUTORIZADA" | "AUTORIZADA" | "OTRA_SEÑAL" | "EVIDENCIA_INSUFICIENTE";

export interface VerificationSources {
    partido(): Promise<MatchInfo>;
    dnsPasivoPorIp(ip: string): Promise<PassiveDnsByIp | null>;
    proveedores(): Promise<Provider[]>;
}

export interface VerificationAssessment {
    host_stream: string;
    ip_servidor: string;
    asn: number | null;
    organizacion: string | null;
    dominiosEnIp: string[];
    dominiosCompartidos: string[];
    dnsResuelto: boolean;
    /** null when PASO C didn't run (non-candidate verdicts), false = dedicated IP. */
    riesgoCompartido: boolean | null;
}

export interface VerificationResult {
    detectionId: string;
    minuto: number;
    verdict: Verdict;
    reasonCodes: string[];
    phaseKey: string;
    evidence: {
        capturaSha256: string | null;
        capturaFormato: string | null;
        capturadaMin: number | null;
        duracionSeg: number | null;
        bytesDecodificados: number;
    };
    watermark: {
        marca: string | null;
        matchedPrefix: string | null;
        licenciatario: string | null;
    };
    assessment: VerificationAssessment;
    /** Per-ISP recommendation; empty unless the detection is a candidate. */
    medidasPorIsp: MeasureRecommendation[];
}

export class VerificationEngine {
    private readonly sources: VerificationSources;
    private matchCache: Promise<MatchInfo> | null = null;
    private providersCache: Promise<Provider[]> | null = null;

    constructor(deps: { sources: VerificationSources }) {
        this.sources = deps.sources;
    }

    /** Drop cached /partido and /proveedores payloads (e.g. on match change). */
    refresh(): void {
        this.matchCache = null;
        this.providersCache = null;
    }

    private matchInfo(): Promise<MatchInfo> {
        this.matchCache ??= this.sources.partido();
        return this.matchCache;
    }

    private providers(): Promise<Provider[]> {
        this.providersCache ??= this.sources.proveedores();
        return this.providersCache;
    }

    async classify(detection: Detection): Promise<VerificationResult> {
        const reasonCodes: string[] = [];
        const base = {
            detectionId: detection.id,
            minuto: detection.minuto,
            phaseKey: phaseKey(detection),
        };
        const assessment: VerificationAssessment = {
            host_stream: detection.host_stream,
            ip_servidor: detection.ip_servidor,
            asn: Number.isInteger(detection.asn) ? detection.asn : null,
            organizacion: null,
            dominiosEnIp: [],
            dominiosCompartidos: [],
            dnsResuelto: false,
            riesgoCompartido: null,
        };
        const evidence = validateEvidence(detection);
        reasonCodes.push(...evidence.reasonCodes);
        const result = (
            verdict: Verdict,
            extras: Partial<Pick<VerificationResult, "watermark" | "assessment" | "medidasPorIsp">> = {},
        ): VerificationResult => ({
            ...base,
            verdict,
            reasonCodes,
            evidence: {
                capturaSha256: evidence.capturaSha256,
                capturaFormato: detection.captura?.formato ?? null,
                capturadaMin: detection.captura?.capturada_min ?? null,
                duracionSeg: detection.captura?.duracion_seg ?? null,
                bytesDecodificados: evidence.bytesDecodificados,
            },
            watermark: {
                marca: detection.marca_de_agua_extraida ?? null,
                matchedPrefix: null,
                licenciatario: null,
            },
            assessment,
            medidasPorIsp: [],
            ...extras,
        });

        if (!evidence.ok) {
            return result("EVIDENCIA_INSUFICIENTE");
        }

        const license = checkLicense(detection, await this.matchInfo());
        reasonCodes.push(...license.reasonCodes);
        const watermark = {
            marca: detection.marca_de_agua_extraida,
            matchedPrefix: license.matchedPrefix,
            licenciatario: license.licensee?.nombre ?? null,
        };

        if (license.kind === "foreign") {
            return result("OTRA_SEÑAL", { watermark });
        }
        if (license.kind === "authorized") {
            return result("AUTORIZADA", { watermark });
        }

        const collateral = await assessCollateral(detection, this.sources);
        reasonCodes.push(...collateral.reasonCodes);
        assessment.asn = collateral.asn;
        assessment.organizacion = collateral.organizacion;
        assessment.dominiosEnIp = collateral.dominiosEnIp;
        assessment.dominiosCompartidos = collateral.dominiosCompartidos;
        assessment.dnsResuelto = collateral.dnsResuelto;
        assessment.riesgoCompartido = collateral.riesgoCompartido;

        return result("CANDIDATA_NO_AUTORIZADA", {
            watermark,
            assessment,
            medidasPorIsp: recomendarMedidas(collateral, await this.providers()),
        });
    }
}
