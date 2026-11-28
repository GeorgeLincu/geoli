// /vault/invest/imobiliare/ — state and editor: opportunities in data.json `realEstate`, live recalculation while
// typing, save with the ETag, legal parameters, and the link to Avere netă ("Am cumpărat").
// Rendering lives in realestate-view.ts; maths in src/lib/invest/{mortgage,property,prepay}.ts.
import { loadDoc, saveDoc, loadMarketOnce, loadDocOnce, type Loaded } from './api';
import { toast } from './common';
import { el, byId, NF0, NF1 } from './report-ui';
import { compute, renderResults, renderPrepay, renderCharts, renderTable, renderCompare, type ViewCtx } from './realestate-view';
import { manualFx, chainFx, convert } from '../../lib/invest/fx';
import { bnrFx } from '../../lib/invest/market-sources';
import { inputsFromSettings, portfolioStats, DEFAULTS } from '../../lib/invest/projection';
import { rulesFor, pv } from '../../lib/invest/tax-ro';
import { scheduleCsv, addMonths, monthsBetween, balanceAt, rateFor } from '../../lib/invest/mortgage';
import { RESEARCHED_RE_PARAMS, RE_PARAM_KEYS, RE_PARAM_LABEL } from '../../lib/invest/realestate-defaults';
import { unconfirmedReParams } from '../../lib/invest/property';
import type { Currency, CostItem, InvestData, MortgageLoan, Prepayment, PropertyScenario, RealEstateDoc, NetWorthDoc } from '../../lib/invest/types';

let loaded: Loaded<'data'>;
let doc: RealEstateDoc;
let selected = '';
let dirty = false;
let ctx: ViewCtx;
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const thisMonth = today.slice(0, 7);
const form = byId<HTMLFormElement>('reForm')!;
const F = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(n: string) => form.elements.namedItem(n) as T;
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "5,5" → 5.5; empty → undefined */
const num = (s: string): number | undefined => {
  const t = s.replace(/\s/g, '').replace(/−/g, '-').replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};
const pctIn = (s: string) => { const n = num(s); return n === undefined ? undefined : Math.round(n * 1e6) / 1e8; };
const show = (n: number | undefined, scale = 1) => (n === undefined ? '' : String(Math.round(n * scale * 1e6) / 1e6).replace('.', ','));
const current = () => doc.scenarios.find(s => s.id === selected) ?? null;

function newScenario(): PropertyScenario {
  return {
    id: uid('re'), name: `Oportunitatea ${doc.scenarios.length + 1}`, use: 'home', priceEur: 0, purchaseDate: today, downPct: 0,
    costs: [], prepayments: [], status: 'draft',
  };
}
const defaultLoan = () => ({ months: 360, type: 'annuity' as const, startMonth: addMonths(thisMonth, 1), fixedRate: 0, fixedMonths: 0 });

// ─── Form <-> scenario ───

function fill(s: PropertyScenario) {
  F('name').value = s.name;
  F<HTMLSelectElement>('use').value = s.use;
  F('purchaseDate').value = s.purchaseDate;
  F('priceEur').value = show(s.priceEur || undefined);
  F('downPct').value = show(s.downPct || undefined, 100);
  F('eurRon').value = show(s.eurRon);
  F('hasLoan').checked = !!s.loan;
  const L = s.loan;
  F('principalRon').value = show(L?.principalRon);
  F('years').value = L ? show(L.months / 12) : '';
  F<HTMLSelectElement>('type').value = L?.type ?? 'annuity';
  F('startMonth').value = L?.startMonth ?? '';
  F('fixedRate').value = show(L?.fixedRate || undefined, 100);
  F('fixedYears').value = L ? show(L.fixedMonths / 12) : '';
  F('ircc').value = show(L?.ircc, 100);
  F('margin').value = show(L?.margin, 100);
  F('irccScenarios').value = (L?.irccScenarios ?? []).map(x => `${x > 0 ? '+' : ''}${show(x, 100)}`).join('; ');
  F('upfrontFeesRon').value = show(L?.upfrontFeesRon);
  F('monthlyFeeRon').value = show(L?.monthlyFeeRon);
  F('lifeInsuranceRate').value = show(L?.lifeInsuranceRate, 100);
  F('propertyInsuranceRon').value = show(L?.propertyInsuranceRon);
  F('monthlyIncomeRon').value = show(s.monthlyIncomeRon);
  F('otherDebtRon').value = show(s.otherDebtRon);
  const R = s.rent ?? {};
  F('rentEur').value = show(R.monthlyEur);
  F('occupancy').value = show(R.occupancy, 100);
  F('managementPct').value = show(R.managementPct, 100);
  F('maintenancePct').value = show(R.maintenancePct, 100);
  F('otherYearlyEur').value = show(R.otherYearlyEur);
  F('growth').value = show(R.growth, 100);
  F('appreciation').value = show(s.appreciation, 100);
  F('holdYears').value = show(s.holdYears);
  F('sellCostPct').value = show(s.sellCostPct, 100);
  F<HTMLTextAreaElement>('note').value = s.note ?? '';
  renderCosts(s.costs);
  applyUse(s.use);
  byId('reLoanFields')!.hidden = !s.loan;
}

