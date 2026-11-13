import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditService } from "../auditService.js";
import { MatchOrchestrator, type OrchestratorClient } from "../matchOrchestrator.js";
import { openJsonPersistence } from "../persistence/index.js";
import { phaseKey } from "../phaseKey.js";
import type { DetectionsPage, Detection, MatchInfo, PassiveDnsByIp, Provider } from "../types.js";
import {
    canalNorte,
    golazoLibre,
    matchInfo,
    pelotayaS1,
    pelotayaS2,
    practiceDns,
    providers,
    resumenes,
} from "./fixtures.js";

// Roundtrip: the real orchestrator wiring (poller -> engine -> caseService)
// over real JSON persistence in a tmp dir, fed by a fake QualyData client with
// the practice-scenario detections. No network.

class FakeQualyDataClient implements OrchestratorClient {
    private readonly dnsByIp: Record<string, PassiveDnsByIp | null>;

    constructor(
        // Consumed in place: detecciones() shifts pages so callers can track
        // how much feed remains via pages.length.
        private readonly pages: DetectionsPage[],
        dnsByIp: Record<string, PassiveDnsByIp | null> = practiceDns,
        private readonly match: MatchInfo = matchInfo,
        private readonly providerList: Provider[] = providers,
    ) {
        this.dnsByIp = dnsByIp;
    }

    detecciones(desde: number): Promise<DetectionsPage> {
        const next = this.pages.shift();
        return Promise.resolve(next ?? { minuto_actual: desde, detecciones: [] });
    }
    partido(): Promise<MatchInfo> {
        return Promise.resolve(this.match);
    }
    proveedores(): Promise<Provider[]> {
        return Promise.resolve(this.providerList);
    }
    dnsPasivoPorIp(ip: string): Promise<PassiveDnsByIp | null> {
        return Promise.resolve(
            Object.prototype.hasOwnProperty.call(this.dnsByIp, ip) ? this.dnsByIp[ip] : null,
        );
    }
}

const tmp = () => mkdtemp(path.join(tmpdir(), "shield-orch-"));

async function orchestrate(pages: DetectionsPage[]) {
    const dir = await tmp();
    const persistence = await openJsonPersistence(dir);
    const audit = new AuditService(persistence.audit);
    const client = new FakeQualyDataClient(pages);
    const orchestrator = new MatchOrchestrator({ client, persistence, audit });
    while (pages.length > 0) await orchestrator.pollOnce();
    return { orchestrator, persistence, audit, dir };
}

