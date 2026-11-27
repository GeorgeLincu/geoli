// Yearly reports (Phase 7): what happened to the portfolio in a calendar year.
// Pure functions on top of the existing modules — nothing is recomputed here that another module owns:
//   valuation      computeLedger + valuePortfolio (ledger.ts, portfolio.ts)
//   net worth      netWorthAt (networth.ts)
//   taxes          buildTaxYear / computeTaxYears (tax-ro.ts)
//   drift / IPS    computeDrift (portfolio.ts), activeIpsRules / monthContributions (ips-checks.ts)
//   FI             inputsFromSettings / fiNumber / yearsToFI (projection.ts)
//   returns        returns.ts
//
// Scope of the return figures: every account except Pillar 2/3 (their values are entered by hand, with no
// contributions recorded), in EUR at BNR rates. Flows (money in/out of the portfolio) depend on how an
// account is kept:
//   - accounts with deposits/withdrawals ("cash tracked"): deposits and withdrawals are the flows; buys, sells,
//     dividends and fees move money inside the account (its cash is part of the value);
//   - accounts without them: each buy is money in, each sale and each dividend/interest payment is money out
//     (their cash isn't valued), a standalone fee is money in that buys nothing.
import type { Account, AssetClass, Currency, InvestData, IpsDoc, Settings, TargetAllocation, TaxRuleSet, TaxRules, Transaction } from './types';
import type { FxYear } from './market';
import type { Ledger } from './ledger';
import { flag, ledgerFx, rulesFor, buildTaxYear, computeTaxYears, annualAverages, type TaxYearResult } from './tax-ro';
import type { FxSource } from './fx';
import type { PriceSource } from './prices';
import { convert } from './fx';
import { computeLedger } from './ledger';
import { valuePortfolio, computeDrift, type DriftResult, type Holding } from './portfolio';
import { monthContributions } from './ips-checks';
import { inputsFromSettings, fiNumber, yearsToFI } from './projection';
import { modifiedDietz, chainReturns, periodXirr, realReturn, drawdownSeries, wealthIndex, type DatedFlow } from './returns';

export const DEFAULT_BAND = 0.05;

const pad = (n: number) => String(n).padStart(2, '0');
export const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
export const yearEnd = (y: number) => `${y}-12-31`;
const isPension = (a: Account | undefined) => a?.type === 'pillar2' || a?.type === 'pillar3';

// ─── Scope and flows ───

/** Accounts the return figures cover: all but Pillar 2/3. */
export const scopeAccounts = (data: Pick<InvestData, 'accounts'>) =>
  new Set(data.accounts.filter(a => !isPension(a)).map(a => a.id));

/**
 * Accounts whose cash is part of the value: those with a deposit, a withdrawal or a cash transfer at any time.
 * Decided over the whole history (not per date), so flows and values stay consistent across years.
 */
export function cashTrackedAccounts(data: Pick<InvestData, 'transactions'>): Set<string> {
  const s = new Set<string>();
  for (const t of data.transactions) {
    if (t.type === 'deposit' || t.type === 'withdrawal') s.add(t.accountId);
    if (t.type === 'transfer' && !t.instrumentId && t.toAccountId) { s.add(t.accountId); s.add(t.toAccountId); }
  }
  return s;
}

export type FlowKind = 'contribution' | 'payout';
export interface PortfolioFlow extends DatedFlow {
  /** EUR, portfolio view: + money in, − money out */
  amount: number;
  kind: FlowKind;
  txId: string;
}

export interface FlowsResult {
  flows: PortfolioFlow[];
  /** Transactions skipped because a rate was missing */
  missingFx: string[];
  warnings: string[];
}

