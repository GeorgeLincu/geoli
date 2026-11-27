// "Scădere de la maxim" history + e-mail alerts for /vault/invest/ (owner only; routed from invest.ts).
//
//   cron (after runMarketUpdate)                 → runHistoryBackfill(env, n) then runAlerts(env)
//   GET  /vault/api/invest/alerts                → settings, levels (own + from the IPS), state/log, history index
//   PUT  /vault/api/invest/alerts/settings       → save invest/alerts.json (validated)
//   POST /vault/api/invest/alerts/test           → test e-mail (rate-limited)
//   POST /vault/api/invest/alerts/history        → fetch missing long histories now {instrumentId?, force?} (rate-limited)
//   GET  /vault/api/invest/alerts/history/<id>   → invest/history/<id>.json (weekly closes)
//
// Outbound: only ticker symbols to Yahoo (as in worker/market.ts). E-mail goes only to the owner address
// (first of INVEST_EMAILS, which must be a verified Email Routing destination of the send_email binding).
import { EmailMessage } from 'cloudflare:email';
import type { Env } from './index';
import { emailList } from './auth';
import { error, json, respond } from './http';
import type { InvestData } from '../src/lib/invest/types';
import {
  parsePriceSource, yahooChartUrl, parseYahooChart, mergePrices, latestPrice, emptyPricesYear,
  type PricesYear, type PriceSeries,
} from '../src/lib/invest/market';
import {
  HISTORY_VERSION, HISTORY_DAILY_DAYS, emptyHistoryIndex, yahooWeeklyUrl, pointsToTuples, highOf, mergeSeries,
  drawdownStats, ipsDipLevels, type HistoryDoc, type HistoryIndex, type Point,
} from '../src/lib/invest/drawdown';
import {
  withDefaults, validateAlertSettings, emptyAlertState, ipsTaxDeadline, effectiveDuDate, heldQuantities, planAlerts, composeEmail,
  logSend, testWaitMs, recordTest, rawEmail, type AlertState, type AlertInstrument,
} from '../src/lib/invest/alerts';

const P = 'invest/';
const SETTINGS_KEY = `${P}alerts.json`;
const STATE_KEY = `${P}alerts-state.json`;
const INDEX_KEY = `${P}history/index.json`;
const HISTORY_KEY = (id: string) => `${P}history/${id}.json`;
const PRICES_KEY = (y: number) => `${P}prices/${y}.json`;
const DATA_KEY = `${P}data.json`;
const IPS_KEY = `${P}ips.json`;

const SITE = 'https://geoli.eu';
export const PAGE_PATH = '/vault/invest/oportunitati/';
const MANUAL_HISTORY_MAX = 5;
const MANUAL_HISTORY_COOLDOWN_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0';

/** Instrument ids become R2 key segments */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.VAULT.get(key);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()) as T; } catch { return null; }
}
const putJson = (env: Env, key: string, value: unknown) =>
  env.VAULT.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

// ───────────── Long history (one-off per instrument) ─────────────

