import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { shieldApi } from './shieldApi';
import { useShield } from './ShieldContext';
import { useShieldLive } from './useShieldSocket';
import { CaseStateBadge, OrderStateBadge, SharedIpBadge, TipoBadge } from './components/badges';
import { EmptyState, ErrorState, Firma, KeyValue, LoadingState, MinutoChip, ShieldCard } from './components/shared';
import type { AuditEntry, CaseDetailResponse, DetectionsResponse } from './shieldTypes';

// VISTA 2 — Caso y evidencia (spec §13): the full expediente with linked
// detections, the verification chain (hash/watermark/license), passive DNS +
// collateral risk, per-ISP orders and the custody timeline.

const DETAIL_EVENTS = ['shield:case', 'shield:order', 'shield:detection', 'shield:audit', 'shield:tick'];

export function ShieldCaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { socket, connected } = useShield();

  const detail = useShieldLive<CaseDetailResponse>(socket, connected, DETAIL_EVENTS, () =>
    shieldApi<CaseDetailResponse>(`/cases/${id}`),
  );
  const detections = useShieldLive<DetectionsResponse>(socket, connected, DETAIL_EVENTS, () =>
    shieldApi<DetectionsResponse>('/detections'),
  );
  const audit = useShieldLive<{ entries: AuditEntry[] }>(socket, connected, DETAIL_EVENTS, () =>
    shieldApi<{ entries: AuditEntry[] }>('/audit?n=200'),
  );

  const exp = detail.data?.expediente;
  const linkedDetections = (detections.data?.detecciones ?? []).filter((d) => exp?.deteccion_ids.includes(d.id));
  const timeline = (audit.data?.entries ?? []).filter((e) => e.expediente_id === exp?.expediente_id).reverse();

  if (detail.loading && !exp) return <LoadingState />;
  if (detail.error && !exp) return <ErrorState>{detail.error}</ErrorState>;
  if (!exp) return <EmptyState>Expediente no encontrado.</EmptyState>;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/shield" className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-lg font-semibold font-mono text-white">{exp.expediente_id}</h1>
          <CaseStateBadge estado={exp.estado} />
          {exp.riesgo?.ip_compartida && <SharedIpBadge />}
          {detail.data && !detail.data.simulador_disponible && (
            <span className="text-xs text-amber-300">(simulador sin conexión — vista del último estado persistido)</span>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <ShieldCard title="Señal e infraestructura" subtitle={`Fase ${exp.fase_key}`}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <KeyValue label="Página">{exp.pagina}</KeyValue>
            <KeyValue label="Stream">{exp.stream_url}</KeyValue>
            <KeyValue label="Host">{exp.host_stream}</KeyValue>
            <KeyValue label="IP servidor">{exp.ip_servidor}</KeyValue>
            <KeyValue label="ASN">{exp.asn ?? '—'}</KeyValue>
            <KeyValue label="Detectado">
              <MinutoChip min={exp.detectado_min} /> → <MinutoChip min={exp.ultima_deteccion_min} />
            </KeyValue>
            {exp.fase_origen && <KeyValue label="Fase anterior">{exp.fase_origen}</KeyValue>}
          </dl>
        </ShieldCard>

        <ShieldCard title="Verificación de evidencia" subtitle="Cadena de custodia PASO A–E">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <KeyValue label="Marca de agua">
              <code className="font-mono text-xs">{exp.marca_de_agua_extraida}</code>{' '}
              <span className={exp.validacion_marca.marca_valida ? 'text-emerald-300' : 'text-red-300'}>
                {exp.validacion_marca.marca_valida ? 'válida' : 'inválida'}
              </span>
            </KeyValue>
            <KeyValue label="Licencia">
              {exp.validacion_marca.licenciatario ? `${exp.validacion_marca.licenciatario} (${exp.estado_licencia})` : exp.estado_licencia}
            </KeyValue>
            <KeyValue label="SHA-256 captura">
              {exp.captura_sha256 ? (
                <code className="font-mono text-xs text-white/60">{exp.captura_sha256.slice(0, 16)}…</code>
              ) : (
                '—'
              )}
            </KeyValue>
            <KeyValue label="Captura">
              {exp.captura_capturada_min !== null ? (
                <>
                  <MinutoChip min={exp.captura_capturada_min} /> {exp.captura_formato} · {exp.captura_duracion_seg}s
                </>
              ) : (
                '—'
              )}
            </KeyValue>
            <KeyValue label="Códigos de veredicto">
              {exp.reason_codes.length > 0 ? exp.reason_codes.join(', ') : '—'}
            </KeyValue>
            <KeyValue label="Vence propuesto">
              <MinutoChip min={exp.vence_min_propuesto} />
            </KeyValue>
          </dl>
        </ShieldCard>

        <ShieldCard title="DNS pasivo y riesgo colateral">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <KeyValue label="DNS resuelto">{exp.dns_pasivo?.resuelto ? 'Sí' : 'No'}</KeyValue>
            <KeyValue label="Organización">{exp.dns_pasivo?.organizacion ?? exp.riesgo?.organizacion ?? '—'}</KeyValue>
            <KeyValue label="IP compartida">
              {exp.riesgo?.ip_compartida === null || exp.riesgo?.ip_compartida === undefined
                ? 'Sin evaluar'
                : exp.riesgo.ip_compartida
                  ? 'Sí — nunca bloquear por IP'
                  : 'No'}
            </KeyValue>
            <KeyValue label="Dominios en esa IP">
              {exp.dominios_compartidos.length > 0 ? exp.dominios_compartidos.join(', ') : '—'}
            </KeyValue>
          </dl>
          {exp.medidas_por_isp.length > 0 && (
            <div className="mt-4 border-t border-white/5 pt-3">
              <p className="text-[11px] uppercase tracking-wider text-white/30 mb-2">Medida calculada por ISP</p>
              <ul className="space-y-1.5">
                {exp.medidas_por_isp.map((m) => (
                  <li key={m.proveedorId} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-white/70 w-24 truncate">{m.proveedorId}</span>
                    {m.tipo ? <TipoBadge tipo={m.tipo} /> : <span className="text-orange-300">sin medida segura</span>}
                    <span className="text-white/50 font-mono">{m.objetivo ?? '—'}</span>
                    <span className="text-white/30 flex-1 min-w-0 truncate" title={m.motivo}>
                      {m.motivo}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ShieldCard>

        <ShieldCard title={`Detecciones vinculadas (${exp.deteccion_ids.length})`}>
          {linkedDetections.length === 0 ? (
            <EmptyState>Sin detecciones visibles (ids: {exp.deteccion_ids.join(', ')})</EmptyState>
          ) : (
            <ul className="space-y-2">
              {linkedDetections.map((d) => (
                <li key={d.id} className="text-xs rounded-lg border border-white/5 bg-white/2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-cyan-300">{d.id}</code>
                    <MinutoChip min={d.minuto} />
                  </div>
                  <div className="mt-1 text-white/50 truncate">{d.stream_url}</div>
                  <div className="text-white/35 font-mono">{d.ip_servidor} · ASN {d.asn}</div>
                </li>
              ))}
            </ul>
          )}
        </ShieldCard>
      </div>

      <ShieldCard title={`Órdenes por ISP (${detail.data?.ordenes.length ?? 0})`} subtitle="recibida ≠ aplicada — el estado lo reporta el proveedor">
        {(detail.data?.ordenes.length ?? 0) === 0 ? (
          <EmptyState>Todavía no se compusieron órdenes para este expediente.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-white/30 uppercase tracking-wider text-[10px] border-b border-white/8">
                  <th className="py-2 pr-3 font-medium">ISP</th>
                  <th className="py-2 pr-3 font-medium">Orden</th>
                  <th className="py-2 pr-3 font-medium">Tipo</th>
                  <th className="py-2 pr-3 font-medium">Objetivo</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2 pr-3 font-medium">Intento</th>
                  <th className="py-2 pr-3 font-medium">Demora</th>
                  <th className="py-2 pr-3 font-medium">Firma</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {detail.data!.ordenes.map((o) => (
                  <OrderRow key={o.orden_id} ordenId={o.orden_id} order={o} detectadoMin={exp.detectado_min} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShieldCard>

      <ShieldCard title="Línea de tiempo del expediente" subtitle="Eventos auditados (append-only)">
        {timeline.length === 0 ? (
          <EmptyState>Sin eventos de auditoría para este expediente.</EmptyState>
        ) : (
          <ol className="relative border-l border-white/10 ml-2 space-y-3">
            {timeline.map((e) => (
              <li key={e.seq} className="ml-4">
                <div className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-cyan-500/70 border border-cyan-300/50" />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-xs font-semibold text-white/75">{e.evento}</span>
                  <MinutoChip min={e.min_sim} />
                  <span className="text-[10px] text-white/30 font-mono">
                    {new Date(e.ts_iso).toLocaleTimeString('es-AR')}
                  </span>
                </div>
                <TimelineDatos datos={e.datos} />
              </li>
            ))}
          </ol>
        )}
      </ShieldCard>
    </div>
  );
}

function OrderRow({ ordenId, order, detectadoMin }: { ordenId: string; order: CaseDetailResponse['ordenes'][number]; detectadoMin: number }) {
  const demora =
    order.aplicada_min !== undefined ? `aplicada ${order.aplicada_min - detectadoMin} min post-detección` : '—';
  return (
    <tr>
      <td className="py-2.5 pr-3 font-mono text-white/70">{order.proveedor_id}</td>
      <td className="py-2.5 pr-3 font-mono text-white/50">{order.orden_id}</td>
      <td className="py-2.5 pr-3">
        <TipoBadge tipo={order.tipo} />
      </td>
      <td className="py-2.5 pr-3 font-mono text-white/60">{order.objetivo}</td>
      <td className="py-2.5 pr-3">
        <OrderStateBadge estado={order.estado} />
        {order.motivo && <div className="text-[10px] text-white/30 mt-0.5 max-w-[180px] truncate" title={order.motivo}>{order.motivo}</div>}
      </td>
      <td className="py-2.5 pr-3 text-white/50">{order.intento ?? intentoDesdeId(ordenId)}</td>
      <td className="py-2.5 pr-3 text-white/50">{demora}</td>
      <td className="py-2.5 pr-3">
        <Firma value={order.firma} />
      </td>
    </tr>
  );
}

function intentoDesdeId(ordenId: string): number {
  const match = /-(\d+)$/.exec(ordenId);
  return match ? Number(match[1]) : 1;
}

function TimelineDatos({ datos }: { datos: Record<string, unknown> }) {
  const entries = Object.entries(datos).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return null;
  return (
    <p className="text-[11px] text-white/35 mt-0.5 break-words">
      {entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}
    </p>
  );
}
