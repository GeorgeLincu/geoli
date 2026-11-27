// /vault/invest/oportunitati/ — "Scădere de la maxim" table, underwater chart, e-mail alert settings.
// Maths in src/lib/invest/drawdown.ts; settings/validation in alerts.ts; API in worker/alerts.ts.
import { toast, fmtDateTime } from './common';
import { loadDoc, loadMarket } from './api';
import { mountChart, axisStyle, type ChartTheme } from './charts';
import type { EChartsCoreOption } from 'echarts/core';
import {
  seriesFor, drawdownStats, drawdownEpisodes, underwater, deepestLevel,
  type DrawdownStats, type DipLevel, type HistoryDoc, type HistoryIndex, type Point, type IpsLevels,
} from '../../lib/invest/drawdown';
import { parsePriceSource } from '../../lib/invest/market';
import { levelsForInstrument, type AlertSettings, type AlertLogEntry } from '../../lib/invest/alerts';
import { CURRENCIES, type Currency, type Instrument } from '../../lib/invest/types';

interface AlertsResponse {
  settings: AlertSettings; saved: boolean;
  /** IPS crash rules: apply only to ips.instrumentId */
  ips: IpsLevels | null; ipsTaxDeadline: string | null; duDate: string;
  state: { lastRun: string | null; log: AlertLogEntry[] };
  history: HistoryIndex;
  email: { configured: boolean; to: string; from: string };
  testWaitMs: number;
}

interface Row { inst: Instrument; series: Point[]; stats: DrawdownStats | null; historyNote?: string }

