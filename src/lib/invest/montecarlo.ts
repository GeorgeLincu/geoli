// Monte Carlo simulation of the plan (Phase 1). Pure and deterministic for a given seed,
// so it runs the same in a Web Worker, in tests and on every device.
//
// Each run: accumulate for `yearsToInvest` years (same contribution rule as projection.ts), then withdraw
// `spending` (real) at the start of every retirement year until `planToAge`. A run succeeds if the money
// lasts until then. All amounts are real (today's money).
//
// Return models:
// - normal: yearly real return is lognormal with median = the expected compound return and standard
//   deviation ≈ the volatility (so the median path matches the deterministic projection).
// - bootstrap: each year draws one whole historical year (keeps cross-asset correlation), portfolio
//   return = weighted sum of the classes' returns that year.
import type { AssetClass, ClassAssumption, HistoryYear } from './types';
import { contributionInYear, grow, assumptionFor, normalizeWeights, type PlanInputs, type Weights } from './projection';

/** Small, fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller). */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Linear-interpolated percentile of a sorted array, p in [0, 1]. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Lognormal parameters so the MEDIAN yearly return is `ret` and the standard deviation ≈ `vol`.
 * Draw: exp(mu + s × z) − 1, z standard normal. Shared by the plan and the retirement simulations.
 */
export function lognormalParams(ret: number, vol: number): { mu: number; s: number } {
  const sd = Math.max(0, vol);
  return { mu: Math.log(1 + ret), s: Math.sqrt(Math.log(1 + (sd * sd) / ((1 + ret) * (1 + ret)))) };
}

/** Portfolio real return of one historical year for normalized weights (missing classes use their expected return). */
export function historyYearReturn(
  h: HistoryYear, w: readonly (readonly [AssetClass, number])[], assumptions?: Partial<Record<AssetClass, ClassAssumption>>,
): number {
  return w.reduce((s, [c, wi]) => s + wi * (h.returns[c] ?? assumptionFor(c, assumptions).ret), 0);
}

/**
 * Portfolio real return for each historical year. Classes with no value in a year use their expected
 * return; years where none of the weighted classes has data are skipped.
 */
export function portfolioHistory(
  history: HistoryYear[], weights: Weights, assumptions?: Partial<Record<AssetClass, ClassAssumption>>,
): number[] {
  const w = Object.entries(normalizeWeights(weights)) as [AssetClass, number][];
  const out: number[] = [];
  for (const h of history) {
    if (!w.some(([c]) => typeof h.returns[c] === 'number')) continue;
    out.push(historyYearReturn(h, w, assumptions));
  }
  return out;
}

export interface McInputs extends PlanInputs {
  mode: 'normal' | 'bootstrap';
  runs: number;
  seed: number;
  /** Portfolio real returns per historical year (bootstrap mode) */
  history?: number[];
  /** Years at the start of retirement used for the sequence-of-returns view */
  sequenceYears?: number;
}

export interface SequenceBucket {
  /** Average real return over the first retirement years, range of this bucket */
  from: number;
  to: number;
  successRate: number;
  runs: number;
}

export interface McResult {
  ages: number[];
  p10: number[];
  p50: number[];
  p90: number[];
  /** Share of runs where the money lasted until planToAge (1 if there is no retirement phase) */
  successRate: number;
  retirementAge: number;
  medianAtRetirement: number;
  p10AtRetirement: number;
  medianAtEnd: number;
  p10AtEnd: number;
  /** Median age at which failed runs ran out of money (null if none failed) */
  medianDepletionAge: number | null;
  /** Success rate by quintile of the average return in the first retirement years */
  sequence: SequenceBucket[];
  runs: number;
  mode: 'normal' | 'bootstrap';
}

export const MIN_RUNS = 2000;
export const MAX_RUNS = 20000;

