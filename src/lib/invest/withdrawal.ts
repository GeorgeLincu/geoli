// Retirement and withdrawal strategies (Phase 5). Pure and deterministic for a given seed, like montecarlo.ts,
// whose RNG, return model and percentiles it reuses (so the plan page and this page simulate markets the same way).
//
// Conventions (also explained on the page):
// - Everything is REAL (today's money, EUR). Inflation only matters for the Guyton-Klinger "no raise after a
//   losing year" rule, which in real terms is a cut by one year of inflation.
// - Each run accumulates exactly like the plan (contributions, `grow`), then every retirement year:
//   withdraw at the start of the year, then the rest earns that year's return.
// - The allocation can change with age (glidepath / bond tent): the yearly return is drawn for the weights of that age.
// - Other income (Pillar 2/3 payouts, state pension, anything else) is entered by George as a NET real yearly amount;
//   it adds to the income and, in "spending" mode, reduces what the portfolio must pay.
// - All strategies see the same simulated markets (common random numbers), so they can be compared fairly.
import type { AccountType, AssetClass, ClassAssumption, HistoryYear, TaxRuleSet } from './types';
import { contributionInYear, grow, normalizeWeights, portfolioStats, type PlanInputs, type Weights } from './projection';
import { mulberry32, gaussian, percentile, lognormalParams, historyYearReturn, MIN_RUNS, MAX_RUNS } from './montecarlo';
import { estimateWithdrawal } from './tax-ro';

export type StrategyKey = 'constant' | 'guardrails' | 'vpw' | 'floorCeiling';
export const STRATEGIES: readonly StrategyKey[] = ['constant', 'guardrails', 'vpw', 'floorCeiling'];

/**
 * Method parameters from the published rules, used until George sets his own (labelled "implicit" on the page):
 * - Guyton & Klinger (2006), "Decision Rules and Maximum Initial Withdrawal Rates": guardrails ±20% around the
 *   initial withdrawal rate, 10% cut/raise, no cuts in the last 15 years.
 * - Floor and ceiling: a simple band around the first withdrawal (placeholder, change it).
 */
export const WITHDRAWAL_DEFAULTS = {
  initial: 'spending' as const,
  strategy: 'constant' as const,
  gkGuard: 0.2,
  gkAdjust: 0.1,
  gkMinYearsLeft: 15,
  floor: 0.85,
  ceiling: 1.25,
};

// ─── Glidepath ───

export interface GlidePoint { age: number; weights: Weights }

/**
 * Allocation at `age`: linear interpolation between the two surrounding points, flat before the first and after
 * the last. No points → `fallback` (the current target allocation). Always normalized.
 */
export function weightsAtAge(points: readonly GlidePoint[] | undefined, age: number, fallback: Weights): Weights {
  const pts = (points ?? []).filter(p => Object.keys(normalizeWeights(p.weights)).length).slice().sort((a, b) => a.age - b.age);
  if (!pts.length) return normalizeWeights(fallback);
  if (age <= pts[0].age) return normalizeWeights(pts[0].weights);
  const last = pts[pts.length - 1];
  if (age >= last.age) return normalizeWeights(last.weights);
  const i = pts.findIndex(p => p.age > age);
  const a = pts[i - 1], b = pts[i];
  const t = (age - a.age) / (b.age - a.age);
  const wa = normalizeWeights(a.weights), wb = normalizeWeights(b.weights);
  const out: Weights = {};
  for (const c of new Set([...Object.keys(wa), ...Object.keys(wb)]) as Set<AssetClass>) {
    out[c] = (wa[c] ?? 0) * (1 - t) + (wb[c] ?? 0) * t;
  }
  return normalizeWeights(out);
}

// ─── Other income ───

export interface IncomeStream {
  /** Net yearly amount, today's money (EUR) */
  amount: number;
  startAge: number;
  /** Last age it is paid (inclusive). Missing = for life. */
  endAge?: number;
}

export const otherIncomeAt = (streams: readonly IncomeStream[] | undefined, age: number) =>
  (streams ?? []).reduce((s, x) => s + (age >= x.startAge && (x.endAge === undefined || age <= x.endAge) ? Math.max(0, x.amount) : 0), 0);

