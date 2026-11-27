import { describe, it, expect } from 'vitest';
import {
  weightsAtAge, otherIncomeAt, vpwRate, guytonKlingerStep, floorCeilingStep, runRetirement, netIncome,
  WITHDRAWAL_DEFAULTS, type RetireInputs,
} from './withdrawal';
import { runMonteCarlo } from './montecarlo';
import type { TaxRuleSet } from './types';

const GK = { guard: 0.2, adjust: 0.1, minYearsLeft: 15 };

// A plan with no volatility: every run is the same, so the numbers can be checked by hand.
const base = (over: Partial<RetireInputs> = {}): RetireInputs => ({
  age: 60, capital: 100_000, monthlyContribution: 0, contributionGrowth: 0, yearsToInvest: 0,
  spending: 10_000, swr: 0.04, inflation: 0.03, realReturn: 0, volatility: 0, planToAge: 70,
  mode: 'normal', runs: 2000, seed: 1, correlation: 0,
  baseWeights: { cash: 1 }, assumptions: { cash: { ret: 0, vol: 0 } },
  params: { initial: 'spending', gk: GK, floor: 0.85, ceiling: 1.25 },
  ...over,
});

describe('glidepath', () => {
  const pts = [{ age: 50, weights: { equity: 0.8, bond: 0.2 } }, { age: 60, weights: { equity: 0.4, bond: 0.6 } }];
  it('interpolates linearly and stays flat outside the points', () => {
    expect(weightsAtAge(pts, 40, {})).toEqual({ equity: 0.8, bond: 0.2 });
    const mid = weightsAtAge(pts, 55, {});
    expect(mid.equity).toBeCloseTo(0.6); expect(mid.bond).toBeCloseTo(0.4);
    expect(weightsAtAge(pts, 90, {})).toEqual({ equity: 0.4, bond: 0.6 });
  });
  it('falls back to the current allocation and normalizes', () => {
    expect(weightsAtAge([], 50, { equity: 3, bond: 1 })).toEqual({ equity: 0.75, bond: 0.25 });
    expect(weightsAtAge([{ age: 50, weights: {} }], 50, { gold: 1 })).toEqual({ gold: 1 });
  });
});

describe('other income', () => {
  it('counts streams between their start and end age (inclusive)', () => {
    const s = [{ amount: 5000, startAge: 65 }, { amount: 1000, startAge: 60, endAge: 64 }];
    expect(otherIncomeAt(s, 59)).toBe(0);
    expect(otherIncomeAt(s, 64)).toBe(1000);
    expect(otherIncomeAt(s, 65)).toBe(5000);
    expect(otherIncomeAt(undefined, 70)).toBe(0);
  });
});

describe('strategy rules', () => {
  it('VPW is an annuity due on the years left', () => {
    expect(vpwRate(0, 10)).toBeCloseTo(0.1);
    expect(vpwRate(0.05, 1)).toBeCloseTo(1);
    // 30 years at 5%: PMT due = 0.05 / (1.05 × (1 − 1.05^−30)) ≈ 6.195%
    expect(vpwRate(0.05, 30)).toBeCloseTo(0.06195, 4);
  });
  it('Guyton-Klinger cuts, raises and skips the inflation raise', () => {
    // initial rate 4%; balance fell so 4000 is 5% (> 4.8%) → cut 10%
    expect(guytonKlingerStep(4000, 80_000, 0.04, 0.05, 0.03, 30, GK)).toBeCloseTo(3600);
    // same, but only 10 years left → no cut
    expect(guytonKlingerStep(4000, 80_000, 0.04, 0.05, 0.03, 10, GK)).toBeCloseTo(4000);
    // balance rose: 4000 / 140000 = 2.86% (< 3.2%) → raise 10%
    expect(guytonKlingerStep(4000, 140_000, 0.04, 0.05, 0.03, 30, GK)).toBeCloseTo(4400);
    // losing year and rate above initial → no inflation raise (real cut), then within the guardrails
    expect(guytonKlingerStep(4120, 100_000, 0.04, -0.1, 0.03, 30, GK)).toBeCloseTo(4000);
  });
  it('floor and ceiling clamp the variable amount', () => {
    expect(floorCeilingStep(50_000, 0.04, 4000, 0.85, 1.25)).toBe(3400);
    expect(floorCeilingStep(200_000, 0.04, 4000, 0.85, 1.25)).toBe(5000);
    expect(floorCeilingStep(110_000, 0.04, 4000, 0.85, 1.25)).toBeCloseTo(4400);
  });
});

