// /vault/invest/import/ — CSV → transactions. The file is read with FileReader and parsed here; only the
// resulting data.json (new transactions + confirmed new instruments) is sent, in one ETag-checked save.
// All parsing/matching logic lives in src/lib/invest/import.ts. DOM is built with textContent, never innerHTML.
import { loadDoc, saveDoc, type Loaded } from './api';
import { toast } from './common';
import { validateDoc } from '../../lib/invest/validate';
import {
  CURRENCIES, IMPORT_FIELDS, TX_TYPES, emptyData,
  type Currency, type ImportField, type ImportPreset, type Instrument, type InvestData, type TxType,
} from '../../lib/invest/types';
import {
  BUILTIN_PRESETS, DEFAULT_TYPE_MAP, FIELD_LABEL, applyImport, blankPreset, buildPreview, distinctValues,
  findNewInstruments, missingColumns, readTable, type InstrumentProposal, type Preview, type RowStatus, type Table,
} from '../../lib/invest/import';
import { ASSET_CLASS_LABEL, REGION_LABEL, TX_TYPE_LABEL } from '../../lib/invest/labels';

// ─── Helpers ───

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
type Child = Node | string | number | null | undefined | false;
function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
function select(options: [string, string][], value: string | undefined, attrs: Record<string, string> = {}) {
  const s = h('select', { class: 'pf-input', ...attrs }) as HTMLSelectElement;
  for (const [v, l] of options) s.append(new Option(l, v, false, v === (value ?? '')));
  return s;
}
function table(el: HTMLElement, head: (string | [string, 'num'])[], rows: HTMLElement[], empty: string) {
  el.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map(c => (Array.isArray(c) ? h('th', { class: 'num', scope: 'col' }, c[0]) : h('th', { scope: 'col' }, c))))),
    h('tbody', {}, ...(rows.length ? rows : [h('tr', { class: 'pf-empty' }, h('td', { colspan: String(head.length) }, empty))])),
  );
}
const NFQ = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 6 });
const NF2 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const fmtQ = (n?: number) => (n === undefined ? '' : NFQ.format(n));
const fmtM = (n?: number) => (n === undefined ? '' : NF2.format(n));
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const newId = () => crypto.randomUUID();
/** Drops undefined/empty keys so the strict validator doesn't see them. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

// ─── State ───

let loaded: Loaded<'data'> | null = null;
let data: InvestData = emptyData();
let text = '';
let fileName = '';
/** Working copy of the mapping (a saved preset, a built-in one or a new one) */
let preset: ImportPreset = blankPreset();
/** id of the preset selected in the list ('' = new) */
let presetId = '';
let tableData: Table | null = null;
/** New-instrument proposals by key; George's edits survive re-parsing. */
const proposals = new Map<string, { create: boolean; inst: Instrument; lines: number[] }>();
let preview: Preview | null = null;
/** Rows whose checkbox George changed (line → include) */
const overrides = new Map<number, boolean>();

const savedPresets = () => data.importPresets ?? [];
const allPresets = (): (ImportPreset & { builtin?: boolean; verified?: boolean; doc?: string })[] => [...savedPresets(), ...BUILTIN_PRESETS];

// ─── Step 1: file + preset ───

function renderPresetList() {
  const sel = $<HTMLSelectElement>('#presetSel');
  const opts: [string, string][] = [['', 'Nou (potrivesc eu coloanele)']];
  for (const p of savedPresets()) opts.push([p.id, p.name]);
  for (const p of BUILTIN_PRESETS) opts.push([p.id, `${p.name}${p.verified ? '' : ' — neverificat pe un fișier real'}`]);
  sel.replaceChildren(...opts.map(([v, l]) => new Option(l, v, false, v === presetId)));
}

