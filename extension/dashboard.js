'use strict';

/*
 * PixiJS GitHub Desktop Sync — dashboard v3.0.1
 *
 * A GitHub-like workspace in the browser:
 *   - Repositories tab: ALL GitHub repositories (search / filter / sort),
 *     repo detail (README, file tree + viewer/editor, commits, branches,
 *     issues, pull requests, releases), code search, notifications,
 *     profile, create/fork/star/delete repos, download .zip.
 *   - Local Git tab: the v1 local-git client (status, stage, commit,
 *     branches, history, diff, fetch/pull/push) plus v2.1 push/pull/sync
 *     with ahead/behind, branch management, merge-conflict resolution,
 *     stash, remotes and clone — and v3.0 cherry-pick / revert / reset,
 *     tags, and local .zip export.
 *   - Sign-in: a 3-step Vietnamese wizard — OAuth Web Flow (Connect
 *     GitHub) first, Device Flow, then PAT. NO password field anywhere:
 *     GitHub stopped accepting passwords for third-party apps in 2020,
 *     so the extension never asks for one. A login-diagnostics panel
 *     (GET /api/github/login/diagnostics) pinpoints the failing step
 *     instead of a generic error.
 *
 * CONNECTION MODEL (this is what v1 got wrong — "Bridge disconnected"
 * used to stick forever):
 *   - health() polls GET /health every 10 s;
 *   - an EventSource stream (GET /api/events) pushes live updates;
 *   - on ANY failure the state machine goes to "reconnecting" and
 *     retries with backoff (1s, 2s, 5s, 10s, 30s cap) until the bridge
 *     answers again — the user never has to click anything.
 * States: 'connected' (green) / 'reconnecting' (yellow) / 'disconnected' (red).
 *
 * SECURITY: the GitHub PAT lives in bridge/.github-config.json. The
 * dashboard only ever sees the public profile through /api/github/me.
 */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '', autoUpdateEnabled: false, autoUpdateInterval: 60, lastRepo: '', settingsDefaultBranch: '', settingsNotifications: true };

let bridgeState = 'disconnected'; // 'connected' | 'reconnecting' | 'disconnected'
let healthTimer = null;
let sseSource = null;
let sseBackoffMs = 1000;
let sseBackoffTimer = null;
let healthFailures = 0;

let ghUser = null; // public profile from /api/github/user, or null
let allRepos = []; // full repo list from /api/github/repos/all
let reposLoadedAt = null;
let currentRepo = null; // { owner, repo, full_name, default_branch }
let currentPath = ''; // path inside the file tree
let selectedFile = '';
let selectedFileSha = ''; // blob sha of the file open in the viewer (for edits)
let localConnected = false;
let updateBadgeCount = 0;
let historyPage = 1; // v2.1 paginated local history
let historyHasNext = false;
let oauthConfigured = false; // v2.1 OAuth Web Flow ready?
let oauthPollTimer = null;
let deviceCountdownTimer = null; // v3.0 Device Flow countdown
let deviceDeadline = 0;
let currentIssueNumber = null; // issue open in the detail pane
let notifUnreadCount = 0; // v3.0 notification badge
let settingsDefaultBranch = ''; // v3.0 from storage
let settingsNotifications = true; // v3.0 from storage

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '') || DEFAULTS.bridgeUrl;
}

async function cfg() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {
    bridgeUrl: normalizeBase(s.bridgeUrl),
    token: String(s.token || '').trim(),
    autoUpdateEnabled: !!s.autoUpdateEnabled,
    autoUpdateInterval: Number(s.autoUpdateInterval) || 60,
    lastRepo: String(s.lastRepo || ''),
    settingsDefaultBranch: String(s.settingsDefaultBranch || '').trim(),
    settingsNotifications: s.settingsNotifications !== false,
  };
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  $('log').textContent = time + ' · ' + message;
}

function esc(s) {
  return String(s == null ? '' : s);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  if (sec < 86400 * 30) return Math.floor(sec / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function formatNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

// v3.0 — client-side PAT shape check, BEFORE anything is sent to the
// bridge. GitHub tokens always start with one of these prefixes and are
// at least 20 characters long. An email (contains @) or a plain password
// never matches, so pasting one shows a clear warning instead of a
// generic "invalid token" error from the API.
function looksLikeGithubToken(value) {
  const v = String(value || '').trim();
  if (v.length < 20) return false;
  return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+$/.test(v);
}

const TOKEN_FORMAT_HINT = 'Đây không phải token — token bắt đầu bằng ghp_… (classic) hoặc github_pat_… (fine-grained). GitHub không cho app khác nhập mật khẩu — mật khẩu chỉ nhập trên trang github.com.';

/* ------------------------------------------------------------------ */
/* Bridge API                                                          */
/* ------------------------------------------------------------------ */

async function fetchJson(url, options) {
  // v3.0.1: bridgeFetch (extension/bridge-client.js) translates every
  // network failure into a Vietnamese BRIDGE_UNREACHABLE error — the
  // raw browser "Failed to fetch" never reaches the user.
  const res = await bridgeFetch(url, options);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

async function api(path, method = 'GET', body) {
  const c = await cfg();
  if (!c.token) throw new Error('Missing bridge token. Start the bridge and paste its token.');
  return fetchJson(c.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// GitHub calls all go through the bridge (the PAT never leaves it).
async function gh(path, method = 'GET', body) {
  return api('/api/github' + path, method, body);
}

// v3.0 — download a binary response (repo .zip, release asset, local
// archive) through the bridge with the bearer token, then trigger a
// browser download. Throws a readable error when the bridge answers
// with JSON instead of a file (e.g. 404 on an older bridge).
async function downloadBlob(path, method = 'GET', body, filename) {
  const c = await cfg();
  if (!c.token) throw new Error('Missing bridge token. Start the bridge and paste its token.');
  const res = await bridgeFetch(c.bridgeUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try {
      const data = await res.json();
      if (data && data.error) detail = data.error;
    } catch (_) { /* non-JSON error body — keep the status */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.zip';
    if (typeof a.click === 'function') a.click();
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
  }
  return { filename: filename || 'download.zip', size: blob.size };
}

/* ------------------------------------------------------------------ */
/* Connection state machine: health poll + SSE, auto-reconnect         */
/* ------------------------------------------------------------------ */

function setBridgeState(state, detail) {
  bridgeState = state;
  const lamp = $('lamp');
  lamp.className = state === 'connected' ? 'ok' : state === 'reconnecting' ? 'reconnecting' : 'off';
  $('bridgeStatus').textContent =
    state === 'connected' ? 'BRIDGE CONNECTED' :
    state === 'reconnecting' ? 'RECONNECTING…' : 'BRIDGE DISCONNECTED';
  if (detail !== undefined) log(detail);
}

async function health() {
  const c = await cfg();
  try {
    const res = await bridgeFetch(c.bridgeUrl + '/health', undefined, 8000);
    if (!res.ok) throw new Error('offline');
    const data = await res.json();
    healthFailures = 0;

    const wasDown = bridgeState !== 'connected';
    setBridgeState('connected');
    setLoginEnabled(true);
    updateRateLimit(data.github && data.github.rateLimit);

    const repo = data.repository;
    if (repo) {
      $('repoName').textContent = repo.name;
      $('branch').textContent = repo.branch || '—';
      $('remote').textContent = repo.remote || 'No remote';
      if (!$('repoPath').value.trim()) $('repoPath').value = repo.path;
      localConnected = true;
    } else {
      $('repoName').textContent = 'Not connected';
      $('branch').textContent = '—';
      $('remote').textContent = '—';
      localConnected = false;
    }
    if (data.github) {
      if (data.github.authed) {
        ghUser = ghUser || { login: data.github.login, avatar_url: data.github.avatar_url };
        showUser(ghUser);
      }
    }
    if (data.autoUpdate) showAutoUpdate(data.autoUpdate);
    if (wasDown) {
      log('Bridge is back. Reconnected.');
      startEventStream();
      await refreshGithubState().catch((err) => log('ERROR: ' + err.message));
    }
    return true;
  } catch (err) {
    healthFailures += 1;
    // First failure while connected -> reconnecting (retries keep running).
    // Failure at boot -> disconnected (nothing ever worked yet).
    // v3.0.1: login buttons are disabled while the bridge is down, so
    // the user cannot click sign-in into a raw "Failed to fetch".
    setLoginEnabled(false);
    if (bridgeState === 'connected' || healthFailures > 1) {
      setBridgeState('reconnecting', `Bridge không kết nối được (lần thử ${healthFailures}). Đang thử lại…`);
    } else {
      setBridgeState('disconnected', BRIDGE_START_SHORT);
    }
    localConnected = false;
    stopEventStream();
    return false;
  }
}

function startHealthPoll() {
  if (healthTimer) return;
  healthTimer = setInterval(() => { health(); }, 10000);
}

function startEventStream() {
  if (typeof EventSource === 'undefined') return; // Node test harness without EventSource
  cfg().then((c) => {
    if (!c.token) return;
    if (sseSource) return;
    const url = c.bridgeUrl + '/api/events?token=' + encodeURIComponent(c.token);
    let source;
    try {
      source = new EventSource(url);
    } catch (err) {
      scheduleSseReconnect();
      return;
    }
    sseSource = source;
    source.onopen = () => {
      sseBackoffMs = 1000;
      log('Live updates connected (SSE).');
    };
    source.addEventListener('auto-update', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.updated && payload.updated.length) {
        updateBadgeCount += payload.updated.length;
        showUpdateBadge();
        log(`Auto-update: ${payload.updated.length} repo(s) have new commits — ${payload.updated.map((u) => u.repo + '@' + u.newSha).join(', ')}`);
        if (!$('view-repos').classList.contains('hidden')) loadRepos(false).catch(() => {});
      }
      if (payload.at) showAutoUpdate({ lastRunAt: payload.at });
    });
    source.addEventListener('repo-updated', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      updateBadgeCount += 1;
      showUpdateBadge();
      log(`New commit in ${payload.repo || '?'} (${payload.newSha || ''})`);
    });
    source.addEventListener('github-auth', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.authed === false) {
        ghUser = null;
        showUser(null);
      } else if (payload.authed === true) {
        // OAuth Web Flow (or another sign-in) completed on the bridge.
        stopOAuthPolling();
        refreshGithubState().catch((err) => log('ERROR: ' + err.message));
      }
    });
    source.addEventListener('auto-sync', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      if (payload.skipped) {
        log(`Auto-sync skipped for ${payload.repo || '?'}: ${payload.reason || 'no reason given'}`);
      } else {
        log(`Auto-sync pulled ${payload.commitsPulled || 0} commit(s) into ${payload.repo || '?'}@${payload.branch || ''}` +
          (payload.changedFiles && payload.changedFiles.length ? ` — ${payload.changedFiles.join(', ')}` : ''));
        if (localConnected) refreshAllLocal().catch(() => {});
      }
      if (payload.at) showAutoUpdate({ lastAutoSync: payload });
    });
    source.addEventListener('rate-limit', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch (_) {}
      updateRateLimit(payload);
      log(`GitHub rate limit low: ${payload.remaining} requests remaining.`);
    });
    source.onerror = () => {
      stopEventStream();
      if (bridgeState === 'connected') setBridgeState('reconnecting', 'Live updates dropped. Reconnecting…');
      scheduleSseReconnect();
    };
  }).catch(() => {});
}

function scheduleSseReconnect() {
  if (sseBackoffTimer) return;
  const delay = sseBackoffMs;
  sseBackoffMs = Math.min(30000, sseBackoffMs * 2);
  sseBackoffTimer = setTimeout(() => {
    sseBackoffTimer = null;
    if (bridgeState !== 'disconnected') startEventStream();
  }, delay);
}

function stopEventStream() {
  if (sseBackoffTimer) { clearTimeout(sseBackoffTimer); sseBackoffTimer = null; }
  if (sseSource) { try { sseSource.close(); } catch (_) {} sseSource = null; }
}

async function reconnectNow() {
  healthFailures = 0;
  sseBackoffMs = 1000;
  setBridgeState('reconnecting', 'Reconnecting to the bridge…');
  const ok = await health();
  if (ok) {
    startEventStream();
    await refreshGithubState().catch((err) => log('ERROR: ' + err.message));
  }
}

/* ------------------------------------------------------------------ */
/* v3.0.1 — login gate + connection diagnostics (fix "Failed to fetch") */
/* ------------------------------------------------------------------ */

// v3.0.1: while the bridge is down, every sign-in button is disabled
// and the login panel shows the 3-step start guide instead of letting
// the user click sign-in into a raw "Failed to fetch".
const LOGIN_BUTTON_IDS = ['oauthConnectBtn', 'deviceFlowBtn', 'loginPatBtn', 'oauthSaveBtn', 'diagBtn', 'connDiagBtn'];

