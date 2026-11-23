#!/usr/bin/env node
'use strict';

/*
 * PixiJS GitHub Desktop Sync - Local Git + GitHub Bridge
 * v2.1.0
 *
 * A dependency-free local bridge (Node >= 18, only built-in modules) that
 * exposes two things to the companion Chrome extension:
 *
 *   1. LOCAL GIT  - v1 feature set + v2.1 push/pull expansion: pull
 *      (merge / rebase / ff-only), push (upstream / --force-with-lease
 *      with explicit confirm / --all / tags), one-click sync, ahead/
 *      behind, branch create/rename/delete (local + remote), merge +
 *      conflict resolve (ours/theirs) + abort, stash, commit --amend,
 *      diff summary, paginated log, remotes, and clone from URL.
 *   2. GITHUB API - v2: sign in with a Personal Access Token, GitHub
 *      OAuth Device Flow, or (v2.1) OAuth Web Application Flow with a
 *      real GitHub account; list ALL repositories (paginated), inspect
 *      a repository (branches, commits, file tree, file contents,
 *      README, issues, pull requests), create/update files, and
 *      AUTO-UPDATE: the bridge polls GitHub on a schedule (ETag-aware,
 *      so unchanged polls cost no rate limit), pushes change events to
 *      the extension over Server-Sent Events, and (v2.1, opt-in) can
 *      auto-sync (pull) the local repo when its remote gains commits.
 *
 * Design rules (kept from v1, extended):
 *  - Binds to 127.0.0.1 only; never exposed to the network.
 *  - Every /api/* route requires the bridge bearer token
 *    (Authorization: Bearer <token>, timing-safe compare).
 *    Exception: /api/github/oauth/callback is a browser redirect from
 *    github.com, so it cannot carry the token — it is protected by a
 *    one-time, expiring `state` value instead, and the server only
 *    listens on 127.0.0.1.
 *  - The GitHub PAT / OAuth access token is stored in
 *    bridge/.github-config.json (0600, git-ignored) and is NEVER
 *    returned to the extension, never logged. The OAuth App
 *    client_secret lives in bridge/.github-oauth.json (0600,
 *    git-ignored) and is NEVER returned or logged either. The
 *    extension only ever learns "authed: true/false" + the public
 *    user profile (login, name, avatar_url) + the sign-in method.
 *  - Git is always spawned with shell:false (no shell injection).
 *  - Paths are validated as repository-relative (no absolute, no traversal).
 *  - No reset / plain --force / arbitrary shell endpoint. The only
 *    forceful operation is `git push --force-with-lease`, and only when
 *    the caller passes confirm=true explicitly.
 *  - GitHub requests use the global fetch (Node >= 18) with a timeout and
 *    honour ETag/If-None-Match so auto-update polling is cheap.
 *
 * Environment overrides (useful for tests):
 *  - BRIDGE_PORT          (default 17321)
 *  - BRIDGE_DATA_DIR      directory holding .bridge-token,
 *                         .bridge-state.json, .github-config.json and
 *                         .github-oauth.json
 *                         (default: the bridge/ folder itself)
 *  - GITHUB_API_BASE      (default https://api.github.com)
 *  - GITHUB_OAUTH_BASE    (default https://github.com)
 *  - GITHUB_OAUTH_CLIENT_ID / GITHUB_CLIENT_ID
 *                         OAuth App client id, enables Device Flow and
 *                         the OAuth Web Flow. Without it, both flows
 *                         answer 400 with setup help.
 *  - GITHUB_OAUTH_CLIENT_SECRET
 *                         OAuth App client secret, needed for the
 *                         Web Flow token exchange (never logged).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '2.1.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 17321);
const ROOT = path.resolve(__dirname);
const DATA_DIR = process.env.BRIDGE_DATA_DIR ? path.resolve(process.env.BRIDGE_DATA_DIR) : ROOT;
const TOKEN_FILE = path.join(DATA_DIR, '.bridge-token');
const STATE_FILE = path.join(DATA_DIR, '.bridge-state.json');
const GH_CONFIG_FILE = path.join(DATA_DIR, '.github-config.json');
const GH_OAUTH_FILE = path.join(DATA_DIR, '.github-oauth.json');
const GITHUB_API_BASE = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const GITHUB_OAUTH_BASE = (process.env.GITHUB_OAUTH_BASE || 'https://github.com').replace(/\/+$/, '');
const GITHUB_CLIENT_ID = String(process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '').trim();
const GITHUB_CLIENT_SECRET = String(process.env.GITHUB_OAUTH_CLIENT_SECRET || '').trim();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // a login attempt lives 10 minutes

const GIT_TIMEOUT_MS = 120000; // hard cap so a credential prompt can never hang the bridge
const GH_TIMEOUT_MS = 20000; // GitHub API calls must fail fast
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 400000;
const GH_SCOPES = 'repo read:user';
const AUTO_UPDATE_MIN_SECONDS = 15;
const AUTO_UPDATE_MAX_SECONDS = 3600;
const AUTO_UPDATE_DEFAULT_SECONDS = 60;
const REPO_LIST_CACHE_MS = 60 * 1000;
const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function redactToken(value) {
  // Never print a token: show only its shape (ghp_…xxxx).
  const s = String(value || '');
  if (s.length <= 8) return s ? '****' : '(none)';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Bridge token (extension <-> bridge)                                 */
/* ------------------------------------------------------------------ */

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[a-f0-9]{32,}$/i.test(existing)) {
        try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
        return existing;
      }
    }
  } catch (_) {}
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  return fresh;
}

const TOKEN = loadToken();

function tokenMatches(header) {
  if (typeof header !== 'string') return false;
  const expected = `Bearer ${TOKEN}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Persistent state (repo path survives a bridge restart)              */
/* ------------------------------------------------------------------ */

let repoPath = null;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = safeJsonParse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.repoPath === 'string' && raw.repoPath) {
      const abs = path.resolve(raw.repoPath);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) repoPath = abs;
    }
  } catch (_) {}
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ repoPath }, null, 2), { mode: 0o600 });
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* GitHub config (PAT + auto-update settings). The PAT is NEVER        */
/* returned to any client and NEVER logged.                            */
/* ------------------------------------------------------------------ */

let ghConfig = {
  token: null,
  user: null,
  authedAt: null,
  authMethod: null, // 'pat' | 'device' | 'oauth-web'
  scopes: null, // e.g. 'repo, read:user' (from the x-oauth-scopes response header)
  autoUpdate: { enabled: false, intervalSeconds: AUTO_UPDATE_DEFAULT_SECONDS, autoSync: false },
};

function loadGhConfig() {
  try {
    if (!fs.existsSync(GH_CONFIG_FILE)) return;
    const raw = safeJsonParse(fs.readFileSync(GH_CONFIG_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    ghConfig = {
      token: typeof raw.token === 'string' && raw.token ? raw.token : null,
      user: raw.user && typeof raw.user === 'object' ? raw.user : null,
      authedAt: typeof raw.authedAt === 'string' ? raw.authedAt : null,
      authMethod: ['pat', 'device', 'oauth-web'].includes(raw.authMethod) ? raw.authMethod : null,
      scopes: typeof raw.scopes === 'string' && raw.scopes ? raw.scopes : null,
      autoUpdate: {
        enabled: !!(raw.autoUpdate && raw.autoUpdate.enabled),
        intervalSeconds: clampInterval(raw.autoUpdate && raw.autoUpdate.intervalSeconds),
        autoSync: !!(raw.autoUpdate && raw.autoUpdate.autoSync),
      },
    };
    try { fs.chmodSync(GH_CONFIG_FILE, 0o600); } catch (_) {}
  } catch (_) {}
}

function saveGhConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GH_CONFIG_FILE, JSON.stringify(ghConfig, null, 2), { mode: 0o600 });
    try { fs.chmodSync(GH_CONFIG_FILE, 0o600); } catch (_) {}
  } catch (err) {
    log('Could not save GitHub config:', err.message);
  }
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTO_UPDATE_DEFAULT_SECONDS;
  return Math.min(AUTO_UPDATE_MAX_SECONDS, Math.max(AUTO_UPDATE_MIN_SECONDS, Math.round(n)));
}

function ghAuthed() {
  return !!(ghConfig.token && ghConfig.user);
}

function publicUser() {
  if (!ghConfig.user) return null;
  const u = ghConfig.user;
  return {
    login: u.login || null,
    id: u.id || null,
    name: u.name || null,
    avatar_url: u.avatar_url || null,
    html_url: u.html_url || null,
    type: u.type || null,
    public_repos: typeof u.public_repos === 'number' ? u.public_repos : null,
    followers: typeof u.followers === 'number' ? u.followers : null,
    following: typeof u.following === 'number' ? u.following : null,
    created_at: u.created_at || null,
    authMethod: ghConfig.authMethod || null,
    scopes: ghConfig.scopes || null,
  };
}

/* ------------------------------------------------------------------ */
/* OAuth App config (client_id + client_secret for the Web Flow).      */
/* Stored in bridge/.github-oauth.json (0600, git-ignored). The        */
/* secret is NEVER returned to any client and NEVER logged.            */
/* Env vars (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET)     */
/* take precedence over the file, so tests and CI can inject them.    */
/* ------------------------------------------------------------------ */

let oauthAppConfig = { clientId: null, clientSecret: null };

function loadOAuthAppConfig() {
  try {
    if (!fs.existsSync(GH_OAUTH_FILE)) return;
    const raw = safeJsonParse(fs.readFileSync(GH_OAUTH_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    oauthAppConfig = {
      clientId: typeof raw.clientId === 'string' && raw.clientId ? raw.clientId : null,
      clientSecret: typeof raw.clientSecret === 'string' && raw.clientSecret ? raw.clientSecret : null,
    };
    try { fs.chmodSync(GH_OAUTH_FILE, 0o600); } catch (_) {}
  } catch (_) {}
}

function saveOAuthAppConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GH_OAUTH_FILE, JSON.stringify(oauthAppConfig, null, 2), { mode: 0o600 });
    try { fs.chmodSync(GH_OAUTH_FILE, 0o600); } catch (_) {}
  } catch (err) {
    log('Could not save OAuth App config:', err.message);
  }
}

function oauthClientId() {
  return GITHUB_CLIENT_ID || oauthAppConfig.clientId || null;
}

function oauthClientSecret() {
  return GITHUB_CLIENT_SECRET || oauthAppConfig.clientSecret || null;
}

function oauthWebConfigured() {
  return !!(oauthClientId() && oauthClientSecret());
}

function oauthCallbackUrl() {
  return `http://${HOST}:${PORT}/api/github/oauth/callback`;
}

