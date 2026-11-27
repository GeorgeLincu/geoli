// Income calendar for /vault/invest/calendar/ — pure logic (no DOM, no fetch).
//
// Builds a dated list of cash-ins for a window of months:
//   • expected bond coupons and maturities (instruments with `maturity`, from the positions in the ledger)
//   • expected dividends from George's own schedule (`data.calendar.dividends`): months + amount per unit, or
//     "like last year" = each dividend received is expected again one year later, scaled to the units held
//   • other planned cash-ins he adds (`data.calendar.planned`)
//   • received dividends / interest (actual transactions)
// Every item carries gross, estimated tax (tax-ro rules where they exist) and net. Nothing is invented:
// without a schedule or a past payment there is no expected dividend.
import type {
  Account, Currency, Instrument, InvestData, ReinvestMarker, TaxRules, TaxRuleSet, Transaction,
} from './types';
import { rulesFor, pv, flag, incomeSource, isGovInterest } from './tax-ro';

export type CalKind = 'coupon' | 'maturity' | 'dividend' | 'interest' | 'planned';

/**
 * upcoming = expected, in the future · received = expected in the past and a matching payment exists ·
 * pending = expected in the past, no matching payment found · past = maturity / planned in the past ·
 * actual = a received payment (transaction)
 */
export type CalStatus = 'upcoming' | 'received' | 'pending' | 'past' | 'actual';

/** rate = tax-ro rate · exempt = Tezaur/Fidelis rule · noRules = no tax rules saved · ownRate = George's own % ·
 *  unknown = no rule for this income · principal = repayment of capital, not income */
export type TaxBasis = 'rate' | 'exempt' | 'noRules' | 'ownRate' | 'unknown' | 'principal';

export interface CalItem {
  id: string;
  date: string;
  kind: CalKind;
  /** true = expected/planned, false = received (transaction) */
  expected: boolean;
  status: CalStatus;
  label: string;
  instrumentId?: string;
  accountId?: string;
  currency: Currency;
  gross: number;
  /** Estimated tax (null = unknown) */
  tax: number | null;
  net: number | null;
  taxBasis: TaxBasis;
  /** Rate used for the estimate, when there is one */
  taxRate?: number;
  /** The rate / exemption is confirmed by George for that exact year */
  taxConfirmed: boolean;
  /** How an expected amount was derived */
  basis?: 'schedule' | 'lastYear' | 'coupon' | 'maturity' | 'planned';
  quantity?: number;
  /** Coupon frequency not set by George (annual assumed) */
  assumedFrequency?: boolean;
  /** No face value on the instrument: the average purchase price per unit was used */
  faceEstimated?: boolean;
  /** Maturity items: the "de reinvestit" marker, if George set one */
  reinvest?: ReinvestMarker;
  txId?: string;
  matchedTxId?: string;
  note?: string;
}