function setLoginEnabled(enabled) {
  for (const id of LOGIN_BUTTON_IDS) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }
  const notice = $('bridgeDownNotice');
  if (notice) {
    notice.classList.toggle('hidden', enabled);
    if (!enabled) $('bridgeDownNoticeText').textContent = BRIDGE_START_GUIDE;
  }
}

// Throws the translated BRIDGE_UNREACHABLE error when the bridge does
// not answer /health. Every sign-in entry point calls this first.
async function ensureBridgeUp() {
  const c = await cfg();
  await checkBridgeHealth(c.bridgeUrl);
  return true;
}

// v3.0.1 — one-click connection check: bridge reachable? right port?
// CORS preflight? /health ok? /oauth/status? Renders one row per step
// (same .diag-row style as the login diagnostics). Never throws.
async function runConnectionDiagnostics() {
  const list = $('connDiagList');
  const statusEl = $('connDiagStatus');
  list.innerHTML = '';
  statusEl.textContent = 'Đang kiểm tra…';
  const c = await cfg();
  let steps;
  try {
    steps = await checkConnectionSteps(c.bridgeUrl, c.token);
  } catch (err) {
    statusEl.textContent = 'Không kiểm tra được: ' + translateBridgeError(err, c.bridgeUrl).short;
    return null;
  }
  const failed = steps.filter((s) => !s.ok);
  statusEl.textContent = failed.length
    ? `${failed.length}/${steps.length} bước chưa đạt — xem cách sửa bên dưới.`
    : 'Tất cả các bước đều đạt ✓ — bridge đã sẵn sàng, thử đăng nhập lại.';
  for (const s of steps) {
    const row = document.createElement('div');
    row.className = 'diag-row' + (s.ok ? ' ok' : ' bad');
    const mark = document.createElement('b');
    mark.textContent = s.ok ? '✓' : '✗';
    const body = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = s.label || s.key || 'check';
    body.append(label);
    if (s.detail) body.append(document.createTextNode(' — ' + s.detail));
    if (!s.ok && s.fix) {
      const fix = document.createElement('small');
      fix.textContent = 'Cách sửa: ' + s.fix;
      body.append(fix);
    }
    row.append(mark, body);
    list.append(row);
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* GitHub sign-in                                                      */
/* ------------------------------------------------------------------ */

function authMethodLabel(method) {
  if (method === 'oauth-web') return 'OAuth Web';
  if (method === 'pat') return 'PAT';
  if (method === 'device') return 'Device Flow';
  return method ? String(method) : '';
}

function showUser(user) {
  ghUser = user || null;
  if (user && user.login) {
    $('userChip').classList.remove('hidden');
    $('userAvatar').src = user.avatar_url || '';
    $('userAvatar').alt = user.login;
    $('userLogin').textContent = user.login;
    // v3.0: show the account email when the bridge reports it, so the
    // user can recognise their own account at a glance.
    const emailEl = $('userEmail');
    if (user.email) {
      emailEl.textContent = user.email;
      emailEl.classList.remove('hidden');
    } else {
      emailEl.textContent = '';
      emailEl.classList.add('hidden');
    }
    const method = authMethodLabel(user.authMethod);
    $('userAuthMethod').textContent =
      (method ? 'via ' + method : '') + (user.scopes ? ' · ' + user.scopes : '');
    $('loginPanel').classList.add('hidden');
  } else {
    $('userChip').classList.add('hidden');
    $('userAvatar').src = '';
    $('userLogin').textContent = '—';
    $('userEmail').textContent = '';
    $('userEmail').classList.add('hidden');
    $('userAuthMethod').textContent = '';
    $('loginPanel').classList.remove('hidden');
  }
}

function updateRateLimit(rl) {
  if (!rl) return;
  const el = $('rateLimit');
  if (rl.remaining == null && rl.limit == null) { el.textContent = '—'; return; }
  const reset = rl.reset ? new Date(typeof rl.reset === 'number' ? rl.reset * 1000 : rl.reset).toLocaleTimeString() : '—';
  el.textContent = `${rl.remaining ?? '?'}/${rl.limit ?? '?'} remaining (resets ${reset})`;
}

async function refreshGithubState() {
  try {
    // v2.1: /user reports the sign-in method + scopes; fall back to the
    // v2.0 /me endpoint when talking to an older bridge.
    let me;
    try {
      me = await gh('/user');
    } catch (_) {
      me = await gh('/me');
    }
    if (me.authed && me.user) {
      // /me does not return authMethod/scopes on the user object, but the
      // v2.1 /user response carries them at the top level too.
      if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
      if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
      showUser(me.user);
      updateRateLimit(me.rateLimit);
      await loadRepos(false);
      await loadAutoUpdateStatus();
    } else {
      showUser(null);
      setRepoListEmpty('Sign in to GitHub to list your repositories.');
    }
  } catch (err) {
    // v3.0.1: a dead bridge is now a translated BRIDGE_UNREACHABLE
    // error (Vietnamese) instead of the raw "Failed to fetch" — treat
    // it like "not connected" and show the empty state, not a crash.
    if (err.code === BRIDGE_UNREACHABLE_CODE || /not connected|Missing bridge token|Bridge chưa chạy/i.test(err.message)) {
      showUser(null);
      setRepoListEmpty('Bridge chưa chạy — chạy bridge trước rồi đăng nhập GitHub (xem hướng dẫn trong khung "Bridge chưa chạy" ở panel đăng nhập).');
    } else {
      throw err;
    }
  }
  await loadOAuthStatus();
}

let devicePollTimer = null;

async function loginWithPat() {
  // v3.0.1: check the bridge first — a dead bridge used to surface as
  // a raw "Failed to fetch" from this very call.
  await ensureBridgeUp();
  const token = $('patInput').value.trim();
  if (!token) throw new Error('Paste a Personal Access Token first');
  // v3.0: check the shape on the client before sending anything. Users
  // used to paste their GitHub email / password here — GitHub has not
  // accepted passwords for third-party apps since 2020, so that can
  // never work. Warn clearly and do NOT send the request.
  if (!looksLikeGithubToken(token)) {
    $('patWarning').textContent = TOKEN_FORMAT_HINT;
    $('patWarning').classList.remove('hidden');
    await loadLoginDiagnostics().catch(() => {});
    throw new Error('The pasted text is not a GitHub token — see the warning above the button.');
  }
  $('patWarning').classList.add('hidden');
  let res;
  try {
    res = await gh('/auth', 'POST', { token });
  } catch (err) {
    if (/INVALID_TOKEN_FORMAT/.test(err.message)) {
      $('patWarning').textContent = TOKEN_FORMAT_HINT;
      $('patWarning').classList.remove('hidden');
    }
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  $('patInput').value = '';
  showUser(res.user);
  log(`Signed in to GitHub as ${res.user.login}`);
  await loadRepos(true);
  await loadAutoUpdateStatus();
}

/* ------------------------------------------------------------------ */
/* v3.0 — Login diagnostics: pinpoint the failing sign-in step         */
/* ------------------------------------------------------------------ */

// GET /api/github/login/diagnostics (bridge v3.0). Renders one line per
// check: ✓/✗ + detail + how to fix it. Never throws: on an older bridge
// (404) or when the bridge is down it says so in the panel instead of
// failing — the UI must not break just because the route is missing.
async function loadLoginDiagnostics() {
  const list = $('diagList');
  const statusEl = $('diagStatus');
  list.innerHTML = '';
  list.className = '';
  statusEl.textContent = 'Đang kiểm tra…';
  let data;
  try {
    data = await gh('/login/diagnostics');
  } catch (err) {
    statusEl.textContent = 'Không kiểm tra được: ' + err.message +
      ' — bridge này có thể là bản cũ (cần bridge v3.0 cho chẩn đoán chi tiết). Kiểm tra lại: bridge có đang chạy không, token bridge có đúng không, rồi thử lại cách đăng nhập.';
    return null;
  }
  const checks = (data && data.checks) || [];
  if (!checks.length) {
    statusEl.textContent = 'Bridge không trả về kết quả kiểm tra nào.';
    return data;
  }
  const failed = checks.filter((c) => !c.ok);
  statusEl.textContent = data.summary ||
    (failed.length ? `${failed.length}/${checks.length} bước chưa đạt — xem cách sửa bên dưới.` : 'Tất cả các bước đều đạt ✓ — thử đăng nhập lại.');
  for (const c of checks) {
    const row = document.createElement('div');
    row.className = 'diag-row' + (c.ok ? ' ok' : ' bad');
    const mark = document.createElement('b');
    mark.textContent = c.ok ? '✓' : '✗';
    const body = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = c.label || c.key || 'check';
    body.append(label);
    if (c.detail) body.append(document.createTextNode(' — ' + c.detail));
    if (!c.ok && c.fix) {
      const fix = document.createElement('small');
      fix.textContent = 'Cách sửa: ' + c.fix;
      body.append(fix);
    }
    row.append(mark, body);
    list.append(row);
  }
  return data;
}

function stopDeviceCountdown() {
  if (deviceCountdownTimer) { clearInterval(deviceCountdownTimer); deviceCountdownTimer = null; }
}

function updateDeviceCountdown() {
  const left = Math.max(0, Math.floor((deviceDeadline - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  $('deviceCountdown').textContent = left > 0 ? `Mã còn hiệu lực: ${mm}:${ss}` : 'Mã đã hết hạn.';
}

async function startDeviceFlow() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  let res;
  try {
    res = await gh('/auth/device/start', 'POST', {});
  } catch (err) {
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  $('deviceBox').classList.remove('hidden');
  $('deviceCode').textContent = res.user_code || '—';
  $('deviceStatus').textContent = 'Waiting for you to approve on GitHub…';
  // v3.0: show how long the code stays valid (countdown, 1s tick).
  stopDeviceCountdown();
  deviceDeadline = Date.now() + (Number(res.expires_in) || 900) * 1000;
  updateDeviceCountdown();
  deviceCountdownTimer = setInterval(updateDeviceCountdown, 1000);
  const verifyUrl = res.verification_uri_complete || res.verification_uri;
  $('deviceOpenBtn').onclick = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: verifyUrl });
    else if (typeof window !== 'undefined' && window.open) window.open(verifyUrl, '_blank');
  };
  if (devicePollTimer) clearInterval(devicePollTimer);
  const interval = Math.max(5, Number(res.interval) || 5) * 1000;
  const deadline = deviceDeadline;
  devicePollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      stopDeviceCountdown();
      $('deviceStatus').textContent = 'The code expired. Click "Sign in with Device Flow" again.';
      return;
    }
    try {
      const poll = await gh('/auth/device/poll', 'POST', { device_code: res.device_code });
      if (poll.status === 'authorized') {
        clearInterval(devicePollTimer);
        devicePollTimer = null;
        stopDeviceCountdown();
        $('deviceBox').classList.add('hidden');
        showUser(poll.user);
        log(`Signed in to GitHub as ${poll.user.login} (Device Flow)`);
        await loadRepos(true);
        await loadAutoUpdateStatus();
      } else if (poll.status === 'slow_down') {
        $('deviceStatus').textContent = 'Slow down — GitHub asked us to poll less often. Still waiting…';
      }
    } catch (err) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      stopDeviceCountdown();
      $('deviceStatus').textContent = 'Device Flow failed: ' + err.message;
      await loadLoginDiagnostics().catch(() => {});
    }
  }, interval);
}

async function logoutGithub() {
  await gh('/logout', 'POST', {});
  ghUser = null;
  allRepos = [];
  currentRepo = null;
  showUser(null);
  setRepoListEmpty('Signed out. Sign in to GitHub to list your repositories.');
  showView('repos');
  log('Signed out of GitHub.');
}

/* ------------------------------------------------------------------ */
/* OAuth Web Flow (v2.1, kept in v3.0): Connect GitHub — the recommended sign-in */
/* ------------------------------------------------------------------ */

// Reads /oauth/status and updates the setup form. Never throws: an
// older bridge (or a bridge that is down) simply leaves the form as-is.
async function loadOAuthStatus() {
  try {
    const st = await gh('/oauth/status');
    oauthConfigured = !!st.configured;
    $('oauthCallbackUrl').textContent = st.callbackUrl || '—';
    $('oauthConfigStatus').textContent = st.configured
      ? `OAuth App: configured ✓ (Client ID ${st.clientIdConfigured ? 'set' : 'missing'} · Client Secret ${st.clientSecretConfigured ? 'set' : 'missing'} — the secret is never shown again)`
      : 'OAuth App: not configured yet. Create an OAuth App (see above), save its Client ID + Client Secret, then click CONNECT GITHUB.';
    $('oauthConnectHint').textContent = st.configured
      ? 'Sign in with your real GitHub account in the browser (OAuth Web Flow — the recommended way).'
      : 'Connect GitHub needs an OAuth App first — open "OAUTH APP SETUP" below, or sign in with a token / Device Flow instead.';
  } catch (_) { /* older bridge or offline — PAT / Device Flow still work */ }
}

