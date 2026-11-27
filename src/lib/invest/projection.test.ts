import { describe, it, expect } from 'vitest';
import {
  project, yearsToFI, coastFI, summarize, sensitivity, fiNumber, portfolioStats, normalizeWeights,
  weightsFromTargets, inputsFromSettings, contributionInYear, DEFAULTS, type PlanInputs,
} from './projection';

// Round illustrative numbers for the tests only (not anyone's real plan).
const base: PlanInputs = {
  age: 30, capital: 10_000, monthlyContribution: 500, contributionGrowth: 0, yearsToInvest: 20,
  spending: 24_000, swr: 0.04, inflation: 0.03, realReturn: 0.05, volatility: 0.15, planToAge: 90,
};

describe('fiNumber', () => {
  it('is spending / SWR', () => {
    expect(fiNumber(40_000, 0.04)).toBe(1_000_000);
    expect(fiNumber(40_000, 0)).toBe(Infinity);
  });
});

describe('project', () => {
  it('with 0% return and no growth is capital + contributions', () => {
    const rows = project({ ...base, realReturn: 0 });
    expect(rows).toHaveLength(21);
    expect(rows[0]).toMatchObject({ year: 0, age: 30, balance: 10_000, contributed: 10_000, growth: 0 });
    expect(rows[20].balance).toBeCloseTo(10_000 + 20 * 6_000, 6);
    expect(rows[20].growth).toBeCloseTo(0, 6);
  });

  it('compounds capital and gives contributions half a year of return', () => {
    const rows = project({ ...base, yearsToInvest: 1 });
    expect(rows[1].balance).toBeCloseTo(10_000 * 1.05 + 6_000 * 1.025, 6);
  });

  it('matches the closed form for capital only', () => {
    const rows = project({ ...base, monthlyContribution: 0 });
    expect(rows[20].balance).toBeCloseTo(10_000 * Math.pow(1.05, 20), 6);
  });

  it('shows nominal values with inflation', () => {
    const rows = project(base);
    expect(rows[10].nominal).toBeCloseTo(rows[10].balance * Math.pow(1.03, 10), 6);
  });

  it('grows the contribution by the real change per year', () => {
    const inp = { ...base, contributionGrowth: 0.1 };
    expect(contributionInYear(inp, 1)).toBeCloseTo(6_000);
    expect(contributionInYear(inp, 3)).toBeCloseTo(6_000 * 1.21);
    expect(contributionInYear({ ...base, monthlyContribution: -5 }, 1)).toBe(0);
  });
});

describe('yearsToFI', () => {
  it('is 0 when already FI', () => {
    expect(yearsToFI({ ...base, capital: 600_000 })).toBe(0);
  });

  it('interpolates inside the crossing year', () => {
    // 0% return, 6,000/yr: from 10,000 to 600,000 takes 590,000 / 6,000 = 98.33 years
    expect(yearsToFI({ ...base, realReturn: 0 })).toBeCloseTo(98.333, 2);
  });

  it('is null when never reached in 100 years', () => {
    expect(yearsToFI({ ...base, realReturn: 0, monthlyContribution: 100 })).toBeNull();
  });

  it('is consistent with the projection', () => {
    const y = yearsToFI(base)!;
    const rows = project(base, Math.ceil(y));
    expect(rows[Math.floor(y)].balance).toBeLessThan(600_000);
    expect(rows[Math.ceil(y)].balance).toBeGreaterThanOrEqual(600_000);
  });
});

describe('coastFI', () => {
  it('discounts the FI number to today', () => {
    const c = coastFI(base);
    expect(c.number).toBeCloseTo(600_000 / Math.pow(1.05, 20), 6);
    expect(c.reachedNow).toBe(false);
  });

  it('is never reached when the plan falls short', () => {
    expect(coastFI(base).age).toBeNull();
  });

  it('finds the age from which contributions could stop', () => {
    const rich = { ...base, monthlyContribution: 2_000 };
    const c = coastFI(rich);
    expect(c.age).not.toBeNull();
    const rows = project(rich);
    const row = rows.find(r => r.age === c.age)!;
    expect(row.balance * Math.pow(1.05, 20 - row.year)).toBeGreaterThanOrEqual(600_000 - 1e-6);
    const before = rows.find(r => r.age === c.age! - 1)!;
    expect(before.balance * Math.pow(1.05, 20 - before.year)).toBeLessThan(600_000);
  });
});

describe('summarize', () => {
  it('reports retirement values and ratio', () => {
    const s = summarize(base);
    expect(s.retirementAge).toBe(50);
    expect(s.fiNumber).toBe(600_000);
    expect(s.ratio).toBeCloseTo(s.balanceAtRetirement / 600_000);
    expect(s.incomeAtSwr).toBeCloseTo(s.balanceAtRetirement * 0.04);
    expect(s.fiAge).toBeCloseTo(30 + s.yearsToFI!);
  });
});

