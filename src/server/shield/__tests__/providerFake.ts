import { createHash, createHmac } from "node:crypto";
import type { ShieldOrder } from "../judicialTypes.js";
import { SimulatorHttpError } from "../qualydataClient.js";
import type { BlockOrder, OrderAccepted, Provider, ProviderOrder, SimulatorState } from "../types.js";
import { TEST_CLAVES, TEST_TURNOS } from "./judicialHarness.js";

// Deterministic in-memory mirror of tools/desafio-futbol/simulador/servidor.py:
// same fraccion() derivation, same validation ORDER in _validar, same order
// lifecycle in _avanzar_orden. Unit tests exercise real contract semantics —
// including deterministic failure rates and auto-expiry — without a socket.

export interface FakeProviderMeta {
    id: string;
    nombre: string;
    clientes: number;
    capacidades: ("ip" | "dominio")[];
    demora_min: number;
    tasa_falla: number;
}

export const PRACTICE_PROVIDERS: FakeProviderMeta[] = [
    { id: "aurora", nombre: "Conectividad Aurora", clientes: 3_800_000, capacidades: ["ip", "dominio"], demora_min: 0.5, tasa_falla: 0 },
    { id: "andina", nombre: "Red Andina Telecom", clientes: 1_200_000, capacidades: ["ip", "dominio"], demora_min: 2, tasa_falla: 0 },
    { id: "valle", nombre: "FibraValle", clientes: 140_000, capacidades: ["dominio"], demora_min: 6, tasa_falla: 0 },
    { id: "cumbre", nombre: "Cooperativa Cumbre", clientes: 60_000, capacidades: ["ip", "dominio"], demora_min: 3, tasa_falla: 0.35 },
];

const JUZGADO_DE_JUEZ: Record<string, { juzgado_id: string; clave: string }> = {
    "jueza-laura-ficticia": { juzgado_id: "jg-centro-3", clave: TEST_CLAVES["jueza-laura-ficticia"] },
    "juez-martin-ejemplo": { juzgado_id: "jg-norte-1", clave: TEST_CLAVES["juez-martin-ejemplo"] },
};

/** A valid signed ShieldOrder for tests — firma computed with the TEST claves. */
export function makeOrder(overrides: Partial<ShieldOrder> = {}): ShieldOrder {
    const juezId = overrides.juez_id ?? "jueza-laura-ficticia";
    const registro = JUZGADO_DE_JUEZ[juezId];
    const draft: BlockOrder = {
        orden_id: overrides.orden_id ?? "ord-EXP-T-0001-aurora-01",
        expediente_id: overrides.expediente_id ?? "EXP-T-0001",
        tipo: overrides.tipo ?? "dominio",
        objetivo: overrides.objetivo ?? "s1.pelotaya.test",
        vence_min: overrides.vence_min ?? 105,
        juzgado_id: overrides.juzgado_id ?? registro.juzgado_id,
        juez_id: juezId,
        firma: "",
    };
    draft.firma =
        overrides.firma ??
        createHmac("sha256", registro.clave)
            .update(`${draft.orden_id}|${draft.tipo}|${draft.objetivo}|${draft.vence_min}|${draft.juez_id}`, "utf8")
            .digest("hex");
    return {
        ...draft,
        proveedor_id: overrides.proveedor_id ?? "aurora",
        estado: overrides.estado ?? "pendiente_envio",
        creada_min: overrides.creada_min ?? 10,
        creada_en: overrides.creada_en ?? "2026-11-12T00:00:00.000Z",
        intento: overrides.intento,
        enviada_min: overrides.enviada_min,
        recibida_min: overrides.recibida_min,
        aplicada_min: overrides.aplicada_min,
        finalizada_min: overrides.finalizada_min,
        motivo: overrides.motivo,
        proximo_intento_ms: overrides.proximo_intento_ms,
        final: overrides.final,
    };
}

/** Exact port of servidor.py:fraccion — sha256("|".join(parts))[:8] / 2^32. */
export function fraccion(...partes: string[]): number {
    const digest = createHash("sha256").update(partes.join("|"), "utf8").digest("hex");
    return parseInt(digest.slice(0, 8), 16) / 0x100000000;
}

