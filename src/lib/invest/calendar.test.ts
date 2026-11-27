// Income calendar — invented data only.
import { describe, it, expect } from 'vitest';
import {
  addMonths, monthRange, windowFor, holdingsIndex, estimateIncomeTax, buildCalendar, monthTotals, yearTotals, upcoming,
  reinvestReminders, type CalItem,
} from './calendar';
import { planAlerts, defaultAlertSettings, emptyAlertState } from './alerts';
import { emptyData, type InvestData, type TaxRules, type Transaction } from './types';

const TODAY = '2026-11-27';

const tx = (o: Partial<Transaction> & Pick<Transaction, 'id' | 'date' | 'type'>): Transaction =>
  ({ accountId: 'brk', currency: 'EUR', ...o });

function sample(): InvestData {
  const d = emptyData();
  d.accounts = [
    { id: 'brk', name: 'Broker străin', type: 'foreign_broker', currency: 'EUR' },
    { id: 'ro', name: 'Broker RO', type: 'ro_broker', currency: 'RON' },
    { id: 'tz', name: 'Tezaur', type: 'gov_bonds', currency: 'RON' },
  ];
  d.instruments = [
    { id: 'etf', name: 'ETF distribuție', ticker: 'DIST', region: 'global', assetClass: 'equity', currency: 'EUR', distribution: 'distributing' },
    { id: 'bvb', name: 'Acțiune BVB', ticker: 'XYZ', isin: 'RO0000000001', region: 'romania', assetClass: 'equity', currency: 'RON' },
    { id: 'tez', name: 'Tezaur 2 ani', region: 'romania', assetClass: 'gov_bond', currency: 'RON', coupon: 0.06, maturity: '2027-03-10', faceValue: 1 },
  ];
  d.transactions = [
    tx({ id: 'b1', date: '2025-01-10', type: 'buy', instrumentId: 'etf', quantity: 100, price: 50 }),
    tx({ id: 'd1', date: '2026-03-20', type: 'dividend', instrumentId: 'etf', amount: 40, withheldTax: 0 }),
    tx({ id: 'b2', date: '2026-04-01', type: 'buy', instrumentId: 'etf', quantity: 100, price: 55 }),
    tx({ id: 'd2', date: '2026-09-20', type: 'dividend', instrumentId: 'etf', amount: 100, withheldTax: 0 }),
    tx({ id: 'b3', date: '2025-03-10', type: 'buy', accountId: 'tz', currency: 'RON', instrumentId: 'tez', quantity: 10000, price: 1 }),
    tx({ id: 'i1', date: '2026-03-10', type: 'interest', accountId: 'tz', currency: 'RON', instrumentId: 'tez', amount: 600 }),
    tx({ id: 'b4', date: '2026-01-05', type: 'buy', accountId: 'ro', currency: 'RON', instrumentId: 'bvb', quantity: 1000, price: 2 }),
  ];
  return d;
}

const p = (value: number, confirmed = true) => ({ value, confirmed });
const RULES: TaxRules = {
  version: 1,
  years: [
    { year: 2026, confirmed: false, params: { 'div.rate': p(0.16), 'int.rate': p(0.1), 'int.govExempt': p(1, false) } },
  ],
};

const byKind = (items: CalItem[], kind: CalItem['kind']) => items.filter(i => i.kind === kind);

describe('dates', () => {
  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2027-03-10', -12)).toBe('2026-03-10');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });
  it('ranges and windows', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(windowFor(TODAY, 12, 24)).toEqual({ from: '2025-11', to: '2028-11' });
  });
});

describe('holdings', () => {
  it('replays buys, sells and transfers per account', () => {
    const h = holdingsIndex([
      tx({ id: '1', date: '2026-01-01', type: 'buy', instrumentId: 'x', quantity: 10, price: 2 }),
      tx({ id: '2', date: '2026-02-01', type: 'sell', instrumentId: 'x', quantity: 4 }),
      tx({ id: '3', date: '2026-03-01', type: 'transfer', instrumentId: 'x', quantity: 6, toAccountId: 'b' }),
    ]);
    expect(h.at('brk', 'x', '2025-12-31')).toBe(0);
    expect(h.at('brk', 'x', '2026-01-15')).toBe(10);
    expect(h.at('brk', 'x', '2026-02-01')).toBe(6);
    expect(h.at('brk', 'x', '2026-03-01')).toBe(0);
    expect(h.at('b', 'x', '2026-03-01')).toBe(6);
    expect(h.avgBuy('brk', 'x')).toBe(2);
  });
});

