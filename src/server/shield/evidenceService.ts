import { createHash } from "node:crypto";
import type { Detection } from "./types.js";

// PASO A: shape validation + integrity hash. The hash is computed over the exact
// decoded capture bytes — never over a reserialized JSON payload.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface EvidenceValidation {
    ok: boolean;
    /** Success + failure codes in evaluation order (CAPTURE_HASH_OK on a clean capture). */
    reasonCodes: string[];
    /** sha256 hex of the decoded capture bytes; null when the capture can't be decoded. */
    capturaSha256: string | null;
    bytesDecodificados: number;
}

export function decodeCapture(contenido_b64: string): Buffer {
    return Buffer.from(contenido_b64, "base64");
}

export function sha256Hex(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

/** Integrity proof for a capture: sha256 hex of the exact bytes it decodes to. */
export function captureSha256(contenido_b64: string): string {
    return sha256Hex(decodeCapture(contenido_b64));
}

export function isValidBase64(value: string): boolean {
    return value.length > 0 && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

export function validateEvidence(detection: Detection): EvidenceValidation {
    const failures: string[] = [];
    const reasonCodes: string[] = [];
    let capturaSha256Hex: string | null = null;
    let bytesDecodificados = 0;
    const fail = (code: string) => {
        failures.push(code);
        reasonCodes.push(code);
    };

    if (!detection.id || detection.id.trim().length === 0) fail("MISSING_ID");
    if (!detection.host_stream || detection.host_stream.trim().length === 0) fail("MISSING_HOST_STREAM");
    if (!detection.ip_servidor || detection.ip_servidor.trim().length === 0) fail("MISSING_IP_SERVIDOR");
    if (!Number.isInteger(detection.asn)) fail("MISSING_ASN");
    if (typeof detection.marca_de_agua_extraida !== "string" || detection.marca_de_agua_extraida.trim().length === 0) {
        fail("MISSING_WATERMARK");
    }

    const captura = detection.captura;
    if (!captura || typeof captura.contenido_b64 !== "string" || captura.contenido_b64.length === 0) {
        fail("MISSING_CAPTURE");
    } else if (!isValidBase64(captura.contenido_b64)) {
        fail("INVALID_CAPTURE_B64");
    } else {
        const bytes = decodeCapture(captura.contenido_b64);
        if (bytes.length === 0) {
            fail("EMPTY_CAPTURE_BYTES");
        } else {
            bytesDecodificados = bytes.length;
            capturaSha256Hex = sha256Hex(bytes);
            reasonCodes.push("CAPTURE_HASH_OK");
        }
    }

    return { ok: failures.length === 0, reasonCodes, capturaSha256: capturaSha256Hex, bytesDecodificados };
}
