import { describe, expect, it } from "vitest";
import { AuditService } from "../auditService.js";
import { CaseService } from "../caseService.js";
import { buildPendienteJuezExpediente } from "../demoSeed.js";
import type { Expediente } from "../expedienteTypes.js";
import type { ShieldOrder } from "../judicialTypes.js";
import { ProviderDispatcher } from "../providerDispatcher.js";
import { SigningService } from "../signingService.js";
import { OrderStatusTracker } from "../statusTracker.js";
import { TEST_TURNOS, writeTestJuzgados } from "./judicialHarness.js";
import { memPersistence } from "./memPersistence.js";
import { FakeDispatchSim, FakeProviderBackend, makeOrder, type FakeProviderMeta } from "./providerFake.js";

// OrderStatusTracker over the servidor.py-mirror backend. Real signing (TEST
// claves) — the fake provider verifies every HMAC, so a retry signed by the
// wrong judge/key would be rejected provider-side and the test would see it.

const turnos = () => TEST_TURNOS;

const FAILA_PROVIDER: FakeProviderMeta = {
    id: "fallax",
    nombre: "ISP Que Siempre Falla",
    clientes: 10_000,
    capacidades: ["ip", "dominio"],
    demora_min: 0.5,
    tasa_falla: 1.0,
};

interface Rig {
    backend: FakeProviderBackend;
    sim: FakeDispatchSim;
    persistence: ReturnType<typeof memPersistence>;
    tracker: OrderStatusTracker;
    dispatcher: ProviderDispatcher;
    setNow: (ms: number) => void;
    /** Extra cycles — the aggregate walks the custody graph one hop per cycle. */
    pump: (n?: number) => Promise<void>;
}

async function rig(backend: FakeProviderBackend, opts: { retryDelayMs?: number } = {}): Promise<Rig> {
    const persistence = memPersistence();
    const audit = new AuditService(persistence.audit);
    const { filePath } = await writeTestJuzgados();
    const signing = await SigningService.fromEnv(filePath);
    const caseService = new CaseService({ cases: persistence.cases, evidence: persistence.evidence, audit });
    const sim = new FakeDispatchSim(backend);
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const tracker = new OrderStatusTracker({
        orders: persistence.orders,
        cases: persistence.cases,
        caseService,
        client: sim,
        signing,
        audit,
        turnos,
        retryDelayMs: opts.retryDelayMs ?? 100,
        now,
    });
    const dispatcher = new ProviderDispatcher({
        orders: persistence.orders,
        client: sim,
        audit,
        turnos,
        now,
    });
    return {
        backend,
        sim,
        persistence,
        tracker,
        dispatcher,
        setNow: (ms) => (nowMs = ms),
        pump: async (n = 3) => {
            for (let i = 0; i < n; i++) await tracker.cycleOnce();
        },
    };
}

const aprobado = (expediente_id: string, fase_key = `${expediente_id}|fase`): Expediente =>
    buildPendienteJuezExpediente({ expediente_id, fase_key, estado: "aprobado" });

describe("OrderStatusTracker — TEST 06 recibida != aplicada", () => {
    it("202 muestra recibida; solo el poll del proveedor la promueve a aplicada", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, tracker, dispatcher } = await rig(backend);
        await persistence.orders.save(makeOrder());

        await dispatcher.cycleOnce();
        let saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("recibida");
        expect(saved.aplicada_min).toBeUndefined();

        // Poll antes de que el proveedor aplique: sigue recibida.
        await tracker.cycleOnce();
        saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("recibida");
        expect(saved.aplicada_min).toBeUndefined();

        // El simulador aplica a los ~0.35-0.65 min; el poll siguiente la ve.
        backend.avanzar(11);
        await tracker.cycleOnce();
        saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("aplicada");
        expect(saved.aplicada_min).toBeGreaterThanOrEqual(10);
    });
});

