// E-mail alerts for /vault/invest/ — pure logic (settings, de-duplication state, message text, raw e-mail).
// The Worker (worker/alerts.ts) loads the data, calls planAlerts() from the cron and sends the result.
//
// Stored in R2:
//   invest/alerts.json        AlertSettings — what George turned on (edited on /vault/invest/oportunitati/)
//   invest/alerts-state.json  AlertState    — what was already sent, so each event is announced once
//
// Privacy: e-mails carry instrument names and percentages; money (prices, planned extra amounts, bond values)
// only when settings.email.includeAmounts is on. They go only to the owner address configured in the Worker.
import type { Currency, Transaction } from './types';
import { normalizeLevels, nextAlertLevel, type DipLevel } from './drawdown';

export const ALERTS_VERSION = 1;

export interface AlertSettings {
  version: typeof ALERTS_VERSION;
  /** Master switch: nothing is e-mailed while false (the page still works) */
  emailEnabled: boolean;
  /** Include prices and planned amounts in e-mails (off = only names and percentages) */
  includeAmounts: boolean;
  drawdown: {
    enabled: boolean;
    /** Which high the levels are measured from */
    basis: 'ath' | 'high52';
    /** George's own levels; used when the IPS has none (or useIps is false) */
    levels: DipLevel[];
    /** Prefer the levels stored in the IPS (invest/ips.json) when present */
    useIps: boolean;
  };
  stale: { enabled: boolean; days: number };
  /** Declarația unică reminder. date '' = not set */
  du: { enabled: boolean; date: string; daysBefore: number[] };
  maturities: { enabled: boolean; daysAhead: number };
}

export const defaultAlertSettings = (): AlertSettings => ({
  version: ALERTS_VERSION,
  emailEnabled: false,
  includeAmounts: false,
  drawdown: { enabled: false, basis: 'ath', levels: [], useIps: true },
  stale: { enabled: false, days: 5 },
  du: { enabled: false, date: '', daysBefore: [30, 7, 1] },
  maturities: { enabled: false, daysAhead: 30 },
});

export interface AlertLogEntry { at: string; kinds: string[]; subject: string; ok: boolean; error?: string; test?: boolean }

export interface AlertState {
  version: typeof ALERTS_VERSION;
  /** instrument id → deepest level already announced (fraction) */
  drawdown: Record<string, { level: number; at: string }>;
  /** instrument id → latest price date already reported as stale ('none' = no price at all) */
  stale: Record<string, string>;
  /** "<deadline>|<days before>" already sent */
  du: string[];
  /** "<instrument id>|<maturity>" already sent */
  maturities: string[];
  lastRun?: string;
  /** Test e-mails: rate limit */
  lastTest?: string;
  tests?: { date: string; count: number };
  /** Newest first, at most LOG_KEPT */
  log: AlertLogEntry[];
}

export const LOG_KEPT = 30;
export const TEST_COOLDOWN_MS = 2 * 60 * 1000;
export const TESTS_PER_DAY = 5;

export const emptyAlertState = (): AlertState =>
  ({ version: ALERTS_VERSION, drawdown: {}, stale: {}, du: [], maturities: [], log: [] });

// ───────────── Settings validation ─────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: unknown): s is string =>
  typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const intIn = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Validates the settings sent by the page. Returns cleaned settings or problems.
 * Unknown fields are rejected so a typo doesn't silently do nothing.
 */