function choosePreset(id: string) {
  presetId = id;
  const p = allPresets().find(x => x.id === id);
  if (p) {
    const { builtin: _b, verified: _v, doc: _d, ...rest } = p as ImportPreset & { builtin?: boolean; verified?: boolean; doc?: string };
    preset = structuredClone(rest);
    // a saved preset may have a type map from an older version; default words still help
    preset.typeMap = { ...DEFAULT_TYPE_MAP, ...preset.typeMap };
  } else {
    preset = blankPreset(tableData?.headers ?? []);
  }
  overrides.clear();
  const doc = $('#presetDoc');
  const builtin = BUILTIN_PRESETS.find(b => b.id === id);
  doc.replaceChildren();
  if (builtin) {
    if (!builtin.verified) doc.append(h('span', { class: 'pf-tag pf-tag--warn' }, 'neverificat pe un fișier real'), ' ');
    doc.append(builtin.doc);
  }
  doc.hidden = !builtin;
  $('#deletePreset').hidden = !savedPresets().some(x => x.id === id);
  (($('#presetForm') as HTMLFormElement).elements.namedItem('name') as HTMLInputElement).value = savedPresets().find(x => x.id === id)?.name ?? '';
  fillFormatForm();
  reparse(true);
}

function fillFormatForm() {
  const f = $<HTMLFormElement>('#fileForm');
  (f.elements.namedItem('delimiter') as HTMLSelectElement).value = preset.delimiter === '\t' ? 'tab' : preset.delimiter;
  (f.elements.namedItem('decimal') as HTMLSelectElement).value = preset.decimal;
  (f.elements.namedItem('dateOrder') as HTMLSelectElement).value = preset.dateOrder;
  (f.elements.namedItem('headerRow') as HTMLInputElement).value = preset.headerRow ? String(preset.headerRow) : '';
}

function readFormatForm() {
  const f = $<HTMLFormElement>('#fileForm');
  const d = (f.elements.namedItem('delimiter') as HTMLSelectElement).value;
  preset.delimiter = d === 'tab' ? '\t' : (d as ImportPreset['delimiter']);
  preset.decimal = (f.elements.namedItem('decimal') as HTMLSelectElement).value as ImportPreset['decimal'];
  preset.dateOrder = (f.elements.namedItem('dateOrder') as HTMLSelectElement).value as ImportPreset['dateOrder'];
  const hr = parseInt((f.elements.namedItem('headerRow') as HTMLInputElement).value, 10);
  if (hr > 0) preset.headerRow = hr; else delete preset.headerRow;
}

async function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Fișierul e prea mare (maxim 10 MB).', 'err'); return; }
  const buf = await file.arrayBuffer();
  // UTF-8 first; if that produces replacement characters, try Windows-1250 (older Romanian Excel exports).
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('�')) t = new TextDecoder('windows-1250').decode(buf);
  text = t;
  fileName = file.name;
  proposals.clear();
  overrides.clear();
  // A fresh "new" mapping guesses columns from this file's header.
  if (!presetId) preset = blankPreset();
  reparse(!presetId);
}

/** Splits the file again (format changed or new file). `guess` = re-guess columns from the headers. */
function reparse(guess = false) {
  if (!text) { renderAll(); return; }
  tableData = readTable(text, preset);
  if (guess && !presetId) {
    const fresh = blankPreset(tableData.headers);
    preset.columns = fresh.columns;
  }
  $('#fileInfo').textContent = tableData.headers.length
    ? `${fileName}: ${tableData.rows.length} rânduri, ${tableData.headers.length} coloane, antetul pe rândul ${tableData.headerLine}.`
    : `${fileName}: nu am găsit niciun rând.`;
  renderAll();
}

// ─── Step 2: mapping ───