function renderCosts(costs: CostItem[]) {
  byId('reCosts')!.replaceChildren(...costs.map(c => {
    const r = el('div', null, 're-cost');
    r.dataset.id = c.id;
    const label = el('input'); label.type = 'text'; label.value = c.label; label.maxLength = 160; label.dataset.f = 'label'; label.setAttribute('aria-label', 'Cost');
    const amount = el('input'); amount.type = 'text'; amount.inputMode = 'decimal'; amount.value = show(c.amount); amount.dataset.f = 'amount'; amount.setAttribute('aria-label', 'Suma');
    const cur = el('select'); cur.dataset.f = 'currency'; cur.setAttribute('aria-label', 'Moneda');
    for (const x of ['EUR', 'RON', 'USD']) { const o = el('option', x); o.value = x; cur.append(o); }
    cur.value = c.currency;
    const rm = el('button', '×', 'inv-btn'); rm.type = 'button'; rm.setAttribute('aria-label', `Șterge costul ${c.label}`);
    rm.addEventListener('click', () => { r.remove(); onEdit(); });
    r.append(label, amount, cur, rm);
    return r;
  }));
}

function readCosts(): CostItem[] {
  return [...byId('reCosts')!.querySelectorAll<HTMLElement>('.re-cost')].map(r => {
    const g = (f: string) => r.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-f="${f}"]`)!.value;
    return { id: r.dataset.id!, label: g('label').trim() || 'Cost', amount: Math.max(0, num(g('amount')) ?? 0), currency: g('currency') as Currency };
  });
}

function read(prev: PropertyScenario): PropertyScenario {
  const s: PropertyScenario = {
    ...prev,
    name: F('name').value.trim() || prev.name,
    use: F<HTMLSelectElement>('use').value as PropertyScenario['use'],
    purchaseDate: F('purchaseDate').value || prev.purchaseDate,
    priceEur: Math.max(0, num(F('priceEur').value) ?? 0),
    downPct: Math.min(1, Math.max(0, pctIn(F('downPct').value) ?? 0)),
    costs: readCosts(),
  };
  const opt = <K extends keyof PropertyScenario>(k: K, v: PropertyScenario[K] | undefined) => { if (v === undefined) delete s[k]; else s[k] = v; };
  opt('eurRon', num(F('eurRon').value));
  opt('monthlyIncomeRon', num(F('monthlyIncomeRon').value));
  opt('otherDebtRon', num(F('otherDebtRon').value));
  opt('appreciation', pctIn(F('appreciation').value));
  const hy = num(F('holdYears').value);
  opt('holdYears', hy === undefined ? undefined : Math.min(60, Math.max(1, Math.round(hy))));
  opt('sellCostPct', pctIn(F('sellCostPct').value));
  opt('note', F<HTMLTextAreaElement>('note').value.trim() || undefined);
  const rent = {
    monthlyEur: num(F('rentEur').value), occupancy: pctIn(F('occupancy').value), managementPct: pctIn(F('managementPct').value),
    maintenancePct: pctIn(F('maintenancePct').value), otherYearlyEur: num(F('otherYearlyEur').value), growth: pctIn(F('growth').value),
  };
  const r = Object.fromEntries(Object.entries(rent).filter(([, v]) => v !== undefined));
  opt('rent', Object.keys(r).length ? r : undefined);
  if (F('hasLoan').checked) {
    const L: MortgageLoan = { ...(prev.loan ?? defaultLoan()) };
    const set = <K extends keyof typeof L>(k: K, v: (typeof L)[K] | undefined) => { if (v === undefined) delete L[k]; else L[k] = v; };
    set('principalRon', num(F('principalRon').value));
    const years = num(F('years').value);
    L.months = years && years > 0 ? Math.min(600, Math.round(years * 12)) : L.months;
    L.type = F<HTMLSelectElement>('type').value as typeof L.type;
    L.startMonth = F('startMonth').value || L.startMonth;
    L.fixedRate = pctIn(F('fixedRate').value) ?? 0;
    L.fixedMonths = Math.min(L.months, Math.max(0, Math.round((num(F('fixedYears').value) ?? 0) * 12)));
    set('ircc', pctIn(F('ircc').value));
    set('margin', pctIn(F('margin').value));
    const sc = F('irccScenarios').value.split(/[;\s]+/).map(x => pctIn(x)).filter((x): x is number => x !== undefined && x !== 0 && Math.abs(x) <= 0.2).slice(0, 6);
    set('irccScenarios', sc.length ? sc : undefined);
    set('upfrontFeesRon', num(F('upfrontFeesRon').value));
    set('monthlyFeeRon', num(F('monthlyFeeRon').value));
    set('lifeInsuranceRate', pctIn(F('lifeInsuranceRate').value));
    set('propertyInsuranceRon', num(F('propertyInsuranceRon').value));
    s.loan = L;
  } else delete s.loan;
  return s;
}

function applyUse(use: PropertyScenario['use']) {
  for (const n of document.querySelectorAll<HTMLElement>('[data-home][data-rental]')) n.textContent = n.dataset[use] ?? n.textContent;
  for (const n of document.querySelectorAll<HTMLElement>('.re-rental-only')) n.hidden = use !== 'rental';
  byId('reRentNote')!.textContent = use === 'rental'
    ? 'Chiria încasată și costurile tale. Impozitul pe chirie vine din regulile de mai jos.'
    : 'Ca să compari cu statul în chirie: chiria pe care ai plăti-o pentru o locuință asemănătoare și costurile proprietarului.';
}

// ─── Render ───

let timer: ReturnType<typeof setTimeout> | undefined;
function onEdit() {
  const s = current();
  if (!s) return;
  const next = read(s);
  doc.scenarios = doc.scenarios.map(x => (x.id === s.id ? next : x));
  byId('reLoanFields')!.hidden = !next.loan;
  applyUse(next.use);
  setDirty(true);
  clearTimeout(timer);
  timer = setTimeout(renderAll, 150);
}

function setDirty(v: boolean) {
  dirty = v;
  byId('reDirty')!.hidden = !v;
  byId('reSaveState')!.textContent = v ? 'Nesalvat' : '';
}

function renderTabs() {
  byId('reTabs')!.replaceChildren(...doc.scenarios.map(s => {
    const b = el('button', `${s.name}${s.status === 'bought' ? ' ✓' : ''}`, 'plan-seg__btn re-tab');
    b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(s.id === selected));
    b.addEventListener('click', () => { selected = s.id; fill(s); renderAll(); });
    return b;
  }));
  const empty = !doc.scenarios.length;
  form.hidden = empty;
  for (const id of ['reDup', 'reDel']) (byId(id) as HTMLButtonElement).disabled = empty;
}

function renderAll() {
  renderTabs();
  const s = current();
  for (const sec of document.querySelectorAll<HTMLElement>('#reBody > .inv-card, #reBody > .rp-grid-2')) {
    if (sec.querySelector('#reListTitle') || sec.querySelector('#reCmpTitle') || sec.id === 'reParamsCard') continue;
    sec.hidden = !s;
  }
  if (s) {
    const c = compute(s, ctx);
    renderResults(s, c, ctx);
    renderPrepay(s, c, ctx, id => { s.prepayments = s.prepayments.filter(p => p.id !== id); setDirty(true); renderAll(); });
    renderCharts(s, c, ctx);
    renderTable(s, c, ctx);
    renderNetWorth(s);
  }
  renderCompare(ctx, (id, on) => {
    const set = new Set(doc.compare ?? []);
    if (on) set.add(id); else set.delete(id);
    doc.compare = [...set].slice(0, 3);
    setDirty(true);
    renderAll();
  });
  renderParams();
}

// ─── Prepayments form ───

function addPrepayment() {
  const s = current();
  if (!s?.loan) return;
  const box = byId('rePreForm')!;
  const g = (n: string) => box.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`)!.value;
  const amount = num(g('pAmount'));
  const month = g('pMonth') || s.loan.startMonth;
  if (!(amount && amount > 0)) { toast('Scrie suma plății anticipate (lei).', 'err'); return; }
  const kind = g('pKind') as Prepayment['kind'];
  const p: Prepayment = { id: uid('pp'), kind, amountRon: amount, month, effect: g('pEffect') as Prepayment['effect'] };
  if (kind === 'recurring') {
    p.count = Math.max(1, Math.round(num(g('pCount')) ?? 12));
    p.everyMonths = Math.max(1, Math.round(num(g('pEvery')) ?? 1));
  }
  s.prepayments = [...s.prepayments, p];
  setDirty(true);
  renderAll();
}

