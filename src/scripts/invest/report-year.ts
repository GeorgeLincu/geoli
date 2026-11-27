// /vault/invest/rapoarte/<an>/ — one yearly report. Figures from src/lib/invest/report.ts; charts with ECharts.
import type { EChartsCoreOption } from 'echarts/core';
import { toast } from './common';
import { axisStyle, emptyChart, installPrintTheme, type ChartTheme } from './charts';
import { chartIn } from './chart-slot';
import { loadReportContext, ensureSnapshots, snapshotOf, saveComputedSnapshot, storeSnapshot, rebuildHistory, type ReportContext } from './report-data';
import {
  yearFigures, pointAt, waterfall, waterfallBars, driftOf, accountValues, ipsCompliance, fiProgress, realOf, taxResults,
  type YearFigures,
} from '../../lib/invest/report';
import { drawdownSeries, wealthIndex } from '../../lib/invest/returns';
import { netWorthAt } from '../../lib/invest/networth';
import { applySnapshotEdit, snapshotNetWorth, isEdited } from '../../lib/invest/snapshots';
import { ASSET_CLASS_LABEL } from '../../lib/invest/labels';
import { unconfirmedParams } from '../../lib/invest/tax-ro';
import type { AssetClass, YearSnapshot } from '../../lib/invest/types';
import {
  eur, ron, signedEur, pct, fmtDate, MONTHS, axisMoney, el, byId, trendClass, kpi, row, chip, openDetailsForPrint, NF1,
} from './report-ui';

const m = /\/rapoarte\/(\d{4})\/?$/.exec(location.pathname);
const YEAR = m ? Number(m[1]) : NaN;

let ctx: ReportContext;

function setState(text: string) { const s = byId('rpState'); if (s) { s.textContent = text; s.hidden = !text; } }

function yearNav() {
  const nav = byId('rpYears');
  if (!nav) return;
  nav.replaceChildren(...[...ctx.years].sort((a, b) => a - b).map(y => {
    const a = el('a', String(y));
    a.href = `/vault/invest/rapoarte/${y}/`;
    if (y === YEAR) a.setAttribute('aria-current', 'page');
    return a;
  }));
}

// ─── Sections ───

function renderKpis(f: YearFigures, snap: YearSnapshot | null, nwEur: number | null) {
  const real = f.complete ? realOf(f.twr, snap?.inflation) : null;
  const items = [
    kpi(f.complete ? 'Valoare la 31 decembrie' : `Valoare la ${fmtDate(f.end)}`, eur(f.endEur), { hero: true, note: `la început: ${eur(f.startEur)}` }),
    kpi('Contribuții nete', signedEur(f.netContributions), { note: `${eur(f.contributedIn)} depuse, ${eur(f.contributedOut)} retrase` }),
    kpi('Câștig de piață', signedEur(f.market), { cls: trendClass(f.market) }),
    kpi('Randament (TWR)', pct(f.twr, true), { cls: trendClass(f.twr), note: f.complete ? 'pe an' : 'de la început de an' }),
    kpi('Randament (XIRR)', pct(f.xirr, true), { cls: trendClass(f.xirr), note: 'ponderat cu banii' }),
    kpi('Randament real', f.complete ? pct(real, true) : '—', {
      cls: trendClass(real),
      note: !f.complete ? 'după încheierea anului' : snap?.inflation ? `inflație ${pct(snap.inflation.rate)}` : 'notează inflația mai jos',
    }),
    kpi('Dividende și dobânzi', eur(f.income), { note: `impozit reținut ${eur(f.withheld)}` }),
    kpi('Comisioane', eur(f.fees)),
    kpi('Avere netă', eur(nwEur), { href: '/vault/invest/avere/', linkText: 'Avere netă →' }),
  ];
  byId('rpKpis')!.replaceChildren(...items);
  const warn = byId('rpWarn')!;
  const notes: string[] = [];
  const endP = pointAt(ctx.history!, f.end);
  if (endP?.atCost) notes.push(`${endP.atCost} ${endP.atCost === 1 ? 'poziție e evaluată' : 'poziții sunt evaluate'} la cost (fără preț la ${fmtDate(f.end)}).`);
  if (f.missingFx) notes.push(`${f.missingFx} tranzacții nu au curs BNR și lipsesc din cifre.`);
  if (f.twrSkipped) notes.push(`${f.twrSkipped} ${f.twrSkipped === 1 ? 'lună fără' : 'luni fără'} sumă investită au fost sărite în TWR.`);
  if (ctx.history!.warnings.length) notes.push(...new Set(ctx.history!.warnings));
  warn.textContent = notes.join(' ');
  warn.hidden = !notes.length;
}

