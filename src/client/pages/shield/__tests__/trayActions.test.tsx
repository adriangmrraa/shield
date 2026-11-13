// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrayActions } from '../components/TrayActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

// The tray button is only a hint — when can_sign=false the judge can't even
// attempt the action, with the reason reachable via the title attribute.
describe('TrayActions', () => {
  it('deshabilita aprobar y rechazar cuando canSign=false', () => {
    render(<TrayActions canSign={false} onApprove={() => {}} onReject={() => {}} />);
    const approve = screen.getByRole('button', { name: /aprobar/i });
    const reject = screen.getByRole('button', { name: /rechazar/i });
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(reject.hasAttribute('disabled')).toBe(true);
  });

  it('habilita los botones cuando canSign=true', () => {
    render(<TrayActions canSign={true} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.getByRole('button', { name: /aprobar/i }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /rechazar/i }).hasAttribute('disabled')).toBe(false);
  });

  it('expone el motivo de bloqueo como tooltip', () => {
    render(<TrayActions canSign={false} onApprove={() => {}} onReject={() => {}} />);
    const group = screen.getByRole('button', { name: /aprobar/i }).parentElement;
    expect(group?.getAttribute('title')).toMatch(/turno|asignado/i);
  });

  it('aprobar dispara el handler (click humano explícito)', () => {
    const onApprove = vi.fn();
    render(<TrayActions canSign={true} onApprove={onApprove} onReject={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /aprobar/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('rechazar exige motivo antes de confirmar', () => {
    const onReject = vi.fn();
    render(<TrayActions canSign={true} onApprove={() => {}} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: /rechazar/i }));
    const confirm = screen.getByRole('button', { name: /confirmar rechazo/i });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/motivo del rechazo/i), { target: { value: 'evidencia insuficiente' } });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onReject).toHaveBeenCalledWith('evidencia insuficiente');
  });
});
