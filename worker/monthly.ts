// Monthly summary e-mail (owner only; routed from invest.ts, run by the cron in index.ts after the alerts).
//
//   GET  /vault/api/invest/monthly            → { settings, state, email }
//   PUT  /vault/api/invest/monthly/settings   → save invest/monthly.json (validated)
//   POST /vault/api/invest/monthly/test       → send last month's summary now (at most one per 2 minutes)
//
// Off by default. Sent once per month (state invest/monthly-state.json `lastSent`) on the first cron run of the
// month, through the same send_email binding as the alerts, only to the first INVEST_EMAILS address.
import { EmailMessage } from 'cloudflare:email';
import type { Env } from './index';
import { emailList } from './auth';
import { error, json } from './http';
import type { InvestData, IpsDoc } from '../src/lib/invest/types';
import type { FxYear, PricesYear } from '../src/lib/invest/market';
import { rawEmail } from '../src/lib/invest/alerts';
import { manualFx, chainFx } from '../src/lib/invest/fx';
import { manualPrices, chainPrices } from '../src/lib/invest/prices';
import { bnrFx, storePrices } from '../src/lib/invest/market-sources';
import { activeIpsRules } from '../src/lib/invest/ips-checks';
import {
  withMonthlyDefaults, validateMonthlySettings, emptyMonthlyState, dueMonth, previousMonth, monthSummary, monthlyEmail,
  TEST_COOLDOWN_MS, type MonthlyState,
} from '../src/lib/invest/monthly';

const P = 'invest/';
const SETTINGS_KEY = `${P}monthly.json`;
const STATE_KEY = `${P}monthly-state.json`;
const PAGE = 'https://geoli.eu/vault/invest/rapoarte/';

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.VAULT.get(key);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()) as T; } catch { return null; }
}
const putJson = (env: Env, key: string, value: unknown) =>
  env.VAULT.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

const ownerAddress = (env: Env) => emailList(env.INVEST_EMAILS)[0] ?? '';

/** Computes the summary of `month` from the stored data (two valuations + net worth, cheap enough for the cron). */
async function compose(env: Env, month: string, includeAmounts: boolean, test: boolean) {
  const y = +month.slice(0, 4);
  const years = [y - 1, y];
  const [data, ips, ...docs] = await Promise.all([
    getJson<InvestData>(env, `${P}data.json`), getJson<IpsDoc>(env, `${P}ips.json`),
    ...years.map(yy => getJson<FxYear>(env, `${P}fx/${yy}.json`)),
    ...years.map(yy => getJson<PricesYear>(env, `${P}prices/${yy}.json`)),
  ]);
  if (!data) throw new Error('no data.json');
  const fxDocs = docs.slice(0, years.length).filter((d): d is FxYear => !!d);
  const priceDocs = docs.slice(years.length).filter((d): d is PricesYear => !!d) as unknown as PricesYear[];
  const fx = chainFx(bnrFx(fxDocs), manualFx(data.fxRates ?? []));
  const prices = chainPrices(storePrices(priceDocs, data.instruments, fx), manualPrices(data.prices ?? []));
  const s = monthSummary(data, { fx, prices, emergencyAccountIds: activeIpsRules(ips)?.rules.emergencyFund?.accountIds ?? [] }, month);
  return monthlyEmail(s, includeAmounts, PAGE, test);
}

async function send(env: Env, subject: string, text: string) {
  if (!env.CONTACT_EMAIL) throw new Error('send_email binding missing');
  const to = ownerAddress(env);
  if (!to) throw new Error('INVEST_EMAILS is empty');
  const from = env.CONTACT_FROM || 'formular@geoli.eu';
  await env.CONTACT_EMAIL.send(new EmailMessage(from, to, rawEmail({ from, fromName: 'Investiții geoli.eu', to, subject, text })));
}

const log = (st: MonthlyState, e: MonthlyState['log'][number]): MonthlyState => ({ ...st, log: [e, ...st.log].slice(0, 24) });

/** Cron: sends last month's summary once, if turned on. A failed send is retried at the next run. */
export async function runMonthly(env: Env, now = new Date()) {
  const settings = withMonthlyDefaults(await getJson(env, SETTINGS_KEY));
  const state = (await getJson<MonthlyState>(env, STATE_KEY)) ?? emptyMonthlyState();
  const today = now.toISOString().slice(0, 10);
  const month = dueMonth(settings, state, today);
  if (!month) return { sent: false };
  try {
    const mail = await compose(env, month, settings.includeAmounts, false);
    await send(env, mail.subject, mail.text);
    await putJson(env, STATE_KEY, log({ ...state, lastSent: month }, { at: now.toISOString(), month, ok: true }));
    return { sent: true, month };
  } catch (e) {
    await putJson(env, STATE_KEY, log(state, { at: now.toISOString(), month, ok: false, message: String((e as Error).message).slice(0, 200) }));
    throw e;
  }
}

export async function handleMonthlyApi(request: Request, env: Env, sub: string): Promise<Response> {
  const method = request.method;
  if (sub === '' && method === 'GET') {
    const [raw, state] = await Promise.all([getJson(env, SETTINGS_KEY), getJson<MonthlyState>(env, STATE_KEY)]);
    return json({
      settings: withMonthlyDefaults(raw), saved: !!raw, state: state ?? emptyMonthlyState(),
      email: { configured: !!env.CONTACT_EMAIL, to: ownerAddress(env) },
    });
  }
  if (sub === 'settings' && method === 'PUT') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) return error(415, 'JSON expected');
    const text = await request.text();
    if (text.length > 2000) return error(413, 'Too large');
    let body: unknown;
    try { body = JSON.parse(text); } catch { return error(400, 'Invalid JSON'); }
    const { settings, problems } = validateMonthlySettings(body);
    if (!settings) return json({ error: 'Invalid settings', problems }, 422);
    await putJson(env, SETTINGS_KEY, settings);
    return json({ ok: true, settings });
  }
  if (sub === 'test' && method === 'POST') {
    const now = new Date();
    const state = (await getJson<MonthlyState>(env, STATE_KEY)) ?? emptyMonthlyState();
    const wait = state.lastTest ? TEST_COOLDOWN_MS - (now.getTime() - Date.parse(state.lastTest)) : 0;
    if (wait > 0) {
      const res = error(429, 'Prea des — încearcă din nou peste câteva minute');
      res.headers.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res;
    }
    const settings = withMonthlyDefaults(await getJson(env, SETTINGS_KEY));
    const month = previousMonth(now.toISOString().slice(0, 10));
    try {
      const mail = await compose(env, month, settings.includeAmounts, true);
      await send(env, mail.subject, mail.text);
      await putJson(env, STATE_KEY, log({ ...state, lastTest: now.toISOString() }, { at: now.toISOString(), month, ok: true, message: 'test' }));
      return json({ ok: true, to: ownerAddress(env), month });
    } catch (e) {
      await putJson(env, STATE_KEY, { ...state, lastTest: now.toISOString() });
      return error(502, `Trimiterea a eșuat: ${(e as Error).message}`);
    }
  }
  return error(404, 'Not found');
}