/** Money in/out of the portfolio (EUR at the BNR rate of each transaction's date). */
export function portfolioFlows(data: Pick<InvestData, 'accounts' | 'transactions'>, fx: FxSource): FlowsResult {
  const scope = scopeAccounts(data);
  const tracked = cashTrackedAccounts(data);
  const flows: PortfolioFlow[] = [];
  const missingFx: string[] = [];
  const warnings: string[] = [];
  const add = (t: Transaction, amount: number, kind: FlowKind) => {
    if (!amount) return;
    const eur = convert(fx, amount, t.currency, 'EUR', t.date);
    if (eur === null) { missingFx.push(t.id); return; }
    flows.push({ date: t.date, amount: eur, kind, txId: t.id });
  };
  for (const t of data.transactions) {
    const inScope = scope.has(t.accountId);
    const f = t.fees ?? 0;
    if (t.type === 'transfer') {
      const toIn = !!t.toAccountId && scope.has(t.toAccountId);
      if (t.instrumentId) {
        if (inScope !== toIn) warnings.push(`Transfer de titluri între portofoliu și Pilon 2/3 (${t.date}) — ignorat în randamente`);
        if (inScope && !tracked.has(t.accountId)) add(t, f, 'contribution');
        continue;
      }
      const amt = t.amount ?? 0;
      if (inScope && !toIn) add(t, -amt, 'contribution');
      else if (!inScope && toIn) add(t, amt, 'contribution');
      continue;
    }
    if (!inScope) continue;
    if (tracked.has(t.accountId)) {
      if (t.type === 'deposit') add(t, t.amount ?? 0, 'contribution');
      else if (t.type === 'withdrawal') add(t, -(t.amount ?? 0), 'contribution');
      continue;
    }
    switch (t.type) {
      case 'buy': add(t, (t.quantity ?? 0) * (t.price ?? 0) + f, 'contribution'); break;
      case 'sell': add(t, -((t.quantity ?? 0) * (t.price ?? 0) - f - (t.withheldTax ?? 0)), 'contribution'); break;
      case 'dividend': case 'interest': add(t, -((t.amount ?? 0) - (t.withheldTax ?? 0) - f), 'payout'); break;
      case 'fee': add(t, (t.amount ?? 0) + f, 'contribution'); break;
      default: break;
    }
  }
  flows.sort((a, b) => a.date.localeCompare(b.date));
  return { flows, missingFx, warnings };
}

// ─── Valuation ───

export interface PortfolioPoint {
  date: string;
  eur: number;
  ron: number;
  byClass: Partial<Record<AssetClass, number>>;
  holdings: Holding[];
  missingFx: Currency[];
  /** Positions valued at cost (no price on that date) */
  atCost: number;
}

export interface ValueSources { fx: FxSource; prices: PriceSource }

/** Portfolio value on `date` in the report scope (no Pillar 2/3; cash of cash-tracked accounts). */
export function portfolioAt(data: InvestData, src: ValueSources, date: string, tracked = cashTrackedAccounts(data)): PortfolioPoint {
  const scope = scopeAccounts(data);
  const ledger = computeLedger(data, src.fx, date);
  ledger.cashTracked = new Set([...tracked].filter(id => scope.has(id)));
  const v = valuePortfolio(data, ledger, src.prices, src.fx, date);
  const holdings = v.holdings.filter(h => scope.has(h.accountId));
  let eur = 0, ron = 0, atCost = 0;
  const byClass: Partial<Record<AssetClass, number>> = {};
  for (const h of holdings) {
    if (h.basis === 'cost') atCost++;
    if (h.valueEur === null || h.valueRon === null) continue;
    eur += h.valueEur; ron += h.valueRon;
    byClass[h.assetClass] = (byClass[h.assetClass] ?? 0) + h.valueEur;
  }
  return { date, eur, ron, byClass, holdings, missingFx: v.missingFx, atCost };
}

/** First date with a transaction in the report scope (null = nothing yet). */
export function firstActivity(data: Pick<InvestData, 'accounts' | 'transactions'>): string | null {
  const scope = scopeAccounts(data);
  let first: string | null = null;
  for (const t of data.transactions) {
    if (!scope.has(t.accountId) && !(t.toAccountId && scope.has(t.toAccountId))) continue;
    if (!first || t.date < first) first = t.date;
  }
  return first;
}

/** Month-ends from the month before `first` to the last one before `to`, then `to`. */
export function monthEnds(first: string, to: string): string[] {
  let y = +first.slice(0, 4), m = +first.slice(5, 7) - 1;
  if (m === 0) { m = 12; y--; }
  const out: string[] = [];
  for (;;) {
    const e = monthEnd(y, m);
    if (e >= to) break;
    out.push(e);
    if (++m > 12) { m = 1; y++; }
  }
  out.push(to);
  return out;
}