const API = '/vault/api/invest/alerts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const nf = (min: number, max: number) => new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max });
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const fmtPct = (f: number) => `${nf(1, 1).format(f * 100)} %`;
const fmtPrice = (n: number, c: string) => `${nf(2, n < 10 ? 4 : 2).format(n)} ${c}`;
const fmtMoney = (n: number, c: string) => `${nf(0, 2).format(n)} ${c}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await res.json().catch(() => ({})) as T & { error?: string; problems?: string[] };
  if (!res.ok) throw new Error([body.error || `Eroare ${res.status}`, ...(body.problems ?? []).slice(0, 3)].join(': '));
  return body;
}

// ───────────── State ─────────────

let info: AlertsResponse;
let rows: Row[] = [];
let allInstruments: Instrument[] = [];
let basis: 'ath' | 'high52' = 'ath';
let sortKey = 'belowAth';
let sortDir: 1 | -1 = -1;
let selected = '';
let chart: ReturnType<typeof mountChart> | null = null;
type Theme = ChartTheme;
let currentBuild: ((t: Theme) => EChartsCoreOption) | null = null;

/** Levels for one instrument: IPS rules for the IPS reference instrument, the page's own for the rest. */
const levelsOf = (id: string) => (info ? levelsForInstrument(info.settings, info.ips, id) : { levels: [] as DipLevel[], source: 'settings' as const });
const ipsApplies = () => !!(info?.settings.drawdown.useIps && info.ips?.instrumentId && info.ips.levels.length);
const instName = (id: string | null) => allInstruments.find(i => i.id === id)?.name ?? id ?? '';
const below = (r: Row) => (r.stats ? (basis === 'ath' ? r.stats.belowAth : r.stats.below52) : -1);
const lvlText = (l: DipLevel) => `−${nf(0, 1).format(l.pct * 100)} %${l.extraAmount ? ` · +${fmtMoney(l.extraAmount, l.currency ?? 'EUR')}` : ''}`;

// ───────────── Load ─────────────

async function load() {
  const today = new Date().toISOString().slice(0, 10);
  const y = Number(today.slice(0, 4));
  const [alerts, data] = await Promise.all([api<AlertsResponse>(''), loadDoc('data')]);
  info = alerts;
  allInstruments = data.doc.instruments;
  basis = info.settings.drawdown.basis;
  const instruments = data.doc.instruments.filter(i => parsePriceSource(i.priceSource));
  const txYears = data.doc.transactions.map(t => Number(t.date.slice(0, 4))).filter(n => n >= 2000 && n <= y);
  const years = [...new Set([y - 2, y - 1, y, ...txYears])].sort();
  const [market, histories] = await Promise.all([
    loadMarket(years),
    Promise.all(instruments.map(async i => {
      if (!info.history.instruments[i.id]?.ok) return null;
      const h = await api<HistoryDoc & { missing?: boolean }>(`/history/${encodeURIComponent(i.id)}`).catch(() => null);
      return h && !h.missing ? h : null;
    })),
  ]);
  rows = instruments.map((inst, k) => {
    const series = seriesFor(inst.id, histories[k], market.prices);
    const idx = info.history.instruments[inst.id];
    const historyNote = !idx ? 'istoric lung nedescărcat' : !idx.ok ? `istoric: ${idx.message ?? 'eroare'}` : undefined;
    return { inst, series, stats: drawdownStats(series), historyNote };
  });
  if (!selected || !rows.some(r => r.inst.id === selected)) {
    selected = [...rows].filter(r => r.stats).sort((a, b) => below(b) - below(a))[0]?.inst.id ?? '';
  }
  renderAll();
  fillForm(info.settings);
}

function renderAll() {
  renderLevels();
  renderTable();
  renderChart();
  renderStatus();
}

// ───────────── Table ─────────────

function chips(ls: readonly DipLevel[]) {
  return ls.map((l, i) => {
    const li = el('li', lvlText(l), `dd-chip dd-lvl-${Math.min(i + 1, 5)}`);
    if (l.note) li.title = l.note;
    return li;
  });
}

function renderLevels() {
  const ul = $('ddLevels');
  const own = info.settings.drawdown.levels;
  const items: HTMLElement[] = [];
  if (own.length) items.push(el('li', 'Pragurile tale:', 'dd-levels__label'), ...chips(own));
  if (ipsApplies()) items.push(el('li', `Din IPS (${fmtDate(info.ips!.versionDate)}), doar pentru ${instName(info.ips!.instrumentId)}:`, 'dd-levels__label'), ...chips(info.ips!.levels));
  ul.replaceChildren(...items);
  ul.hidden = !items.length;
}

const SORTS: Record<string, (r: Row) => number | string> = {
  name: r => r.inst.name.toLocaleLowerCase('ro'),
  last: r => r.stats?.last.close ?? -1,
  ath: r => r.stats?.ath.close ?? -1,
  belowAth: r => r.stats?.belowAth ?? -1,
  high52: r => r.stats?.high52.close ?? -1,
  below52: r => r.stats?.below52 ?? -1,
  maxDd: r => r.stats?.maxDrawdown?.depth ?? -1,
  level: r => (r.stats ? deepestLevel(below(r), levelsOf(r.inst.id).levels) * 10 + below(r) : -1),
};

function renderTable() {
  const table = $<HTMLTableElement>('ddTable');
  const state = $('ddState');
  const sorted = [...rows].sort((a, b) => {
    const x = SORTS[sortKey](a), y = SORTS[sortKey](b);
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });
  table.tBodies[0].replaceChildren(...sorted.map(rowEl));
  table.hidden = !rows.length;
  for (const th of table.tHead!.querySelectorAll('th')) {
    const k = th.querySelector('button')?.dataset.sort;
    th.setAttribute('aria-sort', k === sortKey ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-basis]')) b.setAttribute('aria-pressed', String(b.dataset.basis === basis));

  const missing = rows.filter(r => r.historyNote).length;
  const parts: string[] = [];
  if (!rows.length) parts.push('Niciun instrument cu sursă automată de preț. Adaugă sursa (ex. „xetra:VWCE”) în Portofoliu → Instrumente.');
  if (missing) parts.push(`${missing} ${missing === 1 ? 'instrument nu are' : 'instrumente nu au'} încă istoricul lung (maximul istoric poate lipsi sau fi doar din ultimele luni).`);
  if (!info.settings.drawdown.levels.length && !ipsApplies()) parts.push('Nu ai definit praguri: le poți adăuga mai jos, la „Alerte pe e-mail” (sau în IPS, pentru instrumentul de referință).');
  else parts.push(`Pragurile se aplică față de ${basis === 'ath' ? 'maximul istoric' : 'maximul pe 52 de săptămâni'}.`);
  state.textContent = parts.join(' ');
  $('histBtn').hidden = !missing;
}

function rowEl(r: Row) {
  const tr = el('tr');
  const s = r.stats;
  const name = el('td', null, 'dd-name');
  const btn = el('button', r.inst.name, 'dd-link');
  btn.type = 'button';
  btn.title = 'Arată graficul';
  btn.addEventListener('click', () => { selected = r.inst.id; ($<HTMLSelectElement>('uwSelect')).value = selected; renderChart(); $('uwCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  name.append(btn);
  if (r.inst.ticker) name.append(' ', el('small', r.inst.ticker));
  if (r.historyNote) name.append(el('span', r.historyNote, 'dd-note'));
  tr.append(name);
  if (!s) {
    const td = el('td', 'fără prețuri încă', 'dd-muted');
    td.colSpan = 7;
    tr.append(td);
    return tr;
  }
  const cur = info.history.instruments[r.inst.id]?.currency ?? r.inst.currency;
  const withDate = (txt: string, date: string) => { const td = el('td', null, 'dd-num'); td.append(txt, el('small', fmtDate(date))); return td; };
  tr.append(
    withDate(fmtPrice(s.last.close, cur), s.last.date),
    withDate(fmtPrice(s.ath.close, cur), s.ath.date),
    el('td', s.belowAth > 0 ? `−${fmtPct(s.belowAth)}` : 'la maxim', `dd-num dd-pct${basis === 'ath' ? ' is-basis' : ''}`),
    withDate(fmtPrice(s.high52.close, cur), s.high52.date),
    el('td', s.below52 > 0 ? `−${fmtPct(s.below52)}` : 'la maxim', `dd-num dd-pct${basis === 'high52' ? ' is-basis' : ''}`),
  );
  const md = el('td', null, 'dd-num');
  if (s.maxDrawdown) md.append(`−${fmtPct(s.maxDrawdown.depth)}`, el('small', `${fmtDate(s.maxDrawdown.peak.date)} → ${fmtDate(s.maxDrawdown.trough.date)}`));
  else md.textContent = '—';
  tr.append(md);

  const lvTd = el('td', null, 'dd-level');
  const b = below(r);
  const { levels: ls, source } = levelsOf(r.inst.id);
  if (source === 'ips') lvTd.append(el('small', 'regulă din IPS'));
  const hit = deepestLevel(b, ls);
  if (hit) {
    const i = ls.findIndex(l => l.pct === hit);
    const lvl = ls[i];
    tr.classList.add('dd-row-hit', `dd-lvl-${Math.min(i + 1, 5)}`);
    lvTd.append(el('span', `−${nf(0, 1).format(hit * 100)} % atins`, `dd-chip dd-lvl-${Math.min(i + 1, 5)}`));
    if (lvl.extraAmount) lvTd.append(el('small', `plan: +${fmtMoney(lvl.extraAmount, lvl.currency ?? 'EUR')}`));
    if (lvl.note) lvTd.append(el('small', lvl.note));
  }
  const next = ls.find(l => l.pct > b + 1e-9);
  if (next) lvTd.append(el('small', `următorul: −${nf(0, 1).format(next.pct * 100)} % (încă ${nf(1, 1).format((next.pct - b) * 100)} p.p.)`));
  if (!ls.length) lvTd.textContent = '—';
  tr.append(lvTd);
  return tr;
}

// ───────────── Underwater chart ─────────────

function renderChart() {
  const card = $('uwCard');
  const withData = rows.filter(r => r.stats);
  card.hidden = !withData.length;
  if (!withData.length) return;
  const sel = $<HTMLSelectElement>('uwSelect');
  sel.replaceChildren(...withData.map(r => { const o = el('option', r.inst.ticker ? `${r.inst.name} (${r.inst.ticker})` : r.inst.name); o.value = r.inst.id; return o; }));
  if (!withData.some(r => r.inst.id === selected)) selected = withData[0].inst.id;
  sel.value = selected;
  const row = withData.find(r => r.inst.id === selected)!;
  const uw = underwater(row.series).map(p => [p.date, -Math.round(p.dd * 10_000) / 100] as [string, number]);
  const ls = levelsOf(row.inst.id).levels;

  const build = (t: Theme): EChartsCoreOption => ({
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => `${nf(1, 1).format(Number(v))} %`,
    },
    xAxis: { type: 'time', ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', max: 0, ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${v} %` } },
    series: [{
      name: 'Sub maxim', type: 'line', data: uw, showSymbol: false, sampling: 'lttb',
      lineStyle: { width: 1.5, color: t.err }, areaStyle: { color: t.err, opacity: 0.18 },
      markLine: ls.length ? {
        silent: true, symbol: 'none',
        lineStyle: { type: 'dashed', color: t.warn },
        label: { color: t.muted, formatter: (p: { value: number }) => `${p.value} %`, position: 'insideEndTop' },
        data: ls.map(l => ({ yAxis: -Math.round(l.pct * 1000) / 10 })),
      } : undefined,
    }],
  });
  // mountChart keeps the builder it was created with (re-run on theme change): route it to the current one
  currentBuild = build;
  if (!chart) chart = mountChart($('uwChart'), t => (currentBuild ? currentBuild(t) : {}));
  else chart.update();

  const eps = drawdownEpisodes(row.series, 0.05).slice(0, 5);
  const body = $<HTMLTableElement>('epTable').tBodies[0];
  body.replaceChildren(...(eps.length ? eps.map(e => {
    const tr = el('tr');
    const end = e.recovery ?? row.series[row.series.length - 1].date;
    const days = Math.round((Date.parse(end) - Date.parse(e.peak.date)) / 86_400_000);
    tr.append(
      el('td', fmtDate(e.peak.date)), el('td', fmtDate(e.trough.date)),
      el('td', `−${fmtPct(e.depth)}`, 'dd-num'),
      el('td', e.recovery ? fmtDate(e.recovery) : 'încă nu'),
      el('td', `${nf(0, 0).format(days)} zile${e.recovery ? '' : '+'}`, 'dd-num'),
    );
    return tr;
  }) : [(() => { const tr = el('tr'); const td = el('td', 'Nicio scădere de peste 5 % în datele disponibile.', 'dd-muted'); td.colSpan = 5; tr.append(td); return tr; })()]));
}


