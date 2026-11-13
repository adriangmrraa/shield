import { Link } from 'react-router-dom';
import { Gauge, TrendingUp, Users, FileSearch } from 'lucide-react';
import { shieldApi } from './shieldApi';
import { useShield } from './ShieldContext';
import { useShieldLive } from './useShieldSocket';
import { CaseStateBadge, OrderStateBadge, TipoBadge } from './components/badges';
import { EmptyState, ErrorState, LoadingState, MinutoChip, ShieldCard, SkeletonRows, StaleWarning, StatCard, formatAuditDatos } from './components/shared';
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

      {metrics.error && !report && <ErrorState>{metrics.error}</ErrorState>}
      {metrics.loading && !report && <SkeletonRows rows={2} />}

      {isp && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Cobertura vigente"
            icon={Gauge}
            value={`${isp.cobertura.cobertura_ponderada_pct.toFixed(1)}%`}
            hint="órdenes aplicadas ahora"
            accent="text-emerald-300"
          />
          <StatCard
            label="Cobertura alcanzada"
            icon={TrendingUp}
            value={`${isp.cobertura.cobertura_alcanzada_ponderada_pct.toFixed(1)}%`}
            hint="aplicada en algún momento (incl. vencidas)"
            accent="text-cyan-300"
          />
          <StatCard label="Clientes totales ISP" icon={Users} value={isp.cobertura.clientes_totales} hint="peso de la cobertura" />
          <StatCard label="Expedientes evaluados" icon={FileSearch} value={isp.cobertura.por_expediente.length} hint="con distribución iniciada" />
        </div>
      )}

      <ShieldCard title="Métricas por ISP" subtitle="Enviadas cuentan intentos al cable; slots son objetivos (expediente, proveedor)">
        {metrics.loading && !report ? (
          <SkeletonRows rows={2} />
        ) : !isp || isp.por_isp.length === 0 ? (
          <EmptyState>{isp === null ? 'Sin simulador conectado — métricas de ISP no disponibles.' : 'Sin proveedores.'}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-white/30 uppercase tracking-wider text-[10px] border-b border-white/8">
                  <th scope="col" className="py-2 pr-3 font-medium">ISP</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Clientes</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Capacidades</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Enviadas</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Aplicadas</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Fallidas</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Vencidas</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">En curso</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Demora prom.</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Último estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {isp.por_isp.map((m) => (
                  <tr key={m.proveedorId} className="hover:bg-white/2 transition-colors">
                    <td className="py-2.5 pr-3 font-mono text-white/75">{m.proveedorId}</td>
                    <td className="py-2.5 pr-3 text-white/60 text-right tabular-nums">{m.clientes}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex gap-1">
                        {m.capacidades.map((c) => (
                          <TipoBadge key={c} tipo={c} />
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-white/60 text-right tabular-nums">{m.enviadas}</td>
                    <td className="py-2.5 pr-3 text-emerald-300 font-medium text-right tabular-nums">{m.aplicadas}</td>
                    <td className="py-2.5 pr-3 text-red-300 text-right tabular-nums">{m.fallidas + m.rechazadas}</td>
                    <td className="py-2.5 pr-3 text-white/60 text-right tabular-nums">{m.vencidas}</td>
                    <td className="py-2.5 pr-3 text-amber-300 text-right tabular-nums">{m.en_curso}</td>
                    <td className="py-2.5 pr-3 text-white/60 text-right tabular-nums">
                      {m.demora_promedio_min !== null ? `${m.demora_promedio_min.toFixed(1)}′` : '—'}
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
              <li key={e.expediente_id} className="rounded-lg border border-white/5 bg-white/2 px-4 py-3 hover:border-white/10 transition-colors">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/shield/cases/${e.expediente_id}`}
                    className="font-mono text-xs text-cyan-300 hover:text-cyan-200 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50"
                  >
                    {e.expediente_id}
                  </Link>
                  <CaseStateBadge estado={e.estado} />
                  <span className="ml-auto text-xs text-white/50 tabular-nums">
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
                    <span className="font-mono font-semibold text-white/80 tabular-nums">{n}</span>
                  </li>
                ))}
            </ul>
          )}
        </ShieldCard>

        <ShieldCard
          title="Últimos eventos de auditoría"
          subtitle="hora · minuto · evento · datos clave"
          actions={audit.error && audit.data ? <StaleWarning hint={audit.error} /> : undefined}
        >
          {audit.error && !audit.data ? (
            <ErrorState>{audit.error}</ErrorState>
          ) : (audit.data?.entries.length ?? 0) === 0 ? (
            <EmptyState>Sin eventos todavía.</EmptyState>
          ) : (
            <ul className="space-y-1 max-h-[380px] overflow-y-auto pr-1">
              {[...(audit.data?.entries ?? [])].reverse().map((e) => (
                <li key={e.seq} className="text-xs py-1.5 border-b border-white/3 last:border-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-white/25 font-mono tabular-nums">#{e.seq}</span>
                    <MinutoChip min={e.min_sim} />
                    <span className="text-white/75 font-medium">{e.evento}</span>
                    <span className="ml-auto text-white/25 font-mono tabular-nums">{new Date(e.ts_iso).toLocaleTimeString('es-AR')}</span>
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

function AuditDatos({ datos }: { datos: Record<string, unknown> }) {
  const line = formatAuditDatos(datos, 4);
  if (!line) return null;
  return <div className="text-white/30 mt-0.5 break-words font-mono text-[10px]">{line}</div>;
}
