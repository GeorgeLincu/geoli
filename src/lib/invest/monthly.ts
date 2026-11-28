// Monthly summary e-mail (opt-in): on the first cron run of a month, a short digest of the previous month.
// Settings in invest/monthly.json, state in invest/monthly-state.json (worker/monthly.ts). Pure functions here.
//
// Privacy: without „Include sume” only percentages and counts are sent (return of the month, change of the net
// worth in %, FI progress %, number of transactions). Amounts only when George turns them on.
import type { InvestData } from './types';
import type { NetWorthSources } from './networth';
import { netWorthAt } from './networth';
import { portfolioAt, portfolioFlows, monthEnd, fiProgress, type ValueSources } from './report';
import { modifiedDietz } from './returns';

export const MONTHLY_VERSION = 1;

export interface MonthlySettings { version: typeof MONTHLY_VERSION; enabled: boolean; includeAmounts: boolean }
export interface MonthlyState { version: typeof MONTHLY_VERSION; lastSent?: string; lastTest?: string; log: { at: string; month: string; ok: boolean; message?: string }[] }

export const defaultMonthlySettings = (): MonthlySettings => ({ version: MONTHLY_VERSION, enabled: false, includeAmounts: false });
export const emptyMonthlyState = (): MonthlyState => ({ version: MONTHLY_VERSION, log: [] });
export const TEST_COOLDOWN_MS = 2 * 60 * 1000;

export function validateMonthlySettings(v: unknown): { settings?: MonthlySettings; problems: string[] } {
  const problems: string[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { problems: ['object expected'] };
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['version', 'enabled', 'includeAmounts'].includes(k)) problems.push(`${k}: unknown field`);
  if (o.version !== MONTHLY_VERSION) problems.push(`version: must be ${MONTHLY_VERSION}`);
  if (typeof o.enabled !== 'boolean') problems.push('enabled: true/false expected');
  if (typeof o.includeAmounts !== 'boolean') problems.push('includeAmounts: true/false expected');
  return problems.length ? { problems } : { settings: { version: MONTHLY_VERSION, enabled: o.enabled as boolean, includeAmounts: o.includeAmounts as boolean }, problems };
}

export const withMonthlyDefaults = (raw: unknown): MonthlySettings => validateMonthlySettings(raw).settings ?? defaultMonthlySettings();

/** `YYYY-MM` of the month before `today`. */
export function previousMonth(today: string): string {
  let y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** The month to report now, or null (off, or already sent this month). */
export function dueMonth(settings: MonthlySettings, state: MonthlyState, today: string): string | null {
  if (!settings.enabled) return null;
  const month = previousMonth(today);
  return state.lastSent && state.lastSent >= month ? null : month;
}

export interface MonthSummary {
  month: string;
  start: string;
  end: string;
  portfolioStart: number;
  portfolioEnd: number;
  /** Net money added in the month (EUR, portfolio view) */
  flows: number;
  /** Modified Dietz return of the month (null = nothing invested) */
  ret: number | null;
  netWorthStart: number;
  netWorthEnd: number;
  transactions: number;
  fiProgress: number | null;
  atCost: number;
}

export function monthSummary(data: InvestData, src: ValueSources & Pick<NetWorthSources, 'emergencyAccountIds'>, month: string): MonthSummary {
  const y = +month.slice(0, 4), m = +month.slice(5, 7);
  const end = monthEnd(y, m);
  const start = m === 1 ? `${y - 1}-12-31` : monthEnd(y, m - 1);
  const p0 = portfolioAt(data, src, start), p1 = portfolioAt(data, src, end);
  const flows = portfolioFlows(data, src.fx).flows.filter(f => f.date > start && f.date <= end);
  const nw0 = netWorthAt(data, src, start), nw1 = netWorthAt(data, src, end);
  const fi = fiProgress(data.settings, data.targets, y, p1.eur);
  return {
    month, start, end, portfolioStart: p0.eur, portfolioEnd: p1.eur,
    flows: flows.reduce((s, f) => s + f.amount, 0),
    ret: modifiedDietz(start, p0.eur, flows, end, p1.eur),
    netWorthStart: nw0.netEur, netWorthEnd: nw1.netEur,
    transactions: data.transactions.filter(t => t.date.startsWith(`${month}-`)).length,
    fiProgress: fi ? fi.progress : null, atCost: p1.atCost,
  };
}

const MONTHS_RO = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (x: number) => `${x > 0.0005 ? '+' : x < -0.0005 ? '−' : ''}${NF1.format(Math.abs(x) * 100)}%`;
const eur = (x: number) => `${x < 0 ? '−' : ''}${NF0.format(Math.abs(x))} €`;

export function monthlyEmail(s: MonthSummary, includeAmounts: boolean, pageUrl: string, test = false): { subject: string; text: string } {
  const name = `${MONTHS_RO[+s.month.slice(5, 7) - 1]} ${s.month.slice(0, 4)}`;
  const nwChange = s.netWorthStart > 0 ? s.netWorthEnd / s.netWorthStart - 1 : null;
  const lines = [
    `Rezumatul lunii ${name}${test ? ' (test)' : ''}`,
    '',
    `Randamentul portofoliului în lună (ponderat în timp): ${s.ret === null ? '—' : pct(s.ret)}`,
    `Avere netă: ${nwChange === null ? '—' : pct(nwChange)} față de sfârșitul lunii trecute${includeAmounts ? ` (${eur(s.netWorthStart)} → ${eur(s.netWorthEnd)})` : ''}`,
  ];
  if (includeAmounts) {
    lines.push(`Portofoliu (fără Pilon 2/3): ${eur(s.portfolioStart)} → ${eur(s.portfolioEnd)}`);
    lines.push(`Bani adăugați net în portofoliu: ${eur(s.flows)}`);
  }
  if (s.fiProgress !== null) lines.push(`Progres FI: ${NF1.format(s.fiProgress * 100)}%`);
  lines.push(`Tranzacții înregistrate în lună: ${s.transactions}`);
  if (s.atCost) lines.push(`${s.atCost} poziții fără preț la sfârșitul lunii (evaluate la cost).`);
  lines.push('', `Detalii: ${pageUrl}`, '', 'Ai primit acest e-mail pentru că ai activat „Rezumat lunar” pe pagina Rapoarte. Îl oprești de acolo.');
  return { subject: `Investiții: rezumatul lunii ${name}${test ? ' (test)' : ''}`, text: lines.join('\n') };
}