// ───────────── Alert settings form ─────────────

const form = $<HTMLFormElement>('alForm');
const f = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as T;

function levelRow(l?: DipLevel) {
  const tr = el('tr');
  const pct = el('input'); pct.type = 'number'; pct.min = '1'; pct.max = '99'; pct.step = 'any'; pct.inputMode = 'decimal'; pct.name = 'lvPct';
  pct.setAttribute('aria-label', 'Prag, procent sub maxim');
  if (l) pct.value = String(Math.round(l.pct * 1000) / 10);
  const amt = el('input'); amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.inputMode = 'decimal'; amt.name = 'lvAmt';
  amt.setAttribute('aria-label', 'Sumă suplimentară planificată (opțional)');
  if (l?.extraAmount) amt.value = String(l.extraAmount);
  const cur = el('select'); cur.name = 'lvCur'; cur.setAttribute('aria-label', 'Moneda');
  for (const c of CURRENCIES) { const o = el('option', c); o.value = c; cur.append(o); }
  cur.value = l?.currency ?? 'EUR';
  const note = el('input'); note.type = 'text'; note.maxLength = 200; note.name = 'lvNote'; note.setAttribute('aria-label', 'Notă (opțional)');
  if (l?.note) note.value = l.note;
  const del = el('button', 'Șterge', 'inv-btn inv-btn--ghost'); del.type = 'button';
  del.addEventListener('click', () => tr.remove());
  for (const [i, c] of [pct, amt, cur, note, del].entries()) { const td = el('td'); td.append(c); if (i === 0) td.className = 'al-pct'; tr.append(td); }
  return tr;
}

