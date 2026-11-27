import { describe, it, expect } from 'vitest';
import { diffLines, diffVersions, rulesToLines, hasChanges } from './ips-diff';
import { IPS_SECTIONS, IPS_SECTION_KEYS } from './ips-sections';

const fmt = (ops: ReturnType<typeof diffLines>) => ops.map(o => (o.type === 'same' ? ' ' : o.type === 'add' ? '+' : '-') + o.text);

describe('diffLines', () => {
  it('finds inserted, removed and changed lines', () => {
    expect(fmt(diffLines('a\nb\nc', 'a\nx\nc\nd'))).toEqual([' a', '-b', '+x', ' c', '+d']);
    expect(fmt(diffLines('', 'a'))).toEqual(['+a']);
    expect(fmt(diffLines('a', ''))).toEqual(['-a']);
    expect(diffLines('', '')).toEqual([]);
  });
  it('treats CRLF like LF', () => {
    expect(hasChanges(diffLines('a\r\nb', 'a\nb'))).toBe(false);
  });
  it('keeps the common head and tail around a middle edit', () => {
    const a = Array.from({ length: 300 }, (_, i) => `l${i}`);
    const b = [...a]; b[150] = 'changed';
    expect(fmt(diffLines(a.join('\n'), b.join('\n'))).filter(l => l[0] !== ' ')).toEqual(['-l150', '+changed']);
  });
});

describe('diffVersions', () => {
  it('lists only changed sections, in outline order, and diffs the rules', () => {
    const before = { sections: { goals: 'A', risk: 'R', extra: 'E' }, rules: { reviewMonth: 1 } };
    const after = { sections: { goals: 'A', risk: 'R2', horizon: 'H' }, rules: { reviewMonth: 2, driftAlerts: true } };
    const d = diffVersions(before, after, IPS_SECTION_KEYS);
    expect(d.sections.map(s => s.key)).toEqual(['horizon', 'risk', 'extra']);
    expect(fmt(d.rules)).toEqual(['-Revizuire anuală: ianuarie', '+Alertă la ieșirea din bandă: da', '+Revizuire anuală: februarie']);
  });
  it('no rules change → empty rules diff', () => {
    expect(diffVersions({ sections: {} }, { sections: {} }, []).rules).toEqual([]);
  });
});

describe('rulesToLines', () => {
  it('uses display names and sorts crash rules by depth', () => {
    const lines = rulesToLines({
      emergencyFund: { months: 6, monthlyExpenses: 1500, accountIds: ['a1'] },
      crash: { referenceInstrumentId: 'i1', rules: [{ id: 'y', dropPct: 0.3 }, { id: 'x', dropPct: 0.2, action: 'cumpăr', extraAmount: 500 }] },
    }, { account: () => 'Cash', instrument: () => 'VWCE' });
    expect(lines).toEqual([
      'Fond de urgență: 6 luni × 1.500 € pe lună',
      'Fond de urgență, conturi: Cash',
      'Reguli la căderi, măsurate pe: VWCE',
      'La −20% sub maxim: cumpăr · 500 € în plus',
      'La −30% sub maxim: —',
    ]);
  });
});

describe('IPS outline', () => {
  it('has unique keys and only questions (no pre-written answers)', () => {
    expect(new Set(IPS_SECTION_KEYS).size).toBe(IPS_SECTION_KEYS.length);
    for (const s of IPS_SECTIONS) for (const q of s.questions) expect(q.trim().endsWith('?')).toBe(true);
  });
});
