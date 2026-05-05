import { CONFIG } from './config.js';

const translations = Object.freeze({
  en: {
    'nav.about':    'About',
    'nav.services': 'Services',
    'nav.stack':    'Stack',
    'nav.cta':      "Let's Talk",

    'hero.badge':    'Available for projects',
    'hero.title1':   'Automating the',
    'hero.title2':   'future of work.',
    'hero.subtitle': 'I help organisations cut through complexity — building intelligent automation, AI-driven workflows, and scalable technology solutions that actually stick.',
    'hero.cta1':     'Explore Services',
    'hero.cta2':     'Get in Touch',

    'about.label':  'About',
    'about.lead':   'Technology consultant at BearingPoint with a focus on Artificial Intelligence, Robotic Process Automation, and enterprise digital transformation.',
    'about.body':   'With hands-on experience delivering AI and automation projects across industries, I bridge the gap between cutting-edge technology and real-world business outcomes. From designing intelligent agent architectures to deploying RPA at scale — I turn complex challenges into elegant, automated solutions.',
    'about.stat1':  'Agent Design',
    'about.stat2':  'Process Automation',
    'about.stat3':  'Cloud Architecture',
    'about.role':   'Technology Consultant',
    'about.status': 'Open to collaboration',

    'services.label':    'Services',
    'services.title':    'What I do',
    'services.subtitle': 'End-to-end expertise across the intelligent automation stack.',

    's1.title': 'AI Agent Development',
    's1.desc':  'Design and build intelligent agents using Microsoft Copilot Studio, Azure AI, and custom LLM integrations. From conversational bots to autonomous multi-agent systems.',
    's1.l1': 'Copilot Studio agents',
    's1.l2': 'Azure OpenAI integrations',
    's1.l3': 'Multi-agent orchestration',

    's2.title': 'Robotic Process Automation',
    's2.desc':  'End-to-end RPA delivery — from process discovery through to bot development, testing, and hypercare. Compliant, scalable, built to last.',
    's2.l1': 'Process discovery & mining',
    's2.l2': 'Bot development & deployment',
    's2.l3': 'RPA governance frameworks',

    's3.title': 'Cloud & Azure Architecture',
    's3.desc':  'Design resilient, cost-optimised Azure solutions — from Static Web Apps and serverless Functions to full enterprise data platforms.',
    's3.l1': 'Azure infrastructure design',
    's3.l2': 'Serverless & containerised apps',
    's3.l3': 'Cost optimisation reviews',

    's4.title': 'Digital Transformation Strategy',
    's4.desc':  'Advisory and delivery for organisations navigating large-scale transformation — aligning technology investments with measurable business outcomes.',
    's4.l1': 'Automation roadmaps',
    's4.l2': 'Technology assessments',
    's4.l3': 'Change & adoption support',

    'stack.label': 'Technology Stack',
    'stack.title': 'Tools of the trade',
    'stack.cat1':  'AI & Automation',
    'stack.cat2':  'Cloud & Infrastructure',
    'stack.cat3':  'Platform & Productivity',

    'contact.label':    'Contact',
    'contact.title':    "Let's build something.",
    'contact.subtitle': "Whether you have a project in mind, a question about automation, or just want to connect — I'd love to hear from you.",

    'footer.tagline': 'Technology · AI · RPA',
  },

  ro: {
    'nav.about':    'Despre',
    'nav.services': 'Servicii',
    'nav.stack':    'Tehnologii',
    'nav.cta':      'Hai să vorbim',

    'hero.badge':    'Disponibil pentru proiecte',
    'hero.title1':   'Automatizând',
    'hero.title2':   'viitorul muncii.',
    'hero.subtitle': 'Ajut organizațiile să reducă complexitatea — construind automatizări inteligente, fluxuri bazate pe AI și soluții tehnologice scalabile care chiar funcționează.',
    'hero.cta1':     'Explorează Serviciile',
    'hero.cta2':     'Contactează-mă',

    'about.label':  'Despre',
    'about.lead':   'Consultant tehnologie la BearingPoint, specializat în Inteligență Artificială, Automatizare Robotizată a Proceselor și transformare digitală la nivel enterprise.',
    'about.body':   'Cu experiență practică în livrarea proiectelor de AI și automatizare în diverse industrii, construiesc puntea dintre tehnologia de vârf și rezultatele reale de business. De la arhitecturi de agenți inteligenți până la implementarea RPA la scară largă — transform provocările complexe în soluții elegante și automatizate.',
    'about.stat1':  'Design Agenți',
    'about.stat2':  'Automatizare Procese',
    'about.stat3':  'Arhitectură Cloud',
    'about.role':   'Consultant Tehnologie',
    'about.status': 'Deschis colaborărilor',

    'services.label':    'Servicii',
    'services.title':    'Ce fac',
    'services.subtitle': 'Expertiză completă pe tot stackul de automatizare inteligentă.',

    's1.title': 'Dezvoltare Agenți AI',
    's1.desc':  'Proiectez și construiesc agenți inteligenți folosind Microsoft Copilot Studio, Azure AI și integrări LLM personalizate. De la boți conversaționali la sisteme multi-agent autonome.',
    's1.l1': 'Agenți Copilot Studio',
    's1.l2': 'Integrări Azure OpenAI',
    's1.l3': 'Orchestrare multi-agent',

    's2.title': 'Automatizare Robotizată (RPA)',
    's2.desc':  'Livrare RPA end-to-end — de la descoperirea proceselor până la dezvoltarea botului, testare și hypercare. Conform, scalabil și construit pentru durabilitate.',
    's2.l1': 'Descoperire și minare procese',
    's2.l2': 'Dezvoltare și deploy bot',
    's2.l3': 'Cadre de guvernanță RPA',

    's3.title': 'Arhitectură Cloud & Azure',
    's3.desc':  'Proiectez soluții Azure reziliente și optimizate ca și cost — de la Static Web Apps și funcții serverless până la arhitecturi complete de platforme de date enterprise.',
    's3.l1': 'Design infrastructură Azure',
    's3.l2': 'Aplicații serverless și containerizate',
    's3.l3': 'Analize de optimizare costuri',

    's4.title': 'Strategie de Transformare Digitală',
    's4.desc':  'Consultanță și livrare pentru organizații care navighează transformări la scară largă — aliniind investițiile tehnologice cu rezultate de business măsurabile.',
    's4.l1': 'Foi de parcurs pentru automatizare',
    's4.l2': 'Evaluări tehnologice',
    's4.l3': 'Suport pentru schimbare și adoptare',

    'stack.label': 'Stack Tehnologic',
    'stack.title': 'Instrumentele de lucru',
    'stack.cat1':  'AI & Automatizare',
    'stack.cat2':  'Cloud & Infrastructură',
    'stack.cat3':  'Platformă & Productivitate',

    'contact.label':    'Contact',
    'contact.title':    'Hai să construim ceva.',
    'contact.subtitle': 'Indiferent dacă ai un proiect în minte, o întrebare despre automatizare sau vrei doar să ne conectăm — mi-ar face plăcere să te aud.',

    'footer.tagline': 'Tehnologie · AI · RPA',
  },
});

function isValidLang(lang) {
  return CONFIG.supportedLangs.includes(lang);
}

export function setLang(lang) {
  if (!isValidLang(lang)) return;

  const html = document.documentElement;
  html.setAttribute('lang', lang);
  html.setAttribute('data-lang', lang);

  document.body.classList.add('lang-switching');
  setTimeout(() => document.body.classList.remove('lang-switching'), 300);

  const dict = translations[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
      el.textContent = dict[key];
    }
  });

  document.querySelectorAll('.lang-btn').forEach(btn => {
    const active = btn.dataset.lang === lang;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const toggle = document.getElementById('langToggle');
  if (toggle) toggle.dataset.active = lang;

  try {
    localStorage.setItem(CONFIG.storageKey, lang);
  } catch (_) {}
}

export function initLang() {
  let saved;
  try {
    saved = localStorage.getItem(CONFIG.storageKey);
  } catch (_) {}

  const lang = isValidLang(saved) ? saved : CONFIG.defaultLang;
  setLang(lang);

  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
}
