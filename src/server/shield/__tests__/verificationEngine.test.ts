import { describe, expect, it } from "vitest";
import { VerificationEngine } from "../verificationEngine.js";
import { UNSAFE_MEASURE_MOTIVO } from "../measurePolicy.js";
import { dedicatedDns, detection, FakeSources, providers, sharedDns } from "./fixtures.js";

const engine = (dns: ConstructorParameters<typeof FakeSources>[0]) =>
    new VerificationEngine({ sources: new FakeSources(dns) });

const canalNorte = detection({
    id: "D-0002",
    pagina: "https://canalnorte.test/en-vivo",
    stream_url: "https://envivo.canalnorte.test/hls/en-vivo/index.m3u8",
    host_stream: "envivo.canalnorte.test",
    ip_servidor: "192.0.2.10",
    asn: 64640,
    marca_de_agua_extraida: "LP26-PRA-LIC-NORTE",
});

const golazoLibre = detection({
    id: "D-0003",
    pagina: "https://golazo-libre.test/partido",
    stream_url: "https://live.golazo-libre.test/hls/en-vivo/index.m3u8",
    host_stream: "live.golazo-libre.test",
    ip_servidor: "198.51.100.20",
    asn: 64610,
    marca_de_agua_extraida: "LP26-PRA-OFI-S077310",
});

describe("VerificationEngine", () => {
    it("TEST 01: foreign watermark -> OTRA_SEÑAL, zero measures", async () => {
        const sources = new FakeSources({});
        const e = new VerificationEngine({ sources });
        const result = await e.classify(detection({ id: "D-0008", marca_de_agua_extraida: "LP25-F03-OFI-S102934" }));

        expect(result.verdict).toBe("OTRA_SEÑAL");
        expect(result.medidasPorIsp).toEqual([]);
        expect(result.reasonCodes).toContain("FOREIGN_WATERMARK");
        expect(result.evidence.capturaSha256).toMatch(/^[0-9a-f]{64}$/);
        // PASO C/D don't run for non-candidates: no DNS calls, risk stays unevaluated.
        expect(sources.dnsRequests).toEqual([]);
        expect(result.assessment.riesgoCompartido).toBeNull();
    });

    it("TEST 02: licensee on an authorized domain -> AUTORIZADA, zero measures", async () => {
        const sources = new FakeSources({});
        const e = new VerificationEngine({ sources });
        const result = await e.classify(canalNorte);

        expect(result.verdict).toBe("AUTORIZADA");
        expect(result.medidasPorIsp).toEqual([]);
        expect(result.watermark.licenciatario).toContain("Canal Norte");
        expect(sources.dnsRequests).toEqual([]);
    });

    it("TEST 03: valid watermark on unauthorized host -> CANDIDATA_NO_AUTORIZADA", async () => {
        const result = await engine({ "203.0.113.10": dedicatedDns }).classify(detection());

        expect(result.verdict).toBe("CANDIDATA_NO_AUTORIZADA");
        expect(result.reasonCodes).toEqual(
            expect.arrayContaining(["CAPTURE_HASH_OK", "WATERMARK_PREFIX_MATCH", "VALID_MARK_UNAUTHORIZED_HOST"]),
        );
        expect(result.medidasPorIsp.length).toBe(providers.length);
    });

    it("TEST 04: shared IP with legit domains -> dominio on every capable ISP, never ip", async () => {
        const result = await engine({ "198.51.100.20": sharedDns }).classify(golazoLibre);

        expect(result.verdict).toBe("CANDIDATA_NO_AUTORIZADA");
        expect(result.assessment.riesgoCompartido).toBe(true);
        expect(result.assessment.dominiosCompartidos).toHaveLength(11);
        for (const rec of result.medidasPorIsp) {
            expect(rec.tipo).not.toBe("ip");
        }
        expect(result.medidasPorIsp.find((r) => r.proveedorId === "aurora")).toMatchObject({
            tipo: "dominio",
            objetivo: "live.golazo-libre.test",
        });
        // An ip-only ISP on shared infra gets no measure instead of collateral damage.
        expect(result.medidasPorIsp.find((r) => r.proveedorId === "soloip")).toMatchObject({
            tipo: null,
            motivo: UNSAFE_MEASURE_MOTIVO,
        });
    });

    it("TEST 05: dominio-only ISP gets dominio even on a dedicated IP", async () => {
        const result = await engine({ "203.0.113.10": dedicatedDns }).classify(detection());

        expect(result.assessment.riesgoCompartido).toBe(false);
        const byIsp = Object.fromEntries(result.medidasPorIsp.map((r) => [r.proveedorId, r]));
        expect(byIsp.valle).toMatchObject({ tipo: "dominio", objetivo: "s1.pelotaya.test" });
        expect(byIsp.aurora).toMatchObject({ tipo: "ip", objetivo: "203.0.113.10" });
    });

    it("an invalid capture is EVIDENCIA_INSUFICIENTE and never a candidate", async () => {
        const sources = new FakeSources({});
        const e = new VerificationEngine({ sources });
        const result = await e.classify(
            detection({ captura: { capturada_min: 2, formato: "mpegts", duracion_seg: 6, contenido_b64: "###" } }),
        );

        expect(result.verdict).toBe("EVIDENCIA_INSUFICIENTE");
        expect(result.medidasPorIsp).toEqual([]);
        expect(result.evidence.capturaSha256).toBeNull();
        expect(sources.dnsRequests).toEqual([]);
    });

    it("a DNS 404 degrades to dominio recommendations (unknown risk)", async () => {
        const result = await engine({}).classify(detection());

        expect(result.verdict).toBe("CANDIDATA_NO_AUTORIZADA");
        expect(result.reasonCodes).toContain("DNS_IP_NO_RECORDS");
        expect(result.assessment.riesgoCompartido).toBe(true);
        for (const rec of result.medidasPorIsp) expect(rec.tipo).not.toBe("ip");
    });

    it("caches /partido and /proveedores across classifications", async () => {
        let matchCalls = 0;
        let providerCalls = 0;
        const sources = new FakeSources({ "203.0.113.10": dedicatedDns });
        const counting = {
            partido: () => {
                matchCalls += 1;
                return sources.partido();
            },
            proveedores: () => {
                providerCalls += 1;
                return sources.proveedores();
            },
            dnsPasivoPorIp: sources.dnsPasivoPorIp.bind(sources),
        };
        const e = new VerificationEngine({ sources: counting });
        await e.classify(detection({ id: "D-1" }));
        await e.classify(detection({ id: "D-2" }));

        expect(matchCalls).toBe(1);
        expect(providerCalls).toBe(1);
        e.refresh();
        await e.classify(detection({ id: "D-3" }));
        expect(matchCalls).toBe(2);
    });
});
