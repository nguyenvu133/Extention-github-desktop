'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '' };

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '') || DEFAULTS.bridgeUrl;
}

// Same root-vs-extension/ logic as background.js: popup.html lives
// beside dashboard.html, so the dashboard path follows the folder
// popup.html itself was loaded from. Falls back to dashboard.html
// when the page URL is unavailable (e.g. in the Node test harness).
function dashboardUrl() {
  try {
    const href = (typeof location !== 'undefined' && location.href) || '';
    const path = href.split('?')[0].split('#')[0];
    const dir = path.replace(/[^/]*$/, '').replace(/^(?:[a-z-]+:\/\/[^/]+\/)?/, '');
    return chrome.runtime.getURL(dir + 'dashboard.html');
  } catch (_) {
    return chrome.runtime.getURL('dashboard.html');
  }
}

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {
    bridgeUrl: normalizeBase(s.bridgeUrl),
    token: String(s.token || '').trim(),
  };
}

async function api(path, method = 'GET', body) {
  const s = await settings();
  if (!s.token) throw new Error('No bridge token saved');
  const res = await fetch(s.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function setLamp(state) {
  $('lamp').className = 'lamp ' + state;
}

async function refresh() {
  const s = await settings();
  $('token').value = s.token;

  try {
    const res = await fetch(s.bridgeUrl + '/health');
    if (!res.ok) throw new Error('offline');
    const health = await res.json();

    setLamp('ok');
    $('connection').textContent = 'CONNECTED';
    $('message').textContent = 'Bridge v' + (health.version || '?');

    const repo = health.repository;
    $('repoName').textContent = repo ? repo.name : 'No repository selected';
    $('branchName').textContent = repo && repo.branch ? repo.branch : '—';
    $('repoPath').textContent = repo ? repo.path : 'Open Workspace to select a repository';

    // /health is public, so the token has to be verified separately.
    if (!s.token) {
      setLamp('warn');
      $('message').textContent = 'Add bridge token';
      return;
    }
    try {
      await api('/api/repo/current');
      $('message').textContent = 'Token accepted';
    } catch (err) {
      setLamp('warn');
      $('message').textContent = 'Token rejected';
    }
  } catch (_) {
    setLamp('off');
    $('connection').textContent = 'DISCONNECTED';
    $('message').textContent = 'Start the local bridge';
  }
}

$('refresh').onclick = refresh;

$('saveToken').onclick = async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ token });
  await refresh();
};

$('open').onclick = () => {
  chrome.tabs.create({ url: dashboardUrl() });
  window.close();
};

document.querySelectorAll('[data-action]').forEach((button) => {
  button.onclick = async () => {
    const action = button.dataset.action;
    const method = action === 'status' ? 'GET' : 'POST';
    try {
      const data = await api('/api/git/' + action, method, method === 'POST' ? {} : undefined);
      if (action === 'status') {
        const count = (data.files || []).length;
        $('message').textContent = count + ' changed file(s)';
      } else {
        $('message').textContent = button.textContent + ' ✓';
      }
      await refresh();
    } catch (err) {
      $('message').textContent = err.message;
    }
  };
});

$('version').textContent = 'v' + chrome.runtime.getManifest().version;
refresh();
