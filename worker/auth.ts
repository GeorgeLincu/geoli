// Verifies the Cloudflare Access JWT on every vault request.
// Access blocks unauthenticated visitors at the edge; this check is defence in depth
// (e.g. someone reaching the Worker via a workers.dev URL that Access doesn't cover).
import type { Env } from './index';

export interface User {
  email: string;
  admin: boolean;
}

interface Jwk extends JsonWebKey { kid: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};
const b64urlToJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(teamDomain: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}

async function verifyAccessJwt(token: string, env: Env): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = b64urlToJson(h);
    payload = b64urlToJson(p);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  let jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN, true)).find(k => k.kid === header.kid); // key rotation
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  return payload;
}

const adminList = (env: Env) =>
  (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

/** Returns the signed-in user, or null. Fails closed when Access isn't configured. */
export async function getUser(request: Request, env: Env): Promise<User | null> {
  const url = new URL(request.url);

  // Local development only: `wrangler dev` on localhost with DEV_EMAIL in .dev.vars
  if (env.DEV_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    const email = env.DEV_EMAIL.toLowerCase();
    return { email, admin: adminList(env).includes(email) };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;

  const claims = await verifyAccessJwt(token, env).catch(() => null);
  const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : '';
  if (!email) return null;
  return { email, admin: adminList(env).includes(email) };
}
