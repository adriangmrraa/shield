// @vitest-environment jsdom
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShieldSocket } from '../useShieldSocket';

// S6 regression: the socket lifecycle must follow the signed-in judge. Before
// the fix the effect ran once with [] deps — a fresh login never connected and
// a logout left a live authenticated socket open.

const sockets: Array<{ handlers: Map<string, () => void>; disconnect: ReturnType<typeof vi.fn> }> = [];

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket = {
      handlers: new Map<string, () => void>(),
      on(event: string, cb: () => void) {
        this.handlers.set(event, cb);
        return this;
      },
      off(event: string) {
        this.handlers.delete(event);
        return this;
      },
      disconnect: vi.fn(),
    };
    sockets.push(socket as (typeof sockets)[number]);
    return socket;
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);
beforeEach(() => {
  sockets.length = 0;
  localStorage.clear();
});

const connect = (s: (typeof sockets)[number]) => {
  act(() => s.handlers.get('connect')?.());
};

describe('useShieldSocket', () => {
  it('does not connect without a signed-in judge', () => {
    const { result } = renderHook(() => useShieldSocket(null));
    expect(result.current.socket).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('connects when a judge appears after mount (fresh login)', () => {
    localStorage.setItem('shield.jwt', 'token-a');
    const { result, rerender } = renderHook(({ juezId }) => useShieldSocket(juezId), {
      initialProps: { juezId: null as string | null },
    });
    expect(sockets).toHaveLength(0);

    rerender({ juezId: 'jueza-laura-ficticia' });
    expect(sockets).toHaveLength(1);
    connect(sockets[0]);
    expect(result.current.socket).not.toBeNull();
    expect(result.current.connected).toBe(true);
  });

  it('disconnects on logout and reconnects for a new judge', () => {
    localStorage.setItem('shield.jwt', 'token-b');
    const { result, rerender } = renderHook(({ juezId }) => useShieldSocket(juezId), {
      initialProps: { juezId: 'jueza-laura-ficticia' as string | null },
    });
    expect(sockets).toHaveLength(1);

    rerender({ juezId: null });
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.socket).toBeNull();
    expect(result.current.connected).toBe(false);

    rerender({ juezId: 'juez-martin-ejemplo' });
    expect(sockets).toHaveLength(2);
    expect(result.current.socket).not.toBeNull();
  });
});