export interface History {
  /** Month-end valuations (first point = the month-end before the first transaction), last = `to` */
  points: PortfolioPoint[];
  flows: PortfolioFlow[];
  missingFx: string[];
  warnings: string[];
  /** Monthly Modified Dietz returns, keyed by `YYYY-MM` (null = nothing invested that month) */
  monthly: Map<string, number | null>;
  to: string;
}

/**
 * Valuations at every month-end from the first transaction to `to`, plus flows and monthly returns.
 * `overrides` replaces the value at a date (George's corrected year-end snapshot), so every figure uses it.
 */
export function buildHistory(data: InvestData, src: ValueSources, to: string, overrides: ReadonlyMap<string, number> = new Map()): History | null {
  const first = firstActivity(data);
  if (!first || first > to) return null;
  const tracked = cashTrackedAccounts(data);
  const { flows, missingFx, warnings } = portfolioFlows(data, src.fx);
  const points = monthEnds(first, to).map(d => {
    const p = portfolioAt(data, src, d, tracked);
    const o = overrides.get(d);
    if (o !== undefined && p.eur > 0) {
      const k = o / p.eur;
      return { ...p, eur: o, ron: p.ron * k, byClass: Object.fromEntries(Object.entries(p.byClass).map(([c, v]) => [c, (v ?? 0) * k])) };
    }
    return o !== undefined ? { ...p, eur: o } : p;
  });
  const monthly = new Map<string, number | null>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const inside = flows.filter(f => f.date > a.date && f.date <= b.date);
    monthly.set(b.date.slice(0, 7), modifiedDietz(a.date, a.eur, inside, b.date, b.eur));
  }
  return { points, flows, missingFx, warnings, monthly, to };
}

export const pointAt = (h: History, date: string) => h.points.find(p => p.date === date) ?? null;

// ─── One year ───

export interface YearFigures {
  year: number;
  start: string;
  end: string;
  /** Whole calendar year finished */
  complete: boolean;
  startEur: number;
  endEur: number;
  startRon: number;
  endRon: number;
  /** Contributions: money in, money out (positive numbers), net */
  contributedIn: number;
  contributedOut: number;
  netContributions: number;
  /** Dividends and interest paid out of accounts whose cash isn't tracked */
  payouts: number;
  /** Gross dividends + interest */
  income: number;
  dividends: number;
  interest: number;
  /** Tax withheld at source (income + Romanian-broker sales) */
  withheld: number;
  fees: number;
  /** Realised gain/loss of the sales in the year (EUR at the sale date) */
  realized: number;
  /** Price change: end − start − net flows − income + withheld + fees */
  market: number;
  /** Money-weighted return of the period (for a part year: the period rate) and annualised */
  xirr: number | null;
  xirrAnnual: number | null;
  /** Time-weighted (monthly Modified Dietz, chained) */
  twr: number | null;
  twrSkipped: number;
  months: { month: string; r: number | null }[];
  /** Deepest fall of the wealth index in the year, below the running peak since the start */
  maxDrawdown: number;
  /** Rows skipped (no rate) */
  missingFx: number;
}

/** Income, fees and withheld tax of a year in EUR — read from the transactions in scope. */
function yearCashItems(data: InvestData, fx: FxSource, year: number) {
  const scope = scopeAccounts(data);
  const toEur = (n: number, c: Currency, d: string) => convert(fx, n, c, 'EUR', d);
  let dividends = 0, interest = 0, withheld = 0, fees = 0, missing = 0;
  for (const t of data.transactions) {
    if (!t.date.startsWith(`${year}-`) || !scope.has(t.accountId)) continue;
    const f = t.fees ?? 0;
    const w = t.type === 'dividend' || t.type === 'interest' || t.type === 'sell' ? (t.withheldTax ?? 0) : 0;
    const gross = t.type === 'dividend' || t.type === 'interest' ? (t.amount ?? 0) : 0;
    const fee = f + (t.type === 'fee' ? (t.amount ?? 0) : 0);
    if (!gross && !w && !fee) continue;
    const g = toEur(gross, t.currency, t.date), ww = toEur(w, t.currency, t.date), ff = toEur(fee, t.currency, t.date);
    if (g === null || ww === null || ff === null) { missing++; continue; }
    if (t.type === 'dividend') dividends += g; else interest += g;
    withheld += ww; fees += ff;
  }
  return { dividends, interest, withheld, fees, missing };
}

