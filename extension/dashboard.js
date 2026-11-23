'use strict';

/*
 * PixiJS GitHub Desktop Sync — dashboard v2.0.0
 *
 * A GitHub-like workspace in the browser:
 *   - Repositories tab: ALL GitHub repositories (search / filter / sort),
 *     repo detail (README, file tree + viewer, commits, branches,
 *     issues, pull requests), auto-update with new-commit detection.
 *   - Local Git tab: the v1 local-git client (status, stage, commit,
 *     branches, history, diff, fetch/pull/push).
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
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:17321', token: '', autoUpdateEnabled: false, autoUpdateInterval: 60, lastRepo: '' };

let bridgeState = 'disconnected'; // 'connected' | 'reconnecting' | 'disconnected'
let healthTimer = null;
let sseSource = null;
let sseBackoffMs = 1000;
let sseBackoffTimer = null;
let healthFailures = 0;

let ghUser = null; // public profile from /api/github/me, or null
let allRepos = []; // full repo list from /api/github/repos/all
let reposLoadedAt = null;
let currentRepo = null; // { owner, repo, full_name, default_branch }
let currentPath = ''; // path inside the file tree
let selectedFile = '';
let localConnected = false;
let updateBadgeCount = 0;

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

/* ------------------------------------------------------------------ */
/* Bridge API                                                          */
/* ------------------------------------------------------------------ */

