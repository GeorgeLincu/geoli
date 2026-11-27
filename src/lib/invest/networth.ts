// Full net worth: the investment portfolio (ledger + prices, never re-entered) plus the assets and debts
// George records by hand in data.json `netWorth` (bank cash, savings, real estate, cars, mortgage, loans…).
// Pure functions; the /vault/invest/avere/ page, the dashboard card and the yearly reports (Phase 7) use them.
//
// Reports: call `netWorthAt(data, sources, 'YYYY-12-31')` for the year-end figure.
import type {
  Currency, DatedValue, InvestData, IpsRules, Liability, NetWorthAsset, NetWorthAssetCategory, NetWorthDoc,
} from './types';
import type { FxSource } from './fx';
import type { PriceSource } from './prices';
import { convert } from './fx';
import { computeLedger } from './ledger';
import { valuePortfolio } from './portfolio';

/** Asset categories shown on the page. `investments` and `pension` come from the portfolio. */
export type NetWorthCategory = 'investments' | 'pension' | NetWorthAssetCategory;
export const NET_WORTH_CATEGORIES: readonly NetWorthCategory[] = ['investments', 'pension', 'cash', 'savings', 'real_estate', 'vehicle', 'other'];

export const emptyNetWorth = (): NetWorthDoc => ({ assets: [], liabilities: [] });

/** Cash and savings are liquid and count toward the emergency fund unless George says otherwise. */
const quickByDefault = (c: NetWorthAssetCategory) => c === 'cash' || c === 'savings';
export const isLiquid = (a: Pick<NetWorthAsset, 'category' | 'liquid'>) => a.liquid ?? quickByDefault(a.category);
export const isEmergency = (a: Pick<NetWorthAsset, 'category' | 'emergency'>) => a.emergency ?? quickByDefault(a.category);

/** The entry in force on `date`: the latest one on or before it (null = nothing recorded yet). */
export function valueAt(points: readonly DatedValue[], date: string): DatedValue | null {
  let best: DatedValue | null = null;
  for (const p of points) if (p.date <= date && (!best || p.date >= best.date)) best = p;
  return best;
}

export interface NetWorthItem {
  /** `acc:<accountId>` (portfolio), `asset:<id>`, `debt:<id>` */
  key: string;
  kind: 'portfolio' | 'asset' | 'liability';
  id: string;
  name: string;
  /** Liabilities have no category */
  category: NetWorthCategory | null;
  /** In `currency` (portfolio accounts: EUR). Always positive; liabilities are subtracted. */
  value: number;
  currency: Currency;
  /** Date of the value used (manual entries) */
  valueDate?: string;
  valueEur: number | null;
  valueRon: number | null;
  liquid: boolean;
  emergency: boolean;
}

export interface NetWorthAt {
  date: string;
  items: NetWorthItem[];
  assetsEur: number;
  assetsRon: number;
  liabilitiesEur: number;
  liabilitiesRon: number;
  netEur: number;
  netRon: number;
  /** EUR per asset category (zero categories included) */
  byCategory: Record<NetWorthCategory, number>;
  liquidEur: number;
  illiquidEur: number;
  /** EUR counted toward the emergency fund */
  emergencyEur: number;
  /** liabilities / assets (null when there are no assets) */
  debtToAssets: number | null;
  /** Currencies without a usable rate on that date (their items are left out of the totals) */
  missingFx: Currency[];
  /** Portfolio positions valued at cost (no price on that date) */
  atCost: number;
}

export interface NetWorthSources {
  fx: FxSource;
  prices: PriceSource;
  /** Portfolio accounts that hold the emergency fund (the IPS rule's `accountIds`) */
  emergencyAccountIds?: readonly string[];
}

