import { CONFIG } from './config.js';

export function initForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  const submitBtn = form.querySelector('[data-form="submit"]');
  const status    = document.getElementById('formStatus');

  form.querySelector('[name="access_key"]').value = CONFIG.web3formsKey;

  form.addEventListener('submit', async e => {
    e.preventDefault();

    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = '...';
    status.hidden = true;

    try {
      const res  = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body:   new FormData(form),
      });
      const data = await res.json();

      if (data.success) {
        form.reset();
        showStatus('success', form.dataset.msgSuccess);
      } else {
        throw new Error(data.message);
      }
    } catch {
      showStatus('error', form.dataset.msgError);
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
