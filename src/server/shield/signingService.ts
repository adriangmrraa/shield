import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { shiftSchema, type Shift } from "./types.js";

// HMAC contract verified against tools/desafio-futbol/simulador/servidor.py
// (source of truth, lines 31-36 and 175-177):
//   orden:    HMAC_SHA256_HEX(clave_firma_demo, "<orden_id>|<tipo>|<objetivo>|<vence_min>|<juez_id>")
//   levantar: HMAC_SHA256_HEX(clave, "LEVANTAR|<orden_id>|<juez_id>")
// Exact string with "|" separators, vence_min as integer decimal, lowercase hex,
// UTF-8 bytes. Keys load from SHIELD_SIGNING_KEYS_PATH and NEVER reach logs,
// audit, responses or exports — the emitted signature (hex) may.

const signingJudgeSchema = z.object({
    id: z.string(),
    nombre: z.string(),
    clave_firma_demo: z.string().min(1),
});
const signingCourtSchema = z.object({
    id: z.string(),
    nombre: z.string(),
    jurisdiccion: z.string(),
    jueces: z.array(signingJudgeSchema),
});
const signingFileSchema = z.object({
    juzgados: z.array(signingCourtSchema),
    turnos: z.array(shiftSchema),
});

export interface SigningJudge {
    juez_id: string;
    nombre: string;
    juzgado_id: string;
    clave: string;
}

export interface SigningBundle {
    jueces: Map<string, SigningJudge>;
    turnos: Shift[];
}

export class SigningConfigError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "SigningConfigError";
    }
}

export class UnknownJudgeError extends Error {
    readonly juezId: string;

    constructor(juezId: string) {
        super(`Unknown judge for signing: ${juezId}`);
        this.name = "UnknownJudgeError";
        this.juezId = juezId;
    }
}

const DEFAULT_KEYS_PATH = "./config/juzgados.demo.json";

export async function loadSigningBundle(
    filePath: string = process.env.SHIELD_SIGNING_KEYS_PATH ?? DEFAULT_KEYS_PATH,
): Promise<SigningBundle> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
        throw new SigningConfigError(
            `Signing keys file not readable at ${filePath} — set SHIELD_SIGNING_KEYS_PATH ` +
                `to a juzgados JSON (server-only file, never committed)`,
            { cause: error },
        );
    }
    let parsed: z.infer<typeof signingFileSchema>;
    try {
        parsed = signingFileSchema.parse(JSON.parse(raw));
    } catch (error) {
        throw new SigningConfigError(`Signing keys file at ${filePath} does not match the juzgados schema`, {
            cause: error,
        });
    }

    const jueces = new Map<string, SigningJudge>();
    for (const juzgado of parsed.juzgados) {
        for (const juez of juzgado.jueces) {
            jueces.set(juez.id, {
                juez_id: juez.id,
                nombre: juez.nombre,
                juzgado_id: juzgado.id,
                clave: juez.clave_firma_demo,
            });
        }
    }
    return { jueces, turnos: parsed.turnos };
}

export class SigningService {
    private readonly bundle: SigningBundle;

    constructor(bundle: SigningBundle) {
        this.bundle = bundle;
    }

    static async fromEnv(filePath?: string): Promise<SigningService> {
        return new SigningService(await loadSigningBundle(filePath));
    }

    turnos(): Shift[] {
        return this.bundle.turnos;
    }

    /** Judge registry WITHOUT the key — safe shape for internal lookups. */
    juez(juezId: string): Omit<SigningJudge, "clave"> {
        const juez = this.bundle.jueces.get(juezId);
        if (!juez) throw new UnknownJudgeError(juezId);
        return { juez_id: juez.juez_id, nombre: juez.nombre, juzgado_id: juez.juzgado_id };
    }

    juzgadoIdDe(juezId: string): string {
        return this.juez(juezId).juzgado_id;
    }

    listJudges(): Array<Omit<SigningJudge, "clave">> {
        return [...this.bundle.jueces.values()].map((j) => ({
            juez_id: j.juez_id,
            nombre: j.nombre,
            juzgado_id: j.juzgado_id,
        }));
    }

    /**
     * firma = HMAC_SHA256_HEX(clave, "<orden_id>|<tipo>|<objetivo>|<vence_min>|<juez_id>").
     * Input is the UNSIGNED order fields; vence_min must already be an integer.
     */
    signOrder(order: {
        orden_id: string;
        tipo: "ip" | "dominio";
        objetivo: string;
        vence_min: number;
        juez_id: string;
    }): string {
        if (!Number.isInteger(order.vence_min)) {
            throw new SigningConfigError(`vence_min must be an integer minute, got ${order.vence_min}`);
        }
        const mensaje = `${order.orden_id}|${order.tipo}|${order.objetivo}|${order.vence_min}|${order.juez_id}`;
        return this.hmac(this.juez(order.juez_id).juez_id, mensaje);
    }

    /** HMAC_SHA256_HEX(clave, "LEVANTAR|<orden_id>|<juez_id>") — spec §6. */
    signLevantar(ordenId: string, juezId: string): string {
        return this.hmac(this.juez(juezId).juez_id, `LEVANTAR|${ordenId}|${juezId}`);
    }

    /** Key lookup stays inside the service; the hex digest is all that leaves. */
    private hmac(juezId: string, mensaje: string): string {
        const juez = this.bundle.jueces.get(juezId);
        if (!juez) throw new UnknownJudgeError(juezId);
        return createHmac("sha256", juez.clave).update(mensaje, "utf8").digest("hex");
    }
}
