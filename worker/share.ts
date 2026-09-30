// Time-limited public share links: /s/<payload>.<signature>
// payload = base64url(JSON {k: key, e: expiry unix seconds}), signature = HMAC-SHA256(payload, SHARE_SECRET)

const enc = new TextEncoder();

const toB64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const MAX_SHARE_HOURS = 24 * 30;

export async function createShareToken(key: string, hours: number, secret: string): Promise<{ token: string; expires: number }> {
  const expires = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const payload = toB64url(enc.encode(JSON.stringify({ k: key, e: expires })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return { token: `${payload}.${toB64url(sig)}`, expires };
}

/** Returns the object key if the token is authentic and not expired. */
export async function verifyShareToken(token: string, secret: string): Promise<string | null> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || token.length > 2048) return null;
  let sigBytes: Uint8Array;
  try { sigBytes = fromB64url(sig); } catch { return null; }
  // crypto.subtle.verify is constant-time
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(payload));
  if (!ok) return null;
  try {
    const { k, e } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof k !== 'string' || typeof e !== 'number' || e < Date.now() / 1000) return null;
    return k;
  } catch {
    return null;
  }
}
