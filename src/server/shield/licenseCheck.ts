import type { Detection, Licensee, MatchInfo } from "./types.js";

// PASO B: watermark/license classification against the runtime /partido payload.
// Prefixes and authorized domains are never hardcoded — always read from MatchInfo.

export type LicenseOutcomeKind = "foreign" | "authorized" | "unauthorized_host";

export interface LicenseOutcome {
    kind: LicenseOutcomeKind;
    reasonCodes: string[];
    /** Longest valid match prefix the watermark carries; null for a foreign mark. */
    matchedPrefix: string | null;
    /** Licensee whose prefix matched, when any (regardless of the host check). */
    licensee: Licensee | null;
}

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

export function checkLicense(detection: Detection, match: MatchInfo): LicenseOutcome {
    const marca = (detection.marca_de_agua_extraida ?? "").trim();
    const host = normalizeHost(detection.host_stream ?? "");

    const matchedPrefix = match.marcas_de_agua_validas
        .map((w) => w.prefijo)
        .filter((prefijo) => prefijo.length > 0 && marca.startsWith(prefijo))
        .sort((a, b) => b.length - a.length)[0];

    if (!matchedPrefix) {
        return { kind: "foreign", reasonCodes: ["FOREIGN_WATERMARK"], matchedPrefix: null, licensee: null };
    }

    const licensee =
        match.licenciatarios.find((l) => l.prefijo_marca.length > 0 && marca.startsWith(l.prefijo_marca)) ?? null;

    if (licensee && licensee.dominios_autorizados.some((d) => normalizeHost(d) === host)) {
        return {
            kind: "authorized",
            reasonCodes: ["WATERMARK_PREFIX_MATCH", "LICENSEE_AUTHORIZED_DOMAIN"],
            matchedPrefix,
            licensee,
        };
    }

    const reasonCodes = ["WATERMARK_PREFIX_MATCH", "VALID_MARK_UNAUTHORIZED_HOST"];
    if (licensee) reasonCodes.push("LICENSEE_PREFIX_UNAUTHORIZED_HOST");
    return { kind: "unauthorized_host", reasonCodes, matchedPrefix, licensee };
}