describe('runRetirement (no volatility)', () => {
  it('constant spending: balance falls linearly, other income lowers the withdrawal', () => {
    const r = runRetirement(base({ incomes: [{ amount: 4000, startAge: 65 }] }));
    const c = r.strategies.constant;
    expect(r.ages).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
    expect(c.withdrawal.p50.slice(0, 6)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 6_000]);
    expect(c.income.p50[9]).toBe(10_000);
    expect(c.successRate).toBe(1);
    expect(c.shortfallRate).toBe(0);
    expect(c.medianBequest).toBeCloseTo(100_000 - 5 * 10_000 - 5 * 6_000);
  });
  it('runs out when the money is not enough, and reports when', () => {
    const r = runRetirement(base({ capital: 45_000 }));
    const c = r.strategies.constant;
    expect(c.successRate).toBe(0);
    expect(c.medianDepletionAge).toBe(64);
    expect(c.shortfallRate).toBe(1);
    expect(c.medianBequest).toBe(0);
  });
  it('VPW never runs out and spends everything by the end', () => {
    const v = runRetirement(base({ capital: 45_000 })).strategies.vpw;
    expect(v.successRate).toBe(1);
    expect(v.withdrawal.p50[0]).toBeCloseTo(4500);
    expect(v.medianBequest).toBeCloseTo(0);
  });
  it('SWR mode starts at SWR × balance; accumulation reuses the plan contributions', () => {
    const r = runRetirement(base({ age: 50, yearsToInvest: 10, monthlyContribution: 1000, params: { ...base().params, initial: 'swr' } }));
    expect(r.retirementAge).toBe(60);
    expect(r.medianAtRetirement).toBeCloseTo(220_000);
    expect(r.strategies.constant.withdrawal.p50[0]).toBeCloseTo(8_800);
    expect(r.strategies.constant.initialRate).toBeCloseTo(0.04);
  });
  it('throws when there is no retirement phase', () => {
    expect(() => runRetirement(base({ yearsToInvest: 10 }))).toThrow();
  });
});