async function saveOAuthConfig() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  const clientId = $('oauthClientId').value.trim();
  const clientSecret = $('oauthClientSecret').value.trim();
  if (!clientId) throw new Error('Paste the Client ID from your GitHub OAuth App first');
  if (!clientSecret) throw new Error('Paste the Client Secret from your GitHub OAuth App first');
  const res = await gh('/oauth/config', 'POST', { clientId, clientSecret });
  $('oauthClientSecret').value = '';
  oauthConfigured = !!res.configured;
  $('oauthCallbackUrl').textContent = res.callbackUrl || $('oauthCallbackUrl').textContent;
  await loadOAuthStatus();
  log('OAuth App saved. You can now click CONNECT GITHUB.');
}

function stopOAuthPolling() {
  if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
}

async function startOAuthWeb() {
  // v3.0.1: check the bridge first (see loginWithPat).
  await ensureBridgeUp();
  if (!oauthConfigured) {
    // Refresh the status first — the user may just have saved the config
    // in another tab, or the bridge may have one from its environment.
    await loadOAuthStatus();
  }
  if (!oauthConfigured) {
    throw new Error('OAuth Web Flow is not configured yet. Open "OAUTH APP SETUP" above: create a GitHub OAuth App (github.com → Settings → Developer settings → OAuth Apps), paste its Authorization callback URL from this page, then save its Client ID + Client Secret here. Or sign in with a Personal Access Token / Device Flow instead.');
  }
  let res;
  try {
    res = await gh('/oauth/start');
  } catch (err) {
    // v3.0: the bridge now names the missing step. Point the user at the
    // OAuth App setup form instead of a generic "failed" message.
    if (/OAUTH_APP_NOT_CONFIGURED/.test(err.message)) {
      $('oauthConfigDetails').open = true;
      $('oauthConnectHint').textContent = 'Chưa cấu hình OAuth App: mở "CÁCH 1 — CẤU HÌNH OAUTH APP" bên dưới, tạo OAuth App trên github.com rồi lưu Client ID + Client Secret ở đây.';
      await loadLoginDiagnostics().catch(() => {});
      throw new Error('OAuth App chưa được cấu hình trên bridge. Xem hướng dẫn trong phần "CÁCH 1 — CẤU HÌNH OAUTH APP" bên dưới.');
    }
    await loadLoginDiagnostics().catch(() => {});
    throw err;
  }
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: res.authorizeUrl });
  else if (typeof window !== 'undefined' && window.open) window.open(res.authorizeUrl, '_blank');
  log('GitHub sign-in opened in a new tab. Approve the app there — this page will pick up the account automatically.');
  $('oauthConnectHint').textContent = 'Waiting for you to approve on GitHub… (this page checks every 2s, up to 5 minutes)';
  stopOAuthPolling();
  const deadline = Date.now() + 5 * 60 * 1000;
  oauthPollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      stopOAuthPolling();
      $('oauthConnectHint').textContent = 'The sign-in timed out. Click CONNECT GITHUB again.';
      return;
    }
    try {
      const me = await gh('/user');
      if (me.authed && me.user) {
        stopOAuthPolling();
        if (!me.user.authMethod && me.authMethod) me.user.authMethod = me.authMethod;
        if (!me.user.scopes && me.scopes) me.user.scopes = me.scopes;
        showUser(me.user);
        log(`Signed in to GitHub as ${me.user.login} (OAuth Web)`);
        await loadRepos(true);
        await loadAutoUpdateStatus();
      }
    } catch (_) { /* bridge hiccup — keep polling until the deadline */ }
  }, 2000);
}

/* ------------------------------------------------------------------ */
/* Auto-update                                                         */
/* ------------------------------------------------------------------ */

function showAutoUpdate(status) {
  if (!status) return;
  const el = $('autoUpdateState');
  if (!status.enabled) {
    el.textContent = 'Auto-update is off.';
    $('autoSyncState').textContent = '';
    $('autoSyncToggle').checked = false;
    $('autoSyncToggle').disabled = true;
    return;
  }
  const last = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleTimeString() : '—';
  el.textContent = `On · every ${status.intervalSeconds}s · last check ${last} · next ${next}` +
    (status.updatesFound ? ` · ${status.updatesFound} update(s) found` : '') +
    (status.lastError ? ` · last error: ${status.lastError}` : '');
  $('autoSyncToggle').disabled = false;
  $('autoSyncToggle').checked = !!status.autoSync;
  const lastSync = status.lastAutoSync;
  $('autoSyncState').textContent = status.autoSync
    ? 'Auto-sync ON — new commits are pulled into the local repo automatically.' +
      (lastSync && lastSync.at
        ? ' Last auto-sync: ' + new Date(lastSync.at).toLocaleTimeString() +
          (lastSync.skipped ? ' (skipped: ' + (lastSync.reason || '') + ')' :
            ' · ' + (lastSync.commitsPulled || 0) + ' commit(s) pulled')
        : '')
    : '';
}

function showUpdateBadge() {
  const badge = $('updateBadge');
  if (updateBadgeCount > 0) {
    badge.classList.remove('hidden');
    badge.textContent = updateBadgeCount + ' new';
  } else {
    badge.classList.add('hidden');
    badge.textContent = '';
  }
}

async function loadAutoUpdateStatus() {
  try {
    const status = await gh('/auto-update');
    showAutoUpdate(status);
    $('autoUpdateToggle').checked = !!status.enabled;
    if (status.intervalSeconds) $('autoUpdateInterval').value = String(status.intervalSeconds);
  } catch (_) { /* not authed yet — ignore */ }
}

async function setAutoUpdateUI(enabled, intervalSeconds, autoSync) {
  const body = { enabled, intervalSeconds };
  if (autoSync !== undefined) body.autoSync = !!autoSync;
  const status = await gh('/auto-update', 'POST', body);
  showAutoUpdate(status);
  await chrome.storage.local.set({ autoUpdateEnabled: status.enabled, autoUpdateInterval: status.intervalSeconds });
  return status;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function showView(name) {
  $('view-repos').classList.toggle('hidden', name !== 'repos');
  $('view-repo').classList.toggle('hidden', name !== 'repo');
  $('view-local').classList.toggle('hidden', name !== 'local');
  $('view-profile').classList.toggle('hidden', name !== 'profile');
  $('view-settings').classList.toggle('hidden', name !== 'settings');
  $('navRepos').classList.toggle('active', name === 'repos' || name === 'repo');
  $('navLocal').classList.toggle('active', name === 'local');
  $('navProfile').classList.toggle('active', name === 'profile');
  $('navSettings').classList.toggle('active', name === 'settings');
}

function showRepoTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  for (const name of ['overview', 'files', 'commits', 'branches', 'issues', 'pulls', 'releases']) {
    $('tab-' + name).classList.toggle('hidden', name !== tab);
  }
}

/* ------------------------------------------------------------------ */
/* Repositories: list, search, filter, sort                            */
/* ------------------------------------------------------------------ */

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26',
  CSS: '#563d7c', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', Go: '#00ADD8',
  Rust: '#dea584', Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF',
  Shell: '#89e051', Vue: '#41b883', Dart: '#00B4AB', 'C#': '#178600',
};

function setRepoListEmpty(text) {
  const container = $('repoList');
  container.className = 'empty';
  container.textContent = text;
}

function repoMatchesFilter(repo, filter) {
  if (filter === 'all') return true;
  if (filter === 'public') return !repo.private;
  if (filter === 'private') return !!repo.private;
  if (filter === 'forks') return !!repo.fork;
  if (filter === 'sources') return !repo.fork;
  if (filter === 'archived') return !!repo.archived;
  return true;
}

function filteredRepos() {
  const query = ($('repoSearch').value || '').trim().toLowerCase();
  const globalQuery = ($('globalSearch').value || '').trim().toLowerCase();
  const q = query || globalQuery;
  const filter = $('repoFilter').value;
  const sort = $('repoSort').value;
  let list = allRepos.filter((r) => repoMatchesFilter(r, filter));
  if (q) {
    list = list.filter((r) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.full_name || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      (r.language || '').toLowerCase().includes(q));
  }
  const byDate = (key) => (a, b) => new Date(b[key] || 0) - new Date(a[key] || 0);
  if (sort === 'updated') list.sort(byDate('updated_at'));
  else if (sort === 'pushed') list.sort(byDate('pushed_at'));
  else if (sort === 'created') list.sort(byDate('created_at'));
  else if (sort === 'stars') list.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  else if (sort === 'name') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return list;
}

function renderRepos() {
  const container = $('repoList');
  const list = filteredRepos();
  $('repoCount').textContent = allRepos.length ? `(${list.length} of ${allRepos.length})` : '';
  if (!allRepos.length) {
    setRepoListEmpty('No repositories found. Sign in to GitHub first, or check that your token has the repo scope.');
    return;
  }
  if (!list.length) {
    setRepoListEmpty('No repositories match the current search / filter.');
    return;
  }
  container.className = '';
  container.innerHTML = '';
  for (const repo of list) {
    const item = document.createElement('button');
    item.className = 'repo-item';
    item.onclick = () => openRepo(repo);

    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = repo.full_name;
    item.append(name);

    if (repo.description) {
      const desc = document.createElement('div');
      desc.className = 'rdesc';
      desc.textContent = repo.description;
      item.append(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'rmeta';

    const vis = document.createElement('span');
    vis.className = 'vis';
    vis.textContent = repo.private ? 'Private' : 'Public';
    meta.append(vis);

    if (repo.language) {
      const lang = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'lang-dot';
      dot.style.background = LANG_COLORS[repo.language] || '#79c0ff';
      lang.append(dot);
      lang.append(document.createTextNode(repo.language));
      meta.append(lang);
    }

    const stars = document.createElement('span');
    stars.textContent = '★ ' + formatNumber(repo.stargazers_count);
    meta.append(stars);

    const forks = document.createElement('span');
    forks.textContent = '⑂ ' + formatNumber(repo.forks_count);
    meta.append(forks);

    const updated = document.createElement('span');
    updated.textContent = 'Updated ' + timeAgo(repo.updated_at);
    meta.append(updated);

    if (repo.fork) {
      const forkTag = document.createElement('span');
      forkTag.textContent = 'Fork';
      meta.append(forkTag);
    }
    if (repo.archived) {
      const archTag = document.createElement('span');
      archTag.textContent = 'Archived';
      meta.append(archTag);
    }
    const hasUpdate = document.createElement('span');
    hasUpdate.className = 'updated';
    hasUpdate.textContent = '';
    meta.append(hasUpdate);

    // v3.0: per-repo .zip download (stops the click so the repo does not open).
    const zipBtn = document.createElement('button');
    zipBtn.className = 'mini zip-btn';
    zipBtn.textContent = '⬇ .zip';
    zipBtn.title = 'Download this repository as a .zip';
    zipBtn.onclick = (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      run('Repository .zip downloaded', () => downloadRepoZip(repo));
    };
    meta.append(zipBtn);

    item.append(meta);
    container.append(item);
  }
  log(list.length + ' repositories shown' + (reposLoadedAt ? ' (loaded ' + new Date(reposLoadedAt).toLocaleTimeString() + ')' : ''));
}

async function loadRepos(force) {
  const res = await gh('/repos/all' + (force ? '?force=1' : ''));
  allRepos = res.repos || [];
  reposLoadedAt = Date.now();
  updateBadgeCount = 0;
  showUpdateBadge();
  renderRepos();
  return allRepos;
}

// v3.0 — download a GitHub repo as .zip (bridge v3.0 route). `ref` is a
// branch name; defaults to the repo's default branch.
async function downloadRepoZip(repo, ref) {
  const parts = String(repo.full_name || '').split('/');
  if (parts.length !== 2) throw new Error('Invalid repository name');
  const branch = ref || repo.default_branch || 'main';
  const filename = `${repo.name || parts[1]}-${branch}.zip`;
  log(`Downloading ${repo.full_name}@${branch} as ${filename}…`);
  const res = await downloadBlob(`/api/github/repos/${parts[0]}/${parts[1]}/zip?ref=${encodeURIComponent(branch)}`, 'GET', undefined, filename);
  log(`Downloaded ${res.filename} (${formatNumber(res.size)} B)`);
  return res;
}

async function downloadCurrentRepoZip() {
  if (!currentRepo) throw new Error('Open a repository first');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  await downloadRepoZip({ full_name: currentRepo.full_name, name: currentRepo.repo, default_branch: currentRepo.default_branch }, branch);
}

// v3.0 — create a repository on GitHub (bridge v3.0 route).
async function createRepo() {
  const name = $('createRepoName').value.trim();
  if (!name) throw new Error('Enter a name for the new repository');
  const res = await gh('/repos', 'POST', {
    name,
    description: $('createRepoDesc').value.trim(),
    private: !!$('createRepoPrivate').checked,
    auto_init: true,
  });
  $('createRepoName').value = '';
  $('createRepoDesc').value = '';
  $('createRepoPrivate').checked = false;
  log(`Repository created: ${res.full_name || res.name || name}`);
  await loadRepos(true);
  return res;
}

/* ------------------------------------------------------------------ */
/* Repo detail: overview / files / commits / branches / issues / pulls */
/* ------------------------------------------------------------------ */

function openRepo(repo) {
  const parts = String(repo.full_name || '').split('/');
  if (parts.length !== 2) return;
  currentRepo = { owner: parts[0], repo: parts[1], full_name: repo.full_name, default_branch: repo.default_branch || 'main' };
  currentPath = '';
  chrome.storage.local.set({ lastRepo: repo.full_name }).catch(() => {});
  $('detailName').textContent = repo.full_name;
  $('detailDesc').textContent = repo.description || 'No description.';
  $('detailStars').textContent = formatNumber(repo.stargazers_count);
  $('detailForks').textContent = formatNumber(repo.forks_count);
  $('detailIssues').textContent = formatNumber(repo.open_issues_count);
  const badges = $('detailBadges');
  badges.innerHTML = '';
  const mk = (text) => { const s = document.createElement('span'); s.textContent = text; badges.append(s); };
  mk(repo.private ? 'Private' : 'Public');
  if (repo.language) mk(repo.language);
  if (repo.fork) mk('Fork');
  if (repo.archived) mk('Archived');
  if (repo.license) mk('License: ' + repo.license);
  if (Array.isArray(repo.topics)) repo.topics.slice(0, 8).forEach((t) => mk(t));
  showView('repo');
  showRepoTab('overview');
  loadReadme().catch((err) => { $('readmeView').textContent = 'Could not load README: ' + err.message; });
  loadRepoBranches().catch(() => {});
  loadRepoCommits().catch(() => {});
}

async function loadReadme() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/readme`);
  $('readmeName').textContent = res.name || '';
  $('readmeView').textContent = res.content || '(Empty README)';
}

async function loadRepoBranches() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/branches?per_page=100`);
  const list = res.branches || [];
  const container = $('branchList');
  container.className = '';
  container.innerHTML = '';
  const select = $('fileBranchSelect');
  select.innerHTML = '';
  if (!list.length) {
    container.className = 'empty';
    container.textContent = 'No branches found.';
    return;
  }
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (b.protected ? '🔒 ' : '') + b.name;
    const meta = document.createElement('small');
    meta.textContent = b.sha ? b.sha.slice(0, 7) : '';
    row.append(title, meta);
    container.append(row);

    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = b.name;
    select.append(opt);
  }
  if (currentRepo.default_branch) select.value = currentRepo.default_branch;
  // v3.0: a saved default branch (Settings) wins when it exists here.
  if (settingsDefaultBranch && list.some((b) => b.name === settingsDefaultBranch)) select.value = settingsDefaultBranch;
  await loadFileTree(currentPath);
}