/** Realised gains of the year converted to EUR at the sale date (ledger in instrument currency). */
function yearRealized(data: InvestData, fx: FxSource, year: number) {
  const scope = scopeAccounts(data);
  const ledger = computeLedger(data, fx, yearEnd(year));
  let sum = 0, missing = 0;
  for (const r of ledger.realized) {
    if (!r.date.startsWith(`${year}-`) || !scope.has(r.accountId)) continue;
    const v = convert(fx, r.gain, r.currency, 'EUR', r.date);
    if (v === null) missing++; else sum += v;
  }
  return { sum, missing };
}

export function yearFigures(data: InvestData, fx: FxSource, h: History, year: number): YearFigures | null {
  const start = yearEnd(year - 1);
  const firstPoint = h.points[0];
  const end = h.to < yearEnd(year) ? h.to : yearEnd(year);
  if (end < `${year}-01-01` || yearEnd(year) <= firstPoint.date) return null;
  const startP = pointAt(h, start) ?? (firstPoint.date >= start ? firstPoint : null);
  const endP = pointAt(h, end);
  if (!startP || !endP) return null;
  const from = startP.date;

  const flows = h.flows.filter(f => f.date > from && f.date <= end);
  let contributedIn = 0, contributedOut = 0, payouts = 0;
  for (const f of flows) {
    if (f.kind === 'payout') payouts -= f.amount;
    else if (f.amount > 0) contributedIn += f.amount; else contributedOut -= f.amount;
  }
  const netFlows = flows.reduce((s, f) => s + f.amount, 0);
  const items = yearCashItems(data, fx, year);
  const income = items.dividends + items.interest;
  const realized = yearRealized(data, fx, year);
  const market = endP.eur - startP.eur - netFlows - income + items.withheld + items.fees;

  const months: { month: string; r: number | null }[] = [];
  for (const p of h.points) if (p.date > from && p.date <= end) months.push({ month: p.date.slice(0, 7), r: h.monthly.get(p.date.slice(0, 7)) ?? null });
  const tw = chainReturns(months.map(m => m.r));
  const xr = periodXirr(from, startP.eur, flows, end, endP.eur);

  // Drawdown inside the year, measured against the peak since the start of the history
  const subs = h.points.slice(1).filter(p => p.date <= end).map(p => ({ to: p.date, r: h.monthly.get(p.date.slice(0, 7)) ?? null }));
  const dd = drawdownSeries(wealthIndex(h.points[0].date, subs));
  const maxDrawdown = dd.points.filter(p => p.date > from && p.date <= end).reduce((m, p) => Math.max(m, p.dd), 0);

  return {
    year, start: from, end, complete: end === yearEnd(year),
    startEur: startP.eur, endEur: endP.eur, startRon: startP.ron, endRon: endP.ron,
    contributedIn, contributedOut, netContributions: contributedIn - contributedOut, payouts,
    income, dividends: items.dividends, interest: items.interest, withheld: items.withheld, fees: items.fees,
    realized: realized.sum, market,
    xirr: xr.period, xirrAnnual: xr.annual, twr: tw.value, twrSkipped: tw.skipped, months, maxDrawdown,
    missingFx: items.missing + realized.missing + h.missingFx.filter(id => data.transactions.find(t => t.id === id)?.date.startsWith(`${year}-`)).length,
  };
}

/** Years covered by the history (first transaction year … `to` year), newest first. */
export function reportYears(h: History | null): number[] {
  if (!h) return [];
  const first = +h.points[0].date.slice(0, 4) + (h.points[0].date.endsWith('-12-31') ? 1 : 0);
  const last = +h.to.slice(0, 4);
  const out: number[] = [];
  for (let y = last; y >= first; y--) out.push(y);
  return out;
}

// ─── Waterfall ───

