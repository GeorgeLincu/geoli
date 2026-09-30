const KEY = 'geoli-theme';

// Theme = explicit choice (localStorage) or the OS preference. theme-init.js applies it before paint.
export function initTheme() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const root = document.documentElement;
  const system = () => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const current = () => root.dataset.theme ?? system();

  const sync = () => btn.setAttribute('aria-pressed', String(current() === 'light'));
  sync();

  btn.addEventListener('click', () => {
    const next = current() === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch {}
    sync();
  });
}
