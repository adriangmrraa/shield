import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachShieldRealtime, createShieldRuntime, type ShieldRuntime } from "../devServer.js";
import { sanitizeForWire } from "../shieldRealtime.js";
import { SHIELD_SOCKET_PATH } from "../shieldSocket.js";
import { FakeSim, TEST_JWT_SECRET, writeTestJuzgados } from "./judicialHarness.js";
import { memPersistence } from "./memPersistence.js";

// S7 socket integration: real Socket.IO server on the dev-server httpServer,
// real jwt auth middleware, real instrumented persistence. Events must reach
// an authenticated client; a tokenless client must be rejected at handshake.

function signJudgeToken(secret: string): string {
    return jwt.sign(
        { sub: "jueza-laura-ficticia", juez_id: "jueza-laura-ficticia", juzgado_id: "jg-centro-3", role: "juez" },
        secret,
        { expiresIn: 60 },
    );
}

function connect(base: string, token?: string): Promise<{ socket: Socket; error?: Error }> {
    return new Promise((resolve) => {
        const socket = ioClient(base, {
            path: SHIELD_SOCKET_PATH,
            auth: token ? { token } : {},
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
            timeout: 3_000,
        });
        socket.once("connect", () => resolve({ socket }));
        socket.once("connect_error", (error) => resolve({ socket, error }));
    });
}

function nextEvent(socket: Socket, name: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${name}`)), timeoutMs);
        socket.once(name, (payload: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

describe("sanitizeForWire", () => {
    it("trunca firma a 12 chars y elimina claves sensibles", () => {
        const firma = "a".repeat(64);
        const out = sanitizeForWire({
            firma,
            clave_firma_demo: "secreto",
            nested: { firma, password_hash: "x" },
            lista: [{ firma }],
            ok: 1,
        }) as Record<string, any>;
        expect(out.firma).toBe("a".repeat(12));
        expect(out.clave_firma_demo).toBeUndefined();
        expect(out.nested.firma).toBe("a".repeat(12));
        expect(out.nested.password_hash).toBeUndefined();
        expect(out.lista[0].firma).toBe("a".repeat(12));
        expect(out.ok).toBe(1);
    });
});

describe("shield socket gateway", () => {
    let runtime: ShieldRuntime;
    let server: Server;
    let base: string;
    let closeSocket: () => void;

    beforeAll(async () => {
        const { filePath } = await writeTestJuzgados();
        process.env.SHIELD_SIGNING_KEYS_PATH = filePath;
        process.env.JWT_SECRET = TEST_JWT_SECRET;

        runtime = await createShieldRuntime({
            persistence: memPersistence(),
            sim: new FakeSim(),
            orchestrator: null,
            dispatch: null,
        });
        server = await new Promise<Server>((resolve) => {
            const s = runtime.app.listen(0, "127.0.0.1", () => resolve(s as Server));
        });
        const handle = attachShieldRealtime(server, runtime);
        closeSocket = handle.close;
        const { port } = server.address() as AddressInfo;
        base = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        closeSocket();
        await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
    });

    it("rechaza handshake sin token", async () => {
        const { socket, error } = await connect(base);
        expect(error).toBeDefined();
        socket.close();
    });

    it("rechaza handshake con token inválido", async () => {
        const { socket, error } = await connect(base, "token-falso");
        expect(error).toBeDefined();
        socket.close();
    });

    it("cliente autenticado conecta y recibe tick del cursor del poller", async () => {
        const { socket, error } = await connect(base, signJudgeToken(TEST_JWT_SECRET));
        expect(error).toBeUndefined();
        const tick = nextEvent(socket, "shield:tick");
        await runtime.persistence.detections.saveCursor(42);
        const payload = await tick;
        expect(payload.minuto).toBe(42);
        socket.close();
    });

    it("emite shield:order desde un append de audit con firma sanitizada", async () => {
        const { socket, error } = await connect(base, signJudgeToken(TEST_JWT_SECRET));
        expect(error).toBeUndefined();
        const orderEvent = nextEvent(socket, "shield:order");
        await runtime.persistence.audit.append({
            ts_iso: new Date().toISOString(),
            min_sim: 44,
            evento: "orden_aplicada",
            expediente_id: "EXP-test-1",
            correlation_id: "orden:test-1",
            datos: { orden_id: "ord-1", proveedor_id: "aurora", firma: "f".repeat(64) },
        });
        const payload = await orderEvent;
        expect(payload.kind).toBe("aplicada");
        expect(payload.expediente_id).toBe("EXP-test-1");
        const datos = payload.datos as Record<string, unknown>;
        expect(datos.firma).toBe("f".repeat(12));
        socket.close();
    });

    it("emite el alias granular shield:order-applied además del canal genérico", async () => {
        const { socket, error } = await connect(base, signJudgeToken(TEST_JWT_SECRET));
        expect(error).toBeUndefined();
        const applied = nextEvent(socket, "shield:order-applied");
        await runtime.persistence.audit.append({
            ts_iso: new Date().toISOString(),
            min_sim: 45,
            evento: "orden_aplicada",
            expediente_id: "EXP-test-1",
            correlation_id: "orden:test-2",
            datos: { orden_id: "ord-2", proveedor_id: "cumbre" },
        });
        const payload = await applied;
        expect(payload.kind).toBe("aplicada");
        socket.close();
    });
});
