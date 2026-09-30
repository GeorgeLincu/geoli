import { CONFIG } from './config.js';
import { t }      from './i18n.js';

const ENDPOINT     = 'https://api.web3forms.com/submit';
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_FILL_MS  = 3000; // humans take longer than this to fill the form

export function initForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  const submitBtn = form.querySelector('[data-form="submit"]');
  const status    = document.getElementById('formStatus');
  const hasKey    = /^[0-9a-f-]{36}$/i.test(CONFIG.web3formsKey);
  const loadedAt  = Date.now();

  form.querySelector('[name="access_key"]').value = hasKey ? CONFIG.web3formsKey : '';

  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.hidden = true;

    const data = new FormData(form);

    // Bots: honeypot ticked or submitted implausibly fast — pretend success
    if (data.get('botcheck') || Date.now() - loadedAt < MIN_FILL_MS) {
      form.reset();
      showStatus('success', t('form.success'));
      return;
    }

    const name    = String(data.get('name')    || '').trim();
    const email   = String(data.get('email')   || '').trim();
    const message = String(data.get('message') || '').trim();
    if (!name || !EMAIL_RE.test(email) || message.length < 10) {
      showStatus('error', t('form.invalid'));
      return;
    }

    // Form not configured yet — fall back to the visitor's mail client
    if (!hasKey) {
      const subject = encodeURIComponent(`Message from ${name} via ${CONFIG.domain}`);
      const body    = encodeURIComponent(`${message}\n\n— ${name} <${email}>`);
      window.location.href = `mailto:${CONFIG.email}?subject=${subject}&body=${body}`;
      return;
    }

    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = t('form.sending');

    try {
      const res  = await fetch(ENDPOINT, {
        method:  'POST',
        headers: { Accept: 'application/json' },
        body:    data,
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message);

      form.reset();
      showStatus('success', t('form.success'));
    } catch {
      showStatus('error', t('form.error'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  function showStatus(type, msg) {
    status.className = `form__status form__status--${type}`;
    status.textContent = msg;
    status.hidden = false;
  }
}
