import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPosts } from '../lib/site';

export async function GET(context: APIContext) {
  const posts = await getPosts();
  return rss({
    title: 'GeoLi — Insights',
    description: 'Articles by George Lincu on AI agents, automation and Azure.',
    site: context.site!,
    items: posts.map(post => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      categories: post.data.tags,
      link: `/blog/${post.id}/`,
    })),
    customData: '<language>en-gb</language>',
  });
}
