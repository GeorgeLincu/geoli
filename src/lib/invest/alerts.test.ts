import { describe, it, expect } from 'vitest';
import {
  defaultAlertSettings, emptyAlertState, validateAlertSettings, withDefaults, effectiveLevels, heldQuantities,
  planAlerts, composeEmail, testWaitMs, recordTest, logSend, rawEmail, TESTS_PER_DAY, LOG_KEPT,
  type AlertSettings, type AlertInstrument, type AlertState,
} from './alerts';
import { normalizeLevels } from './drawdown';

const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  ...defaultAlertSettings(), emailEnabled: true, ...over,
});
const inst = (over: Partial<AlertInstrument> = {}): AlertInstrument => ({
  id: 'vwce', name: 'Vanguard FTSE All-World', ticker: 'VWCE', auto: true, held: 10, currency: 'EUR',
  latest: { date: '2026-11-26', close: 100, currency: 'EUR' },
  belowAth: 0.12, below52: 0.05, athDate: '2026-02-01', athClose: 113.6, high52Date: '2026-09-01', high52Close: 105,
  ...over,
});
const base = { today: '2026-11-27', now: '2026-11-27T18:00:00Z', pageUrl: 'https://geoli.eu/vault/invest/oportunitati/' };
const L = normalizeLevels([{ pct: 10, extraAmount: 500, currency: 'EUR' }, 20, 30]);

describe('settings', () => {
  it('defaults are all off, levels empty, DU date empty', () => {
    const d = defaultAlertSettings();
    expect(d.emailEnabled).toBe(false);
    expect([d.drawdown.enabled, d.stale.enabled, d.du.enabled, d.maturities.enabled]).toEqual([false, false, false, false]);
    expect(d.du.date).toBe('');
    expect(d.drawdown.levels).toEqual([]);
  });

  it('validates and cleans', () => {
    const input = { ...defaultAlertSettings(), drawdown: { enabled: true, basis: 'ath', useIps: false, levels: [30, { pct: 10, extraAmount: 200 }] }, du: { enabled: true, date: '2027-05-25', daysBefore: [1, 30, 7, 7] } };
    const r = validateAlertSettings(input);
    expect(r.problems).toEqual([]);
    expect(r.settings!.drawdown.levels).toEqual([{ pct: 0.1, extraAmount: 200 }, { pct: 0.3 }]);
    expect(r.settings!.du.daysBefore).toEqual([30, 7, 1]);
  });

  it('rejects bad values and unknown fields', () => {
    const r = validateAlertSettings({ ...defaultAlertSettings(), extra: 1, stale: { enabled: true, days: 0 }, du: { enabled: true, date: '', daysBefore: [] } });
    expect(r.settings).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/extra: unknown/);
    expect(r.problems.join(' ')).toMatch(/stale.days/);
    expect(r.problems.join(' ')).toMatch(/du.date: set the deadline/);
    expect(validateAlertSettings({ ...defaultAlertSettings(), drawdown: { ...defaultAlertSettings().drawdown, levels: [10, 10] } }).problems.join()).toMatch(/unique/);
    expect(validateAlertSettings(null).problems).toEqual(['object expected']);
  });

  it('withDefaults fills partial documents', () => {
    const s = withDefaults({ emailEnabled: true, stale: { enabled: true } });
    expect(s.emailEnabled).toBe(true);
    expect(s.stale).toEqual({ enabled: true, days: 5 });
    expect(s.maturities.daysAhead).toBe(30);
  });

  it('effectiveLevels prefers the IPS when allowed and present', () => {
    const s = settings({ drawdown: { enabled: true, basis: 'ath', useIps: true, levels: L } });
    expect(effectiveLevels(s, [{ pct: 0.15 }])).toEqual({ levels: [{ pct: 0.15 }], source: 'ips' });
    expect(effectiveLevels(s, [])).toEqual({ levels: L, source: 'settings' });
    expect(effectiveLevels({ ...s, drawdown: { ...s.drawdown, useIps: false } }, [{ pct: 0.15 }]).source).toBe('settings');
  });
});

describe('heldQuantities', () => {
  it('sums buys minus sells up to a date', () => {
    const q = heldQuantities([
      { id: '1', date: '2026-01-01', type: 'buy', accountId: 'a', instrumentId: 'x', quantity: 5, currency: 'EUR' },
      { id: '2', date: '2026-02-01', type: 'sell', accountId: 'a', instrumentId: 'x', quantity: 2, currency: 'EUR' },
      { id: '3', date: '2026-03-01', type: 'dividend', accountId: 'a', instrumentId: 'x', amount: 9, currency: 'EUR' },
      { id: '4', date: '2027-01-01', type: 'buy', accountId: 'a', instrumentId: 'x', quantity: 100, currency: 'EUR' },
    ], '2026-12-31');
    expect(q.get('x')).toBe(3);
  });
});

