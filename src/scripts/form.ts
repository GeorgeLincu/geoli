// Contact form → POST /api/contact (our Worker e-mails it via Cloudflare Email Routing)
const ENDPOINT = '/api/contact';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function initForm() {
  const form = document.getElementById('contactForm') as HTMLFormElement | null;
  if (!form) return;

  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const status    = document.getElementById('formStatus')!;
  const msg       = form.dataset as Record<string, string>;
  const loadedAt  = Date.now();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.hidden = true;

    const data    = new FormData(form);
    const name    = String(data.get('name')    || '').trim();
    const email   = String(data.get('email')   || '').trim();
    const message = String(data.get('message') || '').trim();
    if (!name || !EMAIL_RE.test(email) || message.length < 10) {
      showStatus('error', msg.msgInvalid);
      return;
    }

    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = msg.msgSending;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name, email, message,
          lang: document.documentElement.lang,
          botcheck: data.get('botcheck') ? 'on' : '',
          elapsed: Date.now() - loadedAt,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 400) { showStatus('error', msg.msgInvalid); return; }
      if (!res.ok || !json.ok) throw new Error(json.error || res.statusText);
      form.reset();
      showStatus('success', msg.msgSuccess);
    } catch {
      showStatus('error', msg.msgError);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  function showStatus(type: 'success' | 'error', text: string) {
    status.className = `form__status form__status--${type}`;
    status.textContent = text;
    status.hidden = false;
  }
}