function renderMapping() {
  const card = $('#mapCard');
  card.hidden = !tableData;
  if (!tableData) return;
  const t = tableData;
  const form = $<HTMLFormElement>('#mapForm');
  const colOpts: [string, string][] = [['', '—'], ...t.headers.map((x, i) => [x, x || `(coloana ${i + 1})`] as [string, string])];
  for (const f of IMPORT_FIELDS) {
    const sel = form.elements.namedItem(f) as HTMLSelectElement;
    const cur = preset.columns[f] ?? '';
    const opts = [...colOpts];
    if (cur && !t.headers.some(x => x.trim().toLowerCase() === cur.trim().toLowerCase())) opts.push([cur, `${cur} (lipsește din fișier)`]);
    sel.replaceChildren(...opts.map(([v, l]) => new Option(l, v, false, v.trim().toLowerCase() === cur.trim().toLowerCase())));
  }
  const acc = form.elements.namedItem('defaultAccountId') as HTMLSelectElement;
  acc.replaceChildren(...[['', '—'], ...data.accounts.filter(a => !a.closed || a.id === preset.defaultAccountId).map(a => [a.id, a.name])]
    .map(([v, l]) => new Option(l, v, false, v === (preset.defaultAccountId ?? ''))));
  (form.elements.namedItem('defaultCurrency') as HTMLSelectElement).value = preset.defaultCurrency ?? '';
  (form.elements.namedItem('typeFromSign') as HTMLInputElement).checked = !!preset.typeFromSign;

  // warnings
  const warn: string[] = [];
  if (!data.accounts.length) warn.push('Nu ai niciun cont în registru. Adaugă întâi un cont în Portofoliu → „Conturi & instrumente”.');
  for (const f of missingColumns(t, preset)) warn.push(`Coloana „${preset.columns[f]}” (${FIELD_LABEL[f]}) nu există în fișier.`);
  if (!preset.columns.date) warn.push('Alege coloana cu data.');
  if (!preset.columns.type && !preset.typeFromSign) warn.push('Alege coloana cu tipul tranzacției (sau bifează „cantitate pozitivă = cumpărare”).');
  const wl = $('#mapWarnings');
  wl.replaceChildren(...warn.map(w => h('li', {}, w)));
  wl.hidden = !warn.length;

  // sample
  const sample = t.rows.slice(0, 5);
  table($('#sampleTable'), ['Rând', ...t.headers], sample.map(r => h('tr', {}, h('td', {}, r.line), ...t.headers.map((_, i) => h('td', {}, r.cells[i] ?? '')))), 'Niciun rând de date.');

  // type values
  const typeOpts: [string, string][] = [['', '— nealocat —'], ...TX_TYPES.map(x => [x, TX_TYPE_LABEL[x]] as [string, string]), ['skip', 'Ignoră rândul']];
  const typeVals = distinctValues(t, preset.columns.type);
  table($('#typeMapTable'), ['Valoare', 'Înseamnă'], typeVals.map(v => {
    const s = select(typeOpts, preset.typeMap[v.toLowerCase()] ?? '', { 'aria-label': `Tipul pentru „${v}”` });
    s.addEventListener('change', () => {
      if (s.value) preset.typeMap[v.toLowerCase()] = s.value as TxType | 'skip';
      else delete preset.typeMap[v.toLowerCase()];
      renderAll();
    });
    return h('tr', {}, h('td', {}, v), h('td', {}, s));
  }), preset.columns.type ? 'Coloana e goală.' : 'Nu ai ales coloana cu tipul.');

  // account values
  const accOpts: [string, string][] = [['', '— potrivire după nume —'], ...data.accounts.map(a => [a.id, a.name] as [string, string])];
  const accVals = distinctValues(t, preset.columns.account);
  table($('#accMapTable'), ['Valoare', 'Contul din aplicație'], accVals.map(v => {
    const s = select(accOpts, preset.accountMap?.[v] ?? '', { 'aria-label': `Contul pentru „${v}”` });
    s.addEventListener('change', () => {
      preset.accountMap = { ...(preset.accountMap ?? {}) };
      if (s.value) preset.accountMap[v] = s.value; else delete preset.accountMap[v];
      renderAll();
    });
    const auto = data.accounts.find(a => a.name.trim().toLowerCase() === v.trim().toLowerCase());
    return h('tr', {}, h('td', {}, v, auto && !preset.accountMap?.[v] ? h('span', { class: 'pf-tag pf-tag--ok imp-gap' }, 'potrivit') : null), h('td', {}, s));
  }), preset.columns.account ? 'Coloana e goală.' : 'Fără coloană de cont: se folosește contul implicit.');
}

function onMapChange(ev: Event) {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  if (!el.name) return;
  if ((IMPORT_FIELDS as readonly string[]).includes(el.name)) {
    if (el.value) preset.columns[el.name as ImportField] = el.value; else delete preset.columns[el.name as ImportField];
  } else if (el.name === 'defaultAccountId') {
    if (el.value) preset.defaultAccountId = el.value; else delete preset.defaultAccountId;
  } else if (el.name === 'defaultCurrency') {
    if (el.value) preset.defaultCurrency = el.value as Currency; else delete preset.defaultCurrency;
  } else if (el.name === 'typeFromSign') {
    if ((el as HTMLInputElement).checked) preset.typeFromSign = true; else delete preset.typeFromSign;
  }
  renderAll();
}

