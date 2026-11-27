import { describe, it, expect } from 'vitest';
import {
  activeIpsRules, latestIpsVersion, ipsAlerts, monthContributions, drawdownFromCloses, triggeredCrashRules, daysBetween,
  type IpsFacts,
} from './ips-checks';
import type { IpsDoc, IpsRules, Transaction, TargetAllocation } from './types';
import type { DriftResult } from './portfolio';
import { validateDoc } from './validate';

const doc = (rules: IpsRules | undefined, date = '2026-01-10'): IpsDoc => ({
  version: 1,
  versions: [
    { date: '2025-03-01', sections: {}, rules: { reviewMonth: 3 } },
    { date, sections: { goals: 'x' }, rules },
  ],
});
const facts = (f: Partial<IpsFacts> = {}): IpsFacts => ({ today: '2026-11-27', ...f });
const ids = (doc: IpsDoc, f: Partial<IpsFacts>) => ipsAlerts(doc, facts(f)).map(a => `${a.level}:${a.id}`);

const target = (id: string, weight: number, band?: number): TargetAllocation => ({ id, label: id, assetClass: 'equity', weight, band });
const drift = (rows: [TargetAllocation, number, 'ok' | 'over' | 'under'][]): DriftResult => ({
  rows: rows.map(([t, actual, status]) => ({ target: t, value: actual * 1000, actualWeight: actual, diff: actual - t.weight, status })),
  unmatched: 0, total: 1000, weightSum: 1,
});

describe('reading ips.json', () => {
  it('picks the newest version by date and ignores the draft', () => {
    const d: IpsDoc = { ...doc({ reviewMonth: 5 }), draft: { savedAt: '2026-11-01T00:00:00Z', sections: {}, rules: { reviewMonth: 1 } } };
    expect(latestIpsVersion(d)?.date).toBe('2026-01-10');
    expect(activeIpsRules(d)?.rules).toEqual({ reviewMonth: 5 });
  });
  it('returns null without versions or rules', () => {
    expect(activeIpsRules(null)).toBeNull();
    expect(activeIpsRules({ version: 1, versions: [] })).toBeNull();
    expect(activeIpsRules(doc(undefined))).toBeNull();
    expect(ipsAlerts(doc(undefined), facts())).toEqual([]);
  });
  it('the doc with rules and a draft passes the validator', () => {
    const d: IpsDoc = {
      ...doc({
        driftAlerts: true, emergencyFund: { months: 6, monthlyExpenses: 2000, accountIds: ['a1'] },
        contribution: { amount: 500, day: 5, graceDays: 3 }, reviewMonth: 1, taxReturn: { month: 5, day: 25 },
        crash: { referenceInstrumentId: 'i1', rules: [{ id: 'r1', dropPct: 0.2, action: 'text', extraAmount: 1000 }] },
      }),
      draft: { savedAt: '2026-11-01T00:00:00Z', sections: { goals: 'y' } },
    };
    expect(validateDoc('ips', d)).toEqual([]);
    expect(validateDoc('ips', doc({ reviewMonth: 13 }))).not.toEqual([]);
    expect(validateDoc('ips', doc({ contribution: { amount: 1, day: 0 } }))).not.toEqual([]);
    expect(validateDoc('ips', doc({ crash: { rules: [{ id: 'r', dropPct: 20 }] } }))).not.toEqual([]);
    expect(validateDoc('ips', doc({ unknown: 1 } as IpsRules))).not.toEqual([]);
  });
});

describe('drift', () => {
  it('one alert per row outside its band', () => {
    const d = drift([[target('eq', 0.8, 0.05), 0.9, 'over'], [target('bd', 0.2), 0.1, 'under'], [target('gd', 0, 0.02), 0, 'ok']]);
    expect(ids(doc({ driftAlerts: true }), { drift: d })).toEqual(['warn:drift:eq', 'warn:drift:bd']);
  });
  it('off → nothing; no valuation → info', () => {
    expect(ids(doc({ driftAlerts: false }), { drift: drift([[target('eq', 1), 0.5, 'under']]) })).toEqual([]);
    expect(ids(doc({ driftAlerts: true }), {})).toEqual(['info:drift']);
  });
});

describe('emergency fund', () => {
  const rules: IpsRules = { emergencyFund: { months: 6, monthlyExpenses: 1000, accountIds: ['a1', 'a2'] } };
  it('warns below N months, silent at or above', () => {
    expect(ids(doc(rules), { accountValuesEur: new Map([['a1', 3000], ['a2', 2000]]) })).toEqual(['warn:emergency']);
    expect(ids(doc(rules), { accountValuesEur: new Map([['a1', 4000], ['a2', 2000]]) })).toEqual([]);
    const a = ipsAlerts(doc(rules), facts({ accountValuesEur: new Map([['a1', 3000], ['a2', null]]) }))[0];
    expect(a.detail).toContain('3,0 luni');
    expect(a.detail).toContain('fără curs');
  });
  it('asks for accounts when none are chosen', () => {
    expect(ids(doc({ emergencyFund: { months: 3, monthlyExpenses: 1000, accountIds: [] } }), {})).toEqual(['info:emergency']);
  });
});

