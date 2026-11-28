// Property analysis for /vault/invest/imobiliare/ (pure, tested in property.test.ts): purchase cash, rental yield
// and IRR with a resale, buy vs rent, and the side-by-side comparison of 2–3 opportunities.
//
// Currency: the price, rent and costs are in EUR, the loan in RON. Loan cash is converted at the scenario's
// EUR/RON rate, kept constant over the years (no FX forecast) — the page says so.
import type { Currency, PropertyScenario, RealEstateDoc } from './types';
import { schedule, dae, prepaymentSavings, ageIn, debtToIncome, type MortgageRow, type MortgageSummary } from './mortgage';
import { xirr } from './returns';

// ─── Parameters (legal rules with provenance, confirmed by George) ───

export type ReParamKey =
  | 'prepay.feeFixed' | 'prepay.feeVariable' | 'rent.taxRate' | 'rent.deduction' | 'dti.max' | 'dti.maxFirstHome' | 'age.maxAtMaturity';

export const paramValue = (doc: RealEstateDoc | undefined, key: ReParamKey, fallback = 0) => doc?.params?.[key]?.value ?? fallback;
export const unconfirmedReParams = (doc: RealEstateDoc | undefined) =>
  Object.entries(doc?.params ?? {}).filter(([, p]) => !p.confirmed).map(([k]) => k);

// ─── Purchase ───

export interface Purchase {
  eurRon: number;
  priceEur: number;
  downEur: number;
  downRon: number;
  /** Loan in RON (George's amount, else price − down payment) */
  loanRon: number;
  /** Purchase costs (notary, agency, renovation…) in EUR; items without a rate are counted in `missing` */
  costsEur: number;
  upfrontFeesEur: number;
  /** Down payment + costs + loan signing fees */
  ownCashEur: number;
  ownCashRon: number;
  missing: number;
}

export function purchase(s: PropertyScenario, eurRon: number, toEur: (amount: number, cur: Currency) => number | null): Purchase {
  const downEur = s.priceEur * s.downPct;
  let costsEur = 0, missing = 0;
  for (const c of s.costs) {
    const v = c.currency === 'EUR' ? c.amount : c.currency === 'RON' ? c.amount / eurRon : toEur(c.amount, c.currency);
    if (v === null) missing++; else costsEur += v;
  }
  const loanRon = s.loan ? (s.loan.principalRon ?? Math.max(0, (s.priceEur - downEur) * eurRon)) : 0;
  const upfrontFeesEur = s.loan ? (s.loan.upfrontFeesRon ?? 0) / eurRon : 0;
  // Cash purchase: the whole price is own money
  const own = (s.loan ? downEur : s.priceEur) + costsEur + upfrontFeesEur;
  return { eurRon, priceEur: s.priceEur, downEur, downRon: downEur * eurRon, loanRon, costsEur, upfrontFeesEur, ownCashEur: own, ownCashRon: own * eurRon, missing };
}

// ─── Loan for a scenario ───

export interface LoanResult {
  base: { rows: MortgageRow[]; summary: MortgageSummary };
  withPrepay: { rows: MortgageRow[]; summary: MortgageSummary };
  dae: number | null;
  /** Per IRCC scenario (with prepayments): shift → summary */
  scenarios: { shift: number; summary: MortgageSummary; rows: MortgageRow[] }[];
}

export function loanFor(s: PropertyScenario, p: Purchase, doc: RealEstateDoc | undefined): LoanResult | null {
  if (!s.loan || !(p.loanRon > 0)) return null;
  const prepayFee = { fixed: paramValue(doc, 'prepay.feeFixed'), variable: paramValue(doc, 'prepay.feeVariable') };
  const base = schedule(s.loan, p.loanRon, { prepayFee });
  const withPrepay = schedule(s.loan, p.loanRon, { prepayFee, prepayments: s.prepayments });
  const shifts = s.loan.fixedMonths < s.loan.months && s.loan.ircc !== undefined ? (s.loan.irccScenarios ?? []) : [];
  return {
    base, withPrepay, dae: dae(s.loan, p.loanRon, base.rows),
    scenarios: shifts.map(shift => ({ shift, ...schedule(s.loan!, p.loanRon, { prepayFee, prepayments: s.prepayments, irccShift: shift }) })),
  };
}

/** Loan cash (instalments, prepayments, fees, insurance) per year of ownership (year 1 = first 12 instalments). */
export function loanCashByYear(rows: readonly MortgageRow[], years: number): number[] {
  const out = Array.from({ length: years }, () => 0);
  rows.forEach((r, i) => { const y = Math.floor(i / 12); if (y < years) out[y] += r.cash; });
  return out;
}
const balanceAfterYears = (rows: readonly MortgageRow[], principal: number, years: number) =>
  rows.length === 0 ? principal : years * 12 >= rows.length ? 0 : rows[years * 12 - 1]?.balance ?? principal;

