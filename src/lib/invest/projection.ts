// Deterministic FIRE projection (Phase 1). Pure functions, no DOM.
//
// Conventions (documented on the page too):
// - Everything is in REAL terms (today's money); nominal = real × (1 + inflation)^years.
// - The expected return is a compound (median) yearly real return.
// - Contributions are monthly, so on average they earn half a year of return in the year they are paid:
//     balance(t+1) = balance(t) × (1 + r) + contribution(t) × (1 + r/2)
// - The contribution changes by `contributionGrowth` (real) each year: year 1 = 12 × monthly.
import type { AssetClass, ClassAssumption, Settings, TargetAllocation } from './types';

export const ASSET_CLASSES: readonly AssetClass[] = ['equity', 'bond', 'gov_bond', 'gold', 'cash', 'real_estate', 'pension', 'other'];

/**
 * Neutral placeholder assumptions so the page works before George sets his own.
 * Shown on the page as "implicit — ipoteză, modific-o". They are NOT forecasts.
 */
export const DEFAULT_ASSUMPTIONS: Record<AssetClass, ClassAssumption> = {
  equity: { ret: 0.05, vol: 0.16 },
  bond: { ret: 0.015, vol: 0.06 },
  gov_bond: { ret: 0.02, vol: 0.03 },
  gold: { ret: 0.01, vol: 0.15 },
  cash: { ret: 0, vol: 0.01 },
  real_estate: { ret: 0.03, vol: 0.12 },
  pension: { ret: 0.03, vol: 0.08 },
  other: { ret: 0.02, vol: 0.10 },
};

/** Placeholder values for the general assumptions (labelled as such in the UI). */
export const DEFAULTS = {
  contributionGrowth: 0,
  swr: 0.04,
  inflation: 0.03,
  planToAge: 90,
  correlation: 0.3,
  mcRuns: 5000,
  mcSeed: 1,
} as const;

export interface PlanInputs {
  age: number;
  capital: number;
  monthlyContribution: number;
  /** Real yearly change of the contribution, decimal */
  contributionGrowth: number;
  yearsToInvest: number;
  /** Yearly spending in retirement, today's money */
  spending: number;
  swr: number;
  inflation: number;
  /** Portfolio expected real compound return */
  realReturn: number;
  /** Portfolio yearly volatility (used by Monte Carlo only) */
  volatility: number;
  planToAge: number;
}

// ─── Portfolio from weights ───

export type Weights = Partial<Record<AssetClass, number>>;

/** Sum target-allocation rows per asset class. */
export function weightsFromTargets(targets: TargetAllocation[]): Weights {
  const w: Weights = {};
  for (const t of targets) w[t.assetClass] = (w[t.assetClass] ?? 0) + t.weight;
  return w;
}

/** Weights scaled to sum to 1 (zero/negative entries dropped). Empty if nothing positive. */
export function normalizeWeights(w: Weights): Weights {
  const entries = Object.entries(w).filter(([, v]) => typeof v === 'number' && v > 0) as [AssetClass, number][];
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (sum <= 0) return {};
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum])) as Weights;
}

export function assumptionFor(cls: AssetClass, custom?: Partial<Record<AssetClass, ClassAssumption>>): ClassAssumption {
  return custom?.[cls] ?? DEFAULT_ASSUMPTIONS[cls];
}

/**
 * Portfolio expected return (weighted average) and volatility with one average correlation between classes:
 *   σp² = Σi Σj wi wj ρij σi σj,  ρii = 1, ρij = correlation.
 */
export function portfolioStats(
  weights: Weights,
  assumptions?: Partial<Record<AssetClass, ClassAssumption>>,
  correlation: number = DEFAULTS.correlation,
): { ret: number; vol: number } {
  const w = Object.entries(normalizeWeights(weights)) as [AssetClass, number][];
  let ret = 0, variance = 0;
  for (const [ci, wi] of w) {
    const ai = assumptionFor(ci, assumptions);
    ret += wi * ai.ret;
    for (const [cj, wj] of w) {
      const aj = assumptionFor(cj, assumptions);
      variance += wi * wj * (ci === cj ? 1 : correlation) * ai.vol * aj.vol;
    }
  }
  return { ret, vol: Math.sqrt(Math.max(0, variance)) };
}

// ─── Settings → inputs ───

