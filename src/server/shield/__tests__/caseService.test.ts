import { describe, expect, it } from "vitest";
import { AuditService } from "../auditService.js";
import { CaseNotFoundError, CaseService, type IngestContext } from "../caseService.js";
import { InvalidTransitionError } from "../expedienteTypes.js";
import { phaseKey, signalKey } from "../phaseKey.js";
import { captureSha256 } from "../evidenceService.js";
import { VerificationEngine } from "../verificationEngine.js";
import {
    canalNorte,
    dedicatedDns,
    detection,
    FakeSources,
    golazoLibre,
    matchInfo,
    pelotayaS1,
    pelotayaS2,
    practiceDns,
    resumenes,
    sharedDns,
} from "./fixtures.js";
import { MemAuditLog, MemCaseRepository, MemEvidenceStore } from "./memPersistence.js";

const CTX: IngestContext = { partidoId: matchInfo.id, venceMin: matchInfo.fin_min, minSim: 10, correlationId: "test" };

function harness(dns: ConstructorParameters<typeof FakeSources>[0] = practiceDns) {
    const cases = new MemCaseRepository();
    const evidence = new MemEvidenceStore();
    const auditLog = new MemAuditLog();
    const audit = new AuditService(auditLog);
    const service = new CaseService({ cases, evidence, audit, now: () => new Date("2026-11-12T20:00:00Z") });
    const engine = new VerificationEngine({ sources: new FakeSources(dns) });
    const ingest = async (d: Parameters<typeof engine.classify>[0]) =>
        service.ingestVerification(d, await engine.classify(d), { ...CTX, correlationId: d.id });
    return { cases, evidence, auditLog, service, engine, ingest };
}

describe("CaseService.ingestVerification", () => {
    it("dedups by phase: 3 detections same host+ip -> ONE case with 3 deteccion_ids", async () => {
        const { ingest, cases } = harness();

        const r1 = await ingest(pelotayaS1("D-0001", 2));
        const r2 = await ingest(pelotayaS1("D-0005", 12));
        const r3 = await ingest(pelotayaS1("D-0009", 22));

        expect(r1.outcome).toBe("created");
        expect(r2.outcome).toBe("updated");
        expect(r3.outcome).toBe("updated");

        const all = await cases.list();
        expect(all).toHaveLength(1);
        const exp = all[0];
        expect(exp.expediente_id).toBe(`EXP-${matchInfo.id}-0001`);
        expect(exp.deteccion_ids).toEqual(["D-0001", "D-0005", "D-0009"]);
        expect(exp.detectado_min).toBe(2);
        expect(exp.ultima_deteccion_min).toBe(22);
        expect(exp.estado).toBe("pendiente_juez");
        expect(exp.fase_origen).toBeNull();
    });

    it("migration s1->s2 (same signal, new host/ip) -> NEW case linked by senal_key", async () => {
        const { ingest, cases } = harness();

        const s1 = await ingest(pelotayaS1("D-0001", 2));
        const s2 = await ingest(pelotayaS2("D-0014", 37.5));

        const all = await cases.list();
        expect(all).toHaveLength(2);
        expect(s2.expediente!.expediente_id).not.toBe(s1.expediente!.expediente_id);
        expect(s2.expediente!.senal_key).toBe(s1.expediente!.senal_key);
        expect(s2.expediente!.fase_origen).toBe(s1.expediente!.fase_key);
        expect(s2.expediente!.fase_key).toBe(phaseKey(pelotayaS2("x", 0)));
    });

    it("different signals get independent cases", async () => {
        const { ingest, cases } = harness({ "203.0.113.10": dedicatedDns, "198.51.100.20": sharedDns });

        await ingest(pelotayaS1("D-0001", 2));
        await ingest(golazoLibre("D-0003", 6));

        const all = await cases.list();
        expect(all).toHaveLength(2);
        expect(new Set(all.map((e) => e.senal_key)).size).toBe(2);
    });

    it("AUTORIZADA / OTRA_SEÑAL / EVIDENCIA_INSUFICIENTE -> audited discard, zero cases", async () => {
        const { ingest, cases, auditLog } = harness();
        const badEvidence = detection({
            id: "D-X",
            captura: { capturada_min: 2, formato: "mpegts", duracion_seg: 6, contenido_b64: "###" },
        });

        const r1 = await ingest(canalNorte("D-0002", 4));
        const r2 = await ingest(resumenes("D-0008", 20));
        const r3 = await ingest(badEvidence);

        expect([r1.outcome, r2.outcome, r3.outcome]).toEqual(["discarded", "discarded", "discarded"]);
        expect(await cases.list()).toHaveLength(0);

        const discards = auditLog.byEvent("detection_descartada");
        expect(discards).toHaveLength(3);
        expect(discards.map((d) => d.datos.verdict)).toEqual([
            "AUTORIZADA",
            "OTRA_SEÑAL",
            "EVIDENCIA_INSUFICIENTE",
        ]);
        for (const entry of discards) {
            expect(Array.isArray(entry.datos.reason_codes)).toBe(true);
            expect(entry.datos.deteccion_id).toMatch(/^D-/);
        }
    });

    it("stores capture bytes behind captura_ref and keeps the full field set", async () => {
        const { ingest, evidence } = harness({ "203.0.113.10": dedicatedDns });
        const d = pelotayaS1("D-0001", 2);
        const { expediente } = await ingest(d);

        const sha = captureSha256(d.captura.contenido_b64);
        expect(expediente!.captura_sha256).toBe(sha);
        expect(expediente!.captura_ref).toBe(`evidence/${sha}.bin`);
        expect(await evidence.get(expediente!.captura_ref!)).not.toBeNull();

        expect(expediente!.vence_min_propuesto).toBe(matchInfo.fin_min);
        expect(expediente!.fuente).toBe("qualydata-sim");
        expect(expediente!.estado_licencia).toBe("candidata_no_autorizada");
        expect(expediente!.validacion_marca.prefijo_coincidente).toBe("LP26-PRA-OFI");
        expect(expediente!.dns_pasivo!.dominios).toContain("s1.pelotaya.test");
        expect(expediente!.riesgo!.ip_compartida).toBe(false);
        expect(expediente!.medidas_por_isp.length).toBeGreaterThan(0);
        expect(expediente!.senal_key).toBe(signalKey(d));
    });

    it("re-ingesting the same detection id never duplicates deteccion_ids", async () => {
        const { ingest, cases, auditLog } = harness();
        const d = pelotayaS1("D-0001", 2);

        await ingest(d);
        const again = await ingest(d);

        expect(again.outcome).toBe("updated");
        expect((await cases.list())[0].deteccion_ids).toEqual(["D-0001"]);
        const updates = auditLog.byEvent("expediente_actualizado");
        expect(updates.at(-1)!.datos.deteccion_nueva).toBe(false);
    });
});