// ─── Strategy rules (one year each) ───

/** VPW: share of the balance to take when `yearsLeft` withdrawals remain (this one included), at real return `r`. */
export function vpwRate(r: number, yearsLeft: number): number {
  const n = Math.max(1, Math.round(yearsLeft));
  if (Math.abs(r) < 1e-9) return 1 / n;
  // annuity due: the first payment is taken now
  return r / ((1 + r) * (1 - Math.pow(1 + r, -n)));
}

export interface GkParams { guard: number; adjust: number; minYearsLeft: number }

/**
 * Guyton-Klinger for one year after the first, in real terms.
 * - Inflation rule: after a losing year, if the current rate is above the initial one, skip the inflation raise
 *   (= a real cut of one year of inflation).
 * - Capital preservation: rate above initial × (1 + guard) → cut by `adjust`, unless ≤ minYearsLeft years remain.
 * - Prosperity: rate below initial × (1 − guard) → raise by `adjust`.
 */
export function guytonKlingerStep(
  prev: number, balance: number, initialRate: number, lastReturn: number, inflation: number, yearsLeft: number, p: GkParams,
): number {
  let w = prev;
  if (balance <= 0) return w;
  if (lastReturn < 0 && w / balance > initialRate) w = w / (1 + inflation);
  const rate = w / balance;
  if (rate > initialRate * (1 + p.guard) && yearsLeft > p.minYearsLeft) w *= 1 - p.adjust;
  else if (rate < initialRate * (1 - p.guard)) w *= 1 + p.adjust;
  return w;
}

/** Floor and ceiling: the initial rate × balance, kept between floor × first and ceiling × first withdrawal. */
export const floorCeilingStep = (balance: number, initialRate: number, first: number, floor: number, ceiling: number) =>
  Math.min(first * ceiling, Math.max(first * floor, initialRate * balance));

// ─── Simulation ───

export interface StrategyParams {
  /** First withdrawal: spending need minus other income, or SWR × balance at retirement */
  initial: 'spending' | 'swr';
  gk: GkParams;
  floor: number;
  ceiling: number;
  /** VPW: fixed real return; missing = expected return of the allocation at that age */
  vpwReturn?: number;
}

export interface RetireInputs extends PlanInputs {
  mode: 'normal' | 'bootstrap';
  runs: number;
  seed: number;
  /** Per-class historical real returns (bootstrap mode) */
  history?: HistoryYear[];
  assumptions?: Partial<Record<AssetClass, ClassAssumption>>;
  correlation: number;
  /** Allocation without a glidepath (the current target) */
  baseWeights: Weights;
  glidepath?: GlidePoint[];
  incomes?: IncomeStream[];
  params: StrategyParams;
}

export interface Bands { p10: number[]; p50: number[]; p90: number[] }

export interface StrategyResult {
  key: StrategyKey;
  /** Balance at the start of each retirement year, plus the end (length = years + 1) */
  balance: Bands;
  /** Withdrawal from the portfolio per retirement year */
  withdrawal: Bands;
  /** Withdrawal + other income per retirement year */
  income: Bands;
  /** Share of runs where the portfolio could pay what the strategy asked until planToAge */
  successRate: number;
  /** Share of runs with at least one year where income < spending need */
  shortfallRate: number;
  medianBequest: number;
  p10Bequest: number;
  /** Median age at which failed runs ran out (null if none failed) */
  medianDepletionAge: number | null;
  /** Median over runs of the lowest yearly income */
  medianMinIncome: number;
  /** Median of the first withdrawal / balance at retirement */
  initialRate: number;
  /** Guyton-Klinger only: balance levels where the median withdrawal hits the lower (cut) / upper (raise) guardrail */
  guardrails?: { cut: number[]; raise: number[] };
}

export interface RetireResult {
  retirementAge: number;
  planToAge: number;
  /** Ages of the retirement years (start of year), length = years; balance arrays have one more (the end) */
  ages: number[];
  medianAtRetirement: number;
  p10AtRetirement: number;
  /** Need per retirement year (spending), for the income chart */
  need: number[];
  other: number[];
  strategies: Record<StrategyKey, StrategyResult>;
  runs: number;
  mode: 'normal' | 'bootstrap';
}

