// /vault/invest/taxe/ — Romanian tax per income year, printable Declarația Unică sheet, planned-sale estimate,
// and the per-year tax parameter editor (invest/tax-rules.json).
import { loadDoc, saveDoc, loadMarket, type Loaded } from './api';
import { mountChart, axisStyle } from './charts';
import { toast } from './common';
import { validateDoc } from '../../lib/invest/validate';
import { emptyData, emptyTaxRules, type InvestData, type TaxRules, type TaxRuleSet, type TaxParam, type AccountType, type Currency } from '../../lib/invest/types';
import { computeLedger, type Ledger } from '../../lib/invest/ledger';
import { manualFx, chainFx, type FxSource } from '../../lib/invest/fx';
import { bnrFx, marketYears } from '../../lib/invest/market-sources';
import type { FxYear } from '../../lib/invest/market';
import {
  TAX_PARAMS, PARAM_BY_KEY, PARAM_GROUP_LABEL, FX_AVG, rulesFor, pv, flag, duDeadline, copyRuleSet, unconfirmedParams,
  missingParams, annualAverages, ledgerFx, buildTaxYear, computeTaxYears, estimateSales, cassFor,
  type TaxYearResult, type ParamDef, type ParamGroup,
} from '../../lib/invest/tax-ro';
import { proposedRuleSet, RESEARCHED_YEARS } from '../../lib/invest/tax-ro-defaults';

