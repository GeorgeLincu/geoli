// /vault/invest/rapoarte/ — list of the years with their main figures; saves missing year-end snapshots.
import type { EChartsCoreOption } from 'echarts/core';
import { toast } from './common';
import { axisStyle, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { loadReportContext, ensureSnapshots, snapshotOf, saveData, type ReportContext } from './report-data';
import { yearFigures, realOf, benchmarkReturn, yearEnd, type YearFigures } from '../../lib/invest/report';
import { isEdited } from '../../lib/invest/snapshots';
import { eur, signedEur, pct, fmtDate, axisMoney, el, byId, trendClass, row } from './report-ui';

async function main() {
  const state = byId('rpState')!;
  void initMonthly();
  try {
    const ctx = await loadReportContext();
    initBenchmark(ctx);
    if (!ctx.history) {
      state.textContent = 'Încă nu există tranzacții. Adaugă-le în Portofoliu; rapoartele apar automat pentru fiecare an.';
      return;
    }
    try {
      const made = await ensureSnapshots(ctx);
      if (made.length) toast(`Instantaneu de 31 decembrie salvat pentru ${made.join(', ')}.`);
    } catch (e) {
      toast(`Instantaneele nu au putut fi salvate: ${(e as Error).message}`, 'err');
    }
    const figs = ctx.years.map(y => yearFigures(ctx.data, ctx.fx, ctx.history!, y)).filter((f): f is YearFigures => !!f);
    const body = byId<HTMLTableElement>('rpList')!.tBodies[0];
    body.replaceChildren(...figs.map(f => {
      const snap = snapshotOf(ctx, f.year);
      const link = el('a', f.complete ? String(f.year) : `${f.year} (în curs)`);
      link.href = `/vault/invest/rapoarte/${f.year}/`;
      const real = f.complete ? realOf(f.twr, snap?.inflation) : null;
      const cell = (text: string, x: number | null) => el('span', text, trendClass(x));
      const snapText = !f.complete ? `până la ${fmtDate(f.end)}` : !snap ? 'lipsă' : isEdited(snap) ? 'salvat, corectat' : 'salvat';
      const bm = benchmarkReturn(ctx.data.instruments.find(i => i.id === ctx.data.settings.benchmarkInstrumentId), { fx: ctx.fx, prices: ctx.prices }, yearEnd(f.year - 1), f.end);
      const tr = row(link, [
        eur(f.endEur), signedEur(f.netContributions), cell(signedEur(f.market), f.market),
        cell(pct(f.twr, true), f.twr), cell(pct(f.xirr, true), f.xirr), cell(pct(real, true), real),
        cell(bm ? pct(bm.ret, true) : '—', bm?.ret ?? null),
      ]);
      const td = el('td', snapText);
      tr.append(td);
      return tr;
    }));
    byId('rpListCard')!.hidden = false;
    state.textContent = '';
    state.hidden = true;

    // Year-end value vs cumulative net contributions (same unit, one axis)
    const asc = [...figs].reverse();
    let cum = 0;
    const cumContrib = asc.map(f => (cum += f.netContributions));
    byId('rpChartCard')!.hidden = false;
    chartIn(byId('rpYearsChart')!, (t: ChartTheme): EChartsCoreOption => ({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => eur(Number(v)) },
      legend: { top: 0, data: ['Valoare la sfârșit', 'Contribuții nete cumulate'] },
      xAxis: { type: 'category', data: asc.map(f => (f.complete ? String(f.year) : `${f.year}*`)), ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: [
        { name: 'Valoare la sfârșit', type: 'bar', data: asc.map(f => Math.round(f.endEur)), color: t.series[0] },
        { name: 'Contribuții nete cumulate', type: 'line', data: cumContrib.map(Math.round), color: t.series[1], symbol: 'circle' },
      ],
    }));
  } catch (e) {
    state.textContent = `Rapoartele nu au putut fi calculate: ${(e as Error).message}`;
  }
}

void main();

// ─── Benchmark picker ───

function initBenchmark(ctx: ReportContext) {
  const card = byId('bmCard');
  const form = byId<HTMLFormElement>('bmForm');
  if (!card || !form) return;
  const select = form.elements.namedItem('instrumentId') as HTMLSelectElement;
  const none = el('option', '— niciunul —'); none.value = '';
  const opts = [...ctx.data.instruments]
    .sort((a, b) => (a.ticker || a.name).localeCompare(b.ticker || b.name))
    .map(i => { const o = el('option', `${i.ticker ? `${i.ticker} · ` : ''}${i.name}${i.priceSource ? '' : ' (fără sursă automată)'}`); o.value = i.id; return o; });
  select.replaceChildren(none, ...opts);
  select.value = ctx.data.settings.benchmarkInstrumentId ?? '';
  card.hidden = !ctx.dataExists;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const settings = { ...ctx.data.settings };
    if (select.value) settings.benchmarkInstrumentId = select.value; else delete settings.benchmarkInstrumentId;
    try {
      await saveData(ctx, { ...ctx.data, settings });
      toast('Indicele de referință a fost salvat.');
      setTimeout(() => location.reload(), 500);
    } catch (err) { toast((err as Error).message, 'err'); }
  });
}

// ─── Monthly e-mail ───

interface MonthlyInfo {
  settings: { version: 1; enabled: boolean; includeAmounts: boolean };
  state: { lastSent?: string; log: { at: string; month: string; ok: boolean; message?: string }[] };
  email: { configured: boolean; to: string };
}

async function monthlyApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/vault/api/invest/monthly${path}`, {
    cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await res.json().catch(() => ({})) as T & { error?: string; problems?: string[] };
  if (!res.ok) throw new Error([body.error || `Eroare ${res.status}`, ...(body.problems ?? [])].join(': '));
  return body;
}

async function initMonthly() {
  const form = byId<HTMLFormElement>('moForm');
  const state = byId('moState');
  if (!form || !state) return;
  const box = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const show = (info: MonthlyInfo) => {
    box('enabled').checked = info.settings.enabled;
    box('includeAmounts').checked = info.settings.includeAmounts;
    const last = info.state.log[0];
    state.textContent = [
      info.email.configured ? `Se trimite la ${info.email.to}.` : 'Trimiterea de e-mail nu e configurată pe server.',
      info.state.lastSent ? `Ultimul rezumat: luna ${info.state.lastSent}.` : '',
      last && !last.ok ? `Ultima încercare a eșuat: ${last.message ?? ''}` : '',
    ].filter(Boolean).join(' ');
  };
  try { show(await monthlyApi<MonthlyInfo>('')); } catch (e) { state.textContent = (e as Error).message; }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await monthlyApi('/settings', { method: 'PUT', body: JSON.stringify({ version: 1, enabled: box('enabled').checked, includeAmounts: box('includeAmounts').checked }) });
      toast('Setările rezumatului lunar au fost salvate.');
      show(await monthlyApi<MonthlyInfo>(''));
    } catch (err) { toast((err as Error).message, 'err'); }
  });
  byId('moTest')?.addEventListener('click', async () => {
    try {
      const r = await monthlyApi<{ to: string; month: string }>('/test', { method: 'POST' });
      toast(`Test trimis la ${r.to} (luna ${r.month}).`);
    } catch (err) { toast((err as Error).message, 'err'); }
  });
}