// One-time login states for the Web Flow (state -> createdAt ms).
// A state is consumed on first use, so a replayed callback is rejected.
const pendingOAuthStates = new Map();

function mintOAuthState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingOAuthStates.set(state, Date.now());
  // Opportunistic cleanup of expired states.
  const now = Date.now();
  for (const [s, at] of pendingOAuthStates) {
    if (now - at > OAUTH_STATE_TTL_MS) pendingOAuthStates.delete(s);
  }
  return state;
}

function consumeOAuthState(state) {
  const at = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  if (!at) return false;
  return Date.now() - at <= OAUTH_STATE_TTL_MS;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function corsOrigin(req) {
  const origin = req.headers.origin || '';
  // Only the extension itself (and its own pages) may talk to the bridge.
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
    return origin;
  }
  // Requests without an Origin header (curl, the extension's own fetch in some
  // contexts) are allowed; the bearer token is still required.
  return '';
}

function send(req, res, status, data) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const origin = corsOrigin(req);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

/* ------------------------------------------------------------------ */
/* Server-Sent Events: live bridge -> extension channel.               */
/* The extension connects with EventSource and auto-reconnects; the    */
/* bridge pushes auto-update ticks, new-commit notices, auth changes   */
/* and rate-limit warnings. The token travels as a query parameter     */
/* because EventSource cannot set request headers.                     */
/* ------------------------------------------------------------------ */

const sseClients = new Set();

function sseBroadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}

function sseSend(res, type, payload) {
  try { res.write(`event: ${type}\ndata: ${JSON.stringify(payload || {})}\n\n`); } catch (_) {}
}

function sseHeartbeat() {
  for (const res of [...sseClients]) {
    try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); }
  }
}
setInterval(sseHeartbeat, 25000).unref();

/* ------------------------------------------------------------------ */
/* GitHub API client (server-side; the PAT never leaves the bridge)    */
/* ------------------------------------------------------------------ */

const ghCache = new Map(); // url -> { etag, data, at }
let lastRateLimit = { limit: null, remaining: null, reset: null, used: null };

