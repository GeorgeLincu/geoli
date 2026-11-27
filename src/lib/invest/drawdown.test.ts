import { describe, it, expect } from 'vitest';
import {
  mergeSeries, seriesFor, highOf, belowHigh, underwater, drawdownEpisodes, drawdownStats,
  normalizeLevels, levelsFromIps, deepestLevel, nextAlertLevel, type Point, type HistoryDoc,
} from './drawdown';
import type { PricesYear } from './market';

const pts = (...xs: [string, number][]): Point[] => xs.map(([date, close]) => ({ date, close }));

describe('mergeSeries / seriesFor', () => {
  it('sorts, de-duplicates (later wins) and drops invalid points', () => {
    const s = mergeSeries(pts(['2024-01-03', 10], ['2024-01-01', 8]), pts(['2024-01-03', 11], ['bad', 5], ['2024-01-04', 0]));
    expect(s).toEqual(pts(['2024-01-01', 8], ['2024-01-03', 11]));
  });

  it('joins weekly history and the daily price store', () => {
    const h: HistoryDoc = {
      version: 1, instrumentId: 'x', symbol: 'X', currency: 'EUR', fetchedAt: '2025-01-01T00:00:00Z',
      weekly: [['2020-01-06', 50], ['2024-12-29', 70], ['2025-01-05', 99]],
    };
    const y24: PricesYear = { version: 1, year: 2024, updated: '', prices: { x: { '2024-12-30': { close: 71, currency: 'EUR', source: 'yahoo' }, '2024-12-31': { close: 72, currency: 'EUR', source: 'yahoo' } } } };
    const store: PricesYear = { version: 1, year: 2025, updated: '', prices: { x: { '2025-01-02': { close: 73, currency: 'EUR', source: 'yahoo' } }, y: { '2025-01-02': { close: 1, currency: 'EUR', source: 'yahoo' } } } };
    expect(seriesFor('x', h, [y24, store])).toEqual(pts(['2020-01-06', 50], ['2024-12-29', 70], ['2024-12-30', 71], ['2024-12-31', 72], ['2025-01-02', 73]));
    expect(seriesFor('x', null, [])).toEqual([]);
  });
});

describe('highs and drawdowns', () => {
  const s = pts(
    ['2020-01-01', 100], ['2020-02-01', 120], ['2020-03-01', 60], ['2020-04-01', 90],
    ['2020-05-01', 125], ['2020-06-10', 110], ['2021-06-01', 100],
  );

  it('highOf picks the earliest highest close', () => {
    expect(highOf(pts(['a', 1], ['b', 3], ['c', 3]))?.date).toBe('b');
    expect(highOf([])).toBeNull();
  });

  it('belowHigh is a non-negative fraction', () => {
    expect(belowHigh(75, 100)).toBeCloseTo(0.25);
    expect(belowHigh(110, 100)).toBe(0);
    expect(belowHigh(5, 0)).toBe(0);
  });

  it('underwater tracks the running high', () => {
    const u = underwater(s);
    expect(u.map(x => Math.round(x.dd * 100))).toEqual([0, 0, 50, 25, 0, 12, 20]);
  });

  it('episodes: peak → trough → recovery, deepest first, open episode has no recovery', () => {
    const e = drawdownEpisodes(s, 0.05);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ peak: { date: '2020-02-01' }, trough: { date: '2020-03-01', close: 60 }, recovery: '2020-05-01' });
    expect(e[0].depth).toBeCloseTo(0.5);
    expect(e[1]).toMatchObject({ peak: { date: '2020-05-01' }, trough: { date: '2021-06-01' }, recovery: null });
    expect(e[1].depth).toBeCloseTo(0.2);
    expect(drawdownEpisodes(s, 0.3)).toHaveLength(1);
  });

  it('stats: ATH, 52-week high, distance below each, max drawdown', () => {
    const st = drawdownStats(s)!;
    expect(st.last).toEqual({ date: '2021-06-01', close: 100 });
    expect(st.ath).toEqual({ date: '2020-05-01', close: 125 });
    expect(st.high52).toEqual({ date: '2020-06-10', close: 110 }); // 2020-05-01 is more than 52 weeks before
    expect(st.belowAth).toBeCloseTo(0.2);
    expect(st.below52).toBeCloseTo(1 - 100 / 110);
    expect(st.maxDrawdown?.depth).toBeCloseTo(0.5);
    expect(st.daysSinceAth).toBe(396);
    expect(st.from).toBe('2020-01-01');
    expect(drawdownStats([])).toBeNull();
  });

  it('at a new high everything is zero', () => {
    const st = drawdownStats(pts(['2024-01-01', 1], ['2024-01-02', 2]))!;
    expect(st.belowAth).toBe(0);
    expect(st.below52).toBe(0);
    expect(st.daysSinceAth).toBe(0);
    expect(st.maxDrawdown).toBeNull();
  });
});

