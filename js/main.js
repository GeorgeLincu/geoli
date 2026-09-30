import { CONFIG }         from './config.js';
import { initLang }       from './i18n.js';
import { initNav }        from './nav.js';
import { initAnimations } from './animations.js';
import { initForm }       from './form.js';

function populateContacts() {
  document.querySelectorAll('[data-contact="email"]').forEach(el => {
    if (el.tagName === 'A') el.href = `mailto:${CONFIG.email}`;
  });
  document.querySelectorAll('[data-contact="email-label"]').forEach(el => {
    el.textContent = CONFIG.email;
  });
  document.querySelectorAll('[data-contact="linkedin"]').forEach(el => {
    if (el.tagName === 'A') el.href = CONFIG.linkedin;
  });
  document.querySelectorAll('[data-contact="footer-copy"]').forEach(el => {
    el.textContent = `© ${CONFIG.year} ${CONFIG.name} · ${CONFIG.domain}`;
  });
}

// CV buttons stay hidden until the PDF actually exists on the server
async function revealCv() {
  if (!CONFIG.cvPath) return;
  try {
    const res = await fetch(CONFIG.cvPath, { method: 'HEAD' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('pdf')) return;
  } catch { return; }

  document.querySelectorAll('[data-contact="cv"]').forEach(el => {
    if (el.tagName === 'A') el.href = CONFIG.cvPath;
    el.hidden = false;
  });
}

initNav();
initAnimations();
populateContacts();
initForm();
initLang();
revealCv();
