// /vault/invest/portofoliu/ — ledger CRUD, positions, allocation vs target, bond ladder, pensions, CSV.
// All maths lives in src/lib/invest/; this file reads forms, saves data.json and renders.
// Every table is built with DOM APIs (textContent), never innerHTML, so user text can't inject markup.
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { SunburstChart, ScatterChart } from 'echarts/charts';
import { loadDoc, saveDoc, loadMarket, setManualPrice, type Loaded } from './api';
import { mountChart, axisStyle, type ChartTheme } from './charts';
import { toast } from './common';
import { validateDoc } from '../../lib/invest/validate';
import { emptyData, type InvestData, type Transaction, type Account, type Instrument, type TargetAllocation, type Currency, type TxType, type AccountType, type AssetClass, type Region } from '../../lib/invest/types';
import { computeLedger, yearTotals, type Ledger } from '../../lib/invest/ledger';
import { manualFx, chainFx, type FxSource } from '../../lib/invest/fx';
import { manualPrices, chainPrices, type PriceSource } from '../../lib/invest/prices';
import { bnrFx, storePrices, manualPriceRows, marketYears } from '../../lib/invest/market-sources';
import { latestFx, type FxYear, type PricesYear } from '../../lib/invest/market';
import { valuePortfolio, allocationTree, computeDrift, rebalanceWithContribution, bondLadder, type Valuation, type Holding } from '../../lib/invest/portfolio';
import { transactionsCsv } from '../../lib/invest/csv';
import { ACCOUNT_TYPE_LABEL, ASSET_CLASS_LABEL, REGION_LABEL, TX_TYPE_LABEL } from '../../lib/invest/labels';

echarts.use([SunburstChart, ScatterChart]);

// ─── Small helpers ───

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

type Child = Node | string | number | null | undefined | false;
function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

const nf = (min: number, max: number) => new Intl.NumberFormat('ro-RO', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF2 = nf(2, 2), NF0 = nf(0, 0), NFQ = nf(0, 6), NF1 = nf(1, 1);
const money = (n: number | null | undefined, cur?: string) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF2.format(n)}${cur ? ` ${cur}` : ''}`);
const money0 = (n: number | null | undefined, cur?: string) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF0.format(n)}${cur ? ` ${cur}` : ''}`);
const qty = (n: number | undefined) => (n === undefined ? '' : NFQ.format(n));
const pct = (n: number) => `${NF1.format(n * 100)}%`;
const pp = (n: number) => `${n >= 0 ? '+' : ''}${NF1.format(n * 100)} pp`;
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
/** ECharts tooltip formatters return HTML: escape anything the user typed. */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const signClass = (n: number | null | undefined) => (n === null || n === undefined || Math.abs(n) < 1e-9 ? '' : n > 0 ? 'pf-pos' : 'pf-neg');

/** Parses "1.234,5", "1234.5", "1 234,5" → number. Empty → undefined. Invalid → NaN. */
function parseNum(s: FormDataEntryValue | null): number | undefined {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return undefined;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const newId = () => crypto.randomUUID();

function table(el: HTMLElement, head: (string | [string, 'num'])[], rows: HTMLElement[], empty: string, foot?: HTMLElement) {
  el.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map(c => (Array.isArray(c) ? h('th', { class: 'num', scope: 'col' }, c[0]) : h('th', { scope: 'col' }, c))))),
    h('tbody', {}, ...(rows.length ? rows : [h('tr', { class: 'pf-empty' }, h('td', { colspan: String(head.length) }, empty))])),
  );
  if (foot) el.append(h('tfoot', {}, foot));
}
const td = (v: Child, cls?: string) => h('td', { class: cls }, v);
const num = (v: Child, extra = '') => h('td', { class: `num ${extra}`.trim() }, v);

function actionButtons(onEdit: (() => void) | null, onDelete: () => void, what: string) {
  const box = h('div', { class: 'pf-btns' });
  if (onEdit) {
    const b = h('button', { type: 'button', class: 'inv-btn', 'aria-label': `Editează ${what}` }, 'Editează');
    b.addEventListener('click', onEdit);
    box.append(b);
  }
  const d = h('button', { type: 'button', class: 'inv-btn', 'aria-label': `Șterge ${what}` }, 'Șterge');
  d.addEventListener('click', onDelete);
  box.append(d);
  return h('td', {}, box);
}

// ─── State ───

let loaded: Loaded<'data'> | null = null;
let data: InvestData = emptyData();
let ledger: Ledger;
let fx: FxSource;
let prices: PriceSource;
let valuation: Valuation;
let asOf = todayIso();
/** Phase 3 market store: BNR rates and prices (automatic closes + manual corrections) */
let fxDocs: FxYear[] = [];
let priceDocs: PricesYear[] = [];
let marketKey = '';

const accName = (id?: string) => data.accounts.find(a => a.id === id)?.name ?? '—';
const instById = (id?: string) => data.instruments.find(i => i.id === id);
const instName = (id?: string) => { const i = instById(id); return i ? (i.ticker ? `${i.ticker} · ${i.name}` : i.name) : '—'; };

function recompute() {
  // BNR first, manual rates only where BNR has nothing. Price store (manual corrections + automatic closes) first,
  // older manual prices kept in data.json last.
  fx = chainFx(bnrFx(fxDocs), manualFx(data.fxRates ?? []));
  prices = chainPrices(storePrices(priceDocs, data.instruments, fx), manualPrices(data.prices ?? []));
  ledger = computeLedger(data, fx, asOf);
  valuation = valuePortfolio(data, ledger, prices, fx, asOf);
}

/** Loads BNR rates and prices for every year with a transaction (and the current one), then re-renders. */
async function refreshMarket(force = false) {
  const years = marketYears(data.transactions.map(t => t.date), todayIso());
  const key = years.join(',');
  if (!force && key === marketKey) return;
  try {
    const m = await loadMarket(years);
    fxDocs = m.fx;
    priceDocs = m.prices;
    marketKey = key;
    renderAll();
  } catch (e) {
    toast(`Cursurile BNR și prețurile automate nu s-au încărcat: ${(e as Error).message}`, 'err');
  }
}