async function loadRepoCommits() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/commits?per_page=20`);
  const container = $('commitList');
  container.className = '';
  container.innerHTML = '';
  const commits = res.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = 'No commits found.';
    return;
  }
  for (const c of commits) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = c.short + ' · ' + c.message;
    const meta = document.createElement('small');
    meta.textContent = (c.author || 'unknown') + ' · ' + (c.date ? new Date(c.date).toLocaleString() : '');
    row.append(title, meta);
    container.append(row);
  }
}

async function loadRepoIssues() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/issues?state=open&per_page=20`);
  const container = $('issueList');
  container.classList.remove('hidden');
  $('issueDetail').classList.add('hidden');
  container.className = '';
  container.innerHTML = '';
  const issues = res.issues || [];
  if (!issues.length) {
    container.className = 'empty';
    container.textContent = 'No open issues.';
    return;
  }
  for (const i of issues) {
    const row = document.createElement('div');
    row.className = 'issueitem';
    row.style.cursor = 'pointer';
    row.title = 'Click to view details and comments';
    row.onclick = () => showIssueDetail(i.number).catch((err) => log('ERROR: ' + err.message));
    const title = document.createElement('b');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '#' + i.number;
    title.append(num);
    title.append(document.createTextNode(i.title + (i.is_pull_request ? ' (PR)' : '')));
    const meta = document.createElement('small');
    meta.textContent = `${i.user || ''} · opened ${timeAgo(i.created_at)} · ${i.comments} comments` +
      (i.labels && i.labels.length ? ' · ' + i.labels.join(', ') : '');
    row.append(title, meta);
    container.append(row);
  }
}

async function loadRepoPulls() {
  if (!currentRepo) return;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/pulls?state=open&per_page=20`);
  const container = $('pullList');
  container.className = '';
  container.innerHTML = '';
  const pulls = res.pulls || [];
  if (!pulls.length) {
    container.className = 'empty';
    container.textContent = 'No open pull requests.';
    return;
  }
  for (const p of pulls) {
    const row = document.createElement('div');
    row.className = 'issueitem';
    const title = document.createElement('b');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '#' + p.number;
    title.append(num);
    title.append(document.createTextNode(p.title + (p.draft ? ' (draft)' : '')));
    const meta = document.createElement('small');
    meta.textContent = `${p.user || ''} · ${p.head} → ${p.base} · opened ${timeAgo(p.created_at)}`;
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'mini blue';
    mergeBtn.textContent = 'Merge';
    mergeBtn.onclick = () => run('Pull request merged', () => mergePullRequest(p.number));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'mini';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => run('Pull request closed', () => closePullRequest(p.number));
    actions.append(mergeBtn, closeBtn);
    row.append(title, meta, actions);
    container.append(row);
  }
}

async function loadFileTree(relPath) {
  if (!currentRepo) return;
  currentPath = relPath || '';
  $('filePathLabel').textContent = '/' + currentPath;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  let apiPath = `/repos/${currentRepo.owner}/${currentRepo.repo}/contents?path=${encodeURIComponent(currentPath)}`;
  if (branch) apiPath += `&ref=${encodeURIComponent(branch)}`;
  const res = await gh(apiPath);
  const container = $('fileTree');
  container.className = '';
  container.innerHTML = '';
  $('fileViewerWrap').classList.add('hidden');
  const entries = res.entries || [];
  if (!entries.length) {
    container.className = 'empty';
    container.textContent = 'This folder is empty.';
    return;
  }
  const sorted = [...entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  for (const e of sorted) {
    const row = document.createElement('button');
    row.className = 'file-row';
    const icon = document.createElement('span');
    icon.textContent = e.type === 'dir' ? '📁' : '📄';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = e.name;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = e.type === 'dir' ? '' : formatNumber(e.size) + ' B';
    row.append(icon, name, meta);
    row.onclick = () => {
      if (e.type === 'dir') loadFileTree(e.path).catch((err) => log('ERROR: ' + err.message));
      else showFile(e.path).catch((err) => log('ERROR: ' + err.message));
    };
    container.append(row);
  }
}

async function showFile(relPath) {
  if (!currentRepo) return;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const res = await gh(`/repos/${currentRepo.owner}/${currentRepo.repo}/contents?path=${encodeURIComponent(relPath)}&ref=${encodeURIComponent(branch)}`);
  $('fileViewerWrap').classList.remove('hidden');
  $('fileViewerName').textContent = res.name || relPath;
  $('fileViewerMeta').textContent = `${formatNumber(res.size)} B · ${res.sha ? res.sha.slice(0, 7) : ''}`;
  const content = res.content || '';
  $('fileViewer').textContent = content.length > 200000
    ? content.slice(0, 200000) + '\n\n… file truncated at 200,000 characters …'
    : content;
  // v3.0: remember the open file so it can be edited / deleted.
  selectedFile = relPath;
  selectedFileSha = res.sha || '';
  $('fileEditWrap').classList.remove('hidden');
  $('fileEditArea').value = content;
}

/* ------------------------------------------------------------------ */
/* v3.0 — Repo actions: star / unstar / fork / edit description /      */
/* delete, releases, code search, file edit / create / delete / upload */
/* ------------------------------------------------------------------ */

function repoApiBase() {
  if (!currentRepo) throw new Error('Open a repository first');
  return `/repos/${currentRepo.owner}/${currentRepo.repo}`;
}

async function starRepo() {
  await gh(repoApiBase() + '/star', 'PUT', {});
  log(`Starred ${currentRepo.full_name} ★`);
  await openRepoRefreshCounts();
}

async function unstarRepo() {
  await gh(repoApiBase() + '/star', 'DELETE', {});
  log(`Unstarred ${currentRepo.full_name}`);
  await openRepoRefreshCounts();
}

async function forkRepo() {
  const res = await gh(repoApiBase() + '/fork', 'POST', {});
  log(`Forked ${currentRepo.full_name} → ${res.full_name || 'your account'}`);
  await loadRepos(true);
  return res;
}

async function editRepoDescription() {
  const current = $('detailDesc').textContent === 'No description.' ? '' : $('detailDesc').textContent;
  const desc = prompt('New description for ' + currentRepo.full_name + ':', current);
  if (desc === null) return; // cancelled
  const res = await gh(repoApiBase(), 'PATCH', { description: desc });
  $('detailDesc').textContent = (res && res.description) || desc || 'No description.';
  log('Repository description updated.');
  await loadRepos(false);
  return res;
}

async function deleteRepo() {
  if (!currentRepo) throw new Error('Open a repository first');
  const fullName = currentRepo.full_name;
  if (!confirm(`Delete the GitHub repository ${fullName}?\n\nThis cannot be undone. All code, issues and pull requests will be gone.`)) return;
  if (!confirm(`Really delete ${fullName}? Click OK to confirm the deletion.`)) return;
  await gh(repoApiBase(), 'DELETE', { confirm: true });
  log(`Repository ${fullName} deleted.`);
  currentRepo = null;
  showView('repos');
  await loadRepos(true);
}

/* --- Releases --- */

async function loadReleases() {
  if (!currentRepo) return;
  const res = await gh(repoApiBase() + '/releases');
  const container = $('releaseList');
  container.className = '';
  container.innerHTML = '';
  const releases = res.releases || [];
  if (!releases.length) {
    container.className = 'empty';
    container.textContent = 'No releases yet.';
    return;
  }
  for (const r of releases) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (r.tag_name || '') + (r.name ? ' — ' + r.name : '') +
      (r.draft ? ' (draft)' : '') + (r.prerelease ? ' (pre-release)' : '');
    const meta = document.createElement('small');
    meta.textContent = (r.body || '').slice(0, 200);
    row.append(title, meta);
    const assets = r.assets || [];
    for (const a of assets) {
      const assetBtn = document.createElement('button');
      assetBtn.className = 'mini';
      assetBtn.textContent = `⬇ ${a.name} (${formatNumber(a.size)} B · ${a.download_count || 0} downloads)`;
      assetBtn.onclick = () => run('Release asset downloaded', async () => {
        await downloadBlob(`${repoApiBase()}/releases/assets/${a.id}?name=${encodeURIComponent(a.name)}`, 'GET', undefined, a.name);
        log(`Downloaded asset ${a.name}`);
      });
      row.append(assetBtn);
    }
    container.append(row);
  }
}

async function createRelease() {
  const tag = $('releaseTag').value.trim();
  if (!tag) throw new Error('Enter a tag name for the release (e.g. v1.0.0)');
  const res = await gh(repoApiBase() + '/releases', 'POST', {
    tag_name: tag,
    name: $('releaseName').value.trim() || tag,
    body: $('releaseBody').value.trim(),
    draft: !!$('releaseDraft').checked,
    prerelease: !!$('releasePrerelease').checked,
  });
  $('releaseTag').value = '';
  $('releaseName').value = '';
  $('releaseBody').value = '';
  $('releaseDraft').checked = false;
  $('releasePrerelease').checked = false;
  log(`Release ${res.tag_name || tag} created.`);
  await loadReleases();
  return res;
}

/* --- Code search --- */

async function searchCode() {
  if (!currentRepo) return;
  const q = $('codeSearchInput').value.trim();
  if (!q) throw new Error('Enter text to search for in this repository');
  const res = await gh(`/search/code?q=${encodeURIComponent(q)}&repo=${encodeURIComponent(currentRepo.full_name)}`);
  const container = $('codeSearchResults');
  container.className = '';
  container.innerHTML = '';
  const items = res.items || [];
  $('codeSearchResults').classList.remove('hidden');
  if (!items.length) {
    container.className = 'empty';
    container.textContent = `No code matches "${q}" in ${currentRepo.full_name}.`;
    return;
  }
  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'file-row';
    const icon = document.createElement('span');
    icon.textContent = '🔎';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = item.name || item.path;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = item.path || '';
    row.append(icon, name, meta);
    row.onclick = () => {
      showRepoTab('files');
      showFile(item.path).catch((err) => log('ERROR: ' + err.message));
    };
    container.append(row);
  }
  log(`${items.length} code result(s) for "${q}"`);
}

/* --- File edit / create / delete / upload --- */

async function saveEditedFile() {
  if (!currentRepo || !selectedFile) throw new Error('Open a file first');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const content = $('fileEditArea').value;
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path: selectedFile,
    message: `Update ${selectedFile} via PixiJS GitHub Sync`,
    content,
    sha: selectedFileSha || undefined,
    branch,
  });
  if (res && res.content && res.content.sha) selectedFileSha = res.content.sha;
  log(`Saved ${selectedFile} ✓`);
  await loadFileTree(currentPath);
  return res;
}

async function createNewFile() {
  if (!currentRepo) throw new Error('Open a repository first');
  const name = $('newFileName').value.trim();
  if (!name) throw new Error('Enter a name for the new file');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const path = currentPath ? currentPath + '/' + name : name;
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path,
    message: `Create ${path} via PixiJS GitHub Sync`,
    content: $('newFileContent').value,
    branch,
  });
  $('newFileName').value = '';
  $('newFileContent').value = '';
  log(`Created ${path} ✓`);
  await loadFileTree(currentPath);
  return res;
}

async function deleteCurrentFile() {
  if (!currentRepo || !selectedFile) throw new Error('Open a file first');
  if (!confirm(`Delete ${selectedFile} from ${currentRepo.full_name}?\n\nThis commits the deletion to the branch.`)) return;
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  await gh(repoApiBase() + '/contents', 'DELETE', {
    path: selectedFile,
    message: `Delete ${selectedFile} via PixiJS GitHub Sync`,
    sha: selectedFileSha,
    branch,
  });
  log(`Deleted ${selectedFile} ✓`);
  $('fileViewerWrap').classList.add('hidden');
  $('fileEditWrap').classList.add('hidden');
  selectedFile = '';
  selectedFileSha = '';
  await loadFileTree(currentPath);
}

async function uploadFileToRepo(file) {
  if (!currentRepo) throw new Error('Open a repository first');
  if (!file) throw new Error('Choose a file to upload');
  if (typeof FileReader === 'undefined') throw new Error('File upload is not available in this environment');
  const branch = $('fileBranchSelect').value || currentRepo.default_branch;
  const path = currentPath ? currentPath + '/' + file.name : file.name;
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
  const res = await gh(repoApiBase() + '/contents', 'PUT', {
    path,
    message: `Upload ${path} via PixiJS GitHub Sync`,
    contentBase64: base64,
    branch,
  });
  log(`Uploaded ${path} ✓`);
  await loadFileTree(currentPath);
  return res;
}

// Refresh the star/fork/issue counters in the repo header after an action.
async function openRepoRefreshCounts() {
  if (!currentRepo) return;
  try {
    const res = await gh('/repos/all?force=1');
    const match = (res.repos || []).find((r) => r.full_name === currentRepo.full_name);
    if (match) {
      $('detailStars').textContent = formatNumber(match.stargazers_count);
      $('detailForks').textContent = formatNumber(match.forks_count);
      $('detailIssues').textContent = formatNumber(match.open_issues_count);
    }
  } catch (_) { /* best-effort — the counts are cosmetic */ }
}

/* --- Issues: create / detail / comment / close-reopen --- */

async function createIssue() {
  if (!currentRepo) return;
  const title = $('issueTitle').value.trim();
  if (!title) throw new Error('Enter an issue title');
  const labels = $('issueLabels').value.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await gh(repoApiBase() + '/issues', 'POST', {
    title,
    body: $('issueBody').value.trim(),
    labels,
  });
  $('issueTitle').value = '';
  $('issueBody').value = '';
  $('issueLabels').value = '';
  log(`Issue #${(res && res.number) || '?'} created.`);
  await loadRepoIssues();
  return res;
}

