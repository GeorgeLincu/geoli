// /vault/invest/ dashboard — "next 30 days" card of the income calendar.
import { loadCalendarContext, converterFor } from './calendar-data';
import { buildCalendar, upcoming, windowFor, type CalItem } from '../../lib/invest/calendar';

const KIND: Record<CalItem['kind'], string> = {
  coupon: 'Cupon', maturity: 'Scadență', dividend: 'Dividend', interest: 'Dobândă', planned: 'Planificat',
};
const NF2 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 });

async function run() {
  const state = document.getElementById('calState');
  const list = document.getElementById('calNext');
  if (!state || !list) return;
  try {
    const ctx = await loadCalendarContext(true);
    if (!ctx.data.exists) { state.textContent = 'Încă nu există date.'; return; }
    const win = windowFor(ctx.today, 0, 2);
    const items = upcoming(buildCalendar({ data: ctx.data.doc, rules: ctx.rules, today: ctx.today, from: win.from, to: win.to }), ctx.today, 30);
    const kpi = document.querySelector<HTMLElement>('[data-db="income"]');
    if (!items.length) {
      state.textContent = 'Nicio încasare așteptată în următoarele 30 de zile.';
      if (kpi) kpi.textContent = '0 lei';
      return;
    }
    const conv = converterFor(ctx.fx, 'RON', ctx.today);
    let net = 0, principal = 0, missing = 0;
    list.replaceChildren(...items.map(i => {
      const v = conv(i.kind === 'maturity' ? i.gross : i.net ?? i.gross, i.currency, i.date);
      if (v === null) missing++; else if (i.kind === 'maturity') principal += v; else net += v;
      const li = document.createElement('li');
      const d = document.createElement('span'); d.className = 'cal-next__date'; d.textContent = `${i.date.slice(8, 10)}.${i.date.slice(5, 7)}`;
      const k = document.createElement('span'); k.className = `cal-kind cal-kind--${i.kind}`; k.textContent = KIND[i.kind];
      const n = document.createElement('span'); n.textContent = i.label + (i.reinvest ? ' · de reinvestit' : '');
      const a = document.createElement('span'); a.className = 'cal-next__amt';
      a.textContent = `${NF2.format(i.kind === 'maturity' ? i.gross : i.net ?? i.gross)} ${i.currency}${i.kind === 'maturity' ? '' : i.net === null ? ' brut' : ' net'}`;
      li.append(d, k, n, a);
      return li;
    }));
    if (kpi) {
      kpi.textContent = `${NF0.format(net)} lei`;
      const small = document.createElement('small');
      small.textContent = `${items.length} ${items.length === 1 ? 'încasare' : 'încasări'}, net estimat${principal ? ` · + ${NF0.format(principal)} lei scadențe` : ''}`;
      kpi.append(small);
    }
    state.textContent = `Venit net estimat: ${NF0.format(net)} RON${principal ? ` · scadențe: ${NF0.format(principal)} RON` : ''}${missing ? ` (${missing} fără curs)` : ''}.`;
  } catch (e) {
    state.textContent = (e as Error).message;
  }
}

run();
