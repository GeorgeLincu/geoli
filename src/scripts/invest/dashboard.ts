// /vault/invest/ — dashboard (Phase 0: data status + example chart).
import { loadDoc, saveDoc, type Loaded } from './api';
import { mountChart, axisStyle } from './charts';
import { toast, fmtEur, fmtDateTime } from './common';
import { emptyData } from '../../lib/invest/types';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function showStats(loaded: Loaded<'data'>) {
  const set = (k: string, v: string) => { $(`[data-stat="${k}"]`).textContent = v; };
  set('accounts', String(loaded.doc.accounts.length));
  set('instruments', String(loaded.doc.instruments.length));
  set('transactions', String(loaded.doc.transactions.length));
  set('saved', loaded.saved ? fmtDateTime(loaded.saved) : '—');
  $('#storeState').textContent = loaded.exists
    ? 'Fișierul de date există și se încarcă corect.'
    : 'Încă nu există date salvate.';
  $('#initBtn').hidden = loaded.exists;
}

async function initStore() {
  try {
    let loaded = await loadDoc('data');
    showStats(loaded);
    $('#initBtn').addEventListener('click', async () => {
      try {
        loaded = await saveDoc('data', loaded, emptyData());
        showStats(loaded);
        toast('Fișierul de date a fost creat.');
      } catch (e) {
        toast((e as Error).message, 'err');
      }
    });
  } catch (e) {
    $('#storeState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
  }
}

function initDemoChart() {
  const el = document.getElementById('demoChart');
  if (!el) return;
  const years = Array.from({ length: 31 }, (_, i) => i);
  const paid = years.map(y => y * 1200);
  const value = years.map(y => {
    let v = 0;
    for (let i = 0; i < y; i++) v = v * 1.05 + 1200;
    return Math.round(v);
  });
  mountChart(el, t => ({
    tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => fmtEur(Number(v)) },
    xAxis: {
      type: 'category', data: years.map(y => `${y} ani`),
      ...axisStyle(t), splitLine: { show: false },
    },
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => `${Math.round(v / 1000)}k €` } },
    series: [
      { name: 'Valoare (exemplu)', type: 'line', data: value, smooth: true, showSymbol: false, areaStyle: { opacity: 0.15 }, lineStyle: { width: 2.5 } },
      { name: 'Bani depuși', type: 'line', data: paid, showSymbol: false, lineStyle: { width: 1.5, type: 'dashed' } },
    ],
  }));
}

initStore();
initDemoChart();