describe("OrderStatusTracker — TEST 07 reintento con id y firma nuevos", () => {
    it("fallida -> retry orden_id -02 + firma nueva del mismo juez; el viejo jamás se reenvía", async () => {
        const backend = new FakeProviderBackend([FAILA_PROVIDER]);
        const { persistence, tracker, dispatcher, setNow } = await rig(backend);
        const original = makeOrder({
            orden_id: "ord-EXP-F-0001-fallax-01",
            expediente_id: "EXP-F-0001",
            proveedor_id: "fallax",
        });
        await persistence.orders.save(original);

        await dispatcher.cycleOnce();
        expect((await persistence.orders.getById(original.orden_id))!.estado).toBe("recibida");

        backend.avanzar(11); // el proveedor la marca fallida
        await tracker.cycleOnce();

        const orders = await persistence.orders.list();
        expect(orders).toHaveLength(2);
        const vieja = orders.find((o) => o.orden_id === original.orden_id)!;
        const retry = orders.find((o) => o.orden_id !== original.orden_id)!;
        expect(vieja.estado).toBe("fallida");
        expect(vieja.motivo).toContain("Error interno");
        expect(retry.orden_id).toBe("ord-EXP-F-0001-fallax-02");
        expect(retry.intento).toBe(2);
        expect(retry.estado).toBe("pendiente_envio");
        expect(retry.firma).not.toBe(original.firma);
        expect(retry.juez_id).toBe(original.juez_id);
        expect(retry.juzgado_id).toBe(original.juzgado_id);
        expect(retry.tipo).toBe(original.tipo);
        expect(retry.objetivo).toBe(original.objetivo);
        expect(persistence.audit.byEvent("orden_fallida")).toHaveLength(1);
        expect(persistence.audit.byEvent("orden_reintentada")).toHaveLength(1);
        expect(persistence.audit.byEvent("orden_reintentada")[0].datos.intento_n).toBe(2);

        // El backoff frena el envío hasta que venza proximo_intento_ms.
        setNow(5_000);
        await dispatcher.cycleOnce();
        const posts = backend.postsDe("fallax");
        expect(posts.map((p) => p.orden_id)).toEqual([original.orden_id, retry.orden_id]);
        // La firma del retry valida en el proveedor (si fuera de otro juez -> 403).
        expect((await persistence.orders.getById(retry.orden_id))!.estado).toBe("recibida");
    });

    it("reintentos acotados: máx ~4 intentos y luego el slot queda final", async () => {
        const backend = new FakeProviderBackend([FAILA_PROVIDER]);
        const { persistence, tracker, dispatcher, setNow } = await rig(backend, { retryDelayMs: 10 });
        await persistence.orders.save(
            makeOrder({ orden_id: "ord-EXP-F-0002-fallax-01", expediente_id: "EXP-F-0002", proveedor_id: "fallax" }),
        );

        // Bombea ciclos: cada intento tarda poco en fallar (demora ~0.5min sim).
        for (let ciclo = 0; ciclo < 12; ciclo++) {
            setNow(ciclo * 100);
            await dispatcher.cycleOnce();
            backend.avanzar(backend.minuto + 1);
            await tracker.cycleOnce();
        }

        const orders = await persistence.orders.list();
        const ids = orders.map((o) => o.orden_id).sort();
        expect(ids).toEqual([
            "ord-EXP-F-0002-fallax-01",
            "ord-EXP-F-0002-fallax-02",
            "ord-EXP-F-0002-fallax-03",
            "ord-EXP-F-0002-fallax-04",
        ]);
        expect(backend.postsDe("fallax")).toHaveLength(4);
        const last = orders.find((o) => o.orden_id.endsWith("-04"))!;
        expect(last.estado).toBe("fallida");
        expect(last.final).toBe(true);
        const bloqueos = persistence.audit.byEvent("orden_reintento_bloqueado");
        expect(bloqueos[bloqueos.length - 1].datos.motivo).toBe("max_intentos_alcanzado");
        expect(persistence.audit.byEvent("orden_reintentada")).toHaveLength(3); // -02, -03, -04
    });

    it("juez salió de turno antes del reintento: no se firma con el saliente, pide reaprobación", async () => {
        const backend = new FakeProviderBackend([FAILA_PROVIDER], { minuto: 45 });
        const { persistence, tracker, dispatcher } = await rig(backend);
        // Laura firma a los 45; la orden falla cuando ya rige el turno de Martín.
        await persistence.orders.save(
            makeOrder({ orden_id: "ord-EXP-F-0003-fallax-01", expediente_id: "EXP-F-0003", proveedor_id: "fallax" }),
        );
        await dispatcher.cycleOnce();
        backend.avanzar(60); // Martín de turno; la orden de Laura falla acá.
        await tracker.cycleOnce();

        const orders = await persistence.orders.list();
        expect(orders).toHaveLength(1); // cero reintentos creados
        expect(orders[0].estado).toBe("fallida");
        expect(orders[0].final).toBe(true);
        const bloqueo = persistence.audit.byEvent("orden_reintento_bloqueado");
        expect(bloqueo).toHaveLength(1);
        expect(bloqueo[0].datos.motivo).toBe("juez_fuera_de_turno_requiere_reaprobacion");
        expect(backend.postsDe("fallax")).toHaveLength(1);
    });

    it("fallida después de fin_min: nunca reintenta", async () => {
        const backend = new FakeProviderBackend([FAILA_PROVIDER], { minuto: 104 });
        const { persistence, tracker, dispatcher } = await rig(backend);
        // Martín rige el turno 50..240 — la orden suya sí puede enviarse a los 104.
        await persistence.orders.save(
            makeOrder({
                orden_id: "ord-EXP-F-0004-fallax-01",
                expediente_id: "EXP-F-0004",
                proveedor_id: "fallax",
                juez_id: "juez-martin-ejemplo",
            }),
        );
        await dispatcher.cycleOnce();
        backend.avanzar(106);
        await tracker.cycleOnce();

        expect((await persistence.orders.list())).toHaveLength(1);
        expect(persistence.audit.byEvent("orden_reintento_bloqueado")[0].datos.motivo).toBe("fin_min_alcanzado");
    });
});