async function yahoo(urlFor: (host: string) => string): Promise<PriceSeries> {
  let last = '';
  for (const host of ['query1', 'query2']) {
    const res = await fetch(urlFor(host), {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual',
    });
    if (res.ok || res.status === 404) return parseYahooChart(await res.json().catch(() => null));
    last = `Yahoo: HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(last);
}

/** Adds daily closes to the shared price store; ETag-guarded so a parallel cron/override isn't lost. */
async function mergeIntoStore(env: Env, instrumentId: string, series: PriceSeries) {
  const years = [...new Set(series.points.map(p => Number(p.date.slice(0, 4))))];
  for (const y of years) {
    const part: PriceSeries = { ...series, points: series.points.filter(p => p.date.startsWith(`${y}-`)) };
    for (let attempt = 0; attempt < 3; attempt++) {
      const obj = await env.VAULT.get(PRICES_KEY(y));
      const doc: PricesYear = obj ? JSON.parse(await obj.text()) : emptyPricesYear(y);
      const docs = new Map([[y, doc]]);
      if (!mergePrices(docs, instrumentId, part).length) break;
      const put = await env.VAULT.put(PRICES_KEY(y), JSON.stringify(doc), {
        httpMetadata: { contentType: 'application/json' },
        ...(obj ? { onlyIf: { etagMatches: obj.etag } } : { onlyIf: { etagDoesNotMatch: '*' } }),
      });
      if (put) break;
    }
  }
}

/** Weekly history since listing + last ~13 months of daily closes into the price store. */
async function fetchHistory(env: Env, index: HistoryIndex, inst: { id: string; priceSource?: string }) {
  const src = parsePriceSource(inst.priceSource);
  if (!src || !SAFE_ID.test(inst.id)) return;
  const now = new Date().toISOString();
  const p2 = Math.floor(Date.now() / 1000);
  try {
    const weekly = await yahoo(h => yahooWeeklyUrl(src.symbol, p2, h));
    if (!weekly.points.length) throw new Error('Yahoo: no data');
    const daily = await yahoo(h => yahooChartUrl(src.symbol, p2 - HISTORY_DAILY_DAYS * 86_400, p2, h));
    await mergeIntoStore(env, inst.id, daily);
    const doc: HistoryDoc = {
      version: HISTORY_VERSION, instrumentId: inst.id, symbol: src.symbol, currency: weekly.currency,
      fetchedAt: now, weekly: pointsToTuples(weekly.points),
    };
    await putJson(env, HISTORY_KEY(inst.id), doc);
    const all = mergeSeries(weekly.points, daily.points);
    index.instruments[inst.id] = {
      symbol: src.symbol, currency: weekly.currency, fetchedAt: now, ok: true,
      from: all[0].date, to: all[all.length - 1].date, points: weekly.points.length, ath: highOf(all)!,
    };
  } catch (e) {
    const prev = index.instruments[inst.id];
    index.instruments[inst.id] = prev?.ok
      ? { ...prev, message: `Reîncercare eșuată: ${errMsg(e)}` }
      : { symbol: src.symbol, currency: 'EUR', fetchedAt: now, ok: false, message: errMsg(e), from: '', to: '', points: 0, ath: { date: '', close: 0 } };
  }
}

/** Instruments with an automatic source whose history is missing, failed, or whose symbol changed. */
function needsHistory(data: InvestData | null, index: HistoryIndex) {
  return (data?.instruments ?? []).filter(i => {
    const src = parsePriceSource(i.priceSource);
    if (!src) return false;
    const e = index.instruments[i.id];
    return !e || !e.ok || e.symbol !== src.symbol;
  });
}

/** Called from the cron with a small budget (free plan: 50 subrequests per invocation). */
export async function runHistoryBackfill(env: Env, max: number) {
  if (max <= 0) return 0;
  const [data, index] = await Promise.all([getJson<InvestData>(env, DATA_KEY), getJson<HistoryIndex>(env, INDEX_KEY)]);
  const idx = index ?? emptyHistoryIndex();
  // Failed ones are retried at most once a day
  const day = new Date().toISOString().slice(0, 10);
  const todo = needsHistory(data, idx).filter(i => idx.instruments[i.id]?.fetchedAt?.slice(0, 10) !== day).slice(0, max);
  for (const inst of todo) await fetchHistory(env, idx, inst);
  if (todo.length) await putJson(env, INDEX_KEY, idx);
  return todo.length;
}

/** History fetches the cron can afford after the price job: worst case 4 subrequests each (2 calls × 2 hosts). */
export function cronHistoryBudget(fetchableInstruments: number) {
  const left = 50 - 3 - 2 * Math.min(fetchableInstruments, 20) - 4; // BNR + 2 backfills, prices, margin
  return Math.max(0, Math.min(2, Math.floor(left / 4)));
}

// ───────────── Alerts ─────────────

const ownerAddress = (env: Env) => emailList(env.INVEST_EMAILS)[0] ?? '';

async function send(env: Env, subject: string, text: string) {
  if (!env.CONTACT_EMAIL) throw new Error('send_email binding missing');
  const to = ownerAddress(env);
  if (!to) throw new Error('INVEST_EMAILS is empty');
  const from = env.CONTACT_FROM || 'formular@geoli.eu';
  await env.CONTACT_EMAIL.send(new EmailMessage(from, to, rawEmail({ from, fromName: 'Investiții geoli.eu', to, subject, text })));
}

/** Builds the per-instrument inputs for planAlerts from the stored data (no big history files parsed). */
async function alertInputs(env: Env, today: string) {
  const y = Number(today.slice(0, 4));
  const [data, ips, index, p0, p1] = await Promise.all([
    getJson<InvestData>(env, DATA_KEY), getJson<unknown>(env, IPS_KEY), getJson<HistoryIndex>(env, INDEX_KEY),
    getJson<PricesYear>(env, PRICES_KEY(y - 1)), getJson<PricesYear>(env, PRICES_KEY(y)),
  ]);
  const docs = [p0, p1].filter((d): d is PricesYear => !!d);
  const held = heldQuantities(data?.transactions ?? [], today);
  const instruments: AlertInstrument[] = (data?.instruments ?? []).map(i => {
    const store: Point[] = [];
    for (const d of docs) for (const [date, p] of Object.entries(d.prices[i.id] ?? {})) store.push({ date, close: p.close });
    const ath = index?.instruments[i.id]?.ok ? [index.instruments[i.id].ath] : [];
    const st = drawdownStats(mergeSeries(ath, store));
    const latest = latestPrice(docs, i.id);
    return {
      id: i.id, name: i.name, ticker: i.ticker, auto: !!parsePriceSource(i.priceSource), currency: i.currency,
      latest: latest ? { date: latest.date, close: latest.close, currency: latest.currency } : null,
      ...(st ? {
        belowAth: st.belowAth, below52: st.below52, athDate: st.ath.date, athClose: st.ath.close,
        high52Date: st.high52.date, high52Close: st.high52.close,
      } : {}),
      maturity: i.maturity, faceValue: i.faceValue, held: held.get(i.id) ?? 0,
    };
  });
  return { instruments, ips: ipsDipLevels(ips), ipsDeadline: ipsTaxDeadline(ips, today) };
}

export async function runAlerts(env: Env) {
  const settings = withDefaults(await getJson(env, SETTINGS_KEY));
  if (!settings.emailEnabled) return { sent: false, reason: 'off' };
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const state = (await getJson<AlertState>(env, STATE_KEY)) ?? emptyAlertState();
  const { instruments, ips, ipsDeadline } = await alertInputs(env, today);
  const plan = planAlerts({ today, now, settings, state, instruments, ips, ipsTaxDeadline: ipsDeadline, pageUrl: SITE + PAGE_PATH });
  if (!plan.items.length) { await putJson(env, STATE_KEY, plan.state); return { sent: false, reason: 'nothing new' }; }
  const kinds = [...new Set(plan.items.map(i => i.kind))];
  try {
    await send(env, plan.subject, plan.text);
    await putJson(env, STATE_KEY, logSend(plan.state, { at: now, kinds, subject: plan.subject, ok: true }));
    return { sent: true, items: plan.items.length };
  } catch (e) {
    // Keep the old de-duplication state so the same events are tried again on the next run
    await putJson(env, STATE_KEY, logSend({ ...state, lastRun: now }, { at: now, kinds, subject: plan.subject, ok: false, error: errMsg(e) }));
    return { sent: false, reason: errMsg(e) };
  }
}

// ───────────── API ─────────────

export async function handleAlertsApi(request: Request, env: Env, sub: string, origin: string): Promise<Response> {
  const method = request.method;

  if (sub === '' && method === 'GET') {
    const [raw, state, index, ips] = await Promise.all([
      getJson(env, SETTINGS_KEY), getJson<AlertState>(env, STATE_KEY), getJson<HistoryIndex>(env, INDEX_KEY), getJson(env, IPS_KEY),
    ]);
    const settings = withDefaults(raw);
    const st = state ?? emptyAlertState();
    const today = new Date().toISOString().slice(0, 10);
    const ipsDeadline = ipsTaxDeadline(ips, today);
    return json({
      settings, saved: !!raw,
      // IPS crash rules (reference instrument only) and the DU deadline actually used
      ips: ipsDipLevels(ips), ipsTaxDeadline: ipsDeadline, duDate: effectiveDuDate(settings, ipsDeadline),
      state: { lastRun: st.lastRun ?? null, log: st.log, drawdown: st.drawdown },
      history: index ?? emptyHistoryIndex(),
      email: { configured: !!env.CONTACT_EMAIL, to: ownerAddress(env), from: env.CONTACT_FROM || 'formular@geoli.eu' },
      testWaitMs: testWaitMs(st, new Date()),
    });
  }

  if (sub === 'settings' && method === 'PUT') {
    const body = await readJson(request, 20_000);
    if (body instanceof Response) return body;
    const r = validateAlertSettings(body);
    if (!r.settings) return json({ error: 'Setări invalide', problems: r.problems }, 422);
    await putJson(env, SETTINGS_KEY, r.settings);
    return json({ ok: true, settings: r.settings });
  }

  if (sub === 'test' && method === 'POST') {
    const state = (await getJson<AlertState>(env, STATE_KEY)) ?? emptyAlertState();
    const now = new Date();
    const wait = testWaitMs(state, now);
    if (wait > 0) {
      const res = json({ error: 'Prea des — încearcă din nou mai târziu.', retryAfter: Math.ceil(wait / 1000) }, 429);
      res.headers.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res;
    }
    const claimed = recordTest(state, now);
    await putJson(env, STATE_KEY, claimed); // claim the slot before sending
    const { subject, text } = composeEmail([], origin + PAGE_PATH, true);
    try {
      await send(env, subject, text);
      await putJson(env, STATE_KEY, logSend(claimed, { at: now.toISOString(), kinds: [], subject, ok: true, test: true }));
      return json({ ok: true, to: ownerAddress(env) });
    } catch (e) {
      await putJson(env, STATE_KEY, logSend(claimed, { at: now.toISOString(), kinds: [], subject, ok: false, error: errMsg(e), test: true }));
      return json({ error: `Trimiterea a eșuat: ${errMsg(e)}` }, 502);
    }
  }

  if (sub === 'history' && method === 'POST') {
    const body = await readJson(request, 1000);
    if (body instanceof Response) return body;
    const { instrumentId, force } = body as { instrumentId?: unknown; force?: unknown };
    const [data, index] = await Promise.all([getJson<InvestData>(env, DATA_KEY), getJson<HistoryIndex>(env, INDEX_KEY)]);
    const idx = index ?? emptyHistoryIndex();
    const wait = (idx.lastManualRun ? Date.parse(idx.lastManualRun) : 0) + MANUAL_HISTORY_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      const res = json({ error: 'Prea des — încearcă din nou peste un minut.', retryAfter: Math.ceil(wait / 1000) }, 429);
      res.headers.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res;
    }
    let todo = needsHistory(data, idx);
    if (typeof instrumentId === 'string') {
      const inst = data?.instruments.find(i => i.id === instrumentId && parsePriceSource(i.priceSource));
      if (!inst) return error(404, 'Instrument fără sursă automată de preț');
      todo = force === true || todo.includes(inst) ? [inst] : [];
    }
    todo = todo.slice(0, MANUAL_HISTORY_MAX);
    idx.lastManualRun = new Date().toISOString();
    await putJson(env, INDEX_KEY, idx);
    for (const inst of todo) await fetchHistory(env, idx, inst);
    await putJson(env, INDEX_KEY, idx);
    return json({ ok: true, fetched: todo.map(i => i.id), remaining: Math.max(0, needsHistory(data, idx).length), history: idx });
  }

  const m = /^history\/([A-Za-z0-9_-]{1,64})$/.exec(sub);
  if (m && method === 'GET') {
    const obj = await env.VAULT.get(HISTORY_KEY(m[1]));
    if (!obj) return json({ missing: true });
    return respond(obj.body, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  return error(404, 'Not found');
}

async function readJson(request: Request, max: number): Promise<unknown | Response> {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
  const text = await request.text();
  if (text.length > max) return error(413, 'Too large');
  try { return JSON.parse(text || '{}'); } catch { return error(400, 'Invalid JSON'); }
}
