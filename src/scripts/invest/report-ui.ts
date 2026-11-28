// Small DOM and number-format helpers shared by the report pages and the dashboard (ro-RO formats).

export const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
export const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Whole units; values that round to 0 never show as "-0"; minus sign is the typographic one. */
const whole = (n: number) => { const r = Math.round(n); return `${r < 0 ? '−' : ''}${NF0.format(Math.abs(r))}`; };
export const eur = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${whole(n)} €`);
export const ron = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${whole(n)} lei`);
export const signedEur = (n: number) => `${n > 0.5 ? '+' : n < -0.5 ? '−' : ''}${NF0.format(Math.abs(n))} €`;
/** Percent with one decimal; `signed` adds + for gains. */
export const pct = (x: number | null | undefined, signed = false) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = NF1.format(Math.abs(x) * 100);
  return `${x < -0.0005 ? '−' : signed && x > 0.0005 ? '+' : ''}${s}%`;
};
/** 31.12.2025 */
export const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
export const MONTHS = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Compact axis label for money: 1,2 mil. / 350k */
export const axisMoney = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${NF1.format(v / 1e6)} mil.`;
  if (a >= 1e3) return `${NF0.format(v / 1e3)}k`;
  return NF0.format(v);
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Up/down class for a signed number (text colour), so the sign is never colour-only (the text has +/−). */
export const trendClass = (x: number | null | undefined) => (x === null || x === undefined ? '' : x > 0.0005 ? 'is-up' : x < -0.0005 ? 'is-down' : '');

/** One KPI tile: <div class="kpi"><dt/><dd/><small/></div> */
export function kpi(label: string, value: string, opts: { note?: string; cls?: string; hero?: boolean; href?: string; linkText?: string } = {}) {
  const d = el('div', null, `kpi${opts.hero ? ' kpi--hero' : ''}`);
  const dd = el('dd', value, opts.cls);
  d.append(el('dt', label), dd);
  if (opts.note) dd.append(el('small', opts.note));
  if (opts.href) { const a = el('a', opts.linkText ?? 'Deschide →'); a.href = opts.href; d.append(a); }
  return d;
}

/** A table row: header cell + value cells (strings or nodes); `num` marks right-aligned value cells. */
export function row(head: string | Node, cells: (string | Node)[], opts: { cls?: string; num?: boolean } = {}) {
  const tr = el('tr', null, opts.cls);
  const th = el('th'); th.scope = 'row'; th.append(head);
  tr.append(th);
  for (const c of cells) { const td = el('td', null, opts.num === false ? undefined : 'num'); td.append(c); tr.append(td); }
  return tr;
}

export function chip(status: 'ok' | 'warn' | 'na', text?: string) {
  const label = text ?? (status === 'ok' ? '✓ respectat' : status === 'warn' ? '! de verificat' : '– n/a');
  return el('span', label, `chip chip--${status}`);
}

/** Opens <details class="rp-print-open"> while printing (closed details hide their content on paper). */
export function openDetailsForPrint() {
  let opened: HTMLDetailsElement[] = [];
  window.addEventListener('beforeprint', () => {
    opened = [...document.querySelectorAll<HTMLDetailsElement>('details.rp-print-open:not([open])')];
    opened.forEach(d => { d.open = true; });
  });
  window.addEventListener('afterprint', () => { opened.forEach(d => { d.open = false; }); opened = []; });
}