describe("OrderStatusTracker — recuperación de enviada", () => {
    it("enviada sin registro remoto (POST perdido): vuelve a pendiente_envio y se reenvía", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, tracker, dispatcher } = await rig(backend);
        // Crash simulado: la orden quedó marcada enviada pero el POST nunca llegó.
        await persistence.orders.save(makeOrder({ estado: "enviada", enviada_min: 9 }));

        await tracker.cycleOnce();
        let saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("pendiente_envio");
        expect(persistence.audit.byEvent("orden_estado_recuperado")[0].datos.motivo).toBe(
            "enviada_sin_registro_remoto_reencolada",
        );

        await dispatcher.cycleOnce();
        saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("recibida");
        expect(backend.remoteOrden("aurora", saved.orden_id)?.estado).toBe("recibida");
    });
});

describe("OrderStatusTracker — TEST 12 vencimiento y gracia", () => {
    it("a fin_min el simulador vence las aplicada; a fin+5 cero ip activas", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, tracker, dispatcher } = await rig(backend);
        await persistence.orders.save(
            makeOrder({ tipo: "ip", objetivo: "203.0.113.10", orden_id: "ord-EXP-V-0001-aurora-01", expediente_id: "EXP-V-0001" }),
        );
        await dispatcher.cycleOnce();
        backend.avanzar(11);
        await tracker.cycleOnce();
        expect((await persistence.orders.list())[0].estado).toBe("aplicada");

        backend.avanzar(106); // el simulador la vence — la app solo lo observa
        await tracker.cycleOnce();
        const saved = (await persistence.orders.list())[0];
        expect(saved.estado).toBe("vencida");
        expect(saved.finalizada_min).toBe(105);

        backend.avanzar(111); // fin_min + 5 + margen
        await tracker.cycleOnce();
        expect(tracker.graceReport.verificado).toBe(true);
        expect(tracker.graceReport.ipActivas).toHaveLength(0);
    });

    it("alerta cualquier bloqueo ip residual tras la gracia", async () => {
        const backend = new FakeProviderBackend();
        const { persistence, tracker } = await rig(backend);
        const orden = makeOrder({
            tipo: "ip",
            objetivo: "203.0.113.10",
            orden_id: "ord-EXP-V-0002-aurora-01",
            expediente_id: "EXP-V-0002",
            estado: "recibida",
            enviada_min: 10,
            recibida_min: 10,
        });
        await backend.recibirOrden("aurora", { ...orden });
        backend.forceEstado("aurora", orden.orden_id, "aplicada");
        backend.minuto = 111; // post-gracia sin avanzar() — la orden sigue viva
        await persistence.orders.save(orden);

        await tracker.cycleOnce();
        expect((await persistence.orders.list())[0].estado).toBe("aplicada");
        const alertas = persistence.audit.byEvent("ip_activa_post_gracia");
        expect(alertas).toHaveLength(1);
        expect(alertas[0].datos.orden_id).toBe(orden.orden_id);
        expect(tracker.graceReport.ipActivas).toHaveLength(1);
    });
});

