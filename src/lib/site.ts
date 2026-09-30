import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCollection, type CollectionEntry } from 'astro:content';

// True when a file referenced by an absolute site path exists in public/
export const publicFileExists = (path: string) =>
  !!path && existsSync(join(process.cwd(), 'public', path));

// Drafts are visible in `astro dev`, or in a build with PREVIEW_DRAFTS=1 (never set that in production)
export const showDrafts = import.meta.env.DEV || process.env.PREVIEW_DRAFTS === '1';

// Published posts, newest first
export async function getPosts(): Promise<CollectionEntry<'blog'>[]> {
  const posts = await getCollection('blog', ({ data }) => showDrafts || !data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export const readingMinutes = (text = '') =>
  Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 220));

export const formatDate = (date: Date, lang: string) =>
  date.toLocaleDateString(lang === 'ro' ? 'ro-RO' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
