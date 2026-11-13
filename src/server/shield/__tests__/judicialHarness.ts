import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createShieldApp } from "../devServer.js";
import { openJsonPersistence, type ShieldPersistence } from "../persistence/index.js";
import { juecesDeTurno } from "../shiftGuard.js";
import { SigningService } from "../signingService.js";
import type { CourtInfo, DetectionsPage, Provider, SimulatorState } from "../types.js";

// Shared test doubles for the S4 judicial slice. Keys are TEST-LOCAL fictitious
// values — distinct from the demo bundle so any leak into responses is visible.

export const TEST_JWT_SECRET = "test-jwt-secret-shield";

export const TEST_CLAVES = {
    "jueza-laura-ficticia": "TEST-clave-laura-aaaa",
    "juez-martin-ejemplo": "TEST-clave-martin-bbbb",
} as const;
export type TestJuezId = keyof typeof TEST_CLAVES;

export const TEST_TURNOS = [
    { juez_id: "jueza-laura-ficticia" as TestJuezId, desde_min: -60, hasta_min: 50 },
    { juez_id: "juez-martin-ejemplo" as TestJuezId, desde_min: 50, hasta_min: 240 },
];

export async function writeTestJuzgados(): Promise<{ dir: string; filePath: string }> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "juzgados-test-"));
    const filePath = path.join(dir, "juzgados.test.json");
    await fs.writeFile(
        filePath,
        JSON.stringify({
            juzgados: [
                {
                    id: "jg-centro-3",
                    nombre: "Juzgado Centro 3 (test)",
                    jurisdiccion: "test",
                    jueces: [{ id: "jueza-laura-ficticia", nombre: "Dra. Laura", clave_firma_demo: TEST_CLAVES["jueza-laura-ficticia"] }],
                },
                {
                    id: "jg-norte-1",
                    nombre: "Juzgado Norte 1 (test)",
                    jurisdiccion: "test",
                    jueces: [{ id: "juez-martin-ejemplo", nombre: "Dr. Martín", clave_firma_demo: TEST_CLAVES["juez-martin-ejemplo"] }],
                },
            ],
            turnos: TEST_TURNOS,
        }),
        "utf8",
    );
    return { dir, filePath };
}

/** Injectable simulator clock: move `minuto` to simulate match time / shift changes. */
export class FakeSim {
    minuto = 10;
    finMin = 105;

    estado(): Promise<SimulatorState> {
        return Promise.resolve({
            partido: "test-match",
            minuto_actual: this.minuto,
            fin_min: this.finMin,
            finalizado: this.minuto >= this.finMin,
            acelerar: 6,
            jueces_de_turno: juecesDeTurno(this.minuto, TEST_TURNOS),
        });
    }
    detecciones(): Promise<DetectionsPage> {
        return Promise.resolve({ minuto_actual: this.minuto, detecciones: [] });
    }
    proveedores(): Promise<Provider[]> {
        return Promise.resolve([]);
    }
    juzgados(): Promise<CourtInfo> {
        return Promise.resolve({ juzgados: [], turnos: TEST_TURNOS, de_turno_ahora: [] });
    }
}

export interface TestServer {
    base: string;
    persistence: ShieldPersistence;
    sim: FakeSim;
    signing: SigningService;
    close(): Promise<void>;
}

export async function startTestServer(sim: FakeSim = new FakeSim()): Promise<TestServer> {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "shield-data-test-"));
    const { filePath } = await writeTestJuzgados();
    const persistence = await openJsonPersistence(dataDir);
    const signing = await SigningService.fromEnv(filePath);
    const app: Express = createShieldApp({
        persistence,
        sim,
        clock: sim,
        signing,
        jwtSecret: TEST_JWT_SECRET,
        orchestrator: null,
    });
    const server = await new Promise<ReturnType<Express["listen"]>>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        persistence,
        sim,
        signing,
        close: () =>
            new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

export interface HttpResult {
    status: number;
    body: Record<string, any>;
}

export async function http(
    base: string,
    method: "GET" | "POST",
    urlPath: string,
    options: { token?: string; body?: unknown } = {},
): Promise<HttpResult> {
    const res = await fetch(`${base}/api/shield${urlPath}`, {
        method,
        headers: {
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export function loginBody(juezId: TestJuezId, password?: string) {
    return { username: juezId, password: password ?? `demo-${juezId}-2026` };
}