function renderFigures(f: YearFigures) {
  const body = byId<HTMLTableElement>('rpFigures')!.tBodies[0];
  body.replaceChildren(
    row(`Valoare la ${fmtDate(f.start)}`, [eur(f.startEur)]),
    row('Depuneri / cumpărări noi', [signedEur(f.contributedIn)]),
    row('Retrageri / vânzări scoase', [signedEur(-f.contributedOut)]),
    row('Dividende (brut)', [signedEur(f.dividends)]),
    row('Dobânzi (brut)', [signedEur(f.interest)]),
    row('Impozit reținut la sursă', [signedEur(-f.withheld)]),
    row('Comisioane', [signedEur(-f.fees)]),
    row('Câștig de piață (preț + curs)', [signedEur(f.market)]),
    row('Venituri retrase din conturi fără cash', [signedEur(-f.payouts)]),
    row(`Valoare la ${fmtDate(f.end)}`, [eur(f.endEur)], { cls: 'is-total' }),
    row('În lei', [`${ron(f.startRon)} → ${ron(f.endRon)}`]),
    row('Câștig realizat din vânzări', [signedEur(f.realized)]),
    row('XIRR anualizat', [pct(f.xirrAnnual, true)]),
    row('Cea mai mare scădere în an', [f.maxDrawdown ? `−${pct(f.maxDrawdown)}` : '0%']),
  );
}

function renderWaterfall(f: YearFigures) {
  const steps = waterfallBars(waterfall(f)).filter(s => s.kind === 'total' || Math.abs(s.value) >= 0.5);
  const box = byId('rpWaterfall')!;
  const narrow = box.clientWidth < 480;
  const SHORT: Record<string, string> = {
    start: 'Început', contrib: 'Contrib.', income: 'Div.+dob.', withheld: 'Impozit', fees: 'Comis.', market: 'Piață', payouts: 'Retrase', end: 'Sfârșit',
  };
  // Value labels only on the totals and on steps big enough to read (≥ 3% of the largest bar)
  const biggest = Math.max(...steps.map(s => Math.abs(s.kind === 'total' ? s.value : s.bar)), 1);
  const labelled = (i: number) => steps[i].kind === 'total' || Math.abs(steps[i].value) >= biggest * 0.03;
  chartIn(box, (t: ChartTheme): EChartsCoreOption => ({
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const s = steps[ps[0].dataIndex];
        return `${s.label}<br/><b>${s.kind === 'total' ? eur(s.value) : signedEur(s.value)}</b>`;
      },
    },
    xAxis: { type: 'category', data: steps.map(s => (narrow ? SHORT[s.key] : s.label)), ...axisStyle(t), axisLabel: { color: t.muted, interval: 0, rotate: narrow ? 45 : 30, fontSize: 11 } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: axisMoney } },
    series: [
      { type: 'bar', stack: 'wf', silent: true, itemStyle: { color: 'transparent', borderColor: 'transparent' }, data: steps.map(s => s.base) },
      {
        type: 'bar', stack: 'wf', name: 'Valoare',
        data: steps.map(s => ({
          value: s.bar,
          itemStyle: { color: s.kind === 'total' ? t.muted : s.value >= 0 ? t.pos : t.neg, borderRadius: 4, borderColor: t.surface, borderWidth: 1 },
        })),
        label: {
          show: true, position: 'top', color: t.text, fontSize: 11,
          formatter: (p: { dataIndex: number }) => { if (!labelled(p.dataIndex)) return ''; const s = steps[p.dataIndex]; return s.kind === 'total' ? axisMoney(s.value) : `${s.value >= 0 ? '+' : '−'}${axisMoney(Math.abs(s.value))}`; },
        },
      },
    ],
  }));
}