function bands(byYear: Float64Array, cols: number, runs: number): Bands {
  const out: Bands = { p10: [], p50: [], p90: [] };
  for (let y = 0; y < cols; y++) {
    const col = byYear.slice(y * runs, (y + 1) * runs).sort();
    out.p10.push(percentile(col, 0.1)); out.p50.push(percentile(col, 0.5)); out.p90.push(percentile(col, 0.9));
  }
  return out;
}

const sortedPct = (a: Float64Array | number[], p: number) => percentile(Float64Array.from(a).sort(), p);

export function runRetirement(inp: RetireInputs): RetireResult {
  const runs = Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.round(inp.runs)));
  const rng = mulberry32(inp.seed);
  const years = Math.max(1, Math.round(inp.planToAge - inp.age));
  const accYears = Math.min(years, Math.max(0, Math.round(inp.yearsToInvest)));
  const n = years - accYears;
  if (n < 1) throw new Error('No retirement years: planToAge must be after the retirement age');
  const retAge = inp.age + accYears;
  const hist = inp.history ?? [];
  if (inp.mode === 'bootstrap' && hist.length === 0) throw new Error('Bootstrap mode needs historical returns');

  // Allocation and return model for each simulated year (year y covers age + y − 1)
  const wYear: (readonly [AssetClass, number])[][] = [];
  const ln: { mu: number; s: number }[] = [];
  const expected: number[] = [];
  for (let y = 1; y <= years; y++) {
    const w = weightsAtAge(inp.glidepath, inp.age + y - 1, inp.baseWeights);
    const st = Object.keys(w).length ? portfolioStats(w, inp.assumptions, inp.correlation) : { ret: inp.realReturn, vol: inp.volatility };
    wYear.push(Object.entries(w) as [AssetClass, number][]);
    ln.push(lognormalParams(st.ret, st.vol));
    expected.push(st.ret);
  }
  const contributions = Array.from({ length: accYears + 1 }, (_, y) => (y === 0 ? 0 : contributionInYear(inp, y)));
  const ages = Array.from({ length: n }, (_, t) => retAge + t);
  const other = ages.map(a => otherIncomeAt(inp.incomes, a));
  const need = ages.map(() => Math.max(0, inp.spending));
  const p = inp.params;

  const S = STRATEGIES.length;
  const bal = STRATEGIES.map(() => new Float64Array((n + 1) * runs));
  const wd = STRATEGIES.map(() => new Float64Array(n * runs));
  const inc = STRATEGIES.map(() => new Float64Array(n * runs));
  const ok = STRATEGIES.map(() => new Uint8Array(runs));
  const short = STRATEGIES.map(() => new Uint8Array(runs));
  const minInc = STRATEGIES.map(() => new Float64Array(runs));
  const rate0 = STRATEGIES.map(() => new Float64Array(runs));
  const depl: number[][] = STRATEGIES.map(() => []);
  const atRet = new Float64Array(runs);
  const ret = new Float64Array(years);

  for (let k = 0; k < runs; k++) {
    for (let y = 0; y < years; y++) {
      ret[y] = inp.mode === 'bootstrap'
        ? historyYearReturn(hist[Math.floor(rng() * hist.length)], wYear[y], inp.assumptions)
        : Math.exp(ln[y].mu + ln[y].s * gaussian(rng)) - 1;
    }
    let b0 = inp.capital;
    for (let y = 1; y <= accYears; y++) b0 = Math.max(0, grow(b0, ret[y - 1], contributions[y]));
    atRet[k] = b0;
    const first = p.initial === 'swr' ? inp.swr * b0 : Math.max(0, inp.spending - other[0]);
    const iwr = b0 > 0 ? first / b0 : 0;

    for (let s = 0; s < S; s++) {
      const key = STRATEGIES[s];
      let b = b0, prev = first, alive = true, lowest = Infinity;
      rate0[s][k] = iwr;
      bal[s][k] = b;
      for (let t = 0; t < n; t++) {
        const r = ret[accYears + t];
        const left = n - t;
        let w: number;
        if (key === 'constant') w = p.initial === 'spending' ? Math.max(0, inp.spending - other[t]) : first;
        else if (key === 'guardrails') w = t === 0 ? first : guytonKlingerStep(prev, b, iwr, ret[accYears + t - 1], inp.inflation, left, p.gk);
        else if (key === 'vpw') w = b * vpwRate(p.vpwReturn ?? expected[accYears + t], left);
        else w = t === 0 ? first : floorCeilingStep(b, iwr, first, p.floor, p.ceiling);
        prev = w;
        if (alive && w > b + 1e-9) { alive = false; depl[s].push(ages[t]); }
        const paid = alive ? w : Math.min(w, b);
        b = Math.max(0, (b - paid) * (1 + r));
        const income = paid + other[t];
        wd[s][t * runs + k] = paid;
        inc[s][t * runs + k] = income;
        if (income < lowest) lowest = income;
        if (need[t] > 0 && income < need[t] - 1e-6) short[s][k] = 1;
        bal[s][(t + 1) * runs + k] = b;
      }
      ok[s][k] = alive ? 1 : 0;
      minInc[s][k] = lowest;
    }
  }

  const strategies = {} as Record<StrategyKey, StrategyResult>;
  STRATEGIES.forEach((key, s) => {
    const balance = bands(bal[s], n + 1, runs);
    const withdrawal = bands(wd[s], n, runs);
    const end = bal[s].slice(n * runs, (n + 1) * runs).sort();
    const d = depl[s].sort((a, b) => a - b);
    const r: StrategyResult = {
      key, balance, withdrawal, income: bands(inc[s], n, runs),
      successRate: ok[s].reduce((a, v) => a + v, 0) / runs,
      shortfallRate: short[s].reduce((a, v) => a + v, 0) / runs,
      medianBequest: percentile(end, 0.5), p10Bequest: percentile(end, 0.1),
      medianDepletionAge: d.length ? percentile(d, 0.5) : null,
      medianMinIncome: sortedPct(minInc[s], 0.5),
      initialRate: sortedPct(rate0[s], 0.5),
    };
    if (key === 'guardrails' && r.initialRate > 0) {
      const g = p.gk.guard;
      r.guardrails = {
        cut: withdrawal.p50.map(w => w / (r.initialRate * (1 + g))),
        raise: withdrawal.p50.map(w => w / (r.initialRate * Math.max(1e-9, 1 - g))),
      };
    }
    strategies[key] = r;
  });

  const sortedRet = atRet.slice().sort();
  return {
    retirementAge: retAge, planToAge: retAge + n, ages,
    medianAtRetirement: percentile(sortedRet, 0.5), p10AtRetirement: percentile(sortedRet, 0.1),
    need, other, strategies, runs, mode: inp.mode,
  };
}

