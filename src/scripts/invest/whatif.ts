// /vault/invest/simulare/ — "Ce-ar fi dacă retrag bani?" Logic in src/lib/invest/whatif.ts; nothing is saved.
import { loadDocOnce, loadMarketOnce } from './api';
import { manualFx, chainFx, convert } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { firstNetWorthDate } from '../../lib/invest/networth';
import { portfolioAt, driftOf, fiProgress, taxResults, type PortfolioPoint } from '../../lib/invest/report';
import { planWithdrawal, withdrawalTax, eligible } from '../../lib/invest/whatif';
import { rulesFor, unconfirmedParams } from '../../lib/invest/tax-ro';
import type { InvestData, TaxRules, Currency } from '../../lib/invest/types';
import type { FxYear } from '../../lib/invest/market';
import type { FxSource } from '../../lib/invest/fx';
import { eur, ron, pct, NF1, el, byId, kpi, row, chip } from './report-ui';

interface Ctx { data: InvestData; rules: TaxRules | null; fxDocs: FxYear[]; fx: FxSource; point: PortfolioPoint; today: string }
let ctx: Ctx;
const form = byId<HTMLFormElement>('wiForm')!;
const sel = (n: string) => form.elements.namedItem(n) as HTMLSelectElement;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const instName = (id: string) => { const i = ctx.data.instruments.find(x => x.id === id); return i ? (i.ticker || i.name) : id; };
const accName = (id: string) => ctx.data.accounts.find(a => a.id === id)?.name ?? id;

function fillSelects() {
  const pos = eligible(ctx.point.holdings, {});
  const accIds = [...new Set(pos.map(h => h.accountId))];
  const instIds = [...new Set(pos.map(h => h.instrumentId!))];
  const opt = (v: string, t: string) => { const o = el('option', t); o.value = v; return o; };
  sel('accountId').replaceChildren(opt('', 'toate conturile'), ...accIds.map(id => opt(id, accName(id))));
  sel('instrumentId').replaceChildren(opt('', 'toate instrumentele'), ...instIds.map(id => opt(id, instName(id))));
}

