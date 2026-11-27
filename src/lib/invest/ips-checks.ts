// Phase 6: turns the machine-checkable IPS rules (ips.json → versions[].rules) into dashboard alerts.
// Pure functions: the dashboard gathers the facts (valuation, drift, transactions, prices) and passes them in.
// Rules come from the newest saved version only; a draft is never enforced.
import type { Currency, IpsCrashRule, IpsDoc, IpsRules, IpsVersion, Transaction } from './types';
import type { DriftResult } from './portfolio';

export type IpsAlertLevel = 'warn' | 'info';
export interface IpsAlert {
  /** Stable key, e.g. "drift:<targetId>", "emergency", "contribution", "review", "tax", "crash" */
  id: string;
  level: IpsAlertLevel;
  title: string;
  detail?: string;
  /** Page where George can act on it */
  href?: string;
}

// ─── Reading the doc ───

/** Newest version by date (ties: the one saved last). */
export function latestIpsVersion(doc: IpsDoc | null | undefined): IpsVersion | null {
  if (!doc?.versions?.length) return null;
  let best = doc.versions[0];
  for (const v of doc.versions) if (v.date >= best.date) best = v;
  return best;
}

/** The rules in force (from the newest version), or null when there is no version or it has no rules. */
export function activeIpsRules(doc: IpsDoc | null | undefined): { rules: IpsRules; version: IpsVersion } | null {
  const version = latestIpsVersion(doc);
  return version?.rules ? { rules: version.rules, version } : null;
}

// ─── Date helpers (ISO YYYY-MM-DD, calendar days, no time zones) ───

