// /vault/invest/jurnal/ — decision journal (data.json `journal`). George writes everything; nothing is pre-filled.
import { loadDoc, saveDoc, type Loaded } from './api';
import { toast } from './common';
import { el, byId, fmtDate } from './report-ui';
import { TX_TYPE_LABEL } from '../../lib/invest/labels';
import type { JournalEntry } from '../../lib/invest/types';

let loaded: Loaded<'data'>;
const form = byId<HTMLFormElement>('jrForm')!;
const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(n: string) => form.elements.namedItem(n) as T;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const instName = (id?: string) => {
  const i = id ? loaded.doc.instruments.find(x => x.id === id) : undefined;
  return i ? (i.ticker || i.name) : '';
};

function txLabel(id: string) {
  const t = loaded.doc.transactions.find(x => x.id === id);
  if (!t) return 'tranzacție ștearsă';
  const q = t.quantity !== undefined ? ` ${t.quantity}` : t.amount !== undefined ? ` ${t.amount} ${t.currency}` : '';
  return `${fmtDate(t.date)} · ${TX_TYPE_LABEL[t.type]}${q}${t.instrumentId ? ` ${instName(t.instrumentId)}` : ''}`;
}

function fillSelects() {
  const none = (text: string) => { const o = el('option', text); o.value = ''; return o; };
  const txs = [...loaded.doc.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
  field<HTMLSelectElement>('txId').replaceChildren(none('— niciuna —'), ...txs.map(t => { const o = el('option', txLabel(t.id)); o.value = t.id; return o; }));
  field<HTMLSelectElement>('instrumentId').replaceChildren(none('— niciunul —'), ...loaded.doc.instruments.map(i => {
    const o = el('option', i.ticker ? `${i.ticker} · ${i.name}` : i.name); o.value = i.id; return o;
  }));
}

function resetForm() {
  form.reset();
  field('id').value = '';
  field('date').value = today();
  byId('jrSave')!.textContent = 'Adaugă nota';
  byId('jrCancel')!.hidden = true;
  byId('jrFormTitle')!.textContent = 'Notă nouă';
}

function edit(j: JournalEntry) {
  field('id').value = j.id;
  field('date').value = j.date;
  field('title').value = j.title;
  field('text').value = j.text;
  field('txId').value = j.txIds?.[0] ?? '';
  field('instrumentId').value = j.instrumentId ?? '';
  field('review').value = j.review ?? '';
  byId('jrSave')!.textContent = 'Salvează modificarea';
  byId('jrCancel')!.hidden = false;
  byId('jrFormTitle')!.textContent = 'Modifică nota';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function save(next: JournalEntry[], message: string) {
  try {
    loaded = await saveDoc('data', loaded, { ...loaded.doc, journal: next });
    toast(message);
    render();
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

function render() {
  const list = [...(loaded.doc.journal ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  byId('jrState')!.textContent = list.length ? `${list.length} ${list.length === 1 ? 'notă' : 'note'}.` : 'Încă nicio notă.';
  const out: HTMLElement[] = [];
  let year = '';
  for (const j of list) {
    if (j.date.slice(0, 4) !== year) { year = j.date.slice(0, 4); out.push(el('p', year, 'jr-year')); }
    const box = el('article', null, 'jr-entry');
    const meta = [fmtDate(j.date), j.instrumentId ? instName(j.instrumentId) : '', ...(j.txIds ?? []).map(txLabel)].filter(Boolean).join(' · ');
    box.append(el('p', meta, 'jr-meta'), el('h3', j.title), el('p', j.text));
    if (j.review) box.append(el('p', `Cum a ieșit${j.reviewedOn ? ` (${fmtDate(j.reviewedOn)})` : ''}: ${j.review}`, 'jr-review'));
    const actions = el('div', null, 'jr-actions');
    const eBtn = el('button', 'Modifică', 'inv-btn'); eBtn.type = 'button';
    eBtn.addEventListener('click', () => edit(j));
    const dBtn = el('button', 'Șterge', 'inv-btn'); dBtn.type = 'button';
    dBtn.addEventListener('click', () => {
      if (!confirm(`Ștergi nota „${j.title}”?`)) return;
      void save((loaded.doc.journal ?? []).filter(x => x.id !== j.id), 'Nota a fost ștearsă.');
    });
    actions.append(eBtn, dBtn);
    box.append(actions);
    out.push(box);
  }
  byId('jrList')!.replaceChildren(...out);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const id = field('id').value || `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const prev = (loaded.doc.journal ?? []).find(x => x.id === id);
  const review = field('review').value.trim();
  const entry: JournalEntry = {
    id, date: field('date').value, title: field('title').value.trim(), text: field('text').value.trim(),
  };
  if (field('txId').value) entry.txIds = [field('txId').value];
  if (field('instrumentId').value) entry.instrumentId = field('instrumentId').value;
  if (review) { entry.review = review; entry.reviewedOn = prev?.review === review && prev.reviewedOn ? prev.reviewedOn : today(); }
  if (!entry.title || !entry.text || !entry.date) { toast('Completează data, titlul și textul.', 'err'); return; }
  const next = prev ? (loaded.doc.journal ?? []).map(x => (x.id === id ? entry : x)) : [...(loaded.doc.journal ?? []), entry];
  if (await save(next, prev ? 'Nota a fost modificată.' : 'Nota a fost adăugată.')) resetForm();
});
byId('jrCancel')!.addEventListener('click', resetForm);

(async () => {
  try {
    loaded = await loadDoc('data');
    if (!loaded.exists) { byId('jrState')!.textContent = 'Creează întâi fișierul de date din Panou.'; form.hidden = true; return; }
    fillSelects();
    resetForm();
    render();
  } catch (e) {
    byId('jrState')!.textContent = (e as Error).message;
  }
})();
