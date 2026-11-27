// Return maths for the yearly reports (Phase 7). Pure functions, no I/O.
//
// Conventions
//   - A "flow" is money George adds to (+) or takes out of (−) the portfolio, seen from the portfolio.
//   - XIRR is money-weighted: the yearly rate r that makes the net present value of
//     [−start value at the start, −each flow on its date, +end value at the end] zero (Actual/365).
//   - TWR is time-weighted: sub-period returns chained geometrically. Sub-periods are months and each month
//     uses Modified Dietz (flows weighted by the share of the month they were invested), so no daily
//     valuation is needed. This is the usual approximation (GIPS allows it); it is exact without flows.
//   - Real return = (1 + nominal) / (1 + inflation) − 1 (Fisher), inflation entered by George per year.

export interface DatedFlow { date: string; amount: number }

const DAY = 86_400_000;
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY);

/**
 * XIRR of investor cash flows (negative = paid in, positive = received), Actual/365.
 * Newton's method from `guess`, with a bisection fallback on [−0.9999, 100]. Null when there is no sign change
 * (no solution) or fewer than two flows.
 */
export function xirr(cashflows: readonly DatedFlow[], guess = 0.1): number | null {
  const cf = cashflows.filter(c => Number.isFinite(c.amount) && c.amount !== 0);
  if (cf.length < 2) return null;
  if (!cf.some(c => c.amount > 0) || !cf.some(c => c.amount < 0)) return null;
  const t0 = cf.reduce((m, c) => (c.date < m ? c.date : m), cf[0].date);
  const ts = cf.map(c => daysBetween(t0, c.date) / 365);
  const npv = (r: number) => cf.reduce((s, c, i) => s + c.amount / Math.pow(1 + r, ts[i]), 0);
  const dnpv = (r: number) => cf.reduce((s, c, i) => s - (ts[i] * c.amount) / Math.pow(1 + r, ts[i] + 1), 0);

  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(r), d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  // Bisection fallback
  let lo = -0.9999, hi = 100;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/**
 * Money-weighted return of a period: start value on `start`, flows (portfolio view: + in, − out),
 * end value on `end`. Returns the annualised XIRR and, for periods under a year, the period rate
 * ((1 + r)^(days/365) − 1), which is what a yearly report for a part year should show.
 */
export function periodXirr(start: string, startValue: number, flows: readonly DatedFlow[], end: string, endValue: number) {
  const cf: DatedFlow[] = [];
  if (startValue) cf.push({ date: start, amount: -startValue });
  for (const f of flows) if (f.date > start && f.date <= end) cf.push({ date: f.date, amount: -f.amount });
  // A flow on the start date counts as invested from the start
  for (const f of flows) if (f.date === start) cf.push({ date: start, amount: -f.amount });
  cf.push({ date: end, amount: endValue });
  const annual = xirr(cf);
  if (annual === null) return { annual: null, period: null };
  const days = daysBetween(start, end);
  return { annual, period: days >= 365 ? annual : Math.pow(1 + annual, days / 365) - 1 };
}

/**
 * Modified Dietz return for one sub-period: (V1 − V0 − F) / (V0 + Σ wᵢ·Fᵢ), wᵢ = share of the period left
 * after flow i (a flow on the start day counts fully, on the end day not at all). Null when the
 * denominator is not positive (nothing was invested).
 */
export function modifiedDietz(start: string, v0: number, flows: readonly DatedFlow[], end: string, v1: number): number | null {
  const total = daysBetween(start, end);
  if (total <= 0) return null;
  let f = 0, weighted = 0;
  for (const x of flows) {
    if (x.date < start || x.date > end) continue;
    const w = (total - daysBetween(start, x.date)) / total;
    f += x.amount;
    weighted += w * x.amount;
  }
  const denom = v0 + weighted;
  if (!(denom > 1e-9)) return null;
  return (v1 - v0 - f) / denom;
}

/** Chains sub-period returns: Π(1 + rᵢ) − 1. Missing sub-periods (null) are skipped (counted in `skipped`). */
export function chainReturns(returns: readonly (number | null)[]): { value: number | null; skipped: number } {
  let g = 1, used = 0, skipped = 0;
  for (const r of returns) {
    if (r === null || !Number.isFinite(r)) { skipped++; continue; }
    g *= 1 + r; used++;
  }
  return { value: used ? g - 1 : null, skipped };
}

/** A valuation on a date (portfolio value in one currency). */
export interface ValuePoint { date: string; value: number }

/**
 * Time-weighted return over consecutive valuation points (e.g. month-ends), Modified Dietz inside each
 * sub-period. `flows` are portfolio-view flows (+ in, − out). Returns the chained TWR and each sub-period return.
 */
export function twr(points: readonly ValuePoint[], flows: readonly DatedFlow[]) {
  const subs: { from: string; to: string; r: number | null }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    // Flows strictly after the previous point and up to this one (a flow on `a.date` was already in a's value)
    const inside = flows.filter(f => f.date > a.date && f.date <= b.date);
    subs.push({ from: a.date, to: b.date, r: modifiedDietz(a.date, a.value, inside, b.date, b.value) });
  }
  const { value, skipped } = chainReturns(subs.map(s => s.r));
  return { value, skipped, subs };
}

/** Fisher: real = (1 + nominal) / (1 + inflation) − 1. */
export const realReturn = (nominal: number | null, inflation: number | null | undefined) =>
  nominal === null || inflation === null || inflation === undefined || inflation <= -1 ? null : (1 + nominal) / (1 + inflation) - 1;

/** Annualises a cumulative return over `days`. */
export const annualise = (cumulative: number, days: number) => (days > 0 ? Math.pow(1 + cumulative, 365 / days) - 1 : null);

/**
 * Drawdown of a value series that already excludes flows: give it a wealth index (e.g. chained TWR
 * starting at 1). Returns the drop below the running peak for every point (0 … 1) and the deepest one.
 */
export function drawdownSeries(index: readonly ValuePoint[]) {
  let peak = -Infinity, max = 0, maxDate: string | null = null;
  const points = index.map(p => {
    peak = Math.max(peak, p.value);
    const dd = peak > 0 ? Math.max(0, 1 - p.value / peak) : 0;
    if (dd > max) { max = dd; maxDate = p.date; }
    return { date: p.date, dd };
  });
  return { points, max, maxDate };
}

/** Wealth index (starts at 1) from sub-period returns; null sub-periods keep the index flat. */
export function wealthIndex(start: string, subs: readonly { to: string; r: number | null }[]): ValuePoint[] {
  let v = 1;
  const out: ValuePoint[] = [{ date: start, value: 1 }];
  for (const s of subs) { if (s.r !== null) v *= 1 + s.r; out.push({ date: s.to, value: v }); }
  return out;
}
