import { describe, it, expect } from 'vitest';
import type { PropertyScenario, RealEstateDoc } from './types';
import { purchase, loanFor, rentalAnalysis, buyVsRent, scenarioMetrics, loanCashByYear, paramValue, unconfirmedReParams } from './property';
import { prepayVsInvest, extraFlows } from './prepay';
import { RESEARCHED_RE_PARAMS, RE_PARAM_KEYS } from './realestate-defaults';
import { schedule } from './mortgage';

// Invented scenarios only.
const toEur = () => null;
const doc: RealEstateDoc = { scenarios: [], params: { 'rent.taxRate': { value: 0.1 }, 'rent.deduction': { value: 0.2 } } };

function flat(over: Partial<PropertyScenario> = {}): PropertyScenario {
  return {
    id: 's1', name: 'Apartament (demo)', use: 'rental', priceEur: 100_000, purchaseDate: '2026-01-15', downPct: 0.2, eurRon: 5,
    costs: [{ id: 'c1', label: 'Notar', amount: 10_000, currency: 'RON' }, { id: 'c2', label: 'Mobilă', amount: 3000, currency: 'EUR' }],
    loan: { months: 360, type: 'annuity', startMonth: '2026-02', fixedRate: 0.06, fixedMonths: 60, ircc: 0.055, margin: 0.02, irccScenarios: [-0.01, 0.01] },
    prepayments: [], rent: { monthlyEur: 500, occupancy: 1, managementPct: 0, maintenancePct: 0.01, otherYearlyEur: 0, growth: 0 },
    appreciation: 0, holdYears: 10, sellCostPct: 0, status: 'draft',
    ...over,
  };
}

describe('purchase', () => {
  it('down payment in EUR and RON, loan, own cash', () => {
    const p = purchase(flat(), 5, toEur);
    expect(p.downEur).toBe(20_000);
    expect(p.downRon).toBe(100_000);
    expect(p.loanRon).toBe(400_000);
    expect(p.costsEur).toBe(2000 + 3000);
    expect(p.ownCashEur).toBe(25_000);
  });

  it('cash purchase: no loan, whole price is own money', () => {
    const p = purchase(flat({ loan: undefined }), 5, toEur);
    expect(p.loanRon).toBe(0);
    expect(p.ownCashEur).toBe(105_000);
    expect(loanFor(flat({ loan: undefined }), p, doc)).toBeNull();
  });
});

describe('loan for a scenario', () => {
  it('computes base, with prepayments and IRCC scenarios', () => {
    const s = flat({ prepayments: [{ id: 'p', kind: 'once', amountRon: 50_000, month: '2027-01', effect: 'term' }] });
    const p = purchase(s, 5, toEur);
    const l = loanFor(s, p, doc)!;
    expect(l.base.rows).toHaveLength(360);
    expect(l.withPrepay.rows.length).toBeLessThan(360);
    expect(l.scenarios.map(x => x.shift)).toEqual([-0.01, 0.01]);
    expect(l.scenarios[1].summary.totalInterest).toBeGreaterThan(l.scenarios[0].summary.totalInterest);
    expect(l.dae!).toBeGreaterThan(0.06);
    expect(loanCashByYear(l.base.rows, 2)[0]).toBeCloseTo(l.base.rows.slice(0, 12).reduce((s2, r) => s2 + r.cash, 0), 6);
  });
});

describe('rental', () => {
  it('yields and a cash IRR equal to the net yield without loan or growth', () => {
    const s = flat({ loan: undefined, costs: [] });
    const p = purchase(s, 5, toEur);
    const r = rentalAnalysis(s, p, [], doc);
    // 6000 rent − 1000 upkeep − tax 10% × 80% × 6000 = 480 → 4520
    expect(r.years[0].noi).toBeCloseTo(4520, 6);
    expect(r.grossYield).toBeCloseTo(0.06, 12);
    expect(r.netYield).toBeCloseTo(0.0452, 12);
    expect(r.cashOnCash).toBeCloseTo(0.0452, 12);
    // Buy 100k, 4.52k a year, sell for 100k after 10 years → IRR = 4.52%
    expect(r.irr!).toBeCloseTo(0.0452, 3);
  });

  it('leverage lowers the cash flow; appreciation raises the IRR', () => {
    const s = flat();
    const p = purchase(s, 5, toEur);
    const rows = loanFor(s, p, doc)!.withPrepay.rows;
    const r0 = rentalAnalysis(s, p, rows, doc);
    const r1 = rentalAnalysis({ ...s, appreciation: 0.03 }, p, rows, doc);
    expect(r0.years[0].cashFlow).toBeLessThan(r0.years[0].noi);
    expect(r1.irr!).toBeGreaterThan(r0.irr!);
    expect(r0.years[9].balance).toBeLessThan(80_000);
  });
});