function fillForm(s: AlertSettings) {
  f('emailEnabled').checked = s.emailEnabled;
  f('includeAmounts').checked = s.includeAmounts;
  f('ddEnabled').checked = s.drawdown.enabled;
  f<HTMLSelectElement>('basis').value = s.drawdown.basis;
  f('useIps').checked = s.drawdown.useIps;
  $<HTMLTableElement>('lvTable').tBodies[0].replaceChildren(...s.drawdown.levels.map(levelRow));
  f('staleEnabled').checked = s.stale.enabled;
  f('staleDays').value = String(s.stale.days);
  f('duEnabled').checked = s.du.enabled;
  f('duDate').value = s.du.date;
  f('duBefore').value = s.du.daysBefore.join(', ');
  f('matEnabled').checked = s.maturities.enabled;
  f('matDays').value = String(s.maturities.daysAhead);

  const ips = $('ipsLevels');
  const r = info.ips;
  ips.hidden = !r;
  ips.textContent = !r ? ''
    : `În IPS (versiunea din ${fmtDate(r.versionDate)}) ai regulile: ${r.levels.map(lvlText).join(', ')}. `
      + (r.instrumentId
        ? `Se aplică doar pentru ${instName(r.instrumentId)}; celelalte instrumente folosesc pragurile de mai jos.`
        : 'În IPS nu e ales un instrument de referință, deci nu se aplică niciunui instrument.');

  const du = $('duIps');
  du.hidden = !info.ipsTaxDeadline;
  du.textContent = info.ipsTaxDeadline
    ? `Dacă lași data goală, se folosește termenul din IPS: ${fmtDate(info.ipsTaxDeadline)}.`
    : '';
}

