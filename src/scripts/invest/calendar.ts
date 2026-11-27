// /vault/invest/calendar/ — income calendar (coupons, maturities, dividends, planned cash-ins, received payments).
// Logic lives in src/lib/invest/calendar.ts; this file renders and edits data.json `calendar`.
import { saveDoc, type Loaded } from './api';
import { mountChart, axisStyle } from './charts';
import { toast } from './common';
import { loadCalendarContext, converterFor, type CalendarContext } from './calendar-data';
import {
  buildCalendar, monthTotals, yearTotals, upcoming, windowFor, monthRange, monthOf, addMonths,
  type CalItem, type MonthTotal, type Sums,
} from '../../lib/invest/calendar';
import { validateDoc } from '../../lib/invest/validate';
import type {
  Currency, DividendSchedule, IncomeCalendar, InvestData, PlannedIncome, BondSchedule, ReinvestMarker,
} from '../../lib/invest/types';

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
const td = (v: Child, cls?: string) => h('td', { class: cls }, v);
const num = (v: Child, extra = '') => h('td', { class: `num ${extra}`.trim() }, v);
function table(el: HTMLElement, head: (string | [string, 'num'])[], rows: HTMLElement[], empty: string) {
  el.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map(c => (Array.isArray(c) ? h('th', { class: 'num', scope: 'col' }, c[0]) : h('th', { scope: 'col' }, c))))),
    h('tbody', {}, ...(rows.length ? rows : [h('tr', { class: 'pf-empty' }, h('td', { colspan: String(head.length) }, empty))])),
  );
}

const NF2 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
const NFQ = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 6 });
const NF1 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
const money = (n: number | null | undefined, cur?: string) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${NF2.format(n)}${cur ? ` ${cur}` : ''}`);
const money0 = (n: number, cur: string) => `${NF0.format(n)} ${cur}`;
const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const MONTH_FMT = new Intl.DateTimeFormat('ro-RO', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = (m: string) => MONTH_FMT.format(new Date(`${m}-01T00:00:00Z`));
const MONTH_SHORT = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "1.234,5" / "1234.5" → number; empty → undefined; invalid → NaN */
function parseNum(s: FormDataEntryValue | null): number | undefined {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return undefined;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : NaN;
}
const text = (fd: FormData, k: string) => { const v = String(fd.get(k) ?? '').trim(); return v || undefined; };
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
function mark(form: HTMLFormElement, name: string, bad: boolean) {
  (form.elements.namedItem(name) as HTMLElement | null)?.setAttribute('aria-invalid', bad ? 'true' : 'false');
  return bad;
}

const KIND_LABEL: Record<CalItem['kind'], string> = {
  coupon: 'Cupon', maturity: 'Scadență', dividend: 'Dividend', interest: 'Dobândă', planned: 'Planificat',
};
const STATUS: Record<CalItem['status'], [string, string]> = {
  upcoming: ['așteptat', ''], received: ['încasat', 'ok'], pending: ['neîncasat?', 'warn'], past: ['trecut', ''], actual: ['încasat', 'ok'],
};

// ─── State ───

let ctx: CalendarContext | null = null;
let loaded: Loaded<'data'> | null = null;
let data: InvestData | null = null;
let items: CalItem[] = [];
let months: MonthTotal[] = [];
let chart: ReturnType<typeof mountChart> | null = null;
let mailOn: boolean | null = null;

const display = () => $<HTMLSelectElement>('#currency').value as Currency;
const useNet = () => $<HTMLSelectElement>('#amounts').value === 'net';
const pick = (s: Sums) => (useNet() ? s.net : s.gross);
const cal = (d: InvestData): IncomeCalendar => (d.calendar ??= {});
const instName = (id: string) => data?.instruments.find(i => i.id === id)?.name ?? '(instrument șters)';

async function commit(mutate: (d: InvestData) => void, okMessage: string): Promise<boolean> {
  if (!loaded || !data) { toast('Datele nu s-au încărcat încă.', 'err'); return false; }
  const next = structuredClone(data);
  mutate(next);
  // Drop empty lists so the document stays tidy
  if (next.calendar) {
    for (const k of Object.keys(next.calendar) as (keyof IncomeCalendar)[]) if (!next.calendar[k]?.length) delete next.calendar[k];
    if (!Object.keys(next.calendar).length) delete next.calendar;
  }
  const problems = validateDoc('data', next);
  if (problems.length) { toast(`Date invalide: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    loaded = await saveDoc('data', loaded, next);
    data = next;
    renderAll();
    toast(okMessage);
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

