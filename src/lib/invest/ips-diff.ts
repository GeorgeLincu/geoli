// Phase 6: line diff between two IPS versions (sections and structured rules).
import type { IpsRules, IpsVersion } from './types';

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 4_000_000;

/** Line-based diff (LCS). Very large inputs fall back to "all removed, all added". */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before ? before.replace(/\r\n?/g, '\n').split('\n') : [];
  const b = after ? after.replace(/\r\n?/g, '\n').split('\n') : [];
  // Trim the common head and tail first: typical edits touch a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail), mb = b.slice(head, b.length - tail);
  const out: DiffOp[] = a.slice(0, head).map(text => ({ type: 'same', text }));

  if (ma.length * mb.length > MAX_CELLS) {
    out.push(...ma.map(text => ({ type: 'del' as const, text })), ...mb.map(text => ({ type: 'add' as const, text })));
  } else {
    const n = ma.length, m = mb.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { out.push({ type: 'same', text: ma[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: ma[i++] });
      else out.push({ type: 'add', text: mb[j++] });
    }
    while (i < n) out.push({ type: 'del', text: ma[i++] });
    while (j < m) out.push({ type: 'add', text: mb[j++] });
  }
  out.push(...a.slice(a.length - tail).map(text => ({ type: 'same' as const, text })));
  return out;
}

export const hasChanges = (ops: readonly DiffOp[]) => ops.some(o => o.type !== 'same');

const NF = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 });
const pct = (x: number) => `${NF.format(x * 100)}%`;
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
export const monthName = (m: number) => MONTHS[m - 1] ?? String(m);

/** Human-readable lines for the structured rules (used by the diff and the print view). */
export function rulesToLines(rules: IpsRules | undefined, names: { account?: (id: string) => string; instrument?: (id: string) => string } = {}): string[] {
  if (!rules) return [];
  const acc = names.account ?? (id => id), inst = names.instrument ?? (id => id);
  const lines: string[] = [];
  if (rules.driftAlerts !== undefined) lines.push(`Alertă la ieșirea din bandă: ${rules.driftAlerts ? 'da' : 'nu'}`);
  if (rules.emergencyFund) {
    const e = rules.emergencyFund;
    lines.push(`Fond de urgență: ${NF.format(e.months)} luni × ${NF.format(e.monthlyExpenses)} € pe lună`);
    lines.push(`Fond de urgență, conturi: ${e.accountIds.length ? e.accountIds.map(acc).join(', ') : '—'}`);
  }
  if (rules.contribution) {
    const c = rules.contribution;
    lines.push(`Contribuție lunară: ${NF.format(c.amount)} € până pe ${c.day} ale lunii${c.graceDays ? ` (+${c.graceDays} zile păsuire)` : ''}`);
  }
  if (rules.reviewMonth) lines.push(`Revizuire anuală: ${monthName(rules.reviewMonth)}`);
  if (rules.taxReturn) {
    const t = rules.taxReturn;
    lines.push(`Termen Declarația Unică: ${t.day} ${monthName(t.month)}, reamintire cu ${t.remindDaysBefore ?? 30} zile înainte`);
  }
  if (rules.crash) {
    lines.push(`Reguli la căderi, măsurate pe: ${rules.crash.referenceInstrumentId ? inst(rules.crash.referenceInstrumentId) : '—'}`);
    for (const r of [...rules.crash.rules].sort((a, b) => a.dropPct - b.dropPct)) {
      lines.push(`La −${pct(r.dropPct)} sub maxim: ${r.action?.trim() || '—'}${r.extraAmount ? ` · ${NF.format(r.extraAmount)} € în plus` : ''}`);
    }
  }
  return lines;
}

export interface VersionDiff {
  sections: { key: string; ops: DiffOp[] }[];
  rules: DiffOp[];
}

/** Diff of every section (in `order`, then any extra keys) and of the rules. Unchanged sections are left out. */
export function diffVersions(before: Pick<IpsVersion, 'sections' | 'rules'>, after: Pick<IpsVersion, 'sections' | 'rules'>,
  order: readonly string[], names?: Parameters<typeof rulesToLines>[1]): VersionDiff {
  const keys = [...order];
  for (const k of [...Object.keys(before.sections), ...Object.keys(after.sections)]) if (!keys.includes(k)) keys.push(k);
  const sections = keys
    .map(key => ({ key, ops: diffLines(before.sections[key] ?? '', after.sections[key] ?? '') }))
    .filter(s => hasChanges(s.ops));
  const rules = diffLines(rulesToLines(before.rules, names).join('\n'), rulesToLines(after.rules, names).join('\n'));
  return { sections, rules: hasChanges(rules) ? rules : [] };
}