/** Keys of the personal inputs George must fill in (no defaults for these). */
export type RequiredKey = 'age' | 'capital' | 'monthlyContribution' | 'yearsToInvest' | 'spending' | 'weights';

/**
 * Builds the calculation inputs from the saved settings. Personal values have no defaults:
 * `missing` lists what still has to be filled in; `inputs` is null until then.
 */
export function inputsFromSettings(
  s: Settings,
  targets: TargetAllocation[],
  currentYear: number,
  ledgerCapital?: number | null,
): { inputs: PlanInputs | null; missing: RequiredKey[]; weights: Weights; weightsFrom: 'targets' | 'plan' } {
  const p = s.projection ?? {};
  const fromTargets = targets.length > 0;
  const weights = normalizeWeights(fromTargets ? weightsFromTargets(targets) : (p.weights ?? {}));
  const capital = ledgerCapital ?? s.manualCapital;
  const missing: RequiredKey[] = [];
  if (s.birthYear === undefined) missing.push('age');
  if (capital === undefined) missing.push('capital');
  if (s.monthlyContribution === undefined) missing.push('monthlyContribution');
  if (s.yearsToInvest === undefined) missing.push('yearsToInvest');
  if (s.retirementSpending === undefined) missing.push('spending');
  if (Object.keys(weights).length === 0) missing.push('weights');
  const weightsFrom = fromTargets ? 'targets' : 'plan';
  if (missing.length) return { inputs: null, missing, weights, weightsFrom };

  const stats = portfolioStats(weights, p.assumptions, p.correlation ?? DEFAULTS.correlation);
  const age = currentYear - (s.birthYear as number);
  return {
    inputs: {
      age,
      capital: capital as number,
      monthlyContribution: s.monthlyContribution as number,
      contributionGrowth: s.contributionGrowth ?? DEFAULTS.contributionGrowth,
      yearsToInvest: s.yearsToInvest as number,
      spending: s.retirementSpending as number,
      swr: s.swr ?? DEFAULTS.swr,
      inflation: s.inflation ?? DEFAULTS.inflation,
      realReturn: stats.ret,
      volatility: stats.vol,
      planToAge: Math.max(p.planToAge ?? DEFAULTS.planToAge, age + (s.yearsToInvest as number) + 1),
    },
    missing, weights, weightsFrom,
  };
}

// ─── Deterministic projection ───

export const fiNumber = (spending: number, swr: number) => (swr > 0 ? spending / swr : Infinity);

/** Contribution paid during year `y` (1-based). */
export const contributionInYear = (inp: Pick<PlanInputs, 'monthlyContribution' | 'contributionGrowth'>, y: number) =>
  Math.max(0, inp.monthlyContribution * 12 * Math.pow(1 + inp.contributionGrowth, y - 1));

/** One year of accumulation (also used by Monte Carlo with a random return). */
export const grow = (balance: number, r: number, contribution: number) =>
  balance * (1 + r) + contribution * (1 + r / 2);

export interface ProjectionRow {
  /** Years from now */
  year: number;
  age: number;
  /** Portfolio value, real */
  balance: number;
  /** Starting capital + all contributions so far, real */
  contributed: number;
  /** balance − contributed */
  growth: number;
  /** Portfolio value in the money of that year */
  nominal: number;
}

/** Year-by-year projection from now (year 0) to `years` (default: yearsToInvest). */
export function project(inp: PlanInputs, years = inp.yearsToInvest): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  let balance = inp.capital, contributed = inp.capital;
  for (let y = 0; y <= years; y++) {
    if (y > 0) {
      const c = contributionInYear(inp, y);
      balance = grow(balance, inp.realReturn, c);
      contributed += c;
    }
    rows.push({
      year: y, age: inp.age + y, balance, contributed, growth: balance - contributed,
      nominal: balance * Math.pow(1 + inp.inflation, y),
    });
  }
  return rows;
}

/**
 * Years until the portfolio reaches the FI number if contributions continue, linearly interpolated
 * inside the crossing year. 0 if already there; null if not reached within `maxYears`.
 */
export function yearsToFI(inp: PlanInputs, maxYears = 100): number | null {
  const target = fiNumber(inp.spending, inp.swr);
  if (inp.capital >= target) return 0;
  let prev = inp.capital;
  for (let y = 1; y <= maxYears; y++) {
    const next = grow(prev, inp.realReturn, contributionInYear(inp, y));
    if (next >= target) return y - 1 + (target - prev) / (next - prev);
    prev = next;
  }
  return null;
}

