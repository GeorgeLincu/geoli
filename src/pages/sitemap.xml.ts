import type { APIContext } from 'astro';
import { getPosts } from '../lib/site';

type Entry = { loc: string; lastmod?: string; alt?: { en: string; ro: string } };

// Hand-rolled so the URL stays /sitemap.xml and EN/RO pairs carry hreflang links.
export async function GET({ site }: APIContext) {
  const abs   = (p: string) => new URL(p, site).href;
  const day   = (d: Date) => d.toISOString().slice(0, 10);
  const posts = await getPosts();
  const today = day(new Date());
  const blogUpdated = posts[0] ? day(posts[0].data.pubDate) : today;

  const pair = (en: string, ro: string, lastmod: string): Entry[] => [
    { loc: en, lastmod, alt: { en, ro } },
    { loc: ro, lastmod, alt: { en, ro } },
  ];

  const entries: Entry[] = [
    ...pair('/', '/ro/', today),
    ...pair('/blog/', '/ro/blog/', blogUpdated),
    ...posts.map(p => ({ loc: `/blog/${p.id}/`, lastmod: day(p.data.updatedDate ?? p.data.pubDate) })),
    ...pair('/legal/', '/ro/legal/', today),
    ...pair('/privacy/', '/ro/privacy/', today),
  ];

  const url = (e: Entry) => {
    const lines = [`    <loc>${abs(e.loc)}</loc>`];
    if (e.lastmod) lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
    if (e.alt) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="en" href="${abs(e.alt.en)}"/>`);
      lines.push(`    <xhtml:link rel="alternate" hreflang="ro" href="${abs(e.alt.ro)}"/>`);
      lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${abs(e.alt.en)}"/>`);
    }
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  };

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries.map(url),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