// ─── Step 3: new instruments ───

function syncProposals(found: InstrumentProposal[]) {
  const keys = new Set(found.map(p => p.key));
  for (const k of [...proposals.keys()]) if (!keys.has(k)) proposals.delete(k);
  for (const p of found) {
    const cur = proposals.get(p.key);
    if (cur) cur.lines = p.lines;
    else proposals.set(p.key, { create: true, inst: { id: newId(), ...p.draft }, lines: p.lines });
  }
}

function renderInstruments() {
  const card = $('#instCard');
  card.hidden = !proposals.size;
  if (!proposals.size) return;
  const classOpts = Object.entries(ASSET_CLASS_LABEL) as [string, string][];
  const regionOpts = Object.entries(REGION_LABEL) as [string, string][];
  const curOpts = CURRENCIES.map(c => [c, c] as [string, string]);
  const rows = [...proposals.entries()].map(([key, p]) => {
    const i = p.inst;
    const label = i.ticker || i.isin || i.name;
    const cb = h('input', { type: 'checkbox', 'aria-label': `Creează ${label}` }) as HTMLInputElement;
    cb.checked = p.create;
    cb.addEventListener('change', () => { p.create = cb.checked; renderPreview(); });
    const input = (field: 'name' | 'ticker' | 'isin' | 'priceSource', max: number, placeholder = '') => {
      const e = h('input', { class: 'pf-input', maxlength: String(max), value: i[field] ?? '', placeholder, autocomplete: 'off', 'aria-label': `${field} pentru ${label}` }) as HTMLInputElement;
      e.addEventListener('change', () => {
        const v = e.value.trim();
        if (field === 'name') i.name = v || label || key; else if (v) i[field] = field === 'isin' ? v.toUpperCase() : v; else delete i[field];
      });
      return e;
    };
    const sel = (field: 'assetClass' | 'region' | 'currency', opts: [string, string][]) => {
      const s = select(opts, i[field], { 'aria-label': `${field} pentru ${label}` });
      s.addEventListener('change', () => { (i as unknown as Record<string, string>)[field] = s.value; });
      return s;
    };
    return h('tr', {},
      h('td', {}, cb),
      h('td', {}, input('name', 160)),
      h('td', {}, input('ticker', 32)),
      h('td', {}, input('isin', 12)),
      h('td', {}, sel('assetClass', classOpts)),
      h('td', {}, sel('region', regionOpts)),
      h('td', {}, sel('currency', curOpts)),
      h('td', {}, input('priceSource', 80, 'ex. xetra:TICKER')),
      h('td', { class: 'num' }, p.lines.length),
    );
  });
  table($('#instTable'), ['Creează', 'Nume', 'Ticker', 'ISIN', 'Clasă', 'Regiune', 'Moneda', 'Sursă preț (opțional)', ['Rânduri', 'num']], rows, '');
}

const acceptedInstruments = () =>
  [...proposals.entries()].filter(([, p]) => p.create).map(([key, p]) => ({ ...p.inst, key }));

// ─── Step 4: preview ───

const STATUS_LABEL: Record<RowStatus, [string, string]> = {
  new: ['nou', 'pf-tag--ok'], duplicate: ['duplicat', 'pf-tag--warn'], error: ['eroare', 'pf-tag--err'], skipped: ['ignorat', ''],
};
const included = (line: number, status: RowStatus) =>
  status === 'error' || status === 'skipped' ? false : overrides.get(line) ?? status === 'new';