export interface WaterfallStep { key: string; label: string; value: number; kind: 'total' | 'delta' }

/** Start → contributions → dividends & interest → withheld tax → fees → market → payouts → end. */
export function waterfall(f: YearFigures): WaterfallStep[] {
  return [
    { key: 'start', label: 'Început', value: f.startEur, kind: 'total' },
    { key: 'contrib', label: 'Contribuții nete', value: f.netContributions, kind: 'delta' },
    { key: 'income', label: 'Dividende și dobânzi', value: f.income, kind: 'delta' },
    { key: 'withheld', label: 'Impozit reținut', value: -f.withheld, kind: 'delta' },
    { key: 'fees', label: 'Comisioane', value: -f.fees, kind: 'delta' },
    { key: 'market', label: 'Câștig de piață', value: f.market, kind: 'delta' },
    { key: 'payouts', label: 'Venituri retrase', value: -f.payouts, kind: 'delta' },
    { key: 'end', label: 'Sfârșit', value: f.endEur, kind: 'total' },
  ];
}

/** Invisible base + visible bar for a waterfall drawn as stacked bars (ECharts has no waterfall type). */
export function waterfallBars(steps: readonly WaterfallStep[]) {
  let running = 0;
  return steps.map(s => {
    if (s.kind === 'total') { running = s.value; return { ...s, base: Math.min(0, s.value), bar: Math.abs(s.value) }; }
    const from = running, to = running + s.value;
    running = to;
    return { ...s, base: Math.min(from, to), bar: Math.abs(s.value) };
  });
}

// ─── Inflation, FI, IPS ───

export interface InflationEntry { rate: number; source?: string }
export const realOf = (nominal: number | null, inflation: InflationEntry | null | undefined) => realReturn(nominal, inflation?.rate);

export interface FiProgress { fiNumber: number; capital: number; progress: number; yearsToFI: number | null; missing: string[] }

/** FI progress at the year end: the plan's FI number (today's settings) vs the portfolio value then. */
export function fiProgress(settings: Settings, targets: TargetAllocation[], year: number, capital: number): FiProgress | null {
  const r = inputsFromSettings(settings, targets, year, capital);
  if (!r.inputs) return settings.retirementSpending !== undefined
    ? { fiNumber: fiNumber(settings.retirementSpending, settings.swr ?? 0.04), capital, progress: capital / fiNumber(settings.retirementSpending, settings.swr ?? 0.04), yearsToFI: null, missing: r.missing }
    : null;
  const fi = fiNumber(r.inputs.spending, r.inputs.swr);
  return { fiNumber: fi, capital, progress: fi > 0 ? capital / fi : 0, yearsToFI: yearsToFI(r.inputs), missing: [] };
}

export interface ComplianceItem { key: string; label: string; status: 'ok' | 'warn' | 'na'; detail: string }

/** The IPS version in force on `date` (newest version dated on or before it). */
export function ipsVersionOn(doc: IpsDoc | null | undefined, date: string) {
  let best: IpsDoc['versions'][number] | null = null;
  for (const v of doc?.versions ?? []) if (v.date <= date && (!best || v.date >= best.date)) best = v;
  return best;
}

const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
const pct1 = (x: number) => `${NF1.format(x * 100)}%`;

/**
 * IPS compliance for a year, measured with the rules in force at its end: drift at the year end, emergency
 * fund at the year end, months with the planned contribution, whether the yearly review happened.
 */
