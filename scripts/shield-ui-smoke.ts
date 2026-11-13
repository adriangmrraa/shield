import { io as ioClient } from "socket.io-client";

// S7 UI smoke (brief §Gates): verifies the real wiring end-to-end —
//   1. /api/shield-health answers on the shield dev server
//   2. judge login returns a JWT over the real API
//   3. authenticated /status answers
//   4. Socket.IO handshake on /shield/socket.io connects WITH the JWT and is
//      REJECTED without it
//   5. the Vite-served UI answers HTML on /shield
//
// Expected surroundings: simulator on :8080 (PYTHONUTF8=1, --acelerar 6),
// `npm run shield:seed`, `npm run shield:dev` and `npm run dev` (o vite preview).
// Run: `npx tsx scripts/shield-ui-smoke.ts`

const API = process.env.SHIELD_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const UI = process.env.SHIELD_UI_URL ?? "http://localhost:5173";
const USERNAME = process.env.SHIELD_SMOKE_USER ?? "jueza-laura-ficticia";
const PASSWORD = process.env.SHIELD_DEMO_PASSWORD ?? `demo-${USERNAME}-2026`;
const SOCKET_PATH = "/shield/socket.io";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
    console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
    if (!cond) failures += 1;
};

async function getJson(path: string, token?: string): Promise<{ status: number; body: Record<string, any> }> {
    const res = await fetch(`${API}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function socketConnect(token?: string): Promise<{ connected: boolean; error?: string }> {
    return new Promise((resolve) => {
        const socket = ioClient(API, {
            path: SOCKET_PATH,
            auth: token ? { token } : {},
            transports: ["websocket", "polling"],
            forceNew: true,
            reconnection: false,
            timeout: 4_000,
        });
        const done = (connected: boolean, error?: string) => {
            socket.close();
            resolve({ connected, error });
        };
        socket.once("connect", () => done(true));
        socket.once("connect_error", (err) => done(false, err.message));
    });
}

async function main(): Promise<void> {
    console.log(`[smoke-ui] API=${API} UI=${UI} juez=${USERNAME}`);

    console.log("\n1) shield dev server");
    const health = await getJson("/api/shield-health");
    ok(health.status === 200 && health.body.ok === true, `GET /api/shield-health -> ${health.status}`);

    console.log("\n2) login judicial real");
    const loginRes = await fetch(`${API}/api/shield/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const loginBody = (await loginRes.json().catch(() => ({}))) as Record<string, any>;
    const token = typeof loginBody.token === "string" ? loginBody.token : undefined;
    ok(loginRes.status === 200 && token !== undefined, `POST /auth/login -> ${loginRes.status} (jwt=${token ? "ok" : "NO"})`);
    ok(loginBody.juez?.juez_id === USERNAME, `juez en respuesta: ${loginBody.juez?.juez_id ?? "?"}`);

    if (token) {
        console.log("\n3) /status autenticado");
        const status = await getJson("/api/shield/status", token);
        ok(status.status === 200, `GET /status -> ${status.status}`);
        ok("contadores" in status.body && "orchestrator" in status.body, "payload tiene contadores + orchestrator");
        const statusAnon = await getJson("/api/shield/status");
        ok(statusAnon.status === 401, `GET /status sin token -> ${statusAnon.status} (401 esperado)`);
    }

    console.log("\n4) Socket.IO /shield/socket.io");
    const noToken = await socketConnect();
    ok(!noToken.connected, `sin token -> rechazado (${noToken.error ?? "sin connect"})`);
    if (token) {
        const withToken = await socketConnect(token);
        ok(withToken.connected, `con JWT -> conecta (${withToken.error ?? "ok"})`);
    }

    console.log("\n5) UI /shield");
    const uiRes = await fetch(`${UI}/shield`);
    const html = await uiRes.text();
    ok(uiRes.status === 200 && html.includes('id="root"'), `GET ${UI}/shield -> ${uiRes.status} HTML app shell`);

    console.log(failures === 0 ? "\n[smoke-ui] TODO VERDE" : `\n[smoke-ui] ${failures} fallas`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error("[smoke-ui] error fatal:", error);
    process.exit(1);
});
