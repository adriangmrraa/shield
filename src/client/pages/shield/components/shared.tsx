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
          <div>
            {title && <h2 className="text-sm font-semibold text-white/85 tracking-wide">{title}</h2>}
            {subtitle && <p className="text-xs text-white/35 mt-0.5">{subtitle}</p>}
          </div>
          {actions}
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
    <div className="py-8 flex items-center justify-center gap-3 text-sm text-white/40">
      <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
      {children}
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <div className="py-6 px-4 rounded-xl bg-red-500/8 border border-red-500/15 text-red-300 text-sm">
      {children}
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
    <span className="inline-flex items-center rounded-md bg-white/5 border border-white/10 px-1.5 py-0.5 text-[11px] font-mono text-white/70">
      {min}&prime;
    </span>
  );
}