describe('runRetirement (Monte Carlo)', () => {
  const mc = (over: Partial<RetireInputs> = {}) => base({
    age: 40, yearsToInvest: 20, planToAge: 95, capital: 200_000, monthlyContribution: 1500, spending: 30_000,
    baseWeights: { equity: 0.7, bond: 0.3 },
    assumptions: { equity: { ret: 0.05, vol: 0.16 }, bond: { ret: 0.015, vol: 0.06 } }, correlation: 0.3,
    realReturn: 0.04, volatility: 0.12, runs: 3000, seed: 7, ...over,
  });
  it('is deterministic for a seed and percentiles are ordered', () => {
    const a = runRetirement(mc()), b = runRetirement(mc());
    expect(a.strategies.guardrails.medianBequest).toBe(b.strategies.guardrails.medianBequest);
    for (const s of Object.values(a.strategies)) {
      s.balance.p10.forEach((x, i) => { expect(x).toBeLessThanOrEqual(s.balance.p50[i]); expect(s.balance.p50[i]).toBeLessThanOrEqual(s.balance.p90[i]); });
      expect(s.successRate).toBeGreaterThanOrEqual(0); expect(s.successRate).toBeLessThanOrEqual(1);
    }
    expect(a.strategies.guardrails.guardrails?.cut.length).toBe(a.ages.length);
  });
  it('matches the plan Monte Carlo for a constant withdrawal without a glidepath', () => {
    // Same seed and the same yearly draws as runMonteCarlo when the allocation is constant
    const inp = mc({ baseWeights: {}, assumptions: {} });
    const r = runRetirement(inp);
    const plan = runMonteCarlo({ ...inp, mode: 'normal', history: undefined });
    expect(r.medianAtRetirement).toBeCloseTo(plan.medianAtRetirement, 6);
    expect(r.strategies.constant.successRate).toBeCloseTo(plan.successRate, 6);
  });
  it('a riskier glidepath changes the outcome; bootstrap needs history', () => {
    const safe = runRetirement(mc()).strategies.constant;
    const tent = runRetirement(mc({ glidepath: [{ age: 40, weights: { equity: 1 } }, { age: 95, weights: { equity: 1 } }] })).strategies.constant;
    expect(tent.balance.p90[0]).toBeGreaterThan(safe.balance.p90[0]);
    expect(() => runRetirement(mc({ mode: 'bootstrap' }))).toThrow();
    const boot = runRetirement(mc({ mode: 'bootstrap', history: [{ year: 2000, returns: { equity: 0.05, bond: 0.01 } }] }));
    // one history year (5% equity, 1% bond, weighted 0.7/0.3 → 3.8%) every year: all runs identical
    expect(boot.p10AtRetirement).toBeCloseTo(boot.medianAtRetirement, 6);
    expect(boot.medianAtRetirement).toBeGreaterThan(0);
  });
  it('defaults are the published Guyton-Klinger values', () => {
    expect(WITHDRAWAL_DEFAULTS).toMatchObject({ gkGuard: 0.2, gkAdjust: 0.1, gkMinYearsLeft: 15 });
  });
});

describe('net income after tax', () => {
  // Synthetic values (NOT the Romanian rules), as in tax-ro.test.ts
  const P = (value: number) => ({ value });
  const set: TaxRuleSet = {
    year: 2025, confirmed: false,
    params: Object.fromEntries(Object.entries({
      'cg.foreign.rate': 0.1, 'cg.ro.rateLong': 0.01, 'cg.ro.rateShort': 0.03, 'cg.ro.holdDays': 365,
      'loss.carryYears': 7, 'loss.offsetShare': 1, 'div.rate': 0.1, 'div.foreignCredit': 1, 'div.usTreatyRate': 0.1,
      'int.rate': 0.1, 'int.govExempt': 1, 'cass.rate': 0.1, 'cass.minWage': 4000, 'cass.t1': 6, 'cass.t2': 12, 'cass.t3': 24,
      'cass.countRoGains': 1, 'cass.countExemptInterest': 0, 'cass.lossReducesBase': 0, 'cass.netOfWithheld': 0,
      'fx.gains': 0, 'fx.income': 0, 'fx.prevDay': 0, 'du.month': 5, 'du.day': 25,
    }).map(([k, v]) => [k, P(v)])),
  };
  it('taxes the gain part of the withdrawal and adds net other income', () => {
    // 20 000 € × 5 = 100 000 lei, 40% gain → 4 000 lei tax + CASS on 40 000 lei (tier 6 × 4 000 = 24 000 → 2 400 lei)
    const r = netIncome(set, 20_000, 3_000, { year: 2025, eurRon: 5, gainShare: 0.4, accountType: 'foreign_broker' });
    expect(r.tax).toBeCloseTo(1_280);
    expect(r.net).toBeCloseTo(20_000 - 1_280 + 3_000);
    expect(r.effectiveRate).toBeCloseTo(0.064);
  });
  it('no withdrawal → no tax', () => {
    expect(netIncome(set, 0, 5_000, { year: 2025, eurRon: 5, gainShare: 1, accountType: 'foreign_broker' })).toEqual({ tax: 0, net: 5_000, effectiveRate: 0 });
  });
});