describe('levels', () => {
  it('normalizeLevels accepts 10 or 0.1, negatives, removes duplicates and junk', () => {
    const l = normalizeLevels([20, { pct: -10, extraAmount: 500, currency: 'EUR', note: ' x ' }, { pct: 0.1 }, 'x', { pct: 150 }, { pct: 0 }, null]);
    expect(l).toEqual([{ pct: 0.1 }, { pct: 0.2 }]);
    const m = normalizeLevels([{ pct: -10, extraAmount: 500, currency: 'EUR', note: ' x ' }]);
    expect(m).toEqual([{ pct: 0.1, extraAmount: 500, currency: 'EUR', note: 'x' }]);
  });

  it('levelsFromIps reads the latest IPS version, tolerant to shape', () => {
    const ips = {
      version: 1,
      versions: [
        { date: '2026-01-01', sections: {}, rules: { dipBuys: [{ belowHighPct: 15 }] } },
        { date: '2026-06-01', sections: {}, rules: { dipBuys: [{ belowHighPct: 10, extraAmount: 300 }, { belowHighPct: 30 }] } },
      ],
    };
    expect(levelsFromIps(ips)).toEqual([{ pct: 0.1, extraAmount: 300 }, { pct: 0.3 }]);
    expect(levelsFromIps({ version: 1, versions: [] })).toEqual([]);
    expect(levelsFromIps(null)).toEqual([]);
    expect(levelsFromIps({ dipLevels: [25] })).toEqual([{ pct: 0.25 }]);
  });

  const L = normalizeLevels([10, 20, 30]);

  it('deepestLevel', () => {
    expect(deepestLevel(0.05, L)).toBe(0);
    expect(deepestLevel(0.1, L)).toBe(0.1);
    expect(deepestLevel(0.25, L)).toBe(0.2);
    expect(deepestLevel(0.5, L)).toBe(0.3);
  });

  it('nextAlertLevel announces each level once per crossing', () => {
    let s = nextAlertLevel(0, 0.12, L);
    expect(s).toEqual({ level: 0.1, newly: [0.1] });
    s = nextAlertLevel(s.level, 0.11, L); // still below −10 %: nothing new
    expect(s).toEqual({ level: 0.1, newly: [] });
    s = nextAlertLevel(s.level, 0.09, L); // hovering just above: not re-armed (hysteresis 2.5 pp)
    expect(s).toEqual({ level: 0.1, newly: [] });
    s = nextAlertLevel(s.level, 0.12, L);
    expect(s.newly).toEqual([]);
    s = nextAlertLevel(s.level, 0.33, L); // gap down through two levels
    expect(s).toEqual({ level: 0.3, newly: [0.2, 0.3] });
    s = nextAlertLevel(s.level, 0.15, L); // recovered above −17.5 %: −30 and −20 re-armed, −10 still held
    expect(s).toEqual({ level: 0.1, newly: [] });
    s = nextAlertLevel(s.level, 0.21, L);
    expect(s).toEqual({ level: 0.2, newly: [0.2] });
    s = nextAlertLevel(s.level, 0, L); // new high: everything re-armed
    expect(s).toEqual({ level: 0, newly: [] });
  });
});
