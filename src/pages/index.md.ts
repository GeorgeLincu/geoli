import { homeMarkdown } from '../lib/agents';

export function GET() {
  return new Response(homeMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
