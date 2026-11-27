// /vault/invest/ dashboard — "Ce cumpăr luna asta": the monthly contribution split into units, toward the target.
// Logic in src/lib/invest/buyplan.ts. Read-only: nothing is saved or bought.
import { loadDocOnce, loadMarketOnce } from './api';
import { manualFx, chainFx, convert } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { activeIpsRules } from '../../lib/invest/ips-checks';
import { firstNetWorthDate } from '../../lib/invest/networth';
import { portfolioAt } from '../../lib/invest/report';
import { buyPlan, lineName } from '../../lib/invest/buyplan';
import { eur, NF0, el, byId } from './report-ui';

const NF4 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 4 });

(async () => {
  const form = byId<HTMLFormElement>('bpForm');
  const state = byId('bpState');
  const list = byId('bpList');
  if (!form || !state || !list) return;
  try {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const [loaded, ipsDoc] = await Promise.all([loadDocOnce('data'), loadDocOnce('ips').catch(() => null)]);
    const data = loaded.doc;
    const first = firstNetWorthDate(data);
    if (!data.targets.length || !first) { state.textContent = 'Ai nevoie de o alocare-țintă și de poziții (Portofoliu).'; form.hidden = true; return; }
    const years: number[] = [];
    for (let y = +first.slice(0, 4) - 1; y <= +today.slice(0, 4); y++) years.push(y);
    const market = await loadMarketOnce(years);
    const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
    const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
    const point = portfolioAt(data, { fx, prices }, today);
    const insts = new Map(data.instruments.map(i => [i.id, i]));
    const priceEur = (id: string) => {
      const q = prices.price(id, today);
      const i = insts.get(id);
      return q && i ? convert(fx, q.price, i.currency, 'EUR', today) : null;
    };

    const ipsAmount = ipsDoc?.exists ? activeIpsRules(ipsDoc.doc)?.rules.contribution?.amount : undefined;
    const amountInput = form.elements.namedItem('amount') as HTMLInputElement;
    const frac = form.elements.namedItem('fractional') as HTMLInputElement;
    amountInput.value = String(ipsAmount ?? data.settings.monthlyContribution ?? '');

    const render = () => {
      const amount = Number(amountInput.value.replace(/\s/g, '').replace(',', '.'));
      if (!(amount > 0)) { state.textContent = 'Scrie suma pe care o investești luna asta (EUR).'; list.replaceChildren(); return; }
      const plan = buyPlan(point.holdings, data.targets, amount, priceEur, { fractional: frac.checked });
      list.replaceChildren(...plan.lines.map(l => {
        const li = el('li', null, 'db-alert');
        const name = lineName(l, data.instruments);
        if (l.units > 0) {
          li.append(el('strong', `${frac.checked ? NF4.format(l.units) : NF0.format(l.units)} × ${name}`), el('span', `≈ ${eur(l.costEur)} la ${l.priceEur === null ? '—' : eur(l.priceEur).replace(' €', '')} € · rândul „${l.target.label}”`));
        } else {
          li.append(el('strong', `${name}: ${eur(l.amountEur)}`), el('span', l.priceEur === null
            ? `fără preț${l.instrumentId ? '' : ' și fără instrument ales pentru rândul „' + l.target.label + '”'} — cumpără manual`
            : 'prea puțin pentru o unitate întreagă; rămâne pentru luna viitoare'));
        }
        return li;
      }));
      state.textContent = `Din ${eur(amount)}: ${eur(plan.spent)} în unități${plan.leftover >= 1 ? `, rămân ${eur(plan.leftover)} cash` : ''}. Banii merg întâi la rândurile cele mai sub țintă; nu se vinde nimic.`;
    };
    form.addEventListener('submit', e => { e.preventDefault(); render(); });
    frac.addEventListener('change', render);
    render();
  } catch (e) {
    state.textContent = (e as Error).message;
  }
})();
