import { describe, it, expect } from 'vitest';
import type { MortgageLoan } from './types';
import {
  addMonths, monthsBetween, annuityPayment, annuityMonths, prepaymentPlan, schedule, dae, prepaymentSavings, ageIn, debtToIncome, balanceAt, rateFor,
} from './mortgage';

// Invented loans only.
const base: MortgageLoan = { months: 360, type: 'annuity', startMonth: '2026-01', fixedRate: 0.06, fixedMonths: 360 };

describe('helpers', () => {
  it('month arithmetic', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2026-01', '2028-03')).toBe(26);
  });

  it('annuity formula: 100 000 at 6% over 30 years = 599.55', () => {
    expect(annuityPayment(100_000, 0.06 / 12, 360)).toBeCloseTo(599.55, 2);
    expect(annuityPayment(1200, 0, 12)).toBe(100);
    expect(annuityMonths(100_000, 0.005, annuityPayment(100_000, 0.005, 360))).toBe(360);
    expect(annuityMonths(100_000, 0.005, 400)).toBe(Infinity);
  });

  it('recurring prepayments expand; same month adds up', () => {
    const p = prepaymentPlan([
      { id: 'a', kind: 'recurring', amountRon: 500, month: '2026-03', count: 3, everyMonths: 1, effect: 'term' },
      { id: 'b', kind: 'once', amountRon: 1000, month: '2026-04', effect: 'installment' },
    ]);
    expect([...p.keys()]).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(p.get('2026-04')).toEqual({ amount: 1500, effect: 'installment' });
  });
});

describe('schedule', () => {
  it('fixed annuity: 360 equal instalments, balance 0, interest = total − principal', () => {
    const s = schedule(base, 100_000);
    expect(s.rows).toHaveLength(360);
    expect(s.rows[0].payment).toBeCloseTo(599.55, 2);
    expect(s.rows[0].interest).toBeCloseTo(500, 6);
    expect(s.rows.at(-1)!.balance).toBeCloseTo(0, 6);
    expect(s.summary.totalInterest).toBeCloseTo(599.5505 * 360 - 100_000, 0);
    expect(s.summary.endMonth).toBe('2055-12');
  });

  it('switches to IRCC + margin after the fixed period and recomputes over the remaining term', () => {
    const loan: MortgageLoan = { ...base, fixedRate: 0.05, fixedMonths: 36, ircc: 0.06, margin: 0.02 };
    const s = schedule(loan, 100_000);
    expect(rateFor(loan, 36).phase).toBe('fixed');
    expect(rateFor(loan, 37).rate).toBeCloseTo(0.08, 12);
    const bal36 = s.rows[35].balance;
    expect(s.rows[36].payment).toBeCloseTo(annuityPayment(bal36, 0.08 / 12, 324), 6);
    expect(s.summary.variablePayment).toBeCloseTo(s.rows[36].payment, 6);
    expect(s.rows).toHaveLength(360);
    // +1 pp IRCC scenario costs more
    expect(schedule(loan, 100_000, { irccShift: 0.01 }).summary.totalInterest).toBeGreaterThan(s.summary.totalInterest);
  });

  it('flags a missing IRCC and keeps the fixed rate', () => {
    const s = schedule({ ...base, fixedMonths: 12 }, 50_000);
    expect(s.summary.variableRateMissing).toBe(true);
  });

  it('decreasing instalments: equal principal parts', () => {
    const s = schedule({ ...base, type: 'decreasing', months: 120 }, 120_000);
    expect(s.rows[0].principal).toBeCloseTo(1000, 6);
    expect(s.rows[0].payment).toBeCloseTo(1600, 6);
    expect(s.rows.at(-1)!.payment).toBeCloseTo(1005, 6);
    expect(s.rows).toHaveLength(120);
  });

  it('prepayment "term" shortens the loan, "installment" lowers the instalment', () => {
    const term = schedule(base, 100_000, { prepayments: [{ id: 'p', kind: 'once', amountRon: 20_000, month: '2026-12', effect: 'term' }] });
    const inst = schedule(base, 100_000, { prepayments: [{ id: 'p', kind: 'once', amountRon: 20_000, month: '2026-12', effect: 'installment' }] });
    expect(term.rows.length).toBeLessThan(360);
    expect(term.rows[12].payment).toBeCloseTo(term.rows[0].payment, 6);
    expect(inst.rows).toHaveLength(360);
    const bal = inst.rows[11].balance;
    expect(inst.rows[12].payment).toBeCloseTo(annuityPayment(bal, 0.005, 348), 6);
    // Shortening saves more interest than lowering the instalment
    expect(term.summary.totalInterest).toBeLessThan(inst.summary.totalInterest);
    for (const s of [term, inst]) expect(s.rows.at(-1)!.balance).toBeCloseTo(0, 6);
  });

  it('recurring prepayments and their fee', () => {
    const s = schedule({ ...base, fixedMonths: 60, ircc: 0.05, margin: 0.02 }, 100_000, {
      prepayments: [{ id: 'r', kind: 'recurring', amountRon: 1000, month: '2026-01', count: 120, everyMonths: 1, effect: 'term' }],
      prepayFee: { fixed: 0.01, variable: 0 },
    });
    // Prepaid until the loan is gone (less than 120 × 1000 because it ends first)
    expect(s.summary.totalPrepaid).toBeGreaterThan(60_000);
    expect(s.summary.totalPrepaid).toBeLessThanOrEqual(120_000);
    // Fee only during the 60 fixed months: 60 × 1000 × 1%
    expect(s.summary.prepaymentFees).toBeCloseTo(600, 6);
    expect(s.rows.length).toBeLessThan(130);
  });

  it('prepayment larger than the balance closes the loan', () => {
    const s = schedule(base, 10_000, { prepayments: [{ id: 'x', kind: 'once', amountRon: 50_000, month: '2026-02', effect: 'term' }] });
    expect(s.rows).toHaveLength(2);
    expect(s.summary.totalPrepaid).toBeLessThan(10_000);
  });
});

