'use strict';

const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '' };

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({
    bridgeUrl: current.bridgeUrl || DEFAULTS.bridgeUrl,
    token: current.token || '',
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'OPEN_DASHBOARD') return false;
  chrome.tabs
    .create({ url: chrome.runtime.getURL('dashboard.html') })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});
