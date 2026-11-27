// Keyboard shortcut: press "g" then "i" (within 1.5 s) on any page → /vault/invest/.
// Nothing visible on the page; the destination is still protected by Cloudflare Access + the owner check.
const WINDOW_MS = 1500;
const TARGET = '/vault/invest/';

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);

export function initShortcut() {
  let gAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'g') { gAt = Date.now(); return; }
    if (k === 'i' && gAt && Date.now() - gAt <= WINDOW_MS) {
      gAt = 0;
      window.location.assign(TARGET);
      return;
    }
    gAt = 0;
  });
}
