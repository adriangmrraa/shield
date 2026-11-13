import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPendienteJuezExpediente } from "../demoSeed.js";
import { seedUsers } from "../userSeed.js";
import {
    FakeSim,
    http,
    loginBody,
    startTestServer,
    TEST_CLAVES,
    TEST_JWT_SECRET,
    type TestServer,
} from "./judicialHarness.js";

// S4 acceptance tests over REAL HTTP (app.listen on an ephemeral port, fetch):
// login JWT, tray with can_sign, double shift check, signed orders, rejection,
// shift-change reassignment and the no-secrets invariant. The simulator clock
// is an injected FakeSim — the order path re-reads it on every decision.

let server: TestServer;

beforeAll(async () => {
    server = await startTestServer(new FakeSim());
    await seedUsers(server.persistence.users, {
        jueces: new Map([
            ["jueza-laura-ficticia", { juez_id: "jueza-laura-ficticia", nombre: "Dra. Laura", juzgado_id: "jg-centro-3", clave: TEST_CLAVES["jueza-laura-ficticia"] }],
            ["juez-martin-ejemplo", { juez_id: "juez-martin-ejemplo", nombre: "Dr. Martín", juzgado_id: "jg-norte-1", clave: TEST_CLAVES["juez-martin-ejemplo"] }],
        ]),
        turnos: [],
    });
});

afterAll(async () => {
    await server.close();
});

async function seedPending(expedienteId: string): Promise<void> {
    await server.persistence.cases.save(
        buildPendienteJuezExpediente({
            expediente_id: expedienteId,
            medidas_por_isp: [
                { proveedorId: "aurora", tipo: "dominio", objetivo: "s1.test", motivo: "dominio preferido" },
                { proveedorId: "valle", tipo: "dominio", objetivo: "s1.test", motivo: "ISP solo admite dominio" },
                { proveedorId: "soloip", tipo: null, objetivo: null, motivo: "sin medida segura disponible" },
            ],
        }),
    );
}

async function login(juezId: "jueza-laura-ficticia" | "juez-martin-ejemplo"): Promise<string> {
    const res = await http(server.base, "POST", "/auth/login", { body: loginBody(juezId) });
    expect(res.status).toBe(200);
    return res.body.token as string;
}

describe("TEST 08 — login + approve with in-shift judge", () => {
    it("wrong password -> 401, valid login -> JWT with judge claims", async () => {
        const bad = await http(server.base, "POST", "/auth/login", {
            body: loginBody("jueza-laura-ficticia", "wrong-password"),
        });
        expect(bad.status).toBe(401);

        const ok = await http(server.base, "POST", "/auth/login", { body: loginBody("jueza-laura-ficticia") });
        expect(ok.status).toBe(200);
        expect(ok.body.juez.juez_id).toBe("jueza-laura-ficticia");
        const claims = jwt.verify(ok.body.token, TEST_JWT_SECRET) as Record<string, unknown>;
        expect(claims.juez_id).toBe("jueza-laura-ficticia");
        expect(claims.juzgado_id).toBe("jg-centro-3");
        expect(claims.role).toBe("juez");
        // The hash never travels in the login response.
        expect(JSON.stringify(ok.body)).not.toContain("password_hash");
    });

    it("approve pendiente_juez -> 200 + orders with verifiable HMAC + approved_by/min persisted", async () => {
        server.sim.minuto = 10;
        await seedPending("EXP-T08-0001");
        const token = await login("jueza-laura-ficticia");

        const res = await http(server.base, "POST", "/cases/EXP-T08-0001/approve", { token, body: {} });

        expect(res.status).toBe(200);
        expect(res.body.expediente.estado).toBe("aprobado");
        expect(res.body.expediente.approved_by).toBe("jueza-laura-ficticia");
        expect(res.body.expediente.approved_min).toBe(10);

        // Two measures with tipo -> two orders; the null measure signs nothing.
        const ordenes = res.body.ordenes as Array<Record<string, unknown>>;
        expect(ordenes).toHaveLength(2);
        for (const orden of ordenes) {
            const mensaje = `${orden.orden_id}|${orden.tipo}|${orden.objetivo}|${orden.vence_min}|${orden.juez_id}`;
            const esperada = createHmac("sha256", TEST_CLAVES["jueza-laura-ficticia"]).update(mensaje, "utf8").digest("hex");
            expect(orden.firma).toBe(esperada);
            expect(orden.estado).toBe("pendiente_envio");
            expect(orden.juzgado_id).toBe("jg-centro-3");
            expect(orden.vence_min).toBe(105);
        }
        const ids = ordenes.map((o) => o.orden_id);
        expect(ids).toContain("ord-EXP-T08-0001-aurora-01");
        expect(ids).toContain("ord-EXP-T08-0001-valle-01");

        // Persisted: the case keeps the approval, orders.json has the orders.
        const stored = await server.persistence.cases.getById("EXP-T08-0001");
        expect(stored!.estado).toBe("aprobado");
        expect((await server.persistence.orders.listByExpediente("EXP-T08-0001"))).toHaveLength(2);

        // Audit: aprobado + 2 orden_compuesta events.
        const audit = await server.persistence.audit.readAll();
        const eventos = audit.map((e) => e.evento);
        expect(eventos).toContain("expediente_aprobado");
        expect(eventos.filter((e) => e === "orden_compuesta")).toHaveLength(2);
    });

    it("second approve of the same case -> 409 (state machine, not a 500)", async () => {
        const token = await login("jueza-laura-ficticia");
        const res = await http(server.base, "POST", "/cases/EXP-T08-0001/approve", { token, body: {} });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("CASE_NOT_PENDING");
    });
});