function syncRecurringFields() {
  const box = byId('rePreForm')!;
  const rec = box.querySelector<HTMLSelectElement>('[name="pKind"]')!.value === 'recurring';
  for (const n of box.querySelectorAll<HTMLElement>('.re-rec')) n.hidden = !rec;
}

// ─── Save ───

async function save(message = 'Salvat.') {
  try {
    const data: InvestData = { ...loaded.doc, realEstate: doc };
    loaded = await saveDoc('data', loaded, data);
    setDirty(false);
    toast(message);
    return true;
  } catch (e) { toast((e as Error).message, 'err'); return false; }
}

// ─── Legal parameters ───

function renderParams() {
  const body = byId<HTMLTableElement>('reParams')!.tBodies[0];
  body.replaceChildren(...RE_PARAM_KEYS.map(k => {
    const p = doc.params?.[k];
    const isAge = k === 'age.maxAtMaturity';
    const tr = el('tr');
    const th = el('th', RE_PARAM_LABEL[k]); th.scope = 'row';
    const v = el('input'); v.type = 'text'; v.inputMode = 'decimal'; v.dataset.k = k; v.dataset.f = 'value';
    v.value = p ? show(p.value, isAge ? 1 : 100) : ''; v.setAttribute('aria-label', `${RE_PARAM_LABEL[k]}${isAge ? ' (ani)' : ' (%)'}`);
    const src = el('td');
    if (p?.source) { const a = el('a', 'sursa'); a.href = p.source; a.rel = 'noopener noreferrer'; a.target = '_blank'; src.append(a, ' '); }
    if (p?.verifiedOn) src.append(el('small', `verificat ${p.verifiedOn.split('-').reverse().join('.')}. `));
    if (p?.note) src.append(el('small', p.note));
    if (isAge && !p) src.append(el('small', 'Nu e o regulă BNR: o stabilește banca. Scrie limita băncii tale (ani).'));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!p?.confirmed; cb.dataset.k = k; cb.dataset.f = 'confirmed';
    cb.setAttribute('aria-label', `Confirm ${RE_PARAM_LABEL[k]}`);
    const vt = el('td', null, 'num'); vt.append(v);
    const ct = el('td'); ct.append(cb);
    tr.append(th, vt, src, ct);
    return tr;
  }));
  const unc = unconfirmedReParams(doc).length, total = Object.keys(doc.params ?? {}).length;
  byId('reParamsSummary')!.textContent = !total ? '— neîncărcate' : unc ? `— ${unc} neconfirmate` : '— confirmate';
}

