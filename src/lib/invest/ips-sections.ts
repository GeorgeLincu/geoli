// Phase 6: the IPS outline. Headings and guiding QUESTIONS only — the answers are George's to write
// (CLAUDE.md rule #3). Keys are stored in ips.json `sections`, so never rename a key once used.

export interface IpsSectionDef {
  key: string;
  title: string;
  questions: string[];
  /** Where the structured part of this topic lives (shown as a link, never copied) */
  link?: { href: string; label: string };
}

export const IPS_SECTIONS: readonly IpsSectionDef[] = [
  { key: 'goals', title: 'Obiective', questions: [
    'Pentru ce investești? Care sunt obiectivele, în ordinea importanței?',
    'Cum arată „suficient” pentru fiecare obiectiv (sumă, venit lunar, dată)?',
  ] },
  { key: 'horizon', title: 'Orizont de timp', questions: [
    'Când crezi că vei avea nevoie de bani, pentru fiecare obiectiv?',
    'Ce s-ar putea schimba la aceste termene?',
  ] },
  { key: 'risk', title: 'Toleranța și capacitatea de risc', questions: [
    'Ce scădere temporară a portofoliului ai putea suporta fără să vinzi?',
    'Cât de stabil e venitul tău și cine depinde de el?',
    'Ce ai făcut (sau crezi că ai face) într-o scădere mare a pieței?',
  ] },
  { key: 'allocation', title: 'Alocarea-țintă și benzile de rebalansare', questions: [
    'De ce ai ales această alocare? Ce rol are fiecare clasă de active?',
    'Ce ar trebui să se întâmple ca să schimbi alocarea?',
  ], link: { href: '/vault/invest/portofoliu/#alocare', label: 'Ținta și benzile sunt pe pagina Portofoliu' } },
  { key: 'contributions', title: 'Reguli de contribuție', questions: [
    'Cât, cât de des și în ce zi contribui?',
    'Ce faci cu banii neprevăzuți (bonusuri, cadouri)?',
    'În ce situații ai sări sau ai reduce o contribuție?',
  ] },
  { key: 'rebalancing', title: 'Reguli de rebalansare', questions: [
    'Rebalansezi prin contribuții, prin vânzări sau prin ambele?',
    'Cât de des verifici și ce faci când un rând iese din bandă?',
    'Cum ții cont de taxe și comisioane când rebalansezi?',
  ] },
  { key: 'withdrawal', title: 'Reguli de retragere', questions: [
    'Când și cum vei începe retragerile?',
    'Ce rată de retragere iei în calcul și cum o ajustezi în anii slabi?',
    'Din ce conturi și în ce ordine retragi?',
  ], link: { href: '/vault/invest/plan/', label: 'Planul și proiecția (pagina Pensie vine în faza 5)' } },
  { key: 'instruments', title: 'Instrumente permise și nepermise', questions: [
    'Ce tipuri de instrumente folosești și de ce?',
    'Ce nu cumperi niciodată?',
    'Ce criterii trebuie să îndeplinească un fond (cost, domiciliu, acumulare/distribuire, mărime)?',
  ] },
  { key: 'crash', title: 'Comportament în căderi', questions: [
    'Ce faci când piața scade 10%, 20%, 30% sau mai mult?',
    'Ce nu faci, orice s-ar întâmpla?',
    'Cine sau ce te ajută să respecți regulile în momentele grele?',
  ] },
  { key: 'emergency', title: 'Fond de urgență', questions: [
    'Câte luni de cheltuieli ții deoparte și unde?',
    'Ce situații justifică folosirea lui și cum îl refaci?',
  ] },
  { key: 'review', title: 'Revizuire', questions: [
    'Când revizuiești IPS și ce verifici de fiecare dată?',
    'Ce evenimente din viață declanșează o revizuire în afara calendarului?',
  ] },
];

export const IPS_SECTION_KEYS = IPS_SECTIONS.map(s => s.key);
export const ipsSectionTitle = (key: string) => IPS_SECTIONS.find(s => s.key === key)?.title ?? key;
