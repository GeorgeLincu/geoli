import { getPosts } from '../lib/site';
import { llmsTxt } from '../lib/agents';

export async function GET() {
  return new Response(llmsTxt(await getPosts()), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
