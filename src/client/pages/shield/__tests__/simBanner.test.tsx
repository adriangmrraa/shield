// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SimBanner } from '../components/SimBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

// Spec §13: the simulated-environment notice must be unmistakable on every
// shield view — the banner component is mounted once in ShieldLayout so it
// covers all routes.
describe('SimBanner', () => {
  it('muestra el aviso ENTORNO SIMULADO / datos ficticios', () => {
    render(<SimBanner />);
    expect(screen.getByTestId('sim-banner').textContent).toMatch(/entorno simulado/i);
    expect(screen.getByTestId('sim-banner').textContent).toMatch(/datos ficticios/i);
  });

  it('usa rol alert para que el aviso no pase desapercibido', () => {
    render(<SimBanner />);
    expect(screen.getByRole('alert')).toBeDefined();
  });
});
