// The sandbox shares only this presentation preference with the live app.
// Run before styles paint; no app storage or identity modules are imported.
(() => {
  let theme = 'light';
  try {
    if (localStorage.getItem('av-theme') === 'dark') theme = 'dark';
  } catch { /* Storage blocked: keep an in-memory light default. */ }
  document.documentElement.dataset.theme = theme;
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('demo-theme-toggle');
    function syncButton() {
      const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    syncButton();
    button.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('av-theme', theme); } catch { /* Best effort. */ }
      syncButton();
    });
  });
})();
