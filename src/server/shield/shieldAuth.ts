import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuditService } from "./auditService.js";
import { JUEZ_ROLE, publicUser, type JudicialIdentity, type ShieldUser } from "./judicialTypes.js";
import type { UserRepository } from "./persistence/types.js";

// Judicial session (spec §9): bcrypt-verified login issues a JWT whose claims
// bind the judge identity. The effective juez_id for every decision comes from
// the VALIDATED token — never from request bodies or client-supplied claims.

export const JWT_EXPIRES_IN_SECONDS = 8 * 60 * 60; // ~8h per brief

export class AuthConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuthConfigError";
    }
}

const judgeClaimsSchema = z.object({
    sub: z.string(),
    juez_id: z.string(),
    juzgado_id: z.string(),
    role: z.literal(JUEZ_ROLE),
});
type JudgeClaims = z.infer<typeof judgeClaimsSchema>;

/** Resolves the JWT secret; missing secret is a startup config error, not a runtime one. */
export function requireJwtSecret(secret: string | undefined = process.env.JWT_SECRET): string {
    if (!secret) {
        throw new AuthConfigError("JWT_SECRET is not set — judicial sessions cannot be issued without it");
    }
    return secret;
}

export interface LoginResult {
    token: string;
    expires_in: number;
    juez: Omit<ShieldUser, "password_hash">;
}

export class ShieldAuthService {
    private readonly users: UserRepository;
    private readonly audit: AuditService;
    private readonly secret: string;
    private readonly expiresInSeconds: number;

    constructor(deps: {
        users: UserRepository;
        audit: AuditService;
        jwtSecret: string;
        expiresInSeconds?: number;
    }) {
        this.users = deps.users;
        this.audit = deps.audit;
        this.secret = deps.jwtSecret;
        this.expiresInSeconds = deps.expiresInSeconds ?? JWT_EXPIRES_IN_SECONDS;
    }

    /** null on bad credentials — callers map it to a generic 401 (no user enumeration). */
    async login(username: string, password: string): Promise<LoginResult | null> {
        const user = await this.users.getByUsername(username);
        const ok = user !== null && (await bcrypt.compare(password, user.password_hash));
        if (!ok || user === null) {
            await this.audit
                .append({
                    evento: "auth_login_rechazado",
                    minSim: null,
                    correlationId: `auth:${username}`,
                    datos: { username },
                })
                .catch(() => {});
            return null;
        }
        const claims: JudgeClaims = {
            sub: user.username,
            juez_id: user.juez_id,
            juzgado_id: user.juzgado_id,
            role: JUEZ_ROLE,
        };
        const token = jwt.sign(claims, this.secret, { expiresIn: this.expiresInSeconds });
        await this.audit
            .append({
                evento: "auth_login",
                minSim: null,
                correlationId: `auth:${username}`,
                datos: { username, juez_id: user.juez_id, juzgado_id: user.juzgado_id },
            })
            .catch(() => {});
        return { token, expires_in: this.expiresInSeconds, juez: publicUser(user) };
    }
}

declare module "express-serve-static-core" {
    interface Request {
        juez?: JudicialIdentity;
    }
}

/**
 * Validates Bearer JWT + role 'juez'. On success the token's claims become the
 * trusted judicial identity on req.juez; anything else -> 401/403, no fallback.
 */
export function requireJudge(jwtSecret: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const header = req.headers.authorization;
        const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
        if (!token) {
            res.status(401).json({ error: "UNAUTHORIZED", detail: "Bearer token requerido" });
            return;
        }
        let payload: unknown;
        try {
            payload = jwt.verify(token, jwtSecret);
        } catch {
            res.status(401).json({ error: "UNAUTHORIZED", detail: "Token inválido o vencido" });
            return;
        }
        const claims = judgeClaimsSchema.safeParse(payload);
        if (!claims.success) {
            // Valid JWT but not a judicial identity — authenticated, not authorized.
            res.status(403).json({ error: "FORBIDDEN", detail: "El token no tiene rol de juez" });
            return;
        }
        req.juez = {
            juez_id: claims.data.juez_id,
            juzgado_id: claims.data.juzgado_id,
            role: claims.data.role,
        };
        next();
    };
}