describe("OrderStatusTracker — agregado de expediente", () => {
    async function expedienteCon(rigged: Rig, exp: Expediente, ordenes: ShieldOrder[]) {
        await rigged.persistence.cases.save(exp);
        for (const orden of ordenes) await rigged.persistence.orders.save(orden);
    }

    it("aprobado -> distribuyendo -> parcial -> aplicado -> vencido", async () => {
        const backend = new FakeProviderBackend();
        const r = await rig(backend);
        const exp = aprobado("EXP-A-0001");
        await expedienteCon(r, exp, [
            makeOrder({ orden_id: "ord-EXP-A-0001-aurora-01", expediente_id: exp.expediente_id, proveedor_id: "aurora", tipo: "ip", objetivo: "203.0.113.10" }),
            makeOrder({ orden_id: "ord-EXP-A-0001-andina-01", expediente_id: exp.expediente_id, proveedor_id: "andina", tipo: "ip", objetivo: "203.0.113.10" }),
        ]);

        await r.dispatcher.cycleOnce();
        await r.tracker.cycleOnce();
        expect((await r.persistence.cases.getById(exp.expediente_id))!.estado).toBe("distribuyendo");

        backend.avanzar(11); // aurora aplica (~0.5min), andina aún no (~2min+)
        await r.tracker.cycleOnce();
        expect((await r.persistence.cases.getById(exp.expediente_id))!.estado).toBe("parcial");

        backend.avanzar(13);
        await r.tracker.cycleOnce();
        expect((await r.persistence.cases.getById(exp.expediente_id))!.estado).toBe("aplicado");

        backend.avanzar(106);
        await r.tracker.cycleOnce();
        expect((await r.persistence.cases.getById(exp.expediente_id))!.estado).toBe("vencido");
    });

    it("TEST 10: fases del mismo stream progresan sin cortarse entre sí", async () => {
        const backend = new FakeProviderBackend();
        const r = await rig(backend);
        const fase1 = aprobado("EXP-B-0001", "pelotaya.test|s1.pelotaya.test|203.0.113.10");
        const fase2 = aprobado("EXP-B-0002", "pelotaya.test|s2.pelotaya.test|203.0.113.11");
        await expedienteCon(r, fase1, [
            makeOrder({ orden_id: "ord-EXP-B-0001-aurora-01", expediente_id: fase1.expediente_id, objetivo: "203.0.113.10", tipo: "ip" }),
        ]);
        await expedienteCon(r, fase2, [
            makeOrder({ orden_id: "ord-EXP-B-0002-aurora-01", expediente_id: fase2.expediente_id, objetivo: "203.0.113.11", tipo: "ip" }),
        ]);

        await r.dispatcher.cycleOnce();
        backend.avanzar(11);
        await r.pump(4); // aprobado -> distribuyendo -> aplicado, un hop por ciclo

        // Ambas fases siguen su propio ciclo de vida al mismo tiempo.
        expect((await r.persistence.cases.getById(fase1.expediente_id))!.estado).toBe("aplicado");
        expect((await r.persistence.cases.getById(fase2.expediente_id))!.estado).toBe("aplicado");
        expect(backend.postsDe("aurora")).toHaveLength(2);

        // La fase 2 se desaprueba de facto si su orden vence; la 1 no se toca:
        // vencen juntas a fin_min sin que una corte a la otra.
        backend.avanzar(106);
        await r.pump(4);
        expect((await r.persistence.cases.getById(fase1.expediente_id))!.estado).toBe("vencido");
        expect((await r.persistence.cases.getById(fase2.expediente_id))!.estado).toBe("vencido");
    });

    it("slot con orden rechazada: no bloquea el 'aplicado' de las posibles", async () => {
        const backend = new FakeProviderBackend();
        const r = await rig(backend);
        const exp = aprobado("EXP-C-0001");
        await expedienteCon(r, exp, [
            makeOrder({ orden_id: "ord-EXP-C-0001-aurora-01", expediente_id: exp.expediente_id, proveedor_id: "aurora", tipo: "ip", objetivo: "203.0.113.10" }),
            // valle no acepta ip -> slot imposible desde el inicio
            makeOrder({ orden_id: "ord-EXP-C-0001-valle-01", expediente_id: exp.expediente_id, proveedor_id: "valle", tipo: "ip", objetivo: "203.0.113.10" }),
        ]);

        await r.dispatcher.cycleOnce();
        backend.avanzar(11);
        await r.pump(4);

        const expSaved = (await r.persistence.cases.getById(exp.expediente_id))!;
        expect(expSaved.estado).toBe("aplicado"); // aurora aplicada + valle rechazada = todas las posibles
        const valle = await r.persistence.orders.getById("ord-EXP-C-0001-valle-01");
        expect(valle!.estado).toBe("rechazada_proveedor");
        expect(backend.postsDe("valle")).toHaveLength(0);
    });
});