const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (iso: string) => iso.split('-').map(Number) as [number, number, number];
const toUtc = (iso: string) => { const [y, m, d] = ymd(iso); return Date.UTC(y, m - 1, d); };
export const daysBetween = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
/** Day `day` of the month, clamped to the month's length (31 → 28/29/30). */
const dayOf = (y: number, m: number, day: number) => `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };

const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
const pct = (x: number) => `${NF1.format(x * 100)}%`;
const eur = (x: number) => `${NF0.format(x)} €`;

// ─── Facts helpers ───

export interface MonthContributions {
  /** Sum in EUR of what could be converted */
  eur: number;
  count: number;
  /** Transactions that could not be converted to EUR (missing rate) */
  unconverted: number;
}

/**
 * What went into the portfolio in the calendar month of `today` (up to today).
 * Deposits are the contribution when the month has any; otherwise buys (quantity × price + fees) count,
 * so a deposit followed by a buy of the same money is not counted twice.
 */
export function monthContributions(
  transactions: readonly Transaction[], today: string,
  toEur: (amount: number, currency: Currency, date: string) => number | null,
): MonthContributions {
  const month = today.slice(0, 7);
  const inMonth = transactions.filter(t => t.date.slice(0, 7) === month && t.date <= today);
  const deposits = inMonth.filter(t => t.type === 'deposit');
  const used = deposits.length ? deposits : inMonth.filter(t => t.type === 'buy');
  let sum = 0, unconverted = 0;
  for (const t of used) {
    const amount = t.type === 'deposit' ? (t.amount ?? 0) : (t.quantity ?? 0) * (t.price ?? 0) + (t.fees ?? 0);
    const v = toEur(amount, t.currency, t.date);
    if (v === null) unconverted++; else sum += v;
  }
  return { eur: sum, count: used.length, unconverted };
}

export interface Drawdown {
  /** Decimal below the high, ≥ 0 (0.2 = 20% below) */
  pct: number;
  high: number;
  highDate: string;
  last: number;
  lastDate: string;
}

/** Drop of the latest close below the highest close in the series (dates ISO, any order). */
export function drawdownFromCloses(closes: Iterable<readonly [string, number]>): Drawdown | null {
  let high: [string, number] | null = null, last: [string, number] | null = null;
  for (const [d, c] of closes) {
    if (!(c > 0)) continue;
    if (!high || c > high[1] || (c === high[1] && d > high[0])) high = [d, c];
    if (!last || d > last[0]) last = [d, c];
  }
  if (!high || !last) return null;
  return { pct: Math.max(0, 1 - last[1] / high[1]), high: high[1], highDate: high[0], last: last[1], lastDate: last[0] };
}

/** Crash rules whose threshold is reached, deepest first. */
export function triggeredCrashRules(rules: readonly IpsCrashRule[], drawdownPct: number): IpsCrashRule[] {
  return rules.filter(r => drawdownPct + 1e-12 >= r.dropPct).sort((a, b) => b.dropPct - a.dropPct);
}

// ─── Alerts ───

export interface IpsFacts {
  today: string;
  /** Drift computed with the Phase 2 targets and bands (null = no valuation available) */
  drift?: DriftResult | null;
  /** Value in EUR per account id (null value = could not be converted) */
  accountValuesEur?: ReadonlyMap<string, number | null>;
  /** This month's contributions (see monthContributions) */
  contributions?: MonthContributions | null;
  /** Drawdown of the crash reference instrument */
  drawdown?: Drawdown | null;
  /** Display names for messages */
  accountName?: (id: string) => string;
  instrumentName?: (id: string) => string;
}

const LEVEL_ORDER: Record<IpsAlertLevel, number> = { warn: 0, info: 1 };

/** All alerts for the rules in force. Empty when nothing is wrong or no rules are set. */
export function ipsAlerts(doc: IpsDoc | null | undefined, facts: IpsFacts): IpsAlert[] {
  const active = activeIpsRules(doc);
  if (!active) return [];
  const { rules, version } = active;
  const { today } = facts;
  const [ty, tm, td] = ymd(today);
  const out: IpsAlert[] = [];

  // Drift outside the bands of the Phase 2 targets
  if (rules.driftAlerts) {
    const drift = facts.drift;
    if (!drift || !drift.rows.length) {
      out.push({ id: 'drift', level: 'info', title: 'Abaterea de la alocare nu poate fi verificată', detail: 'Lipsesc ținta de alocare sau valorile portofoliului.', href: '/vault/invest/portofoliu/' });
    } else {
      for (const r of drift.rows) {
        if (r.status === 'ok') continue;
        out.push({
          id: `drift:${r.target.id}`, level: 'warn',
          title: `„${r.target.label}” e ${r.status === 'over' ? 'peste' : 'sub'} bandă`,
          detail: `Actual ${pct(r.actualWeight)}, țintă ${pct(r.target.weight)}${r.target.band !== undefined ? ` ± ${NF1.format(r.target.band * 100)} pp` : ''}.`,
          href: '/vault/invest/portofoliu/',
        });
      }
    }
  }

  // Emergency fund below N months
  const ef = rules.emergencyFund;
  if (ef && ef.months > 0 && ef.monthlyExpenses > 0) {
    const need = ef.months * ef.monthlyExpenses;
    if (!ef.accountIds.length) {
      out.push({ id: 'emergency', level: 'info', title: 'Fondul de urgență nu are conturi alese', detail: 'Alege în IPS conturile care țin fondul de urgență.', href: '/vault/invest/ips/' });
    } else if (facts.accountValuesEur) {
      let have = 0, unknown = 0;
      for (const id of ef.accountIds) {
        const v = facts.accountValuesEur.get(id);
        if (v === null) unknown++; else have += v ?? 0;
      }
      if (have + 1e-6 < need) {
        out.push({
          id: 'emergency', level: 'warn',
          title: `Fondul de urgență e sub ${NF0.format(ef.months)} luni`,
          detail: `${eur(have)} din ${eur(need)} (≈ ${NF1.format(have / ef.monthlyExpenses)} luni de cheltuieli)${unknown ? `; ${unknown} cont(uri) fără curs` : ''}.`,
          href: '/vault/invest/portofoliu/',
        });
      }
    }
  }

  // Monthly contribution missed
  const c = rules.contribution;
  if (c && c.amount > 0 && facts.contributions) {
    const due = dayOf(ty, tm, c.day + (c.graceDays ?? 0));
    const dueDay = Math.min(c.day + (c.graceDays ?? 0), daysInMonth(ty, tm));
    const got = facts.contributions;
    if (td > dueDay && got.eur + 0.01 * c.amount < c.amount) {
      out.push({
        id: 'contribution', level: 'warn',
        title: got.count ? 'Contribuția lunii e incompletă' : 'Contribuția lunii pare ratată',
        detail: `Plan: ${eur(c.amount)} până pe ${NF0.format(c.day)} ale lunii; înregistrat luna asta: ${eur(got.eur)}${got.unconverted ? ` (+${got.unconverted} tranzacții fără curs)` : ''}. Termen cu păsuire: ${fmtDate(due)}.`,
        href: '/vault/invest/portofoliu/',
      });
    }
  }

  // Annual review due
  if (rules.reviewMonth) {
    const start = `${ty}-${pad(rules.reviewMonth)}-01`;
    if (today >= start && version.date < start) {
      out.push({
        id: 'review', level: 'warn', title: 'Revizuirea anuală a IPS e scadentă',
        detail: `Ultima versiune e din ${fmtDate(version.date)}. Recitește IPS și salvează o versiune nouă (chiar fără schimbări).`,
        href: '/vault/invest/ips/',
      });
    }
  }

  // Tax return (Declarația Unică) reminder, deadline entered by George
  const tx = rules.taxReturn;
  if (tx) {
    const remind = tx.remindDaysBefore ?? 30;
    const deadline = dayOf(ty, tx.month, tx.day);
    const left = daysBetween(today, deadline);
    if (left >= 0 && left <= remind) {
      out.push({
        id: 'tax', level: left <= 7 ? 'warn' : 'info',
        title: left === 0 ? 'Azi e termenul pentru Declarația Unică' : `Declarația Unică: termen în ${left} ${left === 1 ? 'zi' : 'zile'}`,
        detail: `Termenul notat în IPS: ${fmtDate(deadline)}.`,
      });
    }
  }

  // Extra buys on market drops
  const cr = rules.crash;
  if (cr?.rules.length && cr.referenceInstrumentId) {
    const name = facts.instrumentName?.(cr.referenceInstrumentId) ?? cr.referenceInstrumentId;
    const dd = facts.drawdown;
    if (!dd) {
      out.push({ id: 'crash', level: 'info', title: 'Regulile de cădere nu pot fi verificate', detail: `Nu există prețuri salvate pentru ${name}.`, href: '/vault/invest/' });
    } else {
      const hit = triggeredCrashRules(cr.rules, dd.pct);
      if (hit.length) {
        const r = hit[0];
        out.push({
          id: 'crash', level: 'warn',
          title: `${name} e la ${pct(dd.pct)} sub maxim`,
          detail: `Maxim ${NF1.format(dd.high)} pe ${fmtDate(dd.highDate)}, ultimul preț ${NF1.format(dd.last)} pe ${fmtDate(dd.lastDate)}. Regula ta pentru −${pct(r.dropPct)}: ${r.action?.trim() || '(fără text)'}${r.extraAmount ? ` · sumă suplimentară ${eur(r.extraAmount)}` : ''}.`,
          href: '/vault/invest/ips/',
        });
      }
    }
  }

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
