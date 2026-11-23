'use strict';

/*
 * Proves the extension opens its dashboard no matter which folder
 * Chrome was pointed at in Load unpacked:
 *   - repo root (root manifest.json, code under extension/)
 *   - extension/ (its own manifest.json)
 * It runs the real background.js / popup.js in a vm with a chrome.*
 * shim and checks the URL passed to chrome.tabs.create.
 *
 * Usage: node tests/load-from-root-test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', 'extension');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + detail}`);
  if (!ok) failures += 1;
}

function makeChrome() {
  const listeners = { installed: [], message: [] };
  let lastTabUrl = null;
  return {
    listeners,
    lastTabUrl: () => lastTabUrl,
    chrome: {
      storage: { local: { async get(d) { return { ...d }; }, async set() {} } },
      runtime: {
        getManifest: () => ({ version: '1.0.2' }),
        getURL: (p) => 'chrome-extension://test/' + p,
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
      },
      tabs: { create: async ({ url }) => { lastTabUrl = url; return {}; } },
    },
  };
}

/* --- background.js: service worker location decides the prefix --- */
for (const [label, pathname, expected] of [
  ['root load (/extension/background.js)', '/extension/background.js', 'chrome-extension://test/extension/dashboard.html'],
  ['extension/ load (/background.js)', '/background.js', 'chrome-extension://test/dashboard.html'],
]) {
  const ctx = makeChrome();
  const sandbox = {
    chrome: ctx.chrome,
    console,
    self: { location: { pathname } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  const onMessage = ctx.listeners.message[0];
  let response = null;
  onMessage({ type: 'OPEN_DASHBOARD' }, {}, (r) => { response = r; });
  // tabs.create is async; wait a tick.
  setTimeout(() => {
    check(`background.js ${label} opens dashboard`, ctx.lastTabUrl() === expected, String(ctx.lastTabUrl()));
    check(`background.js ${label} answers ok`, response && response.ok === true, JSON.stringify(response));
  }, 50);
}

/* --- popup.js: popup.html location decides the prefix --- */
function runPopup(href) {
  const ctx = makeChrome();
  const els = new Map();
  const el = () => ({ className: '', textContent: '', value: '', dataset: {}, onclick: null });
  const document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelectorAll: () => [],
  };
  const sandbox = {
    document,
    chrome: ctx.chrome,
    console,
    fetch: async () => ({ ok: true, json: async () => ({ version: '1.0.2', repository: null }) }),
    location: { href },
    window: { close() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8'), sandbox, { filename: 'popup.js' });
  return { ctx, els };
}

setTimeout(() => {
  for (const [label, href, expected] of [
    ['root load (popup at extension/popup.html)', 'chrome-extension://test/extension/popup.html', 'chrome-extension://test/extension/dashboard.html'],
    ['extension/ load (popup at popup.html)', 'chrome-extension://test/popup.html', 'chrome-extension://test/dashboard.html'],
    ['no location (test harness fallback)', '', 'chrome-extension://test/dashboard.html'],
  ]) {
    const { ctx, els } = runPopup(href);
    els.get('open').onclick();
    check(`popup.js ${label} opens dashboard`, ctx.lastTabUrl() === expected, String(ctx.lastTabUrl()));
  }
  if (failures > 0) {
    console.error(`\nload-from-root-test: ${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log('\nload-from-root-test: all checks passed\n');
}, 200);
