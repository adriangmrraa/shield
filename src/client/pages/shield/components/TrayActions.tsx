import { useState } from 'react';

// Judicial decision controls (spec §9): approve/reject is ALWAYS an explicit
// human click — nothing here fires on its own. When canSign is false the
// buttons stay disabled with the reason in the title, mirroring the server's
// shift guard (the 403 OUT_OF_SHIFT remains the real gate).

interface TrayActionsProps {
  canSign: boolean;
  disabledReason?: string;
  busy?: boolean;
  onApprove: () => void | Promise<void>;
  onReject: (motivo: string) => void | Promise<void>;
}

export function TrayActions({ canSign, disabledReason, busy, onApprove, onReject }: TrayActionsProps) {
  const [rejecting, setRejecting] = useState(false);
  const [motivo, setMotivo] = useState('');

  const reason = disabledReason ?? 'Solo el juez de turno asignado puede firmar';
  const blocked = !canSign || busy === true;

  const confirmReject = async () => {
    if (motivo.trim().length === 0) return;
    await onReject(motivo.trim());
    setRejecting(false);
    setMotivo('');
  };

  if (rejecting && canSign) {
    return (
      <div className="flex flex-col gap-2 min-w-[220px]">
        <label className="text-[11px] text-white/45 uppercase tracking-wider" htmlFor="reject-motivo">
          Motivo del rechazo (obligatorio)
        </label>
        <textarea
          id="reject-motivo"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          autoFocus
          aria-required
          className="input-premium text-sm resize-none"
          placeholder="Ej.: evidencia insuficiente, medida desproporcionada…"
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1 !bg-red-500/80 hover:!bg-red-500 text-sm py-1.5"
            disabled={motivo.trim().length === 0 || busy}
            onClick={() => void confirmReject()}
          >
            Confirmar rechazo
          </button>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg text-sm text-white/50 hover:text-white/80 hover:bg-white/5"
            onClick={() => {
              setRejecting(false);
              setMotivo('');
            }}
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2" title={!canSign ? reason : undefined}>
      <button
        type="button"
        className="btn-primary text-sm py-1.5 px-4 disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={blocked}
        onClick={() => void onApprove()}
      >
        Aprobar y firmar
      </button>
      <button
        type="button"
        className="px-4 py-1.5 rounded-lg text-sm font-medium border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={blocked}
        onClick={() => setRejecting(true)}
      >
        Rechazar
      </button>
    </div>
  );
}