describe('planAlerts', () => {
  const dd = settings({ drawdown: { enabled: true, basis: 'ath', useIps: false, levels: L } });

  it('nothing enabled → no items, state untouched except lastRun', () => {
    const p = planAlerts({ ...base, settings: settings(), state: emptyAlertState(), instruments: [inst()], levels: L });
    expect(p.items).toEqual([]);
    expect(p.state.lastRun).toBe(base.now);
  });

  it('drawdown: once per crossing, no amounts by default', () => {
    const p1 = planAlerts({ ...base, settings: dd, state: emptyAlertState(), instruments: [inst()], levels: L });
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0].line).toContain('12 % sub maximul istoric (01.02.2026)');
    expect(p1.items[0].line).toContain('pragul tău de −10 %');
    expect(p1.items[0].line).toContain('regulă de cumpărare suplimentară la −10 % (suma e pe pagină)');
    expect(p1.items[0].line).not.toMatch(/500|100|113/);
    expect(p1.state.drawdown.vwce.level).toBe(0.1);
    // Next day, same depth: silent
    const p2 = planAlerts({ ...base, settings: dd, state: p1.state, instruments: [inst({ belowAth: 0.13 })], levels: L });
    expect(p2.items).toEqual([]);
    // Deeper: new level
    const p3 = planAlerts({ ...base, settings: dd, state: p2.state, instruments: [inst({ belowAth: 0.22 })], levels: L });
    expect(p3.items[0].line).toContain('pragul tău de −20 %.');
    expect(p3.items[0].line).not.toContain('suma');
    // A gap through several levels names all of them
    const gap = planAlerts({ ...base, settings: dd, state: emptyAlertState(), instruments: [inst({ belowAth: 0.31 })], levels: L });
    expect(gap.items[0].line).toContain('pragurile tale de −10 %, −20 % și −30 %');
  });

  it('drawdown with amounts enabled shows price, high and the planned extra amount', () => {
    const p = planAlerts({ ...base, settings: { ...dd, includeAmounts: true }, state: emptyAlertState(), instruments: [inst()], levels: L });
    expect(p.items[0].line).toContain('Preț 100 EUR');
    expect(p.items[0].line).toContain('cumpărare suplimentară de 500 EUR la −10 %');
  });

  it('drawdown can use the 52-week high', () => {
    const s = settings({ drawdown: { enabled: true, basis: 'high52', useIps: false, levels: L } });
    expect(planAlerts({ ...base, settings: s, state: emptyAlertState(), instruments: [inst()], levels: L }).items).toEqual([]);
  });

  it('stale prices: once per stale date, cleared when prices resume', () => {
    const s = settings({ stale: { enabled: true, days: 5 } });
    const old = inst({ latest: { date: '2026-11-10', close: 1, currency: 'EUR' } });
    const p1 = planAlerts({ ...base, settings: s, state: emptyAlertState(), instruments: [old, inst({ id: 'm', auto: false, latest: null })], levels: [] });
    expect(p1.items.map(i => i.line)).toEqual(['Vanguard FTSE All-World (VWCE): prețul nu s-a mai actualizat din 10.11.2026 (17 zile).']);
    expect(planAlerts({ ...base, settings: s, state: p1.state, instruments: [old], levels: [] }).items).toEqual([]);
    const p3 = planAlerts({ ...base, settings: s, state: p1.state, instruments: [inst()], levels: [] });
    expect(p3.state.stale).toEqual({});
    const none = planAlerts({ ...base, settings: s, state: emptyAlertState(), instruments: [inst({ latest: null })], levels: [] });
    expect(none.items[0].line).toContain('niciun preț automat');
  });

  it('Declarația unică: one reminder per window, late start sends only the nearest', () => {
    const s = settings({ du: { enabled: true, date: '2027-05-25', daysBefore: [30, 7, 1] } });
    const at = (today: string, state: AlertState) => planAlerts({ ...base, today, settings: s, state, instruments: [], levels: [] });
    expect(at('2027-04-01', emptyAlertState()).items).toEqual([]);
    const p1 = at('2027-04-25', emptyAlertState());
    expect(p1.items[0].line).toBe('Declarația unică: termenul este 25.05.2027, peste 30 de zile.'.replace('30 de zile', '30 zile'));
    expect(at('2027-04-26', p1.state).items).toEqual([]);
    const p2 = at('2027-05-20', p1.state);
    expect(p2.items).toHaveLength(1);
    // started late (2 days before): only the 7-day one, then the 1-day one
    const late = at('2027-05-23', emptyAlertState());
    expect(late.items).toHaveLength(1);
    expect(late.state.du).toEqual(['2027-05-25|7', '2027-05-25|30']);
    expect(at('2027-05-24', late.state).items[0].line).toContain('peste 1 zi');
    expect(at('2027-05-26', emptyAlertState()).items).toEqual([]);
    // Disabled or no date: nothing
    expect(planAlerts({ ...base, today: '2027-05-24', settings: settings(), state: emptyAlertState(), instruments: [], levels: [] }).items).toEqual([]);
  });

  it('maturities: held bonds within the window, once each; amount only when enabled', () => {
    const s = settings({ maturities: { enabled: true, daysAhead: 30 } });
    const bond = inst({ id: 'tz', name: 'Tezaur 2026', ticker: undefined, auto: false, maturity: '2026-12-15', held: 20, faceValue: 100, currency: 'RON' });
    const p1 = planAlerts({ ...base, settings: s, state: emptyAlertState(), instruments: [bond, { ...bond, id: 'sold', held: 0 }, { ...bond, id: 'far', maturity: '2027-06-01' }], levels: [] });
    expect(p1.items.map(i => i.line)).toEqual(['Tezaur 2026: ajunge la scadență pe 15.12.2026 (peste 18 zile).']);
    expect(planAlerts({ ...base, settings: s, state: p1.state, instruments: [bond], levels: [] }).items).toEqual([]);
    const withAmt = planAlerts({ ...base, settings: { ...s, includeAmounts: true }, state: emptyAlertState(), instruments: [bond], levels: [] });
    expect(withAmt.items[0].line).toContain('2.000 RON');
  });

  it('digest subject and text', () => {
    const { subject, text } = composeEmail([{ kind: 'stale', line: 'a' }, { kind: 'du', line: 'b' }], base.pageUrl);
    expect(subject).toBe('Investiții geoli.eu: prețuri neactualizate, Declarația unică');
    expect(text).toContain('- a');
    expect(text).toContain(`Setări alerte: ${base.pageUrl}#alerte`);
    expect(composeEmail([], base.pageUrl, true).subject).toContain('test');
  });
});

