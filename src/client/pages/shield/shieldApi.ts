import type { LoginResponse, ShieldJudge } from './shieldTypes';

// Judicial session + API client for /api/shield. The Shield JWT is a SEPARATE
// session from the app's editorial auth: it lives in its own localStorage slot
// and only ever authorizes the demo judicial API — never leaves to third parties.

const TOKEN_KEY = 'shield.jwt';
const JUEZ_KEY = 'shield.juez';

export function getShieldToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getShieldJuez(): ShieldJudge | null {
  try {
    const raw = localStorage.getItem(JUEZ_KEY);
    return raw ? (JSON.parse(raw) as ShieldJudge) : null;
  } catch {
    return null;
  }
}

export function saveShieldSession(result: LoginResponse): void {
  try {
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(JUEZ_KEY, JSON.stringify(result.juez));
  } catch {
    /* storage unavailable — the session simply won't persist */
  }
}

export function clearShieldSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(JUEZ_KEY);
  } catch {
    /* ignore */
  }
}

export class ShieldApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'ShieldApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * fetch wrapper for /api/shield with the judicial Bearer token. On 401 the
 * session is dropped and the caller sees UNAUTHORIZED — ShieldLayout also
 * reacts by returning to the login view.
 */
export async function shieldApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getShieldToken();
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api/shield${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
  }

  if (response.status === 401) {
    clearShieldSession();
    throw new ShieldApiError(401, 'UNAUTHORIZED', 'Sesión judicial inválida o vencida');
  }
  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : 'HTTP_ERROR';
    const detail = typeof json.detail === 'string' ? json.detail : `HTTP ${response.status}`;
    throw new ShieldApiError(response.status, code, detail);
  }
  return json as T;
}

export async function shieldLogin(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch('/api/shield/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof json.detail === 'string' ? json.detail : 'Credenciales inválidas';
    throw new ShieldApiError(response.status, 'UNAUTHORIZED', detail);
  }
  return json as unknown as LoginResponse;
}