function renderPreview() {
  const card = $('#previewCard');
  card.hidden = !tableData;
  if (!tableData) return;
  preview = buildPreview(tableData, preset, data, acceptedInstruments());
  const c = preview.counts;
  const stat = (k: string, v: number) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
  $('#counts').replaceChildren(stat('Noi', c.new), stat('Duplicate (sărite)', c.duplicate), stat('Cu erori', c.error), stat('Ignorate', c.skipped));

  const accName = (id?: string) => data.accounts.find(a => a.id === id)?.name ?? '';
  const instName = (id?: string) => {
    const i = data.instruments.find(x => x.id === id) ?? acceptedInstruments().find(x => x.id === id);
    return i ? (i.ticker || i.name) : '';
  };
  const filter = $<HTMLSelectElement>('#statusFilter').value;
  const shown = preview.rows.filter(r => !filter || r.status === filter);
  const LIMIT = 500;
  const rows = shown.slice(0, LIMIT).map(r => {
    const [label, cls] = STATUS_LABEL[r.status];
    const cb = h('input', { type: 'checkbox', 'aria-label': `Importă rândul ${r.line}` }) as HTMLInputElement;
    cb.checked = included(r.line, r.status);
    cb.disabled = r.status === 'error' || r.status === 'skipped';
    cb.addEventListener('change', () => { overrides.set(r.line, cb.checked); updateImportButton(); });
    const t = r.tx;
    const isNew = !!r.newInstrumentKey;
    const lead = [
      h('td', {}, cb),
      h('td', { class: 'num' }, r.line),
      h('td', {}, h('span', { class: `pf-tag ${cls}` }, label)),
    ];
    if (!t) {
      // No transaction: the reason (and the raw row) spans the data columns.
      return h('tr', { class: `imp-row imp-row--${r.status}` }, ...lead,
        h('td', { colspan: '11', class: 'pf-note imp-reason' },
          h('span', {}, r.reasons.join('; ')), h('br', {}), h('small', {}, r.cells.map(c => c.trim()).filter(Boolean).join(' · '))));
    }
    return h('tr', { class: `imp-row imp-row--${r.status}` },
      ...lead,
      h('td', {}, t ? fmtDate(t.date) : ''),
      h('td', {}, t ? TX_TYPE_LABEL[t.type] : ''),
      h('td', {}, t ? accName(t.accountId) : ''),
      h('td', {}, t ? instName(t.instrumentId) : '', isNew ? h('span', { class: 'pf-tag imp-gap' }, 'nou') : null),
      h('td', { class: 'num' }, fmtQ(t?.quantity)),
      h('td', { class: 'num' }, fmtM(t?.price)),
      h('td', { class: 'num' }, fmtM(t?.amount)),
      h('td', {}, t?.currency ?? ''),
      h('td', { class: 'num' }, fmtM(t?.fees)),
      h('td', { class: 'num' }, fmtM(t?.withheldTax)),
      h('td', { class: 'pf-note' }, r.status === 'new' ? '' : r.reasons.join('; ')),
    );
  });
  table($('#previewTable'),
    ['', ['Rând', 'num'], 'Stare', 'Data', 'Tip', 'Cont', 'Instrument', ['Cant.', 'num'], ['Preț', 'num'], ['Sumă', 'num'], 'Moneda', ['Comision', 'num'], ['Impozit', 'num'], 'Motiv'],
    rows, 'Niciun rând.');
  $('#previewMore').textContent = shown.length > LIMIT ? `Se arată primele ${LIMIT} din ${shown.length} rânduri (toate se importă după bifă).` : '';
  updateImportButton();
}

function updateImportButton() {
  const btn = $<HTMLButtonElement>('#importBtn');
  const n = preview ? preview.rows.filter(r => included(r.line, r.status)).length : 0;
  btn.textContent = n === 1 ? 'Importă 1 tranzacție' : `Importă ${n} tranzacții`;
  btn.disabled = !n || !loaded;
}

function renderAll() {
  if (tableData) syncProposals(findNewInstruments(tableData, preset, data));
  renderMapping();
  renderInstruments();
  renderPreview();
}

// ─── Saving ───

