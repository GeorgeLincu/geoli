// Contact form backend: POST /api/contact → e-mail to George via Cloudflare Email Routing (send_email binding).
// No third-party form service: the visitor's data goes only through Cloudflare.
import { EmailMessage } from 'cloudflare:email';
import type { Env } from './index';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_FILL_MS = 3000; // humans take longer than this to fill in the form

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' },
  });

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
// RFC 2047 encoded-word for non-ASCII header values (names, subject)
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
// Strip anything that could inject extra e-mail headers
const oneLine = (s: string, max: number) => s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export async function handleContact(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // Only accept submissions from our own pages (blocks cross-site form spam)
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Bad origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return json({ error: 'JSON expected' }, 415);
  if (Number(request.headers.get('Content-Length') || 0) > 20_000) return json({ error: 'Message too long' }, 413);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');

  // Bots: honeypot filled or submitted implausibly fast. Pretend success so they learn nothing.
  const elapsed = Number(body.elapsed);
  if (str('botcheck') || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return json({ ok: true });

  const name = oneLine(str('name'), 120);
  const email = oneLine(str('email'), 200);
  const message = str('message').replace(/\r\n/g, '\n').trim().slice(0, 5000);
  const lang = str('lang') === 'ro' ? 'ro' : 'en';
  if (!name || !EMAIL_RE.test(email) || message.length < 10) return json({ error: 'invalid' }, 400);

  if (!env.CONTACT_EMAIL) return json({ error: 'Contact form is not configured' }, 503);

  const from = env.CONTACT_FROM || 'formular@geoli.eu';
  const to = env.CONTACT_TO || 'george.lincu@gmail.com';
  const subject = `Mesaj nou de pe geoli.eu de la ${name}`;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const country = (request as Request & { cf?: { country?: string } }).cf?.country || '';
  const text = [
    `Nume / Name: ${name}`,
    `E-mail: ${email}`,
    `Limba / Language: ${lang}`,
    `Trimis / Sent: ${new Date().toISOString()}${country ? ` (${country})` : ''}`,
    '',
    message,
    '',
    '—',
    'Răspunde direct la acest e-mail ca să-i scrii persoanei. / Reply to this e-mail to answer.',
    `IP: ${ip}`,
  ].join('\n');

  const domain = from.split('@')[1] || 'geoli.eu';
  const raw = [
    `From: ${header('Formular geoli.eu')} <${from}>`,
    `To: <${to}>`,
    `Reply-To: ${header(name)} <${email}>`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/.{1,76}/g, '$&\r\n'),
  ].join('\r\n');

  try {
    await env.CONTACT_EMAIL.send(new EmailMessage(from, to, raw));
  } catch (err) {
    console.error('contact form send failed', err);
    return json({ error: 'send failed' }, 502);
  }
  return json({ ok: true });
}