describe('tax estimate', () => {
  const d = sample();
  const [brk, , tz] = d.accounts;
  it('foreign dividend: RO rate on gross, or the foreign withholding when higher', () => {
    const r = estimateIncomeTax({ rules: RULES, kind: 'dividend', date: '2026-06-01', gross: 100, withheld: 0, account: brk, instrument: d.instruments[0], currency: 'EUR', received: true });
    expect(r).toMatchObject({ tax: 16, taxBasis: 'rate', taxRate: 0.16, taxConfirmed: true });
    expect(estimateIncomeTax({ rules: RULES, kind: 'dividend', date: '2026-06-01', gross: 100, withheld: 30, account: brk, currency: 'USD', received: true }).tax).toBe(30);
  });
  it('Tezaur interest is exempt; unconfirmed flag kept', () => {
    const r = estimateIncomeTax({ rules: RULES, kind: 'interest', date: '2026-06-01', gross: 600, account: tz, instrument: d.instruments[2], currency: 'RON', received: false });
    expect(r).toMatchObject({ tax: 0, taxBasis: 'exempt', taxConfirmed: false });
  });
  it('a year without its own rules uses the previous one, marked unconfirmed', () => {
    const r = estimateIncomeTax({ rules: RULES, kind: 'dividend', date: '2027-06-01', gross: 100, account: brk, currency: 'EUR', received: false });
    expect(r).toMatchObject({ tax: 16, taxConfirmed: false });
  });
  it('no rules at all → unknown tax (or what was withheld)', () => {
    expect(estimateIncomeTax({ rules: null, kind: 'dividend', date: '2026-06-01', gross: 100, account: brk, currency: 'EUR', received: false }))
      .toMatchObject({ tax: null, taxBasis: 'noRules' });
    expect(estimateIncomeTax({ rules: null, kind: 'dividend', date: '2026-06-01', gross: 100, withheld: 10, account: brk, currency: 'EUR', received: true }).tax).toBe(10);
  });
});