/** Applies a change to a copy of the data, validates, saves (ETag) and re-renders. */
async function commit(mutate: (d: InvestData) => void, okMessage: string): Promise<boolean> {
  if (!loaded) { toast('Datele nu s-au încărcat încă.', 'err'); return false; }
  const next = structuredClone(data);
  mutate(next);
  const problems = validateDoc('data', next);
  if (problems.length) { toast(`Date invalide: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    loaded = await saveDoc('data', loaded, next);
    data = next;
    renderAll();
    toast(okMessage);
    void refreshMarket(); // a transaction in a new year needs that year's rates
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

// ─── Select options (accounts / instruments) ───

function fillSelects() {
  for (const sel of $$<HTMLSelectElement>('select[data-accounts]')) {
    const cur = sel.value;
    const opts: HTMLElement[] = [];
    if (sel.dataset.optional !== undefined) opts.push(h('option', { value: '' }, sel.dataset.all ?? '—'));
    for (const a of data.accounts) opts.push(h('option', { value: a.id }, `${a.name}${a.closed ? ' (închis)' : ''}`));
    sel.replaceChildren(...opts);
    sel.value = cur;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  }
  for (const sel of $$<HTMLSelectElement>('select[data-pension-accounts]')) {
    const cur = sel.value;
    sel.replaceChildren(...data.accounts.filter(a => a.type === 'pillar2' || a.type === 'pillar3').map(a => h('option', { value: a.id }, a.name)));
    sel.value = cur;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  }
  for (const sel of $$<HTMLSelectElement>('select[data-instruments]')) {
    const cur = sel.value;
    const opts: HTMLElement[] = [];
    if (sel.dataset.optional !== undefined) opts.push(h('option', { value: '' }, '—'));
    for (const i of [...data.instruments].sort((a, b) => a.name.localeCompare(b.name, 'ro'))) opts.push(h('option', { value: i.id }, instName(i.id)));
    sel.replaceChildren(...opts);
    sel.value = cur;
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  }
}

// ─── Form helpers ───

function setForm(form: HTMLFormElement, values: Record<string, unknown>) {
  form.reset();
  for (const [k, v] of Object.entries(values)) {
    const field = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!field) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(v);
    else field.value = v === undefined || v === null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  }
  form.dispatchEvent(new Event('input'));
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Reads numbers and marks invalid fields. Returns null when something is invalid. */
function readNums(form: HTMLFormElement, names: string[]): Record<string, number | undefined> | null {
  const fd = new FormData(form);
  const out: Record<string, number | undefined> = {};
  let ok = true;
  for (const n of names) {
    const field = form.elements.namedItem(n) as HTMLInputElement | null;
    const v = parseNum(fd.get(n));
    const bad = v !== undefined && Number.isNaN(v);
    field?.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) ok = false;
    out[n] = v;
  }
  if (!ok) toast('Verifică numerele marcate cu roșu.', 'err');
  return ok ? out : null;
}
const text = (fd: FormData, k: string) => { const v = String(fd.get(k) ?? '').trim(); return v || undefined; };
/** Drops undefined keys so the strict validator doesn't see them. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
function required(form: HTMLFormElement, names: string[]) {
  let ok = true;
  for (const n of names) {
    const f = form.elements.namedItem(n) as HTMLInputElement | null;
    const bad = !f || !String(f.value).trim();
    f?.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) ok = false;
  }
  if (!ok) toast('Completează câmpurile obligatorii.', 'err');
  return ok;
}

// ─── Summary + warnings ───

function renderSummary() {
  const set = (k: string, v: string, cls = '') => { const e = $(`[data-sum="${k}"]`); e.textContent = v; e.className = cls; };
  set('eur', money0(valuation.totalEur, '€'));
  set('ron', money0(valuation.totalRon, 'lei'));
  const unreal = valuation.holdings.reduce((s, x) => {
    if (x.unrealized === undefined || x.basis !== 'market') return s;
    const r = fx.rate(x.currency, asOf), e = fx.rate('EUR', asOf);
    return r && e ? s + (x.unrealized * r.ron) / e.ron : s;
  }, 0);
  set('unreal', money0(unreal, '€'), signClass(unreal));
  const y = yearTotals(ledger, Number(asOf.slice(0, 4)));
  set('real', money0(y.netGainRon, 'lei'), signClass(y.netGainRon));
  set('income', money0(y.divRon - y.divTaxRon + y.intRon - y.intTaxRon, 'lei'));

  const msgs: string[] = [];
  if (valuation.missingFx.length) msgs.push(`Lipsesc cursuri valutare pentru: ${valuation.missingFx.join(', ')} (la ${fmtDate(asOf)} sau înainte). Cursurile BNR se iau automat în zilele lucrătoare (sau apasă „Actualizează acum” în Panou); altfel adaugă-le în „Cursuri & prețuri”. Până atunci acele valori nu intră în total.`);
  const noPrice = valuation.holdings.filter(x => x.basis === 'cost').length;
  if (noPrice) msgs.push(`${noPrice} ${noPrice === 1 ? 'poziție nu are' : 'poziții nu au'} preț; sunt evaluate la cost.`);
  const txWarn = new Map<string, number>();
  for (const w of ledger.warnings) txWarn.set(w.message, (txWarn.get(w.message) ?? 0) + 1);
  for (const [m, c] of [...txWarn].slice(0, 6)) msgs.push(c > 1 ? `${m} (${c} tranzacții)` : m);
  const box = $('#warnings');
  box.replaceChildren(...msgs.map(m => h('li', {}, m)));
  box.hidden = msgs.length === 0;

  $('#loadState').textContent = data.transactions.length || data.accounts.length
    ? `${data.accounts.length} conturi · ${data.instruments.length} instrumente · ${data.transactions.length} tranzacții.`
    : 'Nu ai încă date. Începe cu tab-ul „Conturi & instrumente”: adaugă un cont, apoi instrumentele, apoi tranzacțiile.';
}

// ─── Positions ───

const BASIS_LABEL: Record<string, string> = { market: 'piață', face: 'nominal', cost: 'cost', pension: 'extras', cash: 'cash' };

function renderPositions() {
  const pos = valuation.holdings.filter(x => x.kind === 'position').sort((a, b) => (b.valueEur ?? 0) - (a.valueEur ?? 0));
  const totalEur = pos.reduce((s, x) => s + (x.valueEur ?? 0), 0);
  const rows = pos.map(x => {
    const p = ledger.positions.find(q => q.accountId === x.accountId && q.instrumentId === x.instrumentId)!;
    return h('tr', {},
      td(instName(x.instrumentId)), td(accName(x.accountId)), num(qty(x.quantity)),
      num(money(p.avgCost, x.currency)),
      num(h('span', {}, money(x.price, x.currency), ' ', h('span', { class: 'pf-tag', title: x.priceDate ? `din ${fmtDate(x.priceDate)}` : undefined }, BASIS_LABEL[x.basis]))),
      num(money(x.value, x.currency)), num(money0(x.valueEur, '€')), num(money0(x.valueRon, 'lei')),
      num(money(x.unrealized, x.currency), signClass(x.unrealized)),
      num(x.cost ? pct((x.unrealized ?? 0) / x.cost) : '—', signClass(x.unrealized)),
    );
  });
  table($('#positionsTable'),
    ['Instrument', 'Cont', ['Cantitate', 'num'], ['Cost mediu', 'num'], ['Preț', 'num'], ['Valoare', 'num'], ['EUR', 'num'], ['RON', 'num'], ['Câștig nerealizat', 'num'], ['%', 'num']],
    rows, 'Nicio poziție deschisă. Adaugă o cumpărare în tab-ul „Tranzacții”.',
    pos.length ? h('tr', {}, h('td', { colspan: '6' }, 'Total'), num(money0(totalEur, '€')), td(''), td(''), td('')) : undefined);

  const cashRows = ledger.cash.filter(c => ledger.cashTracked.has(c.accountId)).map(c => h('tr', {},
    td(accName(c.accountId)), td(c.currency), num(money(c.amount, c.currency), signClass(c.amount)),
  ));
  table($('#cashTable'), ['Cont', 'Moneda', ['Sold', 'num']], cashRows, 'Niciun cont cu depuneri înregistrate.');
}

// ─── Transactions ───

function updateTxFields() {
  const form = $<HTMLFormElement>('#txForm');
  const type = (form.elements.namedItem('type') as HTMLSelectElement).value as TxType;
  for (const lab of $$<HTMLLabelElement>('label[data-show]', form)) lab.hidden = !lab.dataset.show!.split(' ').includes(type);
  const hints: Partial<Record<TxType, string>> = {
    buy: 'Cumpărare: cantitate × preț în moneda tranzacției; comisionul intră în costul mediu.',
    sell: 'Vânzare: costul mediu rămâne neschimbat; câștigul = încasare − comision − cost mediu × cantitate.',
    dividend: 'Dividend: suma brută și impozitul reținut la sursă (ex. 15% SUA cu W-8BEN).',
    interest: 'Dobândă / cupon: suma brută și impozitul reținut, dacă e cazul.',
    transfer: 'Transfer: cu instrument și cantitate mută titlurile (cu costul lor mediu); fără instrument mută cash.',
    deposit: 'Depunere de bani în cont. Odată ce un cont are depuneri, cash-ul lui intră în valoarea totală.',
  };
  $('#txHint').textContent = hints[type] ?? '';
}

function renderTransactions() {
  const filter = $<HTMLSelectElement>('#txFilter').value;
  const txs = data.transactions
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !filter || t.accountId === filter || t.toAccountId === filter)
    .sort((a, b) => b.t.date.localeCompare(a.t.date) || b.i - a.i)
    .map(x => x.t);
  const warned = new Map(ledger.warnings.map(w => [w.txId, w.message]));
  const rows = txs.map(t => {
    const w = warned.get(t.id);
    const total = t.type === 'buy' || t.type === 'sell' ? (t.quantity ?? 0) * (t.price ?? 0) : t.amount;
    return h('tr', {},
      td(fmtDate(t.date)),
      td(h('span', {}, TX_TYPE_LABEL[t.type], w ? h('span', { class: 'pf-tag pf-tag--warn', title: w }, ' ! ') : null)),
      td(t.type === 'transfer' ? `${accName(t.accountId)} → ${accName(t.toAccountId)}` : accName(t.accountId)),
      td(t.instrumentId ? instName(t.instrumentId) : ''),
      num(qty(t.quantity)), num(t.price !== undefined ? money(t.price) : ''), num(money(total, t.currency)),
      num(t.fees ? money(t.fees) : ''), num(t.withheldTax ? money(t.withheldTax) : ''),
      h('td', { class: 'pf-note' }, t.note ?? ''),
      actionButtons(() => editTx(t), () => deleteTx(t), `tranzacția din ${fmtDate(t.date)}`),
    );
  });
  table($('#txTable'),
    ['Data', 'Tip', 'Cont', 'Instrument', ['Cant.', 'num'], ['Preț', 'num'], ['Total', 'num'], ['Comision', 'num'], ['Impozit', 'num'], 'Notă', ''],
    rows, data.accounts.length ? 'Nicio tranzacție încă.' : 'Adaugă întâi un cont (tab-ul „Conturi & instrumente”).');
}

function editTx(t: Transaction) {
  setForm($<HTMLFormElement>('#txForm'), { ...t });
  updateTxFields();
}

async function deleteTx(t: Transaction) {
  if (!confirm(`Ștergi tranzacția ${TX_TYPE_LABEL[t.type]} din ${fmtDate(t.date)}?`)) return;
  await commit(d => { d.transactions = d.transactions.filter(x => x.id !== t.id); }, 'Tranzacția a fost ștearsă.');
}

async function submitTx(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['date', 'accountId'])) return;
  const fd = new FormData(form);
  const type = fd.get('type') as TxType;
  const visible = (n: string) => !(form.elements.namedItem(n) as HTMLElement).closest('label')?.hidden;
  const nums = readNums(form, ['quantity', 'price', 'amount', 'fees', 'withheldTax']);
  if (!nums) return;
  const pick = (n: string) => (visible(n) ? nums[n] : undefined);
  const t: Transaction = clean({
    id: text(fd, 'id') ?? newId(),
    date: String(fd.get('date')),
    type,
    accountId: String(fd.get('accountId')),
    instrumentId: visible('instrumentId') ? text(fd, 'instrumentId') : undefined,
    quantity: pick('quantity'),
    price: pick('price'),
    amount: pick('amount'),
    currency: fd.get('currency') as Currency,
    fees: nums.fees || undefined,
    withheldTax: pick('withheldTax') || undefined,
    toAccountId: visible('toAccountId') ? text(fd, 'toAccountId') : undefined,
    note: text(fd, 'note'),
  });
  if ((type === 'buy' || type === 'sell') && (!t.instrumentId || !(t.quantity! > 0) || t.price === undefined || t.price < 0)) {
    toast('Pentru cumpărare/vânzare alege instrumentul și completează cantitatea și prețul.', 'err'); return;
  }
  if (['dividend', 'interest', 'fee', 'deposit', 'withdrawal'].includes(type) && !(t.amount! > 0)) { toast('Completează suma.', 'err'); return; }
  if (type === 'transfer') {
    if (!t.toAccountId || t.toAccountId === t.accountId) { toast('Alege un cont destinație diferit.', 'err'); return; }
    if (t.instrumentId ? !(t.quantity! > 0) : !(t.amount! > 0)) { toast('Completează cantitatea (titluri) sau suma (cash).', 'err'); return; }
  }
  const editing = data.transactions.some(x => x.id === t.id);
  const ok = await commit(d => {
    const i = d.transactions.findIndex(x => x.id === t.id);
    if (i >= 0) d.transactions[i] = t; else d.transactions.push(t);
  }, editing ? 'Tranzacția a fost actualizată.' : 'Tranzacția a fost adăugată.');
  if (ok) {
    const keep = { date: t.date, type: t.type, accountId: t.accountId, currency: t.currency };
    form.reset();
    setFormQuiet(form, keep);
    updateTxFields();
  }
}

/** Like setForm but without scrolling. */
function setFormQuiet(form: HTMLFormElement, values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) {
    const f = form.elements.namedItem(k) as HTMLInputElement | null;
    if (f) f.value = v;
  }
}

function downloadCsv() {
  const blob = new Blob([transactionsCsv(data)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `tranzactii-${todayIso()}.csv` }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Accounts & instruments ───

function renderAccounts() {
  const rows = data.accounts.map(a => h('tr', {},
    td(a.name), td(ACCOUNT_TYPE_LABEL[a.type]), td(a.institution ?? ''), td(a.currency),
    td(a.closed ? h('span', { class: 'pf-tag' }, 'închis') : ''), h('td', { class: 'pf-note' }, a.notes ?? ''),
    actionButtons(() => setForm($<HTMLFormElement>('#accountForm'), { ...a }), () => deleteAccount(a), `contul ${a.name}`),
  ));
  table($('#accountTable'), ['Nume', 'Tip', 'Instituție', 'Moneda', 'Status', 'Note', ''], rows, 'Niciun cont. Adaugă primul cont mai sus.');
}

async function deleteAccount(a: Account) {
  const used = data.transactions.some(t => t.accountId === a.id || t.toAccountId === a.id) || (data.pensionValues ?? []).some(v => v.accountId === a.id);
  if (used) { toast('Contul are tranzacții sau valori de pensie. Șterge-le întâi sau marchează contul ca închis.', 'err'); return; }
  if (!confirm(`Ștergi contul „${a.name}”?`)) return;
  await commit(d => { d.accounts = d.accounts.filter(x => x.id !== a.id); }, 'Contul a fost șters.');
}

async function submitAccount(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['name'])) return;
  const fd = new FormData(form);
  const a: Account = clean({
    id: text(fd, 'id') ?? newId(), name: text(fd, 'name')!, type: fd.get('type') as AccountType,
    institution: text(fd, 'institution'), currency: fd.get('currency') as Currency, notes: text(fd, 'notes'),
    closed: fd.get('closed') ? true : undefined,
  });
  const ok = await commit(d => {
    const i = d.accounts.findIndex(x => x.id === a.id);
    if (i >= 0) d.accounts[i] = a; else d.accounts.push(a);
  }, 'Contul a fost salvat.');
  if (ok) form.reset();
}

function renderInstruments() {
  const rows = [...data.instruments].sort((a, b) => a.name.localeCompare(b.name, 'ro')).map(i => h('tr', {},
    td(i.name), td(i.ticker ?? ''), td(i.isin ?? ''), td(ASSET_CLASS_LABEL[i.assetClass]), td(REGION_LABEL[i.region]), td(i.currency),
    td(i.distribution === 'accumulating' ? 'Acumulare' : i.distribution === 'distributing' ? 'Distribuție' : ''),
    td(i.maturity ? fmtDate(i.maturity) : ''), num(i.coupon !== undefined ? pct(i.coupon) : ''),
    actionButtons(() => setForm($<HTMLFormElement>('#instrumentForm'), { ...i, coupon: i.coupon !== undefined ? +(i.coupon * 100).toFixed(6) : undefined }), () => deleteInstrument(i), `instrumentul ${i.name}`),
  ));
  table($('#instrumentTable'), ['Nume', 'Ticker', 'ISIN', 'Clasă', 'Regiune', 'Moneda', 'Tip', 'Scadență', ['Cupon', 'num'], ''], rows, 'Niciun instrument încă.');
}

async function deleteInstrument(i: Instrument) {
  const used = data.transactions.some(t => t.instrumentId === i.id) || data.targets.some(t => t.instrumentId === i.id) || (data.prices ?? []).some(p => p.instrumentId === i.id);
  if (used) { toast('Instrumentul e folosit în tranzacții, prețuri sau în țintă. Șterge-le întâi.', 'err'); return; }
  if (!confirm(`Ștergi instrumentul „${i.name}”?`)) return;
  await commit(d => { d.instruments = d.instruments.filter(x => x.id !== i.id); }, 'Instrumentul a fost șters.');
}

async function submitInstrument(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['name'])) return;
  const fd = new FormData(form);
  const nums = readNums(form, ['coupon', 'faceValue']);
  if (!nums) return;
  const i: Instrument = clean({
    id: text(fd, 'id') ?? newId(), name: text(fd, 'name')!, ticker: text(fd, 'ticker'), isin: text(fd, 'isin')?.toUpperCase(),
    assetClass: fd.get('assetClass') as AssetClass, region: fd.get('region') as Region, currency: fd.get('currency') as Currency,
    distribution: (text(fd, 'distribution') as Instrument['distribution']) ?? undefined, priceSource: text(fd, 'priceSource'),
    coupon: nums.coupon !== undefined ? nums.coupon / 100 : undefined, maturity: text(fd, 'maturity'), faceValue: nums.faceValue,
  });
  const ok = await commit(d => {
    const k = d.instruments.findIndex(x => x.id === i.id);
    if (k >= 0) d.instruments[k] = i; else d.instruments.push(i);
  }, 'Instrumentul a fost salvat.');
  if (ok) form.reset();
}

// ─── FX + prices ───

function renderFx() {
  const rates = [...(data.fxRates ?? [])].map((r, i) => ({ r, i })).sort((a, b) => b.r.date.localeCompare(a.r.date) || a.r.currency.localeCompare(b.r.currency));
  table($('#fxTable'), ['Data', 'Moneda', ['Lei / unitate', 'num'], 'Notă', ''],
    rates.slice(0, 300).map(({ r }) => h('tr', {}, td(fmtDate(r.date)), td(r.currency), num(nf(4, 4).format(r.ron)), h('td', { class: 'pf-note' }, r.note ?? ''),
      actionButtons(null, () => { void commit(d => { d.fxRates = (d.fxRates ?? []).filter(x => !(x.date === r.date && x.currency === r.currency)); }, 'Cursul a fost șters.'); }, `cursul ${r.currency} din ${fmtDate(r.date)}`))),
    'Niciun curs introdus.');

  const bnr = latestFx(fxDocs);
  $('#bnrInfo').textContent = bnr
    ? `Ultimul curs BNR (${fmtDate(bnr.date)}): ${Object.entries(bnr.rates).map(([c, r]) => `${c} ${nf(4, 4).format(r ?? 0)}`).join(' · ')}`
    : 'Încă nu există cursuri BNR salvate. Se iau automat în zilele lucrătoare sau cu „Actualizează acum” din Panou.';

  // Manual corrections live in the price store; prices in data.json are older entries kept as a fallback
  const store = manualPriceRows(priceDocs).map(p => h('tr', {}, td(fmtDate(p.date)), td(instName(p.instrumentId)), num(money(p.close, p.currency)), h('td', { class: 'pf-note' }, ''),
    actionButtons(null, () => { void removeStorePrice(p.instrumentId, p.date, p.currency); }, `prețul din ${fmtDate(p.date)}`)));
  const legacy = [...(data.prices ?? [])].sort((a, b) => b.date.localeCompare(a.date)).map(p => h('tr', {}, td(fmtDate(p.date)), td(instName(p.instrumentId)), num(money(p.price, instById(p.instrumentId)?.currency)), h('td', { class: 'pf-note' }, `${p.note ? `${p.note} · ` : ''}introdus înainte de prețurile automate`),
    actionButtons(null, () => { void commit(d => { d.prices = (d.prices ?? []).filter(x => !(x.date === p.date && x.instrumentId === p.instrumentId)); }, 'Prețul a fost șters.'); }, `prețul din ${fmtDate(p.date)}`)));
  table($('#priceTable'), ['Data', 'Instrument', ['Preț', 'num'], 'Notă', ''], [...store, ...legacy].slice(0, 300), 'Nicio corecție manuală.');
}

async function submitFx(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['date', 'ron'])) return;
  const nums = readNums(form, ['ron']);
  if (!nums || !(nums.ron! > 0)) { toast('Cursul trebuie să fie un număr pozitiv.', 'err'); return; }
  const fd = new FormData(form);
  const r = clean({ date: String(fd.get('date')), currency: fd.get('currency') as Currency, ron: nums.ron!, note: text(fd, 'note') });
  const ok = await commit(d => {
    const list = (d.fxRates ?? []).filter(x => !(x.date === r.date && x.currency === r.currency));
    list.push(r);
    d.fxRates = list;
  }, 'Cursul a fost salvat.');
  if (ok) (form.elements.namedItem('ron') as HTMLInputElement).value = '';
}

/** Manual prices go to the same store as the automatic ones (the daily update never overwrites a manual entry). */
async function submitPrice(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['instrumentId', 'date', 'price'])) return;
  const nums = readNums(form, ['price']);
  if (!nums || !(nums.price! > 0)) { toast('Prețul trebuie să fie un număr pozitiv.', 'err'); return; }
  const fd = new FormData(form);
  const inst = instById(String(fd.get('instrumentId')));
  if (!inst) { toast('Alege un instrument.', 'err'); return; }
  try {
    await setManualPrice({ instrumentId: inst.id, date: String(fd.get('date')), close: nums.price!, currency: inst.currency });
    await refreshMarket(true);
    toast('Prețul a fost salvat.');
    (form.elements.namedItem('price') as HTMLInputElement).value = '';
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

async function removeStorePrice(instrumentId: string, date: string, currency: Currency) {
  if (!confirm('Ștergi prețul introdus manual? La următoarea actualizare se folosește prețul automat, dacă există.')) return;
  try {
    await setManualPrice({ instrumentId, date, close: null, currency });
    await refreshMarket(true);
    toast('Prețul a fost șters.');
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

// ─── Pensions ───

function renderPensions() {
  const vals = [...(data.pensionValues ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  table($('#pensionTable'), ['Data', 'Cont', ['Valoare', 'num'], 'Notă', ''],
    vals.map(v => {
      const acc = data.accounts.find(a => a.id === v.accountId);
      return h('tr', {}, td(fmtDate(v.date)), td(acc?.name ?? '—'), num(money(v.value, acc?.currency)), h('td', { class: 'pf-note' }, v.note ?? ''),
        actionButtons(() => setForm($<HTMLFormElement>('#pensionForm'), { ...v }), () => { if (confirm('Ștergi valoarea?')) void commit(d => { d.pensionValues = (d.pensionValues ?? []).filter(x => x.id !== v.id); }, 'Valoarea a fost ștearsă.'); }, `valoarea din ${fmtDate(v.date)}`));
    }),
    data.accounts.some(a => a.type === 'pillar2' || a.type === 'pillar3') ? 'Nicio valoare introdusă.' : 'Adaugă întâi un cont de tip Pilon 2 sau Pilon 3.');
}

async function submitPension(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['accountId', 'date', 'value'])) return;
  const nums = readNums(form, ['value']);
  if (!nums || !(nums.value! >= 0)) return;
  const fd = new FormData(form);
  const v = clean({ id: text(fd, 'id') ?? newId(), accountId: String(fd.get('accountId')), date: String(fd.get('date')), value: nums.value!, note: text(fd, 'note') });
  const ok = await commit(d => {
    const list = d.pensionValues ?? [];
    const i = list.findIndex(x => x.id === v.id);
    if (i >= 0) list[i] = v; else list.push(v);
    d.pensionValues = list;
  }, 'Valoarea a fost salvată.');
  if (ok) form.reset();
}

// ─── Allocation: targets, drift, rebalance ───

function scopeHoldings(): Holding[] {
  const incP = $<HTMLInputElement>('#incPension').checked;
  const incC = $<HTMLInputElement>('#incCash').checked;
  return valuation.holdings.filter(x => (incP || x.kind !== 'pension') && (incC || x.kind !== 'cash') && (x.valueEur ?? 0) > 0);
}

const DEFAULT_BAND = 0.05;

function renderTargets() {
  const sum = data.targets.reduce((s, t) => s + t.weight, 0);
  const sumEl = $('#targetSum');
  sumEl.textContent = data.targets.length ? `Total ponderi: ${pct(sum)}${Math.abs(sum - 1) > 0.0005 ? ' — trebuie să fie 100%.' : ' ✓'}` : '';
  sumEl.className = data.targets.length && Math.abs(sum - 1) > 0.0005 ? 'pf-neg' : 'inv-muted';
  const rows = data.targets.map(t => h('tr', {},
    td(t.label), td(ASSET_CLASS_LABEL[t.assetClass]), td(t.region ? REGION_LABEL[t.region] : '—'), td(t.instrumentId ? instName(t.instrumentId) : '—'),
    num(pct(t.weight)), num(`± ${NF1.format((t.band ?? DEFAULT_BAND) * 100)} pp`),
    actionButtons(() => setForm($<HTMLFormElement>('#targetForm'), { ...t, weight: +(t.weight * 100).toFixed(4), band: t.band !== undefined ? +(t.band * 100).toFixed(4) : undefined }),
      () => { if (confirm(`Ștergi rândul „${t.label}”?`)) void commit(d => { d.targets = d.targets.filter(x => x.id !== t.id); }, 'Rândul a fost șters.'); }, `rândul ${t.label}`),
  ));
  table($('#targetTable'), ['Denumire', 'Clasă', 'Regiune', 'Instrument', ['Pondere', 'num'], ['Bandă', 'num'], ''], rows, 'Nu ai definit încă o țintă. Adaugă rândurile tale mai sus.');
}

async function submitTarget(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (!required(form, ['label', 'weight'])) return;
  const nums = readNums(form, ['weight', 'band']);
  if (!nums) return;
  if (!(nums.weight! > 0 && nums.weight! <= 100)) { toast('Ponderea e un procent între 0 și 100.', 'err'); return; }
  const fd = new FormData(form);
  const t: TargetAllocation = clean({
    id: text(fd, 'id') ?? newId(), label: text(fd, 'label')!, assetClass: fd.get('assetClass') as AssetClass,
    region: (text(fd, 'region') as Region | undefined), instrumentId: text(fd, 'instrumentId'),
    weight: nums.weight! / 100, band: nums.band !== undefined ? Math.abs(nums.band) / 100 : undefined,
  });
  const ok = await commit(d => {
    const i = d.targets.findIndex(x => x.id === t.id);
    if (i >= 0) d.targets[i] = t; else d.targets.push(t);
  }, 'Ținta a fost salvată.');
  if (ok) form.reset();
}

function renderDrift() {
  const d = computeDrift(scopeHoldings(), data.targets, DEFAULT_BAND);
  const rows = d.rows.map(r => h('tr', {},
    td(r.target.label), num(money0(r.value, '€')), num(pct(r.actualWeight)), num(pct(r.target.weight)), num(pp(r.diff), signClass(r.status === 'ok' ? 0 : -1)),
    td(h('span', { class: `pf-tag ${r.status === 'ok' ? 'pf-tag--ok' : 'pf-tag--warn'}` }, r.status === 'ok' ? 'în bandă' : r.status === 'over' ? 'peste bandă' : 'sub bandă')),
  ));
  table($('#driftTable'), ['Rând țintă', ['Valoare', 'num'], ['Actual', 'num'], ['Țintă', 'num'], ['Abatere', 'num'], 'Status'], rows,
    'Definește ținta de alocare (mai jos) ca să vezi abaterile.',
    d.unmatched > 0 ? h('tr', {}, td('În afara țintei (nu intră în ponderi)'), num(money0(d.unmatched, '€')), td(''), td(''), td(''), td('')) : undefined);
  return d;
}

function renderRebalance() {
  const form = $<HTMLFormElement>('#rebForm');
  const amount = parseNum(new FormData(form).get('amount'));
  const el = $('#rebTable');
  if (!amount || !(amount > 0)) { el.replaceChildren(); return; }
  if (!data.targets.length) { table(el, ['Rând țintă'], [], 'Definește întâi ținta de alocare.'); return; }
  const d = computeDrift(scopeHoldings(), data.targets, DEFAULT_BAND);
  const buys = rebalanceWithContribution(d.rows.map(r => ({ id: r.target.id, weight: r.target.weight, value: r.value })), amount);
  const newTotal = d.total + amount;
  const rows = d.rows.map(r => {
    const buy = buys.get(r.target.id) ?? 0;
    const inst = r.target.instrumentId ? instById(r.target.instrumentId) : undefined;
    let units = '';
    if (inst && buy > 0) {
      const q = prices.price(inst.id, asOf);
      const rate = fx.rate(inst.currency, asOf), eur = fx.rate('EUR', asOf);
      if (q && q.price > 0 && rate && eur) units = `≈ ${NF2.format((buy * eur.ron) / rate.ron / q.price)} unități`;
    }
    return h('tr', {}, td(r.target.label), num(money0(buy, '€'), buy > 0 ? 'pf-pos' : ''), td(units),
      num(pct(r.actualWeight)), num(newTotal ? pct((r.value + buy) / newTotal) : '—'), num(pct(r.target.weight)));
  });
  table(el, ['Rând țintă', ['Cumpără', 'num'], 'Cantitate', ['Acum', 'num'], ['După', 'num'], ['Țintă', 'num']], rows, '');
}

// ─── Charts (mounted when their tab is first shown) ───

type Mounted = { update: () => void };
const charts = new Map<string, Mounted>();

const hierLabel: Record<number, (n: string) => string> = {
  0: n => ASSET_CLASS_LABEL[n as AssetClass] ?? n,
  1: n => REGION_LABEL[n as Region] ?? n,
};
const tooltipBase = (t: ChartTheme) => ({ backgroundColor: t.bg, borderColor: t.border, textStyle: { color: t.text, fontFamily: t.font } });

function sunburstOption(t: ChartTheme): EChartsCoreOption {
  const leafLabel = (x: Holding) => x.instrumentId ? (instById(x.instrumentId)?.ticker || instById(x.instrumentId)?.name || '?') : x.kind === 'cash' ? `Cash ${x.currency}` : accName(x.accountId);
  const tree = allocationTree(scopeHoldings(), leafLabel);
  const total = tree.reduce((s, n) => s + n.value, 0);
  const named = tree.map((c, i) => ({
    name: hierLabel[0](c.name), value: c.value, itemStyle: { color: t.series[i % t.series.length] },
    children: c.children!.map(r => ({ name: hierLabel[1](r.name), value: r.value, children: r.children })),
  }));
  return {
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p: { name: string; value: number }) => `${esc(p.name)}: ${money0(p.value, '€')} (${total ? pct(p.value / total) : '—'})` },
    legend: { show: false },
    series: [{
      type: 'sunburst', data: named, radius: ['14%', '95%'], sort: undefined, nodeClick: 'rootToNode',
      itemStyle: { borderColor: t.bg, borderWidth: 2 },
      label: { color: t.text, fontSize: 11, minAngle: 14, overflow: 'truncate', rotate: 'radial' },
      levels: [
        {},
        { r0: '14%', r: '44%', label: { rotate: 'tangential', fontWeight: 600, minAngle: 24, width: 90, overflow: 'truncate', color: t.bg } },
        { r0: '44%', r: '60%', itemStyle: { opacity: 0.8 }, label: { show: false } },
        { r0: '60%', r: '95%', itemStyle: { opacity: 0.6 }, label: { rotate: 'radial', width: 72, overflow: 'truncate' } },
      ],
    }],
    graphic: total ? undefined : [{ type: 'text', left: 'center', top: 'middle', style: { text: 'Nicio poziție', fill: t.muted, fontSize: 14 } }],
  };
}

function driftOption(t: ChartTheme): EChartsCoreOption {
  const d = computeDrift(scopeHoldings(), data.targets, DEFAULT_BAND);
  const rows = [...d.rows].reverse();
  const cats = rows.map(r => r.target.label);
  const lo = rows.map(r => Math.max(0, r.target.weight - (r.target.band ?? DEFAULT_BAND)) * 100);
  const width = rows.map((r, i) => Math.min(100, (r.target.weight + (r.target.band ?? DEFAULT_BAND)) * 100) - lo[i]);
  return {
    legend: { top: 0, textStyle: { color: t.muted }, data: ['Actual', 'Țintă', 'Bandă'] },
    tooltip: {
      ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const r = rows[ps[0]?.dataIndex ?? 0];
        if (!r) return '';
        return `${esc(r.target.label)}<br/>Actual: ${pct(r.actualWeight)}<br/>Țintă: ${pct(r.target.weight)} ± ${NF1.format((r.target.band ?? DEFAULT_BAND) * 100)} pp`;
      },
    },
    grid: { left: 8, right: 24, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitNumber: 4, max: (v: { max: number }) => Math.min(100, Math.ceil((v.max + 5) / 10) * 10), ...axisStyle(t), axisLabel: { color: t.muted, formatter: '{value}%' } },
    yAxis: { type: 'category', data: cats, ...axisStyle(t), splitLine: { show: false } },
    series: [
      {
        name: 'Actual', type: 'bar', barWidth: 16, z: 2,
        data: rows.map(r => ({ value: +(r.actualWeight * 100).toFixed(2), itemStyle: { color: r.status === 'ok' ? t.series[0] : t.warn, borderRadius: 3 } })),
      },
      { name: 'bandLo', type: 'bar', stack: 'band', data: lo, barWidth: 16, barGap: '-100%', itemStyle: { color: 'transparent' }, silent: true, z: 3 },
      { name: 'Bandă', type: 'bar', stack: 'band', data: width, barWidth: 16, itemStyle: { color: t.series[1], opacity: 0.28, borderColor: t.series[1], borderWidth: 1, borderType: 'dashed' }, silent: true, z: 3 },
      { name: 'Țintă', type: 'scatter', data: rows.map(r => +(r.target.weight * 100).toFixed(2)), symbol: 'diamond', symbolSize: 12, itemStyle: { color: t.text }, z: 4 },
    ],
    graphic: rows.length ? undefined : [{ type: 'text', left: 'center', top: 'middle', style: { text: 'Nicio țintă definită', fill: t.muted, fontSize: 14 } }],
  };
}

function ladderOption(t: ChartTheme): EChartsCoreOption {
  const rows = bondLadder(data, ledger, fx, asOf);
  const years = [...new Set(rows.map(r => r.maturity.slice(0, 4)))].sort();
  const allYears: string[] = [];
  if (years.length) for (let y = +years[0]; y <= +years[years.length - 1]; y++) allYears.push(String(y));
  const byInst = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byInst.get(r.instrumentId) ?? allYears.map(() => 0);
    arr[allYears.indexOf(r.maturity.slice(0, 4))] += r.faceRon ?? 0;
    byInst.set(r.instrumentId, arr);
  }
  return {
    tooltip: { ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: unknown) => money0(Number(v), 'lei') },
    xAxis: { type: 'category', data: allYears, ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${NF0.format(v / 1000)}k` } },
    series: [...byInst].map(([id, arr]) => ({ name: instById(id)?.name ?? id, type: 'bar', stack: 'face', data: arr, barMaxWidth: 42, emphasis: { focus: 'series' } })),
    graphic: rows.length ? undefined : [{ type: 'text', left: 'center', top: 'middle', style: { text: 'Niciun titlu de stat cu scadență', fill: t.muted, fontSize: 14 } }],
  };
}

