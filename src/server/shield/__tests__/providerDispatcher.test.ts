import { describe, expect, it } from "vitest";
import { AuditService } from "../auditService.js";
import type { ShieldOrder } from "../judicialTypes.js";
import { ProviderDispatcher } from "../providerDispatcher.js";
import { TEST_TURNOS } from "./judicialHarness.js";
import { memPersistence } from "./memPersistence.js";
import { FakeDispatchSim, FakeProviderBackend, makeOrder } from "./providerFake.js";
import { SimulatorHttpError } from "../qualydataClient.js";

// ProviderDispatcher over the servidor.py-mirror backend. Orders come from a
// MemOrderRepository; the signing judge and shift table are the TEST_* fixtures.

const turnos = () => TEST_TURNOS;

function rig(backend: FakeProviderBackend) {
    const persistence = memPersistence();
    const audit = new AuditService(persistence.audit);
    const sim = new FakeDispatchSim(backend);
    const dispatcher = new ProviderDispatcher({
        orders: persistence.orders,
        client: sim,
        audit,
        turnos,
    });
    return { persistence, sim, dispatcher };
}

describe("ProviderDispatcher", () => {
    it("TEST 06 (envío): pendiente_envio -> POST -> recibida, nunca aplicada sin poll", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        const order = makeOrder();
        await persistence.orders.save(order);

        await dispatcher.cycleOnce();

        const saved = await persistence.orders.getById(order.orden_id);
        expect(saved?.estado).toBe("recibida");
        expect(saved?.enviada_min).toBe(10);
        expect(saved?.recibida_min).toBe(10);
        // recibida is NOT aplicada — only the status poll may promote it.
        expect(backend.remoteOrden("aurora", order.orden_id)?.estado).toBe("recibida");
        const posts = backend.postsDe("aurora");
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({ orden_id: order.orden_id, firma: order.firma, vence_min: 105 });
    });

    it("fan-out: órdenes de ISPs distintos salen en el mismo ciclo", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        await persistence.orders.save(makeOrder({ orden_id: "ord-EXP-T-0001-aurora-01", proveedor_id: "aurora" }));
        await persistence.orders.save(
            makeOrder({ orden_id: "ord-EXP-T-0001-andina-01", proveedor_id: "andina", tipo: "ip", objetivo: "203.0.113.10" }),
        );
        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(1);
        expect(backend.postsDe("andina")).toHaveLength(1);
    });

    it("ISP sin capacidad para el tipo: jamás recibe el POST (defensa extra)", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        // valle solo acepta dominio — una orden ip hacia valle no puede existir upstream.
        await persistence.orders.save(
            makeOrder({ orden_id: "ord-EXP-T-0001-valle-01", proveedor_id: "valle", tipo: "ip", objetivo: "203.0.113.10" }),
        );
        await dispatcher.cycleOnce();
        expect(backend.postsDe("valle")).toHaveLength(0);
        const saved = await persistence.orders.getById("ord-EXP-T-0001-valle-01");
        expect(saved?.estado).toBe("rechazada_proveedor");
        expect(saved?.motivo).toContain("tipo_no_soportado");
        expect(persistence.audit.byEvent("orden_rechazada_proveedor")).toHaveLength(1);
        // Terminal: un segundo ciclo tampoco reintenta.
        await dispatcher.cycleOnce();
        expect(backend.postsDe("valle")).toHaveLength(0);
    });

    it("vence_min distinto de fin_min actual: no se envía (la firma ya no corresponde)", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        await persistence.orders.save(makeOrder({ vence_min: 90 }));
        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(0);
        const saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("pendiente_envio");
        expect(saved.final).toBe(true);
        expect(saved.motivo).toContain("vence_distinto");
    });

    it("juez fuera de turno sin ventana restante: bloqueada_turno, jamás se envía", async () => {
        const backend = new FakeProviderBackend(undefined, { minuto: 60 }); // turno de martín
        const { persistence, dispatcher } = rig(backend);
        // Orden firmada por Laura (turno -60..50) — ya no tiene ventana dentro del partido.
        await persistence.orders.save(makeOrder({ juez_id: "jueza-laura-ficticia" }));
        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(0);
        const saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("bloqueada_turno");
        expect(saved.final).toBe(true);
        expect(persistence.audit.byEvent("orden_bloqueada_turno")).toHaveLength(1);
    });

    it("juez fuera de turno CON ventana futura: se mantiene pendiente y envía cuando entra", async () => {
        const backend = new FakeProviderBackend(undefined, { minuto: 10 }); // turno de laura
        const { persistence, dispatcher } = rig(backend);
        // Orden firmada por Martín (turno 50..240): ahora no puede enviarse, a los 50 sí.
        await persistence.orders.save(makeOrder({ juez_id: "juez-martin-ejemplo" }));
        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(0);
        expect((await persistence.orders.list())[0].estado).toBe("pendiente_envio");

        backend.avanzar(55);
        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(1);
        expect((await persistence.orders.list())[0].estado).toBe("recibida");
    });

    it("reintento programado (proximo_intento_ms futuro): no se envía antes de tiempo", async () => {
        const backend = new FakeProviderBackend();
        const persistence = memPersistence();
        const audit = new AuditService(persistence.audit);
        const sim = new FakeDispatchSim(backend);
        let nowMs = 1_000;
        const dispatcher = new ProviderDispatcher({
            orders: persistence.orders,
            client: sim,
            audit,
            turnos,
            now: () => new Date(nowMs),
        });
        await persistence.orders.save(makeOrder({ proximo_intento_ms: 5_000, intento: 2 }));
        await dispatcher.cycleOnce();
        expect(backend.posts).toHaveLength(0);

        nowMs = 6_000;
        await dispatcher.cycleOnce();
        expect(backend.posts).toHaveLength(1);
    });

    it("5xx del proveedor: queda enviada (ambiguo), nunca rechazada final", async () => {
        const backend = new FakeProviderBackend();
        const persistence = memPersistence();
        const audit = new AuditService(persistence.audit);
        const sim = new FakeDispatchSim(backend);
        // El proveedor puede haber registrado la orden upstream del gateway que
        // falló: un 500 definitivo abandonaría una orden posiblemente viva.
        const failing500 = {
            estado: () => sim.estado(),
            proveedores: () => sim.proveedores(),
            orden: (p: string, o: string) => sim.orden(p, o),
            enviarOrden: async (p: string, o: Record<string, unknown>) => {
                await backend.recibirOrden(p, o); // la orden SÍ llegó al backend
                throw new SimulatorHttpError(500, { error: "upstream exploded" }, "HTTP 500");
            },
        };
        const dispatcher = new ProviderDispatcher({ orders: persistence.orders, client: failing500, audit, turnos });
        const orden = makeOrder();
        await persistence.orders.save(orden);

        await dispatcher.cycleOnce();
        const saved = await persistence.orders.getById(orden.orden_id);
        expect(saved?.estado).toBe("enviada"); // ambiguo — el tracker reconcilia
        expect(saved?.final).toBeUndefined();
        expect(backend.remoteOrden("aurora", orden.orden_id)?.estado).toBe("recibida");
    });

    it("4xx de contrato (firma inválida): rechazada_proveedor, sin retry ciego", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        await persistence.orders.save(makeOrder({ firma: "deadbeef".repeat(8) }));
        await dispatcher.cycleOnce();
        const saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("rechazada_proveedor");
        expect(saved.motivo).toContain("Firma");
        expect(persistence.audit.byEvent("orden_rechazada_proveedor")).toHaveLength(1);

        await dispatcher.cycleOnce();
        expect(backend.postsDe("aurora")).toHaveLength(1); // nunca reintentó
    });

    it("idempotencia tras reinicio: orden recibida no vuelve a POSTear", async () => {
        const backend = new FakeProviderBackend();
        const persistence = memPersistence();
        const audit = new AuditService(persistence.audit);
        const sim = new FakeDispatchSim(backend);
        const orden = makeOrder();
        await persistence.orders.save(orden);

        const first = new ProviderDispatcher({ orders: persistence.orders, client: sim, audit, turnos });
        await first.cycleOnce();
        expect(backend.posts).toHaveLength(1);

        // "Restart": nueva instancia sobre el mismo repo persistido.
        const second = new ProviderDispatcher({ orders: persistence.orders, client: sim, audit, turnos });
        await second.cycleOnce();
        await second.cycleOnce();
        expect(backend.posts).toHaveLength(1);
    });

    it("409 duplicado: adopta el estado remoto en vez de rechazar (la orden ya estaba)", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        const orden = makeOrder();
        // El provider ya tiene esta orden (crash tras el primer POST, antes de persistir).
        await backend.recibirOrden("aurora", { ...orden });
        backend.avanzar(11); // ya aplicada del lado del simulador
        await persistence.orders.save(orden);

        await dispatcher.cycleOnce();

        const saved = await persistence.orders.getById(orden.orden_id);
        expect(saved?.estado).toBe("aplicada");
        expect(saved?.aplicada_min).toBeDefined();
        expect(persistence.audit.byEvent("orden_estado_recuperado")).toHaveLength(1);
        expect(backend.postsDe("aurora")).toHaveLength(2); // el segundo POST fue el 409
    });

    it("orders con final=true nunca se despachan", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        await persistence.orders.save(makeOrder({ final: true }));
        await dispatcher.cycleOnce();
        expect(backend.posts).toHaveLength(0);
    });
});

describe("ProviderDispatcher orden fields", () => {
    it("guarda enviada_min antes del POST y recibida_min en el 202", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, dispatcher } = rig(backend);
        const orden = makeOrder();
        await persistence.orders.save(orden);
        await dispatcher.cycleOnce();
        const saved = (await persistence.orders.list())[0] as ShieldOrder;
        expect(saved.enviada_min).toBe(10);
        expect(saved.recibida_min).toBe(10);
        expect(saved.estado).toBe("recibida");
    });
});