describe("TEST 08b — judge out of shift", () => {
    it("approve at minute 60 (martin's shift) by laura -> 403, zero orders, audited block", async () => {
        server.sim.minuto = 60;
        await seedPending("EXP-T08B-0001");
        const token = await login("jueza-laura-ficticia");

        const res = await http(server.base, "POST", "/cases/EXP-T08B-0001/approve", { token, body: {} });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe("OUT_OF_SHIFT");
        expect(await server.persistence.orders.listByExpediente("EXP-T08B-0001")).toHaveLength(0);
        const stored = await server.persistence.cases.getById("EXP-T08B-0001");
        expect(stored!.estado).toBe("pendiente_juez");
        expect(stored!.approved_by).toBeNull();

        const audit = await server.persistence.audit.readAll();
        const bloqueos = audit.filter((e) => e.evento === "firma_bloqueada_fuera_de_turno");
        expect(bloqueos.length).toBeGreaterThanOrEqual(1);
        expect(bloqueos.at(-1)!.datos.juez_id).toBe("jueza-laura-ficticia");
        expect(bloqueos.at(-1)!.datos.accion).toBe("approve");
    });
});

describe("TEST 09 — shift change reassigns pending cases", () => {
    it("minute 40->55: pendiente pasa a martin, laura gets 403, martin approves", async () => {
        await seedPending("EXP-T09-0001");

        // Laura's tray at minute 40: case assigned to her.
        server.sim.minuto = 40;
        const lauraToken = await login("jueza-laura-ficticia");
        const trayLaura = await http(server.base, "GET", "/cases?estado=pendiente_juez", { token: lauraToken });
        const caseLaura = (trayLaura.body.cases as Array<Record<string, unknown>>).find(
            (c) => c.expediente_id === "EXP-T09-0001",
        )!;
        expect(trayLaura.body.juez_turno_actual).toBe("jueza-laura-ficticia");
        expect(caseLaura.asignado_juez_id).toBe("jueza-laura-ficticia");
        expect(caseLaura.can_sign).toBe(true);

        // Clock crosses 50 -> martin's shift: pending case is reassigned.
        server.sim.minuto = 55;
        const trayMartin = await http(server.base, "GET", "/cases?estado=pendiente_juez", { token: lauraToken });
        const caseAfter = (trayMartin.body.cases as Array<Record<string, unknown>>).find(
            (c) => c.expediente_id === "EXP-T09-0001",
        )!;
        expect(trayMartin.body.juez_turno_actual).toBe("juez-martin-ejemplo");
        expect(caseAfter.asignado_juez_id).toBe("juez-martin-ejemplo");
        expect(caseAfter.can_sign).toBe(false); // can_sign evaluated for the CALLER (laura)

        // The outgoing judge can no longer sign.
        const blocked = await http(server.base, "POST", "/cases/EXP-T09-0001/approve", { token: lauraToken, body: {} });
        expect(blocked.status).toBe(403);

        // Reassignment was audited with motivo cambio_turno.
        const audit = await server.persistence.audit.readAll();
        const reasignaciones = audit.filter(
            (e) => e.evento === "expediente_reasignado" && e.expediente_id === "EXP-T09-0001",
        );
        expect(reasignaciones.length).toBeGreaterThanOrEqual(2); // inicial -> laura, cambio_turno -> martin
        expect(reasignaciones.at(-1)!.datos).toMatchObject({
            desde_juez: "jueza-laura-ficticia",
            hacia_juez: "juez-martin-ejemplo",
            motivo: "cambio_turno",
        });

        // The incoming judge signs normally.
        const martinToken = await login("juez-martin-ejemplo");
        const ok = await http(server.base, "POST", "/cases/EXP-T09-0001/approve", { token: martinToken, body: {} });
        expect(ok.status).toBe(200);
        expect(ok.body.expediente.approved_by).toBe("juez-martin-ejemplo");
        for (const orden of ok.body.ordenes as Array<Record<string, unknown>>) {
            const mensaje = `${orden.orden_id}|${orden.tipo}|${orden.objetivo}|${orden.vence_min}|${orden.juez_id}`;
            const esperada = createHmac("sha256", TEST_CLAVES["juez-martin-ejemplo"]).update(mensaje, "utf8").digest("hex");
            expect(orden.firma).toBe(esperada);
        }
    });
});

