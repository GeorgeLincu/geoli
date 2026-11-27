// Dashboard card "Prețuri și cursuri" (Phase 3): last update, BNR rates, latest price per instrument,
// stale-price warnings, "Actualizează acum" and manual price overrides.
import { toast, fmtDateTime } from './common';
import { EXCHANGES, parsePriceSource, type MarketStatus, type LatestPrice, type InstrumentStatus, type FxDay } from '../../lib/invest/market';
import type { Currency } from '../../lib/invest/types';

interface Row {
  id: string; name: string; ticker: string | null; currency: Currency; priceSource: string | null;
  latest: LatestPrice | null; stale: boolean; status: InstrumentStatus | null;
}
interface Summary { today: string; status: MarketStatus | null; fx: FxDay | null; instruments: Row[] }

const API = '/vault/api/invest/market';
const card = document.getElementById('market');

const fmtDate = (iso: string) => new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const fmtPrice = (n: number, c: Currency) =>
  new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
const fmtRate = (n: number) => new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(n);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function sourceLabel(src: string | null) {
  const p = parsePriceSource(src ?? undefined);
  if (!p) return src ? `invalid: ${src}` : 'manual';
  return `${EXCHANGES[p.exchange].label} · ${p.symbol}`;
}

function badge(r: Row) {
  const wrap = el('td');
  let b: HTMLElement;
  if (!r.latest) b = el('span', 'fără preț', 'mk-badge mk-badge--err');
  else if (r.stale) b = el('span', `preț vechi din ${fmtDate(r.latest.date)}`, 'mk-badge mk-badge--warn');
  else if (r.latest.source === 'manual') b = el('span', 'manual', 'mk-badge mk-badge--manual');
  else b = el('span', 'la zi', 'mk-badge mk-badge--ok');
  wrap.append(b);
  if (r.status?.message) wrap.append(el('span', r.status.message, 'mk-msg'));
  return wrap;
}

function render(s: Summary) {
  const set = (k: string, v: string) => { const n = card?.querySelector(`[data-mk="${k}"]`); if (n) n.textContent = v; };
  set('lastRun', s.status?.lastRun ? fmtDateTime(s.status.lastRun) : 'niciodată');
  set('eur', s.fx?.rates.EUR ? `${fmtRate(s.fx.rates.EUR)} lei` : '—');
  set('usd', s.fx?.rates.USD ? `${fmtRate(s.fx.rates.USD)} lei` : '—');

  const state = document.getElementById('mkState')!;
  const parts: string[] = [];
  if (s.fx) parts.push(`Curs BNR din ${fmtDate(s.fx.date)}.`);
  if (s.status && !s.status.fx.ok && s.status.fx.message) parts.push(`BNR: ${s.status.fx.message}.`);
  if (!s.instruments.length) parts.push('Nu ai încă instrumente. Adaugă-le în Portofoliu, cu sursa de preț (ex. „xetra:VWCE”).');
  const stale = s.instruments.filter(r => r.stale).length;
  if (stale) parts.push(`${stale} ${stale === 1 ? 'instrument are' : 'instrumente au'} prețul vechi sau lipsă.`);
  state.textContent = parts.join(' ') || 'Totul e la zi.';

  const table = document.getElementById('mkTable') as HTMLTableElement;
  const body = table.tBodies[0];
  body.replaceChildren(...s.instruments.map(r => {
    const tr = el('tr');
    const name = el('td', undefined, 'mk-name');
    name.append(el('span', r.name));
    if (r.ticker) name.append(' ', el('small', r.ticker));
    tr.append(
      name,
      el('td', sourceLabel(r.priceSource)),
      el('td', r.latest ? fmtPrice(r.latest.close, r.latest.currency) : '—', 'mk-num'),
      el('td', r.latest ? fmtDate(r.latest.date) : '—'),
      badge(r),
    );
    return tr;
  }));
  table.hidden = !s.instruments.length;

  // Manual override form
  const box = document.getElementById('overrideBox') as HTMLDetailsElement;
  box.hidden = !s.instruments.length;
  const form = document.getElementById('overrideForm') as HTMLFormElement;
  const select = form.elements.namedItem('instrumentId') as HTMLSelectElement;
  const keep = select.value;
  select.replaceChildren(...s.instruments.map(r => {
    const o = el('option', r.ticker ? `${r.name} (${r.ticker})` : r.name);
    o.value = r.id;
    o.dataset.currency = r.latest?.currency ?? r.currency;
    return o;
  }));
  if (keep) select.value = keep;
  syncCurrency(form);
  const date = form.elements.namedItem('date') as HTMLInputElement;
  date.max = s.today;
  if (!date.value) date.value = s.today;
}

function syncCurrency(form: HTMLFormElement) {
  const select = form.elements.namedItem('instrumentId') as HTMLSelectElement;
  const cur = select.selectedOptions[0]?.dataset.currency;
  if (cur) (form.elements.namedItem('currency') as HTMLSelectElement).value = cur;
}

async function readError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (res.status === 401 || res.status === 404) return 'Sesiunea a expirat sau nu ai acces. Reîncarcă pagina.';
  return [body.error || `Eroare ${res.status}`, ...(body.problems || []).slice(0, 3)].join(' — ');
}

async function load() {
  const res = await fetch(API, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(await readError(res));
  render((await res.json()) as Summary);
}

async function refresh(btn: HTMLButtonElement) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Se actualizează…';
  try {
    const res = await fetch(`${API}/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error(await readError(res));
    const r = (await res.json()) as { status: MarketStatus };
    const failed = Object.values(r.status.instruments).filter(i => !i.ok && i.symbol).length;
    toast(failed || !r.status.fx.ok ? 'Actualizat, cu erori — vezi tabelul.' : 'Prețuri și cursuri actualizate.', failed || !r.status.fx.ok ? 'err' : 'ok');
    await load();
  } catch (e) {
    toast((e as Error).message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveOverride(form: HTMLFormElement, remove: boolean) {
  const f = new FormData(form);
  const raw = String(f.get('close') || '').replace(',', '.');
  const close = remove ? null : Number(raw);
  if (!remove && !(close! > 0)) { toast('Introdu un preț mai mare decât 0.', 'err'); return; }
  const body = { instrumentId: String(f.get('instrumentId')), date: String(f.get('date')), close, currency: String(f.get('currency')) };
  try {
    const res = await fetch(`${API}/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await readError(res));
    toast(remove ? 'Prețul manual a fost șters.' : 'Prețul manual a fost salvat.');
    if (!remove) (form.elements.namedItem('close') as HTMLInputElement).value = '';
    await load();
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

if (card) {
  const btn = document.getElementById('refreshBtn') as HTMLButtonElement;
  btn.addEventListener('click', () => refresh(btn));
  const form = document.getElementById('overrideForm') as HTMLFormElement;
  form.addEventListener('submit', e => { e.preventDefault(); saveOverride(form, false); });
  document.getElementById('overrideRemove')!.addEventListener('click', () => saveOverride(form, true));
  (form.elements.namedItem('instrumentId') as HTMLSelectElement).addEventListener('change', () => syncCurrency(form));
  load().catch(e => {
    document.getElementById('mkState')!.textContent = (e as Error).message;
  });
}
