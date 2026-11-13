import type { EstadoExpediente, EstadoOrden, TipoBloqueo } from '../shieldTypes';

// Status vocabulary for the judicial console. Two hard rules from the brief:
//  - `recibida` is NOT `aplicada`: provider-side 202 means "en cola", never
//    paint it with applied colors or labels (TEST 06).
//  - ordenes blocked locally keep their own vocabulary so the feed explains
//    WHY nothing reached the ISP.

interface BadgeSpec {
  label: string;
  className: string;
}

const ORDER_BADGES: Record<EstadoOrden, BadgeSpec> = {
  pendiente_envio: { label: 'Firmada — pendiente de envío', className: 'bg-sky-500/15 text-sky-300 border-sky-500/25' },
  enviada: { label: 'Enviada', className: 'bg-sky-500/15 text-sky-300 border-sky-500/25' },
  recibida: { label: 'Recibida por ISP', className: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  aplicada: { label: 'Aplicada', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
  fallida: { label: 'Fallida', className: 'bg-red-500/15 text-red-300 border-red-500/25' },
  vencida: { label: 'Vencida', className: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25' },
  levantada: { label: 'Levantada', className: 'bg-violet-500/15 text-violet-300 border-violet-500/25' },
  rechazada_proveedor: { label: 'Rechazada por ISP', className: 'bg-red-500/15 text-red-300 border-red-500/25' },
  bloqueada_turno: { label: 'Bloqueada (fuera de turno)', className: 'bg-orange-500/15 text-orange-300 border-orange-500/25' },
};

const CASE_BADGES: Record<EstadoExpediente, BadgeSpec> = {
  recibido: { label: 'Recibido', className: 'bg-sky-500/15 text-sky-300 border-sky-500/25' },
  verificado: { label: 'Verificado', className: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25' },
  descartado: { label: 'Descartado', className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25' },
  pendiente_juez: { label: 'Pendiente de juez', className: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  aprobado: { label: 'Aprobado', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
  rechazado: { label: 'Rechazado', className: 'bg-red-500/15 text-red-300 border-red-500/25' },
  distribuyendo: { label: 'Distribuyendo', className: 'bg-sky-500/15 text-sky-300 border-sky-500/25' },
  parcial: { label: 'Cobertura parcial', className: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  aplicado: { label: 'Aplicado', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
  vencido: { label: 'Vencido', className: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25' },
  levantado: { label: 'Levantado', className: 'bg-violet-500/15 text-violet-300 border-violet-500/25' },
};

function ShieldBadge({ spec }: { spec: BadgeSpec }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${spec.className}`}
    >
      {spec.label}
    </span>
  );
}

export function OrderStateBadge({ estado }: { estado: EstadoOrden }) {
  return <ShieldBadge spec={ORDER_BADGES[estado]} />;
}

export function CaseStateBadge({ estado }: { estado: EstadoExpediente }) {
  return <ShieldBadge spec={CASE_BADGES[estado]} />;
}

const TIPO_BADGES: Record<TipoBloqueo, BadgeSpec> = {
  dominio: { label: 'Dominio', className: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25' },
  ip: { label: 'IP', className: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25' },
};

export function TipoBadge({ tipo }: { tipo: TipoBloqueo }) {
  return <ShieldBadge spec={TIPO_BADGES[tipo]} />;
}

/** Shared-IP / collateral indicator — the order must go out as dominio only. */
export function SharedIpBadge() {
  return (
    <span
      title="IP compartida con dominios legítimos: por daño colateral la medida segura es solo dominio"
      className="inline-flex items-center whitespace-nowrap rounded-full border border-orange-500/30 bg-orange-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-orange-300"
    >
      IP compartida — solo dominio
    </span>
  );
}
