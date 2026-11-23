'use strict';

/*
 * PixiJS GitHub Desktop Sync — popup v2.1.0
 *
 * Shows, at a glance: bridge connection state (with reconnect), the
 * signed-in GitHub account (with its sign-in method), the connected
 * local repository with its ahead/behind badge, quick Git actions
 * (status / fetch / pull / push / sync) and the auto-update switch.
 * The popup re-checks the bridge on open, on demand (reconnect button)
 * and every 10 s while it stays open, so it recovers on its own when
 * the bridge comes back.
 *
 * Security note: the GitHub Personal Access Token is NEVER stored in
 * the extension. It lives in bridge/.github-config.json on the user's
 * machine; the popup only ever sees the public profile (login, name,
 * avatar, sign-in method) through /api/github/user.
 */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '', autoUpdateEnabled: false, autoUpdateInterval: 60 };

let bridgeState = 'checking'; // 'connected' | 'reconnecting' | 'disconnected'
let pollTimer = null;

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
    autoUpdateEnabled: !!s.autoUpdateEnabled,
    autoUpdateInterval: Number(s.autoUpdateInterval) || 60,
  };
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

async function api(path, method = 'GET', body) {
  const s = await settings();
  if (!s.token) throw new Error('No bridge token saved');
  return fetchJson(s.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function setLamp(state) {
  $('lamp').className = 'lamp ' + state;
}

function setBridgeState(state, detail) {
  bridgeState = state;
  if (state === 'connected') {
    setLamp('ok');
    $('connection').textContent = 'CONNECTED';
  } else if (state === 'reconnecting') {
    setLamp('warn');
    $('connection').textContent = 'RECONNECTING…';
  } else {
    setLamp('off');
    $('connection').textContent = 'DISCONNECTED';
  }
  if (detail !== undefined) $('bridgeDetail').textContent = detail;
}

function authMethodLabel(method) {
  if (method === 'oauth-web') return 'OAuth Web';
  if (method === 'pat') return 'PAT';
  if (method === 'device') return 'Device Flow';
  return method ? String(method) : '';
}

function showGithub(user) {
  if (user && user.login) {
    $('githubSignedOut').classList.add('hidden');
    $('githubSignedIn').classList.remove('hidden');
    $('ghAvatar').src = user.avatar_url || '';
    $('ghAvatar').alt = user.login;
    $('ghLogin').textContent = user.login;
    const method = authMethodLabel(user.authMethod);
    $('ghAuthMethod').textContent =
      (method ? 'via ' + method : '') + (user.scopes ? ' · ' + user.scopes : '');
    $('ghName').textContent = user.name || (user.public_repos != null ? user.public_repos + ' public repos' : 'GitHub');
  } else {
    $('githubSignedOut').classList.remove('hidden');
    $('githubSignedIn').classList.add('hidden');
    $('ghAvatar').src = '';
    $('ghLogin').textContent = '—';
    $('ghAuthMethod').textContent = '';
    $('ghName').textContent = '—';
  }
}

// v2.1 ahead/behind badge for the local repo. Silent when there is no
// repo or no upstream — the popup must never fail its refresh over it.
async function showAheadBehind() {
  const badge = $('aheadBehindBadge');
  try {
    const data = await api('/api/git/ahead-behind');
    if (!data.hasUpstream) {
      badge.textContent = 'No upstream';
      badge.classList.remove('hidden');
    } else {
      badge.textContent = `↑${Number(data.ahead) || 0} ↓${Number(data.behind) || 0}`;
      badge.title = `ahead ${Number(data.ahead) || 0}, behind ${Number(data.behind) || 0}${data.upstream ? ' ' + data.upstream : ''}`;
      badge.classList.remove('hidden');
    }
  } catch (_) {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

function showAutoUpdate(status) {
  const box = $('autoUpdateState');
  if (!status) { box.textContent = '—'; return; }
  if (!status.enabled) { box.textContent = 'Off'; return; }
  const last = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
  box.textContent = `On · every ${status.intervalSeconds}s · last check ${last}` +
    (status.updatesFound ? ` · ${status.updatesFound} update(s) found` : '');
}

async function refresh() {
  const s = await settings();
  $('token').value = s.token;
  $('autoUpdateToggle').checked = s.autoUpdateEnabled;

  try {
    const health = await fetchJson(s.bridgeUrl + '/health');
    setBridgeState('connected', 'Bridge v' + (health.version || '?'));

    const repo = health.repository;
    $('repoName').textContent = repo ? repo.name : 'No repository selected';
    $('branchName').textContent = repo && repo.branch ? repo.branch : '—';
    $('repoPath').textContent = repo ? repo.path : 'Open Workspace to select a repository';

    // /health is public, so the token has to be verified separately.
    if (!s.token) {
      setLamp('warn');
      $('message').textContent = 'Add bridge token';
      showGithub(null);
      return;
    }
    try {
      await api('/api/repo/current');
      $('message').textContent = 'Token accepted';
    } catch (err) {
      setLamp('warn');
      $('message').textContent = 'Token rejected — paste the current bridge token';
      showGithub(null);
      return;
    }

    // GitHub sign-in state + auto-update state (both read-only here).
    // v2.1: /user reports the sign-in method + scopes; fall back to /me
    // when talking to an older bridge.
    try {
      let me;
      try {
        me = await api('/api/github/user');
      } catch (_) {
        me = await api('/api/github/me');
      }
      if (me.authed && me.user) {
        if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
        if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
      }
      showGithub(me.authed ? me.user : null);
    } catch (_) {
      showGithub(null);
    }
    try {
      const au = await api('/api/github/auto-update');
      showAutoUpdate(au);
    } catch (_) {
      showAutoUpdate(null);
    }
    await showAheadBehind();
  } catch (_) {
    setBridgeState('disconnected', 'Start the local bridge: node bridge/bridge-server.js');
    $('message').textContent = 'Start the local bridge';
    $('repoName').textContent = 'No repository selected';
    $('branchName').textContent = '—';
    $('repoPath').textContent = 'Open Workspace to select a repository';
    showGithub(null);
  }
}

async function reconnect() {
  setBridgeState('reconnecting', 'Trying ' + (await settings()).bridgeUrl + ' …');
  $('message').textContent = 'Reconnecting…';
  await refresh();
}

$('reconnect').onclick = reconnect;
$('refresh') && ($('refresh').onclick = refresh);

$('saveToken').onclick = async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ token });
  await refresh();
};

$('logout').onclick = async () => {
  try {
    await api('/api/github/logout', 'POST', {});
    showGithub(null);
    $('message').textContent = 'Signed out of GitHub';
  } catch (err) {
    $('message').textContent = err.message;
  }
};

$('autoUpdateToggle').onchange = async () => {
  const enabled = $('autoUpdateToggle').checked;
  try {
    const s = await settings();
    await chrome.storage.local.set({ autoUpdateEnabled: enabled });
    const status = await api('/api/github/auto-update', 'POST', { enabled, intervalSeconds: s.autoUpdateInterval });
    showAutoUpdate(status);
    $('message').textContent = enabled ? 'Auto-update ON' : 'Auto-update OFF';
  } catch (err) {
    $('autoUpdateToggle').checked = !enabled;
    $('message').textContent = err.message;
  }
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
pollTimer = setInterval(() => { refresh(); }, 10000);