describe('portfolio', () => {
  it('normalizes weights and drops non-positive ones', () => {
    expect(normalizeWeights({ equity: 3, bond: 1, gold: 0 })).toEqual({ equity: 0.75, bond: 0.25 });
    expect(normalizeWeights({})).toEqual({});
  });

  it('sums target rows per class', () => {
    const w = weightsFromTargets([
      { id: 'a', label: 'A', assetClass: 'equity', weight: 0.5 },
      { id: 'b', label: 'B', assetClass: 'equity', weight: 0.2 },
      { id: 'c', label: 'C', assetClass: 'bond', weight: 0.3 },
    ]);
    expect(w.equity).toBeCloseTo(0.7);
    expect(w.bond).toBeCloseTo(0.3);
  });

  it('computes weighted return and correlated volatility', () => {
    const a = { equity: { ret: 0.06, vol: 0.2 }, bond: { ret: 0.02, vol: 0.05 } };
    const one = portfolioStats({ equity: 1 }, a);
    expect(one.ret).toBeCloseTo(0.06);
    expect(one.vol).toBeCloseTo(0.2);
    const mix0 = portfolioStats({ equity: 0.5, bond: 0.5 }, a, 0);
    expect(mix0.ret).toBeCloseTo(0.04);
    expect(mix0.vol).toBeCloseTo(Math.sqrt(0.25 * 0.04 + 0.25 * 0.0025));
    const mix1 = portfolioStats({ equity: 0.5, bond: 0.5 }, a, 1);
    expect(mix1.vol).toBeCloseTo(0.125);
  });
});

describe('inputsFromSettings', () => {
  it('lists the personal inputs that are still missing', () => {
    const r = inputsFromSettings({ baseCurrency: 'EUR' }, [], 2026);
    expect(r.inputs).toBeNull();
    expect(r.missing).toEqual(['age', 'capital', 'monthlyContribution', 'yearsToInvest', 'spending', 'weights']);
  });

  it('fills assumptions with the labelled defaults', () => {
    const r = inputsFromSettings({
      baseCurrency: 'EUR', birthYear: 1990, manualCapital: 1000, monthlyContribution: 100, yearsToInvest: 10,
      retirementSpending: 12_000, projection: { weights: { equity: 1 } },
    }, [], 2026);
    expect(r.missing).toEqual([]);
    expect(r.weightsFrom).toBe('plan');
    expect(r.inputs).toMatchObject({ age: 36, swr: DEFAULTS.swr, inflation: DEFAULTS.inflation, planToAge: DEFAULTS.planToAge });
  });

  it('prefers target allocation and ledger capital when present', () => {
    const r = inputsFromSettings({
      baseCurrency: 'EUR', birthYear: 1990, manualCapital: 1000, monthlyContribution: 100, yearsToInvest: 10,
      retirementSpending: 12_000, projection: { weights: { cash: 1 }, assumptions: { equity: { ret: 0.07, vol: 0.2 } } },
    }, [{ id: 't', label: 'Eq', assetClass: 'equity', weight: 1 }], 2026, 5000);
    expect(r.weightsFrom).toBe('targets');
    expect(r.inputs!.capital).toBe(5000);
    expect(r.inputs!.realReturn).toBeCloseTo(0.07);
  });

  it('keeps the plan horizon after retirement', () => {
    const r = inputsFromSettings({
      baseCurrency: 'EUR', birthYear: 1990, manualCapital: 0, monthlyContribution: 100, yearsToInvest: 70,
      retirementSpending: 12_000, projection: { weights: { equity: 1 }, planToAge: 80 },
    }, [], 2026);
    expect(r.inputs!.planToAge).toBe(36 + 70 + 1);
  });
});

describe('sensitivity', () => {
  it('returns all inputs sorted by impact, in the expected direction', () => {
    const { baseAge, bars } = sensitivity(base);
    expect(baseAge).toBeCloseTo(summarize(base).fiAge!);
    expect(bars).toHaveLength(6);
    for (let i = 1; i < bars.length; i++) expect(bars[i - 1].spread).toBeGreaterThanOrEqual(bars[i].spread);
    const contrib = bars.find(b => b.key === 'monthlyContribution')!;
    expect(contrib.highAge!).toBeLessThan(contrib.lowAge!);
    const spend = bars.find(b => b.key === 'spending')!;
    expect(spend.highAge!).toBeGreaterThan(spend.lowAge!);
  });
});