async function showIssueDetail(number) {
  if (!currentRepo) return;
  currentIssueNumber = number;
  const res = await gh(`${repoApiBase()}/issues/${number}`);
  const issue = res.issue || res;
  $('issueDetail').classList.remove('hidden');
  $('issueList').classList.add('hidden');
  $('issueDetailTitle').textContent = `#${issue.number || number} — ${issue.title || ''}`;
  $('issueDetailMeta').textContent = `${issue.user || ''} · ${issue.state || ''} · opened ${timeAgo(issue.created_at)} · ${issue.comments || 0} comments`;
  $('issueDetailBody').textContent = issue.body || '(No description)';
  const commentsBox = $('issueComments');
  commentsBox.innerHTML = '';
  const comments = res.comments || issue.commentsList || [];
  if (!comments.length) {
    commentsBox.className = 'empty';
    commentsBox.textContent = 'No comments yet.';
  } else {
    commentsBox.className = '';
    for (const c of comments) {
      const row = document.createElement('div');
      row.className = 'commititem';
      const title = document.createElement('b');
      title.textContent = (c.user || c.author || 'unknown');
      const meta = document.createElement('small');
      meta.textContent = (c.body || '') + (c.created_at ? ' · ' + timeAgo(c.created_at) : '');
      row.append(title, meta);
      commentsBox.append(row);
    }
  }
  $('issueCloseBtn').textContent = issue.state === 'closed' ? 'Reopen issue' : 'Close issue';
}

async function addIssueComment() {
  if (!currentRepo || currentIssueNumber == null) throw new Error('Open an issue first');
  const body = $('commentBody').value.trim();
  if (!body) throw new Error('Write the comment first');
  await gh(`${repoApiBase()}/issues/${currentIssueNumber}/comments`, 'POST', { body });
  $('commentBody').value = '';
  log('Comment added.');
  await showIssueDetail(currentIssueNumber);
}

async function toggleIssueState() {
  if (!currentRepo || currentIssueNumber == null) throw new Error('Open an issue first');
  const closing = $('issueCloseBtn').textContent.indexOf('Close') === 0;
  await gh(`${repoApiBase()}/issues/${currentIssueNumber}`, 'PATCH', { state: closing ? 'closed' : 'open' });
  log(`Issue #${currentIssueNumber} ${closing ? 'closed' : 'reopened'}.`);
  await showIssueDetail(currentIssueNumber);
  await loadRepoIssues();
}

/* --- Pull requests: create / merge / close --- */

async function createPullRequest() {
  if (!currentRepo) return;
  const title = $('prTitle').value.trim();
  const head = $('prHead').value.trim();
  const base = $('prBase').value.trim() || currentRepo.default_branch;
  if (!title || !head) throw new Error('Enter a PR title and the head branch');
  const res = await gh(repoApiBase() + '/pulls', 'POST', { title, head, base, body: $('prBody').value.trim() });
  $('prTitle').value = '';
  $('prHead').value = '';
  $('prBody').value = '';
  log(`Pull request #${(res && res.number) || '?'} created (${head} → ${base}).`);
  await loadRepoPulls();
  return res;
}

async function mergePullRequest(number) {
  if (!currentRepo) return;
  const method = $('prMergeMethod').value || 'merge';
  if (!confirm(`Merge pull request #${number} (${method})?`)) return;
  await gh(`${repoApiBase()}/pulls/${number}/merge`, 'PUT', { merge_method: method });
  log(`Pull request #${number} merged (${method}).`);
  await loadRepoPulls();
}

async function closePullRequest(number) {
  if (!currentRepo) return;
  if (!confirm(`Close pull request #${number} without merging?`)) return;
  await gh(`${repoApiBase()}/pulls/${number}`, 'PATCH', { state: 'closed' });
  log(`Pull request #${number} closed.`);
  await loadRepoPulls();
}

/* ------------------------------------------------------------------ */
/* Local Git (v1 behaviour, restyled)                                  */
/* ------------------------------------------------------------------ */

function statusLabel(file) {
  if (file.untracked) return 'NEW';
  if (file.status === 'MM') return 'MM';
  return file.status || '?';
}

async function status() {
  const data = await api('/api/git/status');
  const files = data.files || [];
  const container = $('changes');
  container.innerHTML = '';

  if (!files.length) {
    container.className = 'empty';
    container.textContent = 'Working tree clean';
    log('0 changed file(s)');
    return;
  }

  container.className = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file';

    const tag = document.createElement('span');
    tag.className = 'tag' + (file.staged ? ' staged' : '');
    tag.textContent = statusLabel(file);

    const pathEl = document.createElement('span');
    pathEl.className = 'path';
    pathEl.textContent = file.path;
    if (file.origPath) pathEl.title = 'Renamed from ' + file.origPath;

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = file.staged ? 'STAGED' : 'UNSTAGED';

    const actions = document.createElement('span');
    actions.className = 'actions';

    const diffBtn = document.createElement('button');
    diffBtn.textContent = 'Diff';
    diffBtn.onclick = () => showDiff(file.path);

    const stageBtn = document.createElement('button');
    stageBtn.textContent = file.staged ? 'Unstage' : 'Stage';
    stageBtn.onclick = async () => {
      try {
        await api('/api/git/' + (file.staged ? 'unstage' : 'stage'), 'POST', { path: file.path });
        await status();
        log((file.staged ? 'Unstaged ' : 'Staged ') + file.path);
      } catch (err) {
        log('ERROR: ' + err.message);
      }
    };

    actions.append(diffBtn, stageBtn);
    row.append(tag, pathEl, state, actions);
    container.append(row);
  }

  log(files.length + ' changed file(s)');
  loadDiffSummary().catch(() => {});
}

function formatDiffEntries(entries) {
  const list = entries || [];
  if (!list.length) return '0 files';
  let ins = 0;
  let del = 0;
  for (const e of list) { ins += Number(e.insertions) || 0; del += Number(e.deletions) || 0; }
  return `${list.length} file(s) (+${ins}/−${del})`;
}

async function loadDiffSummary() {
  const data = await api('/api/git/diff/summary');
  const worktree = data.worktree || [];
  const staged = data.staged || [];
  const fmt = (entries) => (entries || []).map((e) =>
    `${e.path} (+${e.insertions || 0}/−${e.deletions || 0}${e.binary ? ' binary' : ''})`).join(' · ');
  $('diffSummary').textContent =
    `Unstaged (worktree): ${formatDiffEntries(worktree)}` + (worktree.length ? ' — ' + fmt(worktree) : '') +
    ` · Staged: ${formatDiffEntries(staged)}` + (staged.length ? ' — ' + fmt(staged) : '');
}

async function showDiff(path) {
  selectedFile = path;
  $('diffFile').textContent = path;
  $('diff').textContent = 'Loading…';
  try {
    const data = await api('/api/git/diff?path=' + encodeURIComponent(path));
    $('diff').textContent = data.diff || '(No text diff available)';
  } catch (err) {
    $('diff').textContent = err.message;
  }
}

async function branches() {
  const data = await api('/api/git/branches');
  const select = $('branchSelect');
  const previous = select.value;
  select.innerHTML = '';

  const list = data.branches || [];
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No branches';
    select.append(option);
  } else {
    for (const branch of list) {
      const option = document.createElement('option');
      option.value = branch.name;
      option.textContent = (branch.current ? '● ' : '') + branch.name;
      select.append(option);
    }
    if (previous && list.some((b) => b.name === previous)) select.value = previous;
  }

  // v2.1: remote branches (read-only list — delete via the Branch panel).
  const remoteList = $('remoteBranchList');
  const remoteBranches = data.remoteBranches || [];
  remoteList.innerHTML = '';
  if (!remoteBranches.length) {
    remoteList.className = 'empty';
    remoteList.textContent = 'No remote branches.';
  } else {
    remoteList.className = '';
    for (const name of remoteBranches) {
      const row = document.createElement('div');
      row.className = 'commititem';
      const title = document.createElement('b');
      title.textContent = name;
      row.append(title);
      remoteList.append(row);
    }
  }
}