describe('buildCalendar', () => {
  it('bonds: yearly coupon counted back from maturity, principal at maturity, Tezaur exempt', () => {
    const items = buildCalendar({ data: sample(), rules: RULES, today: TODAY, from: '2025-11', to: '2028-11' });
    const coupons = byKind(items, 'coupon');
    expect(coupons.map(c => c.date)).toEqual(['2026-03-10', '2027-03-10']);
    expect(coupons[0]).toMatchObject({ gross: 600, tax: 0, net: 600, taxBasis: 'exempt', assumedFrequency: true, status: 'received', matchedTxId: 'i1' });
    expect(coupons[1].status).toBe('upcoming');
    const mat = byKind(items, 'maturity');
    expect(mat).toHaveLength(1);
    expect(mat[0]).toMatchObject({ date: '2027-03-10', gross: 10000, tax: 0, taxBasis: 'principal' });
  });

  it('bonds: George sets the frequency (semiannual) and coupons before the purchase are left out', () => {
    const d = sample();
    d.calendar = { bonds: [{ instrumentId: 'tez', frequency: 2 }] };
    const items = buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2025-01', to: '2027-12' });
    expect(byKind(items, 'coupon').map(c => [c.date, c.gross])).toEqual([
      ['2025-09-10', 300], ['2026-03-10', 300], ['2026-09-10', 300], ['2027-03-10', 300],
    ]);
    expect(byKind(items, 'coupon')[0].assumedFrequency).toBe(false);
    // the 2026-09-10 coupon has no payment recorded
    expect(byKind(items, 'coupon')[2].status).toBe('pending');
  });

  it('no dividend is expected without a schedule', () => {
    const items = buildCalendar({ data: sample(), rules: RULES, today: TODAY, from: '2026-12', to: '2028-11' });
    expect(byKind(items, 'dividend')).toEqual([]);
  });

  it('manual schedule: months × amount per unit × units held', () => {
    const d = sample();
    d.calendar = { dividends: [{ id: 's1', instrumentId: 'bvb', mode: 'manual', months: [6], day: 20, perUnit: 0.1 }] };
    const items = buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2025-11', to: '2027-11' });
    const div = byKind(items, 'dividend').filter(i => i.expected);
    // 2026-06 is past and held (bought 2026-01): expected for comparison, nothing received → pending
    expect(div.map(x => [x.date, x.gross, x.currency, x.status])).toEqual([
      ['2026-06-20', 100, 'RON', 'pending'], ['2027-06-20', 100, 'RON', 'upcoming'],
    ]);
    expect(div[1]).toMatchObject({ tax: 16, net: 84, taxBasis: 'rate', basis: 'schedule' });
  });

  it('"like last year": each payment repeats one year later, scaled to the units held', () => {
    const d = sample();
    d.calendar = { dividends: [{ id: 's2', instrumentId: 'etf', mode: 'lastYear' }] };
    const items = buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2026-11', to: '2028-10' });
    const div = byKind(items, 'dividend').filter(i => i.expected);
    // d1: 40 EUR on 100 units → 0.4/unit, now 200 units → 80; d2: 100 on 200 → 100
    expect(div.map(x => [x.date, x.gross])).toEqual([
      ['2027-03-20', 80], ['2027-09-20', 100], ['2028-03-20', 80], ['2028-09-20', 100],
    ]);
    expect(div.every(x => x.basis === 'lastYear')).toBe(true);
  });

  it('received payments are listed with their tax; matched expected items are marked received', () => {
    const d = sample();
    d.calendar = { dividends: [{ id: 's3', instrumentId: 'etf', mode: 'manual', months: [9], day: 15, perUnit: 0.5 }] };
    const items = buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2026-01', to: '2026-12' });
    const got = items.filter(i => !i.expected && i.kind === 'dividend');
    expect(got.map(g => [g.txId, g.gross, g.tax])).toEqual([['d1', 40, 6.4], ['d2', 100, 16]]);
    const exp = items.find(i => i.expected && i.kind === 'dividend')!;
    expect(exp).toMatchObject({ date: '2026-09-15', gross: 100, status: 'received', matchedTxId: 'd2' });
  });

  it('planned cash-ins repeat until their end date; tax only from George\'s own rate', () => {
    const d = sample();
    d.calendar = { planned: [
      { id: 'p1', date: '2026-12-05', label: 'Chirie', amount: 1000, currency: 'RON', repeat: 'monthly', until: '2027-02-28', taxRate: 0.08 },
      { id: 'p2', date: '2027-07-01', label: 'Bonus', amount: 500, currency: 'EUR' },
    ] };
    const items = byKind(buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2026-11', to: '2027-12' }), 'planned');
    expect(items.map(i => [i.date, i.tax])).toEqual([['2026-12-05', 80], ['2027-01-05', 80], ['2027-02-05', 80], ['2027-07-01', null]]);
    expect(items[3].taxBasis).toBe('unknown');
  });

  it('a maturity keeps the reinvest marker that matches its date', () => {
    const d = sample();
    d.calendar = { reinvest: [{ instrumentId: 'tez', maturity: '2027-03-10', remind: true, daysBefore: 14, note: 'Tezaur nou' }] };
    const m = byKind(buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2027-01', to: '2027-12' }), 'maturity')[0];
    expect(m.reinvest).toMatchObject({ remind: true, daysBefore: 14 });
  });
});

describe('totals', () => {
  const d = sample();
  d.calendar = {
    dividends: [{ id: 's', instrumentId: 'etf', mode: 'lastYear' }],
    planned: [{ id: 'p', date: '2027-03-01', label: 'X', amount: 100, currency: 'RON' }],
  };
  const items = buildCalendar({ data: d, rules: RULES, today: TODAY, from: '2026-01', to: '2027-12' });
  const conv = (a: number, cur: string) => (cur === 'EUR' ? a * 5 : a);
  const months = monthTotals(items, monthRange('2026-01', '2027-12'), conv);

  it('per month: expected vs received, principal apart, unknown tax counted at gross', () => {
    const sep26 = months.find(m => m.month === '2026-09')!;
    expect(sep26.received).toMatchObject({ gross: 500, tax: 80, net: 420, count: 1 });
    const mar27 = months.find(m => m.month === '2027-03')!;
    // coupon 600 (exempt) + dividend 80 EUR = 400 RON (tax 64) + planned 100 RON (tax unknown)
    expect(mar27.expected).toMatchObject({ gross: 1100, tax: 64, net: 1036, count: 3, taxUnknown: 1 });
    expect(mar27.principal).toBe(10000);
  });

  it('per year', () => {
    const y = yearTotals(months);
    expect(y.map(t => t.year)).toEqual([2026, 2027]);
    expect(y[0].received.gross).toBe(200 + 500 + 600);
    expect(y[1].principal).toBe(10000);
  });

  it('missing FX is counted, not guessed', () => {
    const m = monthTotals(items, ['2026-09'], (a, cur) => (cur === 'EUR' ? null : a));
    expect(m[0]).toMatchObject({ missingFx: 1, received: { count: 0 } });
  });

  it('next 30 days', () => {
    const all = buildCalendar({ data: sample(), rules: RULES, today: '2027-02-20', from: '2027-01', to: '2027-12' });
    expect(upcoming(all, '2027-02-20').map(i => i.kind)).toEqual(['coupon', 'maturity']);
  });
});

describe('reinvest reminders', () => {
  const d = sample();
  d.calendar = { reinvest: [
    { instrumentId: 'tez', maturity: '2027-03-10', remind: true, daysBefore: 14, note: 'Tezaur nou' },
    { instrumentId: 'etf', maturity: '2027-03-10', remind: true, daysBefore: 14 },
  ] };

  it('only for held instruments whose maturity matches', () => {
    const r = reinvestReminders(d, TODAY);
    expect(r).toEqual([{ key: 'tez|2027-03-10', instrumentId: 'tez', label: 'Tezaur 2 ani', maturity: '2027-03-10', daysBefore: 14, note: 'Tezaur nou', amount: 10000, currency: 'RON' }]);
    const off = structuredClone(d);
    off.calendar!.reinvest![0].remind = false;
    expect(reinvestReminders(off, TODAY)).toEqual([]);
  });

  it('the alerts planner sends it once, inside the window, without amounts by default', () => {
    const base = { now: '2027-02-25T18:00:00Z', settings: { ...defaultAlertSettings(), emailEnabled: true }, instruments: [], ips: null, pageUrl: 'https://geoli.eu/x/', calendarUrl: 'https://geoli.eu/vault/invest/calendar/' };
    const early = planAlerts({ ...base, today: '2027-02-20', state: emptyAlertState(), reinvest: reinvestReminders(d, '2027-02-20') });
    expect(early.items).toEqual([]);
    const p1 = planAlerts({ ...base, today: '2027-02-25', state: early.state, reinvest: reinvestReminders(d, '2027-02-25') });
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0].kind).toBe('reinvest');
    expect(p1.items[0].line).toContain('peste 13 zile');
    expect(p1.items[0].line).toContain('Nota ta: „Tezaur nou”.');
    expect(p1.items[0].line).not.toContain('Valoare nominală');
    expect(p1.subject).toContain('de reinvestit');
    const p2 = planAlerts({ ...base, today: '2027-02-26', state: p1.state, reinvest: reinvestReminders(d, '2027-02-26') });
    expect(p2.items).toEqual([]);
  });
});

describe('validator', () => {
  it('accepts the calendar block and rejects bad values', async () => {
    const { validateDoc } = await import('./validate');
    const d = sample();
    d.calendar = {
      dividends: [{ id: 'a', instrumentId: 'etf', mode: 'manual', months: [3, 9], day: 15, perUnit: 0.4 }],
      planned: [{ id: 'p', date: '2027-01-01', label: 'X', amount: 1, currency: 'RON', repeat: 'yearly', taxRate: 0.1 }],
      bonds: [{ instrumentId: 'tez', frequency: 2 }],
      reinvest: [{ instrumentId: 'tez', maturity: '2027-03-10', remind: true, daysBefore: 7 }],
    };
    expect(validateDoc('data', d)).toEqual([]);
    const bad = structuredClone(d);
    (bad.calendar!.bonds![0] as { frequency: number }).frequency = 3;
    bad.calendar!.dividends![0].months = [13];
    expect(validateDoc('data', bad).length).toBe(2);
  });
});
