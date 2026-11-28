// /vault/invest/imobiliare/ — results, prepayments, charts, schedule table, comparison (rendering only).
// The maths is in src/lib/invest/{mortgage,property,prepay}.ts; the editor/state is in realestate.ts.
import type { EChartsCoreOption } from 'echarts/core';
import { axisStyle, emptyChart, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { el, byId, kpi, row, pct, NF0, NF1, axisMoney, chip } from './report-ui';
import type { Currency, PropertyScenario, RealEstateDoc } from '../../lib/invest/types';
import { purchase, loanFor, rentalAnalysis, buyVsRent, scenarioMetrics, paramValue, type Purchase, type LoanResult } from '../../lib/invest/property';
import { prepaymentSavings, ageIn, debtToIncome, type MortgageRow } from '../../lib/invest/mortgage';
import { prepayVsInvest } from '../../lib/invest/prepay';

export interface ViewCtx {
  doc: RealEstateDoc;
  eurRonBnr: number | null;
  toEur: (amount: number, cur: Currency) => number | null;
  birthYear?: number;
  today: string;
  /** Portfolio alternative from the plan (nominal yearly), its volatility and the tax on gains */
  market: { yearlyReturn: number | null; vol: number; gainTax: number; notes: string[] };
}

const lei = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < -0.5 ? '−' : ''}${NF0.format(Math.abs(Math.round(n)))} lei`);
const euro = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < -0.5 ? '−' : ''}${NF0.format(Math.abs(Math.round(n)))} €`);
const NF2 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${NF2.format(x * 100)}%`);
const ym = (s: string) => `${s.slice(5, 7)}.${s.slice(0, 4)}`;

export const rateOf = (s: PropertyScenario, ctx: ViewCtx) => s.eurRon ?? ctx.eurRonBnr ?? NaN;

export interface Computed { p: Purchase; loan: LoanResult | null; rows: MortgageRow[] }

export function compute(s: PropertyScenario, ctx: ViewCtx): Computed | null {
  const r = rateOf(s, ctx);
  if (!(r > 0) || !(s.priceEur > 0)) return null;
  const p = purchase(s, r, ctx.toEur);
  const loan = loanFor(s, p, ctx.doc);
  return { p, loan, rows: loan?.withPrepay.rows ?? [] };
}

// ─── Results ───

export function renderResults(s: PropertyScenario, c: Computed | null, ctx: ViewCtx) {
  const box = byId('reKpis')!, warn = byId('reWarn')!;
  byId('reDown')!.textContent = c
    ? `Avans ${euro(c.p.downEur)} = ${lei(c.p.downRon)} · credit ${lei(c.p.loanRon)} (${euro(c.p.loanRon / c.p.eurRon)}) · costuri ${euro(c.p.costsEur)} · curs ${NF2.format(c.p.eurRon)} lei/€`
    : 'Completează prețul și cursul EUR/RON.';
  if (!c) { box.replaceChildren(); warn.hidden = true; return; }
  const notes: string[] = [];
  const tiles: HTMLElement[] = [kpi('Bani proprii necesari', euro(c.p.ownCashEur), { hero: true, note: `${lei(c.p.ownCashRon)} · avans + costuri + comisioane` })];
  const L = c.loan;
  if (L) {
    const sum = L.withPrepay.summary;
    const fixedNote = s.loan!.fixedMonths > 0 && s.loan!.fixedMonths < s.loan!.months ? `primii ${NF1.format(s.loan!.fixedMonths / 12)} ani` : 'toată perioada';
    tiles.push(kpi('Rata lunară', lei(sum.firstPayment), { note: s.loan!.fixedMonths >= s.loan!.months || s.loan!.fixedMonths === 0 ? fixedNote : `${fixedNote}, dobândă fixă` }));
    if (sum.variablePayment !== null) tiles.push(kpi('Rata după perioada fixă', lei(sum.variablePayment), { note: `IRCC ${pct2(s.loan!.ircc)} + marjă ${pct2(s.loan!.margin)}` }));
    tiles.push(kpi('DAE', pct2(L.dae), { note: 'cu toate costurile, fără plăți anticipate' }));
    tiles.push(kpi('Dobândă totală', lei(sum.totalInterest), { note: `total plătit ${lei(sum.totalCash)}` }));
    const ageEnd = ageIn(ctx.birthYear, sum.endMonth), ageStart = ageIn(ctx.birthYear, s.purchaseDate.slice(0, 7));
    tiles.push(kpi('Ultima rată', ym(sum.endMonth), { note: ageEnd === null ? 'completează anul nașterii în Plan' : `la ~${ageEnd} ani (cumperi la ~${ageStart})` }));
    const worst = Math.max(sum.firstPayment, sum.variablePayment ?? 0, ...L.scenarios.map(x => x.summary.maxPayment));
    const dti = debtToIncome(Math.max(sum.firstPayment, sum.variablePayment ?? 0), s.monthlyIncomeRon, s.otherDebtRon);
    if (dti !== null) {
      const limit = s.use === 'home' ? paramValue(ctx.doc, 'dti.maxFirstHome', NaN) : paramValue(ctx.doc, 'dti.max', NaN);
      tiles.push(kpi('Grad de îndatorare', pct(dti), {
        cls: Number.isFinite(limit) && dti > limit ? 'is-down' : '',
        note: Number.isFinite(limit) ? `limita BNR ${pct(limit)}${s.use === 'home' ? ' (prima locuință)' : ''}` : 'limita BNR: încarcă regulile',
      }));
      const dtiWorst = debtToIncome(worst, s.monthlyIncomeRon, s.otherDebtRon);
      if (dtiWorst !== null && Number.isFinite(limit) && dtiWorst > limit) notes.push(`În cel mai rău scenariu IRCC rata ajunge la ${lei(worst)}: ${pct(dtiWorst)} din venit.`);
    }
    const maxAge = paramValue(ctx.doc, 'age.maxAtMaturity', NaN);
    if (ageEnd !== null && Number.isFinite(maxAge) && ageEnd > maxAge) notes.push(`La ultima rată ai ~${ageEnd} ani, peste limita de ${maxAge} pe care ai notat-o.`);
    if (sum.variableRateMissing) notes.push('Lipsește IRCC-ul: după perioada fixă s-a păstrat dobânda fixă.');
  }
  const H = s.holdYears ?? 10;
  if (s.use === 'rental') {
    const r = rentalAnalysis(s, c.p, c.rows, ctx.doc);
    tiles.push(kpi('Randament brut', pct(r.grossYield), { note: 'chirie pe an / preț' }));
    tiles.push(kpi('Randament net', pct(r.netYield), { note: 'primul an, după costuri și impozit, / (preț + costuri)' }));
    tiles.push(kpi('Cash-on-cash', pct(r.cashOnCash, true), { cls: (r.cashOnCash ?? 0) < 0 ? 'is-down' : '', note: `${euro(r.years[0]?.cashFlow)} în primul an, după rate` }));
    tiles.push(kpi(`IRR pe ${H} ani`, pct(r.irr, true), { note: 'cu vânzare la final' }));
    if ((r.years[0]?.cashFlow ?? 0) < 0) notes.push(`Chiria nu acoperă rata în primul an: pui ~${euro(-r.years[0].cashFlow / 12)} pe lună de la tine.`);
  } else if (s.rent?.monthlyEur && ctx.market.yearlyReturn !== null) {
    const b = buyVsRent(s, c.p, c.rows, ctx.market.yearlyReturn, ctx.market.gainTax);
    tiles.push(kpi(`Cumpăr vs chirie, în ${H} ani`, `${b.advantage >= 0 ? '+' : '−'}${euro(Math.abs(b.advantage))}`, {
      cls: b.advantage >= 0 ? 'is-up' : 'is-down',
      note: b.advantage >= 0 ? `cumpărarea iese înainte${b.breakEven ? ` din anul ${b.breakEven}` : ''}` : 'chiria + investiții ies înainte',
    }));
  }
  if (c.p.missing) notes.push(`${c.p.missing} costuri într-o monedă fără curs au fost lăsate deoparte.`);
  box.replaceChildren(...tiles);
  warn.textContent = notes.join(' ');
  warn.hidden = !notes.length;
}

// ─── Prepayments ───

export function renderPrepay(s: PropertyScenario, c: Computed | null, ctx: ViewCtx, onRemove: (id: string) => void) {
  const card = byId('rePreCard')!;
  card.hidden = !s.loan;
  const list = byId('rePreList')!;
  list.replaceChildren(...s.prepayments.map(p => {
    const li = el('li', null, 'bp-line');
    const what = p.kind === 'once'
      ? `${lei(p.amountRon)} în ${ym(p.month)}`
      : `${lei(p.amountRon)} × ${p.count ?? 1}, din ${(p.everyMonths ?? 1) === 1 ? 'lună în lună' : `${p.everyMonths} în ${p.everyMonths} luni`}, de la ${ym(p.month)}`;
    const top = el('strong', `${what} · ${p.effect === 'term' ? 'reduce durata' : 'reduce rata'}`);
    const rm = el('button', 'Șterge', 'inv-btn'); rm.type = 'button';
    rm.addEventListener('click', () => onRemove(p.id));
    li.append(top, el('span', p.done?.length ? `${p.done.length} marcate ca făcute` : 'plan'), rm);
    return li;
  }));
  const kp = byId('rePreKpis')!, verdict = byId('reVerdict')!;
  if (!c?.loan || !s.prepayments.length) { kp.replaceChildren(); verdict.replaceChildren(); return; }
  const sv = prepaymentSavings(c.loan.base.summary, c.loan.withPrepay.summary);
  kp.replaceChildren(
    kpi('Dobândă economisită', lei(sv.interestSaved), { hero: true, note: `+ ${lei(sv.insuranceSaved + sv.feesSaved)} asigurări și comisioane` }),
    kpi('Termini mai devreme', sv.monthsSaved > 0 ? `${NF1.format(sv.monthsSaved / 12)} ani` : '—', { note: `${ym(sv.endBefore)} → ${ym(sv.endAfter)}` }),
    kpi('Pui în plus', lei(c.loan.withPrepay.summary.totalPrepaid), { note: sv.prepaymentFees ? `comisioane ${lei(sv.prepaymentFees)}` : 'fără comision' }),
    kpi('Rata după ultima plată', lei(c.rows.at(-1)?.payment ?? null), { note: 'dacă alegi „reduce rata”, scade' }),
  );
  // Worth it? Same money in the portfolio
  const m = ctx.market;
  const items: HTMLElement[] = [el('h3', 'Merită?', 'plan-h3')];
  if (m.yearlyReturn === null) {
    items.push(el('p', 'Completează în Plan randamentele așteptate (alocarea) ca să compar cu investitul.', 'rp-note'));
  } else {
    const prepayFee = { fixed: paramValue(ctx.doc, 'prepay.feeFixed'), variable: paramValue(ctx.doc, 'prepay.feeVariable') };
    const r = prepayVsInvest(s.loan!, c.p.loanRon, s.prepayments, { yearlyReturn: m.yearlyReturn, vol: m.vol, gainTax: m.gainTax, runs: 1000 }, { prepayFee });
    if (r) {
      const investWins = r.difference > 0;
      const p = el('p', null, 're-verdict__main');
      p.append(chip(investWins ? 'na' : 'ok', investWins ? 'Investitul iese înainte' : 'Plata anticipată iese înainte'),
        ` La sfârșitul creditului inițial (${NF1.format(r.horizonMonths / 12)} ani): plata anticipată ≈ ${lei(r.prepayWealth)}, investit ≈ ${lei(r.investWealth)} (diferență ${lei(Math.abs(r.difference))}), la ${pct(m.yearlyReturn)} pe an din Plan, după impozit.`);
      items.push(p);
      if (r.breakEvenReturn !== null) items.push(el('p', `Pragul: investitul câștigă doar dacă portofoliul aduce peste ${pct2(r.breakEvenReturn)} pe an (după impozitul de ${pct(m.gainTax)} pe câștig). Plata anticipată e un randament sigur egal cu dobânda creditului.`));
      if (r.probInvestWins !== null) items.push(el('p', `Cu volatilitatea din Plan (${pct(m.vol)}), investitul câștigă în ${pct(r.probInvestWins)} din 1.000 de simulări; diferența tipică între ${lei(r.p10)} și ${lei(r.p90)} (p10–p90).`, 'rp-note'));
      items.push(el('p', 'De reținut: banii puși în credit nu se mai pot scoate. Păstrează fondul de urgență din IPS înainte de plăți anticipate. O plată anticipată în perioada cu dobândă fixă are sens mai ales înainte de trecerea pe IRCC, dacă te aștepți ca dobânda variabilă să fie mai mare.', 'rp-note'));
    }
  }
  if (m.notes.length) items.push(el('p', m.notes.join(' '), 'rp-note'));
  verdict.replaceChildren(...items);
}

// ─── Charts ───

const yearLabel = (rows: readonly { month: string }[]) => rows.map(r => r.month.slice(0, 4));

export function renderCharts(s: PropertyScenario, c: Computed | null, ctx: ViewCtx) {
  const L = c?.loan;
  const none = (t: ChartTheme) => emptyChart(t, s.loan ? 'Completează creditul' : 'Cumpărare fără credit');
  if (!L) {
    for (const id of ['reBalChart', 'rePayChart', 'reSplitChart']) chartIn(byId(id)!, none);
  } else {
    const base = L.base.rows, pre = L.withPrepay.rows;
    const n = base.length;
    const months = base.map(r => r.month);
    chartIn(byId('reBalChart')!, (t): EChartsCoreOption => ({
      legend: { top: 0 },
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => lei(Number(v)) },
      xAxis: { type: 'category', data: months.map(ym), boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: [
        { name: 'Fără plăți anticipate', type: 'line', showSymbol: false, color: t.series[0], data: base.map(r => Math.round(r.balance)) },
        ...(s.prepayments.length ? [{ name: 'Cu plăți anticipate', type: 'line', showSymbol: false, color: t.series[1], data: Array.from({ length: n }, (_, i) => Math.round(pre[i]?.balance ?? 0)), areaStyle: { opacity: 0.08 } }] : []),
      ],
    }));
    const scen = [{ shift: 0, rows: pre }, ...L.scenarios.map(x => ({ shift: x.shift, rows: x.rows }))].sort((a, b) => a.shift - b.shift);
    const len = Math.max(...scen.map(x => x.rows.length));
    chartIn(byId('rePayChart')!, (t): EChartsCoreOption => ({
      legend: { top: 0 },
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => lei(Number(v)) },
      xAxis: { type: 'category', data: Array.from({ length: len }, (_, i) => ym(months[i] ?? pre[i]?.month ?? '')), boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: scen.map((x, i) => ({
        name: x.shift === 0 ? 'IRCC-ul tău' : `IRCC ${x.shift > 0 ? '+' : '−'}${NF1.format(Math.abs(x.shift) * 100)} pp`,
        type: 'line', showSymbol: false, step: 'end', color: x.shift === 0 ? t.series[0] : t.series[(i % 7) + 1],
        lineStyle: x.shift === 0 ? { width: 2.5 } : { width: 1.5, type: 'dashed' },
        data: x.rows.map(r => Math.round(r.payment)),
      })),
    }));
    // Per year: principal, interest, prepayments, insurance + fees
    const years = [...new Set(yearLabel(pre))];
    const agg = (k: keyof MortgageRow) => years.map(y => Math.round(pre.filter(r => r.month.startsWith(y)).reduce((a, r) => a + (r[k] as number), 0)));
    const insFees = years.map(y => Math.round(pre.filter(r => r.month.startsWith(y)).reduce((a, r) => a + r.insurance + r.fee + r.prepaymentFee, 0)));
    chartIn(byId('reSplitChart')!, (t): EChartsCoreOption => ({
      legend: { top: 0 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => lei(Number(v)) },
      xAxis: { type: 'category', data: years, ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: [
        { name: 'Principal', type: 'bar', stack: 'y', color: t.series[0], data: agg('principal') },
        { name: 'Dobândă', type: 'bar', stack: 'y', color: t.series[1], data: agg('interest') },
        ...(s.prepayments.length ? [{ name: 'Anticipat', type: 'bar', stack: 'y', color: t.series[2], data: agg('prepayment') }] : []),
        { name: 'Asigurări și comisioane', type: 'bar', stack: 'y', color: t.series[3], data: insFees },
      ],
    }));
  }
  // Yield chart
  const yEl = byId('reYieldChart')!, note = byId('reYieldNote')!;
  if (!c) { chartIn(yEl, t => emptyChart(t, 'Completează prețul')); note.textContent = ''; return; }
  if (s.use === 'rental') {
    const r = rentalAnalysis(s, c.p, c.rows, ctx.doc);
    chartIn(yEl, (t): EChartsCoreOption => ({
      legend: { top: 0 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => euro(Number(v)) },
      xAxis: { type: 'category', data: r.years.map(x => `anul ${x.year}`), ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: [
        { name: 'Venit net din chirie', type: 'bar', color: t.series[0], data: r.years.map(x => Math.round(x.noi)) },
        { name: 'Rate credit', type: 'bar', color: t.series[1], data: r.years.map(x => -Math.round(x.debt)) },
        { name: 'Rămâne (cash flow)', type: 'line', color: t.text, symbol: 'circle', data: r.years.map(x => Math.round(x.cashFlow)) },
      ],
    }));
    note.textContent = `La vânzare după ${s.holdYears ?? 10} ani rămân ≈ ${euro(r.saleNet)} (după costuri și credit). EUR, cursul fix ales.`;
  } else if (s.rent?.monthlyEur && ctx.market.yearlyReturn !== null) {
    const b = buyVsRent(s, c.p, c.rows, ctx.market.yearlyReturn, ctx.market.gainTax);
    chartIn(yEl, (t): EChartsCoreOption => ({
      legend: { top: 0 },
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => euro(Number(v)) },
      xAxis: { type: 'category', data: b.years.map(x => `anul ${x.year}`), boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
      series: [
        { name: 'Cumpăr', type: 'line', showSymbol: false, color: t.series[0], data: b.years.map(x => Math.round(x.ownerWealth)) },
        { name: 'Stau în chirie și investesc', type: 'line', showSymbol: false, color: t.series[1], data: b.years.map(x => Math.round(x.renterWealth)) },
      ],
    }));
    note.textContent = `Avere estimată (EUR) la randamentul portofoliului din Plan (${pct(ctx.market.yearlyReturn)} pe an) și creșterea prețului ${pct(s.appreciation ?? 0)} pe an.`;
  } else {
    chartIn(yEl, t => emptyChart(t, s.use === 'home' ? 'Scrie chiria pe care ai plăti-o' : 'Scrie chiria'));
    note.textContent = '';
  }
}

// ─── Schedule table ───

export function renderTable(s: PropertyScenario, c: Computed | null, ctx: ViewCtx) {
  const body = byId<HTMLTableElement>('reTable')!.tBodies[0];
  const rows = c?.rows ?? [];
  const years = [...new Set(rows.map(r => r.month.slice(0, 4)))];
  body.replaceChildren(...years.map(y => {
    const ys = rows.filter(r => r.month.startsWith(y));
    const tot = (f: (r: MortgageRow) => number) => ys.reduce((a, r) => a + f(r), 0);
    const age = ageIn(ctx.birthYear, `${y}-06`);
    return row(y, [lei(tot(r => r.payment)), lei(tot(r => r.interest)), lei(tot(r => r.principal)), lei(tot(r => r.prepayment)),
      lei(tot(r => r.insurance + r.fee + r.prepaymentFee)), lei(ys.at(-1)!.balance), age === null ? '—' : `~${age}`]);
  }));
}

// ─── Comparison ───

export function renderCompare(ctx: ViewCtx, onToggle: (id: string, on: boolean) => void) {
  const pick = byId('reCmpPick')!;
  const chosen = new Set(ctx.doc.compare ?? []);
  pick.replaceChildren(...ctx.doc.scenarios.map(s => {
    const l = el('label', null, 'rp-check');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(s.id);
    cb.disabled = !cb.checked && chosen.size >= 3;
    cb.addEventListener('change', () => onToggle(s.id, cb.checked));
    l.append(cb, ` ${s.name}`);
    return l;
  }));
  const table = byId<HTMLTableElement>('reCmp')!;
  const sel = ctx.doc.scenarios.filter(s => chosen.has(s.id));
  if (sel.length < 2) {
    table.replaceChildren();
    chartIn(byId('reCmpChart')!, t => emptyChart(t, 'Bifează 2–3 oportunități'));
    return;
  }
  const mctx = {
    eurRon: ctx.eurRonBnr ?? NaN, toEur: ctx.toEur, doc: ctx.doc, birthYear: ctx.birthYear,
    yearlyReturn: ctx.market.yearlyReturn ?? 0, gainTax: ctx.market.gainTax,
  };
  const ms = sel.map(s => ({ s, m: scenarioMetrics(s, mctx), r: rateOf(s, ctx) }));
  const head = el('thead'); const hr = el('tr');
  hr.append(el('th', 'Indicator'), ...ms.map(x => { const th = el('th', x.s.name, 'num'); th.scope = 'col'; return th; }));
  head.append(hr);
  type M = typeof ms[number];
  type Line = [label: string, fmt: (x: M) => string, val?: (x: M) => number | null, best?: 'low' | 'high'];
  const lines: Line[] = [
    ['Scop', x => (x.s.use === 'home' ? 'locuință' : 'închiriere')],
    ['Preț', x => euro(x.m.priceEur), x => x.m.priceEur, 'low'],
    ['Bani proprii', x => euro(x.m.ownCashEur), x => x.m.ownCashEur, 'low'],
    ['Credit', x => lei(x.m.loanRon)],
    ['Rata (perioada fixă)', x => lei(x.m.firstPayment), x => x.m.firstPayment, 'low'],
    ['Rata după perioada fixă', x => lei(x.m.variablePayment), x => x.m.variablePayment, 'low'],
    ['DAE', x => pct2(x.m.dae), x => x.m.dae, 'low'],
    ['Dobândă totală', x => lei(x.m.totalInterest), x => x.m.totalInterest, 'low'],
    ['Ultima rată / vârsta', x => (x.m.endMonth ? `${ym(x.m.endMonth)}${x.m.ageAtEnd !== null ? ` / ~${x.m.ageAtEnd}` : ''}` : '—')],
    ['Grad de îndatorare', x => pct(x.m.dti), x => x.m.dti, 'low'],
    ['Randament net (închiriere)', x => pct(x.m.netYield), x => x.m.netYield, 'high'],
    ['Cash-on-cash', x => pct(x.m.cashOnCash, true), x => x.m.cashOnCash, 'high'],
    ['IRR pe orizont', x => pct(x.m.irr, true), x => x.m.irr, 'high'],
    ['Cumpăr vs chirie (locuință)', x => (x.m.buyAdvantage === null ? '—' : `${x.m.buyAdvantage >= 0 ? '+' : '−'}${euro(Math.abs(x.m.buyAdvantage))}`), x => x.m.buyAdvantage, 'high'],
    ['Avere în imobil la orizont', x => `${euro(x.m.equityAtHorizon)} (${x.m.horizon} ani)`, x => x.m.equityAtHorizon, 'high'],
  ];
  const body = el('tbody');
  for (const [label, fmt, val, best] of lines) {
    const vals = val ? ms.map(x => val(x)) : [];
    const known = vals.filter((v): v is number => v !== null && Number.isFinite(v));
    if (val && !known.length) continue;
    const target = best && known.length > 1 ? (best === 'low' ? Math.min(...known) : Math.max(...known)) : null;
    body.append(row(label, ms.map((x, i) => {
      const span = el('span', fmt(x));
      if (target !== null && vals[i] === target) { span.className = 're-best'; span.title = 'cel mai bun'; span.textContent = `★ ${fmt(x)}`; }
      return span;
    })));
  }
  table.replaceChildren(head, body);
  chartIn(byId('reCmpChart')!, (t): EChartsCoreOption => ({
    legend: { top: 0 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => euro(Number(v)) },
    xAxis: { type: 'category', data: ['Bani proprii', 'Dobândă totală', 'Avere în imobil la orizont'], ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
    series: ms.map((x, i) => ({
      name: x.s.name, type: 'bar', color: t.series[i],
      data: [Math.round(x.m.ownCashEur), Math.round((x.m.totalInterest ?? 0) / (x.r || 1)), Math.round(x.m.equityAtHorizon ?? 0)],
    })),
  }));
}
