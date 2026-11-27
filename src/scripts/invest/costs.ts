// /vault/invest/costuri/ — broker fees per year, fund costs (TER) on today's holdings, long-term cost drag.
import type { EChartsCoreOption } from 'echarts/core';
import { loadDoc, saveDoc, loadMarketOnce, type Loaded } from './api';
import { toast } from './common';
import { axisStyle, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { manualFx, chainFx } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { firstNetWorthDate } from '../../lib/invest/networth';
import { portfolioAt, type PortfolioPoint } from '../../lib/invest/report';
import { feesByYear, terCosts, costDrag } from '../../lib/invest/costs';
import { inputsFromSettings, portfolioStats } from '../../lib/invest/projection';
import type { FxSource } from '../../lib/invest/fx';
import { eur, pct, NF0, NF1, el, byId, kpi, row, axisMoney } from './report-ui';

let loaded: Loaded<'data'>;
let fx: FxSource;
let point: PortfolioPoint;
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const NF2 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Small percentages (costs) with two decimals */
const pct2 = (x: number | null) => (x === null ? '—' : `${NF2.format(x * 100)}%`);
/** Decimal → percent text for an input (0.0022 → "0,22") */
const pctInput = (x: number) => String(Math.round(x * 1e6) / 1e4).replace('.', ',');
const num = (s: string) => { const t = s.replace(/\s/g, '').replace(',', '.'); return t === '' ? null : Number(t); };

function render() {
  const data = loaded.doc;
  const ter = terCosts(point.holdings, data.instruments);
  const fees = feesByYear(data, fx);
  const year = +today.slice(0, 4);
  const lastFull = fees.get(year - 1)?.eur ?? null;
  const feeRate = lastFull !== null && point.eur > 0 ? lastFull / point.eur : 0;
  // Fund costs and last year's broker fees, as a share of the whole portfolio (cash included)
  const costRate = (point.eur > 0 ? ter.costEur / point.eur : 0) + feeRate;

  byId('coKpis')!.replaceChildren(
    kpi('Cost fonduri pe an', eur(ter.costEur), { hero: true, note: ter.weightedTer === null ? 'notează TER-urile mai jos' : `TER mediu ${pct2(ter.weightedTer)} pe ${eur(ter.knownValue)}` }),
    kpi(`Comisioane ${year - 1}`, eur(lastFull), { note: feeRate ? `${pct2(feeRate)} din portofoliu` : undefined }),
    kpi(`Comisioane ${year}`, eur(fees.get(year)?.eur ?? 0), { note: 'până azi' }),
    kpi('Cost total pe an', pct2(costRate), { note: 'TER + comisioane anul trecut, ca % din portofoliu' }),
  );

  const insts = new Map(data.instruments.map(i => [i.id, i]));
  byId<HTMLTableElement>('coTer')!.tBodies[0].replaceChildren(...ter.rows.map(r => {
    const i = insts.get(r.instrumentId);
    const input = el('input');
    input.type = 'text'; input.inputMode = 'decimal'; input.name = `ter:${r.instrumentId}`; input.autocomplete = 'off';
    input.value = r.ter === null ? '' : pctInput(r.ter);
    input.setAttribute('aria-label', `TER pentru ${i?.ticker || i?.name || r.instrumentId}`);
    return row(i ? (i.ticker ? `${i.ticker} · ${i.name}` : i.name) : r.instrumentId, [eur(r.valueEur), input, r.costEur === null ? '—' : eur(r.costEur)]);
  }));

  byId<HTMLTableElement>('coFees')!.tBodies[0].replaceChildren(...[...fees].sort((a, b) => b[0] - a[0]).map(([y, f]) =>
    row(String(y), [eur(f.eur), `${NF0.format(f.count)}${f.missing ? ` (+${f.missing} fără curs)` : ''}`])));

  // Long-term inputs: plan values as defaults
  const form = byId<HTMLFormElement>('coDragForm')!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const plan = inputsFromSettings(data.settings, data.targets, year, point.eur);
  const ret = plan.inputs?.realReturn ?? (Object.keys(plan.weights).length ? portfolioStats(plan.weights, data.settings.projection?.assumptions).ret : null);
  if (!f('years').value) f('years').value = String(data.settings.yearsToInvest ?? 20);
  if (!f('ret').value && ret !== null) f('ret').value = NF1.format(ret * 100);
  if (!f('monthly').value) f('monthly').value = String(data.settings.monthlyContribution ?? 0);
  if (!f('cost').value) f('cost').value = pctInput(costRate);
  drag();
}

function drag() {
  const form = byId<HTMLFormElement>('coDragForm')!;
  const v = (n: string) => num((form.elements.namedItem(n) as HTMLInputElement).value);
  const years = Math.round(v('years') ?? 0), ret = v('ret'), monthly = v('monthly') ?? 0, cost = v('cost') ?? 0;
  const note = byId('coDragNote')!;
  if (!(years > 0 && years <= 60) || ret === null) { note.textContent = 'Completează anii (1–60) și randamentul real așteptat.'; return; }
  const d = costDrag({ start: point.eur, monthly, years, realReturn: ret / 100, costRate: cost / 100 });
  note.textContent = `În ${years} ani, costurile de ${NF2.format(cost)}% pe an iau ≈ ${eur(d.lost)} (${pct(d.lostShare)} din valoarea finală, în banii de azi). Randamentul real devine ${pct(d.netReturn)}. Ipotezele sunt cele din Plan; schimbă-le aici ca să compari.`;
  const labels = d.gross.map((_, i) => String(i));
  chartIn(byId('coChart')!, (t: ChartTheme): EChartsCoreOption => ({
    legend: { top: 0, data: ['Fără costuri', 'Cu costuri'] },
    tooltip: { trigger: 'axis', valueFormatter: (x: unknown) => eur(Number(x)) },
    xAxis: { type: 'category', data: labels, name: 'ani', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: t.muted }, boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
    series: [
      { name: 'Fără costuri', type: 'line', showSymbol: false, color: t.series[0], data: d.gross.map(Math.round) },
      { name: 'Cu costuri', type: 'line', showSymbol: false, color: t.series[1], data: d.withCosts.map(Math.round), areaStyle: { opacity: 0.08 } },
    ],
  }));
}

async function saveTer(e: SubmitEvent) {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const problems: string[] = [];
  const next = loaded.doc.instruments.map(i => {
    const input = form.elements.namedItem(`ter:${i.id}`) as HTMLInputElement | null;
    if (!input) return i;
    const v = num(input.value);
    const out = { ...i };
    if (v === null) delete out.ter;
    else if (!Number.isFinite(v) || v < 0 || v > 20) problems.push(`${i.ticker || i.name}: TER între 0 și 20%`);
    else out.ter = Math.round(v * 1e4) / 1e6;
    return out;
  });
  if (problems.length) { toast(problems.join('; '), 'err'); return; }
  try {
    loaded = await saveDoc('data', loaded, { ...loaded.doc, instruments: next });
    toast('TER-urile au fost salvate.');
    (byId<HTMLFormElement>('coDragForm')!.elements.namedItem('cost') as HTMLInputElement).value = '';
    render();
  } catch (err) { toast((err as Error).message, 'err'); }
}

(async () => {
  const state = byId('coState')!;
  try {
    loaded = await loadDoc('data');
    const data = loaded.doc;
    const first = firstNetWorthDate(data);
    if (!first) { state.textContent = 'Încă nu ai tranzacții în Portofoliu.'; return; }
    const years: number[] = [];
    for (let y = +first.slice(0, 4); y <= +today.slice(0, 4); y++) years.push(y);
    const market = await loadMarketOnce(years);
    fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
    const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
    point = portfolioAt(data, { fx, prices }, today);
    state.hidden = true;
    byId('coBody')!.hidden = false;
    render();
    byId<HTMLFormElement>('coTerForm')!.addEventListener('submit', saveTer);
    byId<HTMLFormElement>('coDragForm')!.addEventListener('submit', ev => { ev.preventDefault(); drag(); });
  } catch (e) {
    state.textContent = (e as Error).message;
  }
})();