function renderHeatmap() {
  const h = ctx.history!;
  const years = [...new Set([...h.monthly.keys()].map(k => +k.slice(0, 4)))].filter(y => y <= YEAR).sort((a, b) => a - b).slice(-10);
  const data: [number, number, number | null][] = [];
  let maxAbs = 0.01;
  years.forEach((y, yi) => {
    for (let mo = 1; mo <= 12; mo++) {
      const r = h.monthly.get(`${y}-${String(mo).padStart(2, '0')}`);
      if (r === undefined) continue;
      data.push([mo - 1, yi, r === null ? null : Math.round(r * 10_000) / 100]);
      if (r !== null) maxAbs = Math.max(maxAbs, Math.abs(r));
    }
  });
  const lim = Math.ceil(maxAbs * 100);
  const el0 = byId('rpHeatmap')!;
  chartIn(el0, (t: ChartTheme): EChartsCoreOption => data.length ? ({
    grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'item',
      formatter: (p: { value: [number, number, number | null] }) =>
        `${MONTHS[p.value[0]]} ${years[p.value[1]]}<br/><b>${p.value[2] === null ? 'fără sumă investită' : `${p.value[2] > 0 ? '+' : ''}${NF1.format(p.value[2])}%`}</b>`,
    },
    xAxis: { type: 'category', data: MONTHS, ...axisStyle(t), splitArea: { show: false }, splitLine: { show: false } },
    yAxis: {
      type: 'category', data: years.map(String), ...axisStyle(t), splitLine: { show: false },
      axisLabel: { color: t.muted, formatter: (v: string) => (+v === YEAR ? `{b|${v}}` : v), rich: { b: { color: t.text, fontWeight: 'bold' } } },
    },
    visualMap: {
      type: 'continuous', min: -lim, max: lim, calculable: false, orient: 'horizontal', left: 'center', bottom: 4,
      itemHeight: 140, itemWidth: 10, text: [`+${lim}%`, `−${lim}%`], textStyle: { color: t.muted },
      inRange: { color: [t.neg, t.mid, t.pos] }, outOfRange: { color: t.border },
    },
    series: [{
      type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
      emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } },
    }],
  }) : emptyChart(t, 'Încă nu există luni cu valori'));

  // Table view (also printed)
  const table = byId<HTMLTableElement>('rpMonths')!;
  const head = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'An'), ...MONTHS.map(mo => { const th = el('th', mo, 'num'); th.scope = 'col'; return th; }));
  head.append(hr);
  const body = el('tbody');
  for (const y of [...years].reverse()) {
    const cells = MONTHS.map((_, i) => {
      const r = h.monthly.get(`${y}-${String(i + 1).padStart(2, '0')}`);
      const span = el('span', r === undefined ? '' : r === null ? '·' : pct(r, true), trendClass(r ?? null));
      return span;
    });
    body.append(row(String(y), cells));
  }
  table.replaceChildren(head, body);
}

function renderDrawdown(f: YearFigures) {
  const h = ctx.history!;
  const pts = h.points.filter(p => p.date <= f.end);
  const subs = pts.slice(1).map(p => ({ to: p.date, r: h.monthly.get(p.date.slice(0, 7)) ?? null }));
  const dd = drawdownSeries(wealthIndex(pts[0].date, subs)).points;
  const yearStartIdx = dd.findIndex(p => p.date > f.start);
  chartIn(byId('rpDrawdown')!, (t: ChartTheme): EChartsCoreOption => ({
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => `${NF1.format(Number(v))}%` },
    xAxis: { type: 'category', data: dd.map(p => fmtDate(p.date).slice(3)), boundaryGap: false, ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', max: 0, ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${NF1.format(v)}%` } },
    series: [{
      name: 'Sub maxim', type: 'line', showSymbol: false, color: t.neg,
      data: dd.map(p => -Math.round(p.dd * 1000) / 10),
      areaStyle: { opacity: 0.18 },
      markArea: yearStartIdx >= 0 ? {
        silent: true, itemStyle: { color: t.border, opacity: 0.25 },
        data: [[{ xAxis: yearStartIdx }, { xAxis: dd.length - 1 }]],
      } : undefined,
    }],
  }));
}

function renderAllocation(f: YearFigures) {
  const p = pointAt(ctx.history!, f.end)!;
  const drift = driftOf(p.holdings, ctx.data.targets);
  const state = byId('rpAllocState')!;
  const table = byId<HTMLTableElement>('rpAlloc')!;
  if (!drift) {
    state.textContent = 'Nu ai o alocare-țintă. O poți defini în Portofoliu.';
    table.hidden = true;
  } else {
    state.textContent = `Ținta de azi din Portofoliu (bandă implicită ±5 pp). ${drift.unmatched > 0.5 ? `${eur(drift.unmatched)} nu se potrivesc cu niciun rând.` : ''}`;
    table.tBodies[0].replaceChildren(...drift.rows.map(r => row(r.target.label, [
      eur(r.value), pct(r.actualWeight), `${pct(r.target.weight)} ± ${NF1.format((r.target.band ?? 0.05) * 100)}`,
      chip(r.status === 'ok' ? 'ok' : 'warn', r.status === 'ok' ? '✓ în bandă' : r.status === 'over' ? '▲ peste' : '▼ sub'),
    ])));
    table.hidden = false;
  }
  const classes = Object.entries(p.byClass).filter(([, v]) => (v ?? 0) > 0.5).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const total = classes.reduce((s, [, v]) => s + (v ?? 0), 0);
  byId<HTMLTableElement>('rpClasses')!.tBodies[0].replaceChildren(
    ...classes.map(([c, v]) => row(ASSET_CLASS_LABEL[c as AssetClass] ?? c, [eur(v ?? 0), total ? pct((v ?? 0) / total) : '—'])),
  );
}

