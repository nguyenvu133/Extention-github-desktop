'use strict';

/*
 * PixiJS GitHub Desktop Sync — background service worker (MV3) v2.0.0
 *
 * The service worker is intentionally thin: it only opens the dashboard
 * and seeds extension settings on install. All GitHub / bridge traffic
 * happens from popup.html and dashboard.html, which own their own
 * reconnect loops (health polling + Server-Sent Events).
 *
 * The extension can be loaded from the repo root (manifest.json at the
 * root, code under extension/) or from extension/ itself (its own
 * manifest.json). chrome.runtime.getURL() is always relative to the
 * loaded root, so work out dashboard.html's path from where this
 * service worker itself lives: /extension/background.js -> the
 * dashboard is at extension/dashboard.html, /background.js -> it is
 * at dashboard.html. Falls back to dashboard.html when the location
 * is unavailable (e.g. in the Node test harness).
 */

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:17321',
  token: '',
  autoUpdateEnabled: false,
  autoUpdateInterval: 60,
  lastRepo: '',
};

function dashboardUrl() {
  try {
    const pathname = (typeof self !== 'undefined' && self.location && self.location.pathname) || '';
    const dir = pathname.replace(/[^/]*$/, '').replace(/^\//, '');
    return chrome.runtime.getURL(dir + 'dashboard.html');
  } catch (_) {
    return chrome.runtime.getURL('dashboard.html');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    next[key] = current[key] === undefined ? DEFAULTS[key] : current[key];
  }
  await chrome.storage.local.set(next);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'OPEN_DASHBOARD') return false;
  chrome.tabs
    .create({ url: dashboardUrl() })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});