describe("reject — motivo persisted, zero orders", () => {
    it("reject with motivo -> rechazado + audit, no orders; without motivo -> 400", async () => {
        server.sim.minuto = 10;
        await seedPending("EXP-REJ-0001");
        const token = await login("jueza-laura-ficticia");

        const badReq = await http(server.base, "POST", "/cases/EXP-REJ-0001/reject", { token, body: {} });
        expect(badReq.status).toBe(400);

        const res = await http(server.base, "POST", "/cases/EXP-REJ-0001/reject", {
            token,
            body: { motivo: "evidencia insuficiente para medida cautelar" },
        });
        expect(res.status).toBe(200);
        expect(res.body.expediente.estado).toBe("rechazado");
        expect(res.body.expediente.reject_motivo).toBe("evidencia insuficiente para medida cautelar");
        expect(res.body.expediente.rejected_by).toBe("jueza-laura-ficticia");
        expect(res.body.ordenes).toEqual([]);
        expect(await server.persistence.orders.listByExpediente("EXP-REJ-0001")).toHaveLength(0);

        const audit = await server.persistence.audit.readAll();
        const rechazos = audit.filter((e) => e.evento === "expediente_rechazado");
        expect(rechazos.at(-1)!.expediente_id).toBe("EXP-REJ-0001");
        expect(rechazos.at(-1)!.datos.motivo).toBe("evidencia insuficiente para medida cautelar");
    });
});

describe("bandeja — auth + can_sign", () => {
    it("GET /cases without token -> 401; non-judge JWT -> 403", async () => {
        const noToken = await http(server.base, "GET", "/cases");
        expect(noToken.status).toBe(401);

        const alienToken = jwt.sign({ sub: "editor", role: "editorial" }, TEST_JWT_SECRET);
        const alien = await http(server.base, "GET", "/cases", { token: alienToken });
        expect(alien.status).toBe(403);
    });

    it("can_sign reflects the shift for the caller", async () => {
        server.sim.minuto = 10;
        await seedPending("EXP-TRAY-0001");
        const martinToken = await login("juez-martin-ejemplo");

        const tray = await http(server.base, "GET", "/cases?estado=pendiente_juez", { token: martinToken });
        expect(tray.status).toBe(200);
        const pending = tray.body.cases as Array<Record<string, unknown>>;
        const target = pending.find((c) => c.expediente_id === "EXP-TRAY-0001")!;
        // Assigned to laura (on shift); martin sees can_sign=false.
        expect(target.asignado_juez_id).toBe("jueza-laura-ficticia");
        expect(target.can_sign).toBe(false);
    });
});

describe("match finished — no signature", () => {
    it("approve after fin_min -> 422 MATCH_FINISHED (even for the judge on shift)", async () => {
        server.sim.minuto = 10;
        await seedPending("EXP-FIN-0001");
        // At minute 108 martin is on shift — only the shift-valid judge reaches the fin check.
        const martinToken = await login("juez-martin-ejemplo");
        server.sim.minuto = 108; // beyond fin_min=105 -> finalizado

        const res = await http(server.base, "POST", "/cases/EXP-FIN-0001/approve", { token: martinToken, body: {} });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe("MATCH_FINISHED");
        expect(await server.persistence.orders.listByExpediente("EXP-FIN-0001")).toHaveLength(0);
        server.sim.minuto = 10;
    });
});

describe("secrets — clave_firma_demo never leaks", () => {
    it("no response or audit entry contains a signing key", async () => {
        server.sim.minuto = 10;
        const token = await login("jueza-laura-ficticia");
        const claves = Object.values(TEST_CLAVES) as string[];

        for (const path of ["/cases", "/audit?n=200", "/orders", "/status", "/metrics"]) {
            const res = await http(server.base, "GET", path, { token });
            expect(res.status).toBe(200);
            const serialized = JSON.stringify(res.body);
            for (const clave of claves) expect(serialized).not.toContain(clave);
        }

        const auditSerialized = JSON.stringify(await server.persistence.audit.readAll());
        const usersSerialized = JSON.stringify(await server.persistence.users.list());
        const ordersSerialized = JSON.stringify(await server.persistence.orders.list());
        for (const clave of claves) {
            expect(auditSerialized).not.toContain(clave);
            expect(usersSerialized).not.toContain(clave);
            expect(ordersSerialized).not.toContain(clave);
        }
    });
});
