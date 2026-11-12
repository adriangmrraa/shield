import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { DetectionPoller, InMemoryDetectionStore, type DetectionSource } from "../detectionPoller.js";
import { SimulatorValidationError } from "../qualydataClient.js";
import type { Detection, DetectionsPage } from "../types.js";

const zodFailure = () => new SimulatorValidationError("/detecciones", new ZodError([]));

const detection = (id: string, minuto: number): Detection => ({
    id,
    minuto,
    pagina: `https://pagina.test/${id}`,
    stream_url: `https://s.test/${id}/index.m3u8`,
    host_stream: "s.test",
    ip_servidor: "203.0.113.1",
    asn: 64600,
    marca_de_agua_extraida: `LP26-PRA-OFI-${id}`,
    captura: { capturada_min: minuto, formato: "mpegts", duracion_seg: 6, contenido_b64: "QUJD" },
});

class FakeClient implements DetectionSource {
    readonly requests: number[] = [];
    private readonly queue: Array<DetectionsPage | (() => Promise<DetectionsPage>)>;

    constructor(queue: Array<DetectionsPage | (() => Promise<DetectionsPage>)>) {
        this.queue = [...queue];
    }

    async detecciones(desde: number): Promise<DetectionsPage> {
        this.requests.push(desde);
        const next = this.queue.shift();
        if (!next) return { minuto_actual: desde, detecciones: [] };
        return typeof next === "function" ? next() : next;
    }
}

describe("DetectionPoller", () => {
    it("starts the cursor at -1 and uses the response's minuto_actual as next cursor", async () => {
        const client = new FakeClient([
            { minuto_actual: 3.5, detecciones: [detection("D-1", 3)] },
            { minuto_actual: 7.25, detecciones: [] },
        ]);
        const onDetections = vi.fn();
        const poller = new DetectionPoller({ client, onDetections });

        const first = await poller.pollOnce();
        expect(first.minute).toBe(3.5);

        const second = await poller.pollOnce();
        expect(second.minute).toBe(7.25);

        expect(client.requests).toEqual([-1, 3.5]);
        expect(await poller.cursor()).toBe(7.25);
    });

    it("never delivers the same detection id twice even if the feed repeats it", async () => {
        const client = new FakeClient([
            { minuto_actual: 3, detecciones: [detection("D-1", 2), detection("D-2", 3)] },
            { minuto_actual: 6, detecciones: [detection("D-2", 3), detection("D-3", 5)] },
        ]);
        const onDetections = vi.fn();
        const poller = new DetectionPoller({ client, onDetections });

        await poller.pollOnce();
        await poller.pollOnce();

        const delivered = onDetections.mock.calls.flatMap(([batch]) => batch as Detection[]);
        expect(delivered.map((d) => d.id)).toEqual(["D-1", "D-2", "D-3"]);
    });

    it("survives a validation error: cursor does not advance and the loop stays alive", async () => {
        const boom = () => Promise.reject(zodFailure());
        const client = new FakeClient([boom, { minuto_actual: 4, detecciones: [detection("D-9", 4)] }]);
        const onDetections = vi.fn();
        const onError = vi.fn();
        const store = new InMemoryDetectionStore();
        const poller = new DetectionPoller({
            client,
            onDetections,
            onError,
            store,
            intervalMs: 5,
        });

        await expect(poller.pollOnce()).rejects.toBeInstanceOf(SimulatorValidationError);
        expect(store.getCursor()).toBe(-1);
        expect(onDetections).not.toHaveBeenCalled();

        poller.start();
        await vi.waitFor(() => expect(onDetections).toHaveBeenCalledTimes(1));
        poller.stop();

        expect(onError).not.toHaveBeenCalled();
        expect(store.getCursor()).toBe(4);
        expect(onDetections.mock.calls[0][0].map((d: Detection) => d.id)).toEqual(["D-9"]);
    });

    it("logs a failed cycle inside the loop and keeps polling", async () => {
        let calls = 0;
        const client: DetectionSource = {
            async detecciones(desde: number) {
                calls += 1;
                if (calls === 1) throw zodFailure();
                if (calls === 2) return { minuto_actual: desde + 1, detecciones: [detection("D-2", desde + 1)] };
                return { minuto_actual: desde + 1, detecciones: [] };
            },
        };
        const onDetections = vi.fn();
        const onError = vi.fn();
        const poller = new DetectionPoller({ client, onDetections, onError, intervalMs: 5 });

        poller.start();
        await vi.waitFor(() => expect(onDetections).toHaveBeenCalledTimes(1));
        poller.stop();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBeInstanceOf(SimulatorValidationError);
        expect(calls).toBeGreaterThanOrEqual(2);
    });

    it("advances the cursor even when a cycle yields no detections", async () => {
        const client = new FakeClient([
            { minuto_actual: 1.5, detecciones: [] },
            { minuto_actual: 2.5, detecciones: [detection("D-1", 2)] },
        ]);
        const onDetections = vi.fn();
        const poller = new DetectionPoller({ client, onDetections });

        await poller.pollOnce();
        expect(onDetections).not.toHaveBeenCalled();
        expect(await poller.cursor()).toBe(1.5);

        await poller.pollOnce();
        expect(client.requests).toEqual([-1, 1.5]);
        expect(onDetections).toHaveBeenCalledTimes(1);
    });
});