/** Net worth on `date`. Also the entry point for the yearly reports. */
export function netWorthAt(data: InvestData, src: NetWorthSources, date: string): NetWorthAt {
  const items: NetWorthItem[] = [];
  const missing = new Set<Currency>();
  const efAccounts = new Set(src.emergencyAccountIds ?? []);

  // Portfolio, one item per account (positions + tracked cash + Pillar 2/3 values)
  let atCost = 0;
  if (data.accounts.length) {
    const ledger = computeLedger(data, src.fx, date);
    const valuation = valuePortfolio(data, ledger, src.prices, src.fx, date);
    for (const c of valuation.missingFx) missing.add(c);
    const perAccount = new Map<string, { eur: number; ron: number; any: boolean }>();
    for (const h of valuation.holdings) {
      if (h.basis === 'cost') atCost++;
      const acc = perAccount.get(h.accountId) ?? { eur: 0, ron: 0, any: false };
      if (h.valueEur !== null && h.valueRon !== null) { acc.eur += h.valueEur; acc.ron += h.valueRon; acc.any = true; }
      perAccount.set(h.accountId, acc);
    }
    for (const a of data.accounts) {
      const v = perAccount.get(a.id);
      if (!v || (!v.any && v.eur === 0)) continue;
      const pension = a.type === 'pillar2' || a.type === 'pillar3';
      const category: NetWorthCategory = pension ? 'pension' : a.type === 'cash' ? 'cash' : 'investments';
      items.push({
        key: `acc:${a.id}`, kind: 'portfolio', id: a.id, name: a.name, category,
        value: v.eur, currency: 'EUR', valueEur: v.eur, valueRon: v.ron,
        liquid: !pension, emergency: efAccounts.has(a.id),
      });
    }
  }

  const nw = data.netWorth ?? emptyNetWorth();
  const conv = (value: number, cur: Currency) => {
    const eur = convert(src.fx, value, cur, 'EUR', date);
    const ron = convert(src.fx, value, cur, 'RON', date);
    if (eur === null || ron === null) missing.add(cur === 'RON' ? 'EUR' : cur);
    return { eur, ron };
  };

  for (const a of nw.assets) {
    const v = valueAt(a.values, date);
    if (!v) continue;
    const { eur, ron } = conv(v.value, a.currency);
    items.push({
      key: `asset:${a.id}`, kind: 'asset', id: a.id, name: a.name, category: a.category,
      value: v.value, currency: a.currency, valueDate: v.date, valueEur: eur, valueRon: ron,
      liquid: isLiquid(a), emergency: isEmergency(a),
    });
  }
  for (const l of nw.liabilities) {
    const v = valueAt(l.balances, date);
    if (!v) continue;
    const { eur, ron } = conv(v.value, l.currency);
    items.push({
      key: `debt:${l.id}`, kind: 'liability', id: l.id, name: l.name, category: null,
      value: v.value, currency: l.currency, valueDate: v.date, valueEur: eur, valueRon: ron,
      liquid: false, emergency: false,
    });
  }

  const byCategory = Object.fromEntries(NET_WORTH_CATEGORIES.map(c => [c, 0])) as Record<NetWorthCategory, number>;
  let assetsEur = 0, assetsRon = 0, liabilitiesEur = 0, liabilitiesRon = 0, liquidEur = 0, emergencyEur = 0;
  for (const it of items) {
    if (it.valueEur === null || it.valueRon === null) continue;
    if (it.kind === 'liability') { liabilitiesEur += it.valueEur; liabilitiesRon += it.valueRon; continue; }
    assetsEur += it.valueEur; assetsRon += it.valueRon;
    if (it.category) byCategory[it.category] += it.valueEur;
    if (it.liquid) liquidEur += it.valueEur;
    if (it.emergency) emergencyEur += it.valueEur;
  }
  return {
    date, items, assetsEur, assetsRon, liabilitiesEur, liabilitiesRon,
    netEur: assetsEur - liabilitiesEur, netRon: assetsRon - liabilitiesRon,
    byCategory, liquidEur, illiquidEur: assetsEur - liquidEur, emergencyEur,
    debtToAssets: assetsEur > 0 ? liabilitiesEur / assetsEur : null,
    missingFx: [...missing].sort(), atCost,
  };
}

// ─── Over time ───

