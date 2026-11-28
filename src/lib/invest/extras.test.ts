import { describe, it, expect } from 'vitest';
import { emptyData, type InvestData, type TaxRuleSet } from './types';
import { manualFx } from './fx';
import { manualPrices } from './prices';
import { portfolioAt, benchmarkReturn } from './report';
import { planWithdrawal, withdrawalTax, eligible } from './whatif';
import { feesByYear, terCosts, costDrag } from './costs';
import { buyPlan, instrumentForRow } from './buyplan';
import { monthSummary, monthlyEmail, dueMonth, previousMonth, validateMonthlySettings, withMonthlyDefaults } from './monthly';
import { proposedRuleSet } from './tax-ro-defaults';

// Invented test data only.
const fx = manualFx([{ date: '2020-01-01', currency: 'EUR', ron: 5 }, { date: '2020-01-01', currency: 'USD', ron: 4 }]);

function sample(): InvestData {
  return {
    ...emptyData(),
    settings: { baseCurrency: 'EUR', retirementSpending: 20_000, swr: 0.04, monthlyContribution: 500 },
    accounts: [
      { id: 'a', name: 'Broker', type: 'foreign_broker', currency: 'EUR' },
      { id: 'r', name: 'Broker RO', type: 'ro_broker', currency: 'RON' },
    ],
    instruments: [
      { id: 'w', ticker: 'WLD', name: 'World', assetClass: 'equity', region: 'global', currency: 'EUR', ter: 0.002 },
      { id: 'b', ticker: 'BND', name: 'Bonds', assetClass: 'bond', region: 'europe', currency: 'EUR' },
      { id: 'us', ticker: 'SPX', name: 'US index', assetClass: 'equity', region: 'us', currency: 'USD' },
    ],
    transactions: [
      { id: 't1', date: '2025-01-10', type: 'buy', accountId: 'a', instrumentId: 'w', quantity: 10, price: 100, fees: 2, currency: 'EUR' },
      { id: 't2', date: '2025-01-10', type: 'buy', accountId: 'a', instrumentId: 'b', quantity: 10, price: 50, fees: 1, currency: 'EUR' },
      { id: 't3', date: '2025-03-05', type: 'fee', accountId: 'a', amount: 5, currency: 'EUR' },
      { id: 't4', date: '2026-02-03', type: 'buy', accountId: 'a', instrumentId: 'w', quantity: 1, price: 120, currency: 'EUR' },
    ],
    prices: [
      { instrumentId: 'w', date: '2024-12-31', price: 95 },
      { instrumentId: 'w', date: '2025-12-31', price: 120 },
      { instrumentId: 'w', date: '2026-01-31', price: 125 },
      { instrumentId: 'w', date: '2026-02-28', price: 130 },
      { instrumentId: 'b', date: '2025-12-31', price: 50 },
      { instrumentId: 'us', date: '2024-12-30', price: 100 },
      { instrumentId: 'us', date: '2025-12-31', price: 110 },
    ],
    targets: [
      { id: 'eq', label: 'Acțiuni', assetClass: 'equity', weight: 0.6 },
      { id: 'bo', label: 'Obligațiuni', assetClass: 'bond', weight: 0.4 },
    ],
  };
}
const src = () => ({ fx, prices: manualPrices(sample().prices) });

describe('benchmark', () => {
  it('price change in EUR between the two dates', () => {
    const d = sample();
    const r = benchmarkReturn(d.instruments[0], src(), '2024-12-31', '2025-12-31')!;
    expect(r.ret).toBeCloseTo(120 / 95 - 1, 10);
    // USD instrument converted at the (constant) rate: same ratio
    expect(benchmarkReturn(d.instruments[2], src(), '2024-12-31', '2025-12-31')!.ret).toBeCloseTo(0.1, 10);
  });
  it('null when the series does not reach back', () => {
    const d = sample();
    expect(benchmarkReturn(d.instruments[1], src(), '2024-12-31', '2025-12-31')).toBeNull();
    expect(benchmarkReturn(undefined, src(), '2024-12-31', '2025-12-31')).toBeNull();
  });
});

describe('what-if withdrawal', () => {
  it('sells proportionally and computes the gain at the average cost', () => {
    const d = sample();
    const p = portfolioAt(d, src(), '2025-12-31'); // w 1200, b 500
    const plan = planWithdrawal(p.holdings, 850, {}, fx, '2025-12-31');
    expect(plan.soldEur).toBe(850);
    expect(plan.shortfallEur).toBe(0);
    const w = plan.lines.find(l => l.instrumentId === 'w')!;
    expect(w.valueEur).toBeCloseTo(600, 6);
    expect(w.quantity).toBeCloseTo(5, 6);
    // avg cost 100.2 → gain 600 − 5 × 100.2 = 99
    expect(w.gain).toBeCloseTo(99, 6);
    expect(w.gainRon).toBeCloseTo(495, 6);
    const after = plan.after.reduce((s, h) => s + (h.valueEur ?? 0), 0);
    expect(after).toBeCloseTo(1700 - 850, 6);
  });

  it('caps at what the selection holds', () => {
    const p = portfolioAt(sample(), src(), '2025-12-31');
    const plan = planWithdrawal(p.holdings, 900, { instrumentId: 'b' }, fx, '2025-12-31');
    expect(eligible(p.holdings, { instrumentId: 'b' })).toHaveLength(1);
    expect(plan.soldEur).toBeCloseTo(500, 6);
    expect(plan.shortfallEur).toBeCloseTo(400, 6);
  });

  it('estimates the marginal tax with the researched rules', () => {
    const d = sample();
    const set: TaxRuleSet = proposedRuleSet(2026)!;
    const p = portfolioAt(d, src(), '2025-12-31');
    const plan = planWithdrawal(p.holdings, 850, {}, fx, '2025-12-31');
    const t = withdrawalTax(set, 2026, plan.lines, d.accounts);
    const gainRon = plan.lines.reduce((s, l) => s + (l.gainRon ?? 0), 0);
    expect(t.missing).toBe(0);
    // Foreign broker: yearly net gain taxed at the 2026 rate (16%), below the CASS threshold
    expect(t.estimate.incomeTax).toBeCloseTo(gainRon * 0.16, 1);
    expect(t.estimate.cassDelta).toBe(0);
  });
});

