// UI strings for every page. Keys are shared; each language must define all of them.
export const languages = { en: 'EN', ro: 'RO' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

const ui = {
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


    'about.cv': 'Download CV',

    'blog.label':    'Insights',
    'blog.title':    'Latest Thinking',
    'blog.subtitle': 'Articles on AI, automation, and digital transformation.',
    'blog.read':     'Read article →',
    'blog.soon':     'Coming soon',




    'form.name':    'Your name',
    'form.email':   'Your email',
    'form.message': 'Your message',
    'form.send':    'Send message',
    'form.success': "Message sent — I'll get back to you shortly.",
    'form.error':   'Something went wrong. Please try again.',
    'form.invalid': 'Please fill in your name, a valid email and a message (at least 10 characters).',
    'form.sending': 'Sending…',

    'contact.divider': 'or reach out directly',
    'footer.imprint':  'Imprint',
    'footer.privacy':  'Privacy',
    'a11y.skip':       'Skip to content',

    'meta.title':       'George Lincu — AI Agents, RPA & Azure Consultant | GeoLi',
    'meta.description': 'George Lincu — technology consultant specialising in AI agents (Copilot Studio, Azure OpenAI), robotic process automation and Azure cloud architecture. Based in Europe.',
    'meta.ogTitle':     'George Lincu — AI Agents, RPA & Azure Consultant',

    'nav.blog':       'Insights',
    'nav.home':       'Home',
    'nav.menu':       'Toggle menu',
    'theme.toggle':   'Switch colour theme',
    'lang.label':     'Language',

    'hero.book':      'Book a call',

    'projects.label':    'Projects',
    'projects.title':    'Selected work',
    'projects.subtitle': 'Problem, approach, outcome — a few engagements I can talk about.',
    'projects.problem':  'Challenge',
    'projects.approach': 'Approach',
    'projects.outcome':  'Outcome',

    'blog.all':        'All articles →',
    'blog.minRead':    'min read',
    'blog.back':       '← All articles',
    'blog.updated':    'Updated',
    'blog.enOnly':     '',
    'blog.empty':      'The first articles are on their way.',
    'blog.rss':        'RSS feed',
    'blog.cta.title':  'Working on something similar?',
    'blog.cta.body':   "I'm happy to talk it through.",

    'nf.title':   "This page doesn't exist.",
    'nf.body':    'The link may be broken or the page may have moved.',
    'nf.back':    'Back to geoli.eu',
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


    'about.cv': 'Descarcă CV',

    'blog.label':    'Articole',
    'blog.title':    'Ultimele Gânduri',
    'blog.subtitle': 'Articole despre AI, automatizare și transformare digitală.',
    'blog.read':     'Citește articolul →',
    'blog.soon':     'În curând',




    'form.name':    'Numele tău',
    'form.email':   'Email-ul tău',
    'form.message': 'Mesajul tău',
    'form.send':    'Trimite mesajul',
    'form.success': 'Mesaj trimis — îți voi răspunde în scurt timp.',
    'form.error':   'Ceva a mers greșit. Te rog încearcă din nou.',
    'form.invalid': 'Te rog completează numele, un email valid și un mesaj (minim 10 caractere).',
    'form.sending': 'Se trimite…',

    'contact.divider': 'sau scrie-mi direct',
    'footer.imprint':  'Impressum',
    'footer.privacy':  'Confidențialitate',
    'a11y.skip':       'Sari la conținut',

    'meta.title':       'George Lincu — Consultant Agenți AI, RPA și Azure | GeoLi',
    'meta.description': 'George Lincu — consultant în tehnologie specializat în agenți AI (Copilot Studio, Azure OpenAI), automatizare robotizată a proceselor (RPA) și arhitectură cloud Azure.',
    'meta.ogTitle':     'George Lincu — Consultant Agenți AI, RPA și Azure',

    'nav.blog':       'Articole',
    'nav.home':       'Acasă',
    'nav.menu':       'Deschide meniul',
    'theme.toggle':   'Schimbă tema de culori',
    'lang.label':     'Limbă',

    'hero.book':      'Programează o discuție',

    'projects.label':    'Proiecte',
    'projects.title':    'Proiecte selectate',
    'projects.subtitle': 'Problemă, abordare, rezultat — câteva proiecte despre care pot vorbi.',
    'projects.problem':  'Provocare',
    'projects.approach': 'Abordare',
    'projects.outcome':  'Rezultat',

    'blog.all':        'Toate articolele →',
    'blog.minRead':    'min de citit',
    'blog.back':       '← Toate articolele',
    'blog.updated':    'Actualizat',
    'blog.enOnly':     'Articolele sunt disponibile momentan în limba engleză.',
    'blog.empty':      'Primele articole sunt pe drum.',
    'blog.rss':        'Flux RSS',
    'blog.cta.title':  'Lucrezi la ceva asemănător?',
    'blog.cta.body':   'Hai să discutăm.',

    'nf.title':   'Această pagină nu există.',
    'nf.body':    'Linkul poate fi greșit sau pagina a fost mutată.',
    'nf.back':    'Înapoi la geoli.eu',
  },
} as const;

export type UIKey = keyof typeof ui.en;

export function useTranslations(lang: Lang) {
  return (key: UIKey): string => ui[lang][key] ?? ui.en[key];
}

// Same page in another language: "/" <-> "/ro/", "/blog/x/" <-> "/ro/blog/x/"
export function localizePath(path: string, lang: Lang): string {
  const clean = path.replace(/^\/ro(?=\/|$)/, '') || '/';
  return lang === defaultLang ? clean : `/ro${clean}`;
}