function pensionOption(t: ChartTheme): EChartsCoreOption {
  const accs = data.accounts.filter(a => a.type === 'pillar2' || a.type === 'pillar3');
  const series = accs.map(a => ({
    name: a.name, type: 'line', showSymbol: true, symbolSize: 6,
    data: (data.pensionValues ?? []).filter(v => v.accountId === a.id).sort((x, y) => x.date.localeCompare(y.date)).map(v => [v.date, v.value]),
  })).filter(s => s.data.length);
  return {
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: (v: unknown) => money0(Number(v)) },
    xAxis: { type: 'time', ...axisStyle(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${NF0.format(v / 1000)}k` } },
    series,
    graphic: series.length ? undefined : [{ type: 'text', left: 'center', top: 'middle', style: { text: 'Nicio valoare introdusă', fill: t.muted, fontSize: 14 } }],
  };
}

const CHART_BUILDERS: Record<string, [string, (t: ChartTheme) => EChartsCoreOption][]> = {
  alocare: [['sunburstChart', sunburstOption], ['driftChart', driftOption]],
  titluri: [['ladderChart', ladderOption]],
  pensii: [['pensionChart', pensionOption]],
};

function ensureCharts(tab: string) {
  for (const [id, build] of CHART_BUILDERS[tab] ?? []) {
    if (charts.has(id)) { charts.get(id)!.update(); continue; }
    charts.set(id, mountChart($(`#${id}`), build));
  }
}
function updateCharts() { for (const c of charts.values()) c.update(); }

// ─── Bonds table ───

function renderLadder() {
  const rows = bondLadder(data, ledger, fx, asOf);
  const total = rows.reduce((s, r) => s + (r.faceRon ?? 0), 0);
  table($('#ladderTable'), ['Scadență', 'Instrument', 'Cont', ['Cantitate', 'num'], ['Nominal', 'num'], ['Cupon / an', 'num'], ['În lei', 'num'], 'Status'],
    rows.map(r => h('tr', {},
      td(fmtDate(r.maturity)), td(instName(r.instrumentId)), td(accName(r.accountId)), num(qty(r.quantity)),
      num(money(r.face, r.currency)), num(r.yearlyCoupon !== null ? money(r.yearlyCoupon, r.currency) : '—'), num(money0(r.faceRon, 'lei')),
      td(r.matured ? h('span', { class: 'pf-tag pf-tag--warn', title: 'Înregistrează răscumpărarea ca vânzare la valoarea nominală' }, 'scadent') : h('span', { class: 'pf-tag' }, 'activ')),
    )),
    'Niciun titlu de stat cu dată de scadență.',
    rows.length ? h('tr', {}, h('td', { colspan: '6' }, 'Total'), num(money0(total, 'lei')), td('')) : undefined);
}

// ─── Gains & income per year ───

function renderGains() {
  const sel = $<HTMLSelectElement>('#yearSel');
  const years = new Set<number>([Number(asOf.slice(0, 4))]);
  for (const t of data.transactions) years.add(Number(t.date.slice(0, 4)));
  const prev = sel.value;
  sel.replaceChildren(...[...years].sort((a, b) => b - a).map(y => h('option', { value: String(y) }, String(y))));
  sel.value = prev && years.has(Number(prev)) ? prev : asOf.slice(0, 4);
  const year = Number(sel.value);
  // Gains of past years need the full history, not only up to the valuation date
  const full = computeLedger(data, fx);
  const y = yearTotals(full, year);
  const stat = (label: string, v: string, cls = '') => h('div', {}, h('dt', {}, label), h('dd', { class: cls }, v));
  $('#yearStats').replaceChildren(
    stat('Câștiguri (RON)', money0(y.gainRon, 'lei'), signClass(y.gainRon)),
    stat('Pierderi (RON)', money0(y.lossRon, 'lei'), signClass(y.lossRon)),
    stat('Rezultat net (RON)', money0(y.netGainRon, 'lei'), signClass(y.netGainRon)),
    stat('Dividende brute / impozit (RON)', `${money0(y.divRon)} / ${money0(y.divTaxRon)}`),
    stat('Dobânzi brute / impozit (RON)', `${money0(y.intRon)} / ${money0(y.intTaxRon)}`),
    stat('Comisioane separate (RON)', money0(y.feesRon, 'lei')),
  );
  if (y.missing) $('#yearStats').append(stat('Fără curs', `${y.missing} rânduri`, 'pf-neg'));

  const inYear = (d: string) => d.startsWith(`${year}-`);
  table($('#realizedTable'), ['Data', 'Instrument', 'Cont', ['Cantitate', 'num'], ['Încasare', 'num'], ['Cost mediu', 'num'], ['Câștig', 'num'], ['Câștig (RON)', 'num']],
    full.realized.filter(r => inYear(r.date)).map(r => h('tr', {},
      td(fmtDate(r.date)), td(instName(r.instrumentId)), td(accName(r.accountId)), num(qty(r.quantity)),
      num(money(r.proceeds, r.currency)), num(money(r.cost, r.currency)), num(money(r.gain, r.currency), signClass(r.gain)), num(money(r.gainRon, 'lei'), signClass(r.gainRon)),
    )), 'Nicio vânzare în acest an.');
  table($('#incomeTable'), ['Data', 'Tip', 'Instrument / cont', ['Brut', 'num'], ['Impozit reținut', 'num'], ['Net', 'num'], ['Brut (RON)', 'num'], ['Impozit (RON)', 'num']],
    full.income.filter(r => inYear(r.date)).map(r => h('tr', {},
      td(fmtDate(r.date)), td(TX_TYPE_LABEL[r.type]), td(r.instrumentId ? instName(r.instrumentId) : accName(r.accountId)),
      num(money(r.gross, r.currency)), num(money(r.withheld, r.currency)), num(money(r.net, r.currency)), num(money(r.grossRon, 'lei')), num(money(r.withheldRon, 'lei')),
    )), 'Niciun dividend sau dobândă în acest an.');
}

// ─── Render all ───

function renderAll() {
  recompute();
  fillSelects();
  renderSummary();
  renderPositions();
  renderTransactions();
  renderAccounts();
  renderInstruments();
  renderFx();
  renderPensions();
  renderTargets();
  renderDrift();
  renderRebalance();
  renderLadder();
  renderGains();
  updateCharts();
}

// ─── Tabs ───

function showTab(key: string, focus = false) {
  const tabs = $$<HTMLButtonElement>('[role="tab"][data-tab]');
  if (!tabs.some(t => t.dataset.tab === key)) key = tabs[0].dataset.tab!;
  for (const t of tabs) {
    const on = t.dataset.tab === key;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    $(`#panel-${t.dataset.tab}`).hidden = !on;
    if (on && focus) t.focus();
  }
  if (location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
  ensureCharts(key);
}

function initTabs() {
  const tabs = $$<HTMLButtonElement>('[role="tab"][data-tab]');
  for (const t of tabs) {
    t.addEventListener('click', () => showTab(t.dataset.tab!));
    t.addEventListener('keydown', e => {
      const i = tabs.indexOf(t);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (next) { e.preventDefault(); showTab(next.dataset.tab!, true); }
    });
  }
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
}

// ─── Wiring ───

function wire() {
  const asOfEl = $<HTMLInputElement>('#asOf');
  asOfEl.value = asOf;
  asOfEl.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(asOfEl.value)) { asOf = asOfEl.value; renderAll(); } });

  const txForm = $<HTMLFormElement>('#txForm');
  (txForm.elements.namedItem('date') as HTMLInputElement).value = todayIso();
  txForm.addEventListener('submit', submitTx);
  txForm.addEventListener('reset', () => setTimeout(() => { (txForm.elements.namedItem('date') as HTMLInputElement).value ||= todayIso(); updateTxFields(); }));
  (txForm.elements.namedItem('type') as HTMLSelectElement).addEventListener('change', updateTxFields);
  // Default the currency to the instrument's (or the account's) when picked
  (txForm.elements.namedItem('instrumentId') as HTMLSelectElement).addEventListener('change', e => {
    const i = instById((e.target as HTMLSelectElement).value);
    if (i) (txForm.elements.namedItem('currency') as HTMLSelectElement).value = i.currency;
  });
  (txForm.elements.namedItem('accountId') as HTMLSelectElement).addEventListener('change', e => {
    const a = data.accounts.find(x => x.id === (e.target as HTMLSelectElement).value);
    const instSel = txForm.elements.namedItem('instrumentId') as HTMLSelectElement;
    if (a && !instSel.value) (txForm.elements.namedItem('currency') as HTMLSelectElement).value = a.currency;
  });
  updateTxFields();

  $('#accountForm').addEventListener('submit', e => submitAccount(e as SubmitEvent));
  $('#instrumentForm').addEventListener('submit', e => submitInstrument(e as SubmitEvent));
  $('#fxForm').addEventListener('submit', e => submitFx(e as SubmitEvent));
  $('#priceForm').addEventListener('submit', e => submitPrice(e as SubmitEvent));
  $('#pensionForm').addEventListener('submit', e => submitPension(e as SubmitEvent));
  $('#targetForm').addEventListener('submit', e => submitTarget(e as SubmitEvent));
  $('#rebForm').addEventListener('submit', e => { e.preventDefault(); renderRebalance(); });
  for (const id of ['#fxForm', '#priceForm', '#pensionForm']) ($(id).querySelector('input[name="date"]') as HTMLInputElement).value = todayIso();
  for (const f of $$<HTMLFormElement>('form.pf-form')) f.addEventListener('reset', () => { for (const x of $$('[aria-invalid="true"]', f)) x.setAttribute('aria-invalid', 'false'); });

  $('#txFilter').addEventListener('change', renderTransactions);
  $('#yearSel').addEventListener('change', renderGains);
  $('#csvBtn').addEventListener('click', downloadCsv);
  for (const id of ['#incPension', '#incCash']) $(id).addEventListener('change', () => { renderDrift(); renderRebalance(); updateCharts(); });
}

async function init() {
  wire();
  initTabs();
  recompute();
  showTab(location.hash.slice(1));
  try {
    loaded = await loadDoc('data');
    data = loaded.doc;
    renderAll();
    await refreshMarket(true);
  } catch (e) {
    $('#loadState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
  }
}

init();