// ─── Rental ───

export interface RentalYear {
  year: number;
  rentCollected: number;
  costs: number;
  tax: number;
  /** Net operating income (before the loan) */
  noi: number;
  debt: number;
  cashFlow: number;
  value: number;
  /** Loan balance in EUR at the end of the year */
  balance: number;
  equity: number;
}

export interface RentalResult {
  grossYield: number | null;
  /** First-year NOI / (price + purchase costs) */
  netYield: number | null;
  cashOnCash: number | null;
  /** Money-weighted return of the whole holding with a sale at the end (EUR) */
  irr: number | null;
  saleNet: number;
  years: RentalYear[];
}

export function rentalAnalysis(s: PropertyScenario, p: Purchase, rows: readonly MortgageRow[], doc: RealEstateDoc | undefined): RentalResult {
  const H = s.holdYears ?? 10;
  const rent = s.rent ?? {};
  const g = rent.growth ?? 0, a = s.appreciation ?? 0;
  const taxRate = paramValue(doc, 'rent.taxRate'), deduction = paramValue(doc, 'rent.deduction');
  const debt = loanCashByYear(rows, H);
  const years: RentalYear[] = [];
  for (let y = 1; y <= H; y++) {
    const value = s.priceEur * Math.pow(1 + a, y);
    const collected = (rent.monthlyEur ?? 0) * Math.pow(1 + g, y - 1) * 12 * (rent.occupancy ?? 1);
    const costs = collected * (rent.managementPct ?? 0) + s.priceEur * Math.pow(1 + a, y - 1) * (rent.maintenancePct ?? 0) + (rent.otherYearlyEur ?? 0);
    const tax = collected * (1 - deduction) * taxRate;
    const noi = collected - costs - tax;
    const d = debt[y - 1] / p.eurRon;
    const balance = balanceAfterYears(rows, p.loanRon, y) / p.eurRon;
    years.push({ year: y, rentCollected: collected, costs, tax, noi, debt: d, cashFlow: noi - d, value, balance, equity: value - balance });
  }
  const last = years[H - 1];
  const saleNet = last ? last.value * (1 - (s.sellCostPct ?? 0)) - last.balance : 0;
  const start = s.purchaseDate;
  const at = (y: number) => `${+start.slice(0, 4) + y}${start.slice(4)}`;
  const flows = [{ date: start, amount: -p.ownCashEur }, ...years.map(x => ({ date: at(x.year), amount: x.cashFlow + (x.year === H ? saleNet : 0) }))];
  const first = years[0];
  return {
    grossYield: s.priceEur > 0 && rent.monthlyEur ? (rent.monthlyEur * 12) / s.priceEur : null,
    netYield: first && s.priceEur + p.costsEur > 0 ? first.noi / (s.priceEur + p.costsEur) : null,
    cashOnCash: first && p.ownCashEur > 0 ? first.cashFlow / p.ownCashEur : null,
    irr: xirr(flows, 0.05),
    saleNet, years,
  };
}

// ─── Home: buy vs rent ───

export interface BuyRentYear { year: number; ownerWealth: number; renterWealth: number }

/**
 * Same money each month in both cases. Owner pays the loan, upkeep and other costs; renter pays the rent (the one
 * George would pay otherwise) and invests the down payment + costs at `yearlyReturn`. Whoever pays less in a month
 * invests the difference. Wealth = home value after selling costs − loan + investments (buyer), or investments
 * (renter); gains on investments taxed at `gainTax` when counted. EUR, nominal.
 */
