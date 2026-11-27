import { describe, it, expect } from 'vitest';
import { emptyData, type InvestData } from './types';
import { manualFx } from './fx';
import { manualPrices } from './prices';
import {
  valueAt, netWorthAt, seriesDates, firstNetWorthDate, monthlyExpenses, emergencyStatus,
  payoffMonths, monthlyInterest, isLiquid, isEmergency, netWorthSeries,
} from './networth';

// Invented test data only.
const fx = manualFx([
  { date: '2025-01-01', currency: 'EUR', ron: 5 },
  { date: '2025-01-01', currency: 'USD', ron: 4 },
]);

function sample(): InvestData {
  return {
    ...emptyData(),
    accounts: [
      { id: 'brk', name: 'Broker', type: 'foreign_broker', currency: 'EUR' },
      { id: 'p2', name: 'Pilon 2', type: 'pillar2', currency: 'RON' },
    ],
    instruments: [{ id: 'etf', name: 'World ETF', assetClass: 'equity', region: 'global', currency: 'EUR' }],
    transactions: [{ id: 't1', date: '2025-03-10', type: 'buy', accountId: 'brk', instrumentId: 'etf', quantity: 10, price: 100, currency: 'EUR' }],
    pensionValues: [{ id: 'pv1', accountId: 'p2', date: '2025-06-30', value: 5000 }],
    prices: [{ instrumentId: 'etf', date: '2025-12-31', price: 120 }],
    netWorth: {
      assets: [
        { id: 'bank', name: 'Cont curent', category: 'cash', currency: 'RON', values: [{ date: '2025-01-31', value: 10_000 }, { date: '2025-12-31', value: 15_000 }] },
        { id: 'flat', name: 'Apartament', category: 'real_estate', currency: 'EUR', values: [{ date: '2025-06-01', value: 100_000 }] },
        { id: 'usd', name: 'Depozit USD', category: 'savings', currency: 'USD', emergency: false, values: [{ date: '2025-01-01', value: 1000 }] },
      ],
      liabilities: [
        { id: 'mtg', name: 'Credit ipotecar', kind: 'mortgage', currency: 'EUR', rate: 0.06, monthlyPayment: 600, balances: [{ date: '2025-06-01', value: 80_000 }, { date: '2025-12-31', value: 78_000 }] },
      ],
    },
  };
}
const src = () => ({ fx, prices: manualPrices(sample().prices) });

describe('valueAt', () => {
  const pts = [{ date: '2025-01-31', value: 1 }, { date: '2025-03-31', value: 3 }, { date: '2025-02-28', value: 2 }];
  it('takes the latest entry on or before the date, whatever the order', () => {
    expect(valueAt(pts, '2025-01-30')).toBeNull();
    expect(valueAt(pts, '2025-01-31')?.value).toBe(1);
    expect(valueAt(pts, '2025-03-15')?.value).toBe(2);
    expect(valueAt(pts, '2030-01-01')?.value).toBe(3);
  });
});

describe('defaults for liquid / emergency', () => {
  it('cash and savings are liquid and emergency money unless set otherwise', () => {
    expect(isLiquid({ category: 'cash' })).toBe(true);
    expect(isLiquid({ category: 'real_estate' })).toBe(false);
    expect(isLiquid({ category: 'vehicle', liquid: true })).toBe(true);
    expect(isEmergency({ category: 'savings' })).toBe(true);
    expect(isEmergency({ category: 'savings', emergency: false })).toBe(false);
    expect(isEmergency({ category: 'other' })).toBe(false);
  });
});

