// /vault/invest/ — dashboard (Phase 7). The most important numbers first, one list of alerts (IPS rules,
// George's drawdown levels, stale prices), net worth over time by asset class. Everything is computed with the
// existing modules; documents and market years are fetched once and shared with the other cards on the page.
// Fast first paint: the numbers come first; the chart (one valuation per month-end) is computed afterwards.
import type { EChartsCoreOption } from 'echarts/core';
import { loadDocOnce, loadMarketOnce, loadMarketSummary, saveDoc, type Loaded } from './api';
import { axisStyle, emptyChart, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { toast, fmtDateTime } from './common';
import { collectIpsAlerts } from './ips-alerts';
import type { Summary as MarketSummary } from './market';
import { emptyData, type InvestData } from '../../lib/invest/types';
import { manualFx, chainFx } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { activeIpsRules } from '../../lib/invest/ips-checks';
import { netWorthAt, firstNetWorthDate, seriesDates, monthlyExpenses, emergencyStatus } from '../../lib/invest/networth';
import {
  portfolioAt, portfolioFlows, firstActivity, monthEnds, driftOf, fiProgress, netWorthComposition,
  COMPOSITION_KEYS, COMPOSITION_LABEL, type ValueSources,
} from '../../lib/invest/report';
import { twr } from '../../lib/invest/returns';
import { belowHigh, deepestLevel, type HistoryIndex, type IpsLevels } from '../../lib/invest/drawdown';
import { levelsForInstrument, type AlertSettings } from '../../lib/invest/alerts';
import type { PricesYear } from '../../lib/invest/market';
import { eur, ron, pct, NF1, NF0, axisMoney, el, byId, trendClass, fmtDate, chip } from './report-ui';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function setKpi(key: string, value: string, note?: string, cls = '') {
  const dd = document.querySelector<HTMLElement>(`[data-db="${key}"]`);
  if (!dd) return;
  dd.textContent = value;
  dd.className = cls;
  if (note) dd.append(el('small', note));
}

// ─── "Datele tale" (create the empty data file the first time) ───

function showStore(loaded: Loaded<'data'>) {
  const set = (k: string, v: string) => { $(`[data-stat="${k}"]`).textContent = v; };
  set('accounts', String(loaded.doc.accounts.length));
  set('instruments', String(loaded.doc.instruments.length));
  set('transactions', String(loaded.doc.transactions.length));
  set('saved', loaded.saved ? fmtDateTime(loaded.saved) : '—');
  $('#storeState').textContent = loaded.exists ? 'Fișierul de date există și se încarcă corect.' : 'Încă nu există date salvate.';
  $('#initBtn').hidden = loaded.exists;
}

function bindInit(loaded: Loaded<'data'>) {
  $('#initBtn').addEventListener('click', async () => {
    try {
      const saved = await saveDoc('data', loaded, emptyData());
      showStore(saved);
      toast('Fișierul de date a fost creat.');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast((e as Error).message, 'err'); }
  });
}

// ─── Alerts ───

interface DbAlert { level: 'warn' | 'info'; title: string; detail?: string; href?: string; source: string }

function renderAlerts(alerts: DbAlert[], notes: string[]) {
  const list = byId('dbAlerts')!;
  const state = byId('dbAlertsState')!;
  const sorted = [...alerts].sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1));
  list.replaceChildren(...sorted.map(a => {
    const li = el('li', null, 'db-alert');
    li.append(chip(a.level === 'warn' ? 'warn' : 'na', a.level === 'warn' ? '! ' + a.source : 'i ' + a.source), el('strong', a.title));
    if (a.detail) li.append(el('span', a.detail));
    if (a.href && a.href !== location.pathname) { const l = el('a', 'Deschide →'); l.href = a.href; const s = el('span'); s.append(l); li.append(s); }
    return li;
  }));
  const warns = sorted.filter(a => a.level === 'warn').length;
  state.textContent = [warns ? `${warns} ${warns === 1 ? 'lucru de verificat' : 'lucruri de verificat'}.` : 'Nimic urgent.', ...notes].join(' ');
}

interface AlertsApi { settings: AlertSettings; ips: IpsLevels | null; history: HistoryIndex }