export function validateAlertSettings(v: unknown): { settings?: AlertSettings; problems: string[] } {
  const p: string[] = [];
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { problems: ['object expected'] };
  const allowed = ['version', 'emailEnabled', 'includeAmounts', 'drawdown', 'stale', 'du', 'maturities'];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.push(`${k}: unknown field`);
  if (o.version !== ALERTS_VERSION) p.push(`version: must be ${ALERTS_VERSION}`);
  if (typeof o.emailEnabled !== 'boolean') p.push('emailEnabled: true/false');
  if (typeof o.includeAmounts !== 'boolean') p.push('includeAmounts: true/false');

  const d = (o.drawdown ?? {}) as Record<string, unknown>;
  if (typeof d.enabled !== 'boolean') p.push('drawdown.enabled: true/false');
  if (d.basis !== 'ath' && d.basis !== 'high52') p.push('drawdown.basis: ath or high52');
  if (typeof d.useIps !== 'boolean') p.push('drawdown.useIps: true/false');
  if (!Array.isArray(d.levels) || d.levels.length > 10) p.push('drawdown.levels: list of at most 10');
  const levels = Array.isArray(d.levels) ? normalizeLevels(d.levels) : [];
  if (Array.isArray(d.levels) && levels.length !== d.levels.length) p.push('drawdown.levels: each needs a unique pct between 1 and 99');
  for (const l of levels) if (l.extraAmount !== undefined && l.extraAmount > 1e9) p.push('drawdown.levels: amount too large');

  const s = (o.stale ?? {}) as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') p.push('stale.enabled: true/false');
  if (!intIn(s.days, 2, 60)) p.push('stale.days: whole number 2–60');

  const du = (o.du ?? {}) as Record<string, unknown>;
  if (typeof du.enabled !== 'boolean') p.push('du.enabled: true/false');
  if (du.date !== '' && !isDate(du.date)) p.push('du.date: YYYY-MM-DD or empty');
  if (!Array.isArray(du.daysBefore) || !du.daysBefore.length || du.daysBefore.length > 5 || !du.daysBefore.every(x => intIn(x, 0, 120)))
    p.push('du.daysBefore: 1–5 whole numbers 0–120');
  if (du.enabled === true && du.date === '') p.push('du.date: set the deadline before turning the reminder on');

  const m = (o.maturities ?? {}) as Record<string, unknown>;
  if (typeof m.enabled !== 'boolean') p.push('maturities.enabled: true/false');
  if (!intIn(m.daysAhead, 1, 365)) p.push('maturities.daysAhead: whole number 1–365');

  if (p.length) return { problems: p.slice(0, 20) };
  return {
    problems: [],
    settings: {
      version: ALERTS_VERSION,
      emailEnabled: o.emailEnabled as boolean,
      includeAmounts: o.includeAmounts as boolean,
      drawdown: { enabled: d.enabled as boolean, basis: d.basis as 'ath' | 'high52', levels, useIps: d.useIps as boolean },
      stale: { enabled: s.enabled as boolean, days: s.days as number },
      du: { enabled: du.enabled as boolean, date: du.date as string, daysBefore: [...new Set(du.daysBefore as number[])].sort((a, b) => b - a) },
      maturities: { enabled: m.enabled as boolean, daysAhead: m.daysAhead as number },
    },
  };
}

/** Settings read from R2, filled with defaults for anything missing (older or partial documents). */
export function withDefaults(raw: unknown): AlertSettings {
  const d = defaultAlertSettings();
  const r = (raw ?? {}) as Partial<AlertSettings>;
  return {
    ...d, ...r, version: ALERTS_VERSION,
    drawdown: { ...d.drawdown, ...(r.drawdown ?? {}), levels: normalizeLevels(r.drawdown?.levels) },
    stale: { ...d.stale, ...(r.stale ?? {}) },
    du: { ...d.du, ...(r.du ?? {}) },
    maturities: { ...d.maturities, ...(r.maturities ?? {}) },
  };
}

/** Levels actually used: the IPS ones when enabled and present, else the page's own. */
export function effectiveLevels(settings: AlertSettings, ipsLevels: readonly DipLevel[]): { levels: DipLevel[]; source: 'ips' | 'settings' } {
  if (settings.drawdown.useIps && ipsLevels.length) return { levels: [...ipsLevels], source: 'ips' };
  return { levels: settings.drawdown.levels, source: 'settings' };
}

// ───────────── Holdings ─────────────

/** Units held per instrument (buys − sells). Used to skip matured/sold bonds. */
export function heldQuantities(txs: readonly Transaction[], asOf?: string): Map<string, number> {
  const q = new Map<string, number>();
  for (const t of txs) {
    if (!t.instrumentId || (asOf && t.date > asOf)) continue;
    const n = t.quantity ?? 0;
    if (t.type === 'buy') q.set(t.instrumentId, (q.get(t.instrumentId) ?? 0) + n);
    else if (t.type === 'sell') q.set(t.instrumentId, (q.get(t.instrumentId) ?? 0) - n);
  }
  return q;
}

// ───────────── Planner ─────────────

export interface AlertInstrument {
  id: string;
  name: string;
  ticker?: string;
  /** Has an automatic price source */
  auto: boolean;
  /** Latest stored price (any source) */
  latest?: { date: string; close: number; currency: Currency } | null;
  /** From drawdownStats(); absent when there is no series */
  belowAth?: number;
  below52?: number;
  athDate?: string;
  athClose?: number;
  high52Date?: string;
  high52Close?: number;
  maturity?: string;
  /** Units held now */
  held: number;
  /** Face value per unit (bonds), for the optional amount line */
  faceValue?: number;
  currency: Currency;
}

export interface AlertInput {
  today: string;
  now: string;
  settings: AlertSettings;
  state: AlertState;
  instruments: AlertInstrument[];
  levels: DipLevel[];
  /** Absolute link to the page, e.g. https://geoli.eu/vault/invest/oportunitati/ */
  pageUrl: string;
}

