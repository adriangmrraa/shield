import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Expediente } from "../expedienteTypes.js";
import { WriteQueue } from "../persistence/fileQueue.js";
import { FsEvidenceStore } from "../persistence/fsEvidenceStore.js";
import { openJsonPersistence } from "../persistence/index.js";
import { JsonCaseRepository } from "../persistence/jsonCaseRepository.js";
import { JsonDetectionStore } from "../persistence/jsonDetectionStore.js";
import { JsonlAuditLog } from "../persistence/jsonlAuditLog.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "shield-persist-"));

export function sampleExpediente(overrides: Partial<Expediente> = {}): Expediente {
    return {
        expediente_id: "EXP-practica-01-0001",
        partido_id: "practica-01",
        senal_key: "pelotaya.test",
        fase_key: "pelotaya.test|s1.pelotaya.test|203.0.113.10",
        fase_origen: null,
        deteccion_ids: ["D-0001"],
        detectado_min: 2,
        ultima_deteccion_min: 2,
        pagina: "https://pelotaya.test/en-vivo",
        stream_url: "https://s1.pelotaya.test/hls/en-vivo/index.m3u8",
        host_stream: "s1.pelotaya.test",
        ip_servidor: "203.0.113.10",
        asn: 64600,
        marca_de_agua_extraida: "LP26-PRA-OFI-S048211",
        validacion_marca: { marca_valida: true, prefijo_coincidente: "LP26-PRA-OFI", licenciatario: null },
        estado_licencia: "candidata_no_autorizada",
        captura_sha256: "a".repeat(64),
        captura_capturada_min: 2,
        captura_formato: "mpegts",
        captura_duracion_seg: 6,
        captura_ref: `evidence/${"a".repeat(64)}.bin`,
        dns_pasivo: {
            resuelto: true,
            organizacion: "Bruma Hosting Dedicado (ficticio)",
            dominios: ["s1.pelotaya.test", "s1-respaldo.pelotaya.test"],
        },
        dominios_compartidos: [],
        riesgo: { ip_compartida: false, dns_resuelto: true, asn: 64600, organizacion: "Bruma" },
        medidas_por_isp: [
            { proveedorId: "aurora", tipo: "ip", objetivo: "203.0.113.10", motivo: "dedicated" },
        ],
        vence_min_propuesto: 105,
        asignado_juez_id: null,
        approved_by: null,
        approved_min: null,
        rejected_by: null,
        rejected_min: null,
        reject_motivo: null,
        estado: "pendiente_juez",
        fuente: "qualydata-sim",
        reason_codes: ["CAPTURE_HASH_OK", "WATERMARK_PREFIX_MATCH"],
        creado_en: "2026-11-12T20:00:00.000Z",
        creado_min: 2.5,
        ultima_transicion: {
            desde: "verificado",
            hacia: "pendiente_juez",
            min_sim: 2.5,
            ts_iso: "2026-11-12T20:00:00.000Z",
        },
        ...overrides,
    };
}

describe("JsonDetectionStore", () => {
    it("persists cursor + seen ids across instances (poller restart)", async () => {
        const dir = await tmp();
        const file = path.join(dir, "detections-seen.json");

        const first = new JsonDetectionStore(file, new WriteQueue());
        await first.markSeen("D-0001");
        await first.markSeen("D-0002");
        await first.saveCursor(37.5);

        const second = new JsonDetectionStore(file, new WriteQueue());
        expect(await second.getCursor()).toBe(37.5);
        expect(await second.hasSeen("D-0001")).toBe(true);
        expect(await second.hasSeen("D-9999")).toBe(false);
    });
});