function renderIps(f: YearFigures) {
  const p = pointAt(ctx.history!, f.end)!;
  const c = ipsCompliance(ctx.ips, ctx.data, ctx.fx, YEAR, f.end, driftOf(p.holdings, ctx.data.targets), accountValues(p.holdings));
  const state = byId('rpIpsState')!;
  const list = byId('rpIps')!;
  if (!c.versionDate) { state.textContent = `Nu exista o versiune IPS salvată la ${fmtDate(f.end)}.`; list.replaceChildren(); return; }
  state.textContent = c.items.length
    ? `Regulile din IPS-ul din ${fmtDate(c.versionDate)}.`
    : `IPS-ul din ${fmtDate(c.versionDate)} nu are reguli verificabile.`;
  list.replaceChildren(...c.items.map(i => {
    const li = el('li');
    li.append(chip(i.status), el('strong', i.label), el('span', i.detail));
    return li;
  }));
}

function renderFiAndNetWorth(f: YearFigures, nwEur: number | null, nwRon: number | null) {
  const fi = fiProgress(ctx.data.settings, ctx.data.targets, YEAR, f.endEur);
  const tiles = [kpi('Avere netă', eur(nwEur), { note: nwRon === null ? undefined : ron(nwRon) })];
  if (fi) {
    tiles.push(kpi('Progres FI', pct(fi.progress), { note: `din ${eur(fi.fiNumber)}` }));
    tiles.push(kpi('Ani până la FI', fi.yearsToFI === null ? '—' : fi.yearsToFI === 0 ? 'atins' : NF1.format(fi.yearsToFI), { note: 'cu planul de azi' }));
  }
  byId('rpFi')!.replaceChildren(...tiles);
  byId('rpFiNote')!.textContent = fi
    ? `Numărul FI = cheltuieli anuale / SWR din Plan. Portofoliul fără Pilon 2/3 la ${fmtDate(f.end)}.${fi.missing.length ? ' Unele date din Plan lipsesc, deci anii până la FI nu se pot calcula.' : ''}`
    : 'Completează cheltuielile la pensie în Plan ca să vezi progresul FI.';
}

function renderTax() {
  const res = taxResults(ctx.data, ctx.rules, ctx.fxDocs, ctx.fx, YEAR).get(YEAR);
  const box = byId('rpTax')!;
  const note = byId('rpTaxNote')!;
  if (!res) {
    box.replaceChildren();
    note.textContent = ctx.rules ? `Nu există parametri fiscali pentru ${YEAR}.` : 'Parametrii fiscali nu sunt încă salvați (pagina Taxe).';
    return;
  }
  const r = res.result;
  box.replaceChildren(
    kpi('De plată prin Declarația Unică', ron(r.payable), { note: `din care CASS ${ron(r.cass.due)}` }),
    kpi('Reținut la sursă', ron(r.withheld)),
    kpi('Total impozite', ron(r.totalTax), { note: r.effectiveRate === null ? undefined : `rată efectivă ${pct(r.effectiveRate)}`, href: '/vault/invest/taxe/', linkText: 'Pagina Taxe →' }),
  );
  const unconf = unconfirmedParams(res.set).length;
  note.textContent = [
    'Estimare cu motorul de pe pagina Taxe (lei, cursuri BNR). Nu e consultanță fiscală.',
    res.exactRules ? '' : `Se folosesc parametrii din ${res.set.year}, nu există pentru ${YEAR}.`,
    unconf ? `${unconf} parametri neconfirmați de tine.` : '',
  ].filter(Boolean).join(' ');
}

// ─── Snapshot editor ───