/** George's drawdown levels crossed today (same rules as the Scăderi page and the e-mail alerts). */
async function drawdownAlerts(summary: MarketSummary, priceDocs: PricesYear[], held: Set<string>, today: string): Promise<DbAlert[]> {
  const res = await fetch('/vault/api/invest/alerts', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) return [];
  const info = (await res.json()) as AlertsApi;
  const out: DbAlert[] = [];
  const yearAgo = `${+today.slice(0, 4) - 1}${today.slice(4)}`;
  for (const row of summary.instruments) {
    if (!held.has(row.id) || !row.latest) continue;
    const { levels } = levelsForInstrument(info.settings, info.ips, row.id);
    if (!levels.length) continue;
    let high = 0;
    const h = info.history.instruments[row.id];
    if (info.settings.drawdown.basis === 'ath' && h?.ok) high = h.ath.close;
    for (const doc of priceDocs) {
      for (const [date, p] of Object.entries(doc.prices[row.id] ?? {})) {
        if (info.settings.drawdown.basis === 'high52' && date < yearAgo) continue;
        if (p.close > high) high = p.close;
      }
    }
    if (!(high > 0)) continue;
    const below = belowHigh(row.latest.close, high);
    const hit = deepestLevel(below, levels);
    if (!hit) continue;
    out.push({
      level: 'warn', source: 'Scăderi', href: '/vault/invest/oportunitati/',
      title: `${row.ticker || row.name} e la −${pct(below)} sub maxim${info.settings.drawdown.basis === 'high52' ? 'ul pe 52 de săptămâni' : ''}`,
      detail: `Ai trecut de nivelul tău de −${pct(hit)}.`,
    });
  }
  return out;
}

function staleAlerts(summary: MarketSummary, held: Set<string>): DbAlert[] {
  const rows = summary.instruments.filter(r => held.has(r.id) && r.priceSource && r.priceSource !== 'manual' && r.stale);
  if (!rows.length) return [];
  return [{
    level: 'warn', source: 'Prețuri', href: '#market',
    title: rows.length === 1 ? `Preț vechi: ${rows[0].ticker || rows[0].name}` : `${rows.length} instrumente au prețul vechi`,
    detail: rows.slice(0, 4).map(r => `${r.ticker || r.name}${r.latest ? ` (${fmtDate(r.latest.date)})` : ' (fără preț)'}`).join(', '),
  }];
}

// ─── Net worth chart ───