export function ipsCompliance(
  doc: IpsDoc | null | undefined, data: InvestData, fx: FxSource, year: number, end: string,
  drift: DriftResult | null, accountValuesEur: ReadonlyMap<string, number>,
): { versionDate: string | null; items: ComplianceItem[] } {
  const v = ipsVersionOn(doc, end);
  if (!v) return { versionDate: null, items: [] };
  const rules = v.rules ?? {};
  const items: ComplianceItem[] = [];
  if (rules.driftAlerts) {
    if (!drift?.rows.length) items.push({ key: 'drift', label: 'Alocare în benzi', status: 'na', detail: 'Lipsesc ținta sau valorile.' });
    else {
      const out = drift.rows.filter(r => r.status !== 'ok');
      items.push({
        key: 'drift', label: 'Alocare în benzi la sfârșitul perioadei', status: out.length ? 'warn' : 'ok',
        detail: out.length ? out.map(r => `${r.target.label}: ${pct1(r.actualWeight)} (țintă ${pct1(r.target.weight)})`).join('; ') : `Toate cele ${drift.rows.length} rânduri în bandă.`,
      });
    }
  }
  const ef = rules.emergencyFund;
  if (ef && ef.months > 0 && ef.monthlyExpenses > 0) {
    const have = ef.accountIds.reduce((s, id) => s + (accountValuesEur.get(id) ?? 0), 0);
    const need = ef.months * ef.monthlyExpenses;
    items.push({
      key: 'emergency', label: `Fond de urgență (${NF0.format(ef.months)} luni)`, status: have + 1e-6 >= need ? 'ok' : 'warn',
      detail: `${NF0.format(have)} € din ${NF0.format(need)} € (≈ ${NF1.format(have / ef.monthlyExpenses)} luni).`,
    });
  }
  const c = rules.contribution;
  if (c && c.amount > 0) {
    let met = 0, total = 0;
    const lastMonth = +end.slice(5, 7);
    const toEur = (n: number, cur: Currency, d: string) => convert(fx, n, cur, 'EUR', d);
    for (let m = 1; m <= lastMonth; m++) {
      const me = monthEnd(year, m) > end ? end : monthEnd(year, m);
      const got = monthContributions(data.transactions, me, toEur);
      total++;
      if (got.eur + 0.01 * c.amount >= c.amount) met++;
    }
    items.push({
      key: 'contribution', label: `Contribuția lunară (${NF0.format(c.amount)} €)`, status: met === total ? 'ok' : 'warn',
      detail: `Atinsă în ${met} din ${total} ${total === 1 ? 'lună' : 'luni'}.`,
    });
  }
  if (rules.reviewMonth) {
    const reviewed = (doc?.versions ?? []).some(x => x.date.startsWith(`${year}-`));
    const due = `${year}-${pad(rules.reviewMonth)}-01` <= end;
    items.push({
      key: 'review', label: 'Revizuirea anuală a IPS', status: reviewed ? 'ok' : due ? 'warn' : 'na',
      detail: reviewed ? 'Există o versiune salvată în acest an.' : due ? 'Nicio versiune salvată în acest an.' : 'Încă nu e scadentă.',
    });
  }
  return { versionDate: v.date, items };
}

/** Drift at a date in the report scope (holdings with a positive value), with the Portofoliu fallback band. */
export const driftOf = (holdings: readonly Holding[], targets: readonly TargetAllocation[]) =>
  targets.length ? computeDrift(holdings.filter(x => (x.valueEur ?? 0) > 0), targets, DEFAULT_BAND) : null;

/** EUR per account (report scope) from the holdings. */
export function accountValues(holdings: readonly Holding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of holdings) if (h.valueEur !== null) m.set(h.accountId, (m.get(h.accountId) ?? 0) + h.valueEur);
  return m;
}

// ─── Taxes (same computation as the Taxe page) ───

/**
 * Romanian tax for every income year up to `lastYear` (the loss carry-forward needs the earlier years), computed
 * exactly like /vault/invest/taxe/: rules per year from tax-rules.json, ledger with the rule set's FX choice.
 */
export function taxResults(data: InvestData, rules: TaxRules | null, fxDocs: readonly FxYear[], fx: FxSource, lastYear: number) {
  if (!rules?.years.length) return new Map<number, TaxYearResult>();
  const ledgers = new Map<boolean, Ledger>();
  const ledgerFor = (set: TaxRuleSet) => {
    const k = flag(set, 'fx.prevDay');
    if (!ledgers.has(k)) ledgers.set(k, computeLedger(data, ledgerFx(set, fx)));
    return ledgers.get(k)!;
  };
  const txYears = data.transactions.map(t => Number(t.date.slice(0, 4)));
  const first = txYears.length ? Math.min(...txYears) : lastYear;
  const span: number[] = [];
  for (let y = first; y <= lastYear; y++) span.push(y);
  return computeTaxYears(span, y => {
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