describe('buy vs rent', () => {
  it('renting wins with high rent-free returns; buying wins when rent is high and the home appreciates', () => {
    const s = flat({ use: 'home', loan: undefined, costs: [], rent: { monthlyEur: 300, maintenancePct: 0.01, growth: 0 }, holdYears: 20 });
    const p = purchase(s, 5, toEur);
    expect(buyVsRent(s, p, [], 0.08).advantage).toBeLessThan(0);
    const s2 = { ...s, rent: { monthlyEur: 700, maintenancePct: 0.01, growth: 0.02 }, appreciation: 0.03 };
    const b = buyVsRent(s2, purchase(s2, 5, toEur), [], 0.05);
    expect(b.advantage).toBeGreaterThan(0);
    expect(b.breakEven).not.toBeNull();
  });
});

describe('comparison metrics', () => {
  it('fills the row for a rental and for a home', () => {
    const ctx = { eurRon: 5, toEur, doc, birthYear: 1988, yearlyReturn: 0.06, gainTax: 0.16 };
    const m = scenarioMetrics(flat({ monthlyIncomeRon: 12_000 }), ctx);
    expect(m.ageAtPurchase).toBe(38);
    expect(m.ageAtEnd).toBe(68);
    expect(m.dti).toBeGreaterThan(0.2);
    expect(m.irr).not.toBeNull();
    expect(m.buyAdvantage).toBeNull();
    const h = scenarioMetrics(flat({ use: 'home', rent: { monthlyEur: 600 } }), ctx);
    expect(h.irr).toBeNull();
    expect(h.buyAdvantage).not.toBeNull();
  });
});

describe('prepay vs invest', () => {
  const loan = { months: 240, type: 'annuity' as const, startMonth: '2026-01', fixedRate: 0.06, fixedMonths: 240 };
  const pre = [{ id: 'p', kind: 'once' as const, amountRon: 50_000, month: '2026-06', effect: 'term' as const }];

  it('both cases spend the same money', () => {
    const f = extraFlows(loan, 300_000, pre);
    const a = schedule(loan, 300_000).rows, b = schedule(loan, 300_000, { prepayments: pre }).rows;
    const spentA = a.reduce((s, r) => s + r.cash, 0) + f.toInvest.reduce((s, x) => s + x, 0);
    const spentB = b.reduce((s, r) => s + r.cash, 0) + f.toPrepayCase.reduce((s, x) => s + x, 0);
    expect(spentA).toBeCloseTo(spentB, 4);
  });

  it('break-even near the loan rate without tax; investing at a higher return wins', () => {
    const r = prepayVsInvest(loan, 300_000, pre, { yearlyReturn: 0.1, vol: 0, gainTax: 0, runs: 0 })!;
    expect(r.difference).toBeGreaterThan(0);
    // 6%/12 monthly ≈ 6.17% effective yearly
    expect(r.breakEvenReturn!).toBeCloseTo(Math.pow(1.005, 12) - 1, 3);
    const low = prepayVsInvest(loan, 300_000, pre, { yearlyReturn: 0.03, vol: 0, gainTax: 0, runs: 0 })!;
    expect(low.difference).toBeLessThan(0);
    // Tax on gains raises the bar
    const taxed = prepayVsInvest(loan, 300_000, pre, { yearlyReturn: 0.1, vol: 0, gainTax: 0.16, runs: 0 })!;
    expect(taxed.breakEvenReturn!).toBeGreaterThan(r.breakEvenReturn!);
  });

  it('Monte Carlo gives a probability and percentiles; null without prepayments', () => {
    const r = prepayVsInvest(loan, 300_000, pre, { yearlyReturn: 0.07, vol: 0.15, gainTax: 0.1, runs: 300, seed: 3 })!;
    expect(r.probInvestWins!).toBeGreaterThan(0);
    expect(r.probInvestWins!).toBeLessThan(1);
    expect(r.p10!).toBeLessThan(r.p90!);
    expect(prepayVsInvest(loan, 300_000, [], { yearlyReturn: 0.07, vol: 0.15, gainTax: 0 })).toBeNull();
  });
});

describe('parameters', () => {
  it('researched values exist with a source and are unconfirmed', () => {
    for (const [k, p] of Object.entries(RESEARCHED_RE_PARAMS)) {
      expect(RE_PARAM_KEYS).toContain(k);
      expect(p!.source).toMatch(/^https:\/\//);
      expect(p!.confirmed).toBe(false);
    }
    const d: RealEstateDoc = { scenarios: [], params: { 'rent.taxRate': { value: 0.1, confirmed: false }, 'dti.max': { value: 0.4, confirmed: true } } };
    expect(paramValue(d, 'rent.taxRate')).toBe(0.1);
    expect(paramValue(d, 'prepay.feeFixed', 0.5)).toBe(0.5);
    expect(unconfirmedReParams(d)).toEqual(['rent.taxRate']);
  });
});