describe("MatchOrchestrator roundtrip", () => {
    it("4+ scenario detections -> correct cases and discards", async () => {
        const pages: DetectionsPage[] = [
            {
                minuto_actual: 6,
                detecciones: [
                    pelotayaS1("D-0001", 2),
                    canalNorte("D-0002", 4),
                    golazoLibre("D-0003", 6),
                    resumenes("D-0008", 6),
                ],
            },
        ];
        const { orchestrator, persistence } = await orchestrate(pages);

        const status = await orchestrator.status();
        expect(status.casosPorEstado).toEqual({ pendiente_juez: 2 });
        expect(status.contadores).toMatchObject({
            recibidas: 4,
            verificadas: 4,
            expedientesCreados: 2,
            descartadas: 2,
            errores: 0,
        });
        expect(status.descartesPorVerdict).toEqual({ AUTORIZADA: 1, "OTRA_SEÑAL": 1 });

        const cases = await persistence.cases.list();
        expect(cases.map((c) => c.host_stream).sort()).toEqual(["live.golazo-libre.test", "s1.pelotaya.test"]);
        const golazo = cases.find((c) => c.host_stream === "live.golazo-libre.test")!;
        expect(golazo.riesgo!.ip_compartida).toBe(true);
        expect(golazo.medidas_por_isp.every((m) => m.tipo !== "ip")).toBe(true);
        for (const c of cases) expect(c.estado).toBe("pendiente_juez");
    });

    it("dedup + migration: repeat of a phase appends, new host/ip opens a linked case", async () => {
        const pages: DetectionsPage[] = [
            { minuto_actual: 30, detecciones: [pelotayaS1("D-0001", 2), pelotayaS1("D-0005", 12)] },
            { minuto_actual: 40, detecciones: [pelotayaS2("D-0014", 37.5)] },
        ];
        const { persistence } = await orchestrate(pages);

        const cases = await persistence.cases.list();
        expect(cases).toHaveLength(2);
        const s1 = cases.find((c) => c.host_stream === "s1.pelotaya.test")!;
        const s2 = cases.find((c) => c.host_stream === "s2.pelotaya.test")!;
        expect(s1.deteccion_ids).toEqual(["D-0001", "D-0005"]);
        expect(s2.fase_origen).toBe(s1.fase_key);
        expect(s2.fase_key).toBe(phaseKey(pelotayaS2("x", 0)));
        expect(s1.senal_key).toBe(s2.senal_key);
    });

    it("audit.jsonl shows the detection -> verificada -> expediente chain", async () => {
        const pages: DetectionsPage[] = [
            { minuto_actual: 3, detecciones: [pelotayaS1("D-0001", 2)] },
        ];
        const { audit } = await orchestrate(pages);

        const events = (await audit.readAll()).map((e) => e.evento);
        expect(events).toEqual([
            "detection_recibida",
            "detection_verificada",
            "expediente_creado",
            "transicion_estado",
            "transicion_estado",
        ]);
        const entries = await audit.readAll();
        expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(entries.every((e) => e.correlation_id === "D-0001")).toBe(true);
    });

    it("no secrets in audit.jsonl or cases.json (no contenido_b64)", async () => {
        const pages: DetectionsPage[] = [
            { minuto_actual: 3, detecciones: [pelotayaS1("D-0001", 2)] },
        ];
        const { dir } = await orchestrate(pages);

        const auditRaw = await readFile(path.join(dir, "audit.jsonl"), "utf8");
        const casesRaw = await readFile(path.join(dir, "cases.json"), "utf8");
        for (const raw of [auditRaw, casesRaw]) {
            expect(raw).not.toContain("contenido_b64");
            expect(raw).not.toContain("QUJDREVGRw==");
        }
    });

    it("survives a failing detection without stalling the batch", async () => {
        // Missing host_stream makes phaseKey throw -> detection_error, batch continues.
        const poison: Detection = { ...pelotayaS1("D-POISON", 3), host_stream: undefined as never };
        const pages: DetectionsPage[] = [
            { minuto_actual: 4, detecciones: [poison, pelotayaS1("D-0001", 4)] },
        ];
        const errors: unknown[] = [];
        const dir = await tmp();
        const persistence = await openJsonPersistence(dir);
        const audit = new AuditService(persistence.audit);
        const orchestrator = new MatchOrchestrator({
            client: new FakeQualyDataClient(pages),
            persistence,
            audit,
            onError: (e) => errors.push(e),
        });
        await orchestrator.pollOnce();

        const status = await orchestrator.status();
        expect(status.contadores.errores).toBe(1);
        expect(status.casosPorEstado).toEqual({ pendiente_juez: 1 });
        expect(errors).toHaveLength(1);
        const errorEvents = (await audit.readAll()).filter((e) => e.evento === "detection_error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].correlation_id).toBe("D-POISON");
    });

    it("a second orchestrator instance resumes the cursor and skips seen detections", async () => {
        const dir = await tmp();
        const persistence = await openJsonPersistence(dir);
        const audit = new AuditService(persistence.audit);
        const client = new FakeQualyDataClient([
            { minuto_actual: 3, detecciones: [pelotayaS1("D-0001", 2)] },
        ]);
        const first = new MatchOrchestrator({ client, persistence, audit });
        await first.pollOnce();

        // Restart: same data dir, feed would resend the same detection.
        const persistence2 = await openJsonPersistence(dir);
        const client2 = new FakeQualyDataClient([
            { minuto_actual: 5, detecciones: [pelotayaS1("D-0001", 2), pelotayaS1("D-0005", 5)] },
        ]);
        const second = new MatchOrchestrator({ client: client2, persistence: persistence2, audit });
        const poll = await second.pollOnce();

        expect(poll.detections.map((d) => d.id)).toEqual(["D-0005"]);
        expect((await persistence.cases.list())[0].deteccion_ids).toEqual(["D-0001", "D-0005"]);
        expect((await second.status()).minuto).toBe(5);
    });
});
