// /vault/invest/ dashboard — Phase 6: alerts from the machine-checkable IPS rules.
// Gathers the facts (valuation, drift, this month's contributions, drawdown) and hands them to ips-checks.
// Phase 7: the dashboard calls collectIpsAlerts() and shows them with the other alerts.
import { loadDocOnce as loadDoc, loadMarketOnce as loadMarket } from './api';
import { activeIpsRules, latestIpsVersion, ipsAlerts, monthContributions, drawdownFromCloses, type IpsFacts, type IpsAlert } from '../../lib/invest/ips-checks';
import { computeLedger } from '../../lib/invest/ledger';
import { manualFx, chainFx, convert } from '../../lib/invest/fx';
import { manualPrices, chainPrices } from '../../lib/invest/prices';
import { bnrFx, storePrices, marketYears } from '../../lib/invest/market-sources';
import { valuePortfolio, computeDrift } from '../../lib/invest/portfolio';

/** Same fallback band as the Portofoliu page (rows without their own band). */
const DEFAULT_BAND = 0.05;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface IpsAlertsResult { alerts: IpsAlert[]; summary: string }

/** IPS alerts for today, with a one-line summary (which version, or why there are none). */
export async function collectIpsAlerts(): Promise<IpsAlertsResult> {
    const ips = await loadDoc('ips');
    const active = ips.exists ? activeIpsRules(ips.doc) : null;
    if (!active) {
      const v = ips.exists ? latestIpsVersion(ips.doc) : null;
      return { alerts: [], summary: v
        ? 'IPS-ul tău nu are reguli verificabile. Le poți adăuga în IPS (opțional), apoi salvezi o versiune nouă.'
        : 'Nu ai salvat încă un IPS. După prima versiune, regulile verificabile apar aici.' };
    }
    const { rules } = active;
    const today = todayIso();
    const facts: IpsFacts = { today };

    const needData = !!(rules.driftAlerts || rules.emergencyFund || rules.contribution || rules.crash?.referenceInstrumentId);
    if (needData) {
      const dataDoc = await loadDoc('data');
      const data = dataDoc.doc;
      const market = await loadMarket(marketYears(data.transactions.map(t => t.date), today)).catch(() => ({ fx: [], prices: [] }));
      const fx = chainFx(bnrFx(market.fx), manualFx(data.fxRates ?? []));
      const prices = chainPrices(storePrices(market.prices, data.instruments, fx), manualPrices(data.prices ?? []));
      const ledger = computeLedger(data, fx, today);
      const valuation = valuePortfolio(data, ledger, prices, fx, today);

      // Same scope as the Portofoliu page defaults: without Pillar 2/3, with cash.
      facts.drift = data.targets.length
        ? computeDrift(valuation.holdings.filter(x => x.kind !== 'pension' && (x.valueEur ?? 0) > 0), data.targets, DEFAULT_BAND)
        : null;
      const perAccount = new Map<string, number | null>();
      for (const h of valuation.holdings) {
        const prev = perAccount.get(h.accountId);
        perAccount.set(h.accountId, prev === null || h.valueEur === null ? null : (prev ?? 0) + h.valueEur);
      }
      facts.accountValuesEur = perAccount;
      facts.contributions = monthContributions(data.transactions, today, (amount, currency, date) => convert(fx, amount, currency, 'EUR', date));

      const ref = rules.crash?.referenceInstrumentId;
      if (ref) {
        // The high is the highest close in the saved price store (loaded years); older manual prices from
        // data.json only for dates the store doesn't have.
        const byDate = new Map<string, number>();
        for (const p of data.prices ?? []) if (p.instrumentId === ref) byDate.set(p.date, p.price);
        for (const doc of market.prices) for (const [date, p] of Object.entries(doc.prices[ref] ?? {})) byDate.set(date, p.close);
        const closes = [...byDate.entries()];
        facts.drawdown = drawdownFromCloses(closes);
      }
      facts.accountName = id => data.accounts.find(a => a.id === id)?.name ?? id;
      facts.instrumentName = id => { const i = data.instruments.find(x => x.id === id); return i ? (i.ticker || i.name) : id; };
    }

    const alerts = ipsAlerts(ips.doc, facts);
    const when = active.version.date.split('-').reverse().join('.');
    return { alerts, summary: alerts.length ? `Conform IPS-ului din ${when}.` : `Regulile IPS sunt respectate (IPS-ul din ${when}).` };
}
