import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Lock, Scale, User } from 'lucide-react';
import { SimBanner } from './components/SimBanner';
import { useShield } from './ShieldContext';

// Judicial entry point (spec §9, §13): separate demo login from the editorial
// app. The page itself advertises that credentials are fictitious demo
// accounts — no production secrecy theater.
export function ShieldLoginPage() {
  const { login, isAuthenticated } = useShield();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) return <Navigate to="/shield" replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate('/shield', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-void flex flex-col">
      <SimBanner />
      <div className="flex-1 flex items-center justify-center px-4 relative overflow-hidden">
        <div className="glow-orb glow-orb-cyan w-[500px] h-[500px] -top-40 -right-60" />
        <div className="glow-orb glow-orb-purple w-[400px] h-[400px] -bottom-40 -left-60" style={{ animationDelay: '2s' }} />

        <div className="w-full max-w-md relative z-10 animate-slide-up">
          <div className="flex flex-col items-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center mb-4 shadow-glow-cyan">
              <Scale className="w-7 h-7 text-cyan-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">PeriodistApp Shield</h1>
            <p className="text-white/30 text-xs mt-1 tracking-wider uppercase">Bandeja judicial — acceso demo</p>
          </div>

          <div className="glass-card-static p-7 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

            <div className="mb-5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200/90 leading-relaxed">
              Las cuentas judiciales son <strong>ficticias y de demostración</strong>. Ninguna credencial otorga
              poder real: todo el circuito corre contra el simulador oficial.
            </div>

            <h2 className="text-lg font-semibold mb-1">Ingreso de juez</h2>
            <p className="text-white/35 text-sm mb-5">Usuario y contraseña demo provistos por el seed</p>

            {error && (
              <div className="mb-5 p-3.5 rounded-xl bg-red-500/8 border border-red-500/15 text-red-400 text-sm flex items-center gap-2 animate-scale-in">
                <div className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                  Usuario judicial
                </label>
                <div className="relative group">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    className="input-premium pl-11"
                    placeholder="jueza-laura-ficticia"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                  Contraseña demo
                </label>
                <div className="relative group">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="input-premium pl-11"
                    placeholder="••••••••••••"
                  />
                </div>
              </div>

              <button type="submit" disabled={loading} className="btn-primary w-full flex items-center justify-center gap-2 py-3">
                {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Ingresar a la bandeja'}
              </button>
            </form>
          </div>

          <p className="text-center text-xs text-white/25 mt-6">
            Sin turno activo el juez puede ver la bandeja pero no puede firmar.
          </p>
        </div>
      </div>
    </div>
  );
}