class GhError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body || null;
  }
}

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}`,
    Authorization: `Bearer ${token}`,
  };
}

function noteRateLimit(headers) {
  if (!headers) return;
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
  const limit = Number(get('x-ratelimit-limit'));
  const remaining = Number(get('x-ratelimit-remaining'));
  const reset = Number(get('x-ratelimit-reset'));
  const used = Number(get('x-ratelimit-used'));
  if (Number.isFinite(limit)) lastRateLimit.limit = limit;
  if (Number.isFinite(remaining)) lastRateLimit.remaining = remaining;
  if (Number.isFinite(reset)) lastRateLimit.reset = reset;
  if (Number.isFinite(used)) lastRateLimit.used = used;
  if (Number.isFinite(remaining) && remaining <= 5) {
    sseBroadcast('rate-limit', { ...lastRateLimit, at: new Date().toISOString() });
  }
}

function parseLinkHeader(header) {
  // <url>; rel="next", <url>; rel="last"  ->  { next, last, first, prev }
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

function pageNumberFromUrl(url) {
  try {
    const n = Number(new URL(url).searchParams.get('page'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

/**
 * One GitHub API call. `opts.useCache` enables the ETag cache: a 304
 * returns the cached body and { notModified: true }.
 */
async function ghRequest(apiPath, opts = {}) {
  const token = opts.token || ghConfig.token;
  if (!token) throw new GhError(401, 'GitHub is not connected. Sign in with a Personal Access Token first.');
  const method = opts.method || 'GET';
  const url = apiPath.startsWith('http') ? apiPath : GITHUB_API_BASE + apiPath;
  const headers = ghHeaders(token);
  if (opts.useCache) {
    const cached = ghCache.get(url);
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
  }
  const init = { method, headers, signal: AbortSignal.timeout(opts.timeout || GH_TIMEOUT_MS) };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'TimeoutError') throw new GhError(504, `GitHub request timed out (${method} ${apiPath})`);
    throw new GhError(502, `Could not reach GitHub: ${err.message}`);
  }
  noteRateLimit(res.headers);
  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;
  if (res.status === 304 && opts.useCache) {
    const cached = ghCache.get(url);
    return { status: 304, data: cached ? cached.data : null, notModified: true, headers: res.headers, links: {} };
  }
  if (opts.useCache && res.headers.get('etag')) {
    ghCache.set(url, { etag: res.headers.get('etag'), data, at: Date.now() });
  }
  if (!res.ok) {
    const message = (data && data.message) || `GitHub API error ${res.status}`;
    if (res.status === 401) {
      throw new GhError(401, 'GitHub token was rejected (401). The token may be expired or revoked — sign in again.');
    }
    if (res.status === 403 && /rate limit/i.test(message)) {
      const resetAt = lastRateLimit.reset ? new Date(lastRateLimit.reset * 1000).toISOString() : 'unknown';
      throw new GhError(403, `GitHub rate limit exceeded. Limit resets at ${resetAt}.`);
    }
    if (res.status === 404) throw new GhError(404, data && data.message ? data.message : 'Not found on GitHub (404)');
    throw new GhError(res.status, message, data);
  }
  return {
    status: res.status,
    data,
    notModified: false,
    headers: res.headers,
    links: parseLinkHeader(res.headers.get('link')),
  };
}

async function ghValidateToken(token) {
  // GET /user both validates the token and returns the public profile.
  // The x-oauth-scopes header tells the UI which permissions the token has.
  const ghRes = await ghRequest('/user', { token, timeout: GH_TIMEOUT_MS });
  const scopes = ghRes.headers && typeof ghRes.headers.get === 'function'
    ? (ghRes.headers.get('x-oauth-scopes') || '')
    : '';
  return { user: ghRes.data, scopes: scopes ? scopes.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : null };
}

function signInWithToken(token, user, scopes, authMethod) {
  ghConfig.token = token;
  ghConfig.user = user;
  ghConfig.authedAt = new Date().toISOString();
  ghConfig.authMethod = authMethod;
  ghConfig.scopes = scopes || null;
  saveGhConfig();
  sseBroadcast('github-auth', { authed: true, login: user.login, authMethod, at: ghConfig.authedAt });
  log(`GitHub signed in as ${user.login} (${authMethod}, scopes: ${scopes || 'unknown'})`);
}

/* --- normalisers: the extension only ever sees these shapes --- */

function normalizeRepo(r) {
  if (!r) return null;
  return {
    id: r.id ?? null,
    name: r.name || '',
    full_name: r.full_name || r.name || '',
    owner: { login: (r.owner && r.owner.login) || '', avatar_url: (r.owner && r.owner.avatar_url) || '' },
    description: r.description || '',
    language: r.language || null,
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    open_issues_count: r.open_issues_count || 0,
    watchers_count: r.watchers_count || 0,
    private: !!r.private,
    fork: !!r.fork,
    archived: !!r.archived,
    disabled: !!r.disabled,
    default_branch: r.default_branch || 'main',
    pushed_at: r.pushed_at || null,
    updated_at: r.updated_at || null,
    created_at: r.created_at || null,
    html_url: r.html_url || '',
    clone_url: r.clone_url || '',
    ssh_url: r.ssh_url || '',
    size: r.size || 0,
    license: (r.license && (r.license.spdx_id || r.license.name)) || null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    visibility: r.visibility || (r.private ? 'private' : 'public'),
  };
}

function normalizeCommit(c) {
  if (!c) return null;
  return {
    sha: c.sha || '',
    short: (c.sha || '').slice(0, 7),
    message: (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : (c.message || '')),
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
    author_login: (c.author && c.author.login) || null,
    author_avatar: (c.author && c.author.avatar_url) || null,
    date: (c.commit && c.commit.author && c.commit.author.date) || c.date || null,
    html_url: c.html_url || '',
  };
}

function normalizeBranch(b) {
  if (!b) return null;
  return {
    name: b.name || '',
    protected: !!(b.protected || (b.protection && b.protection.enabled)),
    sha: (b.commit && b.commit.sha) || '',
  };
}

function normalizeContentEntry(e) {
  if (!e) return null;
  return {
    name: e.name || '',
    path: e.path || '',
    type: e.type || 'file', // 'file' | 'dir' | 'symlink' | 'submodule'
    size: e.size || 0,
    sha: e.sha || '',
    html_url: e.html_url || '',
    download_url: e.download_url || null,
  };
}

function normalizeIssue(i) {
  if (!i) return null;
  return {
    number: i.number,
    title: i.title || '',
    state: i.state || '',
    html_url: i.html_url || '',
    user: (i.user && i.user.login) || '',
    created_at: i.created_at || null,
    updated_at: i.updated_at || null,
    comments: i.comments || 0,
    labels: Array.isArray(i.labels) ? i.labels.map((l) => (typeof l === 'string' ? l : l.name)) : [],
    is_pull_request: !!i.pull_request,
  };
}

/* --- repo list cache (used by the auto-updater + /repos/all) --- */

let repoListCache = { at: 0, repos: [] };

async function fetchAllRepos(force) {
  if (!force && repoListCache.repos.length && Date.now() - repoListCache.at < REPO_LIST_CACHE_MS) {
    return { repos: repoListCache.repos, cached: true };
  }
  const all = [];
  let page = 1;
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const res = await ghRequest(`/user/repos?per_page=100&page=${page}&type=all&sort=updated&direction=desc`, { useCache: false });
    const pageRepos = Array.isArray(res.data) ? res.data.map(normalizeRepo) : [];
    all.push(...pageRepos);
    if (!res.links.next) break;
    const nextPage = pageNumberFromUrl(res.links.next);
    if (!nextPage || nextPage <= page) break;
    page = nextPage;
  }
  repoListCache = { at: Date.now(), repos: all };
  return { repos: all, cached: false };
}

/* ------------------------------------------------------------------ */
/* Auto-update: poll GitHub for new commits, ETag-aware                */
/* ------------------------------------------------------------------ */

const autoUpdate = {
  enabled: false,
  intervalSeconds: AUTO_UPDATE_DEFAULT_SECONDS,
  autoSync: false,
  lastRunAt: null,
  lastChangeAt: null,
  reposChecked: 0,
  updatesFound: 0,
  nextRunAt: null,
  lastError: null,
  timer: null,
  lastShaByRepo: new Map(), // full_name -> sha
  lastAutoSync: null, // { at, repo, branch, commitsPulled, error } or null
};

function autoUpdateStatus() {
  return {
    enabled: autoUpdate.enabled,
    intervalSeconds: autoUpdate.intervalSeconds,
    autoSync: autoUpdate.autoSync,
    lastRunAt: autoUpdate.lastRunAt,
    lastChangeAt: autoUpdate.lastChangeAt,
    reposChecked: autoUpdate.reposChecked,
    updatesFound: autoUpdate.updatesFound,
    nextRunAt: autoUpdate.nextRunAt,
    lastError: autoUpdate.lastError,
    trackedRepos: autoUpdate.lastShaByRepo.size,
    lastAutoSync: autoUpdate.lastAutoSync,
  };
}

async function autoUpdateTick(manual) {
  const started = new Date().toISOString();
  autoUpdate.lastRunAt = started;
  autoUpdate.lastError = null;
  if (!ghAuthed()) {
    autoUpdate.lastError = 'GitHub is not connected';
    return { ok: false, error: autoUpdate.lastError, checked: 0, updated: [] };
  }
  try {
    const { repos } = await fetchAllRepos(false);
    const updates = [];
    let checked = 0;
    // Cap the work per tick so a huge account never burns the rate limit.
    const slice = repos.slice(0, 100);
    for (const repo of slice) {
      checked += 1;
      try {
        const res = await ghRequest(`/repos/${repo.full_name}/commits?per_page=1`, { useCache: true });
        const latest = Array.isArray(res.data) && res.data[0] ? normalizeCommit(res.data[0]) : null;
        if (!latest) continue;
        const previous = autoUpdate.lastShaByRepo.get(repo.full_name);
        if (previous && previous !== latest.sha) {
          updates.push({ repo: repo.full_name, oldSha: previous.slice(0, 7), newSha: latest.sha.slice(0, 7), message: latest.message, at: started });
        }
        autoUpdate.lastShaByRepo.set(repo.full_name, latest.sha);
      } catch (err) {
        // One repo failing must not abort the whole tick.
        log(`auto-update: ${repo.full_name} failed: ${err.message}`);
      }
    }
    autoUpdate.reposChecked = checked;
    if (updates.length) {
      autoUpdate.updatesFound += updates.length;
      autoUpdate.lastChangeAt = started;
      repoListCache = { at: 0, repos: [] }; // repo list changed: drop the cache
      for (const u of updates) sseBroadcast('repo-updated', u);
      // v2.1 auto-sync: if the LOCAL repo's remote is one of the repos
      // that just gained commits, pull it automatically — but only when
      // the working tree is clean (a dirty tree must never be merged
      // without the user seeing it) and only when the user opted in.
      if (autoUpdate.autoSync && repoPath) {
        await maybeAutoSync(updates, started);
      }
    }
    const result = { ok: true, checked, updated: updates, at: started, autoSync: autoUpdate.lastAutoSync };
    sseBroadcast('auto-update', result);
    return result;
  } catch (err) {
    autoUpdate.lastError = err.message;
    log('auto-update tick failed:', err.message);
    return { ok: false, error: err.message, checked: 0, updated: [] };
  } finally {
    scheduleAutoUpdate();
  }
}

function scheduleAutoUpdate() {
  if (autoUpdate.timer) { clearTimeout(autoUpdate.timer); autoUpdate.timer = null; }
  if (!autoUpdate.enabled) { autoUpdate.nextRunAt = null; return; }
  const delay = autoUpdate.intervalSeconds * 1000;
  autoUpdate.nextRunAt = new Date(Date.now() + delay).toISOString();
  autoUpdate.timer = setTimeout(() => { autoUpdateTick(false); }, delay);
  if (autoUpdate.timer.unref) autoUpdate.timer.unref();
}

function setAutoUpdate(enabled, intervalSeconds, autoSync) {
  autoUpdate.enabled = !!enabled;
  if (intervalSeconds !== undefined) autoUpdate.intervalSeconds = clampInterval(intervalSeconds);
  if (autoSync !== undefined) autoUpdate.autoSync = !!autoSync;
  ghConfig.autoUpdate = { enabled: autoUpdate.enabled, intervalSeconds: autoUpdate.intervalSeconds, autoSync: autoUpdate.autoSync };
  saveGhConfig();
  scheduleAutoUpdate();
  if (autoUpdate.enabled) {
    // Run one tick right away so the user sees fresh data immediately.
    setTimeout(() => { autoUpdateTick(false); }, 500).unref?.();
  }
  return autoUpdateStatus();
}

/**
 * v2.1 auto-sync: pull the local repo when its GitHub remote gained
 * commits. Safety rules: only when autoSync is on, only when the
 * working tree is clean, only merge mode, never force. The outcome
 * (pulled / skipped / failed) is recorded and broadcast so the UI can
 * show it; a failure never breaks the auto-update tick.
 */
async function maybeAutoSync(updates, at) {
  try {
    const origin = await remoteUrl();
    const ghRepo = origin ? parseGitHubRepoFromUrl(origin) : null;
    if (!ghRepo) return; // local repo has no GitHub remote — nothing to sync
    const hit = updates.find((u) => u.repo.toLowerCase() === ghRepo.toLowerCase());
    if (!hit) return;
    const dirty = (await runGit(['status', '--porcelain'])).trim();
    if (dirty) {
      autoUpdate.lastAutoSync = { at, repo: ghRepo, skipped: true, reason: 'Working tree has uncommitted changes — auto-sync skipped. Commit or stash first.' };
      sseBroadcast('auto-sync', autoUpdate.lastAutoSync);
      log(`auto-sync skipped for ${ghRepo}: working tree dirty`);
      return;
    }
    const branch = await currentBranch();
    if (!branch || branch.startsWith('(')) {
      autoUpdate.lastAutoSync = { at, repo: ghRepo, skipped: true, reason: 'No branch checked out — auto-sync skipped.' };
      sseBroadcast('auto-sync', autoUpdate.lastAutoSync);
      return;
    }
    const pulled = await pullRepo({ mode: 'merge', remote: 'origin', branch });
    autoUpdate.lastAutoSync = { at, repo: ghRepo, branch, commitsPulled: pulled.commitsPulled, changedFiles: pulled.changedFiles, skipped: false };
    sseBroadcast('auto-sync', autoUpdate.lastAutoSync);
    log(`auto-sync pulled ${pulled.commitsPulled} commit(s) into ${ghRepo}@${branch}`);
  } catch (err) {
    autoUpdate.lastAutoSync = { at, repo: null, skipped: true, reason: `Auto-sync failed: ${err.message}` };
    sseBroadcast('auto-sync', autoUpdate.lastAutoSync);
    log('auto-sync failed:', err.message);
  }
}

/**
 * Parse "owner/repo" out of a git remote URL (https or ssh form).
 * Returns null for non-GitHub remotes.
 */
function parseGitHubRepoFromUrl(url) {
  const s = String(url || '').trim();
  let m = s.match(/^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^git@[^:]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^ssh:\/\/git@[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Git (local) — unchanged v1 behaviour                                */
/* ------------------------------------------------------------------ */

function gitEnv() {
  return Object.assign({}, process.env, {
    // Never block on an interactive credential prompt.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    GIT_OPTIONAL_LOCKS: '0',
    // Stable, parseable output regardless of the user's locale.
    LC_ALL: 'C',
    LANG: 'C',
  });
}

function runGitIn(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!cwd) return reject(new Error('No repository connected'));
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        shell: false,
        env: gitEnv(),
      });
    } catch (err) {
      return reject(new Error(`Could not start git: ${err.message}`));
    }

    let out = '';
    let err = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`));
    }, options.timeout || GIT_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        return reject(new Error('Git is not installed or not on PATH. Install Git and restart the bridge.'));
      }
      reject(new Error(`Could not run git: ${e.message}`));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      // Combine stdout + stderr: git splits its output — e.g. `git pull`
      // prints the fetch summary to stderr and "CONFLICT (content)…"
      // to stdout. Keeping only one side hides the real failure.
      const combined = [out, err].map((s) => (s || '').trim()).filter(Boolean).join('\n');
      const message = combined || `git exited with code ${code}`;
      const error = new Error(message);
      error.gitCode = code;
      error.gitStderr = err;
      reject(error);
    });
  });
}

function runGit(args, options = {}) {
  return runGitIn(repoPath, args, options);
}

/* ------------------------------------------------------------------ */
/* Shared push/pull helpers (v2.1) — used by the routes AND by         */
/* auto-sync, so the behaviour is identical everywhere.                */
/* ------------------------------------------------------------------ */

async function headSha() {
  try {
    return (await runGit(['rev-parse', 'HEAD'])).trim() || null;
  } catch (_) {
    return null;
  }
}