// ─── Calculation ───

function recompute() {
  if (!ctx || !data) return;
  const past = Number($<HTMLSelectElement>('#past').value);
  const ahead = Number($<HTMLSelectElement>('#ahead').value);
  // Always compute at least the last and next 12 months, for the summary
  const win = windowFor(ctx.today, Math.max(past, 12), Math.max(ahead, 12));
  items = buildCalendar({ data, rules: ctx.rules, today: ctx.today, from: win.from, to: win.to });
  const shown = windowFor(ctx.today, past, ahead);
  months = monthTotals(items, monthRange(shown.from, shown.to), converterFor(ctx.fx, display(), ctx.today));
}

function shownItems() {
  if (!ctx) return [];
  const w = windowFor(ctx.today, Number($<HTMLSelectElement>('#past').value), Number($<HTMLSelectElement>('#ahead').value));
  return items.filter(i => monthOf(i.date) >= w.from && monthOf(i.date) <= w.to);
}

// ─── Rendering ───

function renderSummary() {
  if (!ctx) return;
  const cur = display();
  const conv = converterFor(ctx.fx, cur, ctx.today);
  const today = ctx.today;
  const in12 = addMonths(today, 12), ago12 = addMonths(today, -12);
  const sum = (list: CalItem[]) => {
    let total = 0, missing = 0;
    for (const i of list) {
      const amount = useNet() ? (i.net ?? i.gross) : i.gross;
      const v = conv(amount, i.currency, i.date);
      if (v === null) missing++; else total += v;
    }
    return money0(total, cur) + (missing ? ` (+${missing} fără curs)` : '');
  };
  const income = (i: CalItem) => i.kind !== 'maturity';
  const set = (k: string, v: string) => { $(`[data-sum="${k}"]`).textContent = v; };
  set('next30', sum(upcoming(items, today, 30).filter(income)));
  set('next12', sum(items.filter(i => i.expected && income(i) && i.date >= today && i.date <= in12)));
  set('last12', sum(items.filter(i => !i.expected && i.date > ago12 && i.date <= today)));
  const mats = items.filter(i => i.kind === 'maturity' && i.date >= today && i.date <= in12);
  let principal = 0;
  for (const m of mats) principal += conv(m.gross, m.currency, m.date) ?? 0;
  set('principal', mats.length ? `${money0(principal, cur)} (${mats.length})` : '—');

  // Warnings
  const warn: string[] = [];
  const shown = shownItems();
  if (!ctx.rules) warn.push('Nu ai parametri fiscali salvați: impozitul pe dividende și dobânzi nu se poate estima. Încarcă-i în pagina Taxe.');
  else if (shown.some(i => (i.taxBasis === 'rate' || i.taxBasis === 'exempt') && !i.taxConfirmed)) {
    warn.push('Unele impozite folosesc parametri neconfirmați (sau ai unui an anterior). Confirmă-i în pagina Taxe.');
  }
  const assumed = [...new Set(shown.filter(i => i.assumedFrequency).map(i => i.label))];
  if (assumed.length) warn.push(`Frecvența cupoanelor e presupusă anuală pentru: ${assumed.join(', ')}. Verific-o în tab-ul „Cupoane titluri de stat”.`);
  const faceEst = [...new Set(shown.filter(i => i.faceEstimated).map(i => i.label))];
  if (faceEst.length) warn.push(`Fără valoare nominală (folosesc prețul mediu de cumpărare): ${faceEst.join(', ')}. Complet-o în Portofoliu → Instrumente.`);
  const missingFx = months.reduce((a, m) => a + m.missingFx, 0);
  if (missingFx) warn.push(`${missingFx} sume nu au curs BNR spre ${cur} și lipsesc din totaluri.`);
  const unknownTax = shown.filter(i => i.tax === null).length;
  if (unknownTax) warn.push(`${unknownTax} sume nu au impozit estimat: în totalurile nete apar la valoarea brută.`);
  const list = $('#warnings');
  list.replaceChildren(...warn.map(w => h('li', {}, w)));
  list.hidden = !warn.length;

  const noSchedules = !data?.calendar?.dividends?.length;
  $('#loadState').textContent = items.length
    ? `Actualizat azi, ${fmtDate(today)}.${noSchedules ? ' Nu ai încă un calendar de dividende (tab-ul „Dividende așteptate”).' : ''}`
    : 'Nimic de arătat încă: adaugă titluri de stat cu scadență și cupon, un calendar de dividende sau o încasare planificată.';
}

