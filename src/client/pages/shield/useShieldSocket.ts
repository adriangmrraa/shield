import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getShieldToken } from './shieldApi';

// Socket.IO client for the shield realtime channel. Connects on the dedicated
// /shield/socket.io path (proxied to the dev server by Vite) with the judicial
// JWT in handshake.auth.token. When the socket drops, consumers fall back to a
// ~5s poll — the UI degrades, it never freezes.

const POLL_FALLBACK_MS = 5_000;

export function useShieldSocket(): { socket: Socket | null; connected: boolean } {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = getShieldToken();
    if (!token) {
      setSocket(null);
      setConnected(false);
      return;
    }
    const instance = io({
      path: '/shield/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    instance.on('connect', onConnect);
    instance.on('disconnect', onDisconnect);
    instance.on('connect_error', (err) => {
      console.warn('[shield:socket] connect_error:', err.message);
      setConnected(false);
    });
    setSocket(instance);
    return () => {
      instance.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, []);

  return { socket, connected };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandlers = Record<string, (payload: any) => void>;

/**
 * Subscribes socket events for the lifetime of the component. Handlers are
 * captured in a ref — callers may pass fresh closures each render without
 * re-subscribing.
 */
export function useShieldEvents(socket: Socket | null, handlers: EventHandlers): void {
  const ref = useRef<EventHandlers>(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!socket) return;
    const entries = Object.keys(ref.current).map((name) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listener = (payload: any) => ref.current[name]?.(payload);
      socket.on(name, listener);
      return [name, listener] as const;
    });
    return () => {
      for (const [name, listener] of entries) socket.off(name, listener);
    };
  }, [socket]);
}

/**
 * Live data source: initial fetch + re-fetch on every subscribed socket event
 * + hard polling fallback while the socket is down.
 */
export function useShieldLive<T>(
  socket: Socket | null,
  connected: boolean,
  events: string[],
  fetcher: () => Promise<T>,
): { data: T | null; error: string | null; reload: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useShieldEvents(
    socket,
    Object.fromEntries(events.map((name) => [name, () => void reload()])) as EventHandlers,
  );

  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => void reload(), POLL_FALLBACK_MS);
    return () => clearInterval(timer);
  }, [connected, reload]);

  return { data, error, reload, loading };
}