describe("OrderStatusTracker — idempotencia tras reinicio", () => {
    it("reanuda polling de órdenes vivas y no duplica reintentos", async () => {
        const backend = new FakeProviderBackend([FAILA_PROVIDER]);
        const r1 = await rig(backend);
        await r1.persistence.orders.save(
            makeOrder({ orden_id: "ord-EXP-R-0001-fallax-01", expediente_id: "EXP-R-0001", proveedor_id: "fallax" }),
        );
        await r1.dispatcher.cycleOnce();
        backend.avanzar(11);
        await r1.tracker.cycleOnce();
        expect((await r1.persistence.orders.list())).toHaveLength(2); // retry -02 creado

        // "Reinicio": nuevas instancias sobre el MISMO repo — ni re-POST ni retry duplicado.
        const audit2 = new AuditService(r1.persistence.audit);
        const { filePath } = await writeTestJuzgados();
        const signing = await SigningService.fromEnv(filePath);
        const caseService = new CaseService({ cases: r1.persistence.cases, evidence: r1.persistence.evidence, audit: audit2 });
        const sim2 = new FakeDispatchSim(backend);
        const tracker2 = new OrderStatusTracker({
            orders: r1.persistence.orders,
            cases: r1.persistence.cases,
            caseService,
            client: sim2,
            signing,
            audit: audit2,
            turnos,
            retryDelayMs: 10,
        });
        const dispatcher2 = new ProviderDispatcher({
            orders: r1.persistence.orders,
            client: sim2,
            audit: audit2,
            turnos,
        });
        await tracker2.cycleOnce();
        expect((await r1.persistence.orders.list())).toHaveLength(2); // sin duplicar retry
        const postsAntes = backend.posts.length;
        await dispatcher2.cycleOnce();
        // Solo se envía la pendiente_envio (-02); la -01 jamás vuelve a salir.
        expect(backend.posts.length - postsAntes).toBe(1);
        expect(backend.postsDe("fallax").map((p) => p.orden_id)).toEqual([
            "ord-EXP-R-0001-fallax-01",
            "ord-EXP-R-0001-fallax-02",
        ]);
    });
});