describe('test e-mail rate limit and log', () => {
  it('cooldown and daily cap', () => {
    const t0 = new Date('2026-11-27T10:00:00Z');
    let s = emptyAlertState();
    expect(testWaitMs(s, t0)).toBe(0);
    s = recordTest(s, t0);
    expect(testWaitMs(s, new Date(t0.getTime() + 60_000))).toBe(60_000);
    for (let i = 1; i < TESTS_PER_DAY; i++) s = recordTest(s, new Date(t0.getTime() + i * 3_600_000));
    expect(s.tests).toEqual({ date: '2026-11-27', count: TESTS_PER_DAY });
    expect(testWaitMs(s, new Date('2026-11-27T23:00:00Z'))).toBe(3_600_000);
    expect(testWaitMs(s, new Date('2026-11-28T00:10:00Z'))).toBe(0);
  });

  it('log keeps the newest entries', () => {
    let s = emptyAlertState();
    for (let i = 0; i < LOG_KEPT + 5; i++) s = logSend(s, { at: String(i), kinds: [], subject: '', ok: true });
    expect(s.log).toHaveLength(LOG_KEPT);
    expect(s.log[0].at).toBe(String(LOG_KEPT + 4));
  });
});

describe('rawEmail', () => {
  it('builds a plain-text message with encoded headers and no header injection', () => {
    const raw = rawEmail({ from: 'formular@geoli.eu', fromName: 'Investiții geoli.eu', to: 'me@example.com', subject: 'Scădere\r\nBcc: x@y', text: 'Salut\nă', date: new Date('2026-01-01T00:00:00Z'), id: 'id1' });
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('From: =?UTF-8?B?');
    expect(head).toContain('To: <me@example.com>');
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toContain('Message-ID: <id1@geoli.eu>');
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), c => c.charCodeAt(0)));
    expect(decoded).toBe('Salut\r\nă');
  });
});
