import { describe, expect, it } from "vitest";
import { phaseKey, samePhase, signalKey } from "../phaseKey.js";
import { detection } from "./fixtures.js";

describe("phaseKey / samePhase (PASO E)", () => {
    it("consolidates repeated detections of the same signal on the same host+ip", () => {
        const a = detection({ id: "D-0001", minuto: 2 });
        const b = detection({ id: "D-0009", minuto: 22 });
        expect(samePhase(a, b)).toBe(true);
        expect(phaseKey(a)).toBe(phaseKey(b));
    });

    it("treats a host migration (s1 -> s2) as a new phase", () => {
        const s1 = detection({ id: "D-0001", host_stream: "s1.pelotaya.test", ip_servidor: "203.0.113.10" });
        const s2 = detection({
            id: "D-0014",
            stream_url: "https://s2.pelotaya.test/hls/en-vivo/index.m3u8",
            host_stream: "s2.pelotaya.test",
            ip_servidor: "203.0.113.11",
        });
        expect(samePhase(s1, s2)).toBe(false);
        expect(phaseKey(s1)).not.toBe(phaseKey(s2));
        // ...but still the same signal identity underneath both phases.
        expect(signalKey(s1)).toBe(signalKey(s2));
    });

    it("treats an IP change on the same host as a new phase", () => {
        const a = detection({ ip_servidor: "203.0.113.10" });
        const b = detection({ ip_servidor: "203.0.113.11" });
        expect(samePhase(a, b)).toBe(false);
    });

    it("keeps distinct signals on identical infra in different phases", () => {
        const a = detection({ pagina: "https://pelotaya.test/en-vivo" });
        const b = detection({ pagina: "https://golazo-libre.test/partido" });
        expect(samePhase(a, b)).toBe(false);
    });
});
