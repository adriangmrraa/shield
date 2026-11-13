import { describe, expect, it } from "vitest";
import { captureSha256, decodeCapture, sha256Hex, validateEvidence } from "../evidenceService.js";
import { detection } from "./fixtures.js";

describe("validateEvidence (PASO A)", () => {
    it("accepts a well-formed detection and hashes the decoded capture bytes", () => {
        const result = validateEvidence(detection());
        expect(result.ok).toBe(true);
        expect(result.capturaSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.bytesDecodificados).toBe(7);
        expect(result.reasonCodes).toContain("CAPTURE_HASH_OK");
    });

    it("rejects an invalid base64 capture", () => {
        const d = detection({ captura: { capturada_min: 2, formato: "mpegts", duracion_seg: 6, contenido_b64: "!!!no-b64!!!" } });
        const result = validateEvidence(d);
        expect(result.ok).toBe(false);
        expect(result.capturaSha256).toBeNull();
        expect(result.reasonCodes).toContain("INVALID_CAPTURE_B64");
    });

    it("rejects missing shape fields without ever becoming a candidate", () => {
        const d = detection({ id: "", host_stream: "", ip_servidor: "", marca_de_agua_extraida: "" });
        const result = validateEvidence(d);
        expect(result.ok).toBe(false);
        expect(result.reasonCodes).toEqual(
            expect.arrayContaining(["MISSING_ID", "MISSING_HOST_STREAM", "MISSING_IP_SERVIDOR", "MISSING_WATERMARK"]),
        );
    });
});

describe("capture integrity (TEST 11)", () => {
    it("mutating a single decoded byte changes the sha256 proof", () => {
        const b64 = detection().captura.contenido_b64;
        const original = captureSha256(b64);

        const bytes = decodeCapture(b64);
        bytes[0] = bytes[0] ^ 0xff;
        const mutated = sha256Hex(bytes);

        expect(captureSha256(b64)).toBe(original);
        expect(mutated).not.toBe(original);
    });
});