async function history(page) {
  historyPage = Math.max(1, Number(page) || historyPage || 1);
  const data = await api('/api/git/log?page=' + historyPage + '&per_page=30');
  historyHasNext = !!data.has_next;
  const container = $('history');
  container.innerHTML = '';

  const commits = data.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = historyPage > 1 ? 'No more commits on this page.' : 'No commits yet';
  } else {
    container.className = '';
    for (const commit of commits) {
      const item = document.createElement('div');
      item.className = 'commititem';

      const title = document.createElement('b');
      title.textContent = commit.hash + ' · ' + commit.subject;

      const meta = document.createElement('small');
      meta.textContent = commit.author + ' · ' + commit.date;

      item.append(title, meta);
      container.append(item);
    }
  }
  $('historyPageLabel').textContent = 'Page ' + historyPage;
  $('historyPrevBtn').disabled = historyPage <= 1;
  $('historyNextBtn').disabled = !historyHasNext;
}

/* ------------------------------------------------------------------ */
/* Local Git v2.1: ahead/behind, push/pull/sync, branches, merge,      */
/* stash, remotes, clone                                               */
/* ------------------------------------------------------------------ */

function syncTarget() {
  return {
    remote: $('syncRemote').value.trim() || 'origin',
    branch: $('syncBranch').value.trim() || null,
    mode: $('pullMode').value || 'merge',
  };
}

async function loadAheadBehind() {
  const data = await api('/api/git/ahead-behind');
  const badge = $('aheadBehindBadge');
  if (!data.hasUpstream) {
    badge.textContent = 'No upstream';
    badge.title = 'This branch has no upstream branch yet — tick "Set upstream" on push.';
    return data;
  }
  const ahead = Number(data.ahead) || 0;
  const behind = Number(data.behind) || 0;
  badge.textContent = `↑${ahead} ↓${behind}`;
  badge.title = `ahead ${ahead}, behind ${behind} ${data.upstream || ''}`.trim();
  return data;
}

function showAheadBehind(data) {
  if (!data) return;
  const badge = $('aheadBehindBadge');
  const ahead = Number(data.ahead) || 0;
  const behind = Number(data.behind) || 0;
  if (data.hasUpstream === false) {
    badge.textContent = 'No upstream';
    badge.title = 'This branch has no upstream branch yet — tick "Set upstream" on push.';
  } else {
    badge.textContent = `↑${ahead} ↓${behind}`;
    badge.title = `ahead ${ahead}, behind ${behind} ${data.upstream || ''}`.trim();
  }
}

// A pull/merge that conflicts returns HTTP 200 { ok:false, conflict:true }.
// Surface it in the Merge & Conflicts panel instead of a bare error.
async function handlePossibleConflict(res, what) {
  if (res && res.conflict) {
    log(`${what}: merge conflict in ${(res.conflicts || []).length} file(s) — resolve below (Ours / Theirs), then Commit merge.`);
    await loadConflicts();
    return true;
  }
  return false;
}

async function doFetch() {
  await api('/api/git/fetch', 'POST', {});
  await loadAheadBehind().catch(() => {});
  await status();
}

async function doPull() {
  const t = syncTarget();
  const res = await api('/api/git/pull', 'POST', { mode: t.mode, remote: t.remote, branch: t.branch });
  showAheadBehind(res);
  await loadAheadBehind().catch(() => {});
  if (await handlePossibleConflict(res, 'Pull')) {
    await status();
    await history();
    return res;
  }
  if (!res.ok) throw new Error(res.error || res.result || 'Pull failed');
  log(`Pull (${res.mode || t.mode}) ✓ — ${res.commitsPulled || 0} commit(s), ${((res.changedFiles || []).length)} file(s) changed${res.fastForward ? ' (fast-forward)' : ''}`);
  await status();
  await history();
  return res;
}

async function doPush(options) {
  const t = syncTarget();
  const force = !!$('forcePushCheck').checked;
  if (force && !$('forceConfirmCheck').checked) {
    throw new Error('Force-push needs the confirmation checkbox ticked first ("I understand force-push can overwrite the remote branch").');
  }
  const body = {
    remote: t.remote,
    branch: t.branch,
    setUpstream: !!$('setUpstreamCheck').checked,
    force,
    confirm: force, // only ever sent when the user ticked both checkboxes
    pushAll: !!(options && options.pushAll),
    tags: !!(options && options.tags),
  };
  const res = await api('/api/git/push', 'POST', body);
  showAheadBehind(res);
  await loadAheadBehind().catch(() => {});
  await status();
  await history();
  return res;
}

function renderSyncSteps(res) {
  const box = $('syncSteps');
  const steps = (res && res.steps) || [];
  if (!steps.length) {
    box.textContent = res && res.error ? 'Sync failed: ' + res.error : 'Sync finished.';
    return;
  }
  box.textContent = steps.map((s) =>
    `${s.step}: ${s.ok ? '✓' : '✗'}${s.conflict ? ' (conflict)' : ''}${s.result ? ' — ' + String(s.result).split('\n')[0] : ''}${s.error ? ' — ' + s.error : ''}`
  ).join('  ·  ');
}

async function doSync() {
  const t = syncTarget();
  let res;
  try {
    res = await api('/api/git/sync', 'POST', { mode: t.mode, remote: t.remote, branch: t.branch });
  } catch (err) {
    // The bridge answers 400 when a step throws outright (e.g. no remote
    // configured) instead of a per-step report — show it in the panel too.
    $('syncSteps').textContent = `sync: ✗ — ${err.message}`;
    throw err;
  }
  renderSyncSteps(res);
  showAheadBehind(res);
  await loadAheadBehind().catch(() => {});
  if (await handlePossibleConflict(res, 'Sync')) {
    await status();
    await history();
    return res;
  }
  if (!res.ok) throw new Error(res.error || 'Sync failed at the ' + ((res.steps || []).find((s) => !s.ok) || {}).step + ' step');
  log(`Sync ✓ — pulled ${((res.pulled || {}).commitsPulled) || 0} commit(s), pushed.`);
  await status();
  await history();
  return res;
}

async function createBranch() {
  const name = $('newBranchName').value.trim();
  if (!name) throw new Error('Enter a name for the new branch');
  const res = await api('/api/git/branch/create', 'POST', {
    name,
    from: $('newBranchFrom').value.trim() || undefined,
    checkout: $('newBranchCheckout').checked,
  });
  $('newBranchName').value = '';
  $('newBranchFrom').value = '';
  log(`Branch ${res.branch} created${res.current === res.branch ? ' and checked out' : ''}.`);
  await refreshAllLocal();
}

async function renameBranch() {
  const oldName = $('renameBranchOld').value.trim();
  const newName = $('renameBranchNew').value.trim();
  if (!oldName || !newName) throw new Error('Enter both the old and the new branch name');
  const res = await api('/api/git/branch/rename', 'POST', { old: oldName, new: newName });
  $('renameBranchOld').value = '';
  $('renameBranchNew').value = '';
  log(`Branch renamed: ${res.old} → ${res.new}.`);
  await refreshAllLocal();
}

async function deleteBranch() {
  const name = $('deleteBranchName').value.trim();
  if (!name) throw new Error('Enter the branch to delete');
  const res = await api('/api/git/branch/delete', 'POST', {
    name,
    remote: !!$('deleteBranchRemoteCheck').checked,
    deleteRemote: !!$('deleteBranchRemoteCheck').checked,
    remoteName: $('syncRemote').value.trim() || 'origin',
    force: !!$('deleteBranchForceCheck').checked,
  });
  $('deleteBranchName').value = '';
  log(`Branch ${res.branch} deleted${res.remoteDeleted ? ' locally and on the remote' : ' locally'}.`);
  await refreshAllLocal();
}

async function loadConflicts() {
  const data = await api('/api/git/conflicts');
  const container = $('conflictList');
  const conflicts = data.conflicts || [];
  container.innerHTML = '';
  if (!conflicts.length) {
    container.className = 'empty';
    container.textContent = data.merging ? 'Merging — no conflicted files left. Commit the merge when ready.' : 'No merge conflicts.';
    return data;
  }
  container.className = 'conflict-list';
  for (const path of conflicts) {
    const row = document.createElement('div');
    row.className = 'conflict-row';
    const name = document.createElement('span');
    name.className = 'path';
    name.textContent = path;
    const oursBtn = document.createElement('button');
    oursBtn.textContent = 'Ours';
    oursBtn.title = 'Keep our version of ' + path;
    oursBtn.onclick = () => run('Resolved ' + path + ' (ours)', async () => {
      const res = await api('/api/git/conflict/resolve', 'POST', { path, side: 'ours' });
      await loadConflicts();
      await status();
      if (res.allResolved) log('All conflicts resolved — click "Commit merge" to finish.');
    });
    const theirsBtn = document.createElement('button');
    theirsBtn.textContent = 'Theirs';
    theirsBtn.title = 'Keep their version of ' + path;
    theirsBtn.onclick = () => run('Resolved ' + path + ' (theirs)', async () => {
      const res = await api('/api/git/conflict/resolve', 'POST', { path, side: 'theirs' });
      await loadConflicts();
      await status();
      if (res.allResolved) log('All conflicts resolved — click "Commit merge" to finish.');
    });
    row.append(name, oursBtn, theirsBtn);
    container.append(row);
  }
  return data;
}

async function mergeBranch() {
  const branch = $('mergeBranchInput').value.trim();
  if (!branch) throw new Error('Enter the branch to merge');
  const res = await api('/api/git/merge', 'POST', { branch, noFF: $('mergeNoFFCheck').checked });
  if (await handlePossibleConflict(res, 'Merge')) {
    await status();
    await history();
    return res;
  }
  if (!res.ok) throw new Error(res.error || res.result || 'Merge failed');
  log(`Merged ${branch} ✓`);
  await status();
  await history();
  return res;
}

async function commitMerge() {
  const summary = $('summary').value.trim() ||
    `Merge branch '${$('mergeBranchInput').value.trim() || 'unknown'}'`;
  await api('/api/git/commit', 'POST', { summary, description: $('description').value.trim() });
  $('summary').value = '';
  $('description').value = '';
  log('Merge committed ✓');
  await status();
  await history();
  await loadConflicts();
}

async function createStash() {
  const res = await api('/api/git/stash/create', 'POST', { message: $('stashMessage').value.trim() || undefined });
  $('stashMessage').value = '';
  log('Stash created ✓ — ' + (res.result || '').split('\n')[0]);
  await loadStashList();
  await status();
}

async function loadStashList() {
  const data = await api('/api/git/stash/list');
  const container = $('stashList');
  const stashes = data.stashes || [];
  container.innerHTML = '';
  if (!stashes.length) {
    container.className = 'empty';
    container.textContent = 'No stashes.';
    return data;
  }
  container.className = '';
  for (const stash of stashes) {
    const row = document.createElement('div');
    row.className = 'stash-row';
    const label = document.createElement('span');
    label.className = 'path';
    label.textContent = `stash@{${stash.index}} — ${stash.message || '(no message)'}`;
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.onclick = () => run('Stash applied', async () => {
      await api('/api/git/stash/apply', 'POST', { index: stash.index });
      await loadStashList();
      await status();
    });
    const popBtn = document.createElement('button');
    popBtn.textContent = 'Pop';
    popBtn.title = 'Apply and remove this stash';
    popBtn.onclick = () => run('Stash popped', async () => {
      await api('/api/git/stash/apply', 'POST', { index: stash.index, pop: true });
      await loadStashList();
      await status();
    });
    const dropBtn = document.createElement('button');
    dropBtn.textContent = 'Drop';
    dropBtn.onclick = () => run('Stash dropped', async () => {
      await api('/api/git/stash/drop', 'POST', { index: stash.index });
      await loadStashList();
    });
    row.append(label, applyBtn, popBtn, dropBtn);
    container.append(row);
  }
  return data;
}

async function loadRemotes() {
  const data = await api('/api/git/remotes');
  const container = $('remoteList');
  const remotes = data.remotes || [];
  container.innerHTML = '';
  if (!remotes.length) {
    container.className = 'empty';
    container.textContent = 'No remotes configured.';
    return data;
  }
  container.className = '';
  for (const remote of remotes) {
    const row = document.createElement('div');
    row.className = 'remote-row';
    const name = document.createElement('b');
    name.textContent = remote.name;
    const url = document.createElement('span');
    url.className = 'path';
    url.textContent = remote.fetchUrl || remote.pushUrl || '';
    url.title = 'fetch: ' + (remote.fetchUrl || '') + ' · push: ' + (remote.pushUrl || '');
    const setUrlBtn = document.createElement('button');
    setUrlBtn.textContent = 'Edit URL';
    setUrlBtn.onclick = () => {
      $('setUrlRemoteName').value = remote.name;
      $('setUrlRemoteUrl').value = remote.fetchUrl || remote.pushUrl || '';
      $('setUrlRemoteUrl').focus();
    };
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => run('Remote removed', async () => {
      await api('/api/git/remote/remove', 'POST', { name: remote.name });
      await loadRemotes();
      await loadAheadBehind().catch(() => {});
    });
    row.append(name, url, setUrlBtn, removeBtn);
    container.append(row);
  }
  return data;
}