function readForm(): AlertSettings {
  const num = (name: string) => Number(f(name).value);
  const lv = [...$<HTMLTableElement>('lvTable').tBodies[0].rows].map(tr => {
    const v = (n: string) => (tr.querySelector(`[name="${n}"]`) as HTMLInputElement).value.trim();
    const l: DipLevel = { pct: Number(v('lvPct').replace(',', '.')) };
    const a = Number(v('lvAmt').replace(',', '.'));
    if (v('lvAmt') && a > 0) { l.extraAmount = a; l.currency = v('lvCur') as Currency; }
    if (v('lvNote')) l.note = v('lvNote');
    return l;
  }).filter(l => l.pct !== 0); // empty rows
  return {
    version: 1,
    emailEnabled: f('emailEnabled').checked,
    includeAmounts: f('includeAmounts').checked,
    drawdown: { enabled: f('ddEnabled').checked, basis: f<HTMLSelectElement>('basis').value as 'ath' | 'high52', useIps: f('useIps').checked, levels: lv },
    stale: { enabled: f('staleEnabled').checked, days: num('staleDays') },
    du: {
      enabled: f('duEnabled').checked, date: f('duDate').value,
      daysBefore: f('duBefore').value.split(/[,;\s]+/).filter(Boolean).map(Number),
    },
    maturities: { enabled: f('matEnabled').checked, daysAhead: num('matDays') },
  };
}

const PROBLEM_RO: [RegExp, string][] = [
  [/levels.*unique/, 'Fiecare prag trebuie să fie un procent unic între 1 și 99.'],
  [/stale\.days/, 'Zilele pentru prețuri vechi: un număr întreg între 2 și 60.'],
  [/du\.date: YYYY/, 'Data Declarației unice nu e validă.'],
  [/du\.daysBefore/, 'Zilele dinainte de termen: 1–5 numere între 0 și 120, separate prin virgulă.'],
  [/maturities/, 'Zilele pentru scadențe: un număr întreg între 1 și 365.'],
];

