import { shieldApi } from './shieldApi';
import { useShield } from './ShieldContext';
import { useShieldLive } from './useShieldSocket';
import { CaseStateBadge, OrderStateBadge, TipoBadge } from './components/badges';
import { EmptyState, ErrorState, LoadingState, MinutoChip, ShieldCard } from './components/shared';
import type { AuditEntry, MetricsReport } from './shieldTypes';

// VISTA 4 — Métricas y auditoría (spec §10, §13): per-ISP counters, client-
// weighted coverage (vigente vs alcanzada — never conflate them), audit event
// counters and the tail of the append-only log.

const METRICS_EVENTS = ['shield:metrics', 'shield:order', 'shield:case', 'shield:audit', 'shield:tick'];

export function ShieldMetricsPage() {
  const { socket, connected } = useShield();
  const metrics = useShieldLive<MetricsReport>(socket, connected, METRICS_EVENTS, () =>
    shieldApi<MetricsReport>('/metrics'),
  );
  const audit = useShieldLive<{ entries: AuditEntry[] }>(socket, connected, METRICS_EVENTS, () =>
    shieldApi<{ entries: AuditEntry[] }>('/audit?n=40'),
  );

  const report = metrics.data;
  const isp = report?.isp ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-white">Métricas y auditoría</h1>
        <p className="text-xs text-white/35 mt-0.5">
          Cobertura ponderada por clientes del ISP, contadores por evento y la cola de auditoría append-only.
        </p>
      </div>

      {metrics.error && <ErrorState>{metrics.error}</ErrorState>}
      {metrics.loading && !report && <LoadingState />}

      {isp && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Cobertura vigente"
            value={`${isp.cobertura.cobertura_ponderada_pct.toFixed(1)}%`}
            hint="órdenes aplicadas ahora"
            accent="text-emerald-300"
          />
          <StatCard
            label="Cobertura alcanzada"
            value={`${isp.cobertura.cobertura_alcanzada_ponderada_pct.toFixed(1)}%`}
            hint="aplicada en algún momento (incl. vencidas)"
            accent="text-cyan-300"
          />
          <StatCard label="Clientes totales ISP" value={isp.cobertura.clientes_totales} hint="peso de la cobertura" />
          <StatCard label="Expedientes evaluados" value={isp.cobertura.por_expediente.length} hint="con distribución iniciada" />
        </div>
      )}

      <ShieldCard title="Métricas por ISP" subtitle="Enviadas cuentan intentos al cable; slots son objetivos (expediente, proveedor)">
        {!isp || isp.por_isp.length === 0 ? (
          <EmptyState>{isp === null ? 'Sin simulador conectado — métricas de ISP no disponibles.' : 'Sin proveedores.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-white/30 uppercase tracking-wider text-[10px] border-b border-white/8">
                  <th className="py-2 pr-3 font-medium">ISP</th>
                  <th className="py-2 pr-3 font-medium">Clientes</th>
                  <th className="py-2 pr-3 font-medium">Capacidades</th>
                  <th className="py-2 pr-3 font-medium">Enviadas</th>
                  <th className="py-2 pr-3 font-medium">Aplicadas</th>
                  <th className="py-2 pr-3 font-medium">Fallidas</th>
                  <th className="py-2 pr-3 font-medium">Vencidas</th>
                  <th className="py-2 pr-3 font-medium">En curso</th>
                  <th className="py-2 pr-3 font-medium">Demora prom.</th>
                  <th className="py-2 pr-3 font-medium">Último estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {isp.por_isp.map((m) => (
                  <tr key={m.proveedorId}>
                    <td className="py-2.5 pr-3 font-mono text-white/75">{m.proveedorId}</td>
                    <td className="py-2.5 pr-3 text-white/60">{m.clientes}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex gap-1">
                        {m.capacidades.map((c) => (
                          <TipoBadge key={c} tipo={c} />
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-white/60">{m.enviadas}</td>
                    <td className="py-2.5 pr-3 text-emerald-300 font-medium">{m.aplicadas}</td>
                    <td className="py-2.5 pr-3 text-red-300">{m.fallidas + m.rechazadas}</td>
                    <td className="py-2.5 pr-3 text-white/60">{m.vencidas}</td>
                    <td className="py-2.5 pr-3 text-amber-300">{m.en_curso}</td>
                    <td className="py-2.5 pr-3 text-white/60">
                      {m.demora_promedio_min !== null ? `${m.demora_promedio_min.toFixed(1)} min` : '—'}
                    </td>
                    <td className="py-2.5 pr-3">{m.ultimo_estado ? <OrderStateBadge estado={m.ultimo_estado} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShieldCard>

      {isp && isp.cobertura.por_expediente.length > 0 && (
        <ShieldCard title="Cobertura por expediente" subtitle="Clientes de ISPs con orden aplicada sobre el total de clientes">
          <ul className="space-y-3">
            {isp.cobertura.por_expediente.map((e) => (
              <li key={e.expediente_id} className="rounded-lg border border-white/5 bg-white/2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-cyan-300">{e.expediente_id}</span>
                  <CaseStateBadge estado={e.estado} />
                  <span className="ml-auto text-xs text-white/50">
                    vigente <strong className="text-emerald-300">{e.cobertura_pct.toFixed(1)}%</strong>
                    <span className="mx-1.5 text-white/20">·</span>
                    alcanzada <strong className="text-cyan-300">{e.cobertura_alcanzada_pct.toFixed(1)}%</strong>
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                  <div className="bg-cyan-500/50 h-full" style={{ width: `${e.cobertura_alcanzada_pct}%` }} />
                  <div className="bg-emerald-400/80 h-full" style={{ width: `${e.cobertura_pct}%`, marginLeft: `-${e.cobertura_pct}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/40">
                  {e.slots.map((s, i) => (
                    <span key={i} className="font-mono">
                      {s.proveedorId}:{s.tipo}:{s.estado}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </ShieldCard>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <ShieldCard title="Contadores por evento" subtitle="audit_eventos del backend">
          {!report ? (
            <LoadingState />
          ) : Object.keys(report.audit_eventos).length === 0 ? (
            <EmptyState>Sin eventos auditados.</EmptyState>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {Object.entries(report.audit_eventos)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([evento, n]) => (
                  <li key={evento} className="flex items-center justify-between rounded-lg bg-white/2 border border-white/5 px-3 py-1.5 text-xs">
                    <span className="text-white/60">{evento}</span>
                    <span className="font-mono font-semibold text-white/80">{n}</span>
                  </li>
                ))}
            </ul>
          )}
        </ShieldCard>

        <ShieldCard title="Últimos eventos de auditoría" subtitle="hora · minuto · evento · datos clave">
          {(audit.data?.entries.length ?? 0) === 0 ? (
            <EmptyState>Sin eventos todavía.</EmptyState>
          ) : (
            <ul className="space-y-1 max-h-[380px] overflow-y-auto pr-1">
              {[...(audit.data?.entries ?? [])].reverse().map((e) => (
                <li key={e.seq} className="text-xs py-1.5 border-b border-white/3 last:border-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-white/25 font-mono">#{e.seq}</span>
                    <MinutoChip min={e.min_sim} />
                    <span className="text-white/75 font-medium">{e.evento}</span>
                    <span className="ml-auto text-white/25 font-mono">{new Date(e.ts_iso).toLocaleTimeString('es-AR')}</span>
                  </div>
                  {e.expediente_id && <div className="text-cyan-400/70 font-mono mt-0.5">{e.expediente_id}</div>}
                  <AuditDatos datos={e.datos} />
                </li>
              ))}
            </ul>
          )}
        </ShieldCard>
      </div>
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

function AuditDatos({ datos }: { datos: Record<string, unknown> }) {
  const parts = Object.entries(datos)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  if (parts.length === 0) return null;
  return <div className="text-white/30 mt-0.5 break-words font-mono text-[10px]">{parts.join(' · ')}</div>;
}
