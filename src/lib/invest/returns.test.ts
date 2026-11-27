import { describe, it, expect } from 'vitest';
import { xirr, periodXirr, modifiedDietz, chainReturns, twr, realReturn, annualise, drawdownSeries, wealthIndex, daysBetween } from './returns';

describe('xirr', () => {
  it('one year, no flows: equals the simple return', () => {
    const r = xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }]);
    expect(r).toBeCloseTo(0.1, 6);
  });

  it('matches a hand-checked two-flow example (Excel XIRR gives 0.1680…)', () => {
    // −1000 on 1 Jan, −1000 on 1 Jul, +2250 on 31 Dec. NPV at r must be ~0.
    const cf = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: -1000 },
      { date: '2024-12-31', amount: 2250 },
    ];
    const r = xirr(cf)!;
    const npv = cf.reduce((s, c) => s + c.amount / Math.pow(1 + r, daysBetween('2024-01-01', c.date) / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
    expect(r).toBeGreaterThan(0.16);
    expect(r).toBeLessThan(0.18);
  });

  it('handles losses', () => {
    expect(xirr([{ date: '2022-01-01', amount: -1000 }, { date: '2023-01-01', amount: 600 }])).toBeCloseTo(-0.4, 6);
  });

  it('returns null without a sign change or with too few flows', () => {
    expect(xirr([{ date: '2022-01-01', amount: -1000 }])).toBeNull();
    expect(xirr([{ date: '2022-01-01', amount: -1000 }, { date: '2023-01-01', amount: -5 }])).toBeNull();
  });
});

describe('periodXirr', () => {
  it('part year: period rate is de-annualised', () => {
    const r = periodXirr('2024-12-31', 1000, [], '2025-07-01', 1050);
    expect(r.period).toBeCloseTo(0.05, 6);
    expect(r.annual!).toBeGreaterThan(0.1);
  });

  it('flows inside the period are money in (portfolio view)', () => {
    // Start 0, deposit 1000 on day 1, end 1000 → 0%
    const r = periodXirr('2024-12-31', 0, [{ date: '2025-01-01', amount: 1000 }], '2025-12-31', 1000);
    expect(r.period).toBeCloseTo(0, 6);
  });
});

describe('modifiedDietz / twr', () => {
  it('no flows: simple return', () => {
    expect(modifiedDietz('2025-01-31', 1000, [], '2025-02-28', 1100)).toBeCloseTo(0.1, 10);
  });

  it('weights a mid-period flow by the time it was invested', () => {
    // 30-day period, 1000 at start, +1000 on day 15 (weight 0.5), end 2100 → gain 100 / 1500
    const r = modifiedDietz('2025-04-01', 1000, [{ date: '2025-04-16', amount: 1000 }], '2025-05-01', 2100)!;
    expect(r).toBeCloseTo(100 / 1500, 10);
  });

  it('null when nothing was invested', () => {
    expect(modifiedDietz('2025-01-31', 0, [], '2025-02-28', 0)).toBeNull();
  });

  it('chains sub-periods and ignores contributions', () => {
    // +10% then −10% with a big deposit at the boundary: TWR = 1.1 × 0.9 − 1 = −1%
    const points = [
      { date: '2024-12-31', value: 1000 },
      { date: '2025-01-31', value: 1100 + 5000 },
      { date: '2025-02-28', value: 6100 * 0.9 },
    ];
    const flows = [{ date: '2025-01-31', amount: 5000 }];
    const r = twr(points, flows);
    // The deposit on the month-end is weighted 0 in January, so January = (6100 − 1000 − 5000) / 1000 = 10%
    expect(r.subs[0].r).toBeCloseTo(0.1, 10);
    expect(r.subs[1].r).toBeCloseTo(-0.1, 10);
    expect(r.value).toBeCloseTo(-0.01, 10);
  });

  it('chainReturns skips nulls and counts them', () => {
    expect(chainReturns([0.1, null, 0.1])).toEqual({ value: expect.closeTo(0.21, 10), skipped: 1 });
    expect(chainReturns([null]).value).toBeNull();
  });
});

describe('real return and helpers', () => {
  it('Fisher formula', () => {
    expect(realReturn(0.1, 0.05)).toBeCloseTo(1.1 / 1.05 - 1, 12);
    expect(realReturn(0.1, undefined)).toBeNull();
    expect(realReturn(null, 0.05)).toBeNull();
  });

  it('annualise', () => {
    expect(annualise(0.21, 730)).toBeCloseTo(0.1, 3);
  });

  it('drawdown from a wealth index', () => {
    const idx = wealthIndex('2025-01-01', [{ to: '2025-02-01', r: 0.2 }, { to: '2025-03-01', r: -0.25 }, { to: '2025-04-01', r: 0.5 }]);
    expect(idx.map(p => p.value)).toEqual([1, 1.2, expect.closeTo(0.9, 12), expect.closeTo(1.35, 12)]);
    const dd = drawdownSeries(idx);
    expect(dd.max).toBeCloseTo(0.25, 12);
    expect(dd.maxDate).toBe('2025-03-01');
    expect(dd.points.at(-1)!.dd).toBe(0);
  });
});