function readParams() {
  const params = { ...(doc.params ?? {}) };
  for (const inp of byId('reParams')!.querySelectorAll<HTMLInputElement>('input[data-f="value"]')) {
    const k = inp.dataset.k!;
    const n = num(inp.value);
    const conf = byId('reParams')!.querySelector<HTMLInputElement>(`input[data-f="confirmed"][data-k="${k}"]`)!.checked;
    if (n === undefined) { delete params[k]; continue; }
    params[k] = { ...(params[k] ?? {}), value: k === 'age.maxAtMaturity' ? n : n / 100, confirmed: conf };
  }
  doc.params = params;
}

// ─── Avere netă link ───

/** Prepayments George marked as done, as one-off entries (for the real loan balance). */
function donePrepayments(s: PropertyScenario): Prepayment[] {
  return s.prepayments.flatMap(p => (p.done ?? []).map(m => ({ id: `${p.id}:${m}`, kind: 'once' as const, amountRon: p.amountRon, month: m, effect: p.effect })));
}

function expandMonths(p: Prepayment): string[] {
  const n = p.kind === 'recurring' ? Math.max(1, p.count ?? 1) : 1;
  const step = p.kind === 'recurring' ? Math.max(1, p.everyMonths ?? 1) : 1;
  return Array.from({ length: n }, (_, k) => addMonths(p.month, k * step));
}

