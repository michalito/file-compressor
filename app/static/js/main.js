/**
 * Compressify — Entry point.
 * ES module, page-context routing.
 */
import { initTheme } from './components/theme.js';
import { initFooter } from './components/footer.js';

// Initialize on every page
initTheme();
initFooter();

// Page-context routing
const appLayout = document.querySelector('.app-layout');
const loginForm = document.getElementById('login-form');

if (appLayout) {
  // Main application page
  const { initApp } = await import('./features/upload.js');
  const { initSettings } = await import('./features/settings.js');
  const { initBatch } = await import('./features/batch.js');
  const { initCrop } = await import('./features/crop.js');

  initSettings();
  initApp();
  initBatch();
  initCrop();
} else if (loginForm) {
  // Login page
  const { initLogin } = await import('./features/login.js');
  initLogin();
}
