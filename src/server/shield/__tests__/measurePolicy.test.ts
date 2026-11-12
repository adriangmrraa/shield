import { describe, expect, it } from "vitest";
import { recomendarMedidas, UNSAFE_MEASURE_MOTIVO } from "../measurePolicy.js";
import type { CollateralAssessment } from "../collateralRisk.js";
import { providers } from "./fixtures.js";

const assessment = (overrides: Partial<CollateralAssessment> = {}): CollateralAssessment => ({
    host_stream: "live.golazo-libre.test",
    ip_servidor: "198.51.100.20",
    asn: 64610,
    organizacion: "NubeRápida CDN (ficticia)",
    dominiosEnIp: [],
    dominiosCompartidos: [],
    dnsResuelto: true,
    riesgoCompartido: false,
    reasonCodes: [],
    ...overrides,
});

const byIsp = (recs: ReturnType<typeof recomendarMedidas>) =>
    Object.fromEntries(recs.map((r) => [r.proveedorId, r]));

describe("recomendarMedidas (PASO D)", () => {
    it("TEST 04: a shared IP recommends dominio on every ISP that supports it — never ip", () => {
        const recs = byIsp(recomendarMedidas(assessment({ riesgoCompartido: true }), providers));
        expect(recs.aurora).toMatchObject({ tipo: "dominio", objetivo: "live.golazo-libre.test" });
        expect(recs.valle).toMatchObject({ tipo: "dominio", objetivo: "live.golazo-libre.test" });
        expect(recs.soloip).toMatchObject({ tipo: null, objetivo: null, motivo: UNSAFE_MEASURE_MOTIVO });
        expect(Object.values(recs).every((r) => r.tipo !== "ip")).toBe(true);
    });

    it("a dedicated IP recommends ip where the ISP supports it", () => {
        const recs = byIsp(recomendarMedidas(assessment(), providers));
        expect(recs.aurora).toMatchObject({ tipo: "ip", objetivo: "198.51.100.20" });
        expect(recs.soloip).toMatchObject({ tipo: "ip", objetivo: "198.51.100.20" });
    });

    it("TEST 05: a dominio-only ISP gets dominio even when the IP is dedicated", () => {
        const recs = byIsp(recomendarMedidas(assessment(), providers));
        expect(recs.valle).toMatchObject({ tipo: "dominio", objetivo: "live.golazo-libre.test" });
    });

    it("an ISP with no supported capability gets no measure", () => {
        const none = [{ ...providers[0], id: "vacio", capacidades: [] }];
        const recs = recomendarMedidas(assessment(), none);
        expect(recs[0]).toMatchObject({ tipo: null, objetivo: null });
    });
});
