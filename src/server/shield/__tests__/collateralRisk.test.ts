import { describe, expect, it } from "vitest";
import { assessCollateral, isRelatedDomain, registrableSuffix, type PassiveDnsSource } from "../collateralRisk.js";
import { dedicatedDns, detection, FakeSources, sharedDns } from "./fixtures.js";

const golazoDetection = detection({
    pagina: "https://golazo-libre.test/partido",
    host_stream: "live.golazo-libre.test",
    ip_servidor: "198.51.100.20",
    asn: 64610,
    marca_de_agua_extraida: "LP26-PRA-OFI-S077310",
});

const throwingDns: PassiveDnsSource = {
    dnsPasivoPorIp: () => Promise.reject(new Error("socket hang up")),
};

describe("assessCollateral (PASO C)", () => {
    it("TEST 04: flags an IP shared with foreign legitimate domains", async () => {
        const a = await assessCollateral(golazoDetection, new FakeSources({ "198.51.100.20": sharedDns }));
        expect(a.dnsResuelto).toBe(true);
        expect(a.riesgoCompartido).toBe(true);
        expect(a.dominiosCompartidos).toHaveLength(11);
        expect(a.dominiosCompartidos).toContain("noticias-del-valle.test");
        expect(a.reasonCodes).toContain("SHARED_IP_LEGIT_DOMAINS");
    });

    it("treats an IP holding only the stream's own infra as dedicated", async () => {
        const a = await assessCollateral(detection(), new FakeSources({ "203.0.113.10": dedicatedDns }));
        expect(a.riesgoCompartido).toBe(false);
        expect(a.dominiosCompartidos).toEqual([]);
        expect(a.reasonCodes).toContain("IP_APPEARS_DEDICATED");
    });

    it("degrades prudently on the API's documented 404 (unknown risk)", async () => {
        const a = await assessCollateral(detection(), new FakeSources({}));
        expect(a.dnsResuelto).toBe(false);
        expect(a.riesgoCompartido).toBe(true);
        expect(a.reasonCodes).toContain("DNS_IP_NO_RECORDS");
    });

    it("degrades prudently when the lookup throws (unknown risk)", async () => {
        const a = await assessCollateral(detection(), throwingDns);
        expect(a.dnsResuelto).toBe(false);
        expect(a.riesgoCompartido).toBe(true);
        expect(a.reasonCodes).toContain("DNS_LOOKUP_FAILED");
    });
});

describe("domain families", () => {
    it("keeps sibling subdomains of the same signal inside the family", () => {
        expect(registrableSuffix("s1.pelotaya.test")).toBe("pelotaya.test");
        expect(isRelatedDomain("espejo.pelotaya.test", ["pelotaya.test"])).toBe(true);
        expect(isRelatedDomain("pelotaya.test", ["pelotaya.test"])).toBe(true);
        expect(isRelatedDomain("noticias-del-valle.test", ["pelotaya.test"])).toBe(false);
        expect(isRelatedDomain("pelotaya.test.evil.test", ["pelotaya.test"])).toBe(false);
    });
});
