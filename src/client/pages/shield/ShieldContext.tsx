import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import {
  clearShieldSession,
  getShieldJuez,
  getShieldToken,
  saveShieldSession,
  shieldApi,
  shieldLogin,
  ShieldApiError,
} from './shieldApi';
import { useShieldSocket } from './useShieldSocket';
import type { ShieldJudge, ShieldStatus, Turno } from './shieldTypes';

// Shared judicial-console context: session (JWT in localStorage), simulator
// status + shift table for the countdown, and ONE socket for every shield
// view. Views consume via useShield() and fetch their own payloads.

interface ShieldContextValue {
  juez: ShieldJudge | null;
  isAuthenticated: boolean;
  status: ShieldStatus | null;
  statusError: string | null;
  turnos: Turno[];
  socket: Socket | null;
  connected: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  reloadStatus: () => Promise<void>;
}

const ShieldContext = createContext<ShieldContextValue | undefined>(undefined);

export function ShieldProvider({ children }: { children: ReactNode }) {
  const [juez, setJuez] = useState<ShieldJudge | null>(() => getShieldJuez());
  const [hasToken, setHasToken] = useState(() => getShieldToken() !== null);
  const [status, setStatus] = useState<ShieldStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const { socket, connected } = useShieldSocket(juez?.juez_id ?? null);

  const isAuthenticated = hasToken && juez !== null;

  const logout = useCallback(() => {
    clearShieldSession();
    setJuez(null);
    setHasToken(false);
    setStatus(null);
  }, []);

  const reloadStatus = useCallback(async () => {
    try {
      const [nextStatus, nextTurnos] = await Promise.all([
        shieldApi<ShieldStatus>('/status'),
        shieldApi<{ turnos: Turno[] }>('/turnos'),
      ]);
      setStatus(nextStatus);
      setTurnos(nextTurnos.turnos);
      setStatusError(null);
    } catch (err) {
      if (err instanceof ShieldApiError && err.status === 401) logout();
      setStatusError(err instanceof Error ? err.message : 'Error de estado');
    }
  }, [logout]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void reloadStatus();
    // Tick keeps the clock fresh through the socket; the 5s poll below covers
    // both socket downtime and shift metadata changes that produce no tick.
    const tick = (payload: { minuto?: number }) => {
      if (typeof payload?.minuto !== 'number') return;
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              minuto_actual: payload.minuto!,
              reloj: prev.reloj ? { ...prev.reloj, minuto_actual: payload.minuto! } : prev.reloj,
            }
          : prev,
      );
    };
    socket?.on('shield:tick', tick);
    const timer = setInterval(() => void reloadStatus(), 5_000);
    return () => {
      socket?.off('shield:tick', tick);
      clearInterval(timer);
    };
  }, [isAuthenticated, socket, reloadStatus]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await shieldLogin(username, password);
    saveShieldSession(result);
    setJuez(result.juez);
    setHasToken(true);
  }, []);

  const value = useMemo<ShieldContextValue>(
    () => ({
      juez,
      isAuthenticated,
      status,
      statusError,
      turnos,
      socket,
      connected,
      login,
      logout,
      reloadStatus,
    }),
    [juez, isAuthenticated, status, statusError, turnos, socket, connected, login, logout, reloadStatus],
  );

  return <ShieldContext.Provider value={value}>{children}</ShieldContext.Provider>;
}

export function useShield(): ShieldContextValue {
  const ctx = useContext(ShieldContext);
  if (!ctx) throw new Error('useShield must be inside ShieldProvider');
  return ctx;
}

export function isOutOfShift(err: unknown): boolean {
  return err instanceof ShieldApiError && (err.code === 'OUT_OF_SHIFT' || err.status === 403);
}
