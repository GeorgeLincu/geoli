// Shared response helpers for the Worker.

export const baseHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
export const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function respond(body: BodyInit | null, init: ResponseInit & { csp?: string } = {}) {
  const headers = new Headers({ ...baseHeaders, ...(init.headers as Record<string, string>) });
  if (init.csp) headers.set('Content-Security-Policy', init.csp);
  return new Response(body, { ...init, headers });
}
export const json = (data: unknown, status = 200) =>
  respond(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
export const error = (status: number, message: string) => json({ error: message }, status);
export const html = (body: string, status = 200) =>
  respond(body, { status, csp: APP_CSP, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