function calculate() {
  const raw = (form.elements.namedItem('amount') as HTMLInputElement).value.replace(/\s/g, '').replace(',', '.');
  const amount = Number(raw);
  const currency = sel('currency').value as Currency;
  if (!(amount > 0)) { byId('wiState')!.textContent = 'Scrie o sumă mai mare decât 0.'; return; }
  const amountEur = convert(ctx.fx, amount, currency, 'EUR', ctx.today);
  if (amountEur === null) { byId('wiState')!.textContent = 'Lipsește cursul BNR de azi.'; return; }
  const filter = { accountId: sel('accountId').value || undefined, instrumentId: sel('instrumentId').value || undefined };
  const plan = planWithdrawal(ctx.point.holdings, amountEur, filter, ctx.fx, ctx.today);
  if (!plan.lines.length) { byId('wiState')!.textContent = 'Nu există poziții de vândut în selecția aleasă.'; byId('wiOut')!.hidden = true; return; }

  // Tax: marginal on top of this year's realised income (same engine as the Taxe page)
  const year = +ctx.today.slice(0, 4);
  const r = rulesFor(ctx.rules, year);
  const warns: string[] = [];
  let taxRon: number | null = null, cassRon = 0;
  if (r) {
    const ty = taxResults(ctx.data, ctx.rules, ctx.fxDocs, ctx.fx, year).get(year);
    const t = withdrawalTax(r.set, year, plan.lines, ctx.data.accounts, ty?.aggregates, ty?.carryIn);
    taxRon = t.estimate.total; cassRon = t.estimate.cassDelta;
    if (t.missing) warns.push(`${t.missing} vânzări fără curs RON, lăsate în afara impozitului.`);
    if (!r.exact) warns.push(`Se folosesc parametrii fiscali din ${r.set.year}.`);
    if (unconfirmedParams(r.set).length) warns.push('Parametrii fiscali nu sunt toți confirmați de tine (pagina Taxe).');
    if (plan.lines.some(l => ctx.data.accounts.find(a => a.id === l.accountId)?.type === 'ro_broker')) {
      warns.push('La brokerul RO se presupune deținere peste un an (cota mică reținută la sursă).');
    }
  } else warns.push('Nu există parametri fiscali; impozitul nu se poate estima (pagina Taxe).');
  if (plan.shortfallEur > 0.5) warns.push(`Selecția are doar ${eur(plan.soldEur)}; lipsesc ${eur(plan.shortfallEur)}.`);

  const soldRon = convert(ctx.fx, plan.soldEur, 'EUR', 'RON', ctx.today);
  const taxEur = taxRon === null ? null : convert(ctx.fx, taxRon, 'RON', 'EUR', ctx.today);
  const before = fiProgress(ctx.data.settings, ctx.data.targets, year, ctx.point.eur);
  const afterCap = ctx.point.eur - plan.soldEur;
  const after = fiProgress(ctx.data.settings, ctx.data.targets, year, afterCap);
  const delay = before?.yearsToFI != null && after?.yearsToFI != null ? after.yearsToFI - before.yearsToFI : null;

  byId('wiKpis')!.replaceChildren(
    kpi('Se vinde', eur(plan.soldEur), { hero: true, note: ron(soldRon) }),
    kpi('Impozit + CASS estimat', taxRon === null ? '—' : ron(taxRon), { note: cassRon ? `din care CASS ${ron(cassRon)}` : 'de plătit prin Declarația Unică / reținut' }),
    kpi('Rămâne net', soldRon === null || taxRon === null ? '—' : ron(soldRon - taxRon), { note: taxEur === null ? undefined : eur(plan.soldEur - taxEur) }),
    kpi('Portofoliu după', eur(afterCap), { note: `acum ${eur(ctx.point.eur)}` }),
    kpi('Ani până la FI', after?.yearsToFI == null ? '—' : NF1.format(after.yearsToFI), {
      note: delay === null ? 'completează Planul' : delay < 0.05 ? 'aproape fără întârziere' : `+${NF1.format(delay)} ani față de acum`,
    }),
  );
  const warn = byId('wiWarn')!;
  warn.textContent = warns.join(' ');
  warn.hidden = !warns.length;

  byId<HTMLTableElement>('wiSales')!.tBodies[0].replaceChildren(...plan.lines.map(l => {
    const tr = row(instName(l.instrumentId), [accName(l.accountId), NF1.format(l.quantity), eur(l.valueEur), l.gainRon === null ? '—' : ron(l.gainRon)]);
    (tr.children[1] as HTMLElement).className = '';
    return tr;
  }));

  const d0 = driftOf(ctx.point.holdings, ctx.data.targets);
  const d1 = driftOf(plan.after, ctx.data.targets);
  const allocState = byId('wiAllocState')!;
  if (!d0 || !d1) {
    byId<HTMLTableElement>('wiAlloc')!.tBodies[0].replaceChildren();
    allocState.textContent = 'Nu ai o alocare-țintă (Portofoliu).';
  } else {
    byId<HTMLTableElement>('wiAlloc')!.tBodies[0].replaceChildren(...d1.rows.map((r1, i) => {
      const r0 = d0.rows[i];
      return row(r1.target.label, [pct(r1.target.weight), pct(r0.actualWeight), pct(r1.actualWeight),
        chip(r1.status === 'ok' ? 'ok' : 'warn', r1.status === 'ok' ? '✓ în bandă' : r1.status === 'over' ? '▲ peste' : '▼ sub')]);
    }));
    allocState.textContent = filterNote(filter);
  }
  byId('wiState')!.textContent = `Calculat la cursul BNR și prețurile de azi (${ctx.today.split('-').reverse().join('.')}). Estimare, nu consultanță fiscală.`;
  byId('wiOut')!.hidden = false;
}

const filterNote = (f: { accountId?: string; instrumentId?: string }) =>
  f.accountId || f.instrumentId ? 'Vânzarea dintr-o singură parte a portofoliului schimbă alocarea; vezi coloana „După”.' : 'Vânzarea proporțională din tot păstrează alocarea aproape neschimbată.';

(async () => {
  const state = byId('wiState')!;
  try {
    const today = todayIso();
    const [d, rulesDoc] = await Promise.all([loadDocOnce('data'), loadDocOnce('tax-rules').catch(() => null)]);
    const data = d.doc;
    const first = firstNetWorthDate(data);
    if (!first) { state.textContent = 'Încă nu ai poziții în Portofoliu.'; form.hidden = true; return; }
    const years: number[] = [];
    for (let y = +first.slice(0, 4); y <= +today.slice(0, 4); y++) years.push(y);
    const market = await loadMarketOnce(years);
    const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
    const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
    ctx = { data, rules: rulesDoc?.exists ? rulesDoc.doc : null, fxDocs: market.fx, fx, point: portfolioAt(data, { fx, prices }, today), today };
    fillSelects();
    state.textContent = `Portofoliu (fără Pilon 2/3): ${eur(ctx.point.eur)}. Scrie suma și apasă „Calculează”.`;
    form.addEventListener('submit', e => { e.preventDefault(); calculate(); });
  } catch (e) {
    state.textContent = (e as Error).message;
  }
})();
