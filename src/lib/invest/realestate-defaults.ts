// Researched legal values for /vault/invest/imobiliare/ (research of 2026-11-28). Loaded only when George presses
// „Încarcă valorile cercetate”; every value is `confirmed: false` until he confirms it on the page.
// Sources: official where they could be read (ANAF), otherwise the law text from a secondary publisher — marked in `note`.
import type { RealEstateParam } from './types';
import type { ReParamKey } from './property';

const VERIFIED = '2026-11-28';

export const RE_PARAM_LABEL: Record<ReParamKey, string> = {
  'prepay.feeFixed': 'Comision rambursare anticipată — perioada cu dobândă fixă',
  'prepay.feeVariable': 'Comision rambursare anticipată — perioada cu dobândă variabilă',
  'rent.taxRate': 'Impozit pe venitul din chirii',
  'rent.deduction': 'Cota forfetară de cheltuieli la chirii',
  'dti.max': 'Grad maxim de îndatorare (credit în lei)',
  'dti.maxFirstHome': 'Grad maxim de îndatorare — prima locuință',
  'age.maxAtMaturity': 'Vârsta maximă la scadență (politica băncii)',
};

export const RE_PARAM_KEYS = Object.keys(RE_PARAM_LABEL) as ReParamKey[];

export const RESEARCHED_RE_PARAMS: Partial<Record<ReParamKey, RealEstateParam>> = {
  'prepay.feeFixed': {
    value: 0, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://lege5.ro/Gratuit/gezdqnjwg42q/ordonanta-de-urgenta-nr-52-2016',
    note: 'OUG 52/2016 art. 41 alin. (1)–(3): la creditele pentru bunuri imobile (contracte după 30.09.2016) creditorul nu poate percepe penalități sau compensații la rambursarea anticipată, la dobândă fixă sau variabilă. Contracte mai vechi pe OUG 50/2010 (art. 68): max. 1% dacă mai e peste 1 an, 0,5% sub 1 an, doar în perioada fixă. Text citit dintr-o sursă secundară (legislatie.just.ro inaccesibil la verificare) — verifică în contractul tău.',
  },
  'prepay.feeVariable': {
    value: 0, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://lege5.ro/Gratuit/gezdqnjwg42q/ordonanta-de-urgenta-nr-52-2016',
    note: 'OUG 52/2016 art. 41: fără comision. OUG 50/2010: fără comision în perioada cu dobândă variabilă.',
  },
  'rent.taxRate': {
    value: 0.10, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://static.anaf.ro/static/10/Timisoara/Timis/Material%20chirii%202026%20aprilie.pdf',
    note: 'Codul fiscal art. 84: 10% din venitul net, 2025 și 2026 (creșterea la 16% din Legea 239/2025 și OUG 89/2025 nu privește chiriile). Declarația unică până la 25 mai. CASS: dacă chiriile + alte venituri din afara salariului ≥ 6 salarii minime (art. 170) — nu e calculat aici.',
  },
  'rent.deduction': {
    value: 0.20, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://static.anaf.ro/static/3/Ploiesti/20260126082726_comunicat%20ajfp%20arges%20-%20impozit%20venit%20si%20contrib.%20sociale%20site.pdf',
    note: 'Codul fiscal art. 84: venit net = venit brut − 20% cheltuieli forfetare. Închiriere în scop turistic (1–7 camere): 30%, alte reguli.',
  },
  'dti.max': {
    value: 0.40, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://www.bnr.ro/uploads/editor/1850860936.pdf',
    note: 'Regulamentul BNR 17/2012 art. 19: 40% din venitul net pentru credite în lei (20% în valută, fără acoperire). Băncile pot depăși limita pentru max. 15% din volum (art. 20). Limitele citite din surse secundare (KPMG); documentul BNR e proiectul de modificare 2026.',
  },
  'dti.maxFirstHome': {
    value: 0.45, verifiedOn: VERIFIED, confirmed: false,
    source: 'https://kpmg.com/ro/en/home/insights/2019/01/debt-to-income-ratio-loans-2019-restricted.html',
    note: 'Regulamentul BNR 17/2012 art. 19: +5 pp pentru prima locuință în care locuiești.',
  },
};