const pad = (n: number) => String(n).padStart(2, '0');
const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

/** First date anything was recorded: a transaction, a Pillar 2/3 value, an asset value or a debt balance. */
export function firstNetWorthDate(data: InvestData): string | null {
  const dates: string[] = data.transactions.map(t => t.date);
  for (const p of data.pensionValues ?? []) dates.push(p.date);
  for (const a of data.netWorth?.assets ?? []) for (const v of a.values) dates.push(v.date);
  for (const l of data.netWorth?.liabilities ?? []) for (const v of l.balances) dates.push(v.date);
  return dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
}

/**
 * Month-ends from the month of `from` up to `to` (exclusive of month-ends after `to`), then `to` itself.
 * With more than `maxPoints` months, every k-th month-end is kept (always ending at `to`).
 */
export function seriesDates(from: string, to: string, maxPoints = 180): string[] {
  if (from > to) return [to];
  let [y, m] = from.split('-').map(Number);
  const ends: string[] = [];
  for (;;) {
    const e = monthEnd(y, m);
    if (e >= to) break;
    ends.push(e);
    if (++m > 12) { m = 1; y++; }
  }
  const step = Math.max(1, Math.ceil((ends.length + 1) / maxPoints));
  const kept = step === 1 ? ends : ends.filter((_, i) => (ends.length - 1 - i) % step === 0);
  return [...kept, to];
}

export const netWorthSeries = (data: InvestData, src: NetWorthSources, dates: readonly string[]) =>
  dates.map(d => netWorthAt(data, src, d));

// ─── Emergency fund ───

export interface ExpensesSource { eur: number; source: 'manual' | 'ips' }

/** Monthly expenses: George's own figure on the page wins, else the IPS emergency-fund rule's. */
export function monthlyExpenses(doc: NetWorthDoc | undefined, ips: IpsRules | null | undefined): ExpensesSource | null {
  if (doc?.monthlyExpenses && doc.monthlyExpenses > 0) return { eur: doc.monthlyExpenses, source: 'manual' };
  const ef = ips?.emergencyFund;
  if (ef && ef.monthlyExpenses > 0) return { eur: ef.monthlyExpenses, source: 'ips' };
  return null;
}

export interface EmergencyStatus {
  eur: number;
  /** Months of expenses covered (null = no expenses known) */
  months: number | null;
  /** Target months from the IPS rule, if any */
  targetMonths: number | null;
  status: 'ok' | 'under' | 'unknown';
}

export function emergencyStatus(nw: Pick<NetWorthAt, 'emergencyEur'>, expenses: ExpensesSource | null, ips: IpsRules | null | undefined): EmergencyStatus {
  const targetMonths = ips?.emergencyFund?.months ? ips.emergencyFund.months : null;
  const months = expenses && expenses.eur > 0 ? nw.emergencyEur / expenses.eur : null;
  const status = months === null || targetMonths === null ? 'unknown' : months + 1e-9 >= targetMonths ? 'ok' : 'under';
  return { eur: nw.emergencyEur, months, targetMonths, status };
}

// ─── Debts ───

/** Interest for one month at a yearly rate (simple monthly rate = yearly / 12, as banks quote it). */
export const monthlyInterest = (balance: number, yearlyRate: number) => balance * yearlyRate / 12;

/**
 * Months until a debt is paid off with a fixed monthly payment (annuity maths).
 * 0 when nothing is owed; null when the payment doesn't cover the interest (or is missing).
 */
export function payoffMonths(balance: number, yearlyRate: number | undefined, payment: number | undefined): number | null {
  if (!(balance > 0)) return 0;
  if (!payment || payment <= 0) return null;
  const r = (yearlyRate ?? 0) / 12;
  if (r <= 0) return Math.ceil(balance / payment - 1e-9);
  if (payment <= balance * r + 1e-9) return null;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r) - 1e-9);
}

/** The latest balance of a debt (any date), for the page's table. */
export const latestBalance = (l: Pick<Liability, 'balances'>) => valueAt(l.balances, '9999-12-31');