describe('costs', () => {
  it('broker fees per year', () => {
    const f = feesByYear(sample(), fx);
    expect(f.get(2025)).toEqual({ eur: 8, count: 3, missing: 0 });
    expect(f.has(2026)).toBe(false);
  });

  it('TER on today\'s holdings; missing TER listed', () => {
    const d = sample();
    const p = portfolioAt(d, src(), '2025-12-31');
    const c = terCosts(p.holdings, d.instruments);
    expect(c.costEur).toBeCloseTo(1200 * 0.002, 10);
    expect(c.weightedTer).toBeCloseTo(0.002, 10);
    expect(c.missing).toBe(1);
  });

  it('cost drag: zero cost = no loss; positive cost loses money', () => {
    expect(costDrag({ start: 10_000, monthly: 100, years: 20, realReturn: 0.05, costRate: 0 }).lost).toBeCloseTo(0, 6);
    const d = costDrag({ start: 10_000, monthly: 0, years: 10, realReturn: 0.05, costRate: 0.01 });
    expect(d.gross[10]).toBeCloseTo(10_000 * 1.05 ** 10, 6);
    expect(d.withCosts[10]).toBeCloseTo(10_000 * (1.05 * 0.99) ** 10, 6);
    expect(d.lost).toBeGreaterThan(0);
  });
});

describe('buy plan', () => {
  it('fills the underweight row first and rounds down to whole units', () => {
    const d = sample();
    const p = portfolioAt(d, src(), '2025-12-31'); // equity 1200, bonds 500 → bonds underweight vs 60/40
    expect(instrumentForRow(d.targets[1], p.holdings, d.targets)).toBe('b');
    const plan = buyPlan(p.holdings, d.targets, 300, id => (id === 'b' ? 50 : id === 'w' ? 120 : null));
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].instrumentId).toBe('b');
    expect(plan.lines[0].units).toBe(6);
    expect(plan.spent).toBe(300);
    expect(plan.leftover).toBe(0);
  });

  it('fractional units and leftover cash', () => {
    const d = sample();
    const p = portfolioAt(d, src(), '2025-12-31');
    const whole = buyPlan(p.holdings, d.targets, 2000, id => (id === 'b' ? 50 : 120));
    const frac = buyPlan(p.holdings, d.targets, 2000, id => (id === 'b' ? 50 : 120), { fractional: true });
    expect(whole.spent + whole.leftover).toBeCloseTo(2000, 6);
    expect(frac.leftover).toBeLessThan(whole.leftover + 1e-9);
    // After buying, both rows are back at 60/40
    const eq = 1200 + (whole.lines.find(l => l.target.id === 'eq')?.amountEur ?? 0);
    expect(eq / 3700).toBeCloseTo(0.6, 6);
  });
});

describe('monthly summary', () => {
  it('settings validation and due month', () => {
    expect(validateMonthlySettings({ version: 1, enabled: true, includeAmounts: false }).problems).toEqual([]);
    expect(validateMonthlySettings({ version: 1, enabled: 'yes' }).problems.length).toBeGreaterThan(0);
    expect(withMonthlyDefaults(null).enabled).toBe(false);
    expect(previousMonth('2026-01-03')).toBe('2025-12');
    const on = { version: 1 as const, enabled: true, includeAmounts: false };
    expect(dueMonth(on, { version: 1, log: [] }, '2026-03-02')).toBe('2026-02');
    expect(dueMonth(on, { version: 1, log: [], lastSent: '2026-02' }, '2026-03-20')).toBeNull();
    expect(dueMonth({ ...on, enabled: false }, { version: 1, log: [] }, '2026-03-02')).toBeNull();
  });

  it('summarises a month and hides amounts unless asked', () => {
    const d = sample();
    const s = monthSummary(d, { ...src(), emergencyAccountIds: [] }, '2026-02');
    // Jan end: 10 × 125 + 500 = 1750; Feb: buy 1 at 120 (flow +120); end 11 × 130 + 500 = 1930
    expect(s.portfolioStart).toBeCloseTo(1750, 6);
    expect(s.portfolioEnd).toBeCloseTo(1930, 6);
    expect(s.flows).toBeCloseTo(120, 6);
    expect(s.transactions).toBe(1);
    expect(s.ret).toBeCloseTo((1930 - 1750 - 120) / (1750 + 120 * (25 / 28)), 6);
    const plain = monthlyEmail(s, false, 'https://geoli.eu/vault/invest/');
    expect(plain.text).not.toMatch(/€/);
    expect(plain.subject).toContain('februarie 2026');
    expect(monthlyEmail(s, true, 'x').text).toMatch(/1\.930 €/);
  });
});