export interface AlertItem { kind: 'drawdown' | 'stale' | 'du' | 'maturity'; line: string }
export interface AlertPlan { items: AlertItem[]; state: AlertState; subject: string; text: string }

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const pctText = (f: number) =>
  `${new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1, minimumFractionDigits: 0 }).format(f * 100)} %`;
const money = (n: number, cur: string) =>
  `${new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 }).format(n)} ${cur}`;
const roDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const label = (i: AlertInstrument) => (i.ticker ? `${i.name} (${i.ticker})` : i.name);

/**
 * Decides what to e-mail now and returns the next state. Each event is announced once:
 * a drawdown level once per crossing (re-armed after a recovery), a stale price once per stale date,
 * each Declarația unică reminder once per (deadline, days before), each maturity once.
 * Disabled alerts don't touch their state.
 */
export function planAlerts(input: AlertInput): AlertPlan {
  const { today, now, settings, instruments, levels } = input;
  const state: AlertState = structuredClone(input.state);
  const items: AlertItem[] = [];
  const amounts = settings.includeAmounts;

  // Drawdown levels
  if (settings.drawdown.enabled && levels.length) {
    const basisName = settings.drawdown.basis === 'ath' ? 'maximul istoric' : 'maximul pe 52 de săptămâni';
    for (const i of instruments) {
      const below = settings.drawdown.basis === 'ath' ? i.belowAth : i.below52;
      if (below === undefined) continue;
      const prev = state.drawdown[i.id]?.level ?? 0;
      const r = nextAlertLevel(prev, below, levels);
      if (r.level !== prev) {
        if (r.level === 0) delete state.drawdown[i.id];
        else state.drawdown[i.id] = { level: r.level, at: now };
      }
      if (!r.newly.length) continue;
      const crossed = levels.filter(l => r.newly.includes(l.pct));
      const highDate = settings.drawdown.basis === 'ath' ? i.athDate : i.high52Date;
      const highClose = settings.drawdown.basis === 'ath' ? i.athClose : i.high52Close;
      const names = crossed.map(l => `−${pctText(l.pct)}`);
      let line = `${label(i)}: ${pctText(below)} sub ${basisName}${highDate ? ` (${roDate(highDate)})` : ''} — a trecut ${names.length > 1 ? `pragurile tale de ${names.slice(0, -1).join(', ')} și ${names.at(-1)}` : `pragul tău de ${names[0]}`}.`;
      if (amounts && i.latest && highClose) line += ` Preț ${money(i.latest.close, i.latest.currency)} (${roDate(i.latest.date)}), maxim ${money(highClose, i.latest.currency)}.`;
      const planned = crossed.filter(l => l.extraAmount);
      if (planned.length) {
        line += amounts
          ? ` Regula ta: cumpărare suplimentară de ${planned.map(l => `${money(l.extraAmount!, l.currency ?? 'EUR')} la −${pctText(l.pct)}`).join(', ')}.`
          : ` Ai o regulă de cumpărare suplimentară la ${planned.length > 1 ? 'aceste praguri' : `−${pctText(planned[0].pct)}`} (suma e pe pagină).`;
      }
      for (const l of crossed) if (l.note) line += ` Notă −${pctText(l.pct)}: ${l.note}`;
      items.push({ kind: 'drawdown', line });
    }
  }

  // Prices not updating
  if (settings.stale.enabled) {
    for (const i of instruments) {
      if (!i.auto) { delete state.stale[i.id]; continue; }
      const lastDate = i.latest?.date ?? null;
      const stale = !lastDate || daysBetween(lastDate, today) > settings.stale.days;
      if (!stale) { delete state.stale[i.id]; continue; }
      const key = lastDate ?? 'none';
      if (state.stale[i.id] === key) continue;
      state.stale[i.id] = key;
      items.push({
        kind: 'stale',
        line: lastDate
          ? `${label(i)}: prețul nu s-a mai actualizat din ${roDate(lastDate)} (${daysBetween(lastDate, today)} zile).`
          : `${label(i)}: nu există încă niciun preț automat.`,
      });
    }
  }

  // Declarația unică
  if (settings.du.enabled && isDate(settings.du.date)) {
    const left = daysBetween(today, settings.du.date);
    const offsets = [...settings.du.daysBefore].sort((a, b) => a - b);
    const due = offsets.find(o => left >= 0 && left <= o);
    if (due !== undefined && !state.du.includes(`${settings.du.date}|${due}`)) {
      // Mark this and every earlier (larger) reminder as done, so a late first run sends only one e-mail
      for (const o of offsets) if (o >= due) {
        const k = `${settings.du.date}|${o}`;
        if (!state.du.includes(k)) state.du.push(k);
      }
      items.push({
        kind: 'du',
        line: left === 0
          ? `Declarația unică: termenul este azi (${roDate(settings.du.date)}).`
          : `Declarația unică: termenul este ${roDate(settings.du.date)}, peste ${left} ${left === 1 ? 'zi' : 'zile'}.`,
      });
    }
    state.du = state.du.slice(-30);
  }

  // Maturities (Tezaur / Fidelis / any instrument with a maturity date that is still held)
  if (settings.maturities.enabled) {
    for (const i of instruments) {
      if (!i.maturity || i.held <= 0) continue;
      const left = daysBetween(today, i.maturity);
      if (left < 0 || left > settings.maturities.daysAhead) continue;
      const key = `${i.id}|${i.maturity}`;
      if (state.maturities.includes(key)) continue;
      state.maturities.push(key);
      let line = `${label(i)}: ajunge la scadență pe ${roDate(i.maturity)} (${left === 0 ? 'azi' : `peste ${left} ${left === 1 ? 'zi' : 'zile'}`}).`;
      if (amounts && i.faceValue) line += ` Valoare nominală deținută: ${money(i.faceValue * i.held, i.currency)}.`;
      items.push({ kind: 'maturity', line });
    }
    state.maturities = state.maturities.slice(-200);
  }

  state.lastRun = now;
  const { subject, text } = composeEmail(items, input.pageUrl);
  return { items, state, subject, text };
}