async function conflictedFiles() {
  try {
    const raw = await runGit(['diff', '--name-only', '--diff-filter=U']);
    return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function isMerging() {
  try {
    await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch (_) {
    return false;
  }
}

async function aheadBehind() {
  const branch = await currentBranch();
  if (!branch || branch.startsWith('(')) {
    return { branch, upstream: null, ahead: 0, behind: 0, hasUpstream: false };
  }
  const upstream = await upstreamOf(branch);
  if (!upstream) {
    return { branch, upstream: null, ahead: 0, behind: 0, hasUpstream: false };
  }
  try {
    const raw = (await runGit(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`])).trim();
    const parts = raw.split(/\s+/);
    return {
      branch,
      upstream,
      ahead: Number(parts[0]) || 0,
      behind: Number(parts[1]) || 0,
      hasUpstream: true,
    };
  } catch (_) {
    return { branch, upstream, ahead: 0, behind: 0, hasUpstream: true };
  }
}

function validateBranchName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('Branch name is required');
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.startsWith('-') ||
      value.endsWith('/') || value.endsWith('.lock') || value === 'HEAD') {
    throw new Error(`Invalid branch name: ${value}`);
  }
  return value;
}

function validateRemoteName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('Remote name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.startsWith('-')) {
    throw new Error(`Invalid remote name: ${value}`);
  }
  return value;
}

function validateGitUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new Error('Git URL is required');
  if (/[\s;|&$`\\'"\n\r]/.test(value) || value.startsWith('-')) {
    throw new Error('Invalid Git URL');
  }
  const ok = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(value) ||
    value.startsWith('/') || value.startsWith('~/') || value.startsWith('./') || value.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(value);
  if (!ok) throw new Error('Git URL must start with https://, git@, ssh://, git://, file:// or a local path');
  return value;
}

function parseStashList(raw) {
  const out = [];
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const m = line.match(/^stash@\{(\d+)\}:\s*(.*)$/);
    if (m) out.push({ index: Number(m[1]), ref: `stash@{${m[1]}}`, message: m[2] });
  }
  return out;
}

function parseNumstat(raw) {
  const out = [];
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    out.push({
      path: parts.slice(2).join('\t'),
      insertions: parts[0] === '-' ? null : Number(parts[0]) || 0,
      deletions: parts[1] === '-' ? null : Number(parts[1]) || 0,
      binary: parts[0] === '-',
    });
  }
  return out;
}

/**
 * Pull from a remote. Returns a structured result; a merge conflict is
 * NOT an exception — it is { ok: false, conflict: true, conflicts } so
 * the UI can show the conflicted files and offer ours/theirs.
 */
async function pullRepo(opts = {}) {
  const mode = ['merge', 'rebase', 'ff-only'].includes(opts.mode) ? opts.mode : 'merge';
  const remote = validateRemoteName(opts.remote || 'origin');
  const branch = opts.branch ? validateBranchName(opts.branch) : null;
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot pull: no branch checked out');
  const targetBranch = branch || current;
  const upstream = await upstreamOf(current);
  const oldSha = await headSha();

  const args = ['pull'];
  if (mode === 'rebase') args.push('--rebase');
  else if (mode === 'ff-only') args.push('--ff-only');
  else args.push('--no-rebase'); // merge mode: say so explicitly, or git
  // refuses divergent branches ("need to specify how to reconcile them").
  // Plain `git pull` uses the configured upstream; an explicit branch
  // (or a branch without upstream) needs remote + branch on the command.
  if (!upstream || branch) args.push(remote, targetBranch);

  let result;
  try {
    result = await runGit(args);
  } catch (err) {
    const text = `${err.message || ''} ${err.gitStderr || ''}`;
    if (/CONFLICT/i.test(text) || /Automatic merge failed/i.test(text)) {
      const conflicts = await conflictedFiles();
      return {
        ok: false, conflict: true, conflicts, mode, remote, branch: targetBranch,
        result: text.trim(),
      };
    }
    throw err;
  }

  const newSha = await headSha();
  let changedFiles = [];
  let commitsPulled = 0;
  let mergeCommits = 0;
  if (oldSha && newSha && oldSha !== newSha) {
    changedFiles = (await runGit(['diff', '--name-only', `${oldSha}..${newSha}`])).split('\n').map((s) => s.trim()).filter(Boolean);
    mergeCommits = Number((await runGit(['rev-list', '--count', '--merges', `${oldSha}..${newSha}`])).trim()) || 0;
  }
  // "Commits pulled" = commits that arrived from the remote in this
  // pull, measured as old HEAD .. FETCH_HEAD (the head just fetched).
  // Counting old..new instead would also count the merge commit itself
  // and, after a rebase, the rewritten local commit — and the
  // remote-tracking ref is unreliable here because a failed earlier
  // pull (e.g. --ff-only on diverged branches) already advanced it.
  let fetchHeadSha = null;
  try {
    fetchHeadSha = (await runGit(['rev-parse', 'FETCH_HEAD'])).trim() || null;
  } catch (_) { fetchHeadSha = null; }
  if (oldSha && fetchHeadSha) {
    commitsPulled = Number((await runGit(['rev-list', '--count', `${oldSha}..${fetchHeadSha}`])).trim()) || 0;
  } else if (fetchHeadSha) {
    commitsPulled = Number((await runGit(['rev-list', '--count', fetchHeadSha])).trim()) || 0;
  }
  return {
    ok: true, conflict: false, mode, remote, branch: targetBranch,
    result: (result || '').trim(), changedFiles, commitsPulled,
    fastForward: commitsPulled > 0 && mergeCommits === 0, newSha,
  };
}

/**
 * Push to a remote. Force push is --force-with-lease ONLY, and only
 * when the caller passes confirm=true (the UI shows a checkbox for
 * this). Plain --force is never used.
 */
async function pushRepo(opts = {}) {
  const remote = validateRemoteName(opts.remote || 'origin');
  const branch = opts.branch ? validateBranchName(opts.branch) : null;
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot push: no branch checked out');
  const targetBranch = branch || current;
  if (opts.force && opts.confirm !== true) {
    throw new Error('Force push needs explicit confirmation. Tick the "force-push with lease" confirmation and try again.');
  }
  const args = ['push'];
  if (opts.force) args.push('--force-with-lease');
  if (opts.pushAll) {
    args.push(remote, '--all');
  } else if (opts.tags) {
    args.push(remote, '--tags');
  } else {
    const upstream = await upstreamOf(current);
    if (opts.setUpstream || !upstream) args.push('-u', remote, targetBranch);
    else args.push(remote, targetBranch);
  }
  const result = await runGit(args);
  return { ok: true, remote, branch: targetBranch, result: (result || '').trim(), pushed: true };
}

/* ------------------------------------------------------------------ */
/* Path validation                                                     */
/* ------------------------------------------------------------------ */

function expandHome(input) {
  let value = String(input || '').trim();
  if (!value) return value;
  // Strip surrounding quotes that users copy from a file manager.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveRepoDir(input) {
  const expanded = expandHome(input);
  if (!expanded) throw new Error('Repository path is required');
  const abs = path.resolve(expanded);
  if (!fs.existsSync(abs)) throw new Error(`Directory does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);
  return abs;
}

function safeRel(input) {
  const value = String(input == null ? '' : input);
  if (!value) throw new Error('A repository-relative path is required');
  if (value.includes('\0')) throw new Error('Invalid path');
  if (path.isAbsolute(value)) throw new Error('Path must be repository-relative');
  const parts = value.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error('Path traversal is not allowed');
  return value;
}

function safeGhPath(input) {
  // Owner/repo/path segments for GitHub API calls: no traversal, no blanks.
  const value = String(input == null ? '' : input).trim();
  if (!value) throw new Error('A path is required');
  if (value.includes('\0') || value.includes('..')) throw new Error('Invalid path');
  return value.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/* ------------------------------------------------------------------ */
/* Git status parsing (NUL-separated, rename-aware)                    */
/* ------------------------------------------------------------------ */

function parseStatus(raw) {
  const files = [];
  if (!raw) return files;
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);
    let origPath = null;

    // With -z, a rename/copy emits the ORIGINAL path as the next NUL field.
    // `path` must stay the current (new) path so `git add`/`git diff` work.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const original = entries[i + 1];
      if (original) {
        origPath = original;
        i += 1;
      }
    }

    files.push({
      status: (x + y).trim() || '?',
      path: filePath,
      origPath,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: x === '?' && y === '?',
    });
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Repo helpers                                                        */
/* ------------------------------------------------------------------ */

async function currentBranch() {
  try {
    const name = (await runGit(['branch', '--show-current'])).trim();
    if (name) return name;
    // Detached HEAD
    const sha = (await runGit(['rev-parse', '--short', 'HEAD'])).trim();
    return sha ? `(detached ${sha})` : null;
  } catch (_) {
    return null;
  }
}

async function hasHead() {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch (_) {
    return false;
  }
}

async function upstreamOf(branch) {
  try {
    const up = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).trim();
    return up || null;
  } catch (_) {
    return null;
  }
}

async function remoteUrl() {
  // Read the RAW configured URL, not `git remote get-url`:
  // get-url applies url.insteadOf rewriting (e.g. a local mirror
  // standing in for github.com), which would hide the real remote
  // from the UI and from auto-sync's GitHub matching. The raw value
  // is what the user configured and what we want to display.
  try {
    return (await runGit(['config', '--get', 'remote.origin.url'])).trim() || null;
  } catch (_) {
    return null;
  }
}

async function repoSummary() {
  if (!repoPath) return null;
  const summary = {
    name: path.basename(repoPath),
    path: repoPath,
    branch: null,
    remote: null,
    upstream: null,
    head: false,
  };
  try {
    summary.branch = await currentBranch();
    summary.remote = await remoteUrl();
    summary.head = await hasHead();
    if (summary.branch && !summary.branch.startsWith('(')) {
      summary.upstream = await upstreamOf(summary.branch);
    }
  } catch (_) {}
  return summary;
}

function requireGhAuth() {
  if (!ghAuthed()) {
    throw new GhError(401, 'GitHub is not connected. Sign in with a Personal Access Token first.');
  }
}

function healthPayload() {
  return {
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    repository: null, // filled in by the caller (async)
    github: {
      authed: ghAuthed(),
      login: ghConfig.user ? ghConfig.user.login : null,
      avatar_url: ghConfig.user ? ghConfig.user.avatar_url : null,
      authMethod: ghConfig.authMethod || null,
      deviceFlowAvailable: !!oauthClientId(),
      oauthWebAvailable: oauthWebConfigured(),
      rateLimit: lastRateLimit,
    },
    autoUpdate: autoUpdateStatus(),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(req, res, 204, null);
  }

  /* ---- Server-Sent Events (live channel) ---- */
  if (route === '/api/events' && req.method === 'GET') {
    // EventSource cannot set headers, so the bridge token arrives as a
    // query parameter here — and only here. It is compared timing-safe
    // and is never logged.
    if (!tokenMatches(`Bearer ${String(url.searchParams.get('token') || '')}`)) {
      return send(req, res, 401, { error: 'Unauthorized: invalid or missing bridge token' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    sseSend(res, 'hello', { version: VERSION, at: new Date().toISOString(), github: { authed: ghAuthed(), login: ghConfig.user ? ghConfig.user.login : null }, autoUpdate: autoUpdateStatus() });
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  // Public health check (no token) so the popup can show a lamp.
  if (route === '/health' && req.method === 'GET') {
    const payload = healthPayload();
    payload.repository = await repoSummary();
    return send(req, res, 200, payload);
  }

  /* ---- OAuth Web Flow callback (public by necessity) ----
   * GitHub redirects the user's BROWSER here after they sign in on
   * github.com, so no bridge token can travel with the request. The
   * request is protected instead by the one-time, expiring `state`
   * value minted by /api/github/oauth/start, and the server only
   * listens on 127.0.0.1, so only this machine can call it. The
   * authorization code and the access token are never logged and
   * never appear in the HTML response. */
  if (route === '/api/github/oauth/callback' && req.method === 'GET') {
    const sendHtml = (status, title, bodyHtml) => {
      const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#24292f}h1{font-size:22px}.ok{color:#1a7f37}.err{color:#cf222e}code{background:#f6f8fa;padding:2px 6px;border-radius:6px}</style></head><body>${bodyHtml}</body></html>`;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(html);
    };
    const code = String(url.searchParams.get('code') || '');
    const state = String(url.searchParams.get('state') || '');
    const ghError = String(url.searchParams.get('error') || '');
    const ghErrorDesc = String(url.searchParams.get('error_description') || '');
    if (ghError) {
      log('OAuth web flow denied by GitHub:', ghError);
      return sendHtml(400, 'Đăng nhập thất bại', `<h1 class="err">Đăng nhập GitHub thất bại</h1><p>GitHub từ chối yêu cầu: <b>${escHtml(ghErrorDesc || ghError)}</b></p><p>Bạn có thể đóng tab này và thử lại từ extension.</p>`);
    }
    if (!code || !state) {
      return sendHtml(400, 'Đăng nhập thất bại', '<h1 class="err">Đăng nhập GitHub thất bại</h1><p>Thiếu mã xác nhận từ GitHub. Bạn có thể đóng tab này và thử lại từ extension.</p>');
    }
    if (!consumeOAuthState(state)) {
      log('OAuth web flow: invalid or expired state (possible replay/CSRF attempt)');
      return sendHtml(400, 'Đăng nhập thất bại', '<h1 class="err">Phiên đăng nhập đã hết hạn hoặc không hợp lệ</h1><p>Mã chống giả mạo (state) sai hoặc đã dùng rồi. Bạn có thể đóng tab này và bấm "Kết nối GitHub" lại từ extension.</p>');
    }
    const clientId = oauthClientId();
    const clientSecret = oauthClientSecret();
    if (!clientId || !clientSecret) {
      return sendHtml(400, 'Chưa cấu hình OAuth App', '<h1 class="err">Bridge chưa cấu hình OAuth App</h1><p>Bridge cần Client ID + Client Secret của OAuth App để đổi mã lấy token. Nhập chúng trong dashboard (mục Đăng nhập GitHub) rồi thử lại.</p>');
    }
    try {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: oauthCallbackUrl(),
      });
      const tokenRes = await fetch(`${GITHUB_OAUTH_BASE}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
        body: params.toString(),
        signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      });
      const data = safeJsonParse(await tokenRes.text()) || {};
      if (!tokenRes.ok || !data.access_token) {
        throw new Error((data && (data.error_description || data.error)) || 'GitHub did not return an access token');
      }
      const { user, scopes } = await ghValidateToken(data.access_token);
      signInWithToken(data.access_token, user, scopes, 'oauth-web');
      return sendHtml(200, 'Đăng nhập thành công', `<h1 class="ok">Đã kết nối GitHub ✓</h1><p>Đăng nhập thành công với tài khoản <b>${escHtml(user.login)}</b>${user.name ? ` (${escHtml(user.name)})` : ''}.</p><p>Bạn có thể đóng tab này — dashboard trong extension sẽ tự cập nhật.</p>`);
    } catch (err) {
      log('OAuth web flow token exchange failed:', err.message);
      return sendHtml(400, 'Đăng nhập thất bại', `<h1 class="err">Không đổi được mã lấy token</h1><p>${escHtml(err.message)}</p><p>Bạn có thể đóng tab này và thử lại, hoặc đăng nhập bằng Personal Access Token.</p>`);
    }
  }

  if (!tokenMatches(req.headers.authorization)) {
    return send(req, res, 401, { error: 'Unauthorized: invalid or missing bridge token' });
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await readBody(req);
  }

  /* ==================== GITHUB AUTH ==================== */

  if (route === '/api/github/auth' && req.method === 'POST') {
    const token = String(body.token || '').trim();
    if (!token) throw new Error('Paste a Personal Access Token first');
    if (token.length < 20) throw new Error('That does not look like a GitHub token (too short)');
    const { user, scopes } = await ghValidateToken(token);
    signInWithToken(token, user, scopes, 'pat');
    return send(req, res, 200, { ok: true, user: publicUser() });
  }

  if (route === '/api/github/auth/device/start' && req.method === 'POST') {
    const clientId = oauthClientId();
    if (!clientId) {
      throw new Error(
        'Device Flow is not configured on this bridge. Create a GitHub OAuth App and save its client id in the dashboard (or set GITHUB_OAUTH_CLIENT_ID and restart the bridge), or sign in with a Personal Access Token instead.'
      );
    }
    const params = new URLSearchParams({ client_id: clientId, scope: GH_SCOPES });
    const res2 = await fetch(`${GITHUB_OAUTH_BASE}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
      body: params.toString(),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    const data = safeJsonParse(await res2.text()) || {};
    if (!res2.ok || !data.device_code) throw new Error((data && data.error_description) || 'GitHub Device Flow failed to start');
    return send(req, res, 200, {
      ok: true,
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete || data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval || 5,
    });
  }

  if (route === '/api/github/auth/device/poll' && req.method === 'POST') {
    const clientId = oauthClientId();
    if (!clientId) throw new Error('Device Flow is not configured on this bridge (no OAuth App client id).');
    const deviceCode = String(body.device_code || '').trim();
    if (!deviceCode) throw new Error('device_code is required');
    const params = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const res2 = await fetch(`${GITHUB_OAUTH_BASE}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
      body: params.toString(),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    const data = safeJsonParse(await res2.text()) || {};
    if (data.access_token) {
      const { user, scopes } = await ghValidateToken(data.access_token);
      signInWithToken(data.access_token, user, scopes, 'device');
      return send(req, res, 200, { ok: true, status: 'authorized', user: publicUser() });
    }
    if (data.error === 'authorization_pending') return send(req, res, 200, { ok: true, status: 'pending' });
    if (data.error === 'slow_down') return send(req, res, 200, { ok: true, status: 'slow_down' });
    if (data.error === 'expired_token') throw new Error('The device code expired. Start Device Flow again.');
    if (data.error === 'access_denied') throw new Error('You denied the authorization on GitHub.');
    throw new Error((data && data.error_description) || 'Device Flow poll failed');
  }

  if (route === '/api/github/logout' && req.method === 'POST') {
    const wasLogin = ghConfig.user ? ghConfig.user.login : null;
    ghConfig.token = null;
    ghConfig.user = null;
    ghConfig.authedAt = null;
    ghConfig.authMethod = null;
    ghConfig.scopes = null;
    autoUpdate.lastShaByRepo.clear();
    repoListCache = { at: 0, repos: [] };
    ghCache.clear();
    saveGhConfig();
    sseBroadcast('github-auth', { authed: false, login: null, at: new Date().toISOString() });
    if (wasLogin) log(`GitHub signed out (was ${wasLogin})`);
    return send(req, res, 200, { ok: true, authed: false });
  }

  if (route === '/api/github/me' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, authed: ghAuthed(), user: publicUser(), authedAt: ghConfig.authedAt });
  }

  // v2.1 canonical profile endpoint: same as /me, plus the sign-in
  // method and granted scopes so the UI can show "Connected with GitHub".
  if (route === '/api/github/user' && req.method === 'GET') {
    return send(req, res, 200, {
      ok: true,
      authed: ghAuthed(),
      user: publicUser(),
      authMethod: ghConfig.authMethod || null,
      scopes: ghConfig.scopes || null,
      authedAt: ghConfig.authedAt,
    });
  }

  /* ==================== OAUTH WEB FLOW (v2.1) ==================== */
  // Sign in with a REAL GitHub account in the browser:
  //   1. dashboard calls /oauth/start -> gets an authorize URL
  //   2. the user opens it, signs in on github.com, approves the app
  //   3. GitHub redirects to /oauth/callback on this bridge (127.0.0.1)
  //   4. the bridge exchanges the code for a token and stores it like
  //      a PAT. The dashboard learns via SSE + polling /api/github/user.

  if (route === '/api/github/oauth/status' && req.method === 'GET') {
    return send(req, res, 200, {
      ok: true,
      configured: oauthWebConfigured(),
      clientIdConfigured: !!oauthClientId(),
      clientSecretConfigured: !!oauthClientSecret(),
      callbackUrl: oauthCallbackUrl(),
      authed: ghAuthed(),
      authMethod: ghConfig.authMethod || null,
      login: ghConfig.user ? ghConfig.user.login : null,
    });
  }

  if (route === '/api/github/oauth/config' && req.method === 'POST') {
    const clientId = String(body.clientId || body.client_id || '').trim();
    const clientSecret = String(body.clientSecret || body.client_secret || '').trim();
    if (!clientId) throw new Error('Client ID is required (from your GitHub OAuth App)');
    if (!clientSecret) throw new Error('Client Secret is required (from your GitHub OAuth App)');
    if (clientId.length < 5 || clientSecret.length < 10) throw new Error('Client ID / Client Secret look too short — check what you pasted');
    oauthAppConfig = { clientId, clientSecret };
    saveOAuthAppConfig();
    log('OAuth App configured (client id set, secret stored locally, never returned)');
    return send(req, res, 200, { ok: true, configured: true, callbackUrl: oauthCallbackUrl() });
  }

  if (route === '/api/github/oauth/start' && req.method === 'GET') {
    const clientId = oauthClientId();
    if (!clientId) {
      throw new Error(
        'OAuth Web Flow is not configured. Create a GitHub OAuth App and save its Client ID + Client Secret in the dashboard first, or sign in with a Personal Access Token / Device Flow instead.'
      );
    }
    const state = mintOAuthState();
    const authorizeUrl = `${GITHUB_OAUTH_BASE}/login/oauth/authorize?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: oauthCallbackUrl(),
      scope: GH_SCOPES,
      state,
      allow_signup: 'true',
    }).toString();
    return send(req, res, 200, {
      ok: true,
      authorizeUrl,
      expiresIn: Math.floor(OAUTH_STATE_TTL_MS / 1000),
      callbackUrl: oauthCallbackUrl(),
    });
  }

  if (route === '/api/github/rate-limit' && req.method === 'GET') {
    requireGhAuth();
    try {
      const gh = await ghRequest('/rate_limit', { useCache: false });
      const core = (gh.data && gh.data.resources && gh.data.resources.core) || {};
      return send(req, res, 200, {
        ok: true,
        limit: core.limit ?? lastRateLimit.limit,
        remaining: core.remaining ?? lastRateLimit.remaining,
        reset: core.reset ? new Date(core.reset * 1000).toISOString() : (lastRateLimit.reset ? new Date(lastRateLimit.reset * 1000).toISOString() : null),
        used: core.used ?? lastRateLimit.used,
      });
    } catch (err) {
      if (err instanceof GhError) throw err;
      return send(req, res, 200, { ok: true, ...lastRateLimit, note: 'live rate-limit lookup failed; showing last seen values' });
    }
  }

  /* ==================== GITHUB REPOSITORIES ==================== */

  if (route === '/api/github/repos' && req.method === 'GET') {
    requireGhAuth();
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const type = String(url.searchParams.get('type') || 'all');
    const sort = String(url.searchParams.get('sort') || 'updated');
    const direction = String(url.searchParams.get('direction') || 'desc');
    const gh = await ghRequest(`/user/repos?per_page=${perPage}&page=${page}&type=${encodeURIComponent(type)}&sort=${encodeURIComponent(sort)}&direction=${encodeURIComponent(direction)}`, { useCache: true });
    const repos = Array.isArray(gh.data) ? gh.data.map(normalizeRepo) : [];
    return send(req, res, 200, {
      ok: true,
      repos,
      page,
      per_page: perPage,
      has_next: !!gh.links.next,
      has_prev: !!gh.links.prev,
      total_pages: gh.links.last ? pageNumberFromUrl(gh.links.last) : (gh.links.next ? null : page),
      notModified: !!gh.notModified,
    });
  }

  if (route === '/api/github/repos/all' && req.method === 'GET') {
    requireGhAuth();
    const force = url.searchParams.get('force') === '1';
    const { repos, cached } = await fetchAllRepos(force);
    return send(req, res, 200, { ok: true, repos, total: repos.length, cached, fetched_at: new Date(repoListCache.at).toISOString() });
  }

  if (route === '/api/github/repos/search' && req.method === 'GET') {
    requireGhAuth();
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) throw new Error('Search query (q) is required');
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const gh = await ghRequest(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`, { useCache: false });
    const repos = Array.isArray(gh.data && gh.data.items) ? gh.data.items.map(normalizeRepo) : [];
    return send(req, res, 200, { ok: true, repos, total_count: (gh.data && gh.data.total_count) || repos.length, incomplete_results: !!(gh.data && gh.data.incomplete_results) });
  }

  // /api/github/repos/:owner/:repo and everything below it.
  const repoMatch = route.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch && (req.method === 'GET' || req.method === 'PUT')) {
    requireGhAuth();
    const owner = safeGhPath(decodeURIComponent(repoMatch[1]));
    const repo = safeGhPath(decodeURIComponent(repoMatch[2]));
    const rest = repoMatch[3] || '';
    const fullName = `${decodeURIComponent(repoMatch[1])}/${decodeURIComponent(repoMatch[2])}`;

    if (rest === '' && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}`, { useCache: true });
      return send(req, res, 200, { ok: true, repo: normalizeRepo(gh.data), notModified: !!gh.notModified });
    }

    if (rest === 'branches' && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      const gh = await ghRequest(`/repos/${owner}/${repo}/branches?per_page=${perPage}`, { useCache: true });
      return send(req, res, 200, { ok: true, branches: (Array.isArray(gh.data) ? gh.data : []).map(normalizeBranch), notModified: !!gh.notModified });
    }

    if (rest === 'commits' && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 10));
      const sha = url.searchParams.get('sha');
      const pathFilter = url.searchParams.get('path');
      let apiPath = `/repos/${owner}/${repo}/commits?per_page=${perPage}`;
      if (sha) apiPath += `&sha=${encodeURIComponent(sha)}`;
      if (pathFilter) apiPath += `&path=${encodeURIComponent(pathFilter)}`;
      const gh = await ghRequest(apiPath, { useCache: true });
      return send(req, res, 200, { ok: true, commits: (Array.isArray(gh.data) ? gh.data : []).map(normalizeCommit), notModified: !!gh.notModified });
    }

    if (rest === 'readme' && req.method === 'GET') {
      const ref = url.searchParams.get('ref');
      let apiPath = `/repos/${owner}/${repo}/readme`;
      if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`;
      const gh = await ghRequest(apiPath, { useCache: true });
      const d = gh.data || {};
      let content = '';
      if (d.encoding === 'base64' && d.content) {
        content = Buffer.from(String(d.content).replace(/\n/g, ''), 'base64').toString('utf8');
      }
      return send(req, res, 200, { ok: true, name: d.name || 'README', path: d.path || '', content, sha: d.sha || '', html_url: d.html_url || '', notModified: !!gh.notModified });
    }

    if (rest === 'issues' && req.method === 'GET') {
      const state = String(url.searchParams.get('state') || 'open');
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 10));
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`, { useCache: false });
      return send(req, res, 200, { ok: true, issues: (Array.isArray(gh.data) ? gh.data : []).map(normalizeIssue) });
    }

    if (rest === 'pulls' && req.method === 'GET') {
      const state = String(url.searchParams.get('state') || 'open');
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 10));
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}`, { useCache: false });
      const pulls = (Array.isArray(gh.data) ? gh.data : []).map((p) => ({
        number: p.number, title: p.title || '', state: p.state || '',
        html_url: p.html_url || '', user: (p.user && p.user.login) || '',
        created_at: p.created_at || null, updated_at: p.updated_at || null,
        head: (p.head && p.head.ref) || '', base: (p.base && p.base.ref) || '',
        draft: !!p.draft, merged_at: p.merged_at || null,
      }));
      return send(req, res, 200, { ok: true, pulls });
    }

    if (rest === 'contents' && req.method === 'GET') {
      const relPath = String(url.searchParams.get('path') || '').trim();
      const ref = url.searchParams.get('ref');
      let apiPath = `/repos/${owner}/${repo}/contents${relPath ? '/' + safeGhPath(relPath) : ''}`;
      if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`;
      const gh = await ghRequest(apiPath, { useCache: true });
      const d = gh.data;
      if (Array.isArray(d)) {
        return send(req, res, 200, { ok: true, kind: 'dir', path: relPath, entries: d.map(normalizeContentEntry), notModified: !!gh.notModified });
      }
      let content = '';
      if (d && d.encoding === 'base64' && d.content) {
        content = Buffer.from(String(d.content).replace(/\n/g, ''), 'base64').toString('utf8');
      }
      return send(req, res, 200, {
        ok: true, kind: 'file', name: (d && d.name) || '', path: (d && d.path) || relPath,
        size: (d && d.size) || 0, sha: (d && d.sha) || '', encoding: (d && d.encoding) || 'utf8',
        content, html_url: (d && d.html_url) || '', download_url: (d && d.download_url) || null,
        notModified: !!gh.notModified,
      });
    }

    if (rest === 'contents' && req.method === 'PUT') {
      // Create or update a file: { message, content (utf8 text), sha?, branch? }
      const relPath = String(body.path || '').trim();
      if (!relPath) throw new Error('File path (body.path) is required');
      const message = String(body.message || '').trim();
      if (!message) throw new Error('Commit message is required');
      const content = String(body.content == null ? '' : body.content);
      const payload = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
      };
      if (body.sha) payload.sha = String(body.sha);
      if (body.branch) payload.branch = String(body.branch);
      const gh = await ghRequest(`/repos/${owner}/${repo}/contents/${safeGhPath(relPath)}`, { method: 'PUT', body: payload });
      const d = gh.data || {};
      repoListCache = { at: 0, repos: [] };
      return send(req, res, 200, {
        ok: true,
        commit: d.commit ? { sha: d.commit.sha, message: (d.commit.message || '').split('\n')[0], html_url: d.commit.html_url || '' } : null,
        content: d.content ? { name: d.content.name, path: d.content.path, sha: d.content.sha } : null,
      });
    }

    return send(req, res, 404, { error: `Unknown GitHub endpoint: ${req.method} ${route}` });
  }

  /* ==================== AUTO-UPDATE ==================== */

  if (route === '/api/github/auto-update' && req.method === 'GET') {
    requireGhAuth();
    return send(req, res, 200, { ok: true, ...autoUpdateStatus() });
  }

  if (route === '/api/github/auto-update' && req.method === 'POST') {
    requireGhAuth();
    const enabled = body.enabled !== undefined ? !!body.enabled : autoUpdate.enabled;
    const intervalSeconds = body.intervalSeconds !== undefined ? clampInterval(body.intervalSeconds) : autoUpdate.intervalSeconds;
    const autoSync = body.autoSync !== undefined ? !!body.autoSync : autoUpdate.autoSync;
    const status = setAutoUpdate(enabled, intervalSeconds, autoSync);
    return send(req, res, 200, { ok: true, ...status });
  }

  if (route === '/api/github/refresh' && req.method === 'POST') {
    requireGhAuth();
    const result = await autoUpdateTick(true);
    return send(req, res, 200, { ok: true, ...result });
  }

  /* ==================== LOCAL REPO (v1) ==================== */

  if (route === '/api/repo/select' && req.method === 'POST') {
    const candidate = resolveRepoDir(body.path);
    const previous = repoPath;
    repoPath = candidate;
    try {
      const topLevel = (await runGit(['rev-parse', '--show-toplevel'])).trim();
      if (topLevel) repoPath = path.resolve(topLevel);
    } catch (err) {
      repoPath = previous;
      throw new Error(`Not a Git repository: ${candidate}`);
    }
    saveState();
    return send(req, res, 200, { ok: true, repository: await repoSummary() });
  }

  if (route === '/api/repo/current' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, repository: await repoSummary() });
  }

  /* ---- clone (v2.1) — needs no repo selected, so it lives above
   * the repoPath guard. Clones into the requested folder (which must
   * not exist yet, or be empty), then SELECTS the cloned repo so the
   * user can work on it immediately. */
  if (route === '/api/git/clone' && req.method === 'POST') {
    const gitUrl = validateGitUrl(body.url);
    const targetInput = String(body.path || '').trim();
    if (!targetInput) throw new Error('Destination path is required');
    const target = path.resolve(expandHome(targetInput));
    const parent = path.dirname(target);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error(`Parent directory does not exist: ${parent}`);
    }
    if (fs.existsSync(target)) {
      const entries = fs.readdirSync(target);
      if (entries.length) throw new Error(`Destination already exists and is not empty: ${target}`);
    }
    const branch = body.branch ? validateBranchName(body.branch) : null;
    const args = ['clone'];
    if (branch) args.push('-b', branch);
    args.push(gitUrl, target);
    const result = await runGitIn(parent, args, { timeout: GIT_TIMEOUT_MS });
    repoPath = target;
    try {
      const topLevel = (await runGit(['rev-parse', '--show-toplevel'])).trim();
      if (topLevel) repoPath = path.resolve(topLevel);
    } catch (_) {}
    saveState();
    log(`Cloned ${gitUrl} into ${repoPath}`);
    return send(req, res, 200, { ok: true, result: (result || '').trim(), repository: await repoSummary() });
  }

  if (!repoPath) {
    return send(req, res, 400, { error: 'Connect a repository first' });
  }

  /* ---- status ---- */
  if (route === '/api/git/status' && req.method === 'GET') {
    const raw = await runGit(['status', '--porcelain=v1', '-z', '-uall']);
    return send(req, res, 200, {
      branch: await currentBranch(),
      files: parseStatus(raw),
    });
  }

  /* ---- staging ---- */
  if (route === '/api/git/stage' && req.method === 'POST') {
    const rel = safeRel(body.path);
    await runGit(['add', '--', rel]);
    return send(req, res, 200, { ok: true });
  }

  if (route === '/api/git/unstage' && req.method === 'POST') {
    const rel = safeRel(body.path);
    if (await hasHead()) {
      await runGit(['restore', '--staged', '--', rel]);
    } else {
      // No commits yet: `git restore --staged` has no HEAD to restore from.
      await runGit(['rm', '--cached', '-r', '--', rel]);
    }
    return send(req, res, 200, { ok: true });
  }

  if (route === '/api/git/stage-all' && req.method === 'POST') {
    await runGit(['add', '-A']);
    return send(req, res, 200, { ok: true });
  }

  /* ---- commit (v2.1: --amend + commit-all) ---- */
  if (route === '/api/git/commit' && req.method === 'POST') {
    const summary = String(body.summary || '').trim();
    if (!summary) throw new Error('Commit summary is required');
    const description = String(body.description || '').trim();
    const message = description ? `${summary}\n\n${description}` : summary;
    const amend = body.amend === true;
    const commitAll = body.all === true;

    // Fail with a readable message instead of git's cryptic identity error.
    try {
      await runGit(['var', 'GIT_AUTHOR_IDENT']);
    } catch (_) {
      throw new Error(
        'Git author identity is not configured. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"'
      );
    }

    if (commitAll) {
      await runGit(['add', '-A']);
    }

    if (!amend) {
      const staged = (await runGit(['diff', '--cached', '--name-only'])).trim();
      // A merge commit after resolving conflicts may legitimately have
      // nothing staged (e.g. "ours" == HEAD for every file) — git still
      // records the merge, so let it through when MERGE_HEAD exists.
      const merging = await isMerging();
      if (!staged && !merging) throw new Error('Nothing is staged. Stage files before committing.');
    } else if (!(await hasHead())) {
      throw new Error('Cannot amend: there is no commit yet.');
    }

    const args = ['commit', '-m', message];
    if (amend) args.push('--amend');
    const result = await runGit(args);
    return send(req, res, 200, { ok: true, result: result.trim(), amended: amend });
  }

  /* ---- remote sync (v2.1: pull/push/sync expanded) ---- */
  if (route === '/api/git/fetch' && req.method === 'POST') {
    return send(req, res, 200, { ok: true, result: (await runGit(['fetch', '--all', '--prune'])).trim() });
  }

  if (route === '/api/git/pull' && req.method === 'POST') {
    // { mode: 'merge' (default) | 'rebase' | 'ff-only', remote, branch }
    // A merge conflict returns HTTP 200 with { ok: false, conflict: true,
    // conflicts } so the UI can offer ours/theirs instead of a bare error.
    const pulled = await pullRepo({
      mode: body.mode || 'merge',
      remote: body.remote || 'origin',
      branch: body.branch || null,
    });
    return send(req, res, 200, { ok: pulled.ok, ...pulled, ...(await aheadBehind()) });
  }

  if (route === '/api/git/push' && req.method === 'POST') {
    // { remote, branch, setUpstream, force (needs confirm=true), pushAll, tags }
    const pushed = await pushRepo({
      remote: body.remote || 'origin',
      branch: body.branch || null,
      setUpstream: !!body.setUpstream,
      force: !!body.force,
      confirm: body.confirm === true,
      pushAll: !!body.pushAll,
      tags: !!body.tags,
    });
    return send(req, res, 200, { ok: true, ...pushed, ...(await aheadBehind()) });
  }

  // One-click sync: fetch -> pull -> push, with a per-step report.
  if (route === '/api/git/sync' && req.method === 'POST') {
    const mode = ['merge', 'rebase', 'ff-only'].includes(body.mode) ? body.mode : 'merge';
    const steps = [];
    let pulled = null;
    let pushed = null;
    try {
      const fetchOut = await runGit(['fetch', '--all', '--prune']);
      steps.push({ step: 'fetch', ok: true, result: (fetchOut || '').trim() });
    } catch (err) {
      steps.push({ step: 'fetch', ok: false, error: err.message });
      return send(req, res, 200, { ok: false, steps, error: err.message, ...(await aheadBehind()) });
    }
    try {
      pulled = await pullRepo({ mode, remote: body.remote || 'origin', branch: body.branch || null });
    } catch (err) {
      steps.push({ step: 'pull', ok: false, error: err.message });
      return send(req, res, 200, { ok: false, steps, error: err.message, ...(await aheadBehind()) });
    }
    steps.push({ step: 'pull', ok: pulled.ok, conflict: !!pulled.conflict, conflicts: pulled.conflicts || [], result: pulled.result || '', commitsPulled: pulled.commitsPulled || 0, changedFiles: pulled.changedFiles || [] });
    if (!pulled.ok) {
      return send(req, res, 200, { ok: false, conflict: !!pulled.conflict, conflicts: pulled.conflicts || [], steps, pulled, ...(await aheadBehind()) });
    }
    try {
      pushed = await pushRepo({ remote: body.remote || 'origin', branch: body.branch || null });
      steps.push({ step: 'push', ok: true, result: pushed.result || '' });
    } catch (err) {
      steps.push({ step: 'push', ok: false, error: err.message });
      return send(req, res, 200, { ok: false, steps, pulled, error: err.message, ...(await aheadBehind()) });
    }
    return send(req, res, 200, { ok: true, steps, pulled, pushed, ...(await aheadBehind()) });
  }

  // How many commits ahead of / behind the upstream branch.
  if (route === '/api/git/ahead-behind' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, ...(await aheadBehind()) });
  }

  /* ---- branches (v2.1: local + remote, create/rename/delete) ---- */
  if (route === '/api/git/branches' && req.method === 'GET') {
    // `%(HEAD)` is "*" or " " and branch names cannot contain spaces, so the
    // first character plus the rest of the line is an unambiguous split.
    const raw = await runGit(['branch', '--format=%(HEAD) %(refname:short)']);
    const branches = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => ({
        current: line.charAt(0) === '*',
        name: line.slice(2).trim(),
      }))
      .filter((b) => b.name);
    const remoteRaw = await runGit(['branch', '-r', '--format=%(refname:short)']).catch(() => '');
    const remoteBranches = remoteRaw.split('\n').map((s) => s.trim()).filter((s) => s && !s.includes(' -> '));
    return send(req, res, 200, { branches, remoteBranches, current: await currentBranch() });
  }

  if (route === '/api/git/branch/create' && req.method === 'POST') {
    const name = validateBranchName(body.name);
    const from = body.from ? validateBranchName(body.from) : null;
    const checkout = body.checkout === true;
    if (checkout) {
      const args = ['checkout', '-b', name];
      if (from) args.push(from);
      await runGit(args);
    } else {
      const args = ['branch', name];
      if (from) args.push(from);
      await runGit(args);
    }
    return send(req, res, 200, { ok: true, branch: name, current: await currentBranch(), repository: await repoSummary() });
  }

  if (route === '/api/git/branch/rename' && req.method === 'POST') {
    const oldName = validateBranchName(body.old || body.from);
    const newName = validateBranchName(body.new || body.to);
    const current = await currentBranch();
    if (oldName === current) {
      await runGit(['branch', '-m', newName]);
    } else {
      await runGit(['branch', '-m', oldName, newName]);
    }
    return send(req, res, 200, { ok: true, old: oldName, new: newName, current: await currentBranch() });
  }

  if (route === '/api/git/branch/delete' && req.method === 'POST') {
    const name = validateBranchName(body.name);
    const remote = body.remote === true;
    const force = body.force === true;
    const current = await currentBranch();
    if (!remote && name === current) {
      throw new Error(`Cannot delete the current branch (${name}). Switch to another branch first.`);
    }
    let localDeleted = false;
    let remoteDeleted = false;
    if (!remote) {
      await runGit(['branch', force ? '-D' : '-d', name]);
      localDeleted = true;
    }
    if (remote || body.deleteRemote === true) {
      const remoteName = validateRemoteName(body.remoteName || 'origin');
      await runGit(['push', remoteName, '--delete', name]);
      remoteDeleted = true;
    }
    return send(req, res, 200, { ok: true, branch: name, localDeleted, remoteDeleted, current: await currentBranch() });
  }

  /* ---- merge + conflicts (v2.1) ---- */
  if (route === '/api/git/merge' && req.method === 'POST') {
    const branch = validateBranchName(body.branch);
    const args = ['merge'];
    if (body.noFF === true) args.push('--no-ff');
    args.push(branch);
    let result;
    try {
      result = await runGit(args);
    } catch (err) {
      const text = `${err.message || ''} ${err.gitStderr || ''}`;
      if (/CONFLICT/i.test(text) || /Automatic merge failed/i.test(text)) {
        const conflicts = await conflictedFiles();
        return send(req, res, 200, { ok: false, conflict: true, conflicts, branch, result: text.trim() });
      }
      throw err;
    }
    return send(req, res, 200, { ok: true, conflict: false, branch, result: (result || '').trim() });
  }

  if (route === '/api/git/conflicts' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, merging: await isMerging(), conflicts: await conflictedFiles() });
  }

  if (route === '/api/git/conflict/resolve' && req.method === 'POST') {
    const rel = safeRel(body.path);
    const side = body.side === 'theirs' ? 'theirs' : 'ours';
    if (!(await isMerging()) && (await conflictedFiles()).length === 0) {
      throw new Error('No merge conflict in progress');
    }
    await runGit(['checkout', `--${side}`, '--', rel]);
    await runGit(['add', '--', rel]);
    const remaining = await conflictedFiles();
    return send(req, res, 200, { ok: true, path: rel, side, remainingConflicts: remaining, allResolved: remaining.length === 0 });
  }

  if (route === '/api/git/merge/abort' && req.method === 'POST') {
    if (!(await isMerging())) throw new Error('No merge in progress to abort');
    await runGit(['merge', '--abort']);
    return send(req, res, 200, { ok: true, conflicts: [] });
  }

  /* ---- stash (v2.1) ---- */
  if (route === '/api/git/stash/create' && req.method === 'POST') {
    const message = String(body.message || '').trim();
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    const result = await runGit(args);
    const out = (result || '').trim();
    if (/No local changes to save/i.test(out)) {
      throw new Error('Nothing to stash — the working tree is clean.');
    }
    return send(req, res, 200, { ok: true, result: out, stashes: parseStashList(await runGit(['stash', 'list'])) });
  }

  if (route === '/api/git/stash/list' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, stashes: parseStashList(await runGit(['stash', 'list'])) });
  }

  if (route === '/api/git/stash/apply' && req.method === 'POST') {
    const index = Number(body.index) || 0;
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    const pop = body.pop === true;
    const result = await runGit(['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]);
    return send(req, res, 200, { ok: true, result: (result || '').trim(), stashes: parseStashList(await runGit(['stash', 'list'])) });
  }

  if (route === '/api/git/stash/drop' && req.method === 'POST') {
    const index = Number(body.index) || 0;
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    const result = await runGit(['stash', 'drop', `stash@{${index}}`]);
    return send(req, res, 200, { ok: true, result: (result || '').trim(), stashes: parseStashList(await runGit(['stash', 'list'])) });
  }

  if (route === '/api/git/checkout' && req.method === 'POST') {
    const branch = String(body.branch || '').trim();
    if (!branch) throw new Error('Branch name is required');
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
      throw new Error('Invalid branch name');
    }
    // Only tracked changes block a checkout; untracked files usually do not.
    const dirty = (await runGit(['status', '--porcelain', '--untracked-files=no'])).trim();
    if (dirty) throw new Error('Working tree has changes. Commit or stash them before switching branch.');
    try {
      await runGit(['switch', branch]);
    } catch (err) {
      // git < 2.23 has no `switch`
      if (/not a git command|unknown subcommand/i.test(err.message)) {
        await runGit(['checkout', branch]);
      } else {
        throw err;
      }
    }
    return send(req, res, 200, { ok: true, repository: await repoSummary() });
  }

  /* ---- history (v2.1: paginated) ---- */
  if (route === '/api/git/log' && req.method === 'GET') {
    if (!(await hasHead())) return send(req, res, 200, { commits: [], page: 1, per_page: 30 });
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const skip = (page - 1) * perPage;
    const raw = await runGit(['log', `--max-count=${perPage}`, `--skip=${skip}`, '--date=short', '--pretty=format:%h%x1f%s%x1f%an%x1f%ad']);
    const commits = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, date] = line.split('\x1f');
        return { hash, subject, author, date };
      });
    return send(req, res, 200, { commits, page, per_page: perPage, has_next: commits.length === perPage });
  }

  /* ---- diff summary (v2.1): per-file insertions/deletions ---- */
  if (route === '/api/git/diff/summary' && req.method === 'GET') {
    const worktree = parseNumstat(await runGit(['diff', '--numstat']).catch(() => ''));
    const staged = parseNumstat(await runGit(['diff', '--cached', '--numstat']).catch(() => ''));
    return send(req, res, 200, { ok: true, worktree, staged });
  }

  /* ---- remotes (v2.1) ---- */
  if (route === '/api/git/remotes' && req.method === 'GET') {
    // Raw config values, not `git remote -v`: -v applies url.insteadOf
    // rewriting, so a GitHub remote redirected to a local mirror would
    // show up as a local path. The UI wants the configured URL.
    const urlRaw = await runGit(['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '');
    const pushRaw = await runGit(['config', '--get-regexp', '^remote\\..*\\.pushurl$']).catch(() => '');
    const byName = new Map();
    for (const line of urlRaw.split('\n')) {
      const m = line.match(/^remote\.(.+)\.url\s+(.*)$/);
      if (!m) continue;
      const entry = byName.get(m[1]) || { name: m[1], fetchUrl: null, pushUrl: null };
      entry.fetchUrl = m[2].trim();
      byName.set(m[1], entry);
    }
    for (const line of pushRaw.split('\n')) {
      const m = line.match(/^remote\.(.+)\.pushurl\s+(.*)$/);
      if (!m) continue;
      const entry = byName.get(m[1]) || { name: m[1], fetchUrl: null, pushUrl: null };
      entry.pushUrl = m[2].trim();
      byName.set(m[1], entry);
    }
    for (const entry of byName.values()) {
      if (!entry.pushUrl) entry.pushUrl = entry.fetchUrl;
    }
    return send(req, res, 200, { ok: true, remotes: [...byName.values()] });
  }

  if (route === '/api/git/remote/add' && req.method === 'POST') {
    const name = validateRemoteName(body.name);
    const remoteUrl = validateGitUrl(body.url);
    const result = await runGit(['remote', 'add', name, remoteUrl]);
    return send(req, res, 200, { ok: true, name, url: remoteUrl, result: (result || '').trim() });
  }

  if (route === '/api/git/remote/remove' && req.method === 'POST') {
    const name = validateRemoteName(body.name);
    const result = await runGit(['remote', 'remove', name]);
    return send(req, res, 200, { ok: true, name, result: (result || '').trim() });
  }

  if (route === '/api/git/remote/set-url' && req.method === 'POST') {
    const name = validateRemoteName(body.name);
    const remoteUrl = validateGitUrl(body.url);
    const result = await runGit(['remote', 'set-url', name, remoteUrl]);
    return send(req, res, 200, { ok: true, name, url: remoteUrl, result: (result || '').trim() });
  }

  /* ---- diff ---- */
  if (route === '/api/git/diff' && req.method === 'GET') {
    const rel = safeRel(url.searchParams.get('path'));
    let diff = '';

    if (await hasHead()) {
      try {
        diff = await runGit(['diff', 'HEAD', '--', rel]);
      } catch (_) {}
      if (!diff) {
        try {
          diff = await runGit(['diff', '--cached', '--', rel]);
        } catch (_) {}
      }
    } else {
      try {
        diff = await runGit(['diff', '--cached', '--', rel]);
      } catch (_) {}
    }

    // Untracked file: show its content as an all-added diff.
    if (!diff) {
      const abs = path.join(repoPath, rel);
      const tracked = await runGit(['ls-files', '--error-unmatch', '--', rel]).then(() => true).catch(() => false);
      if (!tracked && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        try {
          const content = fs.readFileSync(abs, 'utf8');
          const lines = content.split('\n');
          diff = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
        } catch (_) {
          diff = '(Binary or unreadable file; no text diff available.)';
        }
      }
    }

    if (!diff) diff = '(No text diff; the file may be binary or unchanged.)';
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n… diff truncated at ${MAX_DIFF_CHARS} characters …`;
    }
    return send(req, res, 200, { path: rel, diff });
  }

  return send(req, res, 404, { error: `Unknown endpoint: ${req.method} ${route}` });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

loadState();
loadGhConfig();
loadOAuthAppConfig();
autoUpdate.enabled = !!(ghConfig.autoUpdate && ghConfig.autoUpdate.enabled);
autoUpdate.intervalSeconds = clampInterval(ghConfig.autoUpdate && ghConfig.autoUpdate.intervalSeconds);
autoUpdate.autoSync = !!(ghConfig.autoUpdate && ghConfig.autoUpdate.autoSync);
scheduleAutoUpdate();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof GhError) {
      return send(req, res, err.status || 400, { error: err.message });
    }
    send(req, res, 400, { error: (err && err.message) || 'Bridge error' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error('Another bridge instance is probably running. Close it, or start with:');
    console.error(`  BRIDGE_PORT=17322 node bridge-server.js\n`);
    process.exit(1);
  }
  console.error('Bridge server error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`PixiJS GitHub Bridge v${VERSION}`);
  console.log(`Listening:  http://${HOST}:${PORT}`);
  console.log(`Token file: ${TOKEN_FILE}`);
  console.log(`TOKEN:      ${TOKEN}`);
  console.log(`GitHub API: ${GITHUB_API_BASE}`);
  if (ghAuthed()) {
    console.log(`GitHub:     signed in as ${ghConfig.user.login} (${ghConfig.authMethod || 'token'}, since ${ghConfig.authedAt})`);
  } else {
    console.log('GitHub:     not signed in — sign in from the extension (Connect GitHub, PAT or Device Flow).');
  }
  if (!oauthClientId()) console.log('OAuth App:  not configured — Device Flow and Connect GitHub need a client id (see README section 6).');
  else if (!oauthClientSecret()) console.log('OAuth App:  client id set, client secret missing — Connect GitHub (Web Flow) needs the secret too.');
  else console.log('OAuth App:  configured — Connect GitHub (Web Flow) and Device Flow are available.');
  console.log(`Auto-update: ${autoUpdate.enabled ? `ON every ${autoUpdate.intervalSeconds}s${autoUpdate.autoSync ? ' + auto-sync' : ''}` : 'OFF'}`);
  if (repoPath) console.log(`Repository: ${repoPath}`);
  console.log('');
  console.log('Paste the TOKEN into the extension dashboard, then click "Connect Bridge".');
  console.log('Keep this terminal open. Press Ctrl+C to stop.');
  console.log('');
});

function shutdown() {
  console.log('\nStopping bridge…');
  if (autoUpdate.timer) clearTimeout(autoUpdate.timer);
  for (const res of [...sseClients]) { try { res.end(); } catch (_) {} }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
