export function initNav() {
  const nav      = document.getElementById('nav');
  const burger   = document.getElementById('burger');
  const navLinks = document.getElementById('navLinks');
  if (!nav || !burger || !navLinks) return;

  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const close = () => {
    navLinks.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
  };

  burger.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
  });

  navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', close));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && navLinks.classList.contains('open')) {
      close();
      burger.focus();
    }
  });
}
