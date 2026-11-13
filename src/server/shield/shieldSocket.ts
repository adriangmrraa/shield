import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import type { ShieldEventBus } from "./shieldRealtime.js";

// Socket.IO gateway (S7): same HTTP server as the judicial API, JWT auth on
// handshake.auth.token (spec §12). Unauthenticated sockets are REJECTED — the
// editorial server's anonymous-dev fallback does not apply here. The path is
// /shield/socket.io so the Vite proxy can forward it to this server without
// colliding with the base app's own /socket.io.

export const SHIELD_SOCKET_PATH = "/shield/socket.io";
export const SHIELD_ROOM = "shield";

export interface ShieldSocketDeps {
    jwtSecret: string;
    bus: ShieldEventBus;
    /** Periodic `shield:metrics` snapshot source; skipped when null/absent. */
    metricsSnapshot?: (() => Promise<unknown>) | null;
    /** Metrics only flow while the run loops do (run/stop gates emissions). */
    running?: () => boolean;
    metricsIntervalMs?: number;
    corsOrigin?: string | string[] | boolean;
}

export interface ShieldSocketHandle {
    io: Server;
    close(): void;
}

export function attachShieldSocket(httpServer: HttpServer, deps: ShieldSocketDeps): ShieldSocketHandle {
    const io = new Server(httpServer, {
        path: SHIELD_SOCKET_PATH,
        cors: {
            origin: deps.corsOrigin ?? true,
            credentials: true,
        },
    });

    io.use((socket: Socket, next: (err?: Error) => void) => {
        const token = socket.handshake.auth?.token;
        if (typeof token !== "string" || token.length === 0) {
            next(new Error("UNAUTHORIZED"));
            return;
        }
        try {
            const payload = jwt.verify(token, deps.jwtSecret) as { role?: string; juez_id?: string };
            if (payload.role !== "juez") {
                next(new Error("FORBIDDEN"));
                return;
            }
            socket.data.juez_id = payload.juez_id;
            next();
        } catch {
            next(new Error("UNAUTHORIZED"));
        }
    });

    io.on("connection", (socket: Socket) => {
        void socket.join(SHIELD_ROOM);
    });

    const unsubscribe = deps.bus.onEvent((event) => {
        io.to(SHIELD_ROOM).emit(event.name, event.payload);
    });

    let metricsTimer: ReturnType<typeof setInterval> | null = null;
    if (deps.metricsSnapshot) {
        const snapshot = deps.metricsSnapshot;
        const isRunning = deps.running ?? (() => true);
        metricsTimer = setInterval(() => {
            if (!isRunning()) return;
            if (io.sockets.adapter.rooms.get(SHIELD_ROOM)?.size ?? 0) {
                void snapshot()
                    .then((report) => io.to(SHIELD_ROOM).emit("shield:metrics", report))
                    .catch(() => {});
            }
        }, deps.metricsIntervalMs ?? 5_000);
        metricsTimer.unref?.();
    }

    return {
        io,
        close() {
            if (metricsTimer) clearInterval(metricsTimer);
            unsubscribe();
            void io.close();
        },
    };
}