interface StoredOrder {
    orden_id: string;
    expediente_id: string;
    tipo: "ip" | "dominio";
    objetivo: string;
    vence_min: number;
    juzgado_id: string;
    juez_id: string;
    estado: "recibida" | "aplicada" | "fallida" | "vencida" | "levantada";
    recibida_min: number;
    aplicada_min?: number;
    finalizada_min?: number;
    motivo?: string;
    _aplica_min: number;
    _falla: boolean;
}

export interface HttpResult {
    status: number;
    body: unknown;
}

export class FakeProviderBackend {
    minuto: number;
    finMin: number;
    readonly posts: Array<{ proveedorId: string; body: Record<string, unknown> }> = [];
    private readonly ordenes = new Map<string, Map<string, StoredOrder>>();

    constructor(
        readonly providerMeta: FakeProviderMeta[] = PRACTICE_PROVIDERS,
        options: { minuto?: number; finMin?: number } = {},
    ) {
        this.minuto = options.minuto ?? 10;
        this.finMin = options.finMin ?? 105;
        for (const p of providerMeta) this.ordenes.set(p.id, new Map());
    }

    private meta(pid: string): FakeProviderMeta | undefined {
        return this.providerMeta.find((p) => p.id === pid);
    }

    /** servidor.py:recibir_orden — same checks, same order, same codes. */
    recibirOrden(pid: string, body: Record<string, unknown>): HttpResult {
        this.posts.push({ proveedorId: pid, body });
        const proveedor = this.meta(pid);
        if (!proveedor) return { status: 404, body: { error: `Proveedor desconocido: ${pid}` } };
        const store = this.ordenes.get(pid)!;
        const campos = ["orden_id", "expediente_id", "tipo", "objetivo", "vence_min", "juzgado_id", "juez_id", "firma"];
        const faltantes = campos.filter((c) => !(c in body));
        if (faltantes.length > 0) return { status: 400, body: { error: `Faltan campos: ${faltantes.join(", ")}` } };
        const ordenId = String(body.orden_id);
        if (store.has(ordenId)) return { status: 409, body: { error: "Ya existe una orden con ese orden_id en este proveedor" } };
        if (body.tipo !== "ip" && body.tipo !== "dominio") return { status: 422, body: { error: "El tipo debe ser 'ip' o 'dominio'" } };
        if (!proveedor.capacidades.includes(body.tipo as "ip" | "dominio")) {
            return { status: 422, body: { error: `${proveedor.nombre} no aplica bloqueos por ${String(body.tipo)}` } };
        }
        const vence = body.vence_min;
        if (!Number.isInteger(vence)) return { status: 422, body: { error: "vence_min debe ser un número entero de minutos de partido" } };
        if ((vence as number) <= this.minuto) return { status: 422, body: { error: "vence_min debe ser posterior al minuto actual" } };
        const registro = JUZGADO_DE_JUEZ[String(body.juez_id)];
        if (!registro) return { status: 403, body: { error: "El juez no figura en el registro de juzgados" } };
        if (registro.juzgado_id !== body.juzgado_id) return { status: 403, body: { error: "El juez no pertenece al juzgado indicado" } };
        const mensaje = `${ordenId}|${String(body.tipo)}|${String(body.objetivo)}|${String(vence)}|${String(body.juez_id)}`;
        const esperada = createHmac("sha256", registro.clave).update(mensaje, "utf8").digest("hex");
        if (esperada !== body.firma) return { status: 403, body: { error: "Firma inválida" } };

        const demora = proveedor.demora_min * (0.7 + 0.6 * fraccion(pid, ordenId, "demora"));
        const orden: StoredOrder = {
            orden_id: ordenId,
            expediente_id: String(body.expediente_id),
            tipo: body.tipo as "ip" | "dominio",
            objetivo: String(body.objetivo),
            vence_min: vence as number,
            juzgado_id: String(body.juzgado_id),
            juez_id: String(body.juez_id),
            estado: "recibida",
            recibida_min: this.minuto,
            _aplica_min: this.minuto + demora,
            _falla: fraccion(pid, ordenId, "falla") < proveedor.tasa_falla,
        };
        store.set(ordenId, orden);
        return { status: 202, body: { orden_id: ordenId, estado: "recibida", consultar: `/proveedores/${pid}/ordenes/${ordenId}` } };
    }

