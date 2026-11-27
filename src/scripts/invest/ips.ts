// /vault/invest/ips/ — Phase 6: IPS editor (draft + immutable versions), diff between versions, print view.
// The text is George's; this script only renders headings, guiding questions and his own content.
import { loadDoc, saveDoc, type Loaded } from './api';
import { toast } from './common';
import { validateDoc } from '../../lib/invest/validate';
import { emptyIps, type IpsDoc, type IpsRules, type IpsVersion, type IpsCrashRule, type InvestData } from '../../lib/invest/types';
import { IPS_SECTIONS, IPS_SECTION_KEYS, ipsSectionTitle } from '../../lib/invest/ips-sections';
import { diffVersions, rulesToLines, monthName, type DiffOp } from '../../lib/invest/ips-diff';
import { latestIpsVersion } from '../../lib/invest/ips-checks';
import { ASSET_CLASS_LABEL } from '../../lib/invest/labels';

// ─── Helpers ───

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

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

const NF1 = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const fmtDateTime = (iso: string) => new Intl.DateTimeFormat('ro-RO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** "1.234,5", "1234.5", "1 234,5" → number. Empty → undefined. Invalid → NaN. */
function parseNum(s: string): number | undefined {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return undefined;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : NaN;
}
const numStr = (n: number | undefined) => (n === undefined ? '' : String(+n.toFixed(6)).replace('.', ','));

// ─── State ───

let loaded: Loaded<'ips'> | null = null;
let data: InvestData | null = null;
let dirty = false;

const accName = (id: string) => data?.accounts.find(a => a.id === id)?.name ?? `(cont șters ${id.slice(0, 6)})`;
const instName = (id: string) => {
  const i = data?.instruments.find(x => x.id === id);
  return i ? (i.ticker ? `${i.ticker} · ${i.name}` : i.name) : `(instrument șters ${id.slice(0, 6)})`;
};
const names = { account: accName, instrument: instName };

const sortedVersions = (doc: IpsDoc) => doc.versions.map((v, i) => ({ v, i })).sort((a, b) => (a.v.date === b.v.date ? a.i - b.i : a.v.date < b.v.date ? -1 : 1)).map(x => x.v);

// ─── Editor ───

function input(name: string, attrs: Record<string, string> = {}) {
  return h('input', { type: 'text', inputmode: 'decimal', name, autocomplete: 'off', ...attrs }) as HTMLInputElement;
}
function field(label: string, control: HTMLElement, unit?: string, cls = '') {
  return h('label', { class: `ips-field ${cls}` }, h('span', {}, label, unit ? h('span', { class: 'plan-unit' }, ` (${unit})`) : null), control);
}
function monthSelect(name: string) {
  return h('select', { name }, h('option', { value: '' }, '—'),
    ...Array.from({ length: 12 }, (_, i) => h('option', { value: String(i + 1) }, monthName(i + 1)))) as HTMLSelectElement;
}

function targetsBlock() {
  const t = data?.targets ?? [];
  const body = t.length
    ? h('ul', { class: 'ips-linked' }, ...t.map(x => h('li', {}, `${x.label} (${ASSET_CLASS_LABEL[x.assetClass]}): ${NF1.format(x.weight * 100)}%`,
        x.band !== undefined ? ` ± ${NF1.format(x.band * 100)} pp` : ' · bandă implicită')))
    : h('p', { class: 'inv-muted' }, 'Nu ai încă o țintă de alocare.');
  return h('div', { class: 'ips-rules' },
    h('p', { class: 'ips-rules__title' }, 'Ținta actuală (doar citire, se modifică pe pagina Portofoliu)'),
    body,
    h('label', { class: 'ips-check' }, h('input', { type: 'checkbox', name: 'driftAlerts' }), ' Arată pe Panou o alertă când un rând iese din bandă'));
}

function contributionBlock() {
  return h('div', { class: 'ips-rules' },
    h('p', { class: 'ips-rules__title' }, 'Regulă verificabilă (opțional)'),
    h('div', { class: 'ips-row' },
      field('Suma lunară', input('contribAmount'), '€'),
      field('Până în ziua', input('contribDay', { inputmode: 'numeric' }), '1–31'),
      field('Zile de păsuire', input('contribGrace', { inputmode: 'numeric' }))),
    h('p', { class: 'plan-hint' }, 'Panoul te anunță dacă după ziua respectivă (plus păsuirea) nu apare luna asta o depunere sau o cumpărare de cel puțin suma de mai sus.'));
}

function crashRow(r?: IpsCrashRule) {
  const row = h('div', { class: 'ips-crash-row' },
    h('input', { type: 'hidden', name: 'crashId', value: r?.id ?? crypto.randomUUID() }),
    field('Scădere sub maxim', input('crashDrop', { value: r ? numStr(r.dropPct * 100) : '' }), '%'),
    field('Ce faci', h('input', { type: 'text', name: 'crashAction', maxlength: '1000', value: r?.action ?? '' }), undefined, 'ips-field--grow'),
    field('Sumă în plus', input('crashExtra', { value: numStr(r?.extraAmount) }), '€'),
  );
  const del = h('button', { type: 'button', class: 'inv-btn inv-btn--ghost', 'aria-label': 'Șterge regula' }, 'Șterge');
  del.addEventListener('click', () => { row.remove(); markDirty(); });
  row.append(del);
  return row;
}

function crashBlock() {
  const sel = h('select', { name: 'crashRef' }, h('option', { value: '' }, '—'),
    ...(data?.instruments ?? []).map(i => h('option', { value: i.id }, instName(i.id))));
  const rows = h('div', { class: 'ips-crash-rows', id: 'crashRows' });
  const add = h('button', { type: 'button', class: 'inv-btn' }, 'Adaugă un prag');
  add.addEventListener('click', () => { rows.append(crashRow()); markDirty(); });
  return h('div', { class: 'ips-rules' },
    h('p', { class: 'ips-rules__title' }, 'Praguri verificabile (opțional)'),
    field('Instrumentul după care măsori căderea', sel),
    rows, add,
    h('p', { class: 'plan-hint' }, 'Panoul compară ultimul preț salvat al instrumentului cu maximul din prețurile salvate și îți arată regula ta pentru pragul atins.'));
}

function emergencyBlock() {
  const accs = (data?.accounts ?? []).filter(a => !a.closed);
  return h('div', { class: 'ips-rules' },
    h('p', { class: 'ips-rules__title' }, 'Regulă verificabilă (opțional)'),
    h('div', { class: 'ips-row' },
      field('Luni de cheltuieli', input('efMonths')),
      field('Cheltuieli lunare', input('efExpenses'), '€')),
    h('fieldset', { class: 'ips-accounts' }, h('legend', {}, 'Conturile care țin fondul de urgență'),
      ...(accs.length ? accs.map(a => h('label', { class: 'ips-check' }, h('input', { type: 'checkbox', name: 'efAccount', value: a.id }), ` ${a.name}`))
        : [h('p', { class: 'inv-muted' }, 'Nu ai încă niciun cont (pagina Portofoliu).')])),
    h('p', { class: 'plan-hint' }, 'Panoul compară valoarea acestor conturi cu lunile × cheltuielile.'));
}

function reviewBlock() {
  return h('div', { class: 'ips-rules' },
    h('p', { class: 'ips-rules__title' }, 'Reamintiri (opțional)'),
    h('div', { class: 'ips-row' },
      field('Luna revizuirii anuale', monthSelect('reviewMonth'))),
    h('p', { class: 'plan-hint' }, 'Din luna aleasă, Panoul îți amintește până salvezi o versiune nouă.'),
    h('div', { class: 'ips-row' },
      field('Termen Declarația Unică: luna', monthSelect('taxMonth')),
      field('ziua', input('taxDay', { inputmode: 'numeric' })),
      field('Amintește-mi cu', input('taxRemind', { inputmode: 'numeric' }), 'zile înainte')),
    h('p', { class: 'plan-hint' }, 'Termenul îl scrii tu, verificat pe site-ul ANAF; aplicația nu presupune o dată.'));
}

const RULE_BLOCKS: Record<string, () => HTMLElement> = {
  allocation: targetsBlock, contributions: contributionBlock, crash: crashBlock, emergency: emergencyBlock, review: reviewBlock,
};

function buildEditor() {
  const root = $('#ipsEditor');
  root.replaceChildren(...IPS_SECTIONS.map(s => {
    const id = `sec-${s.key}`;
    return h('section', { class: 'inv-card ips-section', 'aria-labelledby': id, 'data-key': s.key },
      h('h2', { class: 'inv-h2', id }, s.title),
      h('ul', { class: 'ips-questions', 'aria-label': 'Întrebări care te ghidează' }, ...s.questions.map(q => h('li', {}, q))),
      s.link ? h('p', {}, h('a', { href: s.link.href, class: 'ips-link' }, `${s.link.label} →`)) : null,
      h('textarea', { name: `s:${s.key}`, rows: '6', 'aria-labelledby': id, placeholder: 'Răspunsul tău…' }),
      RULE_BLOCKS[s.key]?.() ?? null,
    );
  }));
}

function fillEditor(sections: Record<string, string>, rules: IpsRules | undefined) {
  const root = $('#ipsEditor');
  for (const ta of $$<HTMLTextAreaElement>('textarea', root)) ta.value = sections[ta.name.slice(2)] ?? '';
  const set = (name: string, v: string) => { const el = $<HTMLInputElement>(`[name="${name}"]`, root); if (el) el.value = v; };
  const r = rules ?? {};
  $<HTMLInputElement>('[name="driftAlerts"]', root).checked = !!r.driftAlerts;
  set('contribAmount', numStr(r.contribution?.amount)); set('contribDay', numStr(r.contribution?.day)); set('contribGrace', numStr(r.contribution?.graceDays));
  set('efMonths', numStr(r.emergencyFund?.months)); set('efExpenses', numStr(r.emergencyFund?.monthlyExpenses));
  for (const cb of $$<HTMLInputElement>('[name="efAccount"]', root)) cb.checked = !!r.emergencyFund?.accountIds.includes(cb.value);
  set('reviewMonth', r.reviewMonth ? String(r.reviewMonth) : '');
  set('taxMonth', r.taxReturn ? String(r.taxReturn.month) : ''); set('taxDay', numStr(r.taxReturn?.day)); set('taxRemind', numStr(r.taxReturn?.remindDaysBefore));
  const refSel = $<HTMLSelectElement>('[name="crashRef"]', root);
  const ref = r.crash?.referenceInstrumentId ?? '';
  if (ref && ![...refSel.options].some(o => o.value === ref)) refSel.append(h('option', { value: ref }, instName(ref)));
  refSel.value = ref;
  $('#crashRows').replaceChildren(...(r.crash?.rules ?? []).map(crashRow));
}

/** Reads the editor. Returns null (after a toast) when a rule field is invalid. */
function readEditor(): { sections: Record<string, string>; rules?: IpsRules } | null {
  const root = $('#ipsEditor');
  const sections: Record<string, string> = {};
  for (const ta of $$<HTMLTextAreaElement>('textarea', root)) { const v = ta.value.replace(/\s+$/, ''); if (v) sections[ta.name.slice(2)] = v; }
  const val = (name: string) => $<HTMLInputElement>(`[name="${name}"]`, root)?.value ?? '';
  const errors: string[] = [];
  const num = (name: string, label: string, min: number, max: number, int = false) => {
    const n = parseNum(val(name));
    if (n === undefined) return undefined;
    if (Number.isNaN(n) || n < min || n > max || (int && !Number.isInteger(n))) { errors.push(`${label}: ${int ? 'număr întreg' : 'număr'} între ${min} și ${max}`); return undefined; }
    return n;
  };
  const rules: IpsRules = {};
  if ($<HTMLInputElement>('[name="driftAlerts"]', root).checked) rules.driftAlerts = true;

  const amount = num('contribAmount', 'Suma lunară', 0, 1e9), day = num('contribDay', 'Ziua contribuției', 1, 31, true), grace = num('contribGrace', 'Zile de păsuire', 0, 31, true);
  if (amount !== undefined || day !== undefined) {
    if (amount === undefined || day === undefined) errors.push('Contribuția: completează și suma, și ziua (sau niciuna)');
    else rules.contribution = { amount, day, ...(grace !== undefined ? { graceDays: grace } : {}) };
  }

  const months = num('efMonths', 'Luni de cheltuieli', 0, 120), exp = num('efExpenses', 'Cheltuieli lunare', 0, 1e9);
  const accountIds = $$<HTMLInputElement>('[name="efAccount"]', root).filter(c => c.checked).map(c => c.value);
  if (months !== undefined || exp !== undefined) {
    if (months === undefined || exp === undefined) errors.push('Fondul de urgență: completează și lunile, și cheltuielile (sau niciuna)');
    else rules.emergencyFund = { months, monthlyExpenses: exp, accountIds };
  }

  if (val('reviewMonth')) rules.reviewMonth = Number(val('reviewMonth'));
  const taxDay = num('taxDay', 'Ziua termenului', 1, 31, true), remind = num('taxRemind', 'Zile înainte', 0, 366, true);
  if (val('taxMonth') || taxDay !== undefined) {
    if (!val('taxMonth') || taxDay === undefined) errors.push('Declarația Unică: completează și luna, și ziua (sau niciuna)');
    else rules.taxReturn = { month: Number(val('taxMonth')), day: taxDay, ...(remind !== undefined ? { remindDaysBefore: remind } : {}) };
  }

  const crashRules: IpsCrashRule[] = [];
  for (const row of $$('.ips-crash-row', root)) {
    const get = (n: string) => $<HTMLInputElement>(`[name="${n}"]`, row).value;
    const drop = parseNum(get('crashDrop')), extra = parseNum(get('crashExtra')), action = get('crashAction').trim();
    if (drop === undefined && !action && extra === undefined) continue;
    if (drop === undefined || Number.isNaN(drop) || drop <= 0 || drop >= 100) { errors.push('Prag de cădere: procent între 0 și 100'); continue; }
    if (extra !== undefined && (Number.isNaN(extra) || extra < 0)) { errors.push('Suma în plus: număr pozitiv'); continue; }
    crashRules.push({ id: get('crashId'), dropPct: +(drop / 100).toFixed(6), ...(action ? { action } : {}), ...(extra !== undefined ? { extraAmount: extra } : {}) });
  }
  const ref = val('crashRef');
  if (crashRules.length || ref) rules.crash = { ...(ref ? { referenceInstrumentId: ref } : {}), rules: crashRules };

  if (errors.length) { toast(errors.slice(0, 3).join(' · '), 'err'); return null; }
  return { sections, ...(Object.keys(rules).length ? { rules } : {}) };
}

function markDirty() {
  if (!loaded) return;
  dirty = true;
  renderState();
}

// ─── Saving ───

async function commit(next: IpsDoc, ok: string) {
  if (!loaded) return false;
  const problems = validateDoc('ips', next);
  if (problems.length) { toast(`Nu pot salva: ${problems.slice(0, 2).join('; ')}`, 'err'); return false; }
  try {
    loaded = await saveDoc('ips', loaded, next);
    dirty = false;
    renderAll(false);
    toast(ok);
    return true;
  } catch (e) {
    toast((e as Error).message, 'err');
    return false;
  }
}

async function saveDraft() {
  const ed = readEditor();
  if (!ed || !loaded) return;
  await commit({ ...loaded.doc, draft: { savedAt: new Date().toISOString(), ...ed } }, 'Ciorna a fost salvată.');
}

async function saveVersion(ev: SubmitEvent) {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const ed = readEditor();
  if (!ed || !loaded) return;
  const fd = new FormData(form);
  const date = String(fd.get('date') ?? ''), changeNote = String(fd.get('changeNote') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Alege data versiunii.', 'err'); return; }
  if (!changeNote) { toast('Scrie pe scurt ce s-a schimbat.', 'err'); return; }
  const latest = latestIpsVersion(loaded.doc);
  if (latest && date < latest.date && !confirm(`Data aleasă e mai veche decât versiunea din ${fmtDate(latest.date)}. Regulile în vigoare rămân cele din versiunea cu data cea mai nouă. Continui?`)) return;
  const version: IpsVersion = { date, changeNote, ...ed };
  const { draft: _drop, ...rest } = loaded.doc;
  if (await commit({ ...rest, versions: [...loaded.doc.versions, version] }, 'Versiunea a fost salvată.')) form.hidden = true;
}

// ─── Rendering ───

function renderState() {
  if (!loaded) return;
  const doc = loaded.doc;
  const latest = latestIpsVersion(doc);
  const parts: string[] = [];
  parts.push(latest ? `În vigoare: versiunea din ${fmtDate(latest.date)}.` : 'Nu ai salvat încă nicio versiune.');
  if (doc.draft) parts.push(`Ciornă salvată la ${fmtDateTime(doc.draft.savedAt)}.`);
  if (dirty) parts.push('Ai modificări nesalvate.');
  const el = $('#ipsState');
  el.textContent = parts.join(' ');
  el.classList.toggle('ips-dirty', dirty);
  for (const id of ['#saveDraft', '#openVersion', '#openPrint']) $<HTMLButtonElement>(id).disabled = false;
}

function renderVersions() {
  if (!loaded) return;
  const list = sortedVersions(loaded.doc).reverse();
  const latest = latestIpsVersion(loaded.doc);
  const table = $('#versionTable');
  table.replaceChildren(
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Data'), h('th', { scope: 'col' }, 'Ce s-a schimbat'), h('th', { scope: 'col' }, 'Reguli'), h('th', { scope: 'col' }, ''))),
    h('tbody', {}, ...(list.length ? list.map(v => {
      const load = h('button', { type: 'button', class: 'inv-btn inv-btn--ghost' }, 'Încarcă în editor');
      load.addEventListener('click', () => {
        if (dirty && !confirm('Ai modificări nesalvate în editor. Le înlocuiești cu această versiune?')) return;
        fillEditor(v.sections, v.rules); dirty = true; renderState();
        toast(`Versiunea din ${fmtDate(v.date)} e în editor. Salvează ciorna sau o versiune nouă.`);
        $('#ipsEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return h('tr', {},
        h('td', {}, fmtDate(v.date), v === latest ? h('span', { class: 'ips-tag' }, 'în vigoare') : null),
        h('td', {}, v.changeNote ?? '—'),
        h('td', {}, String(rulesToLines(v.rules).length || '—')),
        h('td', {}, load));
    }) : [h('tr', { class: 'pf-empty' }, h('td', { colspan: '4' }, 'Nicio versiune încă. Scrie, salvează ciorna, apoi „Salvează ca versiune nouă”.'))])),
  );

  // Diff selectors: versions plus the current editor content
  const opts = (sel: HTMLSelectElement, withEditor: boolean, pick: string) => {
    sel.replaceChildren(
      ...sortedVersions(loaded!.doc).map((v, i) => h('option', { value: String(i) }, `${fmtDate(v.date)} — ${v.changeNote ?? ''}`.slice(0, 80))),
      ...(withEditor ? [h('option', { value: 'editor' }, 'Editorul (nesalvat / ciornă)')] : []));
    sel.value = pick;
  };
  const n = loaded.doc.versions.length;
  opts($<HTMLSelectElement>('#diffFrom'), false, String(Math.max(0, n - 2)));
  opts($<HTMLSelectElement>('#diffTo'), true, n >= 2 ? String(n - 1) : 'editor');
  opts($<HTMLSelectElement>('#printPick'), true, n ? String(n - 1) : 'editor');
  renderDiff();
}

function pickVersion(value: string): Pick<IpsVersion, 'sections' | 'rules'> & { date?: string; changeNote?: string } | null {
  if (!loaded) return null;
  if (value === 'editor') { const ed = readEditor(); return ed ? { ...ed } : null; }
  return sortedVersions(loaded.doc)[Number(value)] ?? null;
}

function diffBlock(title: string, ops: DiffOp[]) {
  return h('div', { class: 'ips-diff__block' }, h('h4', {}, title),
    h('pre', { class: 'ips-diff__lines' }, ...ops.map(o => h('span', { class: `ips-diff__${o.type}` }, `${o.type === 'add' ? '+ ' : o.type === 'del' ? '− ' : '  '}${o.text}`))));
}

function renderDiff() {
  const out = $('#diffOut');
  if (!loaded || !loaded.doc.versions.length) { out.replaceChildren(h('p', { class: 'inv-muted' }, 'Comparația apare după prima versiune salvată.')); return; }
  const a = pickVersion($<HTMLSelectElement>('#diffFrom').value), b = pickVersion($<HTMLSelectElement>('#diffTo').value);
  if (!a || !b) { out.replaceChildren(); return; }
  const d = diffVersions(a, b, IPS_SECTION_KEYS, names);
  const blocks = [...d.sections.map(s => diffBlock(ipsSectionTitle(s.key), s.ops)), ...(d.rules.length ? [diffBlock('Reguli verificabile', d.rules)] : [])];
  out.replaceChildren(...(blocks.length ? blocks : [h('p', { class: 'inv-muted' }, 'Nicio diferență.')]));
}

function renderPrint() {
  const v = pickVersion($<HTMLSelectElement>('#printPick').value);
  const doc = $('#printDoc');
  if (!v) { doc.replaceChildren(); return; }
  const rules = rulesToLines(v.rules, names);
  const targets = data?.targets ?? [];
  doc.replaceChildren(
    h('h1', { id: 'printTitle' }, 'Politica de investiții (IPS)'),
    h('p', { class: 'ips-doc__meta' }, v.date ? `Versiunea din ${fmtDate(v.date)}${v.changeNote ? ` — ${v.changeNote}` : ''}` : 'Conținutul editorului (nu e o versiune salvată)',
      ` · tipărit pe ${fmtDate(todayIso())}`),
    ...IPS_SECTIONS.flatMap(s => {
      const text = v.sections[s.key];
      const extra: HTMLElement[] = [];
      if (s.key === 'allocation' && targets.length) {
        extra.push(h('p', { class: 'ips-doc__note' }, 'Ținta din pagina Portofoliu la data tipăririi:'),
          h('ul', {}, ...targets.map(t => h('li', {}, `${t.label}: ${NF1.format(t.weight * 100)}%${t.band !== undefined ? ` ± ${NF1.format(t.band * 100)} pp` : ''}`))));
      }
      if (!text && !extra.length) return [];
      return [h('section', {}, h('h2', {}, s.title), text ? h('div', { class: 'ips-doc__text' }, text) : null, ...extra)];
    }),
    ...Object.keys(v.sections).filter(k => !IPS_SECTION_KEYS.includes(k)).map(k => h('section', {}, h('h2', {}, k), h('div', { class: 'ips-doc__text' }, v.sections[k]))),
    ...(rules.length ? [h('section', {}, h('h2', {}, 'Reguli verificabile'), h('ul', {}, ...rules.map(l => h('li', {}, l))))] : []),
  );
}

function setPrintMode(on: boolean) {
  $('#printView').hidden = !on;
  document.body.classList.toggle('ips-printing', on);
  if (on) { renderPrint(); window.scrollTo({ top: 0 }); }
}

function renderAll(refill = true) {
  if (!loaded) return;
  if (refill) {
    const src = loaded.doc.draft ?? latestIpsVersion(loaded.doc);
    fillEditor(src?.sections ?? {}, src?.rules);
  }
  renderState();
  renderVersions();
}

// ─── Boot ───

async function init() {
  try {
    const [ips, d] = await Promise.all([loadDoc('ips'), loadDoc('data').catch(() => null)]);
    data = d?.doc ?? null;
    loaded = ips.exists ? ips : { ...ips, doc: emptyIps() };
    buildEditor(); // needs accounts, instruments and targets from data.json
    renderAll();
  } catch (e) {
    $('#ipsState').textContent = (e as Error).message;
    toast((e as Error).message, 'err');
    return;
  }

  $('#ipsEditor').addEventListener('input', markDirty);
  $('#ipsEditor').addEventListener('change', markDirty);
  $('#saveDraft').addEventListener('click', () => void saveDraft());
  $('#openVersion').addEventListener('click', () => {
    const form = $<HTMLFormElement>('#versionForm');
    form.hidden = false;
    $<HTMLInputElement>('[name="date"]', form).value ||= todayIso();
    $<HTMLInputElement>('[name="changeNote"]', form).focus();
  });
  $('#cancelVersion').addEventListener('click', () => { $<HTMLFormElement>('#versionForm').hidden = true; });
  $<HTMLFormElement>('#versionForm').addEventListener('submit', ev => void saveVersion(ev));
  $('#diffFrom').addEventListener('change', renderDiff);
  $('#diffTo').addEventListener('change', renderDiff);
  $('#openPrint').addEventListener('click', () => setPrintMode(true));
  $('#closePrint').addEventListener('click', () => setPrintMode(false));
  $('#printPick').addEventListener('change', renderPrint);
  $('#doPrint').addEventListener('click', () => window.print());
  window.addEventListener('beforeunload', ev => { if (dirty) ev.preventDefault(); });
}

void init();
