import type { Detection, PassiveDnsByIp } from "./types.js";

// PASO C: collateral risk from passive DNS. An IP shared with foreign,
// potentially legitimate domains — or one whose risk can't be evaluated at all —
// must never be recommended as a broad IP block target.

/** Minimal slice of QualyDataClient this step needs (structural typing: fakes welcome). */
export interface PassiveDnsSource {
    dnsPasivoPorIp(ip: string): Promise<PassiveDnsByIp | null>;
}

export interface CollateralAssessment {
    host_stream: string;
    ip_servidor: string;
    asn: number | null;
    organizacion: string | null;
    /** Every domain observed on the IP (empty when the lookup failed). */
    dominiosEnIp: string[];
    /** Domains on the IP unrelated to the stream's own infrastructure. */
    dominiosCompartidos: string[];
    /** false on the API's documented 404 or any lookup failure. */
    dnsResuelto: boolean;
    /** true when the IP is shared with foreign domains OR its risk is unknown. */
    riesgoCompartido: boolean;
    reasonCodes: string[];
}

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

/** Last two labels — good enough for the simulator's .test/.example domains. */
export function registrableSuffix(host: string): string {
    const labels = normalizeHost(host).split(".").filter(Boolean);
    return labels.slice(-2).join(".");
}

export function isRelatedDomain(domain: string, families: string[]): boolean {
    const d = normalizeHost(domain);
    return families.some((family) => d === family || d.endsWith(`.${family}`));
}

function pageHost(pagina: string): string | null {
    try {
        return new URL(pagina).hostname;
    } catch {
        return null;
    }
}

export function relatedFamilies(detection: Detection): string[] {
    const families = new Set<string>();
    const streamFamily = registrableSuffix(detection.host_stream ?? "");
    if (streamFamily) families.add(streamFamily);
    const host = detection.pagina ? pageHost(detection.pagina) : null;
    const pageFamily = host ? registrableSuffix(host) : "";
    if (pageFamily) families.add(pageFamily);
    return [...families];
}

export async function assessCollateral(
    detection: Detection,
    dns: PassiveDnsSource,
): Promise<CollateralAssessment> {
    const base = {
        host_stream: detection.host_stream,
        ip_servidor: detection.ip_servidor,
        asn: detection.asn ?? null,
    };

    let record: PassiveDnsByIp | null = null;
    try {
        record = await dns.dnsPasivoPorIp(detection.ip_servidor);
    } catch {
        // Lookup failed entirely: risk is unknown, degrade prudently.
        return {
            ...base,
            organizacion: null,
            dominiosEnIp: [],
            dominiosCompartidos: [],
            dnsResuelto: false,
            riesgoCompartido: true,
            reasonCodes: ["DNS_LOOKUP_FAILED"],
        };
    }

    if (record === null) {
        return {
            ...base,
            organizacion: null,
            dominiosEnIp: [],
            dominiosCompartidos: [],
            dnsResuelto: false,
            riesgoCompartido: true,
            reasonCodes: ["DNS_IP_NO_RECORDS"],
        };
    }

    const families = relatedFamilies(detection);
    const dominiosCompartidos = record.dominios.filter((d) => !isRelatedDomain(d, families));
    const riesgoCompartido = dominiosCompartidos.length > 0;

    return {
        ...base,
        asn: record.asn ?? base.asn,
        organizacion: record.organizacion,
        dominiosEnIp: record.dominios,
        dominiosCompartidos,
        dnsResuelto: true,
        riesgoCompartido,
        reasonCodes: [riesgoCompartido ? "SHARED_IP_LEGIT_DOMAINS" : "IP_APPEARS_DEDICATED"],
    };
}
