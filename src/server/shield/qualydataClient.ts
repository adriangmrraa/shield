import axios, { AxiosError, isAxiosError, type AxiosInstance } from "axios";
import { ZodError, type z } from "zod";
import {
    apiErrorSchema,
    claimsPageSchema,
    courtInfoSchema,
    detectionsPageSchema,
    matchInfoSchema,
    orderAcceptedSchema,
    passiveDnsByDomainSchema,
    passiveDnsByIpSchema,
    providerListSchema,
    providerOrderSchema,
    simulatorStateSchema,
    type BlockOrder,
    type ClaimsPage,
    type CourtInfo,
    type DetectionsPage,
    type LiftOrderRequest,
    type MatchInfo,
    type OrderAccepted,
    type PassiveDnsByDomain,
    type PassiveDnsByIp,
    type Provider,
    type ProviderOrder,
    type SimulatorState,
} from "./types.js";

export class SimulatorConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SimulatorConfigError";
    }
}

// DNS refused / timeout / connection reset: request never got a valid response.
export class SimulatorNetworkError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "SimulatorNetworkError";
    }
}

// Simulator answered with a non-2xx status (4xx validation, 404, etc.).
export class SimulatorHttpError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body: unknown, message?: string) {
        super(message ?? `Simulator responded with HTTP ${status}`);
        this.name = "SimulatorHttpError";
        this.status = status;
        this.body = body;
    }
}

// Response was 2xx JSON but does not match the verified simulator contract.
export class SimulatorValidationError extends Error {
    readonly issues: ZodError["issues"];

    constructor(endpoint: string, cause: ZodError) {
        super(`Invalid payload from ${endpoint}: ${cause.message}`);
        this.name = "SimulatorValidationError";
        this.issues = cause.issues;
    }
}

export interface QualyDataClientOptions {
    /** Defaults to process.env.SIMULATOR_BASE_URL. */
    baseUrl?: string;
    /** Per-request timeout; defaults to 5000 ms. */
    timeoutMs?: number;
    /** Injectable transport — unit tests pass a stub instead of doing real I/O. */
    http?: AxiosInstance;
}

export class QualyDataClient {
    private readonly http: AxiosInstance;

    constructor(options: QualyDataClientOptions = {}) {
        const baseUrl = options.baseUrl ?? process.env.SIMULATOR_BASE_URL;
        if (!baseUrl) {
            throw new SimulatorConfigError(
                "SIMULATOR_BASE_URL is not set — point it at the QualyData simulator (e.g. http://localhost:8080)",
            );
        }
        this.http =
            options.http ?? axios.create({ baseURL: baseUrl, timeout: options.timeoutMs ?? 5_000 });
    }

    private async fetch<T>(endpoint: string, schema: z.ZodType<T>, call: () => Promise<{ data: unknown }>): Promise<T> {
        let data: unknown;
        try {
            data = (await call()).data;
        } catch (error) {
            throw toQualyDataError(error, endpoint);
        }
        try {
            return schema.parse(data);
        } catch (error) {
            if (error instanceof ZodError) throw new SimulatorValidationError(endpoint, error);
            throw error;
        }
    }

    private get<T>(endpoint: string, schema: z.ZodType<T>, params?: Record<string, string | number>) {
        return this.fetch(endpoint, schema, () => this.http.get(endpoint, { params }));
    }

    private post<T>(endpoint: string, schema: z.ZodType<T>, body?: unknown) {
        return this.fetch(endpoint, schema, () => this.http.post(endpoint, body));
    }

    estado(): Promise<SimulatorState> {
        return this.get("/estado", simulatorStateSchema);
    }

    partido(): Promise<MatchInfo> {
        return this.get("/partido", matchInfoSchema);
    }

    /** Detections published after `desde` (simulated minute). */
    detecciones(desde: number): Promise<DetectionsPage> {
        return this.get("/detecciones", detectionsPageSchema, { desde });
    }

    /** Domains seen on an IP. Returns null on the API's documented 404 miss. */
    async dnsPasivoPorIp(ip: string): Promise<PassiveDnsByIp | null> {
        try {
            return await this.get("/dns-pasivo", passiveDnsByIpSchema, { ip });
        } catch (error) {
            if (error instanceof SimulatorHttpError && error.status === 404) return null;
            throw error;
        }
    }

    /** IPs that served a domain. Returns null on the API's documented 404 miss. */
    async dnsPasivoPorDominio(dominio: string): Promise<PassiveDnsByDomain | null> {
        try {
            return await this.get("/dns-pasivo", passiveDnsByDomainSchema, { dominio });
        } catch (error) {
            if (error instanceof SimulatorHttpError && error.status === 404) return null;
            throw error;
        }
    }

    juzgados(): Promise<CourtInfo> {
        return this.get("/juzgados", courtInfoSchema);
    }

    proveedores(): Promise<Provider[]> {
        return this.get("/proveedores", providerListSchema);
    }

    /** Blocking orders submitted to a provider (signed, per the simulator's HMAC rules). */
    enviarOrden(proveedorId: string, orden: BlockOrder): Promise<OrderAccepted> {
        return this.post(`/proveedores/${encodeURIComponent(proveedorId)}/ordenes`, orderAcceptedSchema, orden);
    }

    ordenes(proveedorId: string): Promise<ProviderOrder[]> {
        return this.get(
            `/proveedores/${encodeURIComponent(proveedorId)}/ordenes`,
            providerOrderSchema.array(),
        );
    }

    orden(proveedorId: string, ordenId: string): Promise<ProviderOrder> {
        return this.get(
            `/proveedores/${encodeURIComponent(proveedorId)}/ordenes/${encodeURIComponent(ordenId)}`,
            providerOrderSchema,
        );
    }

    levantarOrden(proveedorId: string, ordenId: string, body: LiftOrderRequest): Promise<ProviderOrder> {
        return this.post(
            `/proveedores/${encodeURIComponent(proveedorId)}/ordenes/${encodeURIComponent(ordenId)}/levantar`,
            providerOrderSchema,
            body,
        );
    }

    /** Claims from sites hit by a block, published after `desde` (simulated minute). */
    reclamos(desde: number): Promise<ClaimsPage> {
        return this.get("/reclamos", claimsPageSchema, { desde });
    }
}

function toQualyDataError(error: unknown, endpoint: string): unknown {
    if (isAxiosError(error)) {
        const axiosErr = error as AxiosError;
        if (axiosErr.response) {
            const parsed = apiErrorSchema.safeParse(axiosErr.response.data);
            const detail = parsed.success ? `: ${parsed.data.error}` : "";
            return new SimulatorHttpError(
                axiosErr.response.status,
                axiosErr.response.data,
                `HTTP ${axiosErr.response.status} from ${endpoint}${detail}`,
            );
        }
        return new SimulatorNetworkError(`Request to ${endpoint} failed: ${axiosErr.message}`, {
            cause: error,
        });
    }
    return error;
}