describe('monthly contribution', () => {
  const rules: IpsRules = { contribution: { amount: 500, day: 5, graceDays: 3 } };
  const none = { eur: 0, count: 0, unconverted: 0 };
  it('silent before day + grace, warns after', () => {
    expect(ids(doc(rules), { today: '2026-11-08', contributions: none })).toEqual([]);
    expect(ids(doc(rules), { today: '2026-11-09', contributions: none })).toEqual(['warn:contribution']);
  });
  it('partial vs complete', () => {
    const partial = ipsAlerts(doc(rules), facts({ contributions: { eur: 200, count: 1, unconverted: 0 } }));
    expect(partial[0].title).toContain('incompletă');
    expect(ids(doc(rules), { contributions: { eur: 497, count: 1, unconverted: 0 } })).toEqual([]);
  });
  it('day 31 + grace in a short month clamps to the month end', () => {
    const r: IpsRules = { contribution: { amount: 100, day: 31, graceDays: 5 } };
    expect(ids(doc(r), { today: '2026-02-28', contributions: none })).toEqual([]);
  });
  it('monthContributions: deposits win over buys, other months ignored, missing rates counted', () => {
    const t = (o: Partial<Transaction>): Transaction => ({ id: Math.random().toString(), date: '2026-11-03', type: 'buy', accountId: 'a', currency: 'EUR', ...o });
    const toEur = (amount: number, c: string) => (c === 'EUR' ? amount : c === 'RON' ? amount / 5 : null);
    const buys = [t({ quantity: 2, price: 100, fees: 1 }), t({ quantity: 1, price: 50, date: '2026-10-30' }), t({ quantity: 1, price: 10, date: '2026-11-28' })];
    expect(monthContributions(buys, '2026-11-27', toEur)).toEqual({ eur: 201, count: 1, unconverted: 0 });
    const withDeposits = [...buys, t({ type: 'deposit', amount: 1000, currency: 'RON' }), t({ type: 'deposit', amount: 10, currency: 'USD' })];
    expect(monthContributions(withDeposits, '2026-11-27', toEur)).toEqual({ eur: 200, count: 2, unconverted: 1 });
  });
});

describe('annual review', () => {
  it('due from the review month until a newer version exists', () => {
    expect(ids(doc({ reviewMonth: 11 }, '2026-01-10'), { today: '2026-10-31' })).toEqual([]);
    expect(ids(doc({ reviewMonth: 11 }, '2026-01-10'), { today: '2026-11-01' })).toEqual(['warn:review']);
    expect(ids(doc({ reviewMonth: 11 }, '2026-11-02'), { today: '2026-11-27' })).toEqual([]);
    expect(ids(doc({ reviewMonth: 1 }, '2025-12-20'), { today: '2026-11-27' })).toEqual(['warn:review']);
  });
});

describe('tax return reminder', () => {
  const rules: IpsRules = { taxReturn: { month: 5, day: 25, remindDaysBefore: 30 } };
  it('only inside the reminder window; warn in the last week', () => {
    expect(ids(doc(rules), { today: '2026-04-24' })).toEqual([]);
    expect(ids(doc(rules), { today: '2026-04-25' })).toEqual(['info:tax']);
    expect(ids(doc(rules), { today: '2026-05-20' })).toEqual(['warn:tax']);
    expect(ipsAlerts(doc(rules), facts({ today: '2026-05-25' }))[0].title).toContain('Azi');
    expect(ids(doc(rules), { today: '2026-05-26' })).toEqual([]);
  });
  it('daysBetween', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    expect(daysBetween('2026-03-01', '2026-02-27')).toBe(-2);
  });
});

describe('crash rules', () => {
  const rules: IpsRules = { crash: { referenceInstrumentId: 'i1', rules: [{ id: 'a', dropPct: 0.1, action: 'A' }, { id: 'b', dropPct: 0.2, action: 'B', extraAmount: 1000 }] } };
  it('drawdownFromCloses: latest vs highest', () => {
    const dd = drawdownFromCloses([['2026-01-02', 100], ['2026-03-01', 120], ['2026-11-27', 90], ['2026-06-01', 0]]);
    expect(dd).toEqual({ pct: 0.25, high: 120, highDate: '2026-03-01', last: 90, lastDate: '2026-11-27' });
    expect(drawdownFromCloses([])).toBeNull();
  });
  it('triggered rules are sorted deepest first', () => {
    expect(triggeredCrashRules(rules.crash!.rules, 0.25).map(r => r.id)).toEqual(['b', 'a']);
    expect(triggeredCrashRules(rules.crash!.rules, 0.1).map(r => r.id)).toEqual(['a']);
    expect(triggeredCrashRules(rules.crash!.rules, 0.05)).toEqual([]);
  });
  it('alert names the deepest rule; info without prices', () => {
    const dd = { pct: 0.22, high: 100, highDate: '2026-01-01', last: 78, lastDate: '2026-11-27' };
    const a = ipsAlerts(doc(rules), facts({ drawdown: dd, instrumentName: () => 'VWCE' }));
    expect(a.map(x => x.id)).toEqual(['crash']);
    expect(a[0].title).toContain('VWCE');
    expect(a[0].detail).toContain('B');
    expect(ids(doc(rules), { drawdown: { ...dd, pct: 0.05 } })).toEqual([]);
    expect(ids(doc(rules), { drawdown: null })).toEqual(['info:crash']);
  });
});

it('warnings come before info', () => {
  const rules: IpsRules = { taxReturn: { month: 12, day: 20 }, reviewMonth: 11 };
  expect(ids(doc(rules), {})).toEqual(['warn:review', 'info:tax']);
});