function renderChart() {
  if (chart) { chart.update(); return; }
  chart = mountChart($('#calChart'), t => {
    const cur = display();
    const kind = useNet() ? 'net' : 'brut';
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => money(Number(v), cur) },
      legend: { top: 0, textStyle: { color: t.muted }, selected: { 'Scadențe (principal)': false } },
      xAxis: { type: 'category', data: months.map(m => fmtMonth(m.month)), ...axisStyle(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => NF0.format(v) } },
      series: [
        { name: `Așteptat (${kind})`, type: 'bar', data: months.map(m => Math.round(pick(m.expected))), itemStyle: { color: t.series[0], borderRadius: [3, 3, 0, 0] } },
        { name: `Încasat (${kind})`, type: 'bar', data: months.map(m => Math.round(pick(m.received))), itemStyle: { color: t.series[1], borderRadius: [3, 3, 0, 0] } },
        { name: 'Scadențe (principal)', type: 'bar', data: months.map(m => Math.round(m.principal)), itemStyle: { color: t.series[3], borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });
}

function renderMonths() {
  const cur = display();
  const rows: HTMLElement[] = [];
  const years = yearTotals(months);
  const cells = (s: Sums) => [num(money(s.gross)), num(money(s.tax)), num(money(s.net))];
  for (const y of years) {
    for (const m of months.filter(x => x.month.startsWith(`${y.year}-`))) {
      if (!m.expected.count && !m.received.count && !m.principal) continue;
      rows.push(h('tr', {}, td(fmtMonth(m.month)), ...cells(m.expected), ...cells(m.received), num(m.principal ? money(m.principal) : '')));
    }
    rows.push(h('tr', { class: 'cal-year' }, td(`Total ${y.year}`), ...cells(y.expected), ...cells(y.received), num(y.principal ? money(y.principal) : '')));
  }
  const el = $('#monthTable');
  table(el, ['Luna', [`Așteptat brut (${cur})`, 'num'], ['Impozit est.', 'num'], ['Așteptat net', 'num'], ['Încasat brut', 'num'], ['Impozit', 'num'], ['Încasat net', 'num'], ['Scadențe', 'num']],
    rows, 'Nicio sumă în fereastra aleasă.');
}

function taxCell(i: CalItem) {
  if (i.taxBasis === 'principal') return num(h('span', { class: 'inv-muted' }, 'nu e venit'));
  if (i.tax === null) return num(h('span', { class: 'pf-tag pf-tag--warn', title: i.taxBasis === 'noRules' ? 'Fără parametri fiscali' : 'Fără regulă pentru acest venit' }, 'necunoscut'));
  const tag = i.taxBasis === 'exempt' ? 'scutit' : i.taxBasis === 'ownRate' ? 'cota ta' : i.taxRate !== undefined ? `${NF1.format(i.taxRate * 100)}%` : '';
  return num(h('span', {}, money(i.tax), ' ', tag ? h('span', { class: 'pf-tag' }, tag) : null,
    (i.taxBasis === 'rate' || i.taxBasis === 'exempt') && !i.taxConfirmed ? h('span', { class: 'pf-tag pf-tag--warn', title: 'Parametrul anului nu e confirmat în pagina Taxe' }, 'neconfirmat') : null));
}

function renderList() {
  const filter = $<HTMLSelectElement>('#listFilter').value;
  const list = shownItems().filter(i =>
    // "tot": an expected item already paid is shown once, as the payment
    filter === 'all' ? !(i.expected && i.status === 'received') : filter === 'expected' ? i.expected : filter === 'received' ? !i.expected : i.kind === 'maturity');
  const rows: HTMLElement[] = [];
  let month = '';
  for (const i of list) {
    const m = monthOf(i.date);
    if (m !== month) { month = m; rows.push(h('tr', { class: 'cal-month-row' }, h('th', { colspan: '8', scope: 'colgroup' }, fmtMonth(m)))); }
    const [statusText, statusKind] = STATUS[i.status];
    const what = h('span', {}, i.label);
    const hints: string[] = [];
    if (i.quantity !== undefined) hints.push(`${NFQ.format(i.quantity)} unități`);
    if (i.basis === 'lastYear') hints.push('ca anul trecut');
    if (i.assumedFrequency) hints.push('frecvență presupusă');
    if (i.note) hints.push(i.note);
    const action = i.kind === 'maturity'
      ? h('button', { type: 'button', class: `inv-btn cal-reinvest${i.reinvest ? ' is-on' : ''}`, 'data-inst': i.instrumentId, 'data-mat': i.date },
        i.reinvest ? `De reinvestit${i.reinvest.remind ? ` · e-mail cu ${i.reinvest.daysBefore} z` : ''}` : 'Marchează de reinvestit')
      : null;
    rows.push(h('tr', { class: i.expected ? 'cal-exp' : 'cal-got' },
      td(fmtDate(i.date)),
      td(h('span', { class: `cal-kind cal-kind--${i.kind}` }, KIND_LABEL[i.kind])),
      h('td', { class: 'cal-what' }, what, hints.length ? h('small', {}, hints.join(' · ')) : null),
      num(money(i.gross, i.currency)), taxCell(i), num(money(i.net, i.currency)),
      td(h('span', { class: `pf-tag${statusKind ? ` pf-tag--${statusKind}` : ''}` }, statusText)),
      td(action),
    ));
  }
  table($('#listTable'), ['Data', 'Tip', 'Ce', ['Brut', 'num'], ['Impozit est.', 'num'], ['Net', 'num'], 'Stare', ''], rows, 'Nimic în fereastra aleasă.');
}

// ─── Settings: dividend schedules ───

function fillInstrumentSelect() {
  const sel = $<HTMLFormElement>('#divForm').elements.namedItem('instrumentId') as HTMLSelectElement;
  const cur = sel.value;
  const list = [...(data?.instruments ?? [])].filter(i => !i.maturity).sort((a, b) => a.name.localeCompare(b.name, 'ro'));
  sel.replaceChildren(h('option', { value: '' }, '— alege —'), ...list.map(i => h('option', { value: i.id }, i.ticker ? `${i.name} (${i.ticker})` : i.name)));
  sel.value = cur;
}

function renderDividends() {
  const list = data?.calendar?.dividends ?? [];
  table($('#divTable'), ['Instrument', 'Cum', 'Luni', ['Pe unitate', 'num'], 'Notă', ''], list.map(s => h('tr', {},
    td(instName(s.instrumentId)),
    td(s.mode === 'lastYear' ? 'ca anul trecut' : 'lunile mele'),
    td(s.mode === 'manual' ? (s.months ?? []).map(m => MONTH_SHORT[m - 1]).join(', ') + (s.day ? ` (ziua ${s.day})` : '') : '—'),
    num(s.mode === 'manual' && s.perUnit !== undefined ? `${NFQ.format(s.perUnit)} ${s.currency ?? data?.instruments.find(i => i.id === s.instrumentId)?.currency ?? ''}` : '—'),
    h('td', { class: 'pf-note' }, s.note ?? ''),
    td(rowButtons(() => editDividend(s), () => void commit(d => { cal(d).dividends = (cal(d).dividends ?? []).filter(x => x.id !== s.id); }, 'Calendarul a fost șters.'), `calendarul pentru ${instName(s.instrumentId)}`)),
  )), 'Niciun calendar de dividende. Fără el nu apare niciun dividend așteptat.');
}

function rowButtons(onEdit: () => void, onDelete: () => void, what: string) {
  const e = h('button', { type: 'button', class: 'inv-btn', 'aria-label': `Editează ${what}` }, 'Editează');
  const d = h('button', { type: 'button', class: 'inv-btn', 'aria-label': `Șterge ${what}` }, 'Șterge');
  e.addEventListener('click', onEdit);
  d.addEventListener('click', () => { if (confirm(`Ștergi ${what}?`)) onDelete(); });
  return h('div', { class: 'pf-btns' }, e, d);
}

function updateDivMode() {
  const form = $<HTMLFormElement>('#divForm');
  const manual = (form.elements.namedItem('mode') as HTMLSelectElement).value === 'manual';
  for (const el of $$('[data-manual]', form)) el.hidden = !manual;
}

function editDividend(s: DividendSchedule) {
  const form = $<HTMLFormElement>('#divForm');
  form.reset();
  const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };
  set('id', s.id); set('instrumentId', s.instrumentId); set('mode', s.mode);
  set('day', String(s.day ?? 15)); set('perUnit', s.perUnit !== undefined ? String(s.perUnit).replace('.', ',') : '');
  set('currency', s.currency ?? ''); set('note', s.note ?? '');
  for (const c of $$<HTMLInputElement>('input[name="months"]', form)) c.checked = (s.months ?? []).includes(Number(c.value));
  updateDivMode();
  showTab('dividende');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitDividend(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const fd = new FormData(form);
  const instrumentId = text(fd, 'instrumentId');
  const mode = fd.get('mode') === 'lastYear' ? 'lastYear' : 'manual';
  if (mark(form, 'instrumentId', !instrumentId)) { toast('Alege instrumentul.', 'err'); return; }
  let s: DividendSchedule = { id: text(fd, 'id') ?? crypto.randomUUID(), instrumentId: instrumentId!, mode, note: text(fd, 'note') };
  if (mode === 'manual') {
    const months = fd.getAll('months').map(Number).filter(n => n >= 1 && n <= 12);
    const perUnit = parseNum(fd.get('perUnit'));
    const day = parseNum(fd.get('day'));
    const badPer = mark(form, 'perUnit', perUnit === undefined || Number.isNaN(perUnit) || perUnit <= 0);
    const badDay = mark(form, 'day', day !== undefined && (Number.isNaN(day) || day < 1 || day > 31 || !Number.isInteger(day)));
    if (!months.length) { toast('Bifează cel puțin o lună.', 'err'); return; }
    if (badPer || badDay) { toast('Verifică suma pe unitate și ziua.', 'err'); return; }
    s = { ...s, months, day, perUnit, currency: (text(fd, 'currency') as Currency | undefined) };
  } else if (!data?.transactions.some(t => t.type === 'dividend' && t.instrumentId === instrumentId)) {
    toast('Nu ai încă niciun dividend încasat pentru acest instrument: „ca anul trecut” nu va arăta nimic până nu adaugi unul.', 'err');
  }
  s = clean(s);
  const ok = await commit(d => {
    const list = cal(d).dividends ??= [];
    const k = list.findIndex(x => x.id === s.id);
    if (k >= 0) list[k] = s; else list.push(s);
  }, 'Calendarul de dividende a fost salvat.');
  if (ok) { form.reset(); updateDivMode(); }
}

// ─── Settings: planned cash-ins ───

const REPEAT_LABEL: Record<string, string> = { none: 'o dată', monthly: 'lunar', quarterly: 'trimestrial', yearly: 'anual' };

function renderPlanned() {
  const list = [...(data?.calendar?.planned ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  table($('#plannedTable'), ['Ce', 'Data', ['Sumă', 'num'], 'Repetare', ['Impozit', 'num'], 'Notă', ''], list.map(p => h('tr', {},
    td(p.label), td(fmtDate(p.date)), num(money(p.amount, p.currency)),
    td(`${REPEAT_LABEL[p.repeat ?? 'none']}${p.until && p.repeat && p.repeat !== 'none' ? ` până la ${fmtDate(p.until)}` : ''}`),
    num(p.taxRate !== undefined ? `${NF1.format(p.taxRate * 100)}%` : '—'),
    h('td', { class: 'pf-note' }, p.note ?? ''),
    td(rowButtons(() => editPlanned(p), () => void commit(d => { cal(d).planned = (cal(d).planned ?? []).filter(x => x.id !== p.id); }, 'Încasarea a fost ștearsă.'), p.label)),
  )), 'Nicio încasare planificată.');
}

function editPlanned(p: PlannedIncome) {
  const form = $<HTMLFormElement>('#plannedForm');
  form.reset();
  const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };
  set('id', p.id); set('label', p.label); set('date', p.date); set('amount', String(p.amount).replace('.', ','));
  set('currency', p.currency); set('repeat', p.repeat ?? 'none'); set('until', p.until ?? '');
  set('taxRate', p.taxRate !== undefined ? String(+(p.taxRate * 100).toFixed(4)).replace('.', ',') : ''); set('note', p.note ?? '');
  showTab('planificate');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitPlanned(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const fd = new FormData(form);
  const label = text(fd, 'label'), date = text(fd, 'date'), until = text(fd, 'until');
  const amount = parseNum(fd.get('amount'));
  const taxPct = parseNum(fd.get('taxRate'));
  const bad = [
    mark(form, 'label', !label),
    mark(form, 'date', !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)),
    mark(form, 'amount', amount === undefined || Number.isNaN(amount) || amount <= 0),
    mark(form, 'taxRate', taxPct !== undefined && (Number.isNaN(taxPct) || taxPct < 0 || taxPct > 100)),
    mark(form, 'until', !!until && !!date && until < date),
  ].some(Boolean);
  if (bad) { toast('Verifică câmpurile marcate cu roșu.', 'err'); return; }
  const repeat = String(fd.get('repeat')) as PlannedIncome['repeat'];
  const p: PlannedIncome = clean({
    id: text(fd, 'id') ?? crypto.randomUUID(), label: label!, date: date!, amount: amount!, currency: fd.get('currency') as Currency,
    repeat: repeat === 'none' ? undefined : repeat, until: repeat !== 'none' ? until : undefined,
    taxRate: taxPct !== undefined ? taxPct / 100 : undefined, note: text(fd, 'note'),
  });
  const ok = await commit(d => {
    const list = cal(d).planned ??= [];
    const k = list.findIndex(x => x.id === p.id);
    if (k >= 0) list[k] = p; else list.push(p);
  }, 'Încasarea a fost salvată.');
  if (ok) form.reset();
}

// ─── Settings: coupon frequency ───

function renderBonds() {
  const bonds = (data?.instruments ?? []).filter(i => i.maturity).sort((a, b) => a.maturity!.localeCompare(b.maturity!));
  table($('#bondTable'), ['Instrument', 'Scadență', ['Cupon', 'num'], ['Nominal / unitate', 'num'], 'Plăți pe an'], bonds.map(i => {
    const cur = data?.calendar?.bonds?.find(b => b.instrumentId === i.id)?.frequency;
    const sel = h('select', { class: 'pf-input', 'aria-label': `Plăți pe an pentru ${i.name}` },
      h('option', { value: '' }, 'nesetat (presupun 1)'),
      ...([1, 2, 4, 12] as const).map(f => h('option', { value: String(f) }, f === 1 ? '1 (anual)' : f === 2 ? '2 (semestrial)' : f === 4 ? '4 (trimestrial)' : '12 (lunar)'))) as HTMLSelectElement;
    sel.value = cur ? String(cur) : '';
    sel.addEventListener('change', () => {
      const f = Number(sel.value) as BondSchedule['frequency'] | 0;
      void commit(d => {
        const list = (cal(d).bonds ?? []).filter(b => b.instrumentId !== i.id);
        if (f) list.push({ instrumentId: i.id, frequency: f });
        cal(d).bonds = list;
      }, 'Frecvența cupoanelor a fost salvată.');
    });
    return h('tr', {}, td(i.name), td(fmtDate(i.maturity!)), num(i.coupon !== undefined ? `${NF1.format(i.coupon * 100)}%` : '—'),
      num(i.faceValue !== undefined ? money(i.faceValue, i.currency) : '—'), td(sel));
  }), 'Niciun instrument cu dată de scadență. Adaugă-le în Portofoliu → Instrumente (cupon, scadență, valoare nominală).');
}

// ─── Reinvest marker ───

function openReinvest(instrumentId: string, maturity: string) {
  const box = $('#reinvestBox');
  const form = $<HTMLFormElement>('#reinvestForm');
  const r = data?.calendar?.reinvest?.find(x => x.instrumentId === instrumentId && x.maturity === maturity);
  form.reset();
  const set = (n: string, v: string) => { (form.elements.namedItem(n) as HTMLInputElement).value = v; };
  set('instrumentId', instrumentId); set('maturity', maturity);
  set('daysBefore', String(r?.daysBefore ?? 14)); set('note', r?.note ?? '');
  (form.elements.namedItem('remind') as HTMLInputElement).checked = r ? r.remind : true;
  $('#reinvestName').textContent = `${instName(instrumentId)}, scadență ${fmtDate(maturity)}`;
  $('#reinvestRemove').hidden = !r;
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderMailState();
}

function renderMailState() {
  const el = $('#mailState');
  el.replaceChildren(
    mailOn === null ? 'Nu am putut verifica alertele pe e-mail. '
      : mailOn ? 'Alertele pe e-mail sunt pornite: memento-ul pleacă odată cu celelalte alerte (zilele lucrătoare, seara). '
      : 'Atenție: alertele pe e-mail sunt oprite, deci memento-ul nu pleacă până nu le pornești. ',
    h('a', { href: '/vault/invest/oportunitati/#alerte' }, 'Setări alerte →'),
  );
}

async function submitReinvest(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const fd = new FormData(form);
  const days = parseNum(fd.get('daysBefore'));
  if (mark(form, 'daysBefore', days === undefined || Number.isNaN(days) || days < 0 || days > 365 || !Number.isInteger(days))) {
    toast('Zilele: un număr întreg între 0 și 365.', 'err'); return;
  }
  const r: ReinvestMarker = clean({
    instrumentId: String(fd.get('instrumentId')), maturity: String(fd.get('maturity')),
    remind: fd.get('remind') === 'on', daysBefore: days!, note: text(fd, 'note'),
  });
  const ok = await commit(d => {
    cal(d).reinvest = [...(cal(d).reinvest ?? []).filter(x => !(x.instrumentId === r.instrumentId && x.maturity === r.maturity)), r];
  }, 'Marcajul „de reinvestit” a fost salvat.');
  if (ok) $('#reinvestBox').hidden = true;
}

async function loadMailState() {
  try {
    const res = await fetch('/vault/api/invest/alerts', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    mailOn = res.ok ? !!((await res.json()) as { settings?: { emailEnabled?: boolean } }).settings?.emailEnabled : null;
  } catch { mailOn = null; }
}

// ─── Tabs ───

function showTab(key: string) {
  const tabs = $$<HTMLButtonElement>('[role="tab"][data-tab]');
  if (!tabs.some(t => t.dataset.tab === key)) key = tabs[0].dataset.tab!;
  for (const t of tabs) {
    const on = t.dataset.tab === key;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    $(`#panel-${t.dataset.tab}`).hidden = !on;
  }
}

function initTabs() {
  const tabs = $$<HTMLButtonElement>('[role="tab"][data-tab]');
  for (const t of tabs) {
    t.addEventListener('click', () => showTab(t.dataset.tab!));
    t.addEventListener('keydown', e => {
      const i = tabs.indexOf(t);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (next) { e.preventDefault(); showTab(next.dataset.tab!); next.focus(); }
    });
  }
  showTab(location.hash.slice(1));
}

// ─── Wiring ───

function renderAll() {
  recompute();
  renderSummary();
  renderChart();
  renderMonths();
  renderList();
  fillInstrumentSelect();
  renderDividends();
  renderPlanned();
  renderBonds();
}

function wire() {
  for (const id of ['#past', '#ahead', '#currency', '#amounts']) $(id).addEventListener('change', renderAll);
  $('#listFilter').addEventListener('change', renderList);
  $('#listTable').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.cal-reinvest');
    if (b?.dataset.inst && b.dataset.mat) openReinvest(b.dataset.inst, b.dataset.mat);
  });
  const divForm = $<HTMLFormElement>('#divForm');
  divForm.addEventListener('submit', e => void submitDividend(e as SubmitEvent));
  (divForm.elements.namedItem('mode') as HTMLSelectElement).addEventListener('change', updateDivMode);
  divForm.addEventListener('reset', () => setTimeout(updateDivMode));
  $('#plannedForm').addEventListener('submit', e => void submitPlanned(e as SubmitEvent));
  $('#reinvestForm').addEventListener('submit', e => void submitReinvest(e as SubmitEvent));
  $('#reinvestCancel').addEventListener('click', () => { $('#reinvestBox').hidden = true; });
  $('#reinvestRemove').addEventListener('click', () => {
    const form = $<HTMLFormElement>('#reinvestForm');
    const inst = (form.elements.namedItem('instrumentId') as HTMLInputElement).value;
    const mat = (form.elements.namedItem('maturity') as HTMLInputElement).value;
    void commit(d => { cal(d).reinvest = (cal(d).reinvest ?? []).filter(x => !(x.instrumentId === inst && x.maturity === mat)); }, 'Marcajul a fost scos.')
      .then(ok => { if (ok) $('#reinvestBox').hidden = true; });
  });
  for (const f of $$<HTMLFormElement>('form.pf-form')) f.addEventListener('reset', () => { for (const x of $$('[aria-invalid="true"]', f)) x.setAttribute('aria-invalid', 'false'); });
  updateDivMode();
}

async function init() {
  wire();
  initTabs();
  try {
    ctx = await loadCalendarContext();
    loaded = ctx.data;
    data = loaded.doc;
    renderAll();
  } catch (e) {
    $('#loadState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
  }
  await loadMailState();
}

init();
