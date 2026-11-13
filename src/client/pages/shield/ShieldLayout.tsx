import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { Gavel, LogOut, MonitorDot, Radio, Scale, BarChart3 } from 'lucide-react';
import { SimBanner } from './components/SimBanner';
import { useShield } from './ShieldContext';

const NAV = [
  { to: '/shield', icon: Gavel, label: 'Bandeja del juez', end: true },
  { to: '/shield/monitor', icon: MonitorDot, label: 'Monitor en vivo' },
  { to: '/shield/metrics', icon: BarChart3, label: 'Métricas y auditoría' },
];

function turnoCountdown(turnos: { juez_id: string; desde_min: number; hasta_min: number }[], juezId: string | null, minuto: number | null) {
  if (!juezId || minuto === null) return null;
  const activo = turnos.find((t) => t.juez_id === juezId && minuto >= t.desde_min && minuto < t.hasta_min);
  return activo ? activo.hasta_min - minuto : 0;
}

/**
 * Judicial-console chrome (spec §13): simulated-environment banner on top of
 * EVERY shield view, compact header with match clock, judge on shift, shift
 * countdown, live/polling indicator and logout.
 */
export function ShieldLayout() {
  const { juez, isAuthenticated, status, turnos, connected, logout } = useShield();

  if (!isAuthenticated) return <Navigate to="/shield/login" replace />;

  const minuto = status?.minuto_actual ?? null;
  const juezTurno = status?.juez_turno_actual ?? null;
  const restante = turnoCountdown(turnos, juezTurno, minuto);
  const soyDeTurno = juezTurno !== null && juezTurno === juez?.juez_id;

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-void text-white/85">
      <SimBanner />

      <header className="shrink-0 border-b border-white/8 bg-surface/60 backdrop-blur">
        <div className="px-4 lg:px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center">
              <Scale className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-white">PeriodistApp Shield</p>
              <p className="text-[10px] uppercase tracking-widest text-white/30">Consola judicial</p>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-1 ml-6">
            {NAV.map(({ to, icon: Icon, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isActive ? 'bg-cyan-500/15 text-cyan-300' : 'text-white/45 hover:text-white/75 hover:bg-white/5'
                  }`
                }
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-xs">
            <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-white/4 border border-white/8 px-2.5 py-1">
              <span className="text-white/35">Minuto</span>
              <span className="font-mono font-semibold text-cyan-300" data-testid="minuto-actual">
                {minuto ?? '—'}
              </span>
              {status?.reloj?.fin_min !== undefined && <span className="text-white/25">/ {status.reloj?.fin_min}</span>}
            </div>

            <div className="hidden lg:flex flex-col items-end leading-tight">
              <span className="text-white/60">{juez?.nombre ?? juez?.juez_id}</span>
              <span className={soyDeTurno ? 'text-emerald-400' : 'text-amber-400'}>
                {juezTurno === null
                  ? 'Sin turno activo'
                  : soyDeTurno
                    ? `De turno${restante !== null ? ` — ${restante} min restantes` : ''}`
                    : `Fuera de turno (firma: ${juezTurno})`}
              </span>
            </div>

            <div
              className={`flex items-center gap-1 rounded-full px-2 py-1 border text-[10px] font-semibold uppercase tracking-wider ${
                connected
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              }`}
              title={connected ? 'Tiempo real por socket' : 'Socket caído — actualizando por polling cada 5 s'}
            >
              <Radio className="w-3 h-3" />
              {connected ? 'En vivo' : 'Polling'}
            </div>

            <button
              onClick={logout}
              className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
              title="Cerrar sesión judicial"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        <nav className="md:hidden flex items-center gap-1 px-3 pb-2 overflow-x-auto">
          {NAV.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                  isActive ? 'bg-cyan-500/15 text-cyan-300' : 'text-white/45'
                }`
              }
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 lg:px-6 py-6 space-y-5">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
