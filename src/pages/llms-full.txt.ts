import { getPosts } from '../lib/site';
import { llmsFullTxt } from '../lib/agents';

export async function GET() {
  return new Response(llmsFullTxt(await getPosts()), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