// ─── Helpers ───

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
const NF2 = nf(2, 2), NF0 = nf(0, 0), NF4 = nf(4, 4), NFQ = nf(0, 6), NF1 = nf(0, 2);
const lei = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF2.format(n)} lei`);
const lei0 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF0.format(n)} lei`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${NF1.format(n * 100)}%`);
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function parseNum(s: string): number | undefined {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return undefined;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}

function table(el: HTMLElement, head: (string | [string, 'num'])[], rows: HTMLElement[], empty: string, foot?: HTMLElement) {
  el.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map(c => (Array.isArray(c) ? h('th', { class: 'num', scope: 'col' }, c[0]) : h('th', { scope: 'col' }, c))))),
    h('tbody', {}, ...(rows.length ? rows : [h('tr', { class: 'pf-empty' }, h('td', { colspan: String(head.length) }, empty))])),
  );
  if (foot) el.append(h('tfoot', {}, foot));
}
const td = (v: Child, cls?: string) => h('td', { class: cls }, v);
const num = (v: Child, extra = '') => h('td', { class: `num ${extra}`.trim() }, v);
const tag = (text: string, kind: 'ok' | 'warn' | 'err') => h('span', { class: `pf-tag pf-tag--${kind}` }, text);

// ─── State ───

let data: InvestData = emptyData();
let rulesLoaded: Loaded<'tax-rules'> | null = null;
let rules: TaxRules = emptyTaxRules();
let fxDocs: FxYear[] = [];
let fx: FxSource = manualFx([]);
let results = new Map<number, TaxYearResult>();
let year = new Date().getFullYear() - 1;
let rulesYear = year;
/** Working copy of the rule set being edited */
let draft: TaxRuleSet | null = null;
let dirty = false;

const accName = (id?: string) => data.accounts.find(a => a.id === id)?.name ?? '—';
const instName = (id?: string) => { const i = data.instruments.find(x => x.id === id); return i ? (i.ticker ? `${i.ticker} · ${i.name}` : i.name) : '—'; };

/** Years that matter: with a transaction, with rules, the previous and the current one. */
function candidateYears(): number[] {
  const now = new Date().getFullYear();
  const ys = new Set<number>([now, now - 1]);
  for (const t of data.transactions) ys.add(Number(t.date.slice(0, 4)));
  for (const r of rules.years) ys.add(r.year);
  return [...ys].filter(y => y > 1990 && y < 2200).sort((a, b) => b - a);
}

function recompute() {
  fx = chainFx(bnrFx(fxDocs), manualFx(data.fxRates ?? []));
  // The ledger depends on whether the previous day's rate is used; compute at most both variants
  const ledgers = new Map<boolean, Ledger>();
  const ledgerFor = (set: TaxRuleSet) => {
    const k = flag(set, 'fx.prevDay');
    if (!ledgers.has(k)) ledgers.set(k, computeLedger(data, ledgerFx(set, fx)));
    return ledgers.get(k)!;
  };
  const txYears = data.transactions.map(t => Number(t.date.slice(0, 4)));
  const first = txYears.length ? Math.min(...txYears) : year;
  const last = Math.max(year, ...txYears);
  const span: number[] = [];
  for (let y = first; y <= last; y++) span.push(y);
  results = computeTaxYears(span, y => {
    const r = rulesFor(rules, y);
    if (!r) return null;
    return {
      ...buildTaxYear({
        year: y, set: r.set, ledger: ledgerFor(r.set), accounts: data.accounts, instruments: data.instruments,
        transactions: data.transactions, fx, averages: annualAverages(fxDocs, y, r.set),
      }),
      exactRules: r.exact,
    };
  });
}

// ─── Summary ───

function renderSummary() {
  const r = results.get(year);
  const status = $('#rulesStatus');
  const set = rulesFor(rules, year);
  const sum = (k: string, v: string) => { $(`[data-sum="${k}"]`).textContent = v; };
  status.hidden = false;
  status.replaceChildren();
  if (!set) {
    status.className = 'tx-status tx-status--err';
    status.append('Nu există parametri fiscali. Deschide tab-ul „Parametri fiscali” și încarcă valorile cercetate (le verifici și le confirmi tu).');
    for (const k of ['total', 'payable', 'withheld', 'rate', 'cass', 'deadline']) sum(k, '—');
    return;
  }
  const unconf = unconfirmedParams(set.set);
  const missing = missingParams(set.set);
  const msgs: string[] = [];
  if (!set.exact) msgs.push(`Pentru ${year} nu ai parametri proprii; se folosesc cei din ${set.set.year}.`);
  if (missing.length) msgs.push(`Lipsesc parametri: ${missing.map(k => PARAM_BY_KEY.get(k)?.label ?? k).join('; ')}.`);
  if (unconf.length) msgs.push(`${unconf.length} parametri neconfirmați — rezultatul e provizoriu.`);
  status.className = `tx-status ${msgs.length ? 'tx-status--warn' : 'tx-status--ok'}`;
  status.append(msgs.length ? msgs.join(' ') : `Parametrii pentru ${year} sunt confirmați.`);

  const res = r?.result;
  sum('total', res ? lei0(res.totalTax) : '—');
  sum('payable', res ? lei0(res.payable) : '—');
  sum('withheld', res ? lei0(res.withheld) : '—');
  sum('rate', res ? pct(res.effectiveRate) : '—');
  sum('cass', res ? (res.cass.tier ? `${lei0(res.cass.due)} (prag ${res.cass.tier})` : '0 lei') : '—');
  sum('deadline', fmtDate(duDeadline(set.set, year)));

  const warn = $('#warnings');
  const items = [...(r?.warnings ?? [])];
  if (r?.missing.length) items.unshift(`${r.missing.length} tranzacții nu au curs BNR și nu sunt incluse (vezi Portofoliu → Cursuri & prețuri).`);
  warn.replaceChildren(...items.map(w => h('li', {}, w)));
  warn.hidden = !items.length;
}

// ─── Calculation tab ───

function renderBreakdown() {
  const r = results.get(year);
  const el = $('#breakdownTable');
  if (!r) { table(el, ['Categorie', ['Sumă', 'num']], [], 'Nimic de calculat pentru anul ales.'); return; }
  const g = r.result.gains, d = r.result.dividends, i = r.result.interest, c = r.result.cass;
  const row = (label: string, base: number | null, tax: number | null, how: string, cls = '') =>
    h('tr', { class: cls }, td(label), num(lei(base)), num(lei(tax)), td(how, 'pf-note'));
  const s = r.set;
  table(el, ['Categorie', ['Venit / bază', 'num'], ['Impozit', 'num'], 'Cum'], [
    row('Câștig net — broker străin', g.foreignNet, null, 'câștiguri minus pierderi din vânzări, în lei'),
    row('− pierderi reportate folosite', -g.lossUsed, null, `disponibil ${lei(g.lossAvailable)}`),
    row('Câștig impozabil — broker străin', g.taxable, g.tax, `${pct(pv(s, 'cg.foreign.rate'))}, de plată prin declarație`, 'tx-strong'),
    row('Câștig net — broker RO', g.roNet, g.roWithheld, `reținut de broker (${pct(pv(s, 'cg.ro.rateLong'))} / ${pct(pv(s, 'cg.ro.rateShort'))}), final`),
    row('Dividende din România', d.roGross, d.roWithheld, 'reținut la sursă, final'),
    row('Dividende din străinătate', d.foreignGross, d.foreignDue, `${pct(pv(s, 'div.rate'))}; credit fiscal ${lei(d.credit)}; de plată ${lei(d.toPay)}`),
    row('Dobânzi din România', i.roGross, i.roWithheld, 'reținut la sursă, final'),
    row('Dobânzi din străinătate', i.foreignGross, i.foreignDue, `${pct(pv(s, 'int.rate'))}; credit fiscal ${lei(i.credit)}; de plată ${lei(i.toPay)}`),
    row('Dobânzi neimpozabile (titluri de stat)', i.exempt, 0, flag(s, 'int.govExempt') ? 'scutite' : '—'),
    row('CASS', c.base, c.due, c.tier ? `${pct(pv(s, 'cass.rate'))} × ${NF0.format(c.multiples[c.tier - 1])} salarii minime` : 'sub primul prag', 'tx-strong'),
  ], '', h('tr', {}, td('Total'), num(lei(r.result.grossIncome)), num(lei(r.result.totalTax)), td(`de plată prin declarație: ${lei(r.result.payable)}`, 'pf-note')));
}

function renderCassText() {
  const r = results.get(year);
  const el = $('#cassText');
  if (!r) { el.textContent = ''; return; }
  const c = r.result.cass;
  const next = c.thresholds[c.tier];
  el.textContent = `Baza CASS ${lei0(c.base)} (salariu minim ${lei0(c.minWage)}; praguri ${c.thresholds.map(lei0).join(' / ')}). `
    + (next !== undefined ? `Până la pragul următor mai sunt ${lei0(next - c.base)}.` : 'Ești la plafonul maxim.');
}

function renderLosses() {
  const r = results.get(year);
  const rows: HTMLElement[] = [];
  for (const b of r?.carryIn ?? []) rows.push(h('tr', {}, td(String(b.year)), num(lei(b.amount)), td(String(b.expiresAfter)), td('intră în anul ales')));
  if (r?.result.gains.lossCreated) rows.push(h('tr', {}, td(String(year)), num(lei(r.result.gains.lossCreated)), td(String(r.result.gains.carryOut.at(-1)?.expiresAfter ?? '')), td('pierdere nouă, se reportează')));
  table($('#lossTable'), ['Anul pierderii', ['Rămas', 'num'], 'Se poate folosi până în', ''], rows, 'Nicio pierdere de reportat.');
}

function renderSales() {
  const r = results.get(year);
  const rows = (r?.sales ?? []).map(s => h('tr', {},
    td(fmtDate(s.date)), td(accName(s.accountId)), td(instName(s.instrumentId)), num(NFQ.format(s.quantity)),
    num(lei(s.proceedsRon)), num(lei(s.costRon)), num(lei(s.gainRon), s.gainRon === null ? '' : s.gainRon >= 0 ? 'pf-pos' : 'pf-neg'),
    td(s.category === 'ro'
      ? h('span', {}, `${NFQ.format(s.longQty ?? 0)} ≥ prag, ${NFQ.format(s.shortQty ?? 0)} sub prag; reținut ${lei(s.withheldRon)} `, s.withholdingEstimated ? tag('estimat', 'warn') : '')
      : 'broker străin', 'pf-note'),
  ));
  table($('#salesTable'), ['Data', 'Cont', 'Instrument', ['Cant.', 'num'], ['Încasat', 'num'], ['Cost mediu', 'num'], ['Câștig', 'num'], 'Detalii'],
    rows, 'Nicio vânzare în anul ales.');
}

function renderIncome() {
  const r = results.get(year);
  const rows = (r?.income ?? []).map(x => h('tr', {},
    td(fmtDate(x.date)), td(x.type === 'dividend' ? 'Dividend' : 'Dobândă'), td(instName(x.instrumentId)),
    td(x.exempt ? tag('scutit', 'ok') : x.source === 'ro' ? 'România' : 'străinătate'),
    num(`${NF2.format(x.gross)} ${x.currency}`), num(`${NF2.format(x.withheld)} ${x.currency}`),
    num(lei(x.grossRon)), num(lei(x.withheldRon)),
  ));
  table($('#incomeTable'), ['Data', 'Tip', 'Instrument', 'Sursă', ['Brut', 'num'], ['Reținut', 'num'], ['Brut (lei)', 'num'], ['Reținut (lei)', 'num']],
    rows, 'Niciun dividend sau dobândă în anul ales.');
}

// CASS step chart: CASS due as a function of the investment-income base, with the current base marked
let cassChart: ReturnType<typeof mountChart> | null = null;
function cassOption(t: Parameters<Parameters<typeof mountChart>[1]>[0]) {
  const r = results.get(year);
  if (!r || !r.result.cass.thresholds.length) return { title: { text: 'Fără praguri CASS', left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 13, fontWeight: 400 } } };
  const c = r.result.cass;
  const maxX = Math.max(c.base * 1.15, c.thresholds.at(-1)! * 1.25);
  const pts: [number, number][] = [[0, 0]];
  for (const th of c.thresholds) pts.push([th, cassFor(r.set, th).due]);
  pts.push([maxX, cassFor(r.set, maxX).due]);
  return {
    grid: { left: 8, right: 24, top: 24, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => lei0(v) },
    xAxis: { type: 'value', max: Math.round(maxX), name: 'venit din investiții (lei)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: t.muted }, ...axisStyle(t),
      axisLabel: { color: t.muted, formatter: (v: number) => `${NF0.format(v / 1000)}k` } },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => NF0.format(v) } },
    series: [{
      name: 'CASS', type: 'line', step: 'end', data: pts, symbol: 'none', lineStyle: { width: 2, color: t.series[0] },
      areaStyle: { color: t.series[0], opacity: 0.12 },
      markLine: { symbol: 'none', label: { color: t.text, formatter: `anul ${year}: ${esc(lei0(c.base))}` }, lineStyle: { color: t.series[3], type: 'dashed' }, data: [{ xAxis: c.base }] },
    }],
  };
}

// ─── Declarația Unică sheet ───

function renderSheet() {
  const box = $('#sheet');
  const r = results.get(year);
  const set = rulesFor(rules, year);
  if (!r || !set) { box.replaceChildren(h('p', { class: 'inv-muted' }, 'Nimic de afișat: lipsesc parametrii fiscali sau tranzacțiile pentru anul ales.')); return; }
  const res = r.result, s = r.set;
  const unconf = unconfirmedParams(s);
  const line = (label: string, value: string, note = '') => h('tr', {}, td(label), num(value), td(note, 'pf-note'));
  const section = (title: string, rows: HTMLElement[]) => h('section', { class: 'tx-sheet__sec' }, h('h3', { class: 'pf-h3' }, title),
    h('div', { class: 'pf-scroll' }, h('table', { class: 'pf-table' }, h('tbody', {}, ...rows))));

  // Rates used
  const rateRows: HTMLElement[] = [];
  const averages = annualAverages(fxDocs, year, s);
  const curUsed = new Set<Currency>();
  r.sales.forEach(x => x.currency !== 'RON' && curUsed.add(x.currency));
  r.income.forEach(x => x.currency !== 'RON' && curUsed.add(x.currency));
  for (const cur of curUsed) {
    const a = averages.get(cur);
    rateRows.push(line(`${cur} — curs mediu anual ${year}`, a ? NF4.format(a.rate) : '—', a ? (a.source === 'manual' ? 'introdus de tine' : `media a ${a.days} cursuri zilnice BNR`) : 'lipsă'));
  }
  const txFx = ledgerFx(s, fx);
  const perTx = (date: string, cur: Currency, what: string) => {
    if (cur === 'RON') return null;
    const q = txFx.rate(cur, date);
    return line(`${fmtDate(date)} · ${what}`, q ? `${NF4.format(q.ron)} lei/${cur}` : '—', q ? `curs BNR din ${fmtDate(q.date)}` : 'lipsă');
  };
  const txRows: HTMLElement[] = [];
  if (pv(s, 'fx.gains') !== FX_AVG) for (const x of r.sales) { const l = perTx(x.date, x.currency, `vânzare ${instName(x.instrumentId)}`); if (l) txRows.push(l); }
  if (pv(s, 'fx.income') !== FX_AVG) for (const x of r.income) { const l = perTx(x.date, x.currency, `${x.type === 'dividend' ? 'dividend' : 'dobândă'} ${instName(x.instrumentId)}`); if (l) txRows.push(l); }

  box.replaceChildren(
    h('header', { class: 'tx-sheet__head' },
      h('h2', { class: 'inv-h2' }, `Fișă Declarația Unică — venituri din ${year}`),
      h('p', { class: 'inv-muted' }, `Termen de depunere: ${fmtDate(duDeadline(s, year))}. Generată la ${fmtDate(todayIso())} din registrul de tranzacții. Sume în lei.`),
      h('p', { class: 'tx-disclaimer' }, h('strong', {}, 'Ajutor de calcul, nu consultanță fiscală. '),
        'Verifică fiecare sumă cu extrasele brokerilor și instrucțiunile ANAF ale formularului înainte de depunere.',
        unconf.length ? ` Atenție: ${unconf.length} parametri nu sunt confirmați.` : '',
        r.exactRules ? '' : ` Parametrii folosiți sunt cei din ${s.year}.`),
    ),
    section('Câștiguri din transferul titlurilor de valoare — broker străin (de declarat)', [
      line('Câștig brut (suma vânzărilor cu câștig)', lei(r.sales.filter(x => x.category === 'foreign' && (x.gainRon ?? 0) > 0).reduce((a, x) => a + (x.gainRon ?? 0), 0))),
      line('Pierdere brută (suma vânzărilor cu pierdere)', lei(r.sales.filter(x => x.category === 'foreign' && (x.gainRon ?? 0) < 0).reduce((a, x) => a + (x.gainRon ?? 0), 0))),
      line('Câștig / pierdere netă anuală', lei(res.gains.foreignNet)),
      line('Pierderi din anii anteriori compensate', lei(res.gains.lossUsed)),
      line('Venit net impozabil', lei(res.gains.taxable)),
      line('Impozit datorat', lei(res.gains.tax), pct(pv(s, 'cg.foreign.rate'))),
      line('Pierdere de reportat în anii următori', lei(res.gains.carryOut.reduce((a, b) => a + b.amount, 0))),
    ]),
    section('Dividende și dobânzi din străinătate (de declarat)', [
      line('Dividende brute', lei(res.dividends.foreignGross)),
      line('Impozit datorat în România pe dividende', lei(res.dividends.foreignDue), pct(pv(s, 'div.rate'))),
      line('Credit fiscal (impozit plătit în străinătate, plafonat)', lei(res.dividends.credit)),
      line('Impozit de plată pe dividende', lei(res.dividends.toPay)),
      line('Dobânzi brute', lei(res.interest.foreignGross)),
      line('Impozit datorat în România pe dobânzi', lei(res.interest.foreignDue), pct(pv(s, 'int.rate'))),
      line('Credit fiscal pe dobânzi', lei(res.interest.credit)),
      line('Impozit de plată pe dobânzi', lei(res.interest.toPay)),
    ]),
    section('Venituri cu impozit reținut la sursă (doar pentru CASS)', [
      line('Câștig net prin broker RO', lei(res.gains.roNet), `impozit reținut ${lei(res.gains.roWithheld)}`),
      line('Dividende din România', lei(res.dividends.roGross), `impozit reținut ${lei(res.dividends.roWithheld)}`),
      line('Dobânzi din România', lei(res.interest.roGross), `impozit reținut ${lei(res.interest.roWithheld)}`),
      line('Dobânzi neimpozabile (titluri de stat)', lei(res.interest.exempt), flag(s, 'cass.countExemptInterest') ? 'intră în baza CASS' : 'nu intră în baza CASS'),
    ]),
    section('CASS', [
      line('Total venituri din investiții luate în calcul', lei(res.cass.base)),
      line('Salariul minim brut folosit', lei0(res.cass.minWage)),
      line('Praguri', res.cass.thresholds.map(lei0).join(' / ')),
      line('Baza de calcul', res.cass.tier ? lei0(res.cass.thresholds[res.cass.tier - 1]) : '0 lei', res.cass.tier ? `${NF0.format(res.cass.multiples[res.cass.tier - 1])} salarii minime` : 'sub primul prag'),
      line('CASS datorat', lei(res.cass.due), pct(pv(s, 'cass.rate'))),
    ]),
    section('Total', [
      line('Impozit + CASS de plată prin Declarația Unică', lei(res.payable)),
      line('Reținut la sursă sau creditat', lei(res.withheld)),
      line('Total impozit și CASS pe veniturile din investiții', lei(res.totalTax), `rata efectivă ${pct(res.effectiveRate)}`),
    ]),
    section('Cursuri BNR folosite', [
      line('Câștiguri convertite cu', pv(s, 'fx.gains') === FX_AVG ? 'cursul mediu anual' : 'cursul zilei tranzacției', flag(s, 'fx.prevDay') ? 'cursul publicat în ziua lucrătoare anterioară' : ''),
      line('Dividende/dobânzi convertite cu', pv(s, 'fx.income') === FX_AVG ? 'cursul mediu anual' : 'cursul zilei încasării'),
      ...rateRows, ...txRows,
    ]),
    section('Parametri folosiți', TAX_PARAMS.filter(d => d.used && s.params[d.key]).map(d => {
      const p = s.params[d.key];
      return line(d.label, fmtParam(d, p.value), [(p.confirmed ?? s.confirmed) ? 'confirmat' : 'NECONFIRMAT', p.verifiedOn ? `verificat ${fmtDate(p.verifiedOn)}` : ''].filter(Boolean).join(' · '));
    })),
  );
}

function fmtParam(d: ParamDef, v: number) {
  switch (d.kind) {
    case 'rate': return pct(v);
    case 'flag': return v ? 'da' : 'nu';
    case 'choice': return d.choices?.find(c => c[0] === v)?.[1] ?? String(v);
    case 'ron': return lei0(v);
    case 'eur': return `${NF0.format(v)} EUR`;
    default: return NF1.format(v);
  }
}

// ─── Planned-sale estimate ───

function runEstimate(e: Event) {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const gain = parseNum((f.elements.namedItem('gain') as HTMLInputElement).value);
  const days = parseNum((f.elements.namedItem('days') as HTMLInputElement).value);
  const accountType = (f.elements.namedItem('accountType') as HTMLSelectElement).value as AccountType;
  if (gain === undefined || Number.isNaN(gain)) { toast('Introdu câștigul estimat în lei.', 'err'); return; }
  const set = rulesFor(rules, year);
  if (!set) { toast('Lipsesc parametrii fiscali.', 'err'); return; }
  const r = results.get(year);
  const est = estimateSales(set.set, [{ accountType, gainRon: gain, holdingDays: Number.isNaN(days) ? undefined : days }],
    { year, base: r?.aggregates, carryIn: r?.carryIn });
  const out = $('#estOut');
  out.hidden = false;
  $('[data-est="tax"]').textContent = lei(est.incomeTax);
  $('[data-est="cass"]').textContent = lei(est.cassDelta);
  $('[data-est="total"]').textContent = lei(est.total);
  $('[data-est="share"]').textContent = gain > 0 ? pct(est.total / gain) : '—';
}

// ─── Rules editor ───

function rulesYears() {
  const ys = new Set<number>([...rules.years.map(r => r.year), ...RESEARCHED_YEARS, year]);
  return [...ys].sort((a, b) => b - a);
}

function loadDraft() {
  const existing = rules.years.find(r => r.year === rulesYear);
  draft = existing ? structuredClone(existing) : null;
  dirty = false;
  renderRules();
}

function renderRules() {
  const sel = $<HTMLSelectElement>('#rulesYear');
  sel.replaceChildren(...rulesYears().map(y => h('option', { value: String(y), selected: y === rulesYear }, `${y}${rules.years.some(r => r.year === y) ? '' : ' (fără parametri)'}`)));
  const body = $('#rulesBody');
  $<HTMLButtonElement>('#seedBtn').disabled = !proposedRuleSet(rulesYear);
  $<HTMLButtonElement>('#deleteYearBtn').disabled = !draft;
  $<HTMLButtonElement>('#confirmAllBtn').disabled = !draft;
  $<HTMLButtonElement>('#saveRulesBtn').disabled = !draft;
  if (!draft) {
    body.replaceChildren(h('p', { class: 'inv-muted' }, `Anul ${rulesYear} nu are parametri. Încarcă valorile cercetate sau adaugă anul copiind ultimul an existent.`));
    return;
  }
  const groups = new Map<ParamGroup, ParamDef[]>();
  for (const d of TAX_PARAMS) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  // Extra keys (e.g. fx.avg.EUR) that aren't in the catalogue
  const extra = Object.keys(draft.params).filter(k => !PARAM_BY_KEY.has(k));
  const blocks: HTMLElement[] = [];
  for (const [g, defs] of groups) {
    blocks.push(h('fieldset', { class: 'tx-group' }, h('legend', {}, PARAM_GROUP_LABEL[g]), ...defs.map(d => paramRow(d, draft!.params[d.key]))));
  }
  blocks.push(h('fieldset', { class: 'tx-group' }, h('legend', {}, 'Cursuri medii anuale BNR (opțional)'),
    h('p', { class: 'inv-muted' }, 'Lasă gol ca să se folosească media cursurilor zilnice BNR. Poți introduce valoarea oficială publicată de BNR.'),
    ...(['EUR', 'USD', 'GBP', 'CHF'] as const).map(cur => paramRow({ key: `fx.avg.${cur}`, group: 'fx', kind: 'number', used: true, label: `Curs mediu anual ${cur} (lei)` }, draft!.params[`fx.avg.${cur}`])),
    ...extra.filter(k => !/^fx\.avg\.(EUR|USD|GBP|CHF)$/.test(k)).map(k => paramRow({ key: k, group: 'other', kind: 'number', used: false, label: k }, draft!.params[k]))));
  body.replaceChildren(...blocks);
}

function paramRow(d: ParamDef, p: TaxParam | undefined) {
  const id = `p-${d.key.replace(/[^a-z0-9]/gi, '-')}`;
  const confirmed = p ? (p.confirmed ?? draft!.confirmed) : false;
  let input: HTMLElement;
  if (d.kind === 'flag' || d.kind === 'choice') {
    const opts: [number, string][] = d.kind === 'flag' ? [[1, 'da'], [0, 'nu']] : d.choices!;
    input = h('select', { id, class: 'pf-input', 'data-key': d.key, 'data-field': 'value' },
      h('option', { value: '', selected: !p }, '—'),
      ...opts.map(([v, l]) => h('option', { value: String(v), selected: p?.value === v }, l)));
  } else {
    const shown = p === undefined ? '' : d.kind === 'rate' ? NF1.format(p.value * 100) : String(p.value).replace('.', ',');
    input = h('input', { id, class: 'pf-input', inputmode: 'decimal', autocomplete: 'off', 'data-key': d.key, 'data-field': 'value', value: shown });
  }
  const unit = d.kind === 'rate' ? '%' : d.kind === 'ron' ? 'lei' : d.kind === 'eur' ? 'EUR' : '';
  return h('div', { class: `tx-param${p && !confirmed ? ' tx-param--unconfirmed' : ''}` },
    h('label', { for: id, class: 'tx-param__label' }, d.label, d.used ? '' : h('small', {}, ' (informativ)'), d.help ? h('small', { class: 'tx-param__help' }, d.help) : ''),
    h('div', { class: 'tx-param__value' }, input, unit ? h('span', { class: 'inv-muted' }, unit) : '',
      h('label', { class: 'pf-check' }, h('input', { type: 'checkbox', 'data-key': d.key, 'data-field': 'confirmed', checked: confirmed }), 'confirmat'),
      p && !confirmed ? tag('neconfirmat', 'warn') : ''),
    h('div', { class: 'tx-param__meta' },
      h('input', { class: 'pf-input', 'data-key': d.key, 'data-field': 'source', value: p?.source ?? '', placeholder: 'sursă (link oficial)', 'aria-label': `Sursa pentru ${d.label}` }),
      h('input', { class: 'pf-input', type: 'date', 'data-key': d.key, 'data-field': 'verifiedOn', value: p?.verifiedOn ?? '', 'aria-label': `Verificat la (${d.label})` }),
      h('input', { class: 'pf-input', 'data-key': d.key, 'data-field': 'note', value: p?.note ?? '', placeholder: 'notă (articol, lege)', 'aria-label': `Notă pentru ${d.label}` }),
      p?.source && /^https:\/\//.test(p.source) ? h('a', { href: p.source, target: '_blank', rel: 'noopener noreferrer' }, 'deschide sursa') : ''),
  );
}

/** Reads the form into a rule set. Returns null (and marks fields) when a value is invalid. */
function readForm(): TaxRuleSet | null {
  if (!draft) return null;
  const next: TaxRuleSet = { year: draft.year, confirmed: false, params: {} };
  let bad = false;
  const keys = new Set($$<HTMLElement>('[data-key]', $('#rulesBody')).map(e => e.dataset.key!));
  for (const key of keys) {
    const get = (field: string) => $(`#rulesBody [data-key="${CSS.escape(key)}"][data-field="${field}"]`) as HTMLInputElement | null;
    const valEl = get('value')!;
    const def = PARAM_BY_KEY.get(key);
    const raw = parseNum(valEl.value);
    valEl.removeAttribute('aria-invalid');
    if (raw === undefined) continue;
    if (Number.isNaN(raw)) { valEl.setAttribute('aria-invalid', 'true'); bad = true; continue; }
    const value = def?.kind === 'rate' ? Math.round(raw * 1e6) / 1e8 : raw;
    const p: TaxParam = { value, confirmed: !!get('confirmed')?.checked };
    const source = get('source')?.value.trim(); if (source) p.source = source;
    const verifiedOn = get('verifiedOn')?.value; if (verifiedOn) p.verifiedOn = verifiedOn;
    const note = get('note')?.value.trim(); if (note) p.note = note;
    next.params[key] = p;
  }
  if (bad) { toast('Unele valori nu sunt numere valide.', 'err'); return null; }
  next.confirmed = Object.keys(next.params).length > 0 && Object.values(next.params).every(p => p.confirmed);
  return next;
}