describe("CaseService state machine", () => {
    it("a created case lands in pendiente_juez via recibido->verificado", async () => {
        const { ingest, auditLog } = harness();
        const { expediente } = await ingest(pelotayaS1("D-0001", 2));

        expect(expediente!.estado).toBe("pendiente_juez");
        expect(expediente!.ultima_transicion).toMatchObject({ desde: "verificado", hacia: "pendiente_juez" });

        const transitions = auditLog
            .byEvent("transicion_estado")
            .filter((t) => t.expediente_id === expediente!.expediente_id);
        expect(transitions.map((t) => [t.datos.desde, t.datos.hacia])).toEqual([
            ["recibido", "verificado"],
            ["verificado", "pendiente_juez"],
        ]);
    });

    it("accepts valid transitions and audits them", async () => {
        const { ingest, service } = harness();
        const { expediente } = await ingest(pelotayaS1("D-0001", 2));

        const approved = await service.transition(expediente!.expediente_id, "aprobado", {
            minSim: 5,
            motivo: "judge demo",
        });
        expect(approved.estado).toBe("aprobado");
        expect(approved.ultima_transicion).toMatchObject({
            desde: "pendiente_juez",
            hacia: "aprobado",
            min_sim: 5,
            motivo: "judge demo",
        });
    });

    it("rejects invalid transitions without mutating the case", async () => {
        const { ingest, service, cases } = harness();
        const { expediente } = await ingest(pelotayaS1("D-0001", 2));

        await expect(
            service.transition(expediente!.expediente_id, "aplicado", { minSim: 5 }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await cases.getById(expediente!.expediente_id))!.estado).toBe("pendiente_juez");
    });

    it("rejects transitions on terminal states and on unknown ids", async () => {
        const { ingest, service } = harness();
        const { expediente } = await ingest(pelotayaS1("D-0001", 2));
        await service.transition(expediente!.expediente_id, "rechazado", { minSim: 5 });

        await expect(
            service.transition(expediente!.expediente_id, "aprobado", { minSim: 6 }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
        await expect(service.transition("EXP-nope-9999", "aprobado", { minSim: 6 })).rejects.toBeInstanceOf(
            CaseNotFoundError,
        );
    });
});

describe("audit trail for the ingest chain", () => {
    it("records expediente_creado with custody fields and no capture bytes", async () => {
        const { ingest, auditLog } = harness();
        const d = pelotayaS1("D-0001", 2);
        const { expediente } = await ingest(d);

        const created = auditLog.byEvent("expediente_creado");
        expect(created).toHaveLength(1);
        expect(created[0].expediente_id).toBe(expediente!.expediente_id);
        expect(created[0].correlation_id).toBe(d.id);
        expect(created[0].datos.captura_sha256).toBe(expediente!.captura_sha256);
        expect(created[0].datos.captura_ref).toBe(expediente!.captura_ref);

        const serialized = JSON.stringify(auditLog.entries);
        expect(serialized).not.toContain(d.captura.contenido_b64);
        expect(serialized).not.toContain("contenido_b64");
    });
});
