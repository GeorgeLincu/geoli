import { CONFIG }         from './config.js';
import { initLang }       from './i18n.js';
import { initNav }        from './nav.js';
import { initAnimations } from './animations.js';

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

initNav();
initAnimations();
populateContacts();
initLang();