export function runMonteCarlo(inp: McInputs): McResult {
  const runs = Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.round(inp.runs)));
  const rng = mulberry32(inp.seed);
  const years = Math.max(1, Math.round(inp.planToAge - inp.age));
  const accYears = Math.min(years, Math.max(0, Math.round(inp.yearsToInvest)));
  const seqYears = Math.max(1, Math.min(inp.sequenceYears ?? 5, years - accYears));
  const hist = inp.history ?? [];
  if (inp.mode === 'bootstrap' && hist.length === 0) throw new Error('Bootstrap mode needs historical returns');

  // lognormal parameters for the normal mode
  const { mu, s } = lognormalParams(inp.realReturn, inp.volatility);
  const draw = inp.mode === 'bootstrap'
    ? () => hist[Math.floor(rng() * hist.length)]
    : () => Math.exp(mu + s * gaussian(rng)) - 1;

  const contributions = Array.from({ length: accYears + 1 }, (_, y) => (y === 0 ? 0 : contributionInYear(inp, y)));
  // byYear[y * runs + k] = balance of run k after year y
  const byYear = new Float64Array((years + 1) * runs);
  const atRetirement = new Float64Array(runs);
  const seqReturn = new Float64Array(runs);
  const ok = new Uint8Array(runs);
  const depletion: number[] = [];

  for (let k = 0; k < runs; k++) {
    let bal = inp.capital, alive = true, seqSum = 0;
    byYear[k] = bal;
    for (let y = 1; y <= years; y++) {
      const r = draw();
      if (y <= accYears) {
        bal = grow(bal, r, contributions[y]);
      } else if (alive) {
        if (y - accYears <= seqYears) seqSum += r;
        if (bal < inp.spending) { alive = false; bal = 0; depletion.push(inp.age + y - 1); }
        else bal = (bal - inp.spending) * (1 + r);
      }
      if (bal < 0) bal = 0;
      byYear[y * runs + k] = bal;
    }
    atRetirement[k] = byYear[accYears * runs + k];
    seqReturn[k] = seqSum / seqYears;
    ok[k] = alive ? 1 : 0;
  }

  const ages: number[] = [], p10: number[] = [], p50: number[] = [], p90: number[] = [];
  for (let y = 0; y <= years; y++) {
    const col = byYear.slice(y * runs, (y + 1) * runs).sort();
    ages.push(inp.age + y);
    p10.push(percentile(col, 0.1)); p50.push(percentile(col, 0.5)); p90.push(percentile(col, 0.9));
  }
  const sortedRet = atRetirement.slice().sort();
  const success = ok.reduce((s2, v) => s2 + v, 0) / runs;

  // sequence-of-returns: quintiles of the early-retirement average return
  const hasRetirement = years > accYears;
  const sequence: SequenceBucket[] = [];
  if (hasRetirement) {
    const order = Array.from({ length: runs }, (_, i) => i).sort((a, b) => seqReturn[a] - seqReturn[b]);
    for (let q = 0; q < 5; q++) {
      const slice = order.slice(Math.floor((q * runs) / 5), Math.floor(((q + 1) * runs) / 5));
      sequence.push({
        from: seqReturn[slice[0]], to: seqReturn[slice[slice.length - 1]],
        successRate: slice.reduce((s2, i) => s2 + ok[i], 0) / slice.length, runs: slice.length,
      });
    }
  }
  depletion.sort((a, b) => a - b);

  return {
    ages, p10, p50, p90,
    successRate: hasRetirement ? success : 1,
    retirementAge: inp.age + accYears,
    medianAtRetirement: percentile(sortedRet, 0.5),
    p10AtRetirement: percentile(sortedRet, 0.1),
    medianAtEnd: p50[p50.length - 1],
    p10AtEnd: p10[p10.length - 1],
    medianDepletionAge: depletion.length ? percentile(depletion, 0.5) : null,
    sequence, runs, mode: inp.mode,
  };
}

// ─── Historical returns from pasted CSV ───

const CLASS_ALIASES: Record<string, AssetClass> = {
  equity: 'equity', actiuni: 'equity', stocks: 'equity',
  bond: 'bond', obligatiuni: 'bond', bonds: 'bond',
  gov_bond: 'gov_bond', 'titluri de stat': 'gov_bond', titluri: 'gov_bond',
  gold: 'gold', aur: 'gold',
  cash: 'cash', numerar: 'cash',
  real_estate: 'real_estate', imobiliare: 'real_estate',
  pension: 'pension', pensii: 'pension',
  other: 'other', altele: 'other',
};
const INFLATION_ALIASES = ['inflatie', 'inflation', 'cpi'];

const normHeader = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s*\(%\)\s*$/, '');

/**
 * Parses pasted yearly returns in PERCENT. First column = year, a header row names the classes
 * (Romanian or English). Separators: tab, semicolon or comma (with ; or tab, "12,5" is read as 12.5).
 * If an inflation column is present, the other columns are nominal and are converted to real:
 * real = (1 + nominal) / (1 + inflation) − 1.
 */
export function parseHistoryCsv(text: string): { years: HistoryYear[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errors: string[] = [];
  if (lines.length < 2) return { years: [], errors: ['Lipsește antetul sau datele.'] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map(normHeader);
  const cols = header.slice(1).map(h => (INFLATION_ALIASES.includes(h) ? 'inflation' : CLASS_ALIASES[h] ?? null));
  header.slice(1).forEach((h, i) => { if (!cols[i]) errors.push(`Coloană necunoscută: „${h}”.`); });
  const infIdx = cols.indexOf('inflation');
  const toNum = (s: string) => {
    const t = s.trim().replace('%', '');
    if (t === '') return null;
    const n = Number(sep === ',' ? t : t.replace(',', '.'));
    return Number.isFinite(n) ? n / 100 : NaN;
  };
  const years: HistoryYear[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep);
    const year = Number(cells[0]);
    if (!Number.isInteger(year) || year < 1800 || year > 2200) { errors.push(`Rând ignorat (an invalid): „${line.slice(0, 40)}”.`); continue; }
    const inf = infIdx >= 0 ? toNum(cells[infIdx + 1] ?? '') : 0;
    if (inf === null || Number.isNaN(inf)) { errors.push(`${year}: inflație lipsă sau invalidă.`); continue; }
    const returns: Partial<Record<AssetClass, number>> = {};
    cols.forEach((c, i) => {
      if (!c || c === 'inflation') return;
      const v = toNum(cells[i + 1] ?? '');
      if (v === null) return;
      if (Number.isNaN(v) || v <= -1) { errors.push(`${year}: valoare invalidă în coloana „${header[i + 1]}”.`); return; }
      returns[c] = (1 + v) / (1 + inf) - 1;
    });
    if (Object.keys(returns).length) years.push({ year, returns });
  }
  return { years, errors: errors.slice(0, 20) };
}
