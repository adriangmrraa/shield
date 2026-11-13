import type { LucideIcon } from 'lucide-react';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

// Small layout primitives shared by the four shield views. Visual language
// follows the app's design system (glass cards on void, cyan accents) while
// the copy stays sober judicial Spanish.

export function ShieldCard({ title, subtitle, children, actions }: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="glass-card-static p-5 relative overflow-hidden">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-white/85 tracking-wide">{title}</h2>}
            {subtitle && <p className="text-xs text-white/35 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-white/30">{children}</div>;
}

export function LoadingState({ children = 'Cargando…' }: { children?: ReactNode }) {
  return (
    <div className="py-8 flex items-center justify-center gap-3 text-sm text-white/40" role="status" aria-live="polite">
      <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" aria-hidden />
      {children}
    </div>
  );
}

/** Skeleton rows for lists still fetching — keeps layout stable, no spinner churn. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite" aria-label="Cargando">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-lg border border-white/5 bg-white/2 px-3 py-2.5 animate-pulse" style={{ animationDelay: `${i * 90}ms` }}>
          <div className="flex items-center gap-2">
            <div className="h-4 w-14 rounded bg-white/8" />
            <div className="h-4 w-24 rounded bg-white/8" />
            <div className="ml-auto h-4 w-16 rounded bg-white/8" />
          </div>
          <div className="mt-2 h-3 w-3/4 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <div className="py-6 px-4 rounded-xl bg-red-500/8 border border-red-500/15 text-red-300 text-sm" role="alert">
      {children}
    </div>
  );
}

/** Small chip used in card headers when a resource keeps stale data after a fetch error. */
export function StaleWarning({ hint }: { hint: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
      title={hint}
      role="status"
    >
      <AlertTriangle className="w-3 h-3" aria-hidden />
      Datos desactualizados
    </span>
  );
}

/** Headline metric tile shared by monitor and metrics views. */
export function StatCard({ label, value, hint, icon: Icon, accent = 'text-white' }: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  accent?: string;
}) {
  return (
    <div className="glass-card-static p-4">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="w-3 h-3 text-white/25" aria-hidden />}
        <p className="text-[10px] uppercase tracking-wider text-white/30">{label}</p>
      </div>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${accent}`}>{value}</p>
      {hint && <p className="text-[11px] text-white/30 mt-0.5">{hint}</p>}
    </div>
  );
}

/** Wire rule: never render a full signature — always the 12-char display form. */
export function Firma({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-white/25">—</span>;
  return (
    <code className="text-[11px] text-white/50 font-mono" title="Firma HMAC truncada (12 hex)">
      {value.slice(0, 12)}…
    </code>
  );
}

// Keys whose values are long digests/secrets — the console only ever shows the
// truncated form (same rule as `Firma`), even inside audit payloads.
const SECRETISH_AUDIT_KEY = /firma|clave|password|secret|token|b64|sha/i;

/**
 * Renders an audit `datos` payload for a human reader: short values verbatim,
 * digest/secret-ish values truncated to 12 chars, objects compact-JSON'd.
 */
export function formatAuditDatos(datos: Record<string, unknown>, maxEntries = Infinity): string {
  return Object.entries(datos)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, maxEntries)
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null) return `${k}: ${JSON.stringify(v)}`;
      const s = String(v);
      if (SECRETISH_AUDIT_KEY.test(k) && s.length > 16) return `${k}: ${s.slice(0, 12)}…`;
      return `${k}: ${s}`;
    })
    .join(' · ');
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-white/30 mb-0.5">{label}</dt>
      <dd className="text-sm text-white/80 break-words">{children}</dd>
    </div>
  );
}

export function MinutoChip({ min }: { min: number | null | undefined }) {
  if (min === null || min === undefined) return <span className="text-white/25">—</span>;
  return (
    <span className="inline-flex items-center rounded-md bg-white/5 border border-white/10 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-white/70">
      {min}&prime;
    </span>
  );
}
