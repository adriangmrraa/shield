import { AlertTriangle } from 'lucide-react';

// Spec §13: the simulated environment must be unmistakable on EVERY shield
// view — a fixed, high-contrast strip that no theme can wash out.
export function SimBanner() {
  return (
    <div
      data-testid="sim-banner"
      className="shrink-0 w-full bg-amber-400 text-amber-950 border-b-2 border-amber-600 px-4 py-1.5 flex items-center justify-center gap-2 select-none"
      role="alert"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
      <span className="text-xs sm:text-sm font-bold tracking-[0.2em] uppercase">
        Entorno simulado — Datos ficticios
      </span>
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
    </div>
  );
}