/**
 * Coast FI: the amount that, with no further contributions, grows to the FI number by the end of
 * `yearsToInvest`; and the first age at which the projected balance reaches that point (null if never).
 */
export function coastFI(inp: PlanInputs): { number: number; age: number | null; reachedNow: boolean } {
  const target = fiNumber(inp.spending, inp.swr);
  const g = 1 + inp.realReturn;
  const needed = (y: number) => target / Math.pow(g, inp.yearsToInvest - y);
  const rows = project(inp);
  const hit = rows.find(r => r.balance >= needed(r.year));
  return { number: needed(0), age: hit ? hit.age : null, reachedNow: inp.capital >= needed(0) };
}

export interface PlanSummary {
  fiNumber: number;
  retirementAge: number;
  balanceAtRetirement: number;
  nominalAtRetirement: number;
  /** Safe yearly income from the retirement balance at the SWR, real */
  incomeAtSwr: number;
  /** balanceAtRetirement / fiNumber */
  ratio: number;
  totalContributed: number;
  yearsToFI: number | null;
  fiAge: number | null;
  coast: ReturnType<typeof coastFI>;
}

export function summarize(inp: PlanInputs): PlanSummary {
  const rows = project(inp);
  const last = rows[rows.length - 1];
  const fi = fiNumber(inp.spending, inp.swr);
  const ytf = yearsToFI(inp);
  return {
    fiNumber: fi,
    retirementAge: inp.age + inp.yearsToInvest,
    balanceAtRetirement: last.balance,
    nominalAtRetirement: last.nominal,
    incomeAtSwr: last.balance * inp.swr,
    ratio: fi > 0 ? last.balance / fi : 0,
    totalContributed: last.contributed,
    yearsToFI: ytf,
    fiAge: ytf === null ? null : inp.age + ytf,
    coast: coastFI(inp),
  };
}

// ─── Sensitivity (tornado) ───

export type SensitivityKey = 'capital' | 'monthlyContribution' | 'contributionGrowth' | 'realReturn' | 'spending' | 'swr';

export interface SensitivityBar {
  key: SensitivityKey;
  lowInput: number;
  highInput: number;
  /** FI age when the input is at its low / high value (null = not reached in 100 years) */
  lowAge: number | null;
  highAge: number | null;
  /** |highAge − lowAge|, unreached counted as base + 100 */
  spread: number;
}

/** How each input is moved: relative (×(1±d)) or absolute (±d). */
export const SENSITIVITY_STEPS: Record<SensitivityKey, { kind: 'rel' | 'abs'; d: number }> = {
  capital: { kind: 'rel', d: 0.2 },
  monthlyContribution: { kind: 'rel', d: 0.2 },
  contributionGrowth: { kind: 'abs', d: 0.01 },
  realReturn: { kind: 'abs', d: 0.01 },
  spending: { kind: 'rel', d: 0.1 },
  swr: { kind: 'abs', d: 0.005 },
};

/** FI age for each input at low/high, sorted by impact (largest first). */
export function sensitivity(inp: PlanInputs): { baseAge: number | null; bars: SensitivityBar[] } {
  const fiAge = (x: PlanInputs) => { const y = yearsToFI(x); return y === null ? null : x.age + y; };
  const baseAge = fiAge(inp);
  const bars = (Object.keys(SENSITIVITY_STEPS) as SensitivityKey[]).map(key => {
    const { kind, d } = SENSITIVITY_STEPS[key];
    const v = inp[key];
    const lowInput = kind === 'rel' ? v * (1 - d) : v - d;
    const highInput = kind === 'rel' ? v * (1 + d) : v + d;
    const lowAge = fiAge({ ...inp, [key]: Math.max(key === 'swr' ? 0.001 : -Infinity, lowInput) });
    const highAge = fiAge({ ...inp, [key]: highInput });
    const far = (baseAge ?? inp.age) + 100;
    return { key, lowInput, highInput, lowAge, highAge, spread: Math.abs((highAge ?? far) - (lowAge ?? far)) };
  });
  bars.sort((a, b) => b.spread - a.spread);
  return { baseAge, bars };
}
