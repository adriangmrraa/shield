import { AxiosError, AxiosHeaders, type AxiosInstance, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";
import {
    QualyDataClient,
    SimulatorConfigError,
    SimulatorHttpError,
    SimulatorNetworkError,
    SimulatorValidationError,
} from "../qualydataClient.js";

const fakeHttp = (impl: { get?: ReturnType<typeof vi.fn>; post?: ReturnType<typeof vi.fn> }) =>
    ({
        get: impl.get ?? vi.fn(),
        post: impl.post ?? vi.fn(),
    }) as unknown as AxiosInstance;

const client = (http: AxiosInstance) => new QualyDataClient({ baseUrl: "http://sim.test", http });

const notFoundResponse = (error: string): AxiosResponse => ({
    status: 404,
    statusText: "Not Found",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { error },
});

describe("QualyDataClient", () => {
    it("fails fast when SIMULATOR_BASE_URL is missing", () => {
        const saved = process.env.SIMULATOR_BASE_URL;
        delete process.env.SIMULATOR_BASE_URL;
        try {
            expect(() => new QualyDataClient()).toThrow(SimulatorConfigError);
        } finally {
            if (saved !== undefined) process.env.SIMULATOR_BASE_URL = saved;
        }
    });

    it("sends `desde` as query param to GET /detecciones", async () => {
        const get = vi.fn(async () => ({ data: { minuto_actual: 3.5, detecciones: [] } }));
        const http = fakeHttp({ get });

        const page = await client(http).detecciones(-1);

        expect(get).toHaveBeenCalledWith("/detecciones", { params: { desde: -1 } });
        expect(page.minuto_actual).toBe(3.5);
    });

    it("wraps a malformed payload in SimulatorValidationError", async () => {
        const http = fakeHttp({ get: vi.fn(async () => ({ data: { minuto_actual: "soon" } })) });

        await expect(client(http).detecciones(0)).rejects.toBeInstanceOf(SimulatorValidationError);
    });

    it("maps an HTTP error response to SimulatorHttpError with status and body", async () => {
        const axiosError = new AxiosError(
            "Request failed",
            "ERR_BAD_REQUEST",
            { headers: new AxiosHeaders() },
            {},
            notFoundResponse("Sin registros de DNS pasivo para la IP 1.2.3.4"),
        );
        const http = fakeHttp({ get: vi.fn(async () => Promise.reject(axiosError)) });

        await expect(client(http).orden("aurora", "O-1")).rejects.toMatchObject({
            name: "SimulatorHttpError",
            status: 404,
        });
    });

    it("returns null on the documented 404 of the passive DNS endpoint", async () => {
        const axiosError = new AxiosError(
            "Request failed",
            "ERR_BAD_REQUEST",
            { headers: new AxiosHeaders() },
            {},
            notFoundResponse("Sin registros de DNS pasivo para la IP 1.2.3.4"),
        );
        const http = fakeHttp({ get: vi.fn(async () => Promise.reject(axiosError)) });

        await expect(client(http).dnsPasivoPorIp("1.2.3.4")).resolves.toBeNull();
    });

    it("maps connection failures to SimulatorNetworkError", async () => {
        const axiosError = new AxiosError("connect ECONNREFUSED", "ECONNREFUSED");
        const http = fakeHttp({ get: vi.fn(async () => Promise.reject(axiosError)) });

        await expect(client(http).estado()).rejects.toBeInstanceOf(SimulatorNetworkError);
    });

    it("posts the order body to the provider's ordenes endpoint", async () => {
        const post = vi.fn(async () => ({
            data: { orden_id: "O-1", estado: "recibida", consultar: "/proveedores/aurora/ordenes/O-1" },
        }));
        const http = fakeHttp({ post });
        const orden = {
            orden_id: "O-1",
            expediente_id: "EXP-1",
            tipo: "dominio" as const,
            objetivo: "s1.pelotaya.test",
            vence_min: 95,
            juzgado_id: "jg-centro-3",
            juez_id: "jueza-laura-ficticia",
            firma: "a".repeat(64),
        };

        const accepted = await client(http).enviarOrden("aurora", orden);

        expect(post).toHaveBeenCalledWith("/proveedores/aurora/ordenes", orden);
        expect(accepted.estado).toBe("recibida");
    });
});