function renderNetWorthChart(data: InvestData, src: ValueSources, today: string) {
  const first = firstNetWorthDate(data);
  const elc = byId('dbNwChart')!;
  if (!first) { chartIn(elc, t => emptyChart(t, 'Încă nu există date')); return; }
  const dates = seriesDates(first, today, 72);
  const pts = dates.map(d => netWorthComposition(data, src, d));
  const keys = COMPOSITION_KEYS.filter(k => pts.some(p => Math.abs(p.parts[k]) >= 0.5));
  const labels = dates.map(d => (d === today ? 'azi' : `${d.slice(5, 7)}.${d.slice(2, 4)}`));
  chartIn(elc, (t: ChartTheme): EChartsCoreOption => ({
    legend: { top: 0, data: [...keys.map(k => COMPOSITION_LABEL[k]), 'Avere netă'] },
    grid: { left: 8, right: 16, top: 56, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => eur(Number(v)) },
    xAxis: { type: 'category', data: labels, boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
    series: [
      ...keys.map(k => ({
        name: COMPOSITION_LABEL[k], type: 'line', stack: k === 'debts' ? 'debt' : 'assets', showSymbol: false,
        color: t.series[COMPOSITION_KEYS.indexOf(k)], lineStyle: { width: 1 }, areaStyle: { opacity: 0.75 },
        data: pts.map(p => Math.round(p.parts[k])),
      })),
      {
        name: 'Avere netă', type: 'line', showSymbol: false, color: t.text, lineStyle: { width: 2, type: 'dashed' }, z: 10,
        data: pts.map(p => Math.round(p.netEur)),
      },
    ],
  }));
  const last = pts[pts.length - 1];
  const firstPt = pts.find(p => Math.abs(p.netEur) >= 0.5) ?? pts[0];
  byId('dbNwNote')!.textContent = `Sfârșit de lună, în EUR. De la ${fmtDate(firstPt.date)}: ${eur(firstPt.netEur)} → ${eur(last.netEur)}. Pozițiile fără preț la o dată sunt la cost. Detalii pe pagina Avere netă.`;
}

// ─── Main ───

async function main() {
  const today = todayIso();
  byId('dbDate')!.textContent = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'full' }).format(new Date());
  const state = byId('dbState')!;
  let loaded: Loaded<'data'>;
  try { loaded = await loadDocOnce('data'); } catch (e) { state.textContent = (e as Error).message; return; }
  showStore(loaded);
  bindInit(loaded);
  const data = loaded.doc;

  const first = firstNetWorthDate(data);
  if (!first) {
    state.textContent = 'Încă nu ai date. Începe cu Portofoliu (conturi, instrumente, tranzacții) sau Avere netă.';
    byId('dbAlertsState')!.textContent = 'Nimic de verificat încă.';
    renderNetWorthChart(data, { fx: manualFx([]), prices: manualPrices([]) }, today);
    return;
  }

  const year = +today.slice(0, 4);
  const years: number[] = [];
  for (let y = +first.slice(0, 4) - 1; y <= year; y++) years.push(y);
  const [ipsDoc, market, summary] = await Promise.all([
    loadDocOnce('ips').catch(() => null),
    loadMarketOnce(years),
    loadMarketSummary<MarketSummary>().catch(() => null),
  ]);
  const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
  const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
  const src: ValueSources = { fx, prices };
  const ips = ipsDoc?.exists ? activeIpsRules(ipsDoc.doc)?.rules ?? null : null;

  // Net worth + emergency fund
  const nw = netWorthAt(data, { fx, prices, emergencyAccountIds: ips?.emergencyFund?.accountIds ?? [] }, today);
  const ef = emergencyStatus(nw, monthlyExpenses(data.netWorth, ips), ips);
  setKpi('networth', eur(nw.netEur), `${ron(nw.netRon)}${ef.months !== null ? ` · fond de urgență ${NF1.format(ef.months)} luni` : ''}`, nw.netEur < 0 ? 'is-down' : '');

  // Portfolio (no Pillar 2/3), FI
  const port = portfolioAt(data, src, today);
  setKpi('portfolio', eur(port.eur), port.atCost ? `fără Pilon 2/3 · ${port.atCost} la cost` : 'fără Pilon 2/3');
  const fi = fiProgress(data.settings, data.targets, year, port.eur);
  if (fi) {
    setKpi('fi', pct(fi.progress), `din ${eur(fi.fiNumber)}`);
    setKpi('yearsFi', fi.yearsToFI === null ? '—' : fi.yearsToFI === 0 ? 'atins' : NF1.format(fi.yearsToFI), fi.yearsToFI === null ? 'completează Planul' : `vârsta ${data.settings.birthYear ? NF0.format(year - data.settings.birthYear + (fi.yearsToFI ?? 0)) : '—'}`);
  } else {
    setKpi('fi', '—', 'completează Planul');
    setKpi('yearsFi', '—', 'completează Planul');
  }

  // Return since 1 January (time-weighted, month-ends of this year)
  const fa = firstActivity(data);
  if (fa) {
    const dates = monthEnds(fa > `${year}-01-01` ? fa : `${year}-01-01`, today);
    const points = dates.map(d => ({ date: d, value: portfolioAt(data, src, d).eur }));
    const r = twr(points, portfolioFlows(data, fx).flows);
    setKpi('ytd', pct(r.value, true), 'ponderat în timp', trendClass(r.value));
  } else setKpi('ytd', '—');

  // Drift
  const drift = driftOf(port.holdings, data.targets);
  if (drift?.rows.length) {
    const worst = drift.rows.reduce((m, r) => (Math.abs(r.diff) > Math.abs(m.diff) ? r : m));
    const out = drift.rows.filter(r => r.status !== 'ok').length;
    setKpi('drift', `${NF1.format(Math.abs(worst.diff) * 100)} pp`, out ? `${out} ${out === 1 ? 'rând' : 'rânduri'} în afara benzii` : `maxim la „${worst.target.label}”, în bandă`, out ? 'is-down' : '');
  } else setKpi('drift', '—', 'fără țintă de alocare');

  // Prices
  const held = new Set(port.holdings.map(h => h.instrumentId).filter((x): x is string => !!x));
  if (summary) {
    const auto = summary.instruments.filter(r => held.has(r.id) && r.priceSource && r.priceSource !== 'manual');
    const stale = auto.filter(r => r.stale).length;
    setKpi('prices', summary.status?.lastRun ? fmtDateTime(summary.status.lastRun) : 'niciodată',
      !auto.length ? 'fără prețuri automate' : stale ? `${stale} cu preț vechi` : 'toate la zi', stale ? 'is-down' : '');
  }
  state.textContent = nw.missingFx.length ? `Lipsește cursul pentru ${nw.missingFx.join(', ')}; acele valori nu intră în total.` : '';
  state.hidden = !state.textContent;

  // Alerts: IPS + drawdown levels + stale prices
  const notes: string[] = [];
  const [ipsRes, dd] = await Promise.all([
    collectIpsAlerts().catch(e => ({ alerts: [], summary: `Regulile IPS nu au putut fi verificate: ${(e as Error).message}` })),
    summary ? drawdownAlerts(summary, market.prices, held, today).catch(() => []) : Promise.resolve([]),
  ]);
  notes.push(ipsRes.summary);
  const alerts: DbAlert[] = [
    ...ipsRes.alerts.map(a => ({ level: a.level, title: a.title, detail: a.detail, href: a.href, source: 'IPS' })),
    ...dd,
    ...(summary ? staleAlerts(summary, held) : []),
  ];
  renderAlerts(alerts, notes);

  // Chart last (one valuation per month-end)
  setTimeout(() => {
    try { renderNetWorthChart(data, src, today); } catch (e) { byId('dbNwNote')!.textContent = (e as Error).message; }
  }, 0);
}

void main();