export function buyVsRent(s: PropertyScenario, p: Purchase, rows: readonly MortgageRow[], yearlyReturn: number, gainTax = 0) {
  const H = s.holdYears ?? 10;
  const rent = s.rent ?? {};
  const g = rent.growth ?? 0, a = s.appreciation ?? 0;
  const rm = Math.pow(1 + yearlyReturn, 1 / 12) - 1;
  let owner = 0, ownerIn = 0, renter = p.ownCashEur, renterIn = p.ownCashEur;
  const years: BuyRentYear[] = [];
  let breakEven: number | null = null;
  for (let m = 0; m < H * 12; m++) {
    const y = Math.floor(m / 12);
    const value = s.priceEur * Math.pow(1 + a, y);
    const ownerCost = (rows[m]?.cash ?? 0) / p.eurRon + (value * (rent.maintenancePct ?? 0) + (rent.otherYearlyEur ?? 0)) / 12;
    const rentCost = (rent.monthlyEur ?? 0) * Math.pow(1 + g, y);
    owner *= 1 + rm; renter *= 1 + rm;
    const d = ownerCost - rentCost;
    if (d > 0) { renter += d; renterIn += d; } else { owner -= d; ownerIn -= d; }
    if ((m + 1) % 12 === 0) {
      const yr = (m + 1) / 12;
      const home = s.priceEur * Math.pow(1 + a, yr) * (1 - (s.sellCostPct ?? 0)) - balanceAfterYears(rows, p.loanRon, yr) / p.eurRon;
      const ow = home + owner - Math.max(0, owner - ownerIn) * gainTax;
      const rw = renter - Math.max(0, renter - renterIn) * gainTax;
      years.push({ year: yr, ownerWealth: ow, renterWealth: rw });
      if (breakEven === null && ow >= rw) breakEven = yr;
    }
  }
  const last = years.at(-1);
  return { years, breakEven, advantage: last ? last.ownerWealth - last.renterWealth : 0 };
}

// ─── Comparison ───

export interface ScenarioMetrics {
  id: string;
  name: string;
  use: PropertyScenario['use'];
  priceEur: number;
  ownCashEur: number;
  loanRon: number;
  firstPayment: number | null;
  variablePayment: number | null;
  totalInterest: number | null;
  totalCostRon: number | null;
  dae: number | null;
  endMonth: string | null;
  ageAtPurchase: number | null;
  ageAtEnd: number | null;
  dti: number | null;
  interestSaved: number | null;
  /** Rental */
  grossYield: number | null;
  netYield: number | null;
  cashOnCash: number | null;
  irr: number | null;
  /** Home: buy − rent wealth at the horizon, EUR, and the first year buying is ahead */
  buyAdvantage: number | null;
  breakEven: number | null;
  /** Equity (value − loan) at the horizon, EUR */
  equityAtHorizon: number | null;
  horizon: number;
}

export interface MetricsContext {
  eurRon: number;
  toEur: (amount: number, cur: Currency) => number | null;
  doc: RealEstateDoc | undefined;
  birthYear?: number;
  /** Nominal yearly return of the alternative (portfolio), for buy vs rent */
  yearlyReturn: number;
  gainTax: number;
}

export function scenarioMetrics(s: PropertyScenario, ctx: MetricsContext): ScenarioMetrics {
  const p = purchase(s, s.eurRon ?? ctx.eurRon, ctx.toEur);
  const loan = loanFor(s, p, ctx.doc);
  const rows = loan?.withPrepay.rows ?? [];
  const sum = loan?.withPrepay.summary;
  const H = s.holdYears ?? 10;
  const rental = s.use === 'rental' ? rentalAnalysis(s, p, rows, ctx.doc) : null;
  const bvr = s.use === 'home' && s.rent?.monthlyEur ? buyVsRent(s, p, rows, ctx.yearlyReturn, ctx.gainTax) : null;
  const value = s.priceEur * Math.pow(1 + (s.appreciation ?? 0), H);
  return {
    id: s.id, name: s.name, use: s.use, priceEur: s.priceEur, ownCashEur: p.ownCashEur, loanRon: p.loanRon,
    firstPayment: sum ? sum.firstPayment : null,
    variablePayment: sum ? sum.variablePayment : null,
    totalInterest: sum ? sum.totalInterest : null,
    totalCostRon: sum ? sum.totalCash : null,
    dae: loan?.dae ?? null,
    endMonth: sum ? sum.endMonth : null,
    ageAtPurchase: ageIn(ctx.birthYear, s.purchaseDate.slice(0, 7)),
    ageAtEnd: sum ? ageIn(ctx.birthYear, sum.endMonth) : null,
    dti: sum ? debtToIncome(Math.max(sum.firstPayment, sum.variablePayment ?? 0), s.monthlyIncomeRon, s.otherDebtRon) : null,
    interestSaved: loan ? prepaymentSavings(loan.base.summary, loan.withPrepay.summary).interestSaved : null,
    grossYield: rental?.grossYield ?? null, netYield: rental?.netYield ?? null, cashOnCash: rental?.cashOnCash ?? null, irr: rental?.irr ?? null,
    buyAdvantage: bvr ? bvr.advantage : null, breakEven: bvr ? bvr.breakEven : null,
    equityAtHorizon: value - balanceAfterYears(rows, p.loanRon, H) / p.eurRon,
    horizon: H,
  };
}