// ─── Net income after Romanian tax ───

export interface NetOptions {
  /** Year whose rule set is used (the rules are not projected: today's thresholds, today's money) */
  year: number;
  /** RON per EUR */
  eurRon: number;
  /** Share of each withdrawal that is gain (1 − cost basis / value) */
  gainShare: number;
  accountType: AccountType;
}

export interface NetIncome {
  /** Tax on the portfolio withdrawal (income tax + CASS), EUR */
  tax: number;
  /** Withdrawal − tax + other (already net) income, EUR */
  net: number;
  effectiveRate: number | null;
}

/**
 * Net yearly income: the portfolio withdrawal goes through tax-ro `estimateWithdrawal` (sale of investments: income
 * tax on the gain part + CASS by tier); other income is entered net and added as is.
 */
export function netIncome(set: TaxRuleSet, withdrawalEur: number, otherNetEur: number, o: NetOptions): NetIncome {
  if (!(o.eurRon > 0) || withdrawalEur <= 0) return { tax: 0, net: Math.max(0, withdrawalEur) + otherNetEur, effectiveRate: withdrawalEur > 0 ? null : 0 };
  const e = estimateWithdrawal(set, { year: o.year, withdrawalRon: withdrawalEur * o.eurRon, gainShare: o.gainShare, accountType: o.accountType });
  const tax = e.totalTax / o.eurRon;
  return { tax, net: withdrawalEur - tax + otherNetEur, effectiveRate: tax / withdrawalEur };
}
