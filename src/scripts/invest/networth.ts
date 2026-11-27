// /vault/invest/avere/ — full net worth. Logic in src/lib/invest/networth.ts; this file loads, renders and saves.
import { loadDoc, saveDoc, loadMarket, type Loaded } from './api';
import { mountChart, axisStyle, type ChartTheme } from './charts';
import { toast } from './common';
import { validateDoc } from '../../lib/invest/validate';
import { emptyData, type Currency, type DatedValue, type InvestData, type IpsRules, type LiabilityKind, type NetWorthAssetCategory } from '../../lib/invest/types';
import { activeIpsRules } from '../../lib/invest/ips-checks';
import { manualFx, chainFx } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import type { FxYear, PricesYear } from '../../lib/invest/market';
import {
  NET_WORTH_CATEGORIES, emptyNetWorth, netWorthAt, netWorthSeries, seriesDates, firstNetWorthDate,
  monthlyExpenses, emergencyStatus, payoffMonths, monthlyInterest, latestBalance, valueAt, isLiquid, isEmergency,
  type NetWorthAt, type NetWorthCategory, type NetWorthSources,
} from '../../lib/invest/networth';
import { NW_CATEGORY_LABEL, LIABILITY_KIND_LABEL } from '../../lib/invest/labels';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const nf = (min: number, max: number) => new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = nf(0, 0), NF1 = nf(1, 1), NF2 = nf(2, 2);
const money0 = (n: number | null | undefined, cur: string) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF0.format(n)} ${cur}`);
const money2 = (n: number | null | undefined, cur: string) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF2.format(n)} ${cur}`);
const pct = (n: number) => `${NF1.format(n * 100)}%`;
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const newId = () => crypto.randomUUID();
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** "1.234,5", "1234.5", "1 234,5" → number. Empty → undefined. Invalid → NaN. */
function parseNum(s: FormDataEntryValue | null): number | undefined {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return undefined;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}
const text = (fd: FormData, k: string) => { const v = String(fd.get(k) ?? '').trim(); return v || undefined; };

function h(tag: string, attrs: Record<string, string | undefined> = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
function table(el: HTMLElement, head: (string | [string, 'num'])[], rows: HTMLElement[], empty: string, foot?: HTMLElement) {
  el.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map(c => (Array.isArray(c) ? h('th', { class: 'num', scope: 'col' }, c[0]) : h('th', { scope: 'col' }, c))))),
    h('tbody', {}, ...(rows.length ? rows : [h('tr', { class: 'pf-empty' }, h('td', { colspan: String(head.length) }, empty))])),
    ...(foot ? [h('tfoot', {}, foot)] : []),
  );
}
const btn = (label: string, action: string, id: string, extra?: string) =>
  h('button', { type: 'button', class: `inv-btn${extra ? ` ${extra}` : ''}`, 'data-action': action, 'data-id': id }, label);

// ─── State ───

let loaded: Loaded<'data'> | null = null;
let data: InvestData = emptyData();
let ips: IpsRules | null = null;
let fxDocs: FxYear[] = [];
let priceDocs: PricesYear[] = [];
let marketKey = '';
let chartCur: 'EUR' | 'RON' = 'EUR';
let series: NetWorthAt[] = [];
let now: NetWorthAt | null = null;
const today = todayIso();

const nwDoc = () => data.netWorth ?? emptyNetWorth();

function sources(): NetWorthSources {
  const fx = chainFx(bnrFx(fxDocs), manualFx(data.fxRates ?? []));
  const prices = chainPrices(storePrices(priceDocs, data.instruments, fx), manualPrices(data.prices ?? []));
  return { fx, prices, emergencyAccountIds: ips?.emergencyFund?.accountIds ?? [] };
}

