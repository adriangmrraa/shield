import { describe, expect, it } from "vitest";
import { checkLicense } from "../licenseCheck.js";
import { detection, matchInfo } from "./fixtures.js";

describe("checkLicense (PASO B)", () => {
    it("TEST 01: a watermark from another match is foreign", () => {
        const outcome = checkLicense(detection({ marca_de_agua_extraida: "LP25-F03-OFI-S102934" }), matchInfo);
        expect(outcome.kind).toBe("foreign");
        expect(outcome.matchedPrefix).toBeNull();
        expect(outcome.reasonCodes).toContain("FOREIGN_WATERMARK");
    });

    it("TEST 02: licensee prefix + authorized domain is authorized", () => {
        const outcome = checkLicense(
            detection({
                host_stream: "envivo.canalnorte.test",
                marca_de_agua_extraida: "LP26-PRA-LIC-NORTE",
            }),
            matchInfo,
        );
        expect(outcome.kind).toBe("authorized");
        expect(outcome.licensee?.nombre).toContain("Canal Norte");
        expect(outcome.reasonCodes).toEqual(
            expect.arrayContaining(["WATERMARK_PREFIX_MATCH", "LICENSEE_AUTHORIZED_DOMAIN"]),
        );
    });

    it("TEST 03: valid match watermark on an unauthorized host stays a candidate", () => {
        const outcome = checkLicense(detection(), matchInfo);
        expect(outcome.kind).toBe("unauthorized_host");
        expect(outcome.matchedPrefix).toBe("LP26-PRA-OFI");
        expect(outcome.reasonCodes).toContain("VALID_MARK_UNAUTHORIZED_HOST");
    });

    it("licensee watermark on a host outside its authorized domains is still a candidate", () => {
        const outcome = checkLicense(
            detection({ host_stream: "s1.pelotaya.test", marca_de_agua_extraida: "LP26-PRA-LIC-NORTE" }),
            matchInfo,
        );
        expect(outcome.kind).toBe("unauthorized_host");
        expect(outcome.licensee?.prefijo_marca).toBe("LP26-PRA-LIC-NORTE");
        expect(outcome.reasonCodes).toContain("LICENSEE_PREFIX_UNAUTHORIZED_HOST");
    });

    it("reads prefixes at runtime instead of hardcoding them", () => {
        const otherMatch = {
            ...matchInfo,
            marcas_de_agua_validas: [{ prefijo: "XX99-FINAL", origen: "otra señal" }],
            licenciatarios: [],
        };
        const outcome = checkLicense(detection({ marca_de_agua_extraida: "XX99-FINAL-S1" }), otherMatch);
        expect(outcome.kind).toBe("unauthorized_host");
        expect(outcome.matchedPrefix).toBe("XX99-FINAL");
    });
});