function liabilityFor(s: PropertyScenario) {
  const c = compute({ ...s, prepayments: donePrepayments(s) }, ctx);
  if (!c?.loan) return null;
  const rows = c.loan.withPrepay.rows;
  const balances = [{ date: s.purchaseDate, value: Math.round(c.p.loanRon * 100) / 100 }];
  for (const r of rows) if (r.month <= thisMonth) balances.push({ date: `${r.month}-01`, value: Math.round(r.balance * 100) / 100 });
  const n = Math.max(1, Math.min(rows.length, monthsBetween(s.loan!.startMonth, thisMonth) + 1));
  const now = rows[n - 1];
  return {
    id: s.netWorthLiabilityId ?? `re-${s.id}-loan`, name: `Credit · ${s.name}`, kind: 'mortgage' as const, currency: 'RON' as const,
    rate: now ? now.rate : rateFor(s.loan!, 1).rate, monthlyPayment: Math.round((now?.payment ?? rows[0]?.payment ?? 0) * 100) / 100,
    notes: 'Creat din Imobiliare; soldurile se actualizează de acolo.', balances,
    current: balanceAt(rows, c.p.loanRon, thisMonth),
  };
}

function renderNetWorth(s: PropertyScenario) {
  const st = byId('reNwState')!;
  const bought = s.status === 'bought';
  (byId('reBought') as HTMLButtonElement).hidden = bought;
  byId('reSync')!.hidden = !bought || !s.loan;
  byId('reDoneAll')!.hidden = !bought || !s.prepayments.length;
  if (!bought) {
    st.textContent = 'Când cumperi, apasă „Am cumpărat”: în Avere netă apar locuința (la preț) și creditul (sold lunar din graficul de rambursare). Le poți ajusta apoi acolo.';
    return;
  }
  const L = liabilityFor(s);
  st.textContent = `Cumpărat. În Avere netă: locuința${s.loan ? ` și creditul (sold acum ≈ ${L ? NF0.format(Math.round(L.current)) : '—'} lei, cu plățile anticipate marcate ca făcute)` : ''}.`;
}