/** Every year from the first recorded date to this one (net-worth values can sit in years without transactions). */
function yearsNeeded() {
  const first = firstNetWorthDate(data);
  const end = Number(today.slice(0, 4));
  const start = Math.max(2005, first ? Number(first.slice(0, 4)) : end);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

async function refreshMarket() {
  const years = yearsNeeded();
  const key = years.join(',');
  if (key === marketKey) return;
  try {
    const m = await loadMarket(years);
    fxDocs = m.fx; priceDocs = m.prices; marketKey = key;
    renderAll();
  } catch (e) {
    toast(`Cursurile BNR și prețurile nu s-au încărcat: ${(e as Error).message}`, 'err');
  }
}

async function commit(mutate: (nw: NonNullable<InvestData['netWorth']>) => void, okMessage: string): Promise<boolean> {
  if (!loaded) { toast('Datele nu s-au încărcat încă.', 'err'); return false; }
  const next = structuredClone(data);
  next.netWorth = next.netWorth ?? emptyNetWorth();
  mutate(next.netWorth);
  const problems = validateDoc('data', next);
  if (problems.length) { toast(`Date invalide: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    loaded = await saveDoc('data', loaded, next);
    data = next;
    renderAll();
    toast(okMessage);
    void refreshMarket();
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

// ─── Rendering ───

function renderAll() {
  const src = sources();
  now = netWorthAt(data, src, today);
  const first = firstNetWorthDate(data);
  series = first ? netWorthSeries(data, src, seriesDates(first, today)) : [];
  renderSummary();
  renderItems();
  renderAssets();
  renderDebts();
  renderValueTargets();
  renderValues();
  timeChart.update();
  liqChart.update();
}

function renderSummary() {
  if (!now) return;
  const set = (k: string, v: string, cls?: string) => {
    const el = $(`[data-nw="${k}"]`);
    el.textContent = v;
    el.className = cls ?? '';
  };
  const n = now;
  set('netEur', money0(n.netEur, '€'), n.netEur < 0 ? 'pf-neg' : '');
  set('netRon', money0(n.netRon, 'lei'), n.netRon < 0 ? 'pf-neg' : '');
  set('assets', money0(n.assetsEur, '€'));
  set('debts', money0(n.liabilitiesEur, '€'));
  set('liquid', money0(n.liquidEur, '€'));
  set('illiquid', money0(n.illiquidEur, '€'));
  if (n.assetsEur > 0) {
    $('[data-nw="liquid"]').append(h('small', { class: 'nw-share' }, `${pct(n.liquidEur / n.assetsEur)} din active`));
    $('[data-nw="illiquid"]').append(h('small', { class: 'nw-share' }, `${pct(n.illiquidEur / n.assetsEur)} din active`));
  }
  set('ratio', n.debtToAssets === null ? '—' : pct(n.debtToAssets), n.debtToAssets !== null && n.debtToAssets > 0.5 ? 'is-warn' : '');
  $('#nwDate').textContent = `la ${fmtDate(today)}`;

  const exp = monthlyExpenses(data.netWorth, ips);
  const ef = emergencyStatus(n, exp, ips);
  set('ef', ef.months === null ? '—' : `${NF1.format(ef.months)} luni`, ef.status === 'under' ? 'is-warn' : ef.status === 'ok' ? 'pf-pos' : '');
  const efText = $('#nwEfText');
  if (ef.months === null) {
    efText.textContent = `Ai ${money0(ef.eur, '€')} puși deoparte. Scrie cheltuielile lunare ca să vezi câte luni acoperă.`;
  } else {
    efText.textContent = `${money0(ef.eur, '€')} acoperă ${NF1.format(ef.months)} luni de cheltuieli (${money0(exp!.eur, '€')}/lună)`
      + (ef.targetMonths !== null ? `; ținta din IPS: ${NF0.format(ef.targetMonths)} luni (${money0(ef.targetMonths * exp!.eur, '€')}).` : '.');
  }
  efText.dataset.kind = ef.status;
  const form = $<HTMLFormElement>('#expForm');
  const input = form.elements.namedItem('monthlyExpenses') as HTMLInputElement;
  if (document.activeElement !== input) input.value = data.netWorth?.monthlyExpenses ? String(data.netWorth.monthlyExpenses).replace('.', ',') : '';
  const ipsEf = ips?.emergencyFund;
  $('#expHint').textContent = [
    ipsEf?.monthlyExpenses ? `Dacă lași gol, se folosește suma din IPS: ${money0(ipsEf.monthlyExpenses, '€')}/lună.` : 'Poți seta cheltuielile și ținta în luni și în regulile IPS.',
    'Intră în fondul de urgență: activele bifate „Fond de urgență”' + (ipsEf?.accountIds.length ? ' și conturile alese în IPS.' : '.'),
  ].join(' ');

  const warn: string[] = [];
  if (n.missingFx.length) warn.push(`Lipsește cursul pentru ${n.missingFx.join(', ')}; acele valori nu intră în total.`);
  if (n.atCost) warn.push(`${n.atCost} ${n.atCost === 1 ? 'poziție e socotită' : 'poziții sunt socotite'} la cost (fără preț la zi).`);
  const ul = $('#nwWarnings');
  ul.replaceChildren(...warn.map(w => h('li', {}, w)));
  ul.hidden = !warn.length;

  const empty = !n.items.length;
  $('#nwState').textContent = !loaded?.exists
    ? 'Încă nu există date salvate. Adaugă mai jos primul activ sau prima datorie.'
    : empty ? 'Nimic de însumat încă: adaugă active și datorii mai jos (portofoliul apare automat după ce ai tranzacții în Portofoliu).'
    : 'Investițiile vin din Portofoliu; restul din ce notezi pe pagina asta.';
}

function renderItems() {
  if (!now) return;
  const rows = now.items.map(it => {
    const cat = it.kind === 'liability' ? 'Datorie' : NW_CATEGORY_LABEL[it.category!];
    const src = it.kind === 'portfolio' ? h('a', { href: '/vault/invest/portofoliu/' }, 'Portofoliu') : it.valueDate ? fmtDate(it.valueDate) : '—';
    return h('tr', {},
      h('td', {}, it.name),
      h('td', {}, cat),
      h('td', { class: 'num' }, it.kind === 'portfolio' ? '' : money2(it.value, it.currency)),
      h('td', { class: `num${it.kind === 'liability' ? ' pf-neg' : ''}` }, it.valueEur === null ? 'fără curs' : money0(it.kind === 'liability' ? -it.valueEur : it.valueEur, '€')),
      h('td', { class: 'num' }, it.valueRon === null ? '—' : money0(it.kind === 'liability' ? -it.valueRon : it.valueRon, 'lei')),
      h('td', {}, src),
    );
  });
  const foot = h('tr', {}, h('td', {}, 'Avere netă'), h('td', {}), h('td', {}),
    h('td', { class: 'num' }, money0(now.netEur, '€')), h('td', { class: 'num' }, money0(now.netRon, 'lei')), h('td', {}));
  table($('#itemsTable'), ['Ce', 'Categorie', ['Valoare', 'num'], ['EUR', 'num'], ['RON', 'num'], 'Sursa / data'], rows,
    'Nimic încă. Portofoliul apare după primele tranzacții; restul îl adaugi mai jos.', rows.length ? foot : undefined);
}

function renderAssets() {
  const rows = nwDoc().assets.map(a => {
    const v = valueAt(a.values, '9999-12-31');
    return h('tr', {},
      h('td', {}, a.name, a.notes ? h('div', { class: 'pf-note' }, a.notes) : null),
      h('td', {}, NW_CATEGORY_LABEL[a.category]),
      h('td', { class: 'num' }, v ? money2(v.value, a.currency) : '—'),
      h('td', {}, v ? fmtDate(v.date) : '—'),
      h('td', {}, isLiquid(a) ? 'da' : 'nu'),
      h('td', {}, isEmergency(a) ? 'da' : 'nu'),
      h('td', {}, h('span', { class: 'pf-btns' },
        btn('Valoare nouă', 'value', `asset:${a.id}`), btn('Editează', 'edit-asset', a.id), btn('Șterge', 'del-asset', a.id))),
    );
  });
  table($('#assetsTable'), ['Activ', 'Categorie', ['Ultima valoare', 'num'], 'Data', 'Lichid', 'Urgență', ''], rows, 'Niciun activ adăugat.');
}

function renderDebts() {
  const rows = nwDoc().liabilities.map(l => {
    const b = latestBalance(l);
    const months = b ? payoffMonths(b.value, l.rate, l.monthlyPayment) : null;
    const payoff = !b ? '—' : months === 0 ? 'achitat' : months === null ? (l.monthlyPayment ? 'rata nu acoperă dobânda' : '—')
      : `${NF0.format(months)} luni (${addMonths(b.date, months)})`;
    return h('tr', {},
      h('td', {}, l.name, l.notes ? h('div', { class: 'pf-note' }, l.notes) : null),
      h('td', {}, LIABILITY_KIND_LABEL[l.kind]),
      h('td', { class: 'num' }, b ? money2(b.value, l.currency) : '—'),
      h('td', {}, b ? fmtDate(b.date) : '—'),
      h('td', { class: 'num' }, l.rate !== undefined ? `${NF2.format(l.rate * 100)}%` : '—'),
      h('td', { class: 'num' }, l.monthlyPayment !== undefined ? money2(l.monthlyPayment, l.currency) : '—'),
      h('td', { class: 'num' }, b && l.rate !== undefined ? money2(monthlyInterest(b.value, l.rate), l.currency) : '—'),
      h('td', {}, payoff),
      h('td', {}, h('span', { class: 'pf-btns' },
        btn('Sold nou', 'value', `debt:${l.id}`), btn('Editează', 'edit-debt', l.id), btn('Șterge', 'del-debt', l.id))),
    );
  });
  table($('#debtsTable'), ['Datorie', 'Tip', ['Sold', 'num'], 'Data', ['Dobândă', 'num'], ['Rată lunară', 'num'], ['Dobândă / lună', 'num'], 'Achitat în', ''], rows, 'Nicio datorie adăugată.');
}

/** Month `n` after an ISO date, as "MM.YYYY". */
function addMonths(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${String((t % 12) + 1).padStart(2, '0')}.${Math.floor(t / 12)}`;
}

function renderValueTargets() {
  const sel = $<HTMLSelectElement>('#valueTarget');
  const cur = sel.value;
  const nw = nwDoc();
  const opts = [
    ...nw.assets.map(a => h('option', { value: `asset:${a.id}` }, `${a.name} (${a.currency})`)),
    ...nw.liabilities.map(l => h('option', { value: `debt:${l.id}` }, `Datorie: ${l.name} (${l.currency})`)),
  ];
  sel.replaceChildren(...(opts.length ? opts : [h('option', { value: '' }, 'Adaugă întâi un activ sau o datorie')]));
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  $('#valueLabel').textContent = sel.value.startsWith('debt:') ? 'Sold rămas' : 'Valoare';
}

function targetPoints(key: string): { points: DatedValue[]; currency: Currency } | null {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const nw = nwDoc();
  if (kind === 'asset') { const a = nw.assets.find(x => x.id === id); return a ? { points: a.values, currency: a.currency } : null; }
  const l = nw.liabilities.find(x => x.id === id);
  return l ? { points: l.balances, currency: l.currency } : null;
}

function renderValues() {
  const key = $<HTMLSelectElement>('#valueTarget').value;
  const t = key ? targetPoints(key) : null;
  const rows = (t?.points ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).map(p => h('tr', {},
    h('td', {}, fmtDate(p.date)),
    h('td', { class: 'num' }, money2(p.value, t!.currency)),
    h('td', { class: 'pf-note' }, p.note ?? ''),
    h('td', {}, h('span', { class: 'pf-btns' }, btn('Șterge', 'del-value', `${key}|${p.date}`))),
  ));
  table($('#valuesTable'), ['Data', ['Valoare', 'num'], 'Notă', ''], rows, 'Nicio valoare pentru elementul ales.');
}

// ─── Charts ───

const CAT_COLOR: Record<NetWorthCategory, (t: ChartTheme) => string> = {
  investments: t => t.series[0], pension: t => t.series[4], cash: t => t.series[1], savings: t => t.series[2],
  real_estate: t => t.series[3], vehicle: t => t.series[5], other: t => t.muted,
};

const timeChart = mountChart($('#nwChart'), t => {
  const ron = chartCur === 'RON';
  const conv = (p: NetWorthAt, eur: number) => (ron ? (p.assetsEur ? eur * (p.assetsRon / p.assetsEur) : 0) : eur);
  const unit = ron ? 'lei' : '€';
  const used = NET_WORTH_CATEGORIES.filter(c => series.some(p => Math.abs(p.byCategory[c]) > 0.005));
  const hasDebt = series.some(p => p.liabilitiesEur > 0.005);
  const fmt = (v: unknown) => money0(Number(v), unit);
  const area = (name: string, color: string, data: number[], stack: string, opacity = 0.55) => ({
    name, type: 'line', stack, data, showSymbol: false, symbolSize: 4, lineStyle: { width: opacity < 0.5 ? 2 : 1, color }, itemStyle: { color },
    areaStyle: { opacity, color }, emphasis: { focus: 'series' },
  });
  return {
    legend: { top: 0, type: 'scroll', textStyle: { color: t.muted } },
    grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', backgroundColor: t.bg, borderColor: t.border, textStyle: { color: t.text, fontFamily: t.font },
      formatter: (ps: { axisValueLabel: string; marker: string; seriesName: string; value: number }[]) =>
        `${esc(ps[0]?.axisValueLabel ?? '')}<br>` + ps.filter(p => Math.abs(p.value) > 0.005 || p.seriesName === 'Avere netă')
          .map(p => `${p.marker}${esc(p.seriesName)}: <b>${esc(fmt(p.value))}</b>`).join('<br>'),
    },
    xAxis: { type: 'category', boundaryGap: false, data: series.map(p => fmtDate(p.date).slice(3)), ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => (Math.abs(v) >= 1e6 ? `${NF1.format(v / 1e6)}M` : `${NF0.format(v / 1000)}k`) } },
    series: [
      ...used.map(c => area(NW_CATEGORY_LABEL[c], CAT_COLOR[c](t), series.map(p => Math.round(conv(p, p.byCategory[c]))), 'assets')),
      ...(hasDebt ? [area('Datorii', t.err, series.map(p => -Math.round(ron ? p.liabilitiesRon : p.liabilitiesEur)), 'debt', 0.18)] : []),
      {
        name: 'Avere netă', type: 'line', data: series.map(p => Math.round(ron ? p.netRon : p.netEur)),
        showSymbol: false, lineStyle: { width: 2.5, color: t.text }, itemStyle: { color: t.text }, z: 10,
      },
    ],
  };
});

const liqChart = mountChart($('#nwLiqChart'), t => {
  const n = now;
  return {
    legend: { bottom: 0, top: 'auto', textStyle: { color: t.muted } },
    tooltip: { trigger: 'item', backgroundColor: t.bg, borderColor: t.border, textStyle: { color: t.text }, valueFormatter: (v: unknown) => money0(Number(v), '€') },
    series: [{
      type: 'pie', radius: ['45%', '72%'], center: ['50%', '45%'], avoidLabelOverlap: true,
      label: { color: t.text, formatter: (p: { percent: number }) => `${NF1.format(p.percent)}%` }, itemStyle: { borderColor: t.bg, borderWidth: 2 },
      data: n && n.assetsEur > 0 ? [
        { name: 'Lichid', value: Math.round(n.liquidEur), itemStyle: { color: t.series[1] } },
        { name: 'Ilichid', value: Math.round(n.illiquidEur), itemStyle: { color: t.series[3] } },
      ] : [],
    }],
  };
});

// ─── Forms ───

function setCheckDefaults(form: HTMLFormElement) {
  const cat = (form.elements.namedItem('category') as HTMLSelectElement).value as NetWorthAssetCategory;
  (form.elements.namedItem('liquid') as HTMLInputElement).checked = isLiquid({ category: cat });
  (form.elements.namedItem('emergency') as HTMLInputElement).checked = isEmergency({ category: cat });
}

function showNewFields(form: HTMLFormElement, show: boolean) {
  for (const el of form.querySelectorAll<HTMLElement>('[data-new]')) el.hidden = !show;
}

/** Form defaults after a reset: new item, today's date, check boxes from the category. */
function applyDefaults(form: HTMLFormElement) {
  (form.elements.namedItem('id') as HTMLInputElement).value = '';
  (form.elements.namedItem('date') as HTMLInputElement).value = today;
  showNewFields(form, true);
  if (form.getAttribute('id') === 'assetForm') setCheckDefaults(form);
}

function readFirstValue(fd: FormData): DatedValue | null | false {
  const value = parseNum(fd.get('value'));
  if (value === undefined) return null;
  if (Number.isNaN(value) || value < 0) { toast('Valoarea trebuie să fie un număr pozitiv.', 'err'); return false; }
  const date = text(fd, 'date') ?? today;
  return { date, value };
}

function upsertPoint(points: DatedValue[], p: DatedValue) {
  const i = points.findIndex(x => x.date === p.date);
  if (i >= 0) points[i] = p; else points.push(p);
  points.sort((a, b) => a.date.localeCompare(b.date));
}

function initForms() {
  const assetForm = $<HTMLFormElement>('#assetForm');
  const debtForm = $<HTMLFormElement>('#debtForm');
  applyDefaults(assetForm); applyDefaults(debtForm);
  // The reset event fires before the browser clears the fields, so apply the defaults right after.
  assetForm.addEventListener('reset', () => setTimeout(() => applyDefaults(assetForm)));
  debtForm.addEventListener('reset', () => setTimeout(() => applyDefaults(debtForm)));
  (assetForm.elements.namedItem('category') as HTMLSelectElement).addEventListener('change', () => {
    if (!(assetForm.elements.namedItem('id') as HTMLInputElement).value) setCheckDefaults(assetForm);
  });

  assetForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(assetForm);
    const name = text(fd, 'name');
    if (!name) { toast('Scrie o denumire.', 'err'); return; }
    const id = text(fd, 'id');
    const first = id ? null : readFirstValue(fd);
    if (first === false) return;
    const category = fd.get('category') as NetWorthAssetCategory;
    const liquid = fd.get('liquid') === 'on', emergency = fd.get('emergency') === 'on';
    const fields = {
      name, category, currency: fd.get('currency') as Currency, notes: text(fd, 'notes'),
      // Store the flags only when they differ from the category default
      liquid: liquid === isLiquid({ category }) ? undefined : liquid,
      emergency: emergency === isEmergency({ category }) ? undefined : emergency,
    };
    const ok = await commit(nw => {
      const existing = id ? nw.assets.find(a => a.id === id) : undefined;
      if (existing) {
        Object.assign(existing, fields);
        for (const k of ['liquid', 'emergency', 'notes'] as const) if (existing[k] === undefined) delete existing[k];
      } else {
        const a = { id: newId(), ...fields, values: first ? [first] : [] };
        for (const k of ['liquid', 'emergency', 'notes'] as const) if (a[k] === undefined) delete a[k];
        nw.assets.push(a);
      }
    }, id ? 'Activul a fost actualizat.' : 'Activul a fost adăugat.');
    if (ok) assetForm.reset();
  });

  debtForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(debtForm);
    const name = text(fd, 'name');
    if (!name) { toast('Scrie o denumire.', 'err'); return; }
    const ratePct = parseNum(fd.get('rate'));
    const pay = parseNum(fd.get('monthlyPayment'));
    if (Number.isNaN(ratePct) || (ratePct !== undefined && (ratePct < 0 || ratePct > 100))) { toast('Dobânda: un procent între 0 și 100.', 'err'); return; }
    if (Number.isNaN(pay) || (pay !== undefined && pay < 0)) { toast('Rata lunară trebuie să fie un număr pozitiv.', 'err'); return; }
    const id = text(fd, 'id');
    const first = id ? null : readFirstValue(fd);
    if (first === false) return;
    const fields = {
      name, kind: fd.get('kind') as LiabilityKind, currency: fd.get('currency') as Currency, notes: text(fd, 'notes'),
      rate: ratePct === undefined ? undefined : Math.round(ratePct * 1e4) / 1e6, monthlyPayment: pay,
    };
    const ok = await commit(nw => {
      const existing = id ? nw.liabilities.find(l => l.id === id) : undefined;
      const target = existing ?? { id: newId(), balances: first ? [first] : [], ...fields };
      if (existing) Object.assign(existing, fields); else nw.liabilities.push(target);
      for (const k of ['rate', 'monthlyPayment', 'notes'] as const) if (target[k] === undefined) delete target[k];
    }, id ? 'Datoria a fost actualizată.' : 'Datoria a fost adăugată.');
    if (ok) debtForm.reset();
  });

  const valueForm = $<HTMLFormElement>('#valueForm');
  (valueForm.elements.namedItem('date') as HTMLInputElement).value = today;
  $<HTMLSelectElement>('#valueTarget').addEventListener('change', () => { renderValueTargets(); renderValues(); });
  valueForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(valueForm);
    const key = String(fd.get('target') ?? '');
    if (!key || !targetPoints(key)) { toast('Alege un activ sau o datorie.', 'err'); return; }
    const date = text(fd, 'date');
    const value = parseNum(fd.get('value'));
    if (!date) { toast('Alege data.', 'err'); return; }
    if (value === undefined || Number.isNaN(value) || value < 0) { toast('Valoarea trebuie să fie un număr pozitiv (0 = vândut / achitat).', 'err'); return; }
    const point: DatedValue = { date, value, ...(text(fd, 'note') ? { note: text(fd, 'note') } : {}) };
    const ok = await commit(nw => {
      const id = key.slice(key.indexOf(':') + 1);
      const list = key.startsWith('asset:') ? nw.assets.find(a => a.id === id)?.values : nw.liabilities.find(l => l.id === id)?.balances;
      if (list) upsertPoint(list, point);
    }, 'Valoarea a fost salvată.');
    if (ok) {
      (valueForm.elements.namedItem('value') as HTMLInputElement).value = '';
      (valueForm.elements.namedItem('note') as HTMLInputElement).value = '';
    }
  });

  const expForm = $<HTMLFormElement>('#expForm');
  expForm.addEventListener('submit', async e => {
    e.preventDefault();
    const v = parseNum(new FormData(expForm).get('monthlyExpenses'));
    if (Number.isNaN(v) || (v !== undefined && v < 0)) { toast('Cheltuielile: un număr pozitiv (sau gol).', 'err'); return; }
    await commit(nw => { if (v) nw.monthlyExpenses = v; else delete nw.monthlyExpenses; }, 'Cheltuielile lunare au fost salvate.');
  });

  // Table buttons (event delegation)
  document.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!b) return;
    const id = b.dataset.id!;
    const nw = nwDoc();
    switch (b.dataset.action) {
      case 'value': {
        $<HTMLSelectElement>('#valueTarget').value = id;
        renderValueTargets(); renderValues();
        $('#values').scrollIntoView({ behavior: 'smooth', block: 'start' });
        (valueForm.elements.namedItem('value') as HTMLInputElement).focus({ preventScroll: true });
        break;
      }
      case 'edit-asset': {
        const a = nw.assets.find(x => x.id === id);
        if (!a) return;
        const f = assetForm.elements;
        (f.namedItem('id') as HTMLInputElement).value = a.id;
        (f.namedItem('name') as HTMLInputElement).value = a.name;
        (f.namedItem('category') as HTMLSelectElement).value = a.category;
        (f.namedItem('currency') as HTMLSelectElement).value = a.currency;
        (f.namedItem('notes') as HTMLInputElement).value = a.notes ?? '';
        (f.namedItem('liquid') as HTMLInputElement).checked = isLiquid(a);
        (f.namedItem('emergency') as HTMLInputElement).checked = isEmergency(a);
        showNewFields(assetForm, false);
        $('#assets').scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'edit-debt': {
        const l = nw.liabilities.find(x => x.id === id);
        if (!l) return;
        const f = debtForm.elements;
        (f.namedItem('id') as HTMLInputElement).value = l.id;
        (f.namedItem('name') as HTMLInputElement).value = l.name;
        (f.namedItem('kind') as HTMLSelectElement).value = l.kind;
        (f.namedItem('currency') as HTMLSelectElement).value = l.currency;
        (f.namedItem('rate') as HTMLInputElement).value = l.rate !== undefined ? NF2.format(l.rate * 100).replace(/\./g, '') : '';
        (f.namedItem('monthlyPayment') as HTMLInputElement).value = l.monthlyPayment !== undefined ? String(l.monthlyPayment).replace('.', ',') : '';
        (f.namedItem('notes') as HTMLInputElement).value = l.notes ?? '';
        showNewFields(debtForm, false);
        $('#debts').scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'del-asset': {
        const a = nw.assets.find(x => x.id === id);
        if (a && confirm(`Ștergi activul „${a.name}” cu tot istoricul lui? (Dacă l-ai vândut, mai bine adaugi valoarea 0 la data vânzării.)`)) {
          await commit(d => { d.assets = d.assets.filter(x => x.id !== id); }, 'Activul a fost șters.');
        }
        break;
      }
      case 'del-debt': {
        const l = nw.liabilities.find(x => x.id === id);
        if (l && confirm(`Ștergi datoria „${l.name}” cu tot istoricul? (Dacă ai achitat-o, mai bine adaugi soldul 0.)`)) {
          await commit(d => { d.liabilities = d.liabilities.filter(x => x.id !== id); }, 'Datoria a fost ștearsă.');
        }
        break;
      }
      case 'del-value': {
        const [key, date] = id.split('|');
        if (!confirm(`Ștergi valoarea din ${fmtDate(date)}?`)) return;
        await commit(d => {
          const tid = key.slice(key.indexOf(':') + 1);
          if (key.startsWith('asset:')) { const a = d.assets.find(x => x.id === tid); if (a) a.values = a.values.filter(p => p.date !== date); }
          else { const l = d.liabilities.find(x => x.id === tid); if (l) l.balances = l.balances.filter(p => p.date !== date); }
        }, 'Valoarea a fost ștearsă.');
        break;
      }
    }
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cur]')) {
    b.addEventListener('click', () => {
      chartCur = b.dataset.cur as 'EUR' | 'RON';
      for (const x of document.querySelectorAll<HTMLButtonElement>('[data-cur]')) x.setAttribute('aria-pressed', String(x === b));
      timeChart.update();
    });
  }
}

async function init() {
  initForms();
  try {
    const [d, ipsDoc] = await Promise.all([loadDoc('data'), loadDoc('ips').catch(() => null)]);
    loaded = d;
    data = d.doc;
    ips = ipsDoc?.exists ? activeIpsRules(ipsDoc.doc)?.rules ?? null : null;
    renderAll();
    await refreshMarket();
  } catch (e) {
    $('#nwState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
  }
}

void init();