async function saveRules(set: TaxRuleSet | null, removeYear?: number): Promise<boolean> {
  if (!rulesLoaded) { toast('Parametrii nu s-au încărcat încă.', 'err'); return false; }
  const next: TaxRules = structuredClone(rules);
  if (removeYear !== undefined) next.years = next.years.filter(y => y.year !== removeYear);
  if (set) next.years = [...next.years.filter(y => y.year !== set.year), set].sort((a, b) => a.year - b.year);
  const problems = validateDoc('tax-rules', next);
  if (problems.length) { toast(`Date invalide: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    rulesLoaded = await saveDoc('tax-rules', rulesLoaded, next);
    rules = next;
    $('#rulesSaved').textContent = `Salvat ${new Date().toLocaleTimeString('ro-RO')}`;
    dirty = false;
    recompute();
    renderAll();
    loadDraft();
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

function wireRules() {
  $('#rulesYear').addEventListener('change', e => {
    if (dirty && !confirm('Ai modificări nesalvate. Le pierzi?')) { ($('#rulesYear') as HTMLSelectElement).value = String(rulesYear); return; }
    rulesYear = Number((e.target as HTMLSelectElement).value);
    loadDraft();
  });
  $('#rulesBody').addEventListener('input', () => { dirty = true; $('#rulesSaved').textContent = 'Modificări nesalvate'; });
  $('#rulesForm').addEventListener('submit', async e => {
    e.preventDefault();
    const set = readForm();
    if (set && await saveRules(set)) toast(`Parametrii pentru ${set.year} au fost salvați.`);
  });
  $('#seedBtn').addEventListener('click', async () => {
    const seed = proposedRuleSet(rulesYear);
    if (!seed) return;
    if (draft && !confirm(`Înlocuiești parametrii existenți pentru ${rulesYear} cu valorile cercetate?`)) return;
    if (await saveRules(seed)) toast(`Valorile cercetate pentru ${rulesYear} au fost încărcate. Verifică-le și confirmă-le.`);
  });
  $('#addYearBtn').addEventListener('click', async () => {
    const latest = [...rules.years].sort((a, b) => b.year - a.year)[0];
    if (!latest) { toast('Nu există niciun an de copiat. Încarcă întâi valorile cercetate.', 'err'); return; }
    const raw = prompt('Ce an adaugi?', String(latest.year + 1));
    const y = Number(raw);
    if (!raw || !Number.isInteger(y) || y < 1990 || y > 2200) return;
    if (rules.years.some(r => r.year === y)) { toast(`Anul ${y} există deja.`, 'err'); return; }
    rulesYear = y;
    if (await saveRules(copyRuleSet(latest, y))) toast(`Anul ${y} a fost creat din ${latest.year}. Verifică valorile.`);
  });
  $('#confirmAllBtn').addEventListener('click', () => {
    if (!confirm(`Confirmi că ai verificat TOATE valorile pentru ${rulesYear}?`)) return;
    for (const c of $$<HTMLInputElement>('#rulesBody input[data-field="confirmed"]')) c.checked = true;
    dirty = true;
    $('#rulesSaved').textContent = 'Modificări nesalvate — apasă „Salvează parametrii”';
  });
  $('#deleteYearBtn').addEventListener('click', async () => {
    if (!draft || !confirm(`Ștergi parametrii pentru ${rulesYear}? (Se păstrează o copie de rezervă la salvare.)`)) return;
    if (await saveRules(null, rulesYear)) toast(`Parametrii pentru ${rulesYear} au fost șterși.`);
  });
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
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
  if (key === 'calcul') {
    if (!cassChart) cassChart = mountChart($('#cassChart'), cassOption);
    else cassChart.update();
  }
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

function renderYearSelect() {
  const sel = $<HTMLSelectElement>('#year');
  sel.replaceChildren(...candidateYears().map(y => h('option', { value: String(y), selected: y === year }, String(y))));
}

function renderAll() {
  renderYearSelect();
  renderSummary();
  renderBreakdown();
  renderCassText();
  renderLosses();
  renderSales();
  renderIncome();
  renderSheet();
  cassChart?.update();
}

async function init() {
  initTabs();
  wireRules();
  $('#year').addEventListener('change', e => { year = Number((e.target as HTMLSelectElement).value); renderAll(); });
  $('#estForm').addEventListener('submit', runEstimate);
  $('#printBtn').addEventListener('click', () => { document.body.classList.add('tx-printing'); window.print(); });
  window.addEventListener('afterprint', () => document.body.classList.remove('tx-printing'));

  const state = $('#loadState');
  try {
    const [d, r] = await Promise.all([loadDoc('data'), loadDoc('tax-rules')]);
    data = d.doc;
    rulesLoaded = r;
    rules = r.doc;
    const m = await loadMarket(marketYears(data.transactions.map(t => t.date), todayIso())).catch(e => {
      toast(`Cursurile BNR nu s-au încărcat: ${(e as Error).message}`, 'err');
      return { fx: [] as FxYear[], prices: [] };
    });
    fxDocs = m.fx;
    // Default year: the last full year (the one to declare now)
    const ys = candidateYears();
    if (!ys.includes(year)) year = ys[0];
    rulesYear = year;
    state.textContent = data.transactions.length
      ? `${data.transactions.length} tranzacții în registru. Cursuri BNR încărcate pentru ${fxDocs.map(f => f.year).join(', ') || '—'}.`
      : 'Registrul de tranzacții e gol: adaugă tranzacții în Portofoliu ca să vezi calculul.';
    recompute();
    renderAll();
    loadDraft();
    showTab(location.hash.slice(1) || 'calcul');
  } catch (e) {
    state.textContent = `Eroare la încărcare: ${(e as Error).message}`;
  }
}

init();
