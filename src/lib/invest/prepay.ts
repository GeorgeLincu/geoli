// "Merită plata anticipată?" (pure, tested in property.test.ts): the same money either goes into the loan, or into the
// portfolio while the loan runs normally. Both cases spend exactly the same each month:
//   - in a month with a prepayment, the "invest" case puts that amount (and the fee it avoids) into the portfolio;
//   - when the prepaid loan ends earlier or its instalment is lower, the "prepay" case invests the difference.
// At the end of the original loan both loans are paid off; wealth = portfolio after tax on its gains.
// Deterministic at the expected return, plus a small Monte Carlo (same random path for both cases).
import type { MortgageLoan, Prepayment } from './types';
import { schedule, type ScheduleOptions } from './mortgage';
import { mulberry32, gaussian, lognormalParams } from './montecarlo';

export interface PrepayMarket {
  /** Expected NOMINAL yearly return of the portfolio (plan real return + inflation) */
  yearlyReturn: number;
  /** Yearly volatility (plan) */
  vol: number;
  /** Tax on investment gains when counted (tax-ro capital gains rate) */
  gainTax: number;
  runs?: number;
  seed?: number;
}

export interface PrepayCompare {
  /** Wealth at the end of the original loan, RON */
  prepayWealth: number;
  investWealth: number;
  /** invest − prepay (positive = investing wins) */
  difference: number;
  /** Yearly portfolio return at which both are equal (null = none in −50%…+100%) */
  breakEvenReturn: number | null;
  horizonMonths: number;
  /** Monte Carlo: share of runs where investing ends ahead, and the difference percentiles */
  probInvestWins: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

/** Monthly extra cash (positive) each strategy invests, from the two loan schedules. */
export function extraFlows(loan: MortgageLoan, principal: number, prepayments: readonly Prepayment[], opts: ScheduleOptions = {}) {
  const a = schedule(loan, principal, { ...opts, prepayments: [] }).rows;
  const b = schedule(loan, principal, { ...opts, prepayments }).rows;
  const H = a.length;
  const toInvest: number[] = [], toPrepayCase: number[] = [];
  for (let m = 0; m < H; m++) {
    const d = (b[m]?.cash ?? 0) - (a[m]?.cash ?? 0);
    toInvest.push(Math.max(0, d));
    toPrepayCase.push(Math.max(0, -d));
  }
  return { toInvest, toPrepayCase, horizon: H };
}

function grow(flows: readonly number[], monthly: (m: number) => number, gainTax: number) {
  let v = 0, inSum = 0;
  for (let m = 0; m < flows.length; m++) { v = v * (1 + monthly(m)) + flows[m]; inSum += flows[m]; }
  return v - Math.max(0, v - inSum) * gainTax;
}

export function prepayVsInvest(loan: MortgageLoan, principal: number, prepayments: readonly Prepayment[], market: PrepayMarket, opts: ScheduleOptions = {}): PrepayCompare | null {
  const f = extraFlows(loan, principal, prepayments, opts);
  if (!f.toInvest.some(x => x > 0)) return null;
  const at = (r: number) => {
    const rm = Math.pow(1 + r, 1 / 12) - 1;
    const p = grow(f.toPrepayCase, () => rm, market.gainTax), i = grow(f.toInvest, () => rm, market.gainTax);
    return { p, i };
  };
  const det = at(market.yearlyReturn);

  // Break-even return by bisection on invest − prepay
  let breakEvenReturn: number | null = null;
  let lo = -0.5, hi = 1;
  const diff = (r: number) => { const x = at(r); return x.i - x.p; };
  if (diff(lo) * diff(hi) < 0) {
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (diff(lo) * diff(mid) <= 0) hi = mid; else lo = mid; }
    breakEvenReturn = (lo + hi) / 2;
  }

  // Monte Carlo: lognormal yearly returns, applied monthly within the year; same path for both cases
  const runs = market.runs ?? 1000;
  let probInvestWins: number | null = null, p10: number | null = null, p50: number | null = null, p90: number | null = null;
  if (runs > 0 && market.vol > 0) {
    const rng = mulberry32(market.seed ?? 7);
    const { mu, s } = lognormalParams(market.yearlyReturn, market.vol);
    const years = Math.ceil(f.horizon / 12);
    const diffs: number[] = [];
    let wins = 0;
    for (let k = 0; k < runs; k++) {
      const monthly = Array.from({ length: years }, () => Math.pow(Math.exp(mu + s * gaussian(rng)), 1 / 12) - 1);
      const r = (m: number) => monthly[Math.floor(m / 12)];
      const d = grow(f.toInvest, r, market.gainTax) - grow(f.toPrepayCase, r, market.gainTax);
      diffs.push(d);
      if (d > 0) wins++;
    }
    diffs.sort((x, y) => x - y);
    const q = (p: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.round(p * (diffs.length - 1))))];
    probInvestWins = wins / runs; p10 = q(0.1); p50 = q(0.5); p90 = q(0.9);
  }
  return {
    prepayWealth: det.p, investWealth: det.i, difference: det.i - det.p, breakEvenReturn, horizonMonths: f.horizon,
    probInvestWins, p10, p50, p90,
  };
}
