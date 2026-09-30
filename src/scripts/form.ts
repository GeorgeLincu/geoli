const ENDPOINT    = 'https://api.web3forms.com/submit';
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_FILL_MS = 3000; // humans take longer than this to fill the form

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

    const data = new FormData(form);

    // Bots: honeypot ticked or submitted implausibly fast — pretend success
    if (data.get('botcheck') || Date.now() - loadedAt < MIN_FILL_MS) {
      form.reset();
      showStatus('success', msg.msgSuccess);
      return;
    }

    const name    = String(data.get('name')    || '').trim();
    const email   = String(data.get('email')   || '').trim();
    const message = String(data.get('message') || '').trim();
    if (!name || !EMAIL_RE.test(email) || message.length < 10) {
      showStatus('error', msg.msgInvalid);
      return;
    }

    // Form not configured yet — fall back to the visitor's mail client
    if (msg.configured !== 'true') {
      const subject = encodeURIComponent(`Message from ${name} via ${msg.domain}`);
      const body    = encodeURIComponent(`${message}\n\n— ${name} <${email}>`);
      window.location.href = `mailto:${msg.email}?subject=${subject}&body=${body}`;
      return;
    }

    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = msg.msgSending;

    try {
      const res  = await fetch(ENDPOINT, { method: 'POST', headers: { Accept: 'application/json' }, body: data });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message);
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
