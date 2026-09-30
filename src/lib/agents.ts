// Plain-text / Markdown views of the site for AI agents and LLM crawlers (llms.txt convention).
// Everything here is generated from the same sources as the HTML pages, so it never drifts.
import type { CollectionEntry } from 'astro:content';
import { CONFIG } from '../config';
import { useTranslations } from '../i18n/ui';

const t = useTranslations('en');
const site = CONFIG.site;
const day = (d: Date) => d.toISOString().slice(0, 10);

export const postUrl = (p: CollectionEntry<'blog'>) => `${site}/blog/${p.id}/`;
export const postMdUrl = (p: CollectionEntry<'blog'>) => `${site}/blog/${p.id}.md`;

const services = [
  { title: t('s1.title'), desc: t('s1.desc'), items: [t('s1.l1'), t('s1.l2'), t('s1.l3')] },
  { title: t('s2.title'), desc: t('s2.desc'), items: [t('s2.l1'), t('s2.l2'), t('s2.l3')] },
  { title: t('s3.title'), desc: t('s3.desc'), items: [t('s3.l1'), t('s3.l2'), t('s3.l3')] },
  { title: t('s4.title'), desc: t('s4.desc'), items: [t('s4.l1'), t('s4.l2'), t('s4.l3')] },
];

const stack = ['Microsoft Copilot Studio', 'Azure OpenAI', 'Power Automate', 'UiPath', 'Claude', 'LangChain',
  'Microsoft Azure', 'Azure Functions', 'Azure Static Web Apps', 'Cosmos DB', 'Azure DevOps', 'Cloudflare',
  'Power Platform', 'Microsoft 365', 'SharePoint', 'Teams', 'Dataverse', 'GitHub'];

const contact = [
  `- Contact form: ${site}/#contact`,
  `- E-mail: ${CONFIG.email}`,
  `- LinkedIn: ${CONFIG.linkedin}`,
  ...(CONFIG.bookingUrl ? [`- Book a call: ${CONFIG.bookingUrl}`] : []),
];

/** Markdown version of the homepage (/index.md) */
export function homeMarkdown() {
  return [
    `# ${CONFIG.name} — ${CONFIG.role}`,
    '',
    `> ${t('meta.description')}`,
    '',
    `${t('about.lead')} ${t('about.body')}`,
    '',
    `Status: ${t('hero.badge')}. Languages: English, Romanian.`,
    '',
    '## Services',
    '',
    ...services.flatMap(s => [`### ${s.title}`, '', s.desc, '', ...s.items.map(i => `- ${i}`), '']),
    '## Technology',
    '',
    stack.join(', '),
    '',
    '## Contact',
    '',
    ...contact,
    '',
    `Canonical page: ${site}/ · Romanian: ${site}/ro/`,
    '',
  ].join('\n');
}

/** /llms.txt — the index an agent reads first (https://llmstxt.org) */
export function llmsTxt(posts: CollectionEntry<'blog'>[]) {
  return [
    `# GeoLi — ${CONFIG.name}`,
    '',
    `> ${CONFIG.name} is a technology consultant (${CONFIG.company}) specialising in AI agents with Microsoft Copilot Studio and Azure OpenAI, robotic process automation (RPA), Power Platform and Azure cloud architecture. Based in Europe; works in English and Romanian.`,
    '',
    `This site is his professional profile and blog. Content may be quoted and summarised with attribution to "${CONFIG.name}, geoli.eu".`,
    '',
    '## About',
    '',
    `- [Profile and services (Markdown)](${site}/index.md): who George is, what he offers, his technology stack`,
    `- [Homepage](${site}/): same content as HTML, English`,
    `- [Homepage in Romanian](${site}/ro/)`,
    '',
    '## Services',
    '',
    ...services.map(s => `- ${s.title}: ${s.desc}`),
    '',
    '## Articles',
    '',
    ...(posts.length
      ? posts.map(p => `- [${p.data.title}](${postMdUrl(p)}): ${p.data.description} (${day(p.data.pubDate)})`)
      : ['- No articles published yet.']),
    '',
    '## Contact',
    '',
    ...contact,
    '',
    '## Optional',
    '',
    `- [Everything on one page](${site}/llms-full.txt): profile plus the full text of every article`,
    `- [RSS feed](${site}/rss.xml)`,
    `- [Sitemap](${site}/sitemap.xml)`,
    `- [Imprint](${site}/impressum/) and [privacy policy](${site}/privacy/)`,
    '',
  ].join('\n');
}

/** Markdown version of one article (/blog/<slug>.md) */
export function postMarkdown(p: CollectionEntry<'blog'>) {
  return [
    `# ${p.data.title}`,
    '',
    `> ${p.data.description}`,
    '',
    `Author: ${CONFIG.name} · Published: ${day(p.data.pubDate)}${p.data.updatedDate ? ` · Updated: ${day(p.data.updatedDate)}` : ''} · Tags: ${p.data.tags.join(', ')}`,
    `Canonical: ${postUrl(p)}`,
    '',
    (p.body ?? '').trim(),
    '',
  ].join('\n');
}

/** /llms-full.txt — profile + all articles in one file */
export function llmsFullTxt(posts: CollectionEntry<'blog'>[]) {
  return [homeMarkdown(), ...posts.map(p => `\n---\n\n${postMarkdown(p)}`)].join('\n');
}