function renderStatus() {
  $('alTo').textContent = info.email.configured
    ? `E-mailurile pleacă de la ${info.email.from} și ajung doar la ${info.email.to}. Conțin doar nume de instrumente și procente, în afară de cazul în care bifezi „Include prețuri și sume”.`
    : 'Trimiterea de e-mail nu e configurată în Worker (lipsește legătura send_email).';
  $('alLastRun').textContent = info.state.lastRun ? `Ultima verificare automată: ${fmtDateTime(info.state.lastRun)}.` : 'Nicio verificare automată încă (rulează în zilele lucrătoare, după actualizarea prețurilor).';
  $('alLog').replaceChildren(...(info.state.log.length ? info.state.log.slice(0, 10).map(e => {
    const li = el('li', null, e.ok ? '' : 'is-err');
    li.textContent = `${fmtDateTime(e.at)} · ${e.test ? 'test' : e.subject.replace(/^Investiții geoli\.eu: /, '')} · ${e.ok ? 'trimis' : `eșuat: ${e.error ?? ''}`}`;
    return li;
  }) : [el('li', 'Nimic trimis încă.', 'dd-muted')]));
}

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  const msg = $('alMsg');
  const body = readForm();
  try {
    const r = await api<{ settings: AlertSettings }>('/settings', { method: 'PUT', body: JSON.stringify(body) });
    toast('Setările au fost salvate.');
    msg.textContent = '';
    info.settings = r.settings;
    await load();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    const ro = PROBLEM_RO.filter(([re]) => re.test(text)).map(([, t]) => t);
    msg.textContent = ro.length ? ro.join(' ') : text;
    toast('Setările nu au fost salvate.', 'err');
  }
});

$('lvAdd').addEventListener('click', () => {
  const tr = levelRow();
  $<HTMLTableElement>('lvTable').tBodies[0].append(tr);
  tr.querySelector('input')?.focus();
});

$('testBtn').addEventListener('click', async () => {
  const b = $<HTMLButtonElement>('testBtn');
  b.disabled = true;
  try {
    const r = await api<{ to: string }>('/test', { method: 'POST', body: '{}' });
    toast(`E-mail de test trimis la ${r.to}.`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'err');
  } finally {
    b.disabled = false;
    info = await api<AlertsResponse>('').catch(() => info);
    renderStatus();
  }
});

$('histBtn').addEventListener('click', async () => {
  const b = $<HTMLButtonElement>('histBtn');
  b.disabled = true;
  b.textContent = 'Se descarcă…';
  try {
    const r = await api<{ fetched: string[]; remaining: number }>('/history', { method: 'POST', body: '{}' });
    toast(r.remaining ? `Descărcat: ${r.fetched.length}. Mai sunt ${r.remaining}; apasă din nou peste un minut.` : 'Istoricul a fost descărcat.');
    await load();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'err');
  } finally {
    b.disabled = false;
    b.textContent = 'Descarcă istoricul lipsă';
  }
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-basis]')) {
  b.addEventListener('click', () => {
    basis = b.dataset.basis as 'ath' | 'high52';
    if (sortKey === 'belowAth' || sortKey === 'below52') sortKey = basis === 'ath' ? 'belowAth' : 'below52';
    renderTable();
  });
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#ddTable [data-sort]')) {
  b.addEventListener('click', () => {
    const k = b.dataset.sort!;
    if (k === sortKey) sortDir = sortDir === 1 ? -1 : 1;
    else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
    renderTable();
  });
}

$<HTMLSelectElement>('uwSelect').addEventListener('change', e => { selected = (e.target as HTMLSelectElement).value; renderChart(); });

load().catch(e => {
  $('ddState').textContent = e instanceof Error ? e.message : String(e);
  toast('Nu s-au putut încărca datele.', 'err');
});