async function fetchJson(url, options) {
  const res = await fetch(url, options);
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
    const res = await fetch(c.bridgeUrl + '/health');
    if (!res.ok) throw new Error('offline');
    const data = await res.json();
    healthFailures = 0;

    const wasDown = bridgeState !== 'connected';
    setBridgeState('connected');
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
  } catch (_) {
    healthFailures += 1;
    // First failure while connected -> reconnecting (retries keep running).
    // Failure at boot -> disconnected (nothing ever worked yet).
    if (bridgeState === 'connected' || healthFailures > 1) {
      setBridgeState('reconnecting', `Bridge unreachable (attempt ${healthFailures}). Retrying…`);
    } else {
      setBridgeState('disconnected', 'Bridge offline. Start it with: node bridge/bridge-server.js');
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
      }
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
/* GitHub sign-in                                                      */
/* ------------------------------------------------------------------ */

function showUser(user) {
  ghUser = user || null;
  if (user && user.login) {
    $('userChip').classList.remove('hidden');
    $('userAvatar').src = user.avatar_url || '';
    $('userAvatar').alt = user.login;
    $('userLogin').textContent = user.login;
    $('loginPanel').classList.add('hidden');
  } else {
    $('userChip').classList.add('hidden');
    $('userAvatar').src = '';
    $('userLogin').textContent = '—';
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
    const me = await gh('/me');
    if (me.authed && me.user) {
      showUser(me.user);
      updateRateLimit(me.rateLimit);
      await loadRepos(false);
      await loadAutoUpdateStatus();
    } else {
      showUser(null);
      setRepoListEmpty('Sign in to GitHub to list your repositories.');
    }
  } catch (err) {
    if (/not connected|Missing bridge token/i.test(err.message)) {
      showUser(null);
      setRepoListEmpty('Sign in to GitHub to list your repositories.');
    } else {
      throw err;
    }
  }
}

let devicePollTimer = null;

async function loginWithPat() {
  const token = $('patInput').value.trim();
  if (!token) throw new Error('Paste a Personal Access Token first');
  const res = await gh('/auth', 'POST', { token });
  $('patInput').value = '';
  showUser(res.user);
  log(`Signed in to GitHub as ${res.user.login}`);
  await loadRepos(true);
  await loadAutoUpdateStatus();
}

async function startDeviceFlow() {
  const res = await gh('/auth/device/start', 'POST', {});
  $('deviceBox').classList.remove('hidden');
  $('deviceCode').textContent = res.user_code || '—';
  $('deviceStatus').textContent = 'Waiting for you to approve on GitHub…';
  const verifyUrl = res.verification_uri_complete || res.verification_uri;
  $('deviceOpenBtn').onclick = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: verifyUrl });
    else if (typeof window !== 'undefined' && window.open) window.open(verifyUrl, '_blank');
  };
  if (devicePollTimer) clearInterval(devicePollTimer);
  const interval = Math.max(5, Number(res.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(res.expires_in) || 900) * 1000;
  devicePollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
      $('deviceStatus').textContent = 'The code expired. Click "Sign in with Device Flow" again.';
      return;
    }
    try {
      const poll = await gh('/auth/device/poll', 'POST', { device_code: res.device_code });
      if (poll.status === 'authorized') {
        clearInterval(devicePollTimer);
        devicePollTimer = null;
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
      $('deviceStatus').textContent = 'Device Flow failed: ' + err.message;
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
/* Auto-update                                                         */
/* ------------------------------------------------------------------ */

function showAutoUpdate(status) {
  if (!status) return;
  const el = $('autoUpdateState');
  if (!status.enabled) {
    el.textContent = 'Auto-update is off.';
    return;
  }
  const last = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleTimeString() : '—';
  el.textContent = `On · every ${status.intervalSeconds}s · last check ${last} · next ${next}` +
    (status.updatesFound ? ` · ${status.updatesFound} update(s) found` : '') +
    (status.lastError ? ` · last error: ${status.lastError}` : '');
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

async function setAutoUpdateUI(enabled, intervalSeconds) {
  const status = await gh('/auto-update', 'POST', { enabled, intervalSeconds });
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
  $('navRepos').classList.toggle('active', name === 'repos' || name === 'repo');
  $('navLocal').classList.toggle('active', name === 'local');
}

function showRepoTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  for (const name of ['overview', 'files', 'commits', 'branches', 'issues', 'pulls']) {
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
    row.append(title, meta);
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
    return;
  }

  for (const branch of list) {
    const option = document.createElement('option');
    option.value = branch.name;
    option.textContent = (branch.current ? '● ' : '') + branch.name;
    select.append(option);
  }

  if (previous && list.some((b) => b.name === previous)) select.value = previous;
}

async function history() {
  const data = await api('/api/git/log');
  const container = $('history');
  container.innerHTML = '';

  const commits = data.commits || [];
  if (!commits.length) {
    container.className = 'empty';
    container.textContent = 'No commits yet';
    return;
  }

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
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('navRepos').onclick = () => { showView(currentRepo ? 'repo' : 'repos'); };
$('navLocal').onclick = () => { showView('local'); };
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

$('loginPatBtn').onclick = () => run('GitHub sign-in', loginWithPat);
$('deviceFlowBtn').onclick = () => run('Device Flow started', startDeviceFlow);

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
    if (tab === 'files') loadFileTree(currentPath).catch((err) => log('ERROR: ' + err.message));
    if (tab === 'overview') loadReadme().catch((err) => log('ERROR: ' + err.message));
  };
});

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
  await api('/api/git/commit', 'POST', { summary, description: $('description').value.trim() });
  $('summary').value = '';
  $('description').value = '';
  await status();
  await history();
});

for (const action of ['fetch', 'pull', 'push']) {
  $(action).onclick = () => run(action.toUpperCase() + ' completed', async () => {
    await api('/api/git/' + action, 'POST', {});
    await status();
    await history();
  });
}

$('switchBranch').onclick = () => run('Branch switched', async () => {
  const branch = $('branchSelect').value;
  if (!branch) throw new Error('Select a branch first');
  await api('/api/git/checkout', 'POST', { branch });
  await refreshAllLocal();
});

$('loadHistory').onclick = () => run('History refreshed', history);

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

  showView('repos');
  startHealthPoll();
  const ok = await health();
  if (!ok) {
    log('Bridge offline. Start it with: node bridge/bridge-server.js — this page will reconnect automatically.');
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
