import { describe, it, expect } from 'vitest';
import { mulberry32, gaussian, percentile, portfolioHistory, runMonteCarlo, parseHistoryCsv, MIN_RUNS, type McInputs } from './montecarlo';
import { project } from './projection';

// Round illustrative numbers for the tests only (not anyone's real plan).
const base: McInputs = {
  age: 40, capital: 100_000, monthlyContribution: 1_000, contributionGrowth: 0, yearsToInvest: 15,
  spending: 30_000, swr: 0.04, inflation: 0.03, realReturn: 0.04, volatility: 0.12, planToAge: 90,
  mode: 'normal', runs: 2000, seed: 42,
};

describe('rng', () => {
  it('is reproducible and in [0,1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('gaussian has mean ≈ 0 and sd ≈ 1', () => {
    const rng = mulberry32(1);
    const xs = Array.from({ length: 50_000 }, () => gaussian(rng));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(sd - 1)).toBeLessThan(0.02);
  });
});

describe('percentile', () => {
  it('interpolates', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.1)).toBeCloseTo(1);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('portfolioHistory', () => {
  it('weights the classes and fills gaps with the expected return', () => {
    const h = portfolioHistory(
      [{ year: 2000, returns: { equity: 0.1, bond: 0.02 } }, { year: 2001, returns: { equity: -0.2 } }, { year: 2002, returns: { gold: 0.3 } }],
      { equity: 0.5, bond: 0.5 },
      { bond: { ret: 0.01, vol: 0.05 } },
    );
    expect(h).toHaveLength(2);
    expect(h[0]).toBeCloseTo(0.06);
    expect(h[1]).toBeCloseTo(-0.095);
  });
});

describe('runMonteCarlo', () => {
  it('is deterministic for a seed', () => {
    const a = runMonteCarlo(base), b = runMonteCarlo(base);
    expect(a.successRate).toBe(b.successRate);
    expect(a.p50).toEqual(b.p50);
    expect(runMonteCarlo({ ...base, seed: 43 }).p50).not.toEqual(a.p50);
  });

  it('enforces at least MIN_RUNS', () => {
    expect(runMonteCarlo({ ...base, runs: 10 }).runs).toBe(MIN_RUNS);
  });

  it('with zero volatility equals the deterministic projection', () => {
    const r = runMonteCarlo({ ...base, volatility: 0 });
    const det = project(base);
    expect(r.p50[15]).toBeCloseTo(det[15].balance, 4);
    expect(r.p10[15]).toBeCloseTo(det[15].balance, 4);
    expect(r.medianAtRetirement).toBeCloseTo(det[15].balance, 4);
  });

  it('keeps the median close to the deterministic path', () => {
    const r = runMonteCarlo({ ...base, runs: 8000 });
    const det = project(base)[15].balance;
    expect(Math.abs(r.medianAtRetirement / det - 1)).toBeLessThan(0.03);
    expect(r.p10[15]).toBeLessThan(r.p50[15]);
    expect(r.p50[15]).toBeLessThan(r.p90[15]);
  });

  it('succeeds always with huge capital and fails always with none', () => {
    expect(runMonteCarlo({ ...base, capital: 50_000_000 }).successRate).toBe(1);
    const broke = runMonteCarlo({ ...base, capital: 0, monthlyContribution: 0, volatility: 0 });
    expect(broke.successRate).toBe(0);
    expect(broke.medianDepletionAge).toBe(55);
  });

  it('runs out exactly when deterministic withdrawals exhaust the money', () => {
    // 0% return, no volatility: 300,000 at 55, 30,000/yr → lasts 10 years, then fails at 65
    const r = runMonteCarlo({ ...base, capital: 300_000, monthlyContribution: 0, realReturn: 0, volatility: 0 });
    expect(r.successRate).toBe(0);
    expect(r.medianDepletionAge).toBe(65);
    expect(runMonteCarlo({ ...base, capital: 300_000, monthlyContribution: 0, realReturn: 0, volatility: 0, planToAge: 65 }).successRate).toBe(1);
  });

  it('shows that bad early-retirement returns hurt more (sequence risk)', () => {
    const r = runMonteCarlo({ ...base, capital: 400_000, runs: 5000, volatility: 0.15 });
    expect(r.sequence).toHaveLength(5);
    expect(r.sequence[0].successRate).toBeLessThan(r.sequence[4].successRate);
    expect(r.sequence[0].from).toBeLessThanOrEqual(r.sequence[4].from);
  });

  it('bootstraps from history and needs it', () => {
    expect(() => runMonteCarlo({ ...base, mode: 'bootstrap' })).toThrow();
    const r = runMonteCarlo({ ...base, mode: 'bootstrap', history: [0.04] });
    expect(r.p50[15]).toBeCloseTo(project(base)[15].balance, 4);
    const mixed = runMonteCarlo({ ...base, mode: 'bootstrap', history: [-0.3, 0.1, 0.2, 0.05, -0.1] });
    expect(mixed.p10[15]).toBeLessThan(mixed.p90[15]);
  });

  it('has no retirement phase when the horizon ends at retirement', () => {
    const r = runMonteCarlo({ ...base, planToAge: 55 });
    expect(r.successRate).toBe(1);
    expect(r.sequence).toEqual([]);
  });
});

describe('parseHistoryCsv', () => {
  it('reads Romanian headers, semicolons and decimal commas', () => {
    const r = parseHistoryCsv('An;Acțiuni;Obligațiuni\n2000;-10,5;4\n2001;20;');
    expect(r.errors).toEqual([]);
    expect(r.years).toHaveLength(2);
    expect(r.years[0].returns.equity).toBeCloseTo(-0.105);
    expect(r.years[0].returns.bond).toBeCloseTo(0.04);
    expect(Object.keys(r.years[1].returns)).toEqual(['equity']);
    expect(r.years[1].returns.equity).toBeCloseTo(0.2);
  });

  it('converts nominal to real when an inflation column exists', () => {
    const r = parseHistoryCsv('year,stocks,inflation\n1990,10,5');
    expect(r.years[0].returns.equity).toBeCloseTo(1.1 / 1.05 - 1);
  });

  it('reports unknown columns and bad rows', () => {
    const r = parseHistoryCsv('an\tcrypto\tactiuni\nabc\t1\t2\n2000\t1\t-150');
    expect(r.errors.some(e => e.includes('crypto'))).toBe(true);
    expect(r.errors.some(e => e.includes('abc'))).toBe(true);
    expect(r.errors.some(e => e.includes('2000'))).toBe(true);
    expect(r.years).toEqual([]);
  });
});