    verOrden(pid: string, ordenId: string): HttpResult {
        const orden = this.ordenes.get(pid)?.get(ordenId);
        if (!orden) return { status: 404, body: { error: "Orden inexistente" } };
        return { status: 200, body: vista(orden) };
    }

    verOrdenes(pid: string): HttpResult {
        const store = this.ordenes.get(pid);
        if (!store) return { status: 404, body: { error: `Proveedor desconocido: ${pid}` } };
        return { status: 200, body: [...store.values()].map(vista) };
    }

    /** servidor.py:avanzar — apply/fail on schedule, expire at vence_min. */
    avanzar(minuto?: number): void {
        if (minuto !== undefined) this.minuto = minuto;
        const ahora = this.minuto;
        for (const store of this.ordenes.values()) {
            for (const orden of store.values()) {
                if (orden.estado === "recibida" && ahora >= orden._aplica_min) {
                    if (orden._falla) {
                        orden.estado = "fallida";
                        orden.motivo = "Error interno del proveedor. Reenviar la orden con un nuevo orden_id.";
                        orden.finalizada_min = orden._aplica_min;
                    } else {
                        orden.estado = "aplicada";
                        orden.aplicada_min = orden._aplica_min;
                    }
                }
                if (orden.estado === "aplicada" && ahora >= orden.vence_min) {
                    orden.estado = "vencida";
                    orden.finalizada_min = Math.max(orden.vence_min, orden.aplicada_min ?? orden.vence_min);
                }
            }
        }
    }

    /** Test hook: force a provider-side state (e.g. keep an order applied past grace). */
    forceEstado(pid: string, ordenId: string, estado: StoredOrder["estado"]): void {
        const orden = this.ordenes.get(pid)?.get(ordenId);
        if (orden) orden.estado = estado;
    }

    /** Test hook: inspect what a provider actually holds. */
    remoteOrden(pid: string, ordenId: string): StoredOrder | undefined {
        return this.ordenes.get(pid)?.get(ordenId);
    }

    postsDe(pid: string): Array<Record<string, unknown>> {
        return this.posts.filter((p) => p.proveedorId === pid).map((p) => p.body);
    }
}

function vista(orden: StoredOrder): ProviderOrder {
    const { _aplica_min: _a, _falla: _f, ...view } = orden;
    return view as ProviderOrder;
}

/** QualyDataClient-shaped facade over the backend (throws SimulatorHttpError like the real client). */
export class FakeDispatchSim {
    constructor(readonly backend: FakeProviderBackend) {}

    estado(): Promise<SimulatorState> {
        const minuto = this.backend.minuto;
        const fin = this.backend.finMin;
        return Promise.resolve({
            partido: "test-match",
            minuto_actual: minuto,
            fin_min: fin,
            finalizado: minuto >= fin,
            acelerar: 6,
            jueces_de_turno: TEST_TURNOS.filter((t) => t.desde_min <= minuto && minuto < t.hasta_min).map((t) => t.juez_id),
        });
    }

    proveedores(): Promise<Provider[]> {
        return Promise.resolve(
            this.backend.providerMeta.map((p) => ({
                id: p.id,
                nombre: p.nombre,
                tamano: "test",
                clientes: p.clientes,
                capacidades: p.capacidades,
                ordenes: `/proveedores/${p.id}/ordenes`,
            })),
        );
    }

    async enviarOrden(proveedorId: string, orden: Record<string, unknown>): Promise<OrderAccepted> {
        const result = await this.backend.recibirOrden(proveedorId, orden as Record<string, unknown>);
        if (result.status !== 202) throw new SimulatorHttpError(result.status, result.body, `HTTP ${result.status}`);
        return result.body as OrderAccepted;
    }

    async orden(proveedorId: string, ordenId: string): Promise<ProviderOrder> {
        const result = await this.backend.verOrden(proveedorId, ordenId);
        if (result.status !== 200) throw new SimulatorHttpError(result.status, result.body, `HTTP ${result.status}`);
        return result.body as ProviderOrder;
    }

    async ordenes(proveedorId: string): Promise<ProviderOrder[]> {
        const result = await this.backend.verOrdenes(proveedorId);
        if (result.status !== 200) throw new SimulatorHttpError(result.status, result.body, `HTTP ${result.status}`);
        return result.body as ProviderOrder[];
    }
}
