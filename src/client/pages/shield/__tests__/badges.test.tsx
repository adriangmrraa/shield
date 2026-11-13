// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderStateBadge } from '../components/badges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

// TEST 06 invariant: the UI must never paint a provider-side "recibida" as if
// the order were already applied. Different label AND different color family.
describe('OrderStateBadge', () => {
  it('recibida y aplicada muestran etiquetas distintas', () => {
    const { unmount } = render(<OrderStateBadge estado="recibida" />);
    const recibida = screen.getByText(/recibida/i);
    expect(recibida.textContent).not.toMatch(/aplicada/i);
    unmount();

    render(<OrderStateBadge estado="aplicada" />);
    expect(screen.getByText(/^aplicada$/i)).toBeDefined();
  });

  it('recibida y aplicada usan familias de color distintas', () => {
    const { container: c1, unmount } = render(<OrderStateBadge estado="recibida" />);
    const recibidaClass = c1.firstElementChild?.className ?? '';
    unmount();
    const { container: c2 } = render(<OrderStateBadge estado="aplicada" />);
    const aplicadaClass = c2.firstElementChild?.className ?? '';
    expect(recibidaClass).not.toBe(aplicadaClass);
    expect(recibidaClass).toContain('amber');
    expect(aplicadaClass).toContain('emerald');
  });
});