describe('netWorthAt', () => {
  it('adds the portfolio (from the ledger), manual assets and subtracts debts', () => {
    const nw = netWorthAt(sample(), { ...src(), emergencyAccountIds: ['brk'] }, '2025-12-31');
    // Portfolio: 10 × 120 = 1200 EUR; Pillar 2: 5000 RON = 1000 EUR
    // Assets: 15000 RON = 3000 EUR, flat 100000 EUR, USD 1000 × 4 / 5 = 800 EUR
    expect(nw.byCategory.investments).toBeCloseTo(1200);
    expect(nw.byCategory.pension).toBeCloseTo(1000);
    expect(nw.byCategory.cash).toBeCloseTo(3000);
    expect(nw.byCategory.savings).toBeCloseTo(800);
    expect(nw.byCategory.real_estate).toBeCloseTo(100_000);
    expect(nw.byCategory.vehicle).toBe(0);
    expect(nw.assetsEur).toBeCloseTo(106_000);
    expect(nw.liabilitiesEur).toBeCloseTo(78_000);
    expect(nw.netEur).toBeCloseTo(28_000);
    expect(nw.netRon).toBeCloseTo(140_000);
    // Liquid: portfolio 1200 + cash 3000 + USD 800; illiquid: pension + flat
    expect(nw.liquidEur).toBeCloseTo(5000);
    expect(nw.illiquidEur).toBeCloseTo(101_000);
    // Emergency: cash 3000 (USD deposit opted out) + broker account chosen in the IPS 1200
    expect(nw.emergencyEur).toBeCloseTo(4200);
    expect(nw.debtToAssets).toBeCloseTo(78_000 / 106_000);
    expect(nw.missingFx).toEqual([]);
    expect(nw.atCost).toBe(0);
  });

  it('uses only what was recorded by that date', () => {
    const nw = netWorthAt(sample(), src(), '2025-02-28');
    // Only the bank (10000 RON) and the USD deposit exist; no transactions, no debt yet
    expect(nw.assetsEur).toBeCloseTo(2000 + 800);
    expect(nw.liabilitiesEur).toBe(0);
    expect(nw.debtToAssets).toBe(0);
    expect(nw.items.map(i => i.key).sort()).toEqual(['asset:bank', 'asset:usd']);
  });

  it('values positions at cost when there is no price yet, and counts them', () => {
    const nw = netWorthAt(sample(), src(), '2025-04-01');
    expect(nw.byCategory.investments).toBeCloseTo(1000);
    expect(nw.atCost).toBe(1);
  });

  it('leaves out items without an exchange rate and reports the currency', () => {
    const d = sample();
    d.netWorth!.assets.push({ id: 'chf', name: 'CHF', category: 'savings', currency: 'CHF', values: [{ date: '2025-01-01', value: 500 }] });
    const nw = netWorthAt(d, src(), '2025-12-31');
    expect(nw.missingFx).toEqual(['CHF']);
    expect(nw.assetsEur).toBeCloseTo(106_000);
    expect(nw.items.find(i => i.id === 'chf')?.valueEur).toBeNull();
  });

  it('works without any portfolio or net-worth data', () => {
    const nw = netWorthAt(emptyData(), src(), '2025-12-31');
    expect(nw.netEur).toBe(0);
    expect(nw.debtToAssets).toBeNull();
    expect(nw.items).toEqual([]);
  });
});

describe('series', () => {
  it('finds the first recorded date', () => {
    expect(firstNetWorthDate(sample())).toBe('2025-01-01');
    expect(firstNetWorthDate(emptyData())).toBeNull();
  });
  it('builds month-ends up to today', () => {
    expect(seriesDates('2025-01-15', '2025-04-10')).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-10']);
    expect(seriesDates('2024-02-01', '2024-02-29')).toEqual(['2024-02-29']);
    expect(seriesDates('2025-05-01', '2025-01-01')).toEqual(['2025-01-01']);
  });
  it('thins long ranges but always ends on the last date', () => {
    const d = seriesDates('2000-01-01', '2025-06-15', 60);
    expect(d.length).toBeLessThanOrEqual(61);
    expect(d[d.length - 1]).toBe('2025-06-15');
    expect(d[d.length - 2]).toBe('2025-05-31');
  });
  it('computes one point per date', () => {
    const s = netWorthSeries(sample(), src(), ['2025-02-28', '2025-12-31']);
    expect(s.map(p => Math.round(p.netEur))).toEqual([2800, 28_000]);
  });
});

describe('emergency fund', () => {
  const ips = { emergencyFund: { months: 6, monthlyExpenses: 1000, accountIds: [] } };
  it('prefers the expenses entered on the page, else the IPS rule', () => {
    expect(monthlyExpenses({ assets: [], liabilities: [], monthlyExpenses: 1500 }, ips)).toEqual({ eur: 1500, source: 'manual' });
    expect(monthlyExpenses({ assets: [], liabilities: [] }, ips)).toEqual({ eur: 1000, source: 'ips' });
    expect(monthlyExpenses(undefined, null)).toBeNull();
  });
  it('counts months and compares with the IPS target', () => {
    expect(emergencyStatus({ emergencyEur: 4200 }, { eur: 1000, source: 'ips' }, ips)).toEqual({ eur: 4200, months: 4.2, targetMonths: 6, status: 'under' });
    expect(emergencyStatus({ emergencyEur: 6000 }, { eur: 1000, source: 'ips' }, ips).status).toBe('ok');
    expect(emergencyStatus({ emergencyEur: 6000 }, { eur: 1000, source: 'manual' }, null)).toEqual({ eur: 6000, months: 6, targetMonths: null, status: 'unknown' });
    expect(emergencyStatus({ emergencyEur: 6000 }, null, ips).months).toBeNull();
  });
});

describe('debts', () => {
  it('monthly interest', () => {
    expect(monthlyInterest(120_000, 0.06)).toBeCloseTo(600);
  });
  it('months to pay off with a fixed instalment', () => {
    expect(payoffMonths(0, 0.05, 100)).toBe(0);
    expect(payoffMonths(1200, 0, 100)).toBe(12);
    expect(payoffMonths(1000, undefined, 300)).toBe(4);
    // 100 000 at 6%/yr, 599.55/month ≈ 30-year annuity
    expect(payoffMonths(100_000, 0.06, 599.56)).toBe(360);
    expect(payoffMonths(100_000, 0.06, 500)).toBeNull();
    expect(payoffMonths(100_000, 0.06, undefined)).toBeNull();
  });
});