describe("JsonCaseRepository", () => {
    it("saves and re-reads an identical expediente", async () => {
        const dir = await tmp();
        const file = path.join(dir, "cases.json");
        const exp = sampleExpediente();

        await new JsonCaseRepository(file, new WriteQueue()).save(exp);
        const reloaded = await new JsonCaseRepository(file, new WriteQueue()).getById(exp.expediente_id);

        expect(reloaded).toEqual(exp);
    });

    it("finds cases by fase_key and the latest phase by senal_key", async () => {
        const repo = new JsonCaseRepository(path.join(await tmp(), "cases.json"), new WriteQueue());
        const s1 = sampleExpediente();
        const s2 = sampleExpediente({
            expediente_id: "EXP-practica-01-0002",
            fase_key: "pelotaya.test|s2.pelotaya.test|203.0.113.11",
            fase_origen: s1.fase_key,
            ultima_deteccion_min: 47.5,
        });
        await repo.save(s1);
        await repo.save(s2);

        expect(await repo.findByPhaseKey(s1.fase_key)).toEqual(s1);
        expect(await repo.findByPhaseKey("no|such|phase")).toBeNull();
        expect(await repo.findLatestBySignalKey("pelotaya.test")).toEqual(s2);
        expect(await repo.listByEstado("pendiente_juez")).toHaveLength(2);
    });

    it("keeps per-match sequences monotonic across instances", async () => {
        const file = path.join(await tmp(), "cases.json");
        expect(await new JsonCaseRepository(file, new WriteQueue()).nextSequence("practica-01")).toBe(1);
        const repo = new JsonCaseRepository(file, new WriteQueue());
        expect(await repo.nextSequence("practica-01")).toBe(2);
        expect(await repo.nextSequence("otro-partido")).toBe(1);
    });

    it("moves a corrupt cases.json aside and starts clean", async () => {
        const dir = await tmp();
        const file = path.join(dir, "cases.json");
        await writeFile(file, "{ not json !!!", "utf8");

        const repo = new JsonCaseRepository(file, new WriteQueue());
        expect(await repo.list()).toEqual([]);

        const names = await readdir(dir);
        expect(names.some((n) => n.startsWith("cases.json.corrupt-"))).toBe(true);

        await repo.save(sampleExpediente());
        expect(await repo.list()).toHaveLength(1);
    });
});

describe("JsonlAuditLog", () => {
    const record = (evento: string) => ({
        ts_iso: "2026-11-12T20:00:00.000Z",
        min_sim: 2,
        evento,
        expediente_id: null,
        correlation_id: "D-0001",
        datos: {},
    });

    it("assigns a monotonic seq and stays append-only across instances", async () => {
        const dir = await tmp();
        const file = path.join(dir, "audit.jsonl");

        const first = new JsonlAuditLog(file, new WriteQueue());
        await first.append(record("detection_recibida"));
        await first.append(record("detection_verificada"));

        const second = new JsonlAuditLog(file, new WriteQueue());
        const third = await second.append(record("expediente_creado"));
        expect(third.seq).toBe(3);

        const lines = (await readFile(file, "utf8")).trim().split("\n");
        expect(lines).toHaveLength(3);
        expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
        expect(await second.tail(2)).toHaveLength(2);
        expect((await second.readAll()).map((e) => e.evento)).toEqual([
            "detection_recibida",
            "detection_verificada",
            "expediente_creado",
        ]);
    });
});

describe("FsEvidenceStore", () => {
    it("stores bytes under evidence/<sha256>.bin and reads them back", async () => {
        const dir = await tmp();
        const store = new FsEvidenceStore(dir, new WriteQueue());
        const sha = "b".repeat(64);
        const bytes = Buffer.from("captura sintetica");

        const ref = await store.put(sha, bytes);
        expect(ref).toBe(`evidence/${sha}.bin`);
        expect(await store.get(ref)).toEqual(bytes);
        expect(await store.get("evidence/../secret.bin")).toBeNull();
        expect(await store.get(`evidence/${"0".repeat(64)}.bin`)).toBeNull();
    });
});

describe("openJsonPersistence", () => {
    it("creates the data dir layout lazily under data/shield semantics", async () => {
        const dir = await tmp();
        const persistence = await openJsonPersistence(dir);

        await persistence.detections.saveCursor(9);
        const reopened = await openJsonPersistence(dir);
        expect(await reopened.detections.getCursor()).toBe(9);
    });
});
