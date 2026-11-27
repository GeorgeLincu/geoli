// /vault/invest/ dashboard — compact "Avere netă" card (full page: /vault/invest/avere/).
import { loadDoc, loadMarket } from './api';
import { activeIpsRules } from '../../lib/invest/ips-checks';
import { manualFx, chainFx } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices } from '../../lib/invest/market-sources';
import { netWorthAt, firstNetWorthDate, monthlyExpenses, emergencyStatus } from '../../lib/invest/networth';

const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function run() {
  const state = document.getElementById('nwCardState');
  if (!state) return;
  const set = (k: string, v: string, cls = '') => {
    const el = document.querySelector<HTMLElement>(`[data-nwc="${k}"]`);
    if (el) { el.textContent = v; el.className = cls; }
  };
  try {
    const [d, ipsDoc] = await Promise.all([loadDoc('data'), loadDoc('ips').catch(() => null)]);
    const data = d.doc;
    const today = todayIso();
    const ips = ipsDoc?.exists ? activeIpsRules(ipsDoc.doc)?.rules ?? null : null;
    // Only today's figure: the current year's rates/prices are enough (older ones only as fallback).
    const first = firstNetWorthDate(data);
    if (!first) { state.textContent = 'Încă nimic de însumat. Adaugă active și datorii pe pagina Avere netă.'; return; }
    const year = Number(today.slice(0, 4));
    const market = await loadMarket([year - 1, year]).catch(() => ({ fx: [], prices: [] }));
    const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
    const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
    const nw = netWorthAt(data, { fx, prices, emergencyAccountIds: ips?.emergencyFund?.accountIds ?? [] }, today);
    const ef = emergencyStatus(nw, monthlyExpenses(data.netWorth, ips), ips);
    set('netEur', `${NF0.format(nw.netEur)} €`, nw.netEur < 0 ? 'is-warn' : '');
    set('netRon', `${NF0.format(nw.netRon)} lei`);
    set('ef', ef.months === null ? '—' : `${NF1.format(ef.months)} luni${ef.targetMonths !== null ? ` / ${NF0.format(ef.targetMonths)}` : ''}`,
      ef.status === 'under' ? 'is-warn' : '');
    set('ratio', nw.debtToAssets === null ? '—' : `${NF1.format(nw.debtToAssets * 100)}%`);
    state.textContent = nw.missingFx.length
      ? `Lipsește cursul pentru ${nw.missingFx.join(', ')}; acele valori nu intră în total.`
      : `Active ${NF0.format(nw.assetsEur)} €, datorii ${NF0.format(nw.liabilitiesEur)} €.`;
  } catch (e) {
    state.textContent = `Averea netă nu a putut fi calculată: ${(e as Error).message}`;
  }
}

void run();
