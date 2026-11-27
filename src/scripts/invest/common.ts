// Shared bits for every /vault/invest/ page.
import { initTheme } from '../theme';

initTheme();

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Short status message at the bottom of the page. */
export function toast(message: string, kind: 'ok' | 'err' = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 8000 : 3500);
}

export const fmtEur = (n: number) =>
  new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat('ro-RO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
