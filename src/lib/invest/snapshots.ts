// Year-end snapshots (Phase 7): invest/snapshots/<year>-12-31.json.
// Created automatically from the ledger + prices (portfolioAt) and netWorthAt once a year is over; George can
// correct the values, enter the year's inflation and a note. Recalculating keeps his fields.
import { SCHEMA_VERSION, type YearSnapshot } from './types';
import type { PortfolioPoint } from './report';
import type { NetWorthAt } from './networth';

export const snapshotKey = (year: number) => `invest/snapshots/${year}-12-31.json`;
export const SNAPSHOT_PREFIX = 'invest/snapshots/';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** New or recalculated snapshot. George's corrections, inflation and note from `prev` are kept. */
export function buildSnapshot(year: number, p: PortfolioPoint, nw: NetWorthAt, now: string, prev?: YearSnapshot | null): YearSnapshot {
  const byAssetClass = Object.fromEntries(Object.entries(p.byClass).map(([k, v]) => [k, r2(v ?? 0)]));
  const out: YearSnapshot = {
    version: SCHEMA_VERSION,
    year,
    date: `${year}-12-31`,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    computed: {
      computedAt: now,
      portfolioEur: r2(p.eur), portfolioRon: r2(p.ron), byAssetClass,
      netWorthEur: r2(nw.netEur), netWorthRon: r2(nw.netRon),
      atCost: p.atCost, missingFx: [...new Set([...p.missingFx, ...nw.missingFx])].sort(),
    },
  };
  if (prev?.portfolioEur !== undefined) out.portfolioEur = prev.portfolioEur;
  if (prev?.netWorthEur !== undefined) out.netWorthEur = prev.netWorthEur;
  if (prev?.inflation) out.inflation = prev.inflation;
  if (prev?.note) out.note = prev.note;
  return out;
}

/** Values the reports use: George's correction, else the computed one. */
export const snapshotPortfolio = (s: YearSnapshot) => s.portfolioEur ?? s.computed.portfolioEur;
export const snapshotNetWorth = (s: YearSnapshot) => s.netWorthEur ?? s.computed.netWorthEur;
export const isEdited = (s: YearSnapshot) => s.portfolioEur !== undefined || s.netWorthEur !== undefined;

/** Portfolio values to force into the history (only corrected ones; computed ones equal the live value). */
export function snapshotOverrides(snaps: readonly YearSnapshot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of snaps) if (s.portfolioEur !== undefined) m.set(s.date, s.portfolioEur);
  return m;
}

/** Closed years (before `today`'s year) with activity and no snapshot yet. */
export function missingSnapshotYears(years: readonly number[], snaps: readonly YearSnapshot[], today: string): number[] {
  const have = new Set(snaps.map(s => s.year));
  const current = +today.slice(0, 4);
  return years.filter(y => y < current && !have.has(y)).sort((a, b) => a - b);
}

/**
 * Applies the edit form: empty string = remove the correction. Amounts in EUR, inflation in percent.
 * Returns the problems (empty = ok) and the updated snapshot.
 */
export function applySnapshotEdit(
  s: YearSnapshot, edit: { portfolioEur: string; netWorthEur: string; inflationPct: string; inflationSource: string; note: string }, now: string,
): { snapshot: YearSnapshot; problems: string[] } {
  const problems: string[] = [];
  const out: YearSnapshot = { ...s, updatedAt: now };
  const num = (raw: string, label: string, min: number, max: number) => {
    const t = raw.trim().replace(/\s/g, '').replace(',', '.');
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isFinite(n) || n < min || n > max) { problems.push(`${label}: număr între ${min} și ${max}`); return undefined; }
    return n;
  };
  const pe = num(edit.portfolioEur, 'Valoarea portofoliului', -1e12, 1e12);
  const ne = num(edit.netWorthEur, 'Averea netă', -1e12, 1e12);
  const inf = num(edit.inflationPct, 'Inflația', -50, 1000);
  delete out.portfolioEur; delete out.netWorthEur; delete out.inflation; delete out.note;
  if (pe !== undefined) out.portfolioEur = pe;
  if (ne !== undefined) out.netWorthEur = ne;
  if (inf !== undefined) out.inflation = { rate: Math.round(inf * 10_000) / 1_000_000, ...(edit.inflationSource.trim() ? { source: edit.inflationSource.trim().slice(0, 500) } : {}) };
  else if (edit.inflationSource.trim()) problems.push('Sursa inflației fără valoare');
  if (edit.note.trim()) out.note = edit.note.trim().slice(0, 2000);
  return { snapshot: out, problems };
}
