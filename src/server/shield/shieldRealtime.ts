import { EventEmitter } from "node:events";
import type { DetectionStore } from "./detectionPoller.js";
import type { AuditEntry, AuditEventRecord, AuditLogWriter, ShieldPersistence } from "./persistence/types.js";

// Realtime bridge (S7): every domain fact already flows through two funnels —
// the append-only audit writer (all case/order/detection/decision events) and
// the poller's saveCursor (the sim clock). Instrumenting those two persistence
// edges feeds Socket.IO without duplicating any domain logic; run/stop stops
// emissions naturally because the loops stop writing.

/** Socket event emitted to authenticated judicial clients (room "shield"). */
export interface ShieldRealtimeEvent {
    name: string;
    payload: Record<string, unknown>;
}

export class ShieldEventBus extends EventEmitter {
    static readonly CHANNEL = "shield-event";

    publish(event: ShieldRealtimeEvent): void {
        this.emit(ShieldEventBus.CHANNEL, event);
    }

    onEvent(listener: (event: ShieldRealtimeEvent) => void): () => void {
        this.on(ShieldEventBus.CHANNEL, listener);
        return () => this.off(ShieldEventBus.CHANNEL, listener);
    }
}

const SECRETISH_KEY = /firma|clave|password|secret|token|b64/i;

/**
 * Custody invariant over the wire: socket payloads never carry full signatures,
 * signing keys or capture bytes. `firma` is truncated to 12 hex chars (the
 * display form the UI is allowed to show); anything else secret-ish is dropped.
 */
export function sanitizeForWire(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeForWire);
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            if (key === "firma" && typeof inner === "string") {
                out[key] = inner.slice(0, 12);
                continue;
            }
            if (SECRETISH_KEY.test(key)) continue;
            out[key] = sanitizeForWire(inner);
        }
        return out;
    }
    return value;
}

/** audit evento -> granular socket name (spec §12) + coarse channel. */
const EVENTO_TO_SOCKET: Record<string, { name: string; kind: string }> = {
    detection_recibida: { name: "shield:detection", kind: "recibida" },
    detection_verificada: { name: "shield:detection", kind: "verificada" },
    detection_descartada: { name: "shield:detection", kind: "descartada" },
    detection_error: { name: "shield:detection", kind: "error" },
    expediente_creado: { name: "shield:case-created", kind: "created" },
    expediente_actualizado: { name: "shield:case", kind: "updated" },
    expediente_descartado: { name: "shield:case", kind: "descartado" },
    transicion_estado: { name: "shield:case", kind: "transition" },
    expediente_reasignado: { name: "shield:judge-turn-changed", kind: "reasignado" },
    expediente_aprobado: { name: "shield:case-ready", kind: "approved" },
    expediente_rechazado: { name: "shield:case-rejected", kind: "rejected" },
    orden_compuesta: { name: "shield:order", kind: "compuesta" },
    orden_despachada: { name: "shield:order", kind: "despachada" },
    orden_recibida: { name: "shield:order-received", kind: "recibida" },
    orden_aplicada: { name: "shield:order-applied", kind: "aplicada" },
    orden_fallida: { name: "shield:order-failed", kind: "fallida" },
    orden_reintentada: { name: "shield:order", kind: "reintentada" },
    orden_reintento_bloqueado: { name: "shield:order", kind: "reintento_bloqueado" },
    orden_rechazada_proveedor: { name: "shield:order", kind: "rechazada_proveedor" },
    orden_bloqueada_turno: { name: "shield:order", kind: "bloqueada_turno" },
    orden_no_despachada: { name: "shield:order", kind: "no_despachada" },
    orden_vencida: { name: "shield:order-expired", kind: "vencida" },
    orden_levantada: { name: "shield:order", kind: "levantada" },
    orden_estado_recuperado: { name: "shield:order", kind: "estado_recuperado" },
    firma_bloqueada_fuera_de_turno: { name: "shield:order", kind: "firma_bloqueada" },
    ip_activa_post_gracia: { name: "shield:order", kind: "ip_activa_post_gracia" },
};

const GENERIC_NAME: Record<string, string> = {
    "shield:detection": "shield:detection",
    "shield:case-created": "shield:case",
    "shield:case-ready": "shield:case",
    "shield:case-rejected": "shield:case",
    "shield:judge-turn-changed": "shield:case",
    "shield:order-received": "shield:order",
    "shield:order-applied": "shield:order",
    "shield:order-failed": "shield:order",
    "shield:order-expired": "shield:order",
};

function emitEntry(bus: ShieldEventBus, entry: AuditEntry): void {
    const sanitized = sanitizeForWire(entry) as AuditEntry;
    const mapped = EVENTO_TO_SOCKET[entry.evento];
    if (mapped) {
        const payload = { kind: mapped.kind, ...sanitized };
        bus.publish({ name: mapped.name, payload });
        // Coarse channel (`shield:case`, `shield:order`): one listener refreshes
        // a whole family of views without subscribing to every lifecycle alias.
        const generic = GENERIC_NAME[mapped.name];
        if (generic && generic !== mapped.name) bus.publish({ name: generic, payload });
    }
    // Raw audit stream: the monitor/metrics views render the log verbatim.
    bus.publish({ name: "shield:audit", payload: { ...sanitized } });
}

const instrumented = new WeakSet<ShieldPersistence>();

/**
 * Wraps `persistence.audit` and `persistence.detections` so every append and
 * every cursor advance publishes socket events on `bus`. Idempotent per
 * persistence bundle — services must be built AFTER this call.
 */
export function instrumentPersistence(persistence: ShieldPersistence, bus: ShieldEventBus): void {
    if (instrumented.has(persistence)) return;
    instrumented.add(persistence);

    const audit = persistence.audit;
    persistence.audit = {
        append: async (record: AuditEventRecord): Promise<AuditEntry> => {
            const entry = await audit.append(record);
            emitEntry(bus, entry);
            return entry;
        },
        tail: (n) => audit.tail(n),
        readAll: () => audit.readAll(),
    };

    const detections = persistence.detections;
    let lastTick: number | null = null;
    persistence.detections = {
        getCursor: () => detections.getCursor(),
        saveCursor: async (minute: number) => {
            await detections.saveCursor(minute);
            if (minute !== lastTick) {
                lastTick = minute;
                bus.publish({ name: "shield:tick", payload: { minuto: minute } });
            }
        },
        hasSeen: (id) => detections.hasSeen(id),
        markSeen: (id) => detections.markSeen(id),
        ...(detections.seenIds ? { seenIds: () => detections.seenIds!() } : {}),
    };
}
