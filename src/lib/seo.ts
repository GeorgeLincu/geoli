import type { CollectionEntry } from 'astro:content';
import { CONFIG } from '../config';
import type { Lang } from '../i18n/ui';

const site   = CONFIG.site;
const person = { '@id': `${site}/#person` };

export function homeJsonLd(lang: Lang) {
  const url = lang === 'en' ? `${site}/` : `${site}/ro/`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        '@id': `${site}/#person`,
        name: CONFIG.name,
        url: `${site}/`,
        image: `${site}/assets/og-image.png`,
        jobTitle: CONFIG.role,
        worksFor: { '@type': 'Organization', name: 'BearingPoint' },
        sameAs: [CONFIG.linkedin],
        knowsAbout: ['Artificial Intelligence', 'AI Agents', 'Microsoft Copilot Studio', 'Azure OpenAI',
          'Robotic Process Automation', 'Power Platform', 'Process Mining', 'Microsoft Azure', 'Digital Transformation'],
        knowsLanguage: ['en', 'ro'],
      },
      {
        '@type': 'WebSite',
        '@id': `${site}/#website`,
        url: `${site}/`,
        name: 'GeoLi',
        inLanguage: ['en', 'ro'],
        publisher: person,
      },
      {
        '@type': 'ProfessionalService',
        '@id': `${site}/#service`,
        name: 'GeoLi — AI & Automation Consulting',
        url,
        image: `${site}/assets/og-image.png`,
        founder: person,
        areaServed: 'Europe',
        serviceType: ['AI Agent Development', 'Robotic Process Automation', 'Cloud & Azure Architecture', 'Digital Transformation Strategy'],
      },
    ],
  };
}

export function postJsonLd(post: CollectionEntry<'blog'>, image: string) {
  const url = `${site}/blog/${post.id}/`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${url}#article`,
        headline: post.data.title,
        description: post.data.description,
        url,
        mainEntityOfPage: url,
        datePublished: post.data.pubDate.toISOString(),
        dateModified: (post.data.updatedDate ?? post.data.pubDate).toISOString(),
        inLanguage: 'en',
        keywords: post.data.tags.join(', '),
        image: new URL(image, site).href,
        author: { '@type': 'Person', name: CONFIG.name, url: `${site}/`, ...person },
        publisher: person,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${site}/` },
          { '@type': 'ListItem', position: 2, name: 'Insights', item: `${site}/blog/` },
          { '@type': 'ListItem', position: 3, name: post.data.title, item: url },
        ],
      },
    ],
  };
}