function renderSnapshot(f: YearFigures) {
  const snap = snapshotOf(ctx, YEAR);
  const state = byId('rpSnapState')!;
  const form = byId<HTMLFormElement>('rpSnapForm')!;
  if (!f.complete) {
    state.textContent = 'Anul nu s-a încheiat. Instantaneul de 31 decembrie se salvează automat când deschizi rapoartele după această dată.';
    form.hidden = true;
    return;
  }
  if (!snap) { state.textContent = 'Instantaneul nu a putut fi salvat.'; form.hidden = true; return; }
  const c = snap.computed;
  state.textContent = `Calculat automat la ${fmtDate(c.computedAt.slice(0, 10))}: portofoliu ${eur(c.portfolioEur)} (${ron(c.portfolioRon)}), avere netă ${eur(c.netWorthEur)}.`
    + (isEdited(snap) ? ' Ai corectat valorile; raportul le folosește pe ale tale.' : '')
    + (c.atCost ? ` ${c.atCost} poziții erau fără preț (la cost).` : '');
  const set = (name: string, v: string) => { (form.elements.namedItem(name) as HTMLInputElement).value = v; };
  const num = (n: number | undefined) => (n === undefined ? '' : String(n).replace('.', ','));
  set('portfolioEur', num(snap.portfolioEur));
  set('netWorthEur', num(snap.netWorthEur));
  set('inflationPct', snap.inflation ? NF1.format(snap.inflation.rate * 100) : '');
  set('inflationSource', snap.inflation?.source ?? '');
  set('note', snap.note ?? '');
  form.hidden = false;
}

function bindSnapshotForm() {
  const form = byId<HTMLFormElement>('rpSnapForm')!;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const snap = snapshotOf(ctx, YEAR);
    if (!snap) return;
    const fd = new FormData(form);
    const g = (k: string) => String(fd.get(k) ?? '');
    const { snapshot, problems } = applySnapshotEdit(snap, {
      portfolioEur: g('portfolioEur'), netWorthEur: g('netWorthEur'), inflationPct: g('inflationPct'), inflationSource: g('inflationSource'), note: g('note'),
    }, new Date().toISOString());
    if (problems.length) { toast(problems.join('; '), 'err'); return; }
    try {
      await storeSnapshot(ctx, snapshot);
      rebuildHistory(ctx);
      toast('Instantaneul a fost salvat.');
      render();
    } catch (err) { toast((err as Error).message, 'err'); }
  });
  byId('rpRecalc')!.addEventListener('click', async () => {
    try {
      await saveComputedSnapshot(ctx, YEAR);
      rebuildHistory(ctx);
      toast('Recalculat din registru și prețuri (corecțiile tale au rămas).');
      render();
    } catch (err) { toast((err as Error).message, 'err'); }
  });
}

// ─── Page ───

function render() {
  const h = ctx.history;
  const f = h ? yearFigures(ctx.data, ctx.fx, h, YEAR) : null;
  if (!f) {
    setState(ctx.years.length
      ? `Nu există date pentru ${YEAR}. Alege un an de mai sus.`
      : 'Încă nu există tranzacții. Adaugă-le în Portofoliu; rapoartele apar automat.');
    byId('rpBody')!.hidden = true;
    return;
  }
  const snap = snapshotOf(ctx, YEAR);
  let nwEur: number | null = null, nwRon: number | null = null;
  if (f.complete && snap) { nwEur = snapshotNetWorth(snap); nwRon = snap.netWorthEur === undefined ? snap.computed.netWorthRon : null; }
  else {
    const nw = netWorthAt(ctx.data, { fx: ctx.fx, prices: ctx.prices, emergencyAccountIds: ctx.emergencyAccountIds }, f.end);
    nwEur = nw.netEur; nwRon = nw.netRon;
  }
  byId('rpSub')!.textContent = f.complete
    ? `1 ianuarie – 31 decembrie ${YEAR} · EUR · portofoliul fără Pilon 2/3`
    : `1 ianuarie – ${fmtDate(f.end)} (an în curs) · EUR · portofoliul fără Pilon 2/3`;
  setState('');
  byId('rpBody')!.hidden = false;
  renderKpis(f, snap, nwEur);
  renderFigures(f);
  renderWaterfall(f);
  renderHeatmap();
  renderDrawdown(f);
  renderAllocation(f);
  renderIps(f);
  renderFiAndNetWorth(f, nwEur, nwRon);
  renderTax();
  renderSnapshot(f);
}

async function main() {
  if (!Number.isFinite(YEAR)) { setState('An invalid.'); return; }
  document.title = `Raport ${YEAR} · Investiții · GeoLi`;
  byId('rpTitle')!.textContent = `Raport ${YEAR}`;
  byId('rpPrint')!.addEventListener('click', () => window.print());
  installPrintTheme();
  openDetailsForPrint();
  try {
    ctx = await loadReportContext();
    try {
      const made = await ensureSnapshots(ctx);
      if (made.length) toast(`Instantaneu salvat pentru ${made.join(', ')}.`);
    } catch (e) {
      toast(`Instantaneul de 31 decembrie nu a putut fi salvat: ${(e as Error).message}`, 'err');
    }
    yearNav();
    render();
    bindSnapshotForm();
  } catch (e) {
    setState(`Raportul nu a putut fi calculat: ${(e as Error).message}`);
  }
}

void main();