describe('DAE, savings, ages', () => {
  it('DAE equals the effective rate without costs and is higher with costs', () => {
    const s = schedule(base, 100_000);
    expect(dae(base, 100_000, s.rows)).toBeCloseTo(Math.pow(1 + 0.06 / 12, 12) - 1, 4);
    const costly: MortgageLoan = { ...base, upfrontFeesRon: 2000, monthlyFeeRon: 20, lifeInsuranceRate: 0.003 };
    const sc = schedule(costly, 100_000);
    expect(dae(costly, 100_000, sc.rows)!).toBeGreaterThan(0.068);
  });

  it('savings from prepayments', () => {
    const a = schedule(base, 100_000).summary;
    const b = schedule(base, 100_000, { prepayments: [{ id: 'p', kind: 'once', amountRon: 20_000, month: '2026-12', effect: 'term' }] }).summary;
    const s = prepaymentSavings(a, b);
    expect(s.interestSaved).toBeGreaterThan(30_000);
    expect(s.monthsSaved).toBeGreaterThan(60);
    expect(s.netSaved).toBeCloseTo(s.interestSaved, 6);
  });

  it('ages, debt-to-income, balance on a date', () => {
    expect(ageIn(1988, '2055-12')).toBe(67);
    expect(ageIn(undefined, '2055-12')).toBeNull();
    expect(debtToIncome(3000, 10_000, 500)).toBeCloseTo(0.35, 12);
    expect(debtToIncome(3000, undefined)).toBeNull();
    const s = schedule(base, 100_000);
    expect(balanceAt(s.rows, 100_000, '2025-12')).toBe(100_000);
    expect(balanceAt(s.rows, 100_000, '2026-01')).toBeCloseTo(s.rows[0].balance, 6);
  });
});