async function save(next: InvestData, ok: string): Promise<boolean> {
  if (!loaded) { toast('Registrul nu s-a încărcat încă.', 'err'); return false; }
  const problems = validateDoc('data', next);
  if (problems.length) { toast(`Date invalide: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    loaded = await saveDoc('data', loaded, next);
    data = next;
    toast(ok);
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

async function doImport() {
  if (!preview) return;
  const include = new Set(preview.rows.filter(r => included(r.line, r.status)).map(r => r.line));
  const accepted = acceptedInstruments();
  const res = applyImport(data, preview, include, accepted, newId);
  const msg = `Adaugi ${res.added} tranzacții${res.instrumentsAdded ? ` și ${res.instrumentsAdded} instrumente noi` : ''} în registru?`;
  if (!confirm(msg)) return;
  const btn = $<HTMLButtonElement>('#importBtn');
  btn.disabled = true;
  if (await save(res.data, `Am importat ${res.added} tranzacții${res.instrumentsAdded ? ` și ${res.instrumentsAdded} instrumente` : ''}.`)) {
    // Imported instruments now exist; the same file would show as duplicates from here on.
    for (const [k, p] of proposals) if (res.data.instruments.some(i => i.id === p.inst.id)) proposals.delete(k);
    overrides.clear();
    renderAll();
    const done = $('#previewMore');
    done.replaceChildren('Importul s-a salvat. ', h('a', { href: '/vault/invest/portofoliu/' }, 'Vezi portofoliul'), '.');
  } else updateImportButton();
}

async function savePreset(ev: SubmitEvent) {
  ev.preventDefault();
  const input = (ev.target as HTMLFormElement).elements.namedItem('name') as HTMLInputElement;
  const name = input.value.trim();
  if (!name) { input.setAttribute('aria-invalid', 'true'); toast('Dă un nume presetului.', 'err'); return; }
  input.setAttribute('aria-invalid', 'false');
  const existing = savedPresets().find(p => p.id === presetId) ?? savedPresets().find(p => p.name.toLowerCase() === name.toLowerCase());
  const id = existing?.id ?? newId();
  // Store only the words that differ from the defaults, plus whatever George mapped himself.
  const typeMap = Object.fromEntries(Object.entries(preset.typeMap).filter(([k, v]) => DEFAULT_TYPE_MAP[k] !== v));
  const p: ImportPreset = clean({ ...structuredClone(preset), id, name, typeMap });
  if (p.accountMap && !Object.keys(p.accountMap).length) delete p.accountMap;
  for (const k of Object.keys(p.columns) as ImportField[]) if (!p.columns[k]) delete p.columns[k];
  const next = structuredClone(data);
  next.importPresets = [...(next.importPresets ?? []).filter(x => x.id !== id), p];
  if (await save(next, `Presetul „${name}” e salvat.`)) {
    presetId = id;
    renderPresetList();
    $('#deletePreset').hidden = false;
  }
}

async function deletePreset() {
  const p = savedPresets().find(x => x.id === presetId);
  if (!p || !confirm(`Ștergi presetul „${p.name}”?`)) return;
  const next = structuredClone(data);
  next.importPresets = (next.importPresets ?? []).filter(x => x.id !== p.id);
  if (!next.importPresets.length) delete next.importPresets;
  if (await save(next, 'Presetul a fost șters.')) {
    presetId = '';
    renderPresetList();
    $('#deletePreset').hidden = true;
  }
}

// ─── Start ───

async function init() {
  const state = $('#loadState');
  try {
    loaded = await loadDoc('data');
    data = loaded.doc;
    state.textContent = `Registru: ${data.accounts.length} conturi, ${data.instruments.length} instrumente, ${data.transactions.length} tranzacții.`;
  } catch (e) {
    state.textContent = (e as Error).message;
    toast((e as Error).message, 'err');
  }
  renderPresetList();
  choosePreset('');
  $('#file').addEventListener('change', onFile);
  $('#presetSel').addEventListener('change', e => choosePreset((e.target as HTMLSelectElement).value));
  $('#fileForm').addEventListener('change', e => { if ((e.target as HTMLElement).id === 'file' || (e.target as HTMLElement).id === 'presetSel') return; readFormatForm(); reparse(); });
  $('#fileForm').addEventListener('submit', e => e.preventDefault());
  $('#mapForm').addEventListener('change', onMapChange);
  $('#mapForm').addEventListener('submit', e => e.preventDefault());
  $('#presetForm').addEventListener('submit', savePreset);
  $('#deletePreset').addEventListener('click', deletePreset);
  $('#statusFilter').addEventListener('change', renderPreview);
  $('#importBtn').addEventListener('click', doImport);
}

void init();
