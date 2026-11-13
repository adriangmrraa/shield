import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { shieldApi, ShieldApiError } from './shieldApi';
import { useShield } from './ShieldContext';
import { useShieldLive } from './useShieldSocket';
import { CaseStateBadge, SharedIpBadge, TipoBadge } from './components/badges';
import { EmptyState, ErrorState, MinutoChip, ShieldCard, SkeletonRows } from './components/shared';
import { TrayActions } from './components/TrayActions';
import type { CasesResponse, ExpedienteConPermiso } from './shieldTypes';

// VISTA 3 — Bandeja del juez (spec §9, §13): pending cases assigned to the
// judge on shift, with explicit approve/reject. can_sign from the API mirrors
// the server's shift guard as a UI hint; the backend re-checks on every POST.

const TRAY_EVENTS = ['shield:case', 'shield:case-created', 'shield:case-ready', 'shield:case-rejected', 'shield:judge-turn-changed', 'shield:audit'];

export function ShieldTrayPage() {
  const { socket, connected, juez } = useShield();
  const { data, error, reload, loading } = useShieldLive<CasesResponse>(socket, connected, TRAY_EVENTS, () =>
    shieldApi<CasesResponse>('/cases?estado=pendiente_juez'),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const soyDeTurno = data?.juez_turno_actual != null && data.juez_turno_actual === juez?.juez_id;

  // Signable cases float to the top: the judge's actionable work first,
  // then anything blocked by shift/assignment, keeping original order inside
  // each bucket so the list stays stable across refreshes.
  const cases = useMemo(
    () => (data?.cases ?? []).slice().sort((a, b) => Number(b.can_sign) - Number(a.can_sign)),
    [data?.cases],
  );
  const signableCount = useMemo(() => cases.filter((c) => c.can_sign).length, [cases]);

  const run = async (exp: ExpedienteConPermiso, action: () => Promise<{ ordenes?: unknown[] }>, okMessage: string) => {
    setBusyId(exp.expediente_id);
    setActionError(null);
    setNotice(null);
    try {
      const result = await action();
      const n = result.ordenes?.length ?? 0;
      setNotice(`${exp.expediente_id}: ${okMessage}${n > 0 ? ` (${n} órdenes firmadas)` : ''}`);
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ShieldApiError && err.code === 'OUT_OF_SHIFT'
          ? `${exp.expediente_id}: fuera de turno — la firma fue bloqueada por el servidor.`
          : err instanceof Error
            ? err.message
            : 'Error al procesar la decisión',
      );
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const approve = (exp: ExpedienteConPermiso) =>
    run(exp, () => shieldApi(`/cases/${exp.expediente_id}/approve`, { method: 'POST' }), 'expediente aprobado');

  const reject = (exp: ExpedienteConPermiso, motivo: string) =>
    run(exp, () => shieldApi(`/cases/${exp.expediente_id}/reject`, { method: 'POST', body: { motivo } }), 'expediente rechazado');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Bandeja del juez</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Expedientes verificados esperando decisión judicial — aprobar o rechazar siempre es un acto humano.
          </p>
        </div>
        <div className="text-xs text-white/45">
          {data?.juez_turno_actual ? (
            <>
              Firma habilitada para:{' '}
              <span className={soyDeTurno ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
                {data.juez_turno_actual}
              </span>
            </>
          ) : (
            <span className="text-white/30">Simulador sin turno activo</span>
          )}
        </div>
      </div>

      {notice && (
        <div className="p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/15 text-emerald-300 text-sm" role="status">
          {notice}
        </div>
      )}
      {actionError && <ErrorState>{actionError}</ErrorState>}
      {error && <ErrorState>{error}</ErrorState>}
      {data && !data.simulador_disponible && (
        <div className="p-3 rounded-xl bg-amber-500/8 border border-amber-500/15 text-amber-300 text-sm" role="status">
          El simulador no responde: la bandeja muestra el último estado persistido y la firma queda deshabilitada.
        </div>
      )}

      <ShieldCard
        title={`Expedientes pendientes (${cases.length})`}
        subtitle={
          signableCount > 0
            ? `${signableCount} listo${signableCount === 1 ? '' : 's'} para firmar — se reasignan al juez que entra de turno`
            : 'Se reasignan automáticamente al juez que entra de turno'
        }
      >
        {loading && cases.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : cases.length === 0 ? (
          <EmptyState>No hay expedientes pendientes de decisión judicial.</EmptyState>
        ) : (
          <ul className="divide-y divide-white/5">
            {cases.map((exp) => (
              <TrayRow
                key={exp.expediente_id}
                exp={exp}
                busy={busyId === exp.expediente_id}
                onApprove={() => approve(exp)}
                onReject={(motivo) => reject(exp, motivo)}
              />
            ))}
          </ul>
        )}
      </ShieldCard>
    </div>
  );
}

function TrayRow({ exp, busy, onApprove, onReject }: {
  exp: ExpedienteConPermiso;
  busy: boolean;
  onApprove: () => Promise<void>;
  onReject: (motivo: string) => Promise<void>;
}) {
  const medidaResumen = resumenMedidas(exp.medidas_por_isp);
  return (
    <li
      className={`py-4 px-3 -mx-3 rounded-xl flex flex-col lg:flex-row lg:items-center gap-4 transition-colors ${
        exp.can_sign ? 'hover:bg-white/2' : 'opacity-80'
      }`}
    >
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/shield/cases/${exp.expediente_id}`}
            className="font-mono text-sm text-cyan-300 hover:text-cyan-200 inline-flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50"
            aria-label={`Abrir expediente ${exp.expediente_id}`}
          >
            <FileText className="w-3.5 h-3.5" aria-hidden />
            {exp.expediente_id}
          </Link>
          <CaseStateBadge estado={exp.estado} />
          {exp.riesgo?.ip_compartida && <SharedIpBadge />}
        </div>

        <div className="text-sm text-white/70 truncate">
          <span className="text-white/40">Señal:</span> {exp.senal_key}
          <span className="text-white/25 mx-2">·</span>
          <span className="text-white/40">Host:</span> {exp.host_stream}
          <span className="text-white/25 mx-2">·</span>
          <span className="text-white/40">IP:</span> <span className="font-mono">{exp.ip_servidor}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/40">
          <span>
            Marca <code className="text-white/60 font-mono">{exp.marca_de_agua_extraida}</code>
          </span>
          <span>
            Detección <MinutoChip min={exp.detectado_min} />
          </span>
          {exp.asignado_juez_id && (
            <span>
              Asignado a <span className="text-white/60">{exp.asignado_juez_id}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-white/35">Medida sugerida:</span>
          {medidaResumen.dominio > 0 && <TipoBadge tipo="dominio" />}
          {medidaResumen.ip > 0 && <TipoBadge tipo="ip" />}
          {medidaResumen.sinMedida > 0 && (
            <span className="text-orange-300/80" title="Hay ISP donde no existe medida segura">
              {medidaResumen.sinMedida} ISP sin medida segura
            </span>
          )}
          <span className="text-white/30">
            ({exp.medidas_por_isp.filter((m) => m.tipo !== null).length} ISP objetivo)
          </span>
        </div>
      </div>

      <div className="shrink-0">
        <TrayActions
          canSign={exp.can_sign}
          disabledReason={
            exp.can_sign
              ? undefined
              : 'Fuera de turno o no asignado: solo el juez de turno asignado puede firmar este expediente'
          }
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
        />
      </div>
    </li>
  );
}

function resumenMedidas(medidas: ExpedienteConPermiso['medidas_por_isp']) {
  return medidas.reduce(
    (acc, m) => {
      if (m.tipo === 'dominio') acc.dominio += 1;
      else if (m.tipo === 'ip') acc.ip += 1;
      else acc.sinMedida += 1;
      return acc;
    },
    { dominio: 0, ip: 0, sinMedida: 0 },
  );
}