const SUBJECTS: Record<AlertItem['kind'], string> = {
  drawdown: 'scădere de la maxim', stale: 'prețuri neactualizate', du: 'Declarația unică', maturity: 'scadențe',
};

/** Plain-text digest: one e-mail per run, grouped by kind. */
export function composeEmail(items: readonly AlertItem[], pageUrl: string, test = false): { subject: string; text: string } {
  if (test) {
    return {
      subject: 'Investiții geoli.eu: e-mail de test',
      text: [
        'Acesta este un e-mail de test trimis de pe pagina „Scăderi” (Investiții).',
        'Dacă îl primești, alertele pot ajunge la tine.',
        '',
        `Setări: ${pageUrl}#alerte`,
        '',
        '—',
        'Trimis automat de geoli.eu. Doar cifre și regulile tale, nu recomandări.',
      ].join('\n'),
    };
  }
  const kinds = [...new Set(items.map(i => i.kind))];
  const subject = `Investiții geoli.eu: ${kinds.map(k => SUBJECTS[k]).join(', ')}`;
  const sections: string[] = [];
  const titles: Record<AlertItem['kind'], string> = {
    drawdown: 'Scădere de la maxim', stale: 'Prețuri care nu se mai actualizează', du: 'Declarația unică', maturity: 'Scadențe apropiate',
  };
  for (const k of kinds) sections.push(`${titles[k]}:\n${items.filter(i => i.kind === k).map(i => `- ${i.line}`).join('\n')}`);
  const text = [
    ...sections.flatMap(s => [s, '']),
    `Detalii: ${pageUrl}`,
    `Setări alerte: ${pageUrl}#alerte`,
    '',
    '—',
    'Trimis automat de geoli.eu, o singură dată pentru fiecare eveniment. Doar cifre și regulile tale, nu recomandări.',
  ].join('\n');
  return { subject, text };
}

/** Appends to the run log (newest first, bounded). */
export function logSend(state: AlertState, entry: AlertLogEntry): AlertState {
  return { ...state, log: [entry, ...state.log].slice(0, LOG_KEPT) };
}

/** Test e-mail rate limit: at most one per TEST_COOLDOWN_MS and TESTS_PER_DAY per day. Returns wait in ms (0 = ok). */
export function testWaitMs(state: AlertState, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  if (state.tests?.date === day && state.tests.count >= TESTS_PER_DAY) {
    return Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime();
  }
  const last = state.lastTest ? Date.parse(state.lastTest) : 0;
  return Math.max(0, last + TEST_COOLDOWN_MS - now.getTime());
}

export function recordTest(state: AlertState, now: Date): AlertState {
  const day = now.toISOString().slice(0, 10);
  const count = state.tests?.date === day ? state.tests.count + 1 : 1;
  return { ...state, lastTest: now.toISOString(), tests: { date: day, count } };
}

// ───────────── Raw e-mail (RFC 5322, plain text, base64 body) ─────────────

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

export function rawEmail(o: { from: string; fromName: string; to: string; subject: string; text: string; date?: Date; id?: string }): string {
  const domain = o.from.split('@')[1] || 'geoli.eu';
  return [
    `From: ${encodedWord(oneLine(o.fromName))} <${o.from}>`,
    `To: <${o.to}>`,
    `Subject: ${encodedWord(oneLine(o.subject))}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${o.id ?? crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(o.text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n'),
  ].join('\r\n');
}
