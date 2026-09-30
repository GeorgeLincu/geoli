import type { APIContext } from 'astro';
import type { CollectionEntry } from 'astro:content';
import { getPosts } from '../../lib/site';
import { postMarkdown } from '../../lib/agents';

// Markdown twin of every article at /blog/<slug>.md — what AI agents prefer to read
export async function getStaticPaths() {
  const posts = await getPosts();
  return posts.map(post => ({ params: { slug: post.id }, props: { post } }));
}

export function GET({ props }: APIContext<{ post: CollectionEntry<'blog'> }>) {
  return new Response(postMarkdown(props.post), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
