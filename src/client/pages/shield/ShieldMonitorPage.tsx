import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Square } from 'lucide-react';
import { shieldApi } from './shieldApi';
import { useShield } from './ShieldContext';
import { useShieldLive } from './useShieldSocket';
import { OrderStateBadge } from './components/badges';
import { EmptyState, ErrorState, LoadingState, MinutoChip, ShieldCard } from './components/shared';
import type { AuditEntry, DetectionsResponse, ShieldOrder, ShieldStatus } from './shieldTypes';

// VISTA 1 — Centro de operaciones (spec §13): live match clock, incoming
// detections with their verification outcome, order feed per ISP, run
// start/stop and live counters. Socket-driven with 5s polling fallback.

const MONITOR_EVENTS = ['shield:tick', 'shield:detection', 'shield:case', 'shield:order', 'shield:audit'];

export function ShieldMonitorPage() {
  const { socket, connected } = useShield();
  const status = useShieldLive<ShieldStatus>(socket, connected, MONITOR_EVENTS, () => shieldApi<ShieldStatus>('/status'));
  const detections = useShieldLive<DetectionsResponse>(socket, connected, MONITOR_EVENTS, () =>
    shieldApi<DetectionsResponse>('/detections'),
  );
  const orders = useShieldLive<{ orders: ShieldOrder[] }>(socket, connected, MONITOR_EVENTS, () =>
    shieldApi<{ orders: ShieldOrder[] }>('/orders'),
  );
  const audit = useShieldLive<{ entries: AuditEntry[] }>(socket, connected, ['shield:audit'], () =>
    shieldApi<{ entries: AuditEntry[] }>('/audit?n=30'),
  );

  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const reloj = status.data?.reloj ?? null;
  const contadores = status.data?.contadores;
  const running = status.data?.orchestrator.running ?? false;
  const veredictos = verdictMap(audit.data?.entries ?? []);

  const setRun = async (start: boolean) => {
    setRunBusy(true);
    setRunError(null);
    try {
      await shieldApi(`/run/${start ? 'start' : 'stop'}`, { method: 'POST' });
      await status.reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'No se pudo cambiar el estado del run');
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Monitor en vivo</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Detecciones, verificación y órdenes en tiempo real durante el partido simulado.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              onClick={() => void setRun(false)}
              disabled={runBusy}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Square className="w-3.5 h-3.5" /> Frenar run
            </button>
          ) : (
            <button
              onClick={() => void setRun(true)}
              disabled={runBusy}
              className="btn-primary flex items-center gap-1.5 px-3.5 py-2 text-sm"
            >
              <Play className="w-3.5 h-3.5" /> Iniciar run
            </button>
          )}
        </div>
      </div>

      {runError && <ErrorState>{runError}</ErrorState>}
      {status.error && <ErrorState>{status.error}</ErrorState>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Minuto de partido" value={reloj ? `${reloj.minuto_actual}` : '—'} hint={reloj ? `fin ${reloj.fin_min} · x${reloj.acelerar}` : 'simulador sin conexión'} accent={reloj?.finalizado ? 'text-zinc-300' : 'text-cyan-300'} />
        <StatCard label="Detecciones vistas" value={contadores?.detecciones_vistas ?? '—'} hint="deduplicadas por el poller" />
        <StatCard label="Expedientes" value={sumValues(contadores?.casos_por_estado)} hint={contadores ? estadoHint(contadores.casos_por_estado, 'pendiente_juez') : undefined} />
        <StatCard label="Órdenes" value={sumValues(contadores?.ordenes_por_estado)} hint={contadores ? estadoHint(contadores.ordenes_por_estado, 'aplicada') : undefined} />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <ShieldCard title="Feed de detecciones" subtitle="Últimas del simulador con veredicto del motor">
          {detections.loading && !detections.data ? (
            <LoadingState />
          ) : (detections.data?.detecciones.length ?? 0) === 0 ? (
            <EmptyState>Sin detecciones todavía — iniciá el run para comenzar el feed.</EmptyState>
          ) : (
            <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {[...(detections.data?.detecciones ?? [])].reverse().map((d) => (
                <li key={d.id} className="rounded-lg border border-white/5 bg-white/2 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <MinutoChip min={d.minuto} />
                    <code className="font-mono text-cyan-300/90">{d.id}</code>
                    {veredictos.get(d.id) && (
                      <span className="text-white/40">veredicto: {veredictos.get(d.id)}</span>
                    )}
                    {d.expediente_id ? (
                      <Link to={`/shield/cases/${d.expediente_id}`} className="ml-auto text-cyan-400 hover:text-cyan-300 font-mono">
                        {d.expediente_id}
                      </Link>
                    ) : (
                      <span className="ml-auto text-white/30">sin expediente</span>
                    )}
                  </div>
                  <div className="mt-1 text-white/45 truncate">{d.pagina}</div>
                  <div className="text-white/30 font-mono truncate">{d.host_stream} · {d.ip_servidor}</div>
                </li>
              ))}
            </ul>
          )}
        </ShieldCard>

        <ShieldCard title="Órdenes por ISP" subtitle="Estado reportado por el proveedor">
          {orders.loading && !orders.data ? (
            <LoadingState />
          ) : (orders.data?.orders.length ?? 0) === 0 ? (
            <EmptyState>Ninguna orden compuesta todavía.</EmptyState>
          ) : (
            <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {[...(orders.data?.orders ?? [])]
                .sort((a, b) => b.creada_min - a.creada_min || b.orden_id.localeCompare(a.orden_id))
                .map((o) => (
                  <li key={o.orden_id} className="rounded-lg border border-white/5 bg-white/2 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-white/75">{o.proveedor_id}</span>
                      <OrderStateBadge estado={o.estado} />
                      {o.intento !== undefined && o.intento > 1 && (
                        <span className="text-amber-300/80">intento {o.intento}</span>
                      )}
                      <Link to={`/shield/cases/${o.expediente_id}`} className="ml-auto text-cyan-400 hover:text-cyan-300 font-mono">
                        {o.expediente_id}
                      </Link>
                    </div>
                    <div className="mt-1 text-white/45 font-mono">
                      {o.tipo} → {o.objetivo} <span className="text-white/25">(vence {o.vence_min}&prime;)</span>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </ShieldCard>
      </div>

      <ShieldCard title="Eventos recientes" subtitle="Cola de auditoría en vivo (append-only)">
        {(audit.data?.entries.length ?? 0) === 0 ? (
          <EmptyState>Sin eventos auditados todavía.</EmptyState>
        ) : (
          <ul className="space-y-1 max-h-[300px] overflow-y-auto pr-1">
            {[...(audit.data?.entries ?? [])].reverse().map((e) => (
              <li key={e.seq} className="flex items-baseline gap-3 text-xs py-1 border-b border-white/3 last:border-0">
                <span className="text-white/25 font-mono w-10 shrink-0">#{e.seq}</span>
                <MinutoChip min={e.min_sim} />
                <span className="text-white/70 font-medium">{e.evento}</span>
                {e.expediente_id && (
                  <Link to={`/shield/cases/${e.expediente_id}`} className="text-cyan-400/80 hover:text-cyan-300 font-mono">
                    {e.expediente_id}
                  </Link>
                )}
                <span className="ml-auto text-white/25 font-mono">{new Date(e.ts_iso).toLocaleTimeString('es-AR')}</span>
              </li>
            ))}
          </ul>
        )}
      </ShieldCard>
    </div>
  );
}

function StatCard({ label, value, hint, accent = 'text-white' }: { label: string; value: string | number; hint?: string; accent?: string }) {
  return (
    <div className="glass-card-static p-4">
      <p className="text-[10px] uppercase tracking-wider text-white/30">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent}`}>{value}</p>
      {hint && <p className="text-[11px] text-white/30 mt-0.5">{hint}</p>}
    </div>
  );
}

function sumValues(record: Record<string, number> | undefined): number | string {
  if (!record) return '—';
  return Object.values(record).reduce((a, b) => a + b, 0);
}

function estadoHint(record: Record<string, number>, key: string): string | undefined {
  const n = record[key];
  return n ? `${n} ${key}` : undefined;
}

/** deteccion_id -> verdict, rebuilt from audit entries (detection_verificada). */
function verdictMap(entries: AuditEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.evento === 'detection_verificada') {
      const detId = e.datos?.deteccion_id;
      const verdict = e.datos?.verdict;
      if (typeof detId === 'string' && typeof verdict === 'string') map.set(detId, verdict);
    }
    if (e.evento === 'detection_descartada') {
      const detId = e.datos?.deteccion_id;
      if (typeof detId === 'string') map.set(detId, 'descartada');
    }
  }
  return map;
}