async function cloneRepo() {
  const url = $('cloneUrl').value.trim();
  const target = $('clonePath').value.trim();
  if (!url) throw new Error('Enter the repository URL to clone');
  if (!target) throw new Error('Enter the destination folder for the clone');
  const res = await api('/api/git/clone', 'POST', {
    url,
    path: target,
    branch: $('cloneBranch').value.trim() || undefined,
  });
  $('cloneUrl').value = '';
  $('cloneBranch').value = '';
  if (res.repository) $('repoPath').value = res.repository.path;
  log('Cloned ✓ — ' + (res.result || '').split('\n')[0]);
  await refreshAllLocal();
}

async function run(label, fn) {
  try {
    await fn();
    log(label + ' ✓');
  } catch (err) {
    log('ERROR: ' + err.message);
  }
}

async function refreshAllLocal() {
  await health();
  if (!localConnected) return;
  await status();
  await branches();
  await history();
  // v2.1 panels: each is best-effort so one failing endpoint (e.g. no
  // remote yet) never blocks the rest of the refresh.
  await loadAheadBehind().catch(() => {});
  await loadConflicts().catch(() => {});
  await loadStashList().catch(() => {});
  await loadRemotes().catch(() => {});
  await loadDiffSummary().catch(() => {});
  await loadTags().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* v3.0 — Notifications, profile, settings                             */
/* ------------------------------------------------------------------ */

async function loadNotifications() {
  let data;
  try {
    data = await gh('/notifications');
  } catch (err) {
    $('notifList').className = 'empty';
    $('notifList').textContent = 'Could not load notifications: ' + err.message +
      ' (needs bridge v3.0 — older bridges do not have this route).';
    return null;
  }
  const list = (data && data.notifications) || [];
  notifUnreadCount = list.filter((n) => n.unread).length;
  updateNotifBadge();
  const container = $('notifList');
  container.innerHTML = '';
  if (!list.length) {
    container.className = 'empty';
    container.textContent = 'No notifications.';
    return data;
  }
  container.className = '';
  for (const n of list) {
    const row = document.createElement('div');
    row.className = 'commititem';
    const title = document.createElement('b');
    title.textContent = (n.unread ? '● ' : '') + ((n.subject && n.subject.title) || 'Notification');
    const meta = document.createElement('small');
    meta.textContent = `${(n.repository && n.repository.full_name) || ''} · ${n.reason || ''} · ${timeAgo(n.updated_at)}`;
    row.append(title, meta);
    container.append(row);
  }
  return data;
}

function updateNotifBadge() {
  const badge = $('notifBadge');
  if (!settingsNotifications || notifUnreadCount <= 0) {
    badge.classList.add('hidden');
    badge.textContent = '';
    return;
  }
  badge.classList.remove('hidden');
  badge.textContent = String(notifUnreadCount);
}

async function markAllNotificationsRead() {
  await gh('/notifications/read', 'POST', {});
  notifUnreadCount = 0;
  updateNotifBadge();
  log('All notifications marked as read.');
  await loadNotifications();
}

async function loadProfile() {
  let data;
  try {
    data = await gh('/profile');
  } catch (err) {
    $('profileStats').textContent = 'Could not load profile: ' + err.message +
      ' (needs bridge v3.0 — older bridges do not have this route).';
    return null;
  }
  const p = (data && data.profile) || {};
  $('profileAvatar').src = p.avatar_url || '';
  $('profileAvatar').alt = p.login || '';
  $('profileName').textContent = p.name || p.login || '—';
  $('profileLogin').textContent = p.login ? '@' + p.login : '—';
  $('profileEmail').textContent = p.email || '—';
  $('profileBio').textContent = p.bio || '—';
  $('profileCompany').textContent = p.company || '—';
  $('profileBlog').textContent = p.blog || '—';
  $('profileLocation').textContent = p.location || '—';
  $('profileStats').textContent =
    `${p.public_repos != null ? p.public_repos + ' public repos' : ''}` +
    `${p.followers != null ? ' · ' + p.followers + ' followers' : ''}` +
    `${p.following != null ? ' · following ' + p.following : ''}` +
    `${p.created_at ? ' · joined ' + new Date(p.created_at).toLocaleDateString() : ''}`;
  const link = $('profileLink');
  if (p.html_url) {
    link.textContent = p.html_url;
    link.href = p.html_url;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  return data;
}

function applySettingsToUI() {
  $('settingsInterval').value = String($('autoUpdateInterval').value || '60');
  $('settingsDefaultBranch').value = settingsDefaultBranch;
  $('settingsAutoSync').checked = $('autoSyncToggle').checked;
  $('settingsNotifications').checked = settingsNotifications;
  updateNotifBadge();
}

async function saveSettings() {
  const intervalSeconds = Number($('settingsInterval').value) || 60;
  settingsDefaultBranch = $('settingsDefaultBranch').value.trim();
  settingsNotifications = !!$('settingsNotifications').checked;
  const autoSync = !!$('settingsAutoSync').checked;
  await chrome.storage.local.set({
    settingsDefaultBranch,
    settingsNotifications,
    autoUpdateInterval: intervalSeconds,
  });
  $('autoUpdateInterval').value = String(intervalSeconds);
  $('settingsStatus').textContent = 'Settings saved ✓' +
    (settingsDefaultBranch ? ` — default branch for new file trees: ${settingsDefaultBranch}.` : '');
  updateNotifBadge();
  // Push interval + auto-sync to the bridge (same endpoint as the
  // auto-update bar); a missing bridge route just logs the error.
  try {
    await setAutoUpdateUI($('autoUpdateToggle').checked, intervalSeconds, autoSync);
  } catch (err) {
    log('Settings saved locally; could not push auto-update to the bridge: ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* v3.0 — Local Git: cherry-pick / revert / reset, tags, local .zip   */
/* ------------------------------------------------------------------ */

async function cherryPickCommit() {
  const sha = $('cpSha').value.trim();
  if (!sha) throw new Error('Enter the commit SHA to cherry-pick');
  const res = await api('/api/git/cherry-pick', 'POST', { sha });
  $('cpSha').value = '';
  log('Cherry-picked ' + sha.slice(0, 7) + ' ✓');
  await status();
  await history();
  return res;
}

async function revertCommit() {
  const sha = $('cpSha').value.trim();
  if (!sha) throw new Error('Enter the commit SHA to revert');
  const res = await api('/api/git/revert', 'POST', { sha });
  $('cpSha').value = '';
  log('Reverted ' + sha.slice(0, 7) + ' ✓');
  await status();
  await history();
  return res;
}

async function resetBranch() {
  const mode = $('resetMode').value || 'mixed';
  const ref = $('resetRef').value.trim() || 'HEAD';
  if (mode === 'hard' && !$('resetHardConfirm').checked) {
    throw new Error('Hard reset discards uncommitted changes — tick the confirmation checkbox first.');
  }
  const res = await api('/api/git/reset', 'POST', { mode, ref, confirm: mode === 'hard' });
  $('resetHardConfirm').checked = false;
  log(`Reset (${mode}) to ${ref} ✓`);
  await status();
  await history();
  return res;
}

async function loadTags() {
  const data = await api('/api/git/tags');
  const container = $('tagList');
  const tags = data.tags || [];
  container.innerHTML = '';
  if (!tags.length) {
    container.className = 'empty';
    container.textContent = 'No tags yet.';
    return data;
  }
  container.className = '';
  for (const tag of tags) {
    const row = document.createElement('div');
    row.className = 'tag-row';
    const name = document.createElement('b');
    name.textContent = tag.name;
    const meta = document.createElement('span');
    meta.className = 'path';
    meta.textContent = tag.sha ? tag.sha.slice(0, 7) : '';
    const pushBtn = document.createElement('button');
    pushBtn.textContent = 'Push';
    pushBtn.onclick = () => run('Tag pushed', async () => {
      await api('/api/git/tag/push', 'POST', { name: tag.name });
      await loadTags();
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => run('Tag deleted', async () => {
      if (!confirm(`Delete local tag ${tag.name}?`)) return;
      await api('/api/git/tag/delete', 'POST', { name: tag.name });
      await loadTags();
    });
    row.append(name, meta, pushBtn, delBtn);
    container.append(row);
  }
  return data;
}

async function createTag() {
  const name = $('newTagName').value.trim();
  if (!name) throw new Error('Enter a name for the new tag');
  const res = await api('/api/git/tag/create', 'POST', {
    name,
    message: $('newTagMessage').value.trim() || undefined,
    ref: $('newTagRef').value.trim() || undefined,
  });
  $('newTagName').value = '';
  $('newTagMessage').value = '';
  $('newTagRef').value = '';
  log(`Tag ${name} created ✓`);
  await loadTags();
  return res;
}

async function deleteTag() {
  const name = $('deleteTagName').value.trim();
  if (!name) throw new Error('Enter the tag to delete');
  if (!confirm(`Delete local tag ${name}?`)) return;
  await api('/api/git/tag/delete', 'POST', { name });
  $('deleteTagName').value = '';
  log(`Tag ${name} deleted ✓`);
  await loadTags();
}

async function pushTag() {
  const name = $('pushTagName').value.trim();
  if (!name) throw new Error('Enter the tag to push');
  const res = await api('/api/git/tag/push', 'POST', {
    name,
    remote: $('syncRemote').value.trim() || 'origin',
  });
  $('pushTagName').value = '';
  log(`Tag ${name} pushed ✓`);
  return res;
}

async function exportLocalZip() {
  const branch = $('branch').textContent && $('branch').textContent !== '—' ? $('branch').textContent : undefined;
  const repoName = $('repoName').textContent && $('repoName').textContent !== 'Not connected' ? $('repoName').textContent : 'repo';
  const filename = `${repoName}-${branch || 'HEAD'}.zip`;
  log(`Exporting local repository as ${filename}…`);
  const res = await downloadBlob('/api/git/archive-zip', 'POST', { ref: branch }, filename);
  log(`Exported ${res.filename} (${formatNumber(res.size)} B)`);
  return res;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('navRepos').onclick = () => { showView(currentRepo ? 'repo' : 'repos'); };
$('navLocal').onclick = () => {
  showView('local');
  if (localConnected) {
    loadAheadBehind().catch(() => {});
    loadConflicts().catch(() => {});
    loadStashList().catch(() => {});
    loadRemotes().catch(() => {});
    loadDiffSummary().catch(() => {});
    loadTags().catch(() => {});
  }
};
$('navProfile').onclick = () => {
  showView('profile');
  loadProfile().catch((err) => log('ERROR: ' + err.message));
};
$('navSettings').onclick = () => {
  showView('settings');
  applySettingsToUI();
};
$('backToRepos').onclick = () => { currentRepo = null; showView('repos'); };
$('reconnectBtn').onclick = () => run('Reconnect', reconnectNow);

$('saveConnection').onclick = () => run('Connection saved', async () => {
  await chrome.storage.local.set({
    bridgeUrl: normalizeBase($('bridgeUrl').value),
    token: $('token').value.trim(),
  });
  stopEventStream();
  const ok = await health();
  if (!ok) throw new Error('Bridge not reachable at ' + normalizeBase($('bridgeUrl').value));
  startEventStream();
  await refreshGithubState();
  if (localConnected) await refreshAllLocal();
});

$('logoutBtn').onclick = () => run('Signed out', logoutGithub);

$('oauthConnectBtn').onclick = () => run('GitHub sign-in (OAuth Web)', startOAuthWeb);
$('oauthSaveBtn').onclick = () => run('OAuth App saved', saveOAuthConfig);
$('oauthCopyCallbackBtn').onclick = () => run('Callback URL copied', async () => {
  const url = $('oauthCallbackUrl').textContent.trim();
  if (!url || url === '—') throw new Error('Callback URL is not available yet — is the bridge reachable?');
  await navigator.clipboard.writeText(url);
});

$('loginPatBtn').onclick = () => run('GitHub sign-in', loginWithPat);
$('deviceFlowBtn').onclick = () => run('Device Flow started', startDeviceFlow);

// v3.0: live token-shape feedback while typing — an email or password
// pasted here gets the red warning immediately, before any request.
$('patInput').oninput = () => {
  const v = $('patInput').value.trim();
  if (!v) { $('patWarning').classList.add('hidden'); return; }
  if (looksLikeGithubToken(v)) {
    $('patWarning').classList.add('hidden');
  } else {
    $('patWarning').textContent = TOKEN_FORMAT_HINT;
    $('patWarning').classList.remove('hidden');
  }
};
$('diagBtn').onclick = () => run('Login diagnostics', loadLoginDiagnostics);
$('connDiagBtn').onclick = () => run('Connection diagnostics', runConnectionDiagnostics);
$('bridgeRetryBtn').onclick = () => run('Reconnect', reconnectNow);

$('globalSearch').oninput = () => { if (allRepos.length) renderRepos(); };
$('repoSearch').oninput = () => renderRepos();
$('repoFilter').onchange = () => renderRepos();
$('repoSort').onchange = () => renderRepos();

$('refreshRepos').onclick = () => run('Repositories refreshed', async () => {
  await loadRepos(false);
});
$('refreshReposForce').onclick = () => run('Repositories force-refreshed', async () => {
  await loadRepos(true);
});

$('autoUpdateToggle').onchange = () => run('Auto-update setting saved', async () => {
  const enabled = $('autoUpdateToggle').checked;
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI(enabled, intervalSeconds);
});
$('autoSyncToggle').onchange = () => run('Auto-sync setting saved', async () => {
  if (!$('autoUpdateToggle').checked) throw new Error('Enable Auto-update first — auto-sync only runs as part of it.');
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI(true, intervalSeconds, $('autoSyncToggle').checked);
});
$('autoUpdateInterval').onchange = () => run('Auto-update interval saved', async () => {
  const intervalSeconds = Number($('autoUpdateInterval').value) || 60;
  await setAutoUpdateUI($('autoUpdateToggle').checked, intervalSeconds);
});
$('manualRefresh').onclick = () => run('Manual refresh', async () => {
  const res = await gh('/refresh', 'POST', {});
  if (res.updated && res.updated.length) {
    log(`Manual refresh: ${res.updated.length} repo(s) updated — ${res.updated.map((u) => u.repo + '@' + u.newSha).join(', ')}`);
    await loadRepos(false);
  } else {
    log(`Manual refresh: ${res.checked || 0} repo(s) checked, no new commits.`);
  }
  await loadAutoUpdateStatus();
});

document.querySelectorAll('.tabs button').forEach((button) => {
  button.onclick = () => {
    const tab = button.dataset.tab;
    showRepoTab(tab);
    if (tab === 'commits') loadRepoCommits().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'branches') loadRepoBranches().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'issues') loadRepoIssues().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'pulls') loadRepoPulls().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'releases') loadReleases().catch((err) => log('ERROR: ' + err.message));
    if (tab === 'files') loadFileTree(currentPath).catch((err) => log('ERROR: ' + err.message));
    if (tab === 'overview') loadReadme().catch((err) => log('ERROR: ' + err.message));
  };
});

// v3.0 — repo detail actions + create repo + releases + code search.
$('createRepoBtn').onclick = () => run('Repository created', createRepo);
$('repoZipBtn').onclick = () => run('Repository .zip downloaded', downloadCurrentRepoZip);
$('repoStarBtn').onclick = () => run('Repository starred', starRepo);
$('repoUnstarBtn').onclick = () => run('Repository unstarred', unstarRepo);
$('repoForkBtn').onclick = () => run('Repository forked', forkRepo);
$('repoEditDescBtn').onclick = () => run('Description updated', editRepoDescription);
$('repoDeleteBtn').onclick = () => run('Repository deleted', deleteRepo);
$('reloadReleases').onclick = () => run('Releases refreshed', loadReleases);
$('createReleaseBtn').onclick = () => run('Release created', createRelease);
$('codeSearchBtn').onclick = () => run('Code search', searchCode);
$('fileSaveBtn').onclick = () => run('File saved', saveEditedFile);
$('newFileBtn').onclick = () => run('File created', createNewFile);
$('fileDeleteBtn').onclick = () => run('File deleted', deleteCurrentFile);
$('fileUploadInput').onchange = () => run('File uploaded', async () => {
  const input = $('fileUploadInput');
  const file = input.files && input.files[0];
  await uploadFileToRepo(file);
  input.value = '';
});
$('createIssueBtn').onclick = () => run('Issue created', createIssue);
$('issueDetailBackBtn').onclick = () => { $('issueDetail').classList.add('hidden'); $('issueList').classList.remove('hidden'); };
$('addCommentBtn').onclick = () => run('Comment added', addIssueComment);
$('issueCloseBtn').onclick = () => run('Issue state changed', toggleIssueState);
$('createPrBtn').onclick = () => run('Pull request created', createPullRequest);

// v3.0 — notifications bell + profile + settings.
$('notifBtn').onclick = () => {
  const panel = $('notifPanel');
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willShow);
  if (willShow) loadNotifications().catch((err) => log('ERROR: ' + err.message));
};
$('notifMarkReadBtn').onclick = () => run('Notifications marked as read', markAllNotificationsRead);
$('notifCloseBtn').onclick = () => $('notifPanel').classList.add('hidden');
$('reloadProfile').onclick = () => run('Profile refreshed', loadProfile);
$('saveSettingsBtn').onclick = () => run('Settings saved', saveSettings);

// v3.0 — local git: cherry-pick / revert / reset, tags, local .zip.
$('localZipBtn').onclick = () => run('Local repository exported as .zip', exportLocalZip);
$('cherryPickBtn').onclick = () => run('Cherry-pick completed', cherryPickCommit);
$('revertBtn').onclick = () => run('Revert completed', revertCommit);
$('resetBtn').onclick = () => run('Reset completed', resetBranch);
$('refreshTagsBtn').onclick = () => run('Tags refreshed', loadTags);
$('createTagBtn').onclick = () => run('Tag created', createTag);
$('deleteTagBtn').onclick = () => run('Tag deleted', deleteTag);
$('pushTagBtn').onclick = () => run('Tag pushed', pushTag);

$('reloadCommits').onclick = () => run('Commits refreshed', loadRepoCommits);
$('reloadBranches').onclick = () => run('Branches refreshed', loadRepoBranches);
$('reloadIssues').onclick = () => run('Issues refreshed', loadRepoIssues);
$('reloadPulls').onclick = () => run('Pull requests refreshed', loadRepoPulls);
$('fileBranchSelect').onchange = () => run('Branch file tree', () => loadFileTree(''));
$('fileUpBtn').onclick = () => run('Up one folder', () => {
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  return loadFileTree(parts.join('/'));
});

$('connectRepo').onclick = () => run('Repository connected', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Enter the full path to a local Git repository');
  const data = await api('/api/repo/select', 'POST', { path });
  if (data.repository) $('repoPath').value = data.repository.path;
  await refreshAllLocal();
});

$('refreshStatus').onclick = () => run('Status refreshed', status);

$('stageAll').onclick = () => run('All changes staged', async () => {
  await api('/api/git/stage-all', 'POST', {});
  await status();
});

$('unstageAll').onclick = () => run('All changes unstaged', async () => {
  const data = await api('/api/git/status');
  const staged = (data.files || []).filter((f) => f.staged);
  if (!staged.length) throw new Error('Nothing is staged');
  for (const file of staged) {
    await api('/api/git/unstage', 'POST', { path: file.path });
  }
  await status();
});

$('commit').onclick = () => run('Commit created', async () => {
  const summary = $('summary').value.trim();
  if (!summary) throw new Error('Commit summary is required');
  await api('/api/git/commit', 'POST', {
    summary,
    description: $('description').value.trim(),
    amend: $('amendCommit').checked,
    all: $('commitAll').checked,
  });
  $('summary').value = '';
  $('description').value = '';
  $('amendCommit').checked = false;
  await status();
  await history();
});

// v2.1: full Push / Pull / Sync — the old loop only sent {} and Pull was
// fast-forward only. Pull now honours the selected mode; Push honours
// set-upstream / force (double opt-in) / push-all / tags.
$('fetch').onclick = () => run('Fetch completed', doFetch);
$('pull').onclick = () => run('Pull completed', doPull);
$('push').onclick = () => run('Push completed', doPush);
$('syncBtn').onclick = () => run('Sync completed', doSync);
$('pushAllBtn').onclick = () => run('Push all branches completed', () => doPush({ pushAll: true }));
$('pushTagsBtn').onclick = () => run('Push tags completed', () => doPush({ tags: true }));
$('forcePushCheck').onchange = () => {
  $('forceConfirmCheck').disabled = !$('forcePushCheck').checked;
  if (!$('forcePushCheck').checked) $('forceConfirmCheck').checked = false;
};

$('switchBranch').onclick = () => run('Branch switched', async () => {
  const branch = $('branchSelect').value;
  if (!branch) throw new Error('Select a branch first');
  await api('/api/git/checkout', 'POST', { branch });
  await refreshAllLocal();
});

$('loadHistory').onclick = () => run('History refreshed', () => history(1));
$('historyPrevBtn').onclick = () => run('History refreshed', () => history(historyPage - 1));
$('historyNextBtn').onclick = () => run('History refreshed', () => history(historyPage + 1));

$('refreshBranchesBtn').onclick = () => run('Branches refreshed', branches);
$('createBranchBtn').onclick = () => run('Branch created', createBranch);
$('renameBranchBtn').onclick = () => run('Branch renamed', renameBranch);
$('deleteBranchBtn').onclick = () => run('Branch deleted', deleteBranch);

$('mergeBtn').onclick = () => run('Merge completed', mergeBranch);
$('refreshConflictsBtn').onclick = () => run('Conflicts refreshed', loadConflicts);
$('abortMergeBtn').onclick = () => run('Merge aborted', async () => {
  await api('/api/git/merge/abort', 'POST', {});
  await loadConflicts();
  await status();
});
$('commitMergeBtn').onclick = () => run('Merge committed', commitMerge);

$('createStashBtn').onclick = () => run('Stash created', createStash);
$('refreshStashBtn').onclick = () => run('Stash list refreshed', loadStashList);

$('refreshRemotesBtn').onclick = () => run('Remotes refreshed', loadRemotes);
$('addRemoteBtn').onclick = () => run('Remote added', async () => {
  const name = $('newRemoteName').value.trim();
  const url = $('newRemoteUrl').value.trim();
  if (!name || !url) throw new Error('Enter both a remote name and a URL');
  await api('/api/git/remote/add', 'POST', { name, url });
  $('newRemoteName').value = '';
  $('newRemoteUrl').value = '';
  await loadRemotes();
});
$('setUrlRemoteBtn').onclick = () => run('Remote URL updated', async () => {
  const name = $('setUrlRemoteName').value.trim();
  const url = $('setUrlRemoteUrl').value.trim();
  if (!name || !url) throw new Error('Enter both a remote name and the new URL');
  await api('/api/git/remote/set-url', 'POST', { name, url });
  $('setUrlRemoteName').value = '';
  $('setUrlRemoteUrl').value = '';
  await loadRemotes();
});

$('cloneBtn').onclick = () => run('Clone completed', cloneRepo);

$('copyPath').onclick = () => run('Repository path copied', async () => {
  const path = $('repoPath').value.trim();
  if (!path) throw new Error('Connect a repository first');
  await navigator.clipboard.writeText(path);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  const c = await cfg();
  $('bridgeUrl').value = c.bridgeUrl;
  $('token').value = c.token;
  $('autoUpdateToggle').checked = !!c.autoUpdateEnabled;
  if (c.autoUpdateInterval) $('autoUpdateInterval').value = String(c.autoUpdateInterval);
  // v3.0 settings from storage.
  settingsDefaultBranch = c.settingsDefaultBranch;
  settingsNotifications = c.settingsNotifications;
  $('settingsInterval').value = String(c.autoUpdateInterval);
  $('settingsDefaultBranch').value = settingsDefaultBranch;
  $('settingsNotifications').checked = settingsNotifications;
  updateNotifBadge();

  showView('repos');
  // v3.0.1: the dashboard only works inside the extension. Opened as a
  // plain file (file://) or a normal web page, the browser enforces
  // CORS against the bridge and every sign-in fails with "Failed to
  // fetch" — say so clearly instead of letting the user guess. The
  // toggle sets the state explicitly both ways (not just "remove when
  // outside") so the banner can never be stuck in the wrong state.
  $('outsideExtensionNotice').classList.toggle('hidden', isExtensionContext());
  // v3.0.1: sign-in stays disabled until the first health check proves
  // the bridge is up.
  setLoginEnabled(false);
  startHealthPoll();
  const ok = await health();
  if (!ok) {
    log('Bridge offline. ' + BRIDGE_START_SHORT + ' Trang này sẽ tự kết nối lại khi bridge chạy.');
    return;
  }
  startEventStream();
  if (!c.token) {
    log('Bridge online. Paste the token printed by the bridge, then click Connect Bridge.');
    return;
  }
  try {
    await refreshGithubState();
  } catch (err) {
    log('ERROR: ' + err.message);
  }
  if (localConnected) {
    try {
      await refreshAllLocal();
    } catch (err) {
      log('ERROR: ' + err.message);
    }
  }
})();
