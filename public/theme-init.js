// Runs before first paint (render-blocking on purpose) to avoid a flash of the wrong theme.
try {
  var t = localStorage.getItem('geoli-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