function upsertNetWorth(s: PropertyScenario): NetWorthDoc {
  const nw: NetWorthDoc = structuredClone(loaded.doc.netWorth ?? { assets: [], liabilities: [] });
  const assetId = s.netWorthAssetId ?? `re-${s.id}`;
  if (!nw.assets.some(a => a.id === assetId)) {
    nw.assets.push({ id: assetId, name: s.name, category: 'real_estate', currency: 'EUR', values: [{ date: s.purchaseDate, value: s.priceEur }], notes: 'Creat din Imobiliare (prețul de cumpărare). Adaugă valori noi când se schimbă.' });
  }
  s.netWorthAssetId = assetId;
  const L = s.loan ? liabilityFor(s) : null;
  if (L) {
    const { current: _c, ...li } = L;
    void _c;
    const i = nw.liabilities.findIndex(x => x.id === li.id);
    if (i >= 0) nw.liabilities[i] = { ...nw.liabilities[i], rate: li.rate, monthlyPayment: li.monthlyPayment, balances: li.balances };
    else nw.liabilities.push(li);
    s.netWorthLiabilityId = li.id;
  }
  return nw;
}

async function markBought() {
  const s = current();
  if (!s || !compute(s, ctx)) { toast('Completează prețul și cursul înainte.', 'err'); return; }
  if (!confirm(`Marchezi „${s.name}” ca achiziționat? Se adaugă locuința${s.loan ? ' și creditul' : ''} în Avere netă.`)) return;
  s.status = 'bought';
  const netWorth = upsertNetWorth(s);
  loaded = { ...loaded, doc: { ...loaded.doc, netWorth } };
  if (await save('Adăugat în Avere netă.')) renderAll();
}

async function syncBalance() {
  const s = current();
  if (!s) return;
  const netWorth = upsertNetWorth(s);
  loaded = { ...loaded, doc: { ...loaded.doc, netWorth } };
  if (await save('Soldul creditului a fost actualizat în Avere netă.')) renderAll();
}

function markDoneUntilToday() {
  const s = current();
  if (!s) return;
  s.prepayments = s.prepayments.map(p => ({ ...p, done: expandMonths(p).filter(m => m <= thisMonth) }));
  setDirty(true);
  renderAll();
  toast('Plățile de până azi sunt marcate ca făcute. Apasă „Actualizează soldul creditului”, apoi „Salvează”.');
}

// ─── Plan market inputs (prepay vs invest, buy vs rent) ───

function planMarket(data: InvestData, rules: Parameters<typeof rulesFor>[0]): ViewCtx['market'] {
  const year = +today.slice(0, 4);
  const notes: string[] = [];
  const res = inputsFromSettings(data.settings, data.targets, year, null);
  let real: number | null = null, vol = 0;
  if (res.inputs) { real = res.inputs.realReturn; vol = res.inputs.volatility; }
  else if (Object.keys(res.weights).length) {
    const st = portfolioStats(res.weights, data.settings.projection?.assumptions, data.settings.projection?.correlation ?? DEFAULTS.correlation);
    real = st.ret; vol = st.vol;
  }
  const infl = data.settings.inflation ?? DEFAULTS.inflation;
  if (data.settings.inflation === undefined) notes.push(`Inflația: valoarea implicită din Plan (${NF1.format(infl * 100)}%).`);
  const yearly = real === null ? null : (1 + real) * (1 + infl) - 1;
  let gainTax = 0;
  const r = rulesFor(rules, year);
  if (r) {
    gainTax = pv(r.set, 'cg.foreign.rate');
    if (!r.exact) notes.push(`Impozitul pe câștig: parametrii din ${r.set.year}.`);
  } else notes.push('Fără parametri fiscali (pagina Taxe): câștigul din investiții e socotit fără impozit.');
  notes.push('Creditul e în lei, portofoliul în euro: comparația nu include variația cursului.');
  return { yearlyReturn: yearly, vol, gainTax, notes };
}

// ─── Init ───

