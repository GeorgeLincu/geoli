// /vault/invest/rapoarte/ — list of the years with their main figures; saves missing year-end snapshots.
import type { EChartsCoreOption } from 'echarts/core';
import { toast } from './common';
import { axisStyle, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { loadReportContext, ensureSnapshots, snapshotOf } from './report-data';
import { yearFigures, realOf, type YearFigures } from '../../lib/invest/report';
import { isEdited } from '../../lib/invest/snapshots';
import { eur, signedEur, pct, fmtDate, axisMoney, el, byId, trendClass, row } from './report-ui';

async function main() {
  const state = byId('rpState')!;
  try {
    const ctx = await loadReportContext();
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
      const tr = row(link, [
        eur(f.endEur), signedEur(f.netContributions), cell(signedEur(f.market), f.market),
        cell(pct(f.twr, true), f.twr), cell(pct(f.xirr, true), f.xirr), cell(pct(real, true), real),
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