// ───────────── Dates ─────────────

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds months to an ISO date, clamping the day to the end of the month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, lastDay(ny, nm)))}`;
}
export const addYears = (iso: string, n: number) => addMonths(iso, n * 12);
export const monthOf = (iso: string) => iso.slice(0, 7);
export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Months from `from` to `to` inclusive ("YYYY-MM"). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = addMonths(`${m}-01`, 1).slice(0, 7)) out.push(m);
  return out;
}

/** Default window: `past` months before the current one, the current one and `ahead` months after it. */
export function windowFor(today: string, past: number, ahead: number) {
  return { from: monthOf(addMonths(`${monthOf(today)}-01`, -past)), to: monthOf(addMonths(`${monthOf(today)}-01`, ahead)) };
}

// ───────────── Holdings ─────────────

const pairKey = (acc: string, inst: string) => `${acc}|${inst}`;

/** Units held per (account, instrument) at any date, replaying buys, sells and transfers. */
export function holdingsIndex(txs: readonly Transaction[]) {
  const events = new Map<string, { date: string; q: number }[]>();
  const buys = new Map<string, { qty: number; cost: number }>();
  const add = (acc: string, inst: string, date: string, q: number) => {
    const k = pairKey(acc, inst);
    const list = events.get(k) ?? [];
    list.push({ date, q });
    events.set(k, list);
  };
  for (const t of txs) {
    if (!t.instrumentId || !t.quantity) continue;
    if (t.type === 'buy') {
      add(t.accountId, t.instrumentId, t.date, t.quantity);
      const b = buys.get(pairKey(t.accountId, t.instrumentId)) ?? { qty: 0, cost: 0 };
      b.qty += t.quantity; b.cost += t.quantity * (t.price ?? 0);
      buys.set(pairKey(t.accountId, t.instrumentId), b);
    } else if (t.type === 'sell') add(t.accountId, t.instrumentId, t.date, -t.quantity);
    else if (t.type === 'transfer' && t.toAccountId) {
      add(t.accountId, t.instrumentId, t.date, -t.quantity);
      add(t.toAccountId, t.instrumentId, t.date, t.quantity);
    }
  }
  for (const list of events.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return {
    /** Units held at the end of `date` */
    at(acc: string, inst: string, date: string): number {
      let q = 0;
      for (const e of events.get(pairKey(acc, inst)) ?? []) { if (e.date > date) break; q += e.q; }
      return Math.abs(q) < 1e-9 ? 0 : q;
    },
    /** Every (account, instrument) pair that ever had a position */
    pairs(inst?: string): { accountId: string; instrumentId: string }[] {
      return [...events.keys()].map(k => { const [accountId, instrumentId] = k.split('|'); return { accountId, instrumentId }; })
        .filter(p => !inst || p.instrumentId === inst);
    },
    /** Average purchase price per unit (in the transaction currency) */
    avgBuy(acc: string, inst: string): number | null {
      const b = buys.get(pairKey(acc, inst));
      return b && b.qty > 0 && b.cost > 0 ? b.cost / b.qty : null;
    },
  };
}

// ───────────── Tax ─────────────

const confirmedParam = (set: TaxRuleSet, key: string) => {
  const p = set.params[key];
  return !!p && (p.confirmed ?? set.confirmed);
};

export interface TaxEstimate { tax: number | null; taxBasis: TaxBasis; taxRate?: number; taxConfirmed: boolean }

/**
 * Estimated Romanian tax on a dividend or interest payment.
 * Received RO-source income: the tax withheld (final), else the rate. Foreign source: the RO rate on the gross,
 * or the foreign withholding when it is higher (the credit is capped). Expected income: gross × rate.
 */
export function estimateIncomeTax(o: {
  rules: TaxRules | null; kind: 'dividend' | 'interest'; date: string; gross: number; withheld?: number;
  account?: Account; instrument?: Instrument; currency: Currency; received: boolean;
}): TaxEstimate {
  const r = rulesFor(o.rules, Number(o.date.slice(0, 4)));
  const withheld = o.withheld ?? 0;
  if (!r) return { tax: o.received && withheld > 0 ? withheld : null, taxBasis: 'noRules', taxConfirmed: false };
  const { set, exact } = r;
  const source = incomeSource(o.account, o.instrument, o.currency);
  if (o.kind === 'interest' && source === 'ro' && isGovInterest(o.account, o.instrument) && flag(set, 'int.govExempt')) {
    return { tax: 0, taxBasis: 'exempt', taxRate: 0, taxConfirmed: exact && confirmedParam(set, 'int.govExempt') };
  }
  const key = o.kind === 'dividend' ? 'div.rate' : 'int.rate';
  const rate = pv(set, key);
  const due = o.gross * rate;
  const tax = !o.received ? due : source === 'ro' ? (withheld > 0 ? withheld : due) : Math.max(withheld, due);
  return { tax: r2(tax), taxBasis: 'rate', taxRate: rate, taxConfirmed: exact && confirmedParam(set, key) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ───────────── Build ─────────────

export interface CalendarInput {
  data: InvestData;
  rules: TaxRules | null;
  today: string;
  /** First and last month of the window, "YYYY-MM" (inclusive) */
  from: string;
  to: string;
}

/** Days within which a received payment counts as the expected one */
export const MATCH_DAYS = 31;

export function buildCalendar({ data, rules, today, from, to }: CalendarInput): CalItem[] {
  const accounts = new Map(data.accounts.map(a => [a.id, a]));
  const instruments = new Map(data.instruments.map(i => [i.id, i]));
  const cal = data.calendar ?? {};
  const hold = holdingsIndex(data.transactions);
  const inWin = (d: string) => { const m = monthOf(d); return m >= from && m <= to; };
  const winStart = `${from}-01`;
  const winEnd = `${to}-${pad(lastDay(Number(to.slice(0, 4)), Number(to.slice(5, 7))))}`;
  /** Units for an expected payment: held the day before it in the past (a purchase on the payment day gets
   *  nothing), held today for the future. */
  const qtyFor = (acc: string, inst: string, d: string) => hold.at(acc, inst, d > today ? today : addDays(d, -1));
  const instLabel = (i: Instrument) => (i.ticker ? `${i.name} (${i.ticker})` : i.name);
  const items: CalItem[] = [];

  const expectedItem = (o: Omit<CalItem, 'expected' | 'status' | keyof TaxEstimate | 'net'> & { tax: TaxEstimate }): CalItem => {
    const { tax, ...rest } = o;
    return {
      ...rest, expected: true, status: 'upcoming',
      ...tax, gross: r2(o.gross), net: tax.tax === null ? null : r2(o.gross - tax.tax),
    };
  };

  // Received dividends / interest
  for (const t of data.transactions) {
    if ((t.type !== 'dividend' && t.type !== 'interest') || !inWin(t.date) || !t.amount) continue;
    const inst = t.instrumentId ? instruments.get(t.instrumentId) : undefined;
    const account = accounts.get(t.accountId);
    const tax = estimateIncomeTax({
      rules, kind: t.type, date: t.date, gross: t.amount, withheld: t.withheldTax, account, instrument: inst, currency: t.currency, received: true,
    });
    items.push({
      id: `tx:${t.id}`, date: t.date, kind: t.type, expected: false, status: 'actual',
      label: inst ? instLabel(inst) : account?.name ?? '—', instrumentId: t.instrumentId, accountId: t.accountId,
      currency: t.currency, gross: r2(t.amount), ...tax, net: tax.tax === null ? null : r2(t.amount - tax.tax), txId: t.id, note: t.note,
    });
  }

  // Bond coupons and maturities
  for (const inst of data.instruments) {
    if (!inst.maturity) continue;
    const sched = cal.bonds?.find(b => b.instrumentId === inst.id);
    const freq = sched?.frequency ?? 1;
    const step = 12 / freq;
    for (const { accountId } of hold.pairs(inst.id)) {
      const account = accounts.get(accountId);
      const avg = hold.avgBuy(accountId, inst.id);
      const face = inst.faceValue ?? avg;
      if (face === null || face === undefined) continue;
      const faceEstimated = inst.faceValue === undefined;
      if (inst.coupon && inst.coupon > 0) {
        for (let k = 0; k < freq * 100; k++) {
          const d = addMonths(inst.maturity, -k * step);
          if (d < winStart) break;
          if (d > winEnd) continue;
          const q = qtyFor(accountId, inst.id, d);
          if (q <= 0) continue;
          const gross = q * face * inst.coupon / freq;
          items.push(expectedItem({
            id: `cp:${accountId}:${inst.id}:${d}`, date: d, kind: 'coupon', label: instLabel(inst),
            instrumentId: inst.id, accountId, currency: inst.currency, gross, quantity: q, basis: 'coupon',
            assumedFrequency: !sched, faceEstimated,
            tax: estimateIncomeTax({ rules, kind: 'interest', date: d, gross, account, instrument: inst, currency: inst.currency, received: false }),
          }));
        }
      }
      if (inWin(inst.maturity)) {
        const q = qtyFor(accountId, inst.id, inst.maturity);
        if (q > 0) {
          items.push(expectedItem({
            id: `mt:${accountId}:${inst.id}:${inst.maturity}`, date: inst.maturity, kind: 'maturity', label: instLabel(inst),
            instrumentId: inst.id, accountId, currency: inst.currency, gross: q * face, quantity: q, basis: 'maturity', faceEstimated,
            reinvest: cal.reinvest?.find(r => r.instrumentId === inst.id && r.maturity === inst.maturity),
            tax: { tax: 0, taxBasis: 'principal', taxConfirmed: true },
          }));
        }
      }
    }
  }

  // Expected dividends from George's schedules
  const lastYearStart = addYears(today, -1);
  for (const s of cal.dividends ?? []) {
    const inst = instruments.get(s.instrumentId);
    if (!inst) continue;
    if (s.mode === 'manual') {
      if (!s.perUnit || !(s.perUnit > 0) || !s.months?.length) continue;
      const currency = s.currency ?? inst.currency;
      for (const m of monthRange(from, to)) {
        if (!s.months.includes(Number(m.slice(5, 7)))) continue;
        const d = `${m}-${pad(Math.min(Math.max(1, Math.round(s.day ?? 15)), lastDay(Number(m.slice(0, 4)), Number(m.slice(5, 7)))))}`;
        for (const { accountId } of hold.pairs(inst.id)) {
          const q = qtyFor(accountId, inst.id, d);
          if (q <= 0) continue;
          const gross = q * s.perUnit;
          items.push(expectedItem({
            id: `dv:${s.id}:${accountId}:${d}`, date: d, kind: 'dividend', label: instLabel(inst), instrumentId: inst.id, accountId,
            currency, gross, quantity: q, basis: 'schedule', note: s.note,
            tax: estimateIncomeTax({ rules, kind: 'dividend', date: d, gross, account: accounts.get(accountId), instrument: inst, currency, received: false }),
          }));
        }
      }
    } else {
      for (const b of data.transactions) {
        if (b.type !== 'dividend' || b.instrumentId !== inst.id || !b.amount || b.amount <= 0) continue;
        // Payments of the last 12 months repeat in each future year; older ones only one year later (for comparison)
        const shifts = b.date > lastYearStart ? [1, 2, 3] : [1];
        const qb = hold.at(b.accountId, inst.id, b.date);
        for (const sh of shifts) {
          const d = addYears(b.date, sh);
          if (!inWin(d)) continue;
          const q = qtyFor(b.accountId, inst.id, d);
          const gross = qb > 0 ? (b.amount / qb) * q : b.amount;
          if (!(gross > 0)) continue;
          items.push(expectedItem({
            id: `dl:${s.id}:${b.id}:${sh}`, date: d, kind: 'dividend', label: instLabel(inst), instrumentId: inst.id, accountId: b.accountId,
            currency: b.currency, gross, quantity: qb > 0 ? q : undefined, basis: 'lastYear', note: s.note,
            tax: estimateIncomeTax({ rules, kind: 'dividend', date: d, gross, account: accounts.get(b.accountId), instrument: inst, currency: b.currency, received: false }),
          }));
        }
      }
    }
  }

  // Other planned cash-ins
  for (const p of cal.planned ?? []) {
    const step = p.repeat === 'monthly' ? 1 : p.repeat === 'quarterly' ? 3 : p.repeat === 'yearly' ? 12 : 0;
    const until = p.until && p.until < winEnd ? p.until : winEnd;
    for (let k = 0; k < (step ? 1200 : 1); k++) {
      const d = addMonths(p.date, k * step);
      if (d > until) break;
      if (!inWin(d)) continue;
      const tax: TaxEstimate = p.taxRate !== undefined
        ? { tax: r2(p.amount * p.taxRate), taxBasis: 'ownRate', taxRate: p.taxRate, taxConfirmed: true }
        : { tax: null, taxBasis: 'unknown', taxConfirmed: false };
      items.push(expectedItem({
        id: `pl:${p.id}:${d}`, date: d, kind: 'planned', label: p.label, currency: p.currency, gross: p.amount, basis: 'planned', note: p.note, tax,
      }));
    }
  }

  matchReceived(items, data.transactions, today);
  return items.sort((a, b) => a.date.localeCompare(b.date) || Number(a.expected) - Number(b.expected) || a.label.localeCompare(b.label));
}

/** Sets the status of expected items: future → upcoming; past coupons/dividends → received (a payment within
 *  MATCH_DAYS for the same instrument) or pending; past maturities / planned → past. Each payment matches once. */
function matchReceived(items: CalItem[], txs: readonly Transaction[], today: string) {
  const used = new Set<string>();
  const candidates = txs.filter(t => (t.type === 'dividend' || t.type === 'interest') && t.instrumentId);
  const expectedPast = items.filter(i => i.expected && i.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  for (const i of items) if (i.expected) i.status = i.date > today ? 'upcoming' : 'past';
  for (const i of expectedPast) {
    if (i.kind !== 'coupon' && i.kind !== 'dividend') continue;
    const want = i.kind === 'coupon' ? 'interest' : 'dividend';
    let best: Transaction | null = null, bestGap = Infinity;
    for (const t of candidates) {
      if (used.has(t.id) || t.type !== want || t.instrumentId !== i.instrumentId) continue;
      if (i.accountId && t.accountId !== i.accountId) continue;
      const gap = Math.abs(daysBetween(i.date, t.date));
      if (gap <= MATCH_DAYS && gap < bestGap) { best = t; bestGap = gap; }
    }
    if (best) { used.add(best.id); i.status = 'received'; i.matchedTxId = best.id; } else i.status = 'pending';
  }
}

// ───────────── Totals ─────────────

/** Converts an amount to the display currency on a date (null = no rate). */
export type Converter = (amount: number, from: Currency, date: string) => number | null;

export interface Sums { gross: number; tax: number; net: number; count: number; taxUnknown: number }
export interface MonthTotal {
  month: string;
  expected: Sums;
  received: Sums;
  /** Capital returned at maturity (not income) */
  principal: number;
  /** Items left out because no FX rate was found */
  missingFx: number;
}

const emptySums = (): Sums => ({ gross: 0, tax: 0, net: 0, count: 0, taxUnknown: 0 });
function addTo(s: Sums, gross: number, tax: number | null) {
  s.gross += gross; s.count++;
  if (tax === null) { s.taxUnknown++; s.net += gross; } else { s.tax += tax; s.net += gross - tax; }
}

/** Totals per month in the display currency. Expected = coupons, dividends, planned (not principal); received = payments. */
export function monthTotals(items: readonly CalItem[], months: readonly string[], conv: Converter): MonthTotal[] {
  const by = new Map(months.map(m => [m, { month: m, expected: emptySums(), received: emptySums(), principal: 0, missingFx: 0 } as MonthTotal]));
  for (const i of items) {
    const t = by.get(monthOf(i.date));
    if (!t) continue;
    const g = conv(i.gross, i.currency, i.date);
    if (g === null) { t.missingFx++; continue; }
    const tax = i.tax === null ? null : i.gross ? g * (i.tax / i.gross) : 0;
    if (i.kind === 'maturity') t.principal += g;
    else addTo(i.expected ? t.expected : t.received, g, tax);
  }
  return [...by.values()].map(t => ({
    ...t, principal: r2(t.principal),
    expected: roundSums(t.expected), received: roundSums(t.received),
  }));
}
const roundSums = (s: Sums): Sums => ({ ...s, gross: r2(s.gross), tax: r2(s.tax), net: r2(s.net) });

export interface YearTotal { year: number; expected: Sums; received: Sums; principal: number; missingFx: number }

export function yearTotals(months: readonly MonthTotal[]): YearTotal[] {
  const by = new Map<number, YearTotal>();
  for (const m of months) {
    const y = Number(m.month.slice(0, 4));
    const t = by.get(y) ?? { year: y, expected: emptySums(), received: emptySums(), principal: 0, missingFx: 0 };
    for (const k of ['expected', 'received'] as const) {
      t[k].gross += m[k].gross; t[k].tax += m[k].tax; t[k].net += m[k].net; t[k].count += m[k].count; t[k].taxUnknown += m[k].taxUnknown;
    }
    t.principal += m.principal; t.missingFx += m.missingFx;
    by.set(y, t);
  }
  return [...by.values()].sort((a, b) => a.year - b.year)
    .map(t => ({ ...t, expected: roundSums(t.expected), received: roundSums(t.received), principal: r2(t.principal) }));
}

/** Expected cash-ins (incl. maturities) from today to today + days, by date. */
export const upcoming = (items: readonly CalItem[], today: string, days = 30) => {
  const end = addDays(today, days);
  return items.filter(i => i.expected && i.date >= today && i.date <= end);
};

// ───────────── Reinvest reminders (used by the alerts cron) ─────────────

export interface ReinvestReminder {
  /** De-duplication key: once per instrument and maturity */
  key: string;
  instrumentId: string;
  label: string;
  maturity: string;
  daysBefore: number;
  note?: string;
  /** Face value held (units × face value); null when the instrument has no face value */
  amount: number | null;
  currency: Currency;
}

/** Maturities George marked "de reinvestit" with a reminder, still held and not yet past. */
export function reinvestReminders(data: InvestData, today: string): ReinvestReminder[] {
  const out: ReinvestReminder[] = [];
  const hold = holdingsIndex(data.transactions);
  for (const r of data.calendar?.reinvest ?? []) {
    if (!r.remind) continue;
    const inst = data.instruments.find(i => i.id === r.instrumentId);
    if (!inst || inst.maturity !== r.maturity || r.maturity < today) continue;
    const held = hold.pairs(inst.id).reduce((a, p) => a + hold.at(p.accountId, inst.id, today), 0);
    if (held <= 0) continue;
    out.push({
      key: `${inst.id}|${r.maturity}`, instrumentId: inst.id, label: inst.ticker ? `${inst.name} (${inst.ticker})` : inst.name,
      maturity: r.maturity, daysBefore: Math.max(0, Math.round(r.daysBefore)), note: r.note,
      amount: inst.faceValue !== undefined ? r2(inst.faceValue * held) : null, currency: inst.currency,
    });
  }
  return out;
}
