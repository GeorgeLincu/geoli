// Article publishing from the vault: reads/writes src/content/blog/<slug>.md in the GitHub repo.
// Every save is a commit to main → Workers Builds rebuilds and deploys the site in ~1–2 minutes.
// Needs the secret GITHUB_TOKEN: a fine-grained token limited to this one repo, "Contents: Read and write".
import type { Env } from './index';

const BLOG_DIR = 'src/content/blog';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PostInput {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  pubDate: string;
  draft: boolean;
  body: string;
  sha?: string; // required when updating an existing file (optimistic locking)
}

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  pubDate: string;
  updatedDate?: string;
  draft: boolean;
}

// ─── GitHub REST helpers ─────────────────────────────────────────────
const repo = (env: Env) => env.GITHUB_REPO || 'GeorgeLincu/geoli';
const branch = (env: Env) => env.GITHUB_BRANCH || 'main';

async function gh(env: Env, path: string, init: RequestInit = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(503, 'Publishing is not configured (GITHUB_TOKEN secret missing)');
  const res = await fetch(`https://api.github.com/repos/${repo(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'geoli-vault',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.message === 'string' ? data.message : res.statusText;
    // 409/422 on PUT = file changed since it was opened (stale sha)
    throw new HttpError(res.status === 409 || res.status === 422 ? 409 : 502, `GitHub: ${msg}`);
  }
  return data;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));

// ─── Frontmatter ─────────────────────────────────────────────────────
function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"') || v.startsWith('[')) { try { return JSON.parse(v); } catch { /* fall through */ } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function parsePost(slug: string, text: string): PostMeta & { body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const fm: Record<string, unknown> = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = parseValue(kv[2]);
  }
  const str = (k: string) => (typeof fm[k] === 'string' ? (fm[k] as string) : fm[k] != null ? String(fm[k]) : '');
  return {
    slug,
    title: str('title'),
    description: str('description'),
    tags: Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : [],
    pubDate: str('pubDate').slice(0, 10),
    updatedDate: str('updatedDate').slice(0, 10) || undefined,
    draft: fm.draft === true,
    body: (m ? m[2] : text).replace(/^\n+/, ''),
  };
}

function serialize(p: PostInput, updatedDate?: string) {
  // JSON strings are valid YAML double-quoted scalars — safe for any title/description
  const lines = [
    '---',
    `title: ${JSON.stringify(p.title)}`,
    `description: ${JSON.stringify(p.description)}`,
    `pubDate: ${p.pubDate}`,
    ...(updatedDate ? [`updatedDate: ${updatedDate}`] : []),
    `tags: ${JSON.stringify(p.tags)}`,
    `draft: ${p.draft}`,
    '---',
    '',
  ];
  return `${lines.join('\n')}${p.body.replace(/\r\n/g, '\n').trim()}\n`;
}

export function validate(raw: unknown): PostInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const post: PostInput = {
    slug: s(b.slug).toLowerCase(),
    title: s(b.title),
    description: s(b.description).replace(/\s+/g, ' '),
    tags: (Array.isArray(b.tags) ? b.tags : []).map(t => s(t)).filter(Boolean).slice(0, 6),
    pubDate: s(b.pubDate),
    draft: b.draft !== false,
    body: typeof b.body === 'string' ? b.body : '',
    sha: s(b.sha) || undefined,
  };
  const errors: string[] = [];
  if (!SLUG_RE.test(post.slug) || post.slug.length > 90) errors.push('URL slug: lower-case letters, digits and hyphens only');
  if (post.title.length < 5 || post.title.length > 120) errors.push('Title: 5–120 characters');
  if (post.description.length < 50 || post.description.length > 170) errors.push('Description: 50–170 characters (shown in Google results)');
  if (post.tags.some(t => t.length > 30)) errors.push('Tags: max 30 characters each');
  if (!post.tags.length) errors.push('Add at least one tag');
  if (!DATE_RE.test(post.pubDate) || isNaN(Date.parse(post.pubDate))) errors.push('Date: YYYY-MM-DD');
  if (post.body.trim().length < 20) errors.push('Article text is empty');
  if (post.body.length > 300_000) errors.push('Article text is too long');
  if (/<script\b|\sstyle\s*=|\son[a-z]+\s*=/i.test(post.body)) errors.push('No <script>, style="" or on…= attributes in the text (blocked by the site security policy)');
  if (errors.length) throw new HttpError(400, errors.join(' · '));
  return post;
}

// ─── Operations ─────────────────────────────────────────────────────
export async function listPosts(env: Env): Promise<PostMeta[]> {
  const items = (await gh(env, `/contents/${BLOG_DIR}?ref=${branch(env)}`)) as unknown as { name: string; type: string }[] | null;
  if (!items) return [];
  const files = items.filter(f => f.type === 'file' && f.name.endsWith('.md') && !f.name.startsWith('_'));
  const posts = await Promise.all(files.map(async f => {
    const slug = f.name.replace(/\.md$/, '');
    const got = await getPost(env, slug);
    if (!got) return null;
    const { body: _body, sha: _sha, ...meta } = got;
    return meta;
  }));
  return (posts.filter(Boolean) as PostMeta[]).sort((a, b) => b.pubDate.localeCompare(a.pubDate));
}

export async function getPost(env: Env, slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  const f = (await gh(env, `/contents/${BLOG_DIR}/${slug}.md?ref=${branch(env)}`)) as { content: string; sha: string } | null;
  if (!f) return null;
  return { ...parsePost(slug, fromBase64(f.content)), sha: f.sha };
}

export async function savePost(env: Env, post: PostInput, by: string) {
  const existing = await getPost(env, post.slug);
  if (existing && !post.sha) throw new HttpError(409, 'An article with this URL already exists — open it from the list to edit it');
  if (existing && post.sha && existing.sha !== post.sha) throw new HttpError(409, 'This article was changed elsewhere — reload it before saving');

  // Mark "updated" only when an already-published article changes again
  const today = new Date().toISOString().slice(0, 10);
  const updatedDate = existing && !existing.draft && !post.draft && existing.pubDate !== today ? today : existing?.updatedDate;
  const verb = existing ? (post.draft ? 'Update draft' : existing.draft ? 'Publish' : 'Update') : (post.draft ? 'Add draft' : 'Publish');

  const res = (await gh(env, `/contents/${BLOG_DIR}/${post.slug}.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${verb}: ${post.title}\n\nSaved from geoli.eu/vault by ${by}`,
      content: toBase64(new TextEncoder().encode(serialize(post, updatedDate))),
      branch: branch(env),
      ...(existing ? { sha: existing.sha } : {}),
    }),
  })) as { content?: { sha: string }; commit?: { html_url: string } };
  return { sha: res?.content?.sha, commit: res?.commit?.html_url, draft: post.draft };
}

export async function deletePost(env: Env, slug: string, sha: string, by: string) {
  const existing = await getPost(env, slug);
  if (!existing) throw new HttpError(404, 'Not found');
  if (existing.sha !== sha) throw new HttpError(409, 'This article was changed elsewhere — reload the list');
  await gh(env, `/contents/${BLOG_DIR}/${slug}.md`, {
    method: 'DELETE',
    body: JSON.stringify({ message: `Delete article: ${existing.title}\n\nDeleted from geoli.eu/vault by ${by}`, sha, branch: branch(env) }),
  });
}