async function main() {
  const state = byId('reState')!;
  try {
    loaded = await loadDoc('data');
    if (!loaded.exists) { state.textContent = 'Creează întâi fișierul de date din Panou.'; return; }
    const year = +today.slice(0, 4);
    const [market, rulesDoc] = await Promise.all([loadMarketOnce([year - 1, year]), loadDocOnce('tax-rules').catch(() => null)]);
    const fx = chainFx(bnrFx(market.fx), manualFx(loaded.doc.fxRates ?? []));
    const eur = fx.rate('EUR', today);
    doc = structuredClone(loaded.doc.realEstate ?? { scenarios: [] });
    ctx = {
      doc, eurRonBnr: eur?.ron ?? null, today, birthYear: loaded.doc.settings.birthYear,
      toEur: (a, c) => convert(fx, a, c, 'EUR', today),
      market: planMarket(loaded.doc, rulesDoc?.exists ? rulesDoc.doc : null),
    };
    byId('reFxHint')!.textContent = eur ? `gol = BNR ${String(eur.ron).replace('.', ',')} (${eur.date.split('-').reverse().join('.')})` : 'gol = cursul BNR (indisponibil acum)';
    selected = doc.scenarios[0]?.id ?? '';
    if (current()) fill(current()!);
    state.hidden = true;
    byId('reBody')!.hidden = false;
    renderAll();

    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    form.addEventListener('submit', e => { e.preventDefault(); void save(); });
    byId('reCostAdd')!.addEventListener('click', () => {
      const s = current(); if (!s) return;
      renderCosts([...readCosts(), { id: uid('c'), label: '', amount: 0, currency: 'RON' }]);
      onEdit();
    });
    byId('reAdd')!.addEventListener('click', () => {
      const s = newScenario();
      doc.scenarios = [...doc.scenarios, s];
      selected = s.id; fill(s); setDirty(true); renderAll();
    });
    byId('reDup')!.addEventListener('click', () => {
      const s = current(); if (!s) return;
      const c: PropertyScenario = { ...structuredClone(s), id: uid('re'), name: `${s.name} (copie)`, status: 'draft' };
      delete c.netWorthAssetId; delete c.netWorthLiabilityId;
      c.prepayments = c.prepayments.map(p => ({ ...p, id: uid('pp'), done: undefined }));
      doc.scenarios = [...doc.scenarios, c];
      selected = c.id; fill(c); setDirty(true); renderAll();
    });
    byId('reDel')!.addEventListener('click', () => {
      const s = current(); if (!s) return;
      if (!confirm(`Ștergi „${s.name}”?${s.status === 'bought' ? ' Locuința și creditul rămân în Avere netă.' : ''}`)) return;
      doc.scenarios = doc.scenarios.filter(x => x.id !== s.id);
      doc.compare = (doc.compare ?? []).filter(x => x !== s.id);
      selected = doc.scenarios[0]?.id ?? '';
      if (current()) fill(current()!);
      setDirty(true); renderAll();
    });
    byId('rePreAdd')!.addEventListener('click', addPrepayment);
    byId('rePreForm')!.querySelector('[name="pKind"]')!.addEventListener('change', syncRecurringFields);
    syncRecurringFields();
    byId('reCsv')!.addEventListener('click', () => {
      const s = current(); const c = s ? compute(s, ctx) : null;
      if (!c?.rows.length) { toast('Nu există grafic de rambursare.', 'err'); return; }
      const url = URL.createObjectURL(new Blob([scheduleCsv(c.rows)], { type: 'text/csv;charset=utf-8' }));
      const a = el('a'); a.href = url; a.download = `rambursare-${s!.name.replace(/[^\w-]+/g, '_')}.csv`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    byId('reLoadParams')!.addEventListener('click', () => {
      const params = { ...(doc.params ?? {}) };
      for (const [k, v] of Object.entries(RESEARCHED_RE_PARAMS)) if (!params[k]?.confirmed) params[k] = { ...v! };
      doc.params = params; setDirty(true); renderAll();
      toast('Valorile cercetate au fost încărcate. Citește sursele, bifează „Confirmat” și salvează.');
    });
    byId('reSaveParams')!.addEventListener('click', async () => { readParams(); if (await save('Regulile au fost salvate.')) renderAll(); });
    byId('reBought')!.addEventListener('click', () => void markBought());
    byId('reSync')!.addEventListener('click', () => void syncBalance());
    byId('reDoneAll')!.addEventListener('click', markDoneUntilToday);
    window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
  } catch (e) {
    state.textContent = (e as Error).message;
  }
}

void main();
