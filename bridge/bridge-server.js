#!/usr/bin/env node
'use strict';

/*
 * PixiJS GitHub Desktop Sync - Local Git + GitHub Bridge
 * v3.7.1
 *
 * A dependency-free local bridge (Node >= 12, only built-in modules) that
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
 *   3. GITHUB API v3.0 - login diagnostics (Vietnamese) + PAT format
 *      guard (passwords are never accepted), repo .zip download via
 *      codeload + local `git archive` zip, repo create/edit/delete,
 *      fork, star, issues (+comments), pull requests (+merge),
 *      releases (+asset download), binary file upload (contentBase64),
 *      file delete, code search, notifications, full profile; local
 *      git adds cherry-pick, revert, reset (hard needs confirm) and
 *      tags (create/list/delete/push).
 *   4. v3.1.0 - extended pull/push: pull preview (incoming commits,
 *      fast-forward?, dirty overlap, likely conflicts), autostash,
 *      prune/tags/squash/no-commit/-X strategy/unrelated/submodules/
 *      unshallow/depth, rebase-merges, undo last pull (reset --keep),
 *      pull ALL branches (fast-forward only), rebase continue/skip/
 *      abort + rebase-aware ours/theirs; push preview (outgoing,
 *      will-be-rejected), --porcelain ref report, rejection reason +
 *      Vietnamese hint, dry-run, push to another remote branch name,
 *      push up to a commit, multi-remote push, --follow-tags,
 *      --atomic, --no-verify, -o push options, --force-if-includes,
 *      explicit lease SHA; live progress over SSE; pull/push history;
 *      GitHub HTTPS remotes reuse the signed-in token. Node >= 12.
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
 *  - No plain --force / arbitrary shell endpoint. The only forceful
 *    operations are `git push --force-with-lease` and `git reset
 *    --hard`, each only when the caller passes confirm=true explicitly.
 *  - GitHub requests use httpFetch (built-in http/https, Node >= 12) with a timeout and
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
 *  - GITHUB_CODELOAD_BASE (default https://codeload.github.com)
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
const https = require('https');
const zlib = require('zlib'); // v3.5.0: inflate GitHub Actions log ZIPs (no extra dependency)

// v3.7.1: minimum Node.js is 12.0.0 (was 16.13.0). The bridge avoids
// every post-12 syntax/API on purpose (no ?. / ?? / replaceAll / .at /
// AbortController / structuredClone — verified against Node 12.22.12),
// so it runs on the old Node the user already has. Node 12 is EOL and
// insecure, so the message still recommends a newer LTS when possible.
(function checkNodeVersion() {
  const m = /^v(\d+)\.(\d+)/.exec(process.version) || [];
  const major = Number(m[1]) || 0;
  if (major < 12) {
    console.error(`\n[LOI] Node.js ${process.version} qua cu — bridge can Node.js 12.0.0 tro len.`);
    console.error('Cai Node.js 12+ (khuyen dung ban LTS moi nhat) tai https://nodejs.org/ roi chay lai.\n');
    process.exit(1);
  }
})();
const { URL } = require('url');

/* ------------------------------------------------------------------ */
/* .env auto-config (v3.5.1) — no dependencies, no magic.              */
/* On startup the bridge reads ONE file — <DATA_DIR>/.env, where      */
/* DATA_DIR is BRIDGE_DATA_DIR when set, otherwise this file's own    */
/* folder (bridge/) — and fills in any process.env key that is not    */
/* already set. A real environment variable always wins over .env.    */
/* Loading only the data dir's file matters: test bridges run with a  */
/* throwaway BRIDGE_DATA_DIR, so they must never pick up the real     */
/* machine's .env (that would sign them in with a real PAT against    */
/* their mock GitHub). Supported keys (see bridge/.env.example):      */
/* BRIDGE_TOKEN, BRIDGE_PORT, GITHUB_PAT, GITHUB_OAUTH_CLIENT_ID,     */
/* GITHUB_OAUTH_CLIENT_SECRET, DEFAULT_REPO_PATH, and auto-update     */
/* settings. Only the KEY NAMES are ever logged, never the values.   */
/* are ever logged, never the values. .env is git-ignored (see        */
/* .gitignore) and must NEVER be pushed to GitHub — it can hold live  */
/* secrets.                                                           */
/* ------------------------------------------------------------------ */
function loadDotEnv() {
  const found = [];
  const dataDir = process.env.BRIDGE_DATA_DIR ? path.resolve(process.env.BRIDGE_DATA_DIR) : path.resolve(__dirname);
  const file = path.join(dataDir, '.env');
  try {
    if (!fs.existsSync(file)) return found;
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
      if (!found.includes(m[1])) found.push(m[1]);
    }
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  } catch (_) {}
  return found;
}
const DOTENV_KEYS = loadDotEnv();

const VERSION = '3.7.1';
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
const GITHUB_CODELOAD_BASE = (process.env.GITHUB_CODELOAD_BASE || 'https://codeload.github.com').replace(/\/+$/, '');
const GITHUB_CLIENT_ID = String(process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '').trim();
const GITHUB_CLIENT_SECRET = String(process.env.GITHUB_OAUTH_CLIENT_SECRET || '').trim();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // a login attempt lives 10 minutes

const GIT_TIMEOUT_MS = 120000; // hard cap so a credential prompt can never hang the bridge
const GH_TIMEOUT_MS = 20000; // GitHub API calls must fail fast
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 400000;
const MAX_LOG_CHARS = 200 * 1024; // v3.5.0: Actions run logs are truncated to ~200 KB of text
const GH_SCOPES = 'repo read:user';
const AUTO_UPDATE_MIN_SECONDS = 15;
const AUTO_UPDATE_MAX_SECONDS = 3600;
const AUTO_UPDATE_DEFAULT_SECONDS = 60;
const REPO_LIST_CACHE_MS = 60 * 1000;
const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ */
/* httpFetch — tiny fetch() replacement (v3.1.0, Node 12+)             */
/* ------------------------------------------------------------------ */
/* Node 12/16 have no global fetch / AbortSignal.timeout / Readable.fromWeb */
/* so the bridge uses this instead on every Node version — one code    */
/* path, built-in http/https only. Returns a fetch-like response:      */
/*   { ok, status, headers.get(), text(), json(), arrayBuffer(), body } */
/* where `body` is the raw Node readable stream (pipe it directly).    */
/* Redirects are followed (max 10); Authorization is dropped when a    */
/* redirect leaves the original host (GitHub asset → S3 signed URL).   */

function httpFetch(url, init = {}, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (_) { return reject(new TypeError(`Invalid URL: ${url}`)); }
    const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!lib) return reject(new TypeError(`Unsupported protocol: ${target.protocol}`));
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.assign({}, init.headers || {});
    let payload = null;
    if (init.body !== undefined && init.body !== null) {
      payload = Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body), 'utf8');
      headers['Content-Length'] = String(payload.length);
    }
    const timeoutMs = Number(init.timeout) || GH_TIMEOUT_MS;
    let settled = false;
    const req = lib.request(target, { method, headers }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        clearTimeout(timer);
        settled = true;
        const next = new URL(res.headers.location, target);
        const nextInit = Object.assign({}, init, { headers: Object.assign({}, headers) });
        delete nextInit.headers['Content-Length'];
        if (next.host !== target.host) {
          for (const k of Object.keys(nextInit.headers)) if (k.toLowerCase() === 'authorization') delete nextInit.headers[k];
        }
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          nextInit.method = 'GET';
          delete nextInit.body;
        }
        return resolve(httpFetch(next.toString(), nextInit, redirectsLeft - 1));
      }
      clearTimeout(timer);
      settled = true;
      // Body idle timeout: a stalled download is cut after 60 s of silence.
      res.setTimeout(Math.max(timeoutMs, 60000), () => res.destroy(new Error('Response body timed out')));
      let consumed = null;
      const readAll = () => {
        if (!consumed) {
          consumed = new Promise((ok, bad) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(Buffer.from(d)));
            res.on('end', () => ok(Buffer.concat(chunks)));
            res.on('error', bad);
          });
        }
        return consumed;
      };
      resolve({
        ok: status >= 200 && status < 300,
        status,
        url: target.toString(),
        headers: { get: (name) => {
          const v = res.headers[String(name).toLowerCase()];
          return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v);
        } },
        body: res,
        text: async () => (await readAll()).toString('utf8'),
        json: async () => JSON.parse((await readAll()).toString('utf8')),
        arrayBuffer: async () => { const b = await readAll(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
      });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`Request timed out after ${timeoutMs / 1000}s`);
      err.name = 'TimeoutError';
      err.code = 'ETIMEDOUT';
      req.destroy(err);
      reject(err);
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

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
  // v3.5.1: a BRIDGE_TOKEN in .env (or the real environment) is stable
  // across restarts and fresh downloads — use it when present, and
  // mirror it into .bridge-token so the old hint still works.
  const envToken = String(process.env.BRIDGE_TOKEN || '').trim();
  if (envToken && !/\s/.test(envToken) && envToken.length >= 16) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, envToken, { mode: 0o600 });
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
    } catch (_) {}
    return envToken;
  }
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
let recentRepos = []; // v3.1.1: [{ path, name, remote, at }] newest first (max 20)
let lastFetchAt = null; // v3.1.1: ISO time of the last successful fetch

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = safeJsonParse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.repoPath === 'string' && raw.repoPath) {
      const abs = path.resolve(raw.repoPath);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) repoPath = abs;
    }
    if (raw && Array.isArray(raw.recentRepos)) {
      recentRepos = raw.recentRepos
        .filter((r) => r && typeof r.path === 'string' && r.path)
        .slice(0, 20);
    }
  } catch (_) {}
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ repoPath, recentRepos }, null, 2), { mode: 0o600 });
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
    email: u.email || null,
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
  // v3.0.1: the dashboard can also be served from a local static server
  // while debugging (http://localhost:<port> / http://127.0.0.1:<port>),
  // and it is often opened directly as a local file (Origin: null).
  // Both are allowed — the bearer token is still required for every
  // /api route, so an unknown page cannot do anything without it.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  if (origin === 'null') {
    log('CORS: allowing null origin (dashboard opened as a local file — file://). Sign-in still requires the bridge token.');
    return 'null';
  }
  // Requests without an Origin header (curl, the extension's own fetch in some
  // contexts) are allowed; the bearer token is still required.
  if (!origin) return '';
  // v3.0.1: log rejected origins so a CORS block is diagnosable instead
  // of a silent "Failed to fetch" on the extension side.
  log('CORS: rejected origin ' + origin + ' — only the extension, localhost and file:// pages may call this bridge.');
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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
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
  constructor(status, message, body, code) {
    super(message);
    this.status = status;
    this.body = body || null;
    this.code = code || null;
  }
}

// fail(code, message): an Error carrying a machine-readable `code` so the
// UI can tell "wrong input shape" apart from a generic failure. The
// server's catch-all at the bottom of this file copies `code` into the
// JSON error response.
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
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
  // A missing header is null, and Number(null) is 0 — without this guard
  // every header-less response would fake "0 requests remaining".
  const num = (name) => {
    const v = get(name);
    if (v === null || v === undefined || v === '') return NaN;
    return Number(v);
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const reset = num('x-ratelimit-reset');
  const used = num('x-ratelimit-used');
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
  const init = { method, headers, timeout: opts.timeout || GH_TIMEOUT_MS };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await httpFetch(url, init);
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT')) throw new GhError(504, `GitHub request timed out (${method} ${apiPath})`);
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
  let dotenvSaved = false;
  try { updateDotEnvValues({ GITHUB_PAT: String(token) }); dotenvSaved = true; }
  catch (err) { log('Could not sync GitHub sign-in to .env:', err.message); }
  sseBroadcast('github-auth', { authed: true, login: user.login, authMethod, at: ghConfig.authedAt });
  log(`GitHub signed in as ${user.login} (${authMethod}, scopes: ${scopes || 'unknown'})`);
  return { dotenvSaved };
}

/* --- normalisers: the extension only ever sees these shapes --- */

function normalizeRepo(r) {
  if (!r) return null;
  return {
    id: (r.id === undefined || r.id === null) ? null : r.id,
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

function normalizePull(p) {
  if (!p) return null;
  return {
    number: p.number,
    title: p.title || '',
    state: p.state || '',
    html_url: p.html_url || '',
    user: (p.user && p.user.login) || '',
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    head: (p.head && p.head.ref) || '',
    base: (p.base && p.base.ref) || '',
    draft: !!p.draft,
    merged_at: p.merged_at || null,
    merged: !!p.merged,
  };
}

function normalizeComment(c) {
  if (!c) return null;
  return {
    id: c.id,
    user: (c.user && c.user.login) || '',
    body: c.body || '',
    created_at: c.created_at || null,
    html_url: c.html_url || '',
  };
}

function normalizeRelease(rel) {
  if (!rel) return null;
  return {
    id: rel.id,
    tag_name: rel.tag_name || '',
    name: rel.name || '',
    body: rel.body || '',
    draft: !!rel.draft,
    prerelease: !!rel.prerelease,
    html_url: rel.html_url || '',
    created_at: rel.created_at || null,
    assets: Array.isArray(rel.assets) ? rel.assets.map((a) => ({
      id: a.id,
      name: a.name || '',
      size: a.size || 0,
      download_count: a.download_count || 0,
      browser_download_url: a.browser_download_url || '',
    })) : [],
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

function autoUpdateDotEnvMatches() {
  try {
    const file = path.join(DATA_DIR, '.env');
    const contents = fs.readFileSync(file, 'utf8');
    const values = {
      GITHUB_AUTO_UPDATE_ENABLED: autoUpdate.enabled ? 'true' : 'false',
      GITHUB_AUTO_UPDATE_INTERVAL_SECONDS: String(autoUpdate.intervalSeconds),
      GITHUB_AUTO_SYNC: autoUpdate.autoSync ? 'true' : 'false',
    };
    const found = Object.create(null);
    for (const line of contents.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && Object.prototype.hasOwnProperty.call(values, m[1])) found[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return Object.entries(values).every(([key, value]) => found[key] === value);
  } catch (_) { return false; }
}
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
    dotenvSynced: autoUpdateDotEnvMatches(),
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

function updateDotEnvValues(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && /[\r\n]/.test(String(value))) throw new Error(`Invalid newline in .env value for ${key}`);
  }
  const file = path.join(DATA_DIR, '.env');
  let lines = [];
  try { if (fs.existsSync(file)) lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (err) { throw new Error(`Cannot read .env: ${err.message}`); }
  const keys = new Set(Object.keys(values));
  const seen = new Set();
  const next = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && keys.has(match[1])) {
      const value = values[match[1]];
      if (!seen.has(match[1]) && value !== null && value !== undefined) next.push(`${match[1]}=${String(value)}`);
      seen.add(match[1]);
    } else next.push(line);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key) && value !== null && value !== undefined) next.push(`${key}=${String(value)}`);
  }
  const content = next.join('\n').replace(/\n*$/, '\n');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  } catch (err) {
    try { fs.unlinkSync(temp); } catch (_) {}
    throw new Error(`Cannot save .env: ${err.message}`);
  }
  return true;
}
function persistAutoUpdateToDotEnv() {
  return updateDotEnvValues({
    GITHUB_AUTO_UPDATE_ENABLED: autoUpdate.enabled ? 'true' : 'false',
    GITHUB_AUTO_UPDATE_INTERVAL_SECONDS: String(autoUpdate.intervalSeconds),
    GITHUB_AUTO_SYNC: autoUpdate.autoSync ? 'true' : 'false',
  });
}

function setAutoUpdate(enabled, intervalSeconds, autoSync) {
  autoUpdate.enabled = !!enabled;
  if (intervalSeconds !== undefined) autoUpdate.intervalSeconds = clampInterval(intervalSeconds);
  if (autoSync !== undefined) autoUpdate.autoSync = !!autoSync;
  ghConfig.autoUpdate = { enabled: autoUpdate.enabled, intervalSeconds: autoUpdate.intervalSeconds, autoSync: autoUpdate.autoSync };
  saveGhConfig();
  let dotenvSaved = false;
  let dotenvError = null;
  try { persistAutoUpdateToDotEnv(); dotenvSaved = true; }
  catch (err) { dotenvError = err.message; log('Could not sync auto-update settings to .env:', err.message); }
  scheduleAutoUpdate();
  if (autoUpdate.enabled) {
    // Run one tick right away so the user sees fresh data immediately.
    // (v3.7.1: no ?.() — Node 12 has no optional chaining/call.)
    var _tickTimer = setTimeout(() => { autoUpdateTick(false); }, 500);
    if (_tickTimer && typeof _tickTimer.unref === 'function') _tickTimer.unref();
  }
  return { ...autoUpdateStatus(), dotenvSaved, dotenvError };
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
        env: Object.assign(gitEnv(), options.env || {}),
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
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      err += text;
      if (typeof options.onStderr === 'function') {
        try { options.onStderr(text); } catch (_) {}
      }
    });

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

// Binary twin of runGitIn: collects stdout as a Buffer instead of a
// string, so `git archive --format=zip` output survives intact.
function runGitBufferIn(cwd, args, options = {}) {
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
    const chunks = [];
    let errText = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`));
    }, options.timeout || GIT_TIMEOUT_MS);
    child.stdout.on('data', (d) => { chunks.push(Buffer.from(d)); });
    child.stderr.on('data', (d) => { errText += d.toString('utf8'); });
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
      if (code === 0) return resolve(Buffer.concat(chunks));
      const error = new Error((errText || '').trim() || `git exited with code ${code}`);
      error.gitCode = code;
      error.gitStderr = errText;
      reject(error);
    });
  });
}

function runGitBuffer(args, options = {}) {
  return runGitBufferIn(repoPath, args, options);
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

function validateSha(value) {
  const sha = String(value || '').trim();
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('A commit SHA (4-40 hex characters) is required');
  return sha;
}

// A ref for reset / archive / tag: a SHA, HEAD / HEAD~n, or a branch/tag
// name. Anything with whitespace or shell metacharacters is refused.
function validateGitRef(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('A ref is required');
  if (/^[0-9a-f]{4,40}$/i.test(value)) return value;
  if (/^HEAD(~\d+)?$/.test(value)) return value;
  return validateBranchName(value);
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

/* ------------------------------------------------------------------ */
/* v3.1.0 — extended pull / push                                       */
/* ------------------------------------------------------------------ */
/* - GitHub HTTPS remotes reuse the token you signed in with (a        */
/*   one-shot credential helper; the token is passed via env, never    */
/*   on the command line, never logged).                               */
/* - Live progress lines are broadcast over SSE as `git-progress`.     */
/* - Every pull/push/sync/undo is recorded in an in-memory history.    */

const PROGRESS_RE = /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Total|Unpacking|Updating files|Checking out|Delta compression|Finding sources)\b/;
const MAX_HISTORY = 50;
const MAX_COMMIT_LIST = 50;
const syncHistory = [];
let lastPull = null; // { oldSha, newSha, branch, at } — enables "Undo last pull"

function cleanGitOutput(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split('\r').pop())
    .filter((line) => line.trim() && !PROGRESS_RE.test(line.trim()))
    .join('\n')
    .trim();
}

function recordHistory(entry) {
  syncHistory.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (syncHistory.length > MAX_HISTORY) syncHistory.length = MAX_HISTORY;
  sseBroadcast('git-history', syncHistory[0]);
}

function progressReporter(op) {
  let lastSent = 0;
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const parts = pending.split(/[\r\n]/);
    pending = parts.pop();
    const line = parts.filter((p) => p.trim()).pop();
    if (!line) return;
    const now = Date.now();
    if (now - lastSent < 150 && !/100%|done/.test(line)) return;
    lastSent = now;
    sseBroadcast('git-progress', { op, line: line.trim(), at: now });
  };
}

async function rawRemoteUrl(remote) {
  try {
    return (await runGit(['config', '--get', `remote.${remote}.url`])).trim() || null;
  } catch (_) {
    return null;
  }
}

function githubHosts() {
  const hosts = new Set(['github.com']);
  try { hosts.add(new URL(GITHUB_OAUTH_BASE).host); } catch (_) {}
  return hosts;
}

/**
 * When the remote is an https:// GitHub URL and the user is signed in,
 * return extra `-c` args + env so git authenticates with that token.
 * `credential.helper=` (empty) first clears any other helper so no GUI
 * credential prompt can pop up and hang the bridge.
 */
async function githubAuthFor(remote, enabled) {
  if (enabled === false || !ghConfig.token) return { args: [], env: {}, used: false };
  return githubAuthForUrl(await rawRemoteUrl(remote), enabled);
}

function githubAuthForUrl(url, enabled) {
  if (enabled === false || !ghConfig.token) return { args: [], env: {}, used: false };
  if (!url || !/^https:\/\//i.test(url)) return { args: [], env: {}, used: false };
  let host = '';
  try { host = new URL(url).host; } catch (_) { return { args: [], env: {}, used: false }; }
  if (!githubHosts().has(host)) return { args: [], env: {}, used: false };
  return {
    args: [
      '-c', 'credential.helper=',
      '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$BRIDGE_GIT_TOKEN"; }; f',
    ],
    env: { BRIDGE_GIT_TOKEN: ghConfig.token },
    used: true,
  };
}

async function gitPath(name) {
  const rel = (await runGit(['rev-parse', '--git-path', name])).trim();
  return path.isAbsolute(rel) ? rel : path.join(repoPath, rel);
}

/** Which multi-step operation (if any) is waiting for the user. */
async function operationState() {
  if (!repoPath) return { state: null, conflicts: [] };
  let state = null;
  try {
    if (fs.existsSync(await gitPath('rebase-merge')) || fs.existsSync(await gitPath('rebase-apply'))) state = 'rebase';
    else if (fs.existsSync(await gitPath('MERGE_HEAD'))) state = 'merge';
    else if (fs.existsSync(await gitPath('CHERRY_PICK_HEAD'))) state = 'cherry-pick';
    else if (fs.existsSync(await gitPath('REVERT_HEAD'))) state = 'revert';
  } catch (_) { state = null; }
  return { state, conflicts: state ? await conflictedFiles() : [] };
}

const OPERATION_HINT = {
  rebase: 'Đang rebase dở — xử lý conflict rồi bấm "Rebase: Continue", hoặc "Rebase: Abort" để huỷ.',
  merge: 'Đang merge dở — xử lý conflict rồi Commit merge, hoặc "Abort merge" để huỷ.',
  'cherry-pick': 'Đang cherry-pick dở — xử lý conflict rồi commit, hoặc dùng git cherry-pick --abort.',
  revert: 'Đang revert dở — xử lý conflict rồi commit, hoặc dùng git revert --abort.',
};

async function assertNoOperation(what) {
  const op = await operationState();
  if (op.state) {
    throw fail('OPERATION_IN_PROGRESS', `Cannot ${what}: a ${op.state} is in progress. ${OPERATION_HINT[op.state]}`);
  }
}

function parseCommitLines(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, date, ...subject] = line.split('\x1f');
    out.push({ sha, short: sha.slice(0, 7), author, date, subject: subject.join('\x1f') });
  }
  return out;
}

async function commitList(range, limit = MAX_COMMIT_LIST) {
  try {
    return parseCommitLines(await runGit(['log', `--max-count=${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s', range]));
  } catch (_) {
    return [];
  }
}

async function countRange(range) {
  try { return Number((await runGit(['rev-list', '--count', range])).trim()) || 0; } catch (_) { return 0; }
}

async function diffStats(range) {
  try {
    const files = parseNumstat(await runGit(['diff', '--numstat', range]));
    return {
      files,
      fileCount: files.length,
      insertions: files.reduce((n, f) => n + (f.insertions || 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
    };
  } catch (_) {
    return { files: [], fileCount: 0, insertions: 0, deletions: 0 };
  }
}

async function dirtyFiles() {
  try {
    return parseStatus(await runGit(['status', '--porcelain=v1', '-z', '-uall'])).map((f) => f.path);
  } catch (_) {
    return [];
  }
}

async function refSha(ref) {
  try { return (await runGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`])).trim() || null; } catch (_) { return null; }
}

/* Classify a failed push/pull so the UI can say WHY and what to do. */
function classifyGitFailure(text) {
  const t = String(text || '');
  if (/\[rejected\].*\(fetch first\)|non-fast-forward|\(stale info\)|Updates were rejected/i.test(t)) {
    if (/stale info/i.test(t)) return { reason: 'stale-lease', hint: 'Remote đã thay đổi kể từ lần fetch cuối — force-with-lease đã chặn để bảo vệ commit của người khác. Fetch/Pull trước rồi thử lại.' };
    return { reason: 'non-fast-forward', hint: 'Remote có commit mới mà máy bạn chưa có. Pull (hoặc Sync) trước rồi Push lại. Chỉ dùng force-push khi chắc chắn muốn ghi đè.' };
  }
  if (/GH006|protected branch/i.test(t)) return { reason: 'protected-branch', hint: 'Branch này được bảo vệ trên GitHub — hãy push lên branch khác rồi tạo Pull Request.' };
  if (/GH013|push declined due to repository rule|secret scanning|push protection/i.test(t)) return { reason: 'repository-rule', hint: 'GitHub chặn push do rule của repo (ví dụ phát hiện secret). Xem chi tiết trong output.' };
  if (/Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|403|Permission to .* denied/i.test(t)) return { reason: 'auth', hint: 'Không xác thực được với remote. Đăng nhập GitHub trong dashboard (bridge sẽ tự dùng token cho remote https://github.com), hoặc cấu hình SSH key / credential helper.' };
  if (/Could not resolve host|unable to access|Connection timed out|Failed to connect/i.test(t)) return { reason: 'network', hint: 'Không kết nối được tới remote — kiểm tra mạng / proxy rồi thử lại.' };
  if (/does not appear to be a git repository|No such remote|repository .* not found/i.test(t)) return { reason: 'no-remote', hint: 'Remote không tồn tại hoặc sai URL — kiểm tra panel Remotes.' };
  if (/src refspec .* does not match any/i.test(t)) return { reason: 'no-local-branch', hint: 'Branch local chưa có commit nào hoặc tên branch sai.' };
  if (/hook declined|pre-push hook/i.test(t)) return { reason: 'hook', hint: 'Hook pre-push đã chặn. Sửa lỗi hook báo, hoặc tích "Bỏ qua hook (--no-verify)".' };
  if (/Your local changes to the following files would be overwritten|Please commit your changes or stash them/i.test(t)) return { reason: 'dirty-tree', hint: 'Có thay đổi chưa commit bị đè. Commit/stash trước, hoặc tích "Autostash".' };
  if (/Not possible to fast-forward|fatal: Not possible to fast-forward/i.test(t)) return { reason: 'not-fast-forward', hint: 'Không fast-forward được vì 2 bên đã rẽ nhánh — chọn Merge hoặc Rebase.' };
  if (/refusing to merge unrelated histories/i.test(t)) return { reason: 'unrelated-histories', hint: 'Hai lịch sử không liên quan — tích "Cho phép lịch sử không liên quan" nếu chắc chắn.' };
  if (/timed out/i.test(t)) return { reason: 'timeout', hint: 'Lệnh git chạy quá lâu và đã bị dừng. Thử lại hoặc kiểm tra mạng.' };
  return { reason: 'unknown', hint: null };
}

function failWithDetails(err, extra) {
  const text = `${err.message || ''}\n${err.gitStderr || ''}`;
  const cls = classifyGitFailure(text);
  const e = new Error(cleanGitOutput(err.message) + (cls.hint ? `\n→ ${cls.hint}` : ''));
  e.code = err.code || ('GIT_' + cls.reason.toUpperCase().replace(/-/g, '_'));
  e.details = Object.assign({ reason: cls.reason, hint: cls.hint }, extra || {});
  return e;
}

/* Porcelain push output: "<flag>\t<from>:<to>\t<summary>" */
const PUSH_FLAGS = { ' ': 'fast-forward', '+': 'forced', '-': 'deleted', '*': 'new', '!': 'rejected', '=': 'up-to-date' };
function parsePushPorcelain(text) {
  const refs = [];
  let remoteUrlSeen = null;
  for (const line of String(text || '').split('\n')) {
    const to = line.match(/^To (.+)$/);
    if (to) { remoteUrlSeen = to[1].trim(); continue; }
    const m = line.match(/^([ +\-*!=])\t([^\t]*)\t(.*)$/);
    if (!m) continue;
    const [from, dest] = m[2].split(':');
    refs.push({ flag: m[1], status: PUSH_FLAGS[m[1]] || 'unknown', from: from || null, to: dest || null, summary: m[3].trim() });
  }
  return { refs, url: remoteUrlSeen };
}

function validatePushOption(value) {
  const v = String(value || '');
  if (!v || /[\n\r\0]/.test(v) || v.length > 200) throw new Error('Invalid push option');
  return v;
}

/**
 * Pull from a remote. Returns a structured result; a merge/rebase
 * conflict is NOT an exception — it is { ok: false, conflict: true,
 * conflicts } so the UI can offer ours/theirs or rebase continue/abort.
 *
 * opts: mode (merge | rebase | rebase-merges | ff-only), remote, branch,
 *       autostash, prune, tags, noTags, squash, noCommit,
 *       strategyOption (ours | theirs | patience | ignore-space-change),
 *       allowUnrelated, recurseSubmodules, unshallow, depth,
 *       useGithubAuth (default true), progress (default true)
 */
async function pullRepo(opts = {}) {
  const MODES = ['merge', 'rebase', 'rebase-merges', 'ff-only'];
  const mode = MODES.includes(opts.mode) ? opts.mode : 'merge';
  const remote = validateRemoteName(opts.remote || 'origin');
  const branch = opts.branch ? validateBranchName(opts.branch) : null;
  await assertNoOperation('pull');
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot pull: no branch checked out');
  const targetBranch = branch || current;
  const upstream = await upstreamOf(current);
  const oldSha = await headSha();

  const args = ['pull'];
  if (mode === 'rebase') args.push('--rebase');
  else if (mode === 'rebase-merges') args.push('--rebase=merges');
  else if (mode === 'ff-only') args.push('--ff-only');
  else args.push('--no-rebase'); // merge mode: say so explicitly, or git
  // refuses divergent branches ("need to specify how to reconcile them").
  if (opts.autostash) args.push('--autostash');
  if (opts.prune) args.push('--prune');
  if (opts.tags && !opts.noTags) args.push('--tags');
  if (opts.noTags) args.push('--no-tags');
  if (mode === 'merge') {
    if (opts.squash) args.push('--squash');
    if (opts.noCommit) args.push('--no-commit');
    if (opts.allowUnrelated) args.push('--allow-unrelated-histories');
  }
  if (opts.strategyOption) {
    const so = String(opts.strategyOption);
    if (!['ours', 'theirs', 'patience', 'ignore-space-change', 'ignore-all-space'].includes(so)) {
      throw new Error('strategyOption must be ours, theirs, patience, ignore-space-change or ignore-all-space');
    }
    args.push('-X', so);
  }
  if (opts.recurseSubmodules) args.push('--recurse-submodules');
  if (opts.unshallow) {
    try {
      if ((await runGit(['rev-parse', '--is-shallow-repository'])).trim() === 'true') args.push('--unshallow');
    } catch (_) {}
  } else if (opts.depth) {
    const d = Number(opts.depth);
    if (!Number.isInteger(d) || d < 1 || d > 100000) throw new Error('depth must be a positive integer');
    args.push(`--depth=${d}`);
  }
  if (opts.progress !== false) args.push('--progress');
  // Plain `git pull` uses the configured upstream; an explicit branch
  // (or a branch without upstream) needs remote + branch on the command.
  if (!upstream || branch) args.push(remote, targetBranch);

  const auth = await githubAuthFor(remote, opts.useGithubAuth);
  const gitOpts = { env: auth.env };
  if (opts.progress !== false) gitOpts.onStderr = progressReporter('pull');

  let result;
  try {
    result = await runGit(auth.args.concat(args), gitOpts);
  } catch (err) {
    const text = `${err.message || ''} ${err.gitStderr || ''}`;
    if (/CONFLICT/i.test(text) || /Automatic merge failed/i.test(text) || /could not apply/i.test(text)) {
      const conflicts = await conflictedFiles();
      const op = await operationState();
      const entry = {
        ok: false, conflict: true, conflicts, mode, remote, branch: targetBranch,
        operation: op.state, hint: OPERATION_HINT[op.state] || null,
        autostashConflict: /conflicts in your autostash|Applying autostash resulted in conflicts/i.test(text),
        result: cleanGitOutput(text), usedGithubAuth: auth.used,
      };
      recordHistory({ type: 'pull', ok: false, conflict: true, mode, remote, branch: targetBranch, conflicts: conflicts.length });
      return entry;
    }
    recordHistory({ type: 'pull', ok: false, mode, remote, branch: targetBranch, error: cleanGitOutput(err.message).split('\n')[0] });
    throw failWithDetails(err, { mode, remote, branch: targetBranch });
  }

  const newSha = await headSha();
  let changedFiles = [];
  let commitsPulled = 0;
  let mergeCommits = 0;
  let stats = { files: [], fileCount: 0, insertions: 0, deletions: 0 };
  if (oldSha && newSha && oldSha !== newSha) {
    changedFiles = (await runGit(['diff', '--name-only', `${oldSha}..${newSha}`])).split('\n').map((s) => s.trim()).filter(Boolean);
    mergeCommits = Number((await runGit(['rev-list', '--count', '--merges', `${oldSha}..${newSha}`])).trim()) || 0;
    stats = await diffStats(`${oldSha}..${newSha}`);
  }
  // "Commits pulled" = commits that arrived from the remote in this
  // pull, measured as old HEAD .. FETCH_HEAD (the head just fetched).
  let fetchHeadSha = null;
  try {
    fetchHeadSha = (await runGit(['rev-parse', 'FETCH_HEAD'])).trim() || null;
  } catch (_) { fetchHeadSha = null; }
  let commits = [];
  if (oldSha && fetchHeadSha) {
    commitsPulled = await countRange(`${oldSha}..${fetchHeadSha}`);
    commits = await commitList(`${oldSha}..${fetchHeadSha}`);
  } else if (fetchHeadSha) {
    commitsPulled = await countRange(fetchHeadSha);
    commits = await commitList(fetchHeadSha);
  }
  // Squash / no-commit leave the result staged but uncommitted.
  const pendingCommit = !!(opts.squash || opts.noCommit) && mode === 'merge';
  if (oldSha && newSha && oldSha !== newSha) {
    lastPull = { oldSha, newSha, branch: current, at: new Date().toISOString() };
  }
  recordHistory({ type: 'pull', ok: true, mode, remote, branch: targetBranch, commits: commitsPulled, files: changedFiles.length, insertions: stats.insertions, deletions: stats.deletions, from: oldSha, to: newSha });
  return {
    ok: true, conflict: false, mode, remote, branch: targetBranch,
    result: cleanGitOutput(result), changedFiles, commitsPulled, commits,
    stats: { fileCount: stats.fileCount, insertions: stats.insertions, deletions: stats.deletions, files: stats.files.slice(0, 200) },
    fastForward: commitsPulled > 0 && mergeCommits === 0, newSha, previousSha: oldSha,
    upToDate: oldSha === newSha && !pendingCommit,
    pendingCommit,
    undoAvailable: !!(lastPull && lastPull.newSha === newSha),
    usedGithubAuth: auth.used,
  };
}

/**
 * Push to a remote. Force push is --force-with-lease ONLY, and only
 * when the caller passes confirm=true. Plain --force is never used.
 *
 * opts: remote, remotes[] (push to several), branch, remoteBranch
 *       (push local → different remote name), upTo (push only up to a
 *       commit), setUpstream, force + confirm, forceIfIncludes,
 *       leaseSha (expected remote sha), pushAll, tags, followTags,
 *       noVerify, atomic, dryRun, pushOptions[], useGithubAuth, progress
 */
async function pushRepo(opts = {}) {
  if (Array.isArray(opts.remotes) && opts.remotes.length) {
    const names = Array.from(new Set(opts.remotes.map((r) => validateRemoteName(r)))).slice(0, 10);
    const results = [];
    for (const name of names) {
      try {
        results.push(await pushRepo(Object.assign({}, opts, { remotes: null, remote: name })));
      } catch (err) {
        results.push({ ok: false, remote: name, error: err.message, reason: (err.details || {}).reason || 'unknown', hint: (err.details || {}).hint || null });
      }
    }
    const ok = results.every((r) => r.ok);
    return { ok, multi: true, results, pushed: results.some((r) => r.ok), remote: names.join(', '), branch: results[0] && results[0].branch, result: results.map((r) => `${r.remote}: ${r.ok ? 'OK' : 'FAILED — ' + r.error}`).join('\n') };
  }
  const remote = validateRemoteName(opts.remote || 'origin');
  const branch = opts.branch ? validateBranchName(opts.branch) : null;
  const remoteBranch = opts.remoteBranch ? validateBranchName(opts.remoteBranch) : null;
  await assertNoOperation('push');
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot push: no branch checked out');
  const targetBranch = branch || current;
  const destBranch = remoteBranch || targetBranch;
  if (opts.force && opts.confirm !== true) {
    throw new Error('Force push needs explicit confirmation. Tick the "force-push with lease" confirmation and try again.');
  }
  const args = ['push', '--porcelain'];
  if (opts.progress !== false) args.push('--progress');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.noVerify) args.push('--no-verify');
  if (opts.atomic) args.push('--atomic');
  if (opts.followTags) args.push('--follow-tags');
  for (const po of (Array.isArray(opts.pushOptions) ? opts.pushOptions : []).slice(0, 10)) {
    args.push('-o', validatePushOption(po));
  }
  if (opts.force) {
    if (opts.leaseSha) args.push(`--force-with-lease=refs/heads/${destBranch}:${validateSha(opts.leaseSha)}`);
    else args.push('--force-with-lease');
    if (opts.forceIfIncludes) args.push('--force-if-includes');
  }
  let mode = 'branch';
  if (opts.pushAll) {
    mode = 'all';
    args.push(remote, '--all');
  } else if (opts.tags) {
    mode = 'tags';
    args.push(remote, '--tags');
  } else {
    const upstream = await upstreamOf(current);
    const wantUpstream = (opts.setUpstream || !upstream) && !opts.upTo && !opts.dryRun && targetBranch === current;
    if (wantUpstream) args.push('-u');
    let src = targetBranch;
    if (opts.upTo) {
      mode = 'up-to';
      const sha = validateSha(opts.upTo);
      const full = await refSha(sha);
      if (!full) throw new Error(`Commit ${sha} not found`);
      // The commit must be on the branch being pushed.
      try { await runGit(['merge-base', '--is-ancestor', full, targetBranch]); } catch (_) {
        throw new Error(`Commit ${sha} is not on branch ${targetBranch}`);
      }
      src = full;
    }
    args.push(remote, (src === destBranch && !opts.upTo) ? src : `${src}:refs/heads/${destBranch}`);
  }

  const auth = await githubAuthFor(remote, opts.useGithubAuth);
  const gitOpts = { env: auth.env };
  if (opts.progress !== false) gitOpts.onStderr = progressReporter('push');
  const aheadBefore = mode === 'branch' || mode === 'up-to' ? await aheadBehind().catch(() => null) : null;
  let result;
  try {
    result = await runGit(auth.args.concat(args), gitOpts);
  } catch (err) {
    const parsed = parsePushPorcelain(err.message);
    recordHistory({ type: 'push', ok: false, remote, branch: targetBranch, remoteBranch: destBranch, dryRun: !!opts.dryRun, error: cleanGitOutput(err.message).split('\n').filter((l) => !/^\S\t|^To |^Done$/.test(l))[0] || 'push failed' });
    throw failWithDetails(err, { remote, branch: targetBranch, remoteBranch: destBranch, refs: parsed.refs, rejected: parsed.refs.some((r) => r.flag === '!') });
  }
  const parsed = parsePushPorcelain(result);
  const pushedCommits = aheadBefore && aheadBefore.hasUpstream && !remoteBranch ? aheadBefore.ahead : null;
  recordHistory({ type: 'push', ok: true, remote, branch: targetBranch, remoteBranch: destBranch, mode, dryRun: !!opts.dryRun, force: !!opts.force, refs: parsed.refs.length, commits: pushedCommits });
  return {
    ok: true, remote, branch: targetBranch, remoteBranch: destBranch, mode,
    result: cleanGitOutput(result).split('\n').filter((l) => l !== 'Done').join('\n'),
    refs: parsed.refs, url: parsed.url,
    pushed: !opts.dryRun, dryRun: !!opts.dryRun, forced: parsed.refs.some((r) => r.flag === '+'),
    upToDate: parsed.refs.length > 0 && parsed.refs.every((r) => r.flag === '='),
    commitsPushed: pushedCommits, usedGithubAuth: auth.used,
  };
}

/** What would a pull bring in? Fetches, but never touches the working tree. */
async function pullPreview(opts = {}) {
  const remote = validateRemoteName(opts.remote || 'origin');
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot preview: no branch checked out');
  const upstream = await upstreamOf(current);
  let targetBranch = opts.branch ? validateBranchName(opts.branch) : null;
  if (!targetBranch) {
    targetBranch = upstream && upstream.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : current;
  }
  const auth = await githubAuthFor(remote, opts.useGithubAuth);
  try {
    await runGit(auth.args.concat(['fetch', '--progress', remote, targetBranch]), { env: auth.env, onStderr: progressReporter('fetch') });
  } catch (err) {
    throw failWithDetails(err, { remote, branch: targetBranch });
  }
  const fetched = await refSha('FETCH_HEAD');
  const head = await headSha();
  if (!fetched) throw new Error('Nothing was fetched');
  const incomingCount = head ? await countRange(`HEAD..${fetched}`) : await countRange(fetched);
  const outgoingCount = head ? await countRange(`${fetched}..HEAD`) : 0;
  const incoming = head ? await commitList(`HEAD..${fetched}`) : await commitList(fetched);
  const stats = head ? await diffStats(`HEAD...${fetched}`) : { files: [], fileCount: 0, insertions: 0, deletions: 0 };
  const dirty = await dirtyFiles();
  const incomingPaths = new Set(stats.files.map((f) => f.path));
  const overlap = dirty.filter((p) => incomingPaths.has(p));
  // Files changed on BOTH sides since the merge base = likely conflicts.
  let possibleConflicts = [];
  if (head && incomingCount && outgoingCount) {
    try {
      const base = (await runGit(['merge-base', 'HEAD', fetched])).trim();
      const ours = new Set((await runGit(['diff', '--name-only', `${base}..HEAD`])).split('\n').filter(Boolean));
      possibleConflicts = Array.from(incomingPaths).filter((p) => ours.has(p));
    } catch (_) {}
  }
  return {
    ok: true, remote, branch: targetBranch, current, remoteSha: fetched, localSha: head,
    upToDate: incomingCount === 0,
    incomingCount, outgoingCount, incoming,
    canFastForward: incomingCount > 0 && outgoingCount === 0,
    diverged: incomingCount > 0 && outgoingCount > 0,
    stats: { fileCount: stats.fileCount, insertions: stats.insertions, deletions: stats.deletions, files: stats.files.slice(0, 200) },
    dirtyFiles: dirty.length, dirtyOverlap: overlap, possibleConflicts,
    suggestion: incomingCount === 0 ? 'Đã cập nhật — không có gì để pull.'
      : overlap.length ? 'Có file đang sửa trùng với thay đổi từ remote — bật Autostash hoặc commit trước khi pull.'
      : outgoingCount === 0 ? 'Pull sẽ fast-forward, không tạo merge commit.'
      : possibleConflicts.length ? `Hai bên đã rẽ nhánh và cùng sửa ${possibleConflicts.length} file — có thể conflict. Cân nhắc Rebase hoặc Merge cẩn thận.`
      : 'Hai bên đã rẽ nhánh — Merge sẽ tạo merge commit, Rebase sẽ đặt commit của bạn lên trên.',
    usedGithubAuth: auth.used,
  };
}

/** What would a push send? Fetches the remote branch to compare. */
async function pushPreview(opts = {}) {
  const remote = validateRemoteName(opts.remote || 'origin');
  const current = await currentBranch();
  if (!current || current.startsWith('(')) throw new Error('Cannot preview: no branch checked out');
  const branch = opts.branch ? validateBranchName(opts.branch) : current;
  const destBranch = opts.remoteBranch ? validateBranchName(opts.remoteBranch) : branch;
  const auth = await githubAuthFor(remote, opts.useGithubAuth);
  let remoteExists = true;
  try {
    await runGit(auth.args.concat(['fetch', '--progress', remote, destBranch]), { env: auth.env, onStderr: progressReporter('fetch') });
  } catch (err) {
    const text = `${err.message} ${err.gitStderr || ''}`;
    if (/couldn't find remote ref|not our ref|no such ref/i.test(text)) remoteExists = false;
    else throw failWithDetails(err, { remote, branch });
  }
  const local = await refSha(branch);
  if (!local) throw new Error(`Branch ${branch} has no commits`);
  const remoteSha = remoteExists ? await refSha('FETCH_HEAD') : null;
  const range = remoteSha ? `${remoteSha}..${local}` : local;
  const outgoingCount = await countRange(range);
  const outgoing = await commitList(range);
  const behindCount = remoteSha ? await countRange(`${local}..${remoteSha}`) : 0;
  const stats = remoteSha ? await diffStats(`${remoteSha}...${local}`) : { files: [], fileCount: 0, insertions: 0, deletions: 0 };
  const unpushedTags = [];
  try {
    const localTags = (await runGit(['tag', '--points-at', local])).split('\n').filter(Boolean);
    unpushedTags.push(...localTags);
  } catch (_) {}
  return {
    ok: true, remote, branch, remoteBranch: destBranch, localSha: local, remoteSha,
    remoteBranchExists: remoteExists, newBranch: !remoteExists,
    outgoingCount, outgoing, behindCount,
    willBeRejected: behindCount > 0,
    upToDate: remoteExists && outgoingCount === 0,
    stats: { fileCount: stats.fileCount, insertions: stats.insertions, deletions: stats.deletions, files: stats.files.slice(0, 200) },
    tagsOnHead: unpushedTags,
    suggestion: !remoteExists ? `Branch "${destBranch}" chưa có trên ${remote} — Push sẽ tạo branch mới (nên tích Set upstream).`
      : outgoingCount === 0 && behindCount === 0 ? 'Đã đồng bộ — không có gì để push.'
      : behindCount > 0 ? `Remote có ${behindCount} commit bạn chưa có — push thường sẽ bị từ chối. Pull/Sync trước, hoặc force-with-lease nếu chắc chắn.`
      : `Sẽ push ${outgoingCount} commit (fast-forward).`,
    usedGithubAuth: auth.used,
  };
}

/** Fast-forward every local branch that only lags its upstream. */
async function pullAllBranches(opts = {}) {
  const remote = validateRemoteName(opts.remote || 'origin');
  await assertNoOperation('update branches');
  const auth = await githubAuthFor(remote, opts.useGithubAuth);
  try {
    await runGit(auth.args.concat(['fetch', '--progress', '--prune', remote]), { env: auth.env, onStderr: progressReporter('fetch') });
  } catch (err) {
    throw failWithDetails(err, { remote });
  }
  const current = await currentBranch();
  const raw = await runGit(['for-each-ref', '--format=%(refname:short)\x1f%(upstream:short)\x1f%(objectname)', 'refs/heads']);
  const results = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name, up, sha] = line.split('\x1f');
    if (!up) { results.push({ branch: name, status: 'no-upstream' }); continue; }
    if (!up.startsWith(remote + '/')) { results.push({ branch: name, upstream: up, status: 'other-remote' }); continue; }
    const upSha = await refSha(up);
    if (!upSha) { results.push({ branch: name, upstream: up, status: 'upstream-gone' }); continue; }
    const behind = await countRange(`${sha}..${upSha}`);
    const ahead = await countRange(`${upSha}..${sha}`);
    if (!behind) { results.push({ branch: name, upstream: up, status: ahead ? 'ahead' : 'up-to-date', ahead, behind }); continue; }
    if (ahead) { results.push({ branch: name, upstream: up, status: 'diverged', ahead, behind }); continue; }
    try {
      if (name === current) {
        await runGit(['merge', '--ff-only', upSha]);
      } else {
        // Atomic compare-and-swap: only moves the ref if it is still `sha`.
        await runGit(['update-ref', '-m', `bridge: fast-forward from ${up}`, `refs/heads/${name}`, upSha, sha]);
      }
      results.push({ branch: name, upstream: up, status: 'updated', behind, from: sha, to: upSha });
    } catch (err) {
      results.push({ branch: name, upstream: up, status: 'failed', error: cleanGitOutput(err.message).split('\n')[0] });
    }
  }
  const updated = results.filter((r) => r.status === 'updated').length;
  recordHistory({ type: 'pull-all', ok: true, remote, updated, diverged: results.filter((r) => r.status === 'diverged').length });
  return { ok: true, remote, results, updated };
}

/** Put the branch back where it was before the last pull (reset --keep). */
async function undoLastPull(opts = {}) {
  if (opts.confirm !== true) throw new Error('Undo pull needs confirm=true.');
  if (!lastPull) throw new Error('Không có lần pull nào để hoàn tác (bridge chỉ nhớ lần pull gần nhất trong phiên hiện tại).');
  await assertNoOperation('undo pull');
  const head = await headSha();
  const branch = await currentBranch();
  if (head !== lastPull.newSha || branch !== lastPull.branch) {
    throw new Error('HEAD đã thay đổi sau lần pull đó (có commit/checkout mới) — không thể hoàn tác an toàn.');
  }
  // --keep refuses if it would discard uncommitted changes.
  await runGit(['reset', '--keep', lastPull.oldSha]);
  const undone = lastPull;
  lastPull = null;
  recordHistory({ type: 'undo-pull', ok: true, branch, from: undone.newSha, to: undone.oldSha });
  return { ok: true, branch, restoredSha: undone.oldSha, removedSha: undone.newSha };
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

/** v3.1.1: remember the selected repo so the toolbar can switch back. */
async function rememberRepo() {
  if (!repoPath) return;
  let remote = null;
  try { remote = await rawRemoteUrl('origin'); } catch (_) {}
  if (!remote) { try { remote = await remoteUrl(); } catch (_) {} }
  const entry = { path: repoPath, name: path.basename(repoPath), remote: remote ? redactUrl(remote) : null, at: new Date().toISOString() };
  recentRepos = [entry].concat(recentRepos.filter((r) => path.resolve(r.path) !== repoPath)).slice(0, 20);
  saveState();
}

function redactUrl(url) {
  return String(url || '').replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

/** "owner/repo" for a github remote URL (https or ssh), else null. */
function githubFullName(url) {
  const m = String(url || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
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

function pullOptionsFrom(body) {
  const b = body || {};
  return {
    mode: b.mode || 'merge',
    remote: b.remote || 'origin',
    branch: b.branch || null,
    autostash: !!b.autostash,
    prune: !!b.prune,
    tags: !!b.fetchTags,
    noTags: !!b.noTags,
    squash: !!b.squash,
    noCommit: !!b.noCommit,
    strategyOption: b.strategyOption || null,
    allowUnrelated: !!b.allowUnrelated,
    recurseSubmodules: !!b.recurseSubmodules,
    unshallow: !!b.unshallow,
    depth: b.depth || null,
    useGithubAuth: b.useGithubAuth !== false,
  };
}

function pushOptionsFrom(body) {
  const b = body || {};
  return {
    remote: b.remote || 'origin',
    remotes: Array.isArray(b.remotes) ? b.remotes : null,
    branch: b.branch || null,
    remoteBranch: b.remoteBranch || null,
    upTo: b.upTo || null,
    setUpstream: !!b.setUpstream,
    force: !!b.force,
    confirm: b.confirm === true,
    forceIfIncludes: !!b.forceIfIncludes,
    leaseSha: b.leaseSha || null,
    pushAll: !!b.pushAll,
    tags: !!b.tags,
    followTags: !!b.followTags,
    noVerify: !!b.noVerify,
    atomic: !!b.atomic,
    dryRun: !!b.dryRun,
    pushOptions: Array.isArray(b.pushOptions) ? b.pushOptions : [],
    useGithubAuth: b.useGithubAuth !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Worktrees + Actions log ZIP (v3.5.0)                                */
/* ------------------------------------------------------------------ */

// Parse `git worktree list --porcelain` into plain objects. Entries are
// blank-line separated; fields: worktree <path>, HEAD <sha>,
// branch refs/heads/<name> (absent when detached), bare, detached,
// locked [reason], prunable [reason].
function parseWorktreeList(raw) {
  const worktrees = [];
  let cur = null;
  const flush = () => { if (cur) worktrees.push(cur); cur = null; };
  for (const line of String(raw || '').split('\n')) {
    const text = line.trim();
    if (!text) { flush(); continue; }
    if (text.startsWith('worktree ')) {
      flush();
      cur = { path: text.slice(9).trim(), branch: null, sha: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (text.startsWith('HEAD ')) cur.sha = text.slice(5).trim() || null;
    else if (text.startsWith('branch ')) cur.branch = text.slice(7).trim().replace(/^refs\/heads\//, '') || null;
    else if (text === 'bare') cur.bare = true;
    else if (text === 'detached') cur.detached = true;
    else if (text === 'locked' || text.startsWith('locked ')) cur.locked = true;
    else if (text === 'prunable' || text.startsWith('prunable ')) cur.prunable = true;
  }
  flush();
  return worktrees;
}

async function listWorktrees() {
  return parseWorktreeList(await runGit(['worktree', 'list', '--porcelain']));
}

// Default branch of a remote, from refs/remotes/<remote>/HEAD
// (set by clone/fetch; no network call). Null when unknown.
async function remoteDefaultBranch(remote) {
  try {
    const ref = (await runGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim();
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1) || null;
  } catch (_) {}
  return null;
}

// Unpack a GitHub Actions run-log ZIP (one .txt per job) into plain
// text. No unzip dependency is bundled, so local file headers
// (PK\x03\x04) are parsed by hand and DEFLATE entries are inflated
// with the built-in zlib. Returns null when the buffer is not a ZIP
// (the caller then falls back to the raw text).
function extractTextFromLogZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf.readUInt32LE(0) !== 0x04034b50) return null;
  const parts = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = Math.min(buf.length, dataStart + compSize);
    const comp = buf.subarray(dataStart, dataEnd);
    try {
      const raw = method === 8 ? zlib.inflateRawSync(comp) : method === 0 ? comp : null;
      if (raw) parts.push(`===== ${name} =====\n${raw.toString('utf8')}`);
    } catch (_) { /* skip an unreadable entry; other files may still parse */ }
    if (dataEnd <= off) break;
    off = dataEnd;
  }
  return parts.length ? parts.join('\n') : null;
}

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
      const tokenRes = await httpFetch(`${GITHUB_OAUTH_BASE}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
        body: params.toString(),
        timeout: GH_TIMEOUT_MS,
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

  // v3.0.1: connection test — a preflighted, authenticated request the
  // dashboard uses to prove CORS + the bridge token work end to end.
  // (If /health answers but this fails with a network error in the
  // browser, the dashboard is being blocked by CORS.)
  if (route === '/api/connection-test' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, version: VERSION, time: new Date().toISOString(), bridgeUrl: `http://${HOST}:${PORT}` });
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
    body = await readBody(req);
  }

  /* ==================== GITHUB AUTH ==================== */

  if (route === '/api/github/auth' && req.method === 'POST') {
    const token = String(body.token || '').trim();
    if (!token) throw new Error('Paste a Personal Access Token first');
    // GitHub removed password auth for third-party apps in 2020: no app
    // may ever accept a GitHub password. Users kept pasting their
    // email/password into this field, so reject anything shaped like
    // credentials (or like a random string) up front, with a clear
    // Vietnamese explanation of what a token looks like instead.
    if (token.includes('@') || /\s/.test(token)) {
      throw fail('INVALID_TOKEN_FORMAT',
        'Đây giống email/mật khẩu, không phải token. GitHub không cho app khác nhập mật khẩu — token bắt đầu bằng ghp_... (classic) hoặc github_pat_... (fine-grained). Tạo token tại github.com → Settings → Developer settings → Personal access tokens.');
    }
    if (!/^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)/.test(token)) {
      throw fail('INVALID_TOKEN_FORMAT',
        'Token GitHub bắt đầu bằng ghp_... hoặc github_pat_... — thứ bạn dán vào không đúng dạng token.');
    }
    if (token.length < 20) throw new Error('That does not look like a GitHub token (too short)');
    const { user, scopes } = await ghValidateToken(token);
    const saved = signInWithToken(token, user, scopes, 'pat');
    return send(req, res, 200, { ok: true, user: publicUser(), dotenvSaved: saved.dotenvSaved });
  }

  if (route === '/api/github/auth/device/start' && req.method === 'POST') {
    const clientId = oauthClientId();
    if (!clientId) {
      throw new Error(
        'Device Flow is not configured on this bridge. Create a GitHub OAuth App and save its client id in the dashboard (or set GITHUB_OAUTH_CLIENT_ID and restart the bridge), or sign in with a Personal Access Token instead.'
      );
    }
    const params = new URLSearchParams({ client_id: clientId, scope: GH_SCOPES });
    const res2 = await httpFetch(`${GITHUB_OAUTH_BASE}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
      body: params.toString(),
      timeout: GH_TIMEOUT_MS,
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
    const res2 = await httpFetch(`${GITHUB_OAUTH_BASE}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}` },
      body: params.toString(),
      timeout: GH_TIMEOUT_MS,
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
    let dotenvSaved = false;
    try { updateDotEnvValues({ GITHUB_PAT: null }); dotenvSaved = true; }
    catch (err) { log('Could not remove GitHub PAT from .env during sign-out:', err.message); }
    sseBroadcast('github-auth', { authed: false, login: null, at: new Date().toISOString() });
    if (wasLogin) log(`GitHub signed out (was ${wasLogin})`);
    return send(req, res, 200, { ok: true, authed: false, dotenvSaved });
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

  // v3.5.0: real-login verify — the email list GitHub returns for the
  // signed-in account. Read-only; no token is ever returned here.
  if (route === '/api/github/user/emails' && req.method === 'GET') {
    requireGhAuth();
    const gh = await ghRequest('/user/emails', { useCache: false });
    const emails = (Array.isArray(gh.data) ? gh.data : []).map((e) => ({
      email: e.email || '',
      primary: !!e.primary,
      verified: !!e.verified,
      visibility: e.visibility || null,
    }));
    return send(req, res, 200, { ok: true, emails });
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
    if (/[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) throw new Error('Client ID / Client Secret must not contain line breaks');
    oauthAppConfig = { clientId, clientSecret };
    saveOAuthAppConfig();
    let dotenvSaved = false;
    try { updateDotEnvValues({ GITHUB_OAUTH_CLIENT_ID: clientId, GITHUB_OAUTH_CLIENT_SECRET: clientSecret }); dotenvSaved = true; }
    catch (err) { log('Could not sync OAuth App settings to .env:', err.message); }
    log('OAuth App configured (client id set, secret stored locally, never returned)');
    return send(req, res, 200, { ok: true, configured: true, callbackUrl: oauthCallbackUrl(), dotenvSaved });
  }

  if (route === '/api/github/oauth/start' && req.method === 'GET') {
    const clientId = oauthClientId();
    if (!clientId) {
      throw fail('OAUTH_APP_NOT_CONFIGURED',
        'Bridge chưa cấu hình OAuth App. Tạo OAuth App rồi lưu Client ID + Client Secret trong dashboard (mục Đăng nhập GitHub), hoặc dùng Device Flow / token PAT.');
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

  // v3.0: login diagnostics (Vietnamese). One call answers "why can't I
  // sign in?" — OAuth App configured? token present + still valid?
  // repo scope? rate limit left? github.com reachable?
  if (route === '/api/github/login/diagnostics' && req.method === 'GET') {
    const checks = [];
    const push = (key, label, ok, detail, fix) => checks.push({ key, label, ok, detail, fix: fix || null });

    push('bridge', 'Bridge đang chạy', true, 'Bridge đang chạy trên máy này.');

    const cid = oauthClientId();
    const csec = oauthClientSecret();
    if (cid && csec && cid.length >= 5) {
      push('oauth-app', 'OAuth App đã cấu hình', true, 'Client ID + Client Secret đã lưu trên bridge.');
    } else if (cid && !csec) {
      push('oauth-app', 'OAuth App đã cấu hình', false, 'Đã có Client ID nhưng thiếu Client Secret.', 'Lưu Client Secret trong dashboard (mục Đăng nhập GitHub).');
    } else {
      push('oauth-app', 'OAuth App đã cấu hình', false, 'Chưa cấu hình OAuth App (thiếu Client ID).', 'Tạo OAuth App trên github.com rồi lưu Client ID + Client Secret trong dashboard (mục Đăng nhập GitHub), hoặc dùng Device Flow / token PAT.');
    }

    let validatedScopes = null;
    if (!ghConfig.token) {
      push('token', 'Token GitHub', false, 'Chưa đăng nhập GitHub.', 'Đăng nhập bằng PAT, Device Flow hoặc Connect GitHub.');
    } else {
      try {
        const validated = await ghValidateToken(ghConfig.token);
        validatedScopes = validated.scopes;
        push('token', 'Token GitHub', true, `Token còn hiệu lực — đăng nhập với ${(validated.user && validated.user.login) || 'tài khoản GitHub'}.`);
      } catch (err) {
        const is401 = err.status === 401 || /401/.test(err.message || '');
        push('token', 'Token GitHub', false,
          is401 ? 'Token đã hết hạn hoặc bị thu hồi (401).' : `Không kiểm tra được token: ${err.message}`,
          'Đăng nhập lại bằng PAT, Device Flow hoặc Connect GitHub.');
      }
    }

    if (validatedScopes !== null) {
      const hasRepo = validatedScopes.split(',').map((s) => s.trim()).includes('repo');
      push('scopes', 'Quyền repo', hasRepo,
        hasRepo ? 'Token có quyền repo.' : 'Token thiếu quyền repo.',
        hasRepo ? null : 'Đăng nhập lại với token có quyền repo (scope repo).');
    } else {
      push('scopes', 'Quyền repo', false,
        'Chưa xác định được scope vì token chưa hợp lệ hoặc chưa đăng nhập.',
        'Đăng nhập lại với token có quyền repo (scope repo).');
    }

    const remaining = lastRateLimit.remaining;
    push('rate-limit', 'Rate limit GitHub', remaining === null || remaining > 5,
      remaining === null ? 'Chưa có dữ liệu rate limit.' : `Còn ${remaining} request.`,
      remaining !== null && remaining <= 5 ? 'Chờ rate limit hồi lại rồi thử lại.' : null);

    try {
      const reach = await httpFetch(`${GITHUB_OAUTH_BASE}/`, { timeout: 5000 });
      push('reachability', 'Kết nối tới github.com', reach.status < 500,
        `github.com trả về HTTP ${reach.status}.`,
        reach.status < 500 ? null : 'github.com đang lỗi — thử lại sau.');
    } catch (err) {
      push('reachability', 'Kết nối tới github.com', false,
        `Không tới được github.com: ${err.message}`,
        'Kiểm tra mạng / VPN / tường lửa, rồi thử lại.');
    }

    const failed = checks.filter((c) => !c.ok);
    return send(req, res, 200, {
      ok: failed.length === 0,
      authed: ghAuthed(),
      login: ghConfig.user ? ghConfig.user.login : null,
      checks,
      summary: failed.length === 0
        ? 'Mọi kiểm tra đều ổn — đăng nhập GitHub đang hoạt động.'
        : `Có ${failed.length} vấn đề cần xử lý: ${failed.map((f) => f.label).join('; ')}.`,
    });
  }

  if (route === '/api/github/rate-limit' && req.method === 'GET') {
    requireGhAuth();
    try {
      const gh = await ghRequest('/rate_limit', { useCache: false });
      const core = (gh.data && gh.data.resources && gh.data.resources.core) || {};
      return send(req, res, 200, {
        ok: true,
        // v3.7.1: no ?? — Node 12 has no nullish coalescing.
        limit: core.limit != null ? core.limit : lastRateLimit.limit,
        remaining: core.remaining != null ? core.remaining : lastRateLimit.remaining,
        reset: core.reset ? new Date(core.reset * 1000).toISOString() : (lastRateLimit.reset ? new Date(lastRateLimit.reset * 1000).toISOString() : null),
        used: core.used != null ? core.used : lastRateLimit.used,
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

  if (route === '/api/github/repos' && req.method === 'POST') {
    requireGhAuth();
    const name = String(body.name || '').trim();
    if (!name) throw new Error('Repository name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid repository name — use letters, digits, ., _ or -');
    const payload = { name };
    if (body.description !== undefined) payload.description = String(body.description);
    if (body.private !== undefined) payload.private = !!body.private;
    if (body.auto_init !== undefined) payload.auto_init = !!body.auto_init;
    const gh = await ghRequest('/user/repos', { method: 'POST', body: payload });
    repoListCache = { at: 0, repos: [] };
    return send(req, res, 200, { ok: true, repo: normalizeRepo(gh.data) });
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

  // v3.0: download a repo as a .zip (codeload). This MUST live BEFORE
  // the repoMatch block below, or 'zip' would be swallowed as `rest`
  // and answered 404.
  const zipMatch = route.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)\/zip$/);
  if (zipMatch && req.method === 'GET') {
    requireGhAuth();
    const owner = safeGhPath(decodeURIComponent(zipMatch[1]));
    const repo = safeGhPath(decodeURIComponent(zipMatch[2]));
    let ref = String(url.searchParams.get('ref') || '').trim();
    if (!ref) {
      const repoRes = await ghRequest(`/repos/${owner}/${repo}`, { useCache: true });
      ref = (repoRes.data && repoRes.data.default_branch) || 'main';
    }
    const isSha = /^[0-9a-f]{40}$/i.test(ref);
    const zipPath = isSha
      ? `/zip/${ref}`
      : `/zip/refs/heads/${ref.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`;
    const zipUrl = `${GITHUB_CODELOAD_BASE}/${owner}/${repo}${zipPath}`;
    let zipRes;
    try {
      zipRes = await httpFetch(zipUrl, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}`, Authorization: `Bearer ${ghConfig.token}` },
        timeout: GH_TIMEOUT_MS,
      });
    } catch (err) {
      throw new GhError(502, `Could not reach GitHub: ${err.message}`);
    }
    if (!zipRes.ok) {
      if (zipRes.status === 404) throw new GhError(404, 'Không tìm thấy repo hoặc branch');
      if (zipRes.status === 403) throw new GhError(403, 'GitHub từ chối tải zip (403) — có thể đã hết rate limit hoặc repo không cho phép.');
      throw new GhError(zipRes.status, `GitHub API error ${zipRes.status}`);
    }
    const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${decodeURIComponent(zipMatch[2])}-${safeRef}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise((resolve, reject) => {
      zipRes.body.on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
    return;
  }

  if (route === '/api/github/search/code' && req.method === 'GET') {
    requireGhAuth();
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) throw new Error('Search query (q) is required');
    const repoFilter = String(url.searchParams.get('repo') || '').trim();
    const fullQ = repoFilter ? `${q} repo:${repoFilter}` : q;
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const gh = await ghRequest(`/search/code?q=${encodeURIComponent(fullQ)}&per_page=${perPage}`, { useCache: false });
    const items = (Array.isArray(gh.data && gh.data.items) ? gh.data.items : []).map((it) => ({
      name: it.name || '',
      path: it.path || '',
      repository: (it.repository && it.repository.full_name) || '',
      html_url: it.html_url || '',
      sha: it.sha || '',
    }));
    return send(req, res, 200, { ok: true, items, total_count: (gh.data && gh.data.total_count) || items.length });
  }

  if (route === '/api/github/notifications' && req.method === 'GET') {
    requireGhAuth();
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const gh = await ghRequest(`/notifications?per_page=${perPage}`, { useCache: false });
    const notifications = (Array.isArray(gh.data) ? gh.data : []).map((n) => ({
      id: n.id,
      subject: { title: (n.subject && n.subject.title) || '', type: (n.subject && n.subject.type) || '', url: (n.subject && n.subject.url) || '' },
      repository: (n.repository && n.repository.full_name) || '',
      reason: n.reason || '',
      unread: !!n.unread,
      updated_at: n.updated_at || null,
    }));
    return send(req, res, 200, { ok: true, notifications });
  }

  if (route === '/api/github/notifications/read' && req.method === 'POST') {
    requireGhAuth();
    await ghRequest('/notifications', { method: 'PUT' });
    return send(req, res, 200, { ok: true });
  }

  if (route === '/api/github/profile' && req.method === 'GET') {
    requireGhAuth();
    const gh = await ghRequest('/user', { useCache: false });
    const u = gh.data || {};
    return send(req, res, 200, {
      ok: true,
      profile: {
        login: u.login || null, id: u.id || null, name: u.name || null, email: u.email || null,
        bio: u.bio || null, company: u.company || null, blog: u.blog || null, location: u.location || null,
        public_repos: typeof u.public_repos === 'number' ? u.public_repos : null,
        followers: typeof u.followers === 'number' ? u.followers : null,
        following: typeof u.following === 'number' ? u.following : null,
        created_at: u.created_at || null, avatar_url: u.avatar_url || null, html_url: u.html_url || null, type: u.type || null,
      },
    });
  }

  /* ==================== GITHUB ACTIONS (v3.5.0) ==================== */
  // Workflows / runs / jobs / logs via ghRequest, same auth + cache
  // style as the other /api/github routes. owner/repo arrive as query
  // params (POST rerun/cancel also accept them in the body).
  const actionsMatch = route.match(/^\/api\/github\/actions\/(.+)$/);
  if (actionsMatch) {
    requireGhAuth();
    const rest = actionsMatch[1];
    const owner = safeGhPath(decodeURIComponent(String((body && body.owner) || url.searchParams.get('owner') || '')));
    const repo = safeGhPath(decodeURIComponent(String((body && body.repo) || url.searchParams.get('repo') || '')));
    const normalizeRun = (r) => (r ? {
      id: r.id, name: r.name || '', run_number: r.run_number || null,
      head_branch: r.head_branch || '', head_sha: r.head_sha || '',
      status: r.status || '', conclusion: r.conclusion || null, event: r.event || '',
      workflow_id: r.workflow_id || null, created_at: r.created_at || null,
      updated_at: r.updated_at || null, html_url: r.html_url || '',
    } : null);

    if (rest === 'workflows' && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/actions/workflows`, { useCache: true });
      const d = gh.data || {};
      return send(req, res, 200, {
        ok: true, total_count: d.total_count || 0,
        workflows: (Array.isArray(d.workflows) ? d.workflows : []).map((w) => ({
          id: w.id, name: w.name || '', path: w.path || '', state: w.state || '',
          created_at: w.created_at || null, updated_at: w.updated_at || null,
          html_url: w.html_url || '', badge_url: w.badge_url || '',
        })),
        notModified: !!gh.notModified,
      });
    }

    if (rest === 'runs' && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      const params = new URLSearchParams({ per_page: String(perPage) });
      if (url.searchParams.get('workflow_id')) params.set('workflow_id', url.searchParams.get('workflow_id'));
      if (url.searchParams.get('status')) params.set('status', url.searchParams.get('status'));
      if (url.searchParams.get('branch')) params.set('branch', url.searchParams.get('branch'));
      const gh = await ghRequest(`/repos/${owner}/${repo}/actions/runs?${params.toString()}`, { useCache: false });
      const d = gh.data || {};
      return send(req, res, 200, { ok: true, total_count: d.total_count || 0, runs: (Array.isArray(d.workflow_runs) ? d.workflow_runs : []).map(normalizeRun) });
    }

    const runMatch = rest.match(/^runs\/(\d+)$/);
    if (runMatch && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/actions/runs/${runMatch[1]}`, { useCache: false });
      return send(req, res, 200, { ok: true, run: normalizeRun(gh.data) });
    }

    const rerunMatch = rest.match(/^runs\/(\d+)\/rerun$/);
    if (rerunMatch && req.method === 'POST') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/actions/runs/${rerunMatch[1]}/rerun`, { method: 'POST', body: {} });
      return send(req, res, 200, { ok: true, run: normalizeRun(gh.data) });
    }

    const cancelMatch = rest.match(/^runs\/(\d+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      await ghRequest(`/repos/${owner}/${repo}/actions/runs/${cancelMatch[1]}/cancel`, { method: 'POST', body: {} });
      return send(req, res, 200, { ok: true, cancelled: true });
    }

    const jobsMatch = rest.match(/^runs\/(\d+)\/jobs$/);
    if (jobsMatch && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/actions/runs/${jobsMatch[1]}/jobs`, { useCache: false });
      const d = gh.data || {};
      return send(req, res, 200, {
        ok: true, total_count: d.total_count || 0,
        jobs: (Array.isArray(d.jobs) ? d.jobs : []).map((j) => ({
          id: j.id, run_id: j.run_id || null, name: j.name || '', status: j.status || '',
          conclusion: j.conclusion || null, started_at: j.started_at || null,
          completed_at: j.completed_at || null, html_url: j.html_url || '',
          steps: Array.isArray(j.steps) ? j.steps.map((s) => ({ name: s.name || '', status: s.status || '', conclusion: s.conclusion || null })) : [],
        })),
      });
    }

    const logsMatch = rest.match(/^runs\/(\d+)\/logs$/);
    if (logsMatch && req.method === 'GET') {
      // GitHub answers with a 302 to a short-lived ZIP download; the
      // bridge follows it (httpFetch) and unpacks the .txt entries.
      let logsRes;
      try {
        logsRes = await httpFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${logsMatch[1]}/logs`, {
          headers: ghHeaders(ghConfig.token), timeout: GH_TIMEOUT_MS,
        });
      } catch (err) {
        throw new GhError(502, `Không tải được log: ${err.message}`);
      }
      if (!logsRes.ok) {
        if (logsRes.status === 404) throw new GhError(404, 'Không tìm thấy log cho lần chạy này — log có thể đã hết hạn (GitHub chỉ giữ log 90 ngày).');
        if (logsRes.status === 410) throw new GhError(410, 'Log của lần chạy này đã bị xóa (hết hạn lưu trữ).');
        throw new GhError(logsRes.status, `Không tải được log (GitHub trả về ${logsRes.status}).`);
      }
      const buf = Buffer.from(await logsRes.arrayBuffer());
      let text = extractTextFromLogZip(buf);
      if (text == null) text = buf.toString('utf8');
      const truncated = text.length > MAX_LOG_CHARS;
      if (truncated) text = text.slice(0, MAX_LOG_CHARS);
      return send(req, res, 200, { ok: true, truncated, log: text });
    }

    return send(req, res, 404, { error: `Unknown GitHub endpoint: ${req.method} ${route}` });
  }

  // /api/github/repos/:owner/:repo and everything below it.
  const repoMatch = route.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH')) {
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

    // v3.5.0: single commit detail (files + stats, GitHub-like page).
    const commitDetailMatch = rest.match(/^commits\/([^/]+)$/);
    if (commitDetailMatch && req.method === 'GET') {
      const sha = safeGhPath(decodeURIComponent(commitDetailMatch[1]));
      const gh = await ghRequest(`/repos/${owner}/${repo}/commits/${sha}`, { useCache: false });
      const d = gh.data || {};
      return send(req, res, 200, {
        ok: true,
        commit: normalizeCommit(d),
        author: (d.author && d.author.login) || null,
        committer: (d.committer && d.committer.login) || null,
        parents: Array.isArray(d.parents) ? d.parents.map((p) => p.sha) : [],
        stats: d.stats || null,
        files: Array.isArray(d.files) ? d.files.map((f) => ({
          filename: f.filename || '', status: f.status || '', additions: f.additions || 0,
          deletions: f.deletions || 0, changes: f.changes || 0, patch: f.patch || '',
        })) : [],
      });
    }

    // v3.5.0: compare base...head (URL-encode each side, keep the
    // literal "..." separator GitHub expects).
    const compareMatch = rest.match(/^compare\/(.+)$/);
    if (compareMatch && req.method === 'GET') {
      const spec = decodeURIComponent(compareMatch[1]);
      const sep = spec.indexOf('...');
      if (sep < 0) throw new Error('Compare cần dạng base...head (ví dụ main...feature).');
      const base = encodeURIComponent(spec.slice(0, sep));
      const head = encodeURIComponent(spec.slice(sep + 3));
      if (!base || !head) throw new Error('Compare cần cả base và head.');
      const gh = await ghRequest(`/repos/${owner}/${repo}/compare/${base}...${head}`, { useCache: false });
      const d = gh.data || {};
      return send(req, res, 200, {
        ok: true, status: d.status || '', ahead_by: d.ahead_by || 0, behind_by: d.behind_by || 0,
        total_commits: d.total_commits || 0,
        commits: (Array.isArray(d.commits) ? d.commits : []).map(normalizeCommit),
        files: (Array.isArray(d.files) ? d.files : []).map((f) => ({
          filename: f.filename || '', status: f.status || '', additions: f.additions || 0,
          deletions: f.deletions || 0, changes: f.changes || 0, patch: f.patch || '',
        })),
      });
    }

    // v3.5.0: languages / contributors / topics. Topics need no
    // accept-preview header on the 2022-11-28 API version.
    if (rest === 'languages' && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/languages`, { useCache: true });
      return send(req, res, 200, { ok: true, languages: gh.data || {}, notModified: !!gh.notModified });
    }

    if (rest === 'contributors' && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      const gh = await ghRequest(`/repos/${owner}/${repo}/contributors?per_page=${perPage}`, { useCache: true });
      return send(req, res, 200, {
        ok: true,
        contributors: (Array.isArray(gh.data) ? gh.data : []).map((c) => ({
          login: c.login || '', id: c.id || null, avatar_url: c.avatar_url || '',
          contributions: c.contributions || 0, html_url: c.html_url || '',
        })),
        notModified: !!gh.notModified,
      });
    }

    if (rest === 'topics' && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/topics`, { useCache: true });
      const d = gh.data || {};
      return send(req, res, 200, { ok: true, topics: Array.isArray(d.names) ? d.names : [], notModified: !!gh.notModified });
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
      // v3.0: contentBase64 uploads a file as-is (binary safe); without
      // it, body.content is treated as utf8 text, as before.
      let encoded;
      if (body.contentBase64) {
        encoded = Buffer.from(String(body.contentBase64).replace(/\s/g, ''), 'base64').toString('base64');
      } else {
        encoded = Buffer.from(String(body.content == null ? '' : body.content), 'utf8').toString('base64');
      }
      const payload = {
        message,
        content: encoded,
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

    if (rest === '' && req.method === 'PATCH') {
      const payload = {};
      if (body.description !== undefined) payload.description = String(body.description);
      if (body.private !== undefined) payload.private = !!body.private;
      if (body.name !== undefined) {
        const newName = String(body.name).trim();
        if (!/^[A-Za-z0-9._-]+$/.test(newName)) throw new Error('Invalid repository name');
        payload.name = newName;
      }
      const gh = await ghRequest(`/repos/${owner}/${repo}`, { method: 'PATCH', body: payload });
      repoListCache = { at: 0, repos: [] };
      return send(req, res, 200, { ok: true, repo: normalizeRepo(gh.data) });
    }

    if (rest === '' && req.method === 'DELETE') {
      if (body.confirm !== true) throw new Error('Xóa repo cần xác nhận — gửi { confirm: true }.');
      await ghRequest(`/repos/${owner}/${repo}`, { method: 'DELETE' });
      repoListCache = { at: 0, repos: [] };
      return send(req, res, 200, { ok: true });
    }

    if (rest === 'fork' && req.method === 'POST') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/forks`, { method: 'POST', body: {} });
      return send(req, res, 200, { ok: true, repo: normalizeRepo(gh.data) });
    }

    if (rest === 'star' && req.method === 'PUT') {
      await ghRequest(`/user/starred/${owner}/${repo}`, { method: 'PUT' });
      return send(req, res, 200, { ok: true, starred: true });
    }

    if (rest === 'star' && req.method === 'DELETE') {
      await ghRequest(`/user/starred/${owner}/${repo}`, { method: 'DELETE' });
      return send(req, res, 200, { ok: true, starred: false });
    }

    if (rest === 'issues' && req.method === 'POST') {
      const title = String(body.title || '').trim();
      if (!title) throw new Error('Issue title is required');
      const payload = { title };
      if (body.body !== undefined) payload.body = String(body.body);
      if (Array.isArray(body.labels)) payload.labels = body.labels.map(String);
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: payload });
      return send(req, res, 200, { ok: true, issue: normalizeIssue(gh.data) });
    }

    const issueMatch = rest.match(/^issues\/(\d+)$/);
    if (issueMatch && req.method === 'GET') {
      const number = issueMatch[1];
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues/${number}`, { useCache: false });
      const commentsRes = await ghRequest(`/repos/${owner}/${repo}/issues/${number}/comments`, { useCache: false });
      const comments = (Array.isArray(commentsRes.data) ? commentsRes.data : []).map(normalizeComment);
      return send(req, res, 200, { ok: true, issue: normalizeIssue(gh.data), comments });
    }

    if (issueMatch && req.method === 'PATCH') {
      const state = String(body.state || '').trim();
      if (state !== 'open' && state !== 'closed') throw new Error("Issue state must be 'open' or 'closed'");
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues/${issueMatch[1]}`, { method: 'PATCH', body: { state } });
      return send(req, res, 200, { ok: true, issue: normalizeIssue(gh.data) });
    }

    const issueCommentsMatch = rest.match(/^issues\/(\d+)\/comments$/);
    // v3.5.0: list comments. (GET issue detail above already returns
    // { issue, comments } — this endpoint is the plain list.)
    if (issueCommentsMatch && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues/${issueCommentsMatch[1]}/comments`, { useCache: false });
      return send(req, res, 200, { ok: true, comments: (Array.isArray(gh.data) ? gh.data : []).map(normalizeComment) });
    }

    if (issueCommentsMatch && req.method === 'POST') {
      const commentBody = String(body.body || '').trim();
      if (!commentBody) throw new Error('Comment body is required');
      const gh = await ghRequest(`/repos/${owner}/${repo}/issues/${issueCommentsMatch[1]}/comments`, { method: 'POST', body: { body: commentBody } });
      return send(req, res, 200, { ok: true, comment: normalizeComment(gh.data) });
    }

    if (rest === 'pulls' && req.method === 'POST') {
      const title = String(body.title || '').trim();
      if (!title) throw new Error('Pull request title is required');
      const head = String(body.head || '').trim();
      if (!head) throw new Error('Pull request head branch is required');
      let base = String(body.base || '').trim();
      if (!base) {
        const repoRes = await ghRequest(`/repos/${owner}/${repo}`, { useCache: true });
        base = (repoRes.data && repoRes.data.default_branch) || 'main';
      }
      const payload = { title, head, base };
      if (body.body !== undefined) payload.body = String(body.body);
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: payload });
      return send(req, res, 200, { ok: true, pull: normalizePull(gh.data) });
    }

    const pullMergeMatch = rest.match(/^pulls\/(\d+)\/merge$/);
    if (pullMergeMatch && req.method === 'PUT') {
      const payload = {};
      if (body.merge_method !== undefined) {
        if (!['merge', 'squash', 'rebase'].includes(body.merge_method)) throw new Error("merge_method must be 'merge', 'squash' or 'rebase'");
        payload.merge_method = body.merge_method;
      }
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls/${pullMergeMatch[1]}/merge`, { method: 'PUT', body: payload });
      const d = gh.data || {};
      return send(req, res, 200, { ok: true, merged: !!d.merged, message: d.message || '' });
    }

    const pullMatch = rest.match(/^pulls\/(\d+)$/);
    if (pullMatch && req.method === 'PATCH') {
      const state = String(body.state || '').trim();
      if (state !== 'open' && state !== 'closed') throw new Error("Pull request state must be 'open' or 'closed'");
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls/${pullMatch[1]}`, { method: 'PATCH', body: { state } });
      return send(req, res, 200, { ok: true, pull: normalizePull(gh.data) });
    }

    // v3.5.0: pull detail / files / reviews (no GET detail existed;
    // only PATCH close/reopen and PUT merge were present).
    if (pullMatch && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls/${pullMatch[1]}`, { useCache: false });
      return send(req, res, 200, { ok: true, pull: normalizePull(gh.data) });
    }

    const pullFilesMatch = rest.match(/^pulls\/(\d+)\/files$/);
    if (pullFilesMatch && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls/${pullFilesMatch[1]}/files?per_page=${perPage}`, { useCache: false });
      return send(req, res, 200, {
        ok: true,
        files: (Array.isArray(gh.data) ? gh.data : []).map((f) => ({
          filename: f.filename || '', status: f.status || '', additions: f.additions || 0,
          deletions: f.deletions || 0, changes: f.changes || 0, patch: f.patch || '',
        })),
      });
    }

    const pullReviewsMatch = rest.match(/^pulls\/(\d+)\/reviews$/);
    if (pullReviewsMatch && req.method === 'GET') {
      const gh = await ghRequest(`/repos/${owner}/${repo}/pulls/${pullReviewsMatch[1]}/reviews`, { useCache: false });
      return send(req, res, 200, {
        ok: true,
        reviews: (Array.isArray(gh.data) ? gh.data : []).map((r) => ({
          id: r.id, user: (r.user && r.user.login) || '', state: r.state || '',
          body: r.body || '', submitted_at: r.submitted_at || null, html_url: r.html_url || '',
        })),
      });
    }

    if (rest === 'releases' && req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      const gh = await ghRequest(`/repos/${owner}/${repo}/releases?per_page=${perPage}`, { useCache: false });
      return send(req, res, 200, { ok: true, releases: (Array.isArray(gh.data) ? gh.data : []).map(normalizeRelease) });
    }

    if (rest === 'releases' && req.method === 'POST') {
      const tagName = String(body.tag_name || '').trim();
      if (!tagName) throw new Error('Release tag_name is required');
      const payload = { tag_name: tagName };
      if (body.name !== undefined) payload.name = String(body.name);
      if (body.body !== undefined) payload.body = String(body.body);
      if (body.draft !== undefined) payload.draft = !!body.draft;
      if (body.prerelease !== undefined) payload.prerelease = !!body.prerelease;
      const gh = await ghRequest(`/repos/${owner}/${repo}/releases`, { method: 'POST', body: payload });
      return send(req, res, 200, { ok: true, release: normalizeRelease(gh.data) });
    }

    const releaseAssetMatch = rest.match(/^releases\/assets\/(\d+)$/);
    if (releaseAssetMatch && req.method === 'GET') {
      const assetId = releaseAssetMatch[1];
      const fileName = String(url.searchParams.get('name') || `asset-${assetId}`).replace(/[^\w.\-() ]+/g, '_');
      const assetUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/assets/${assetId}`;
      let assetRes;
      try {
        assetRes = await httpFetch(assetUrl, {
          headers: { Accept: 'application/octet-stream', 'User-Agent': `PixiJS-GitHub-Bridge/${VERSION}`, Authorization: `Bearer ${ghConfig.token}` },
          timeout: GH_TIMEOUT_MS,
        });
      } catch (err) {
        throw new GhError(502, `Could not reach GitHub: ${err.message}`);
      }
      if (!assetRes.ok) {
        if (assetRes.status === 404) throw new GhError(404, 'Không tìm thấy release asset');
        throw new GhError(assetRes.status, `GitHub API error ${assetRes.status}`);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      await new Promise((resolve, reject) => {
        assetRes.body.on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
      });
      return;
    }

    if (rest === 'contents' && req.method === 'DELETE') {
      const relPath = String(body.path || '').trim();
      if (!relPath) throw new Error('File path (body.path) is required');
      const message = String(body.message || '').trim();
      if (!message) throw new Error('Commit message is required');
      const sha = String(body.sha || '').trim();
      if (!sha) throw new Error('File sha is required to delete a file');
      const payload = { message, sha };
      if (body.branch) payload.branch = String(body.branch);
      const gh = await ghRequest(`/repos/${owner}/${repo}/contents/${safeGhPath(relPath)}`, { method: 'DELETE', body: payload });
      const d = gh.data || {};
      repoListCache = { at: 0, repos: [] };
      return send(req, res, 200, {
        ok: true,
        commit: d.commit ? { sha: d.commit.sha, message: (d.commit.message || '').split('\n')[0], html_url: d.commit.html_url || '' } : null,
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
    await rememberRepo();
    return send(req, res, 200, { ok: true, repository: await repoSummary() });
  }

  /* v3.1.1: recently used local repos (for the toolbar switcher) and a
   * lookup "is owner/repo already cloned on this machine?". */
  if (route === '/api/repo/recent' && req.method === 'GET') {
    if (repoPath && !recentRepos.some((r) => path.resolve(r.path) === repoPath)) await rememberRepo();
    const list = recentRepos
      .filter((r) => { try { return fs.statSync(r.path).isDirectory(); } catch (_) { return false; } })
      .map((r) => Object.assign({}, r, { fullName: githubFullName(r.remote), current: !!repoPath && path.resolve(r.path) === repoPath }));
    return send(req, res, 200, { ok: true, repos: list, defaultCloneDir: path.join(os.homedir(), 'GitHub') });
  }

  if (route === '/api/repo/find' && req.method === 'GET') {
    const want = String(url.searchParams.get('fullName') || '').trim().toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(want)) throw new Error('fullName must look like owner/repo');
    const hit = recentRepos.find((r) => githubFullName(r.remote) === want && (() => { try { return fs.statSync(r.path).isDirectory(); } catch (_) { return false; } })());
    const name = want.split('/')[1];
    return send(req, res, 200, { ok: true, found: !!hit, path: hit ? hit.path : null, suggestedPath: path.join(os.homedir(), 'GitHub', name) });
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
    // v3.1.1: create the parent folder (e.g. ~/GitHub) when it is missing.
    if (!fs.existsSync(parent)) {
      try { fs.mkdirSync(parent, { recursive: true }); } catch (e) {
        throw new Error(`Could not create parent directory ${parent}: ${e.message}`);
      }
    }
    if (!fs.statSync(parent).isDirectory()) {
      throw new Error(`Parent path is not a directory: ${parent}`);
    }
    if (fs.existsSync(target)) {
      const entries = fs.readdirSync(target);
      if (entries.length) throw new Error(`Destination already exists and is not empty: ${target}`);
    }
    const branch = body.branch ? validateBranchName(body.branch) : null;
    const args = ['clone'];
    if (branch) args.push('-b', branch);
    args.push('--progress', gitUrl, target);
    // v3.1.1: private GitHub repos need the signed-in token. Passed as
    // `git -c ... clone` (before the subcommand) so it is NOT persisted
    // into the new repo's .git/config.
    const auth = githubAuthForUrl(gitUrl, body.useGithubAuth !== false);
    let result;
    try {
      result = await runGitIn(parent, auth.args.concat(args), { timeout: GIT_TIMEOUT_MS, env: auth.env, onStderr: progressReporter('clone') });
    } catch (err) {
      recordHistory({ op: 'clone', ok: false, remote: redactUrl(gitUrl), error: cleanGitOutput(err.message).slice(0, 300) });
      throw failWithDetails(err, { usedGithubAuth: auth.used });
    }
    repoPath = target;
    try {
      const topLevel = (await runGit(['rev-parse', '--show-toplevel'])).trim();
      if (topLevel) repoPath = path.resolve(topLevel);
    } catch (_) {}
    saveState();
    await rememberRepo();
    recordHistory({ op: 'clone', ok: true, remote: redactUrl(gitUrl), path: repoPath });
    log(`Cloned ${redactUrl(gitUrl)} into ${repoPath}`);
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
    // v3.1.1: fetch each remote separately so the signed-in GitHub token
    // is only offered to https://github.com remotes (private repos used
    // to fail with "could not read Username").
    const remotesOut = (await runGit(['remote'])).split('\n').map((r) => r.trim()).filter(Boolean);
    if (!remotesOut.length) {
      const e = new Error('Repo chưa có remote nào — thêm remote (ví dụ origin) trong panel Remotes trước khi Fetch.');
      e.code = 'NO_REMOTE';
      throw e;
    }
    let targets = remotesOut;
    if (body.remote) {
      const want = validateRemoteName(body.remote);
      if (!remotesOut.includes(want)) throw new Error(`No such remote: ${want}`);
      targets = [want];
    }
    const results = [];
    for (const remote of targets) {
      const auth = await githubAuthFor(remote, body.useGithubAuth !== false);
      const args = auth.args.concat(['fetch', '--progress', remote]);
      if (body.prune !== false) args.push('--prune');
      if (body.tags) args.push('--tags');
      try {
        const out = await runGitIn(repoPath, args, { env: auth.env, onStderr: progressReporter('fetch') });
        results.push({ remote, ok: true, output: cleanGitOutput(out), usedGithubAuth: auth.used });
      } catch (err) {
        const cls = classifyGitFailure(`${err.message}\n${err.gitStderr || ''}`);
        results.push({ remote, ok: false, error: cleanGitOutput(err.message), reason: cls.reason, hint: cls.hint, usedGithubAuth: auth.used });
      }
    }
    const ok = results.every((r) => r.ok);
    if (results.some((r) => r.ok)) lastFetchAt = new Date().toISOString();
    recordHistory({ op: 'fetch', ok, remote: targets.join(','), error: ok ? undefined : results.filter((r) => !r.ok).map((r) => `${r.remote}: ${r.error}`).join('; ').slice(0, 300) });
    if (!ok && !results.some((r) => r.ok)) {
      const first = results[0];
      const e = new Error(first.error + (first.hint ? `\n→ ${first.hint}` : ''));
      e.code = 'GIT_' + String(first.reason || 'unknown').toUpperCase().replace(/-/g, '_');
      e.details = { reason: first.reason, hint: first.hint, results };
      throw e;
    }
    return send(req, res, 200, { ok, results, lastFetchAt, result: results.map((r) => r.ok ? r.output : r.error).filter(Boolean).join('\n'), ...(await aheadBehind()) });
  }

  if (route === '/api/git/pull' && req.method === 'POST') {
    // v3.1.0 options: mode (merge | rebase | rebase-merges | ff-only),
    // remote, branch, autostash, prune, tags, noTags, squash, noCommit,
    // strategyOption, allowUnrelated, recurseSubmodules, unshallow,
    // depth, useGithubAuth. A conflict returns HTTP 200 { ok:false,
    // conflict:true, conflicts, operation } so the UI can resolve it.
    const pulled = await pullRepo(pullOptionsFrom(body));
    return send(req, res, 200, { ok: pulled.ok, ...pulled, ...(await aheadBehind()) });
  }

  if (route === '/api/git/pull/preview' && req.method === 'POST') {
    return send(req, res, 200, { ...(await pullPreview({ remote: body.remote, branch: body.branch, useGithubAuth: body.useGithubAuth })), ...(await aheadBehind()) });
  }

  if (route === '/api/git/pull/all-branches' && req.method === 'POST') {
    return send(req, res, 200, { ...(await pullAllBranches({ remote: body.remote, useGithubAuth: body.useGithubAuth })), ...(await aheadBehind()) });
  }

  if (route === '/api/git/pull/undo' && req.method === 'POST') {
    return send(req, res, 200, { ...(await undoLastPull({ confirm: body.confirm === true })), ...(await aheadBehind()) });
  }

  if (route === '/api/git/pull/last' && req.method === 'GET') {
    const head = await headSha();
    return send(req, res, 200, { ok: true, lastPull, undoAvailable: !!(lastPull && lastPull.newSha === head) });
  }

  // v3.5.0: pull from every remote in sequence, reusing pullRepo's
  // mode / autostash handling per remote. A failure on one remote
  // never stops the others; a merge conflict stops the loop, because
  // git cannot start another pull while a merge is in progress (the
  // remaining remotes are reported as skipped). Autostash restore is
  // owned by git/pullRepo, so no half-applied stash is left behind.
  // Note: pullRepo's lastPull bookkeeping keeps only the most recent
  // pull, so Undo only undoes the last remote's pull.
  if (route === '/api/git/pull/remotes' && req.method === 'POST') {
    const mode = body.mode || 'merge';
    const autostash = body.autostash === true;
    const remoteNames = (await runGit(['remote'])).split('\n').map((r) => r.trim()).filter(Boolean);
    if (!remoteNames.length) {
      const e = new Error('Repo chưa có remote nào — thêm remote (ví dụ origin) trong panel Remotes trước khi Pull.');
      e.code = 'NO_REMOTE';
      throw e;
    }
    const current = await currentBranch();
    const results = [];
    let stoppedByConflict = false;
    for (const remote of remoteNames) {
      if (stoppedByConflict) {
        results.push({ remote, ok: false, pulled: false, error: 'Bỏ qua: đang có merge conflict từ remote trước — xử lý conflict rồi pull lại.' });
        continue;
      }
      const upstream = current && !current.startsWith('(') ? await upstreamOf(current) : null;
      let branch = null;
      if (upstream && upstream.startsWith(`${remote}/`)) {
        branch = null; // pullRepo pulls the configured upstream
      } else {
        branch = await remoteDefaultBranch(remote);
        if (!branch) {
          results.push({ remote, ok: false, pulled: false, error: `Nhánh hiện tại không theo dõi ${remote} và không xác định được nhánh mặc định của remote này.` });
          continue;
        }
      }
      try {
        const pulled = await pullRepo({ mode, remote, branch, autostash, useGithubAuth: body.useGithubAuth !== false });
        if (pulled.conflict) {
          stoppedByConflict = true;
          results.push({ remote, ok: false, pulled: false, conflict: true, conflicts: pulled.conflicts || [], error: 'Merge conflict — xử lý conflict rồi pull lại.' });
        } else {
          results.push({ remote, ok: pulled.ok, pulled: pulled.ok && !pulled.upToDate, commitsPulled: pulled.commitsPulled || 0, branch: pulled.branch, error: null });
        }
      } catch (err) {
        results.push({ remote, ok: false, pulled: false, error: cleanGitOutput(err.message).split('\n')[0] });
      }
    }
    return send(req, res, 200, { ok: results.some((r) => r.ok), results, ...(await aheadBehind()) });
  }

  if (route === '/api/git/push' && req.method === 'POST') {
    const pushed = await pushRepo(pushOptionsFrom(body));
    return send(req, res, 200, { ...pushed, ok: pushed.ok !== false, ...(await aheadBehind()) });
  }

  if (route === '/api/git/push/preview' && req.method === 'POST') {
    return send(req, res, 200, await pushPreview({ remote: body.remote, branch: body.branch, remoteBranch: body.remoteBranch, useGithubAuth: body.useGithubAuth }));
  }

  /* ---- multi-step operations (v3.1.0): rebase continue/abort/skip ---- */
  if (route === '/api/git/operation' && req.method === 'GET') {
    const op = await operationState();
    return send(req, res, 200, { ok: true, ...op, hint: OPERATION_HINT[op.state] || null });
  }

  const rebaseMatch = route.match(/^\/api\/git\/rebase\/(continue|abort|skip)$/);
  if (rebaseMatch && req.method === 'POST') {
    const op = await operationState();
    if (op.state !== 'rebase') throw new Error('No rebase in progress');
    const action = rebaseMatch[1];
    if (action === 'continue' && op.conflicts.length) {
      throw fail('UNRESOLVED_CONFLICTS', `Còn ${op.conflicts.length} file conflict chưa xử lý: ${op.conflicts.slice(0, 5).join(', ')}. Xử lý (Ours/Theirs hoặc sửa tay rồi Stage) trước khi Continue.`);
    }
    let out = '';
    try {
      // GIT_EDITOR=true: accept the existing commit message, never open an editor.
      out = await runGit(['rebase', `--${action}`], { env: { GIT_EDITOR: 'true' } });
    } catch (err) {
      const after = await operationState();
      if (after.state === 'rebase') {
        recordHistory({ type: `rebase-${action}`, ok: false, conflict: true, conflicts: after.conflicts.length });
        return send(req, res, 200, { ok: false, conflict: true, operation: 'rebase', conflicts: after.conflicts, result: cleanGitOutput(err.message), hint: OPERATION_HINT.rebase, ...(await aheadBehind()) });
      }
      throw err;
    }
    const after = await operationState();
    recordHistory({ type: `rebase-${action}`, ok: true });
    return send(req, res, 200, { ok: true, operation: after.state, conflicts: after.conflicts, done: after.state !== 'rebase', result: cleanGitOutput(out), ...(await aheadBehind()) });
  }

  if (route === '/api/git/sync-history' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), MAX_HISTORY);
    return send(req, res, 200, { ok: true, history: syncHistory.slice(0, limit) });
  }

  if (route === '/api/git/sync-history/clear' && req.method === 'POST') {
    syncHistory.length = 0;
    return send(req, res, 200, { ok: true, history: [] });
  }

  // One-click sync: fetch -> pull -> push, with a per-step report.
  // v3.1.0: autostash, all pull options, skip push when nothing to push,
  // pushAfter=false (= fetch + pull only), push to extra remotes.
  if (route === '/api/git/sync' && req.method === 'POST') {
    const pullOpts = pullOptionsFrom(body);
    const steps = [];
    let pulled = null;
    let pushed = null;
    const remote = pullOpts.remote;
    const auth = await githubAuthFor(validateRemoteName(remote), body.useGithubAuth);
    try {
      const fetchOut = await runGit(auth.args.concat(['fetch', '--all', '--prune', '--progress']), { env: auth.env, onStderr: progressReporter('fetch') });
      steps.push({ step: 'fetch', ok: true, result: cleanGitOutput(fetchOut) });
    } catch (err) {
      const e = failWithDetails(err);
      steps.push({ step: 'fetch', ok: false, error: e.message, reason: e.details.reason });
      recordHistory({ type: 'sync', ok: false, step: 'fetch', error: e.message.split('\n')[0] });
      return send(req, res, 200, { ok: false, steps, error: e.message, reason: e.details.reason, hint: e.details.hint, ...(await aheadBehind()) });
    }
    try {
      pulled = await pullRepo(pullOpts);
    } catch (err) {
      steps.push({ step: 'pull', ok: false, error: err.message, reason: (err.details || {}).reason });
      return send(req, res, 200, { ok: false, steps, error: err.message, reason: (err.details || {}).reason, hint: (err.details || {}).hint, ...(await aheadBehind()) });
    }
    steps.push({ step: 'pull', ok: pulled.ok, conflict: !!pulled.conflict, conflicts: pulled.conflicts || [], result: pulled.result || '', commitsPulled: pulled.commitsPulled || 0, changedFiles: pulled.changedFiles || [] });
    if (!pulled.ok) {
      return send(req, res, 200, { ok: false, conflict: !!pulled.conflict, conflicts: pulled.conflicts || [], operation: pulled.operation, hint: pulled.hint, steps, pulled, ...(await aheadBehind()) });
    }
    if (pulled.pendingCommit) {
      steps.push({ step: 'push', ok: true, skipped: true, result: 'Skipped — squash/no-commit pull left changes staged; commit them first.' });
      return send(req, res, 200, { ok: true, steps, pulled, pushed: null, ...(await aheadBehind()) });
    }
    if (body.pushAfter === false) {
      steps.push({ step: 'push', ok: true, skipped: true, result: 'Skipped (pull only).' });
      recordHistory({ type: 'sync', ok: true, pulled: pulled.commitsPulled, pushed: false });
      return send(req, res, 200, { ok: true, steps, pulled, pushed: null, ...(await aheadBehind()) });
    }
    const ab = await aheadBehind();
    if (ab.hasUpstream && ab.ahead === 0 && body.skipEmptyPush !== false && !(Array.isArray(body.extraRemotes) && body.extraRemotes.length)) {
      steps.push({ step: 'push', ok: true, skipped: true, result: 'Nothing to push — already up to date.' });
      recordHistory({ type: 'sync', ok: true, pulled: pulled.commitsPulled, pushed: false });
      return send(req, res, 200, { ok: true, steps, pulled, pushed: null, ...ab });
    }
    try {
      const pushOpts = pushOptionsFrom(Object.assign({}, body, { force: false, pushAll: false, tags: false, dryRun: false, upTo: null }));
      if (Array.isArray(body.extraRemotes) && body.extraRemotes.length) pushOpts.remotes = [pushOpts.remote].concat(body.extraRemotes);
      pushed = await pushRepo(pushOpts);
      if (pushed.ok === false) throw new Error(pushed.result || 'Push failed');
      steps.push({ step: 'push', ok: true, result: pushed.result || '' });
    } catch (err) {
      steps.push({ step: 'push', ok: false, error: err.message, reason: (err.details || {}).reason });
      return send(req, res, 200, { ok: false, steps, pulled, pushed, error: err.message, reason: (err.details || {}).reason, hint: (err.details || {}).hint, ...(await aheadBehind()) });
    }
    recordHistory({ type: 'sync', ok: true, pulled: pulled.commitsPulled, pushed: true });
    return send(req, res, 200, { ok: true, steps, pulled, pushed, ...(await aheadBehind()) });
  }

  // How many commits ahead of / behind the upstream branch.
  if (route === '/api/git/ahead-behind' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, lastFetchAt, ...(await aheadBehind()) });
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
    const op = await operationState();
    return send(req, res, 200, { ok: true, merging: await isMerging(), operation: op.state, hint: OPERATION_HINT[op.state] || null, conflicts: await conflictedFiles() });
  }

  if (route === '/api/git/conflict/resolve' && req.method === 'POST') {
    const rel = safeRel(body.path);
    const side = body.side === 'theirs' ? 'theirs' : 'ours';
    if (!(await isMerging()) && (await conflictedFiles()).length === 0) {
      throw new Error('No merge conflict in progress');
    }
    // v3.1.0: during a rebase git swaps the meaning — "--ours" is the
    // upstream you rebase ONTO and "--theirs" is YOUR commit. The UI's
    // "Ours" always means "my local version", so swap for rebases.
    const op = await operationState();
    const gitSide = op.state === 'rebase' ? (side === 'ours' ? 'theirs' : 'ours') : side;
    await runGit(['checkout', `--${gitSide}`, '--', rel]);
    await runGit(['add', '--', rel]);
    const remaining = await conflictedFiles();
    return send(req, res, 200, { ok: true, path: rel, side, gitSide, operation: op.state, remainingConflicts: remaining, allResolved: remaining.length === 0 });
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

  /* ---- worktrees + graph + upstream (v3.5.0) ---- */
  if (route === '/api/git/worktrees' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, worktrees: await listWorktrees() });
  }

  if (route === '/api/git/worktree/add' && req.method === 'POST') {
    if (!repoPath) throw new Error('No repository connected');
    const expanded = expandHome(body.path);
    if (!expanded) throw new Error('Worktree path is required');
    if (!path.isAbsolute(expanded)) throw new Error('Worktree path must be absolute');
    const target = path.resolve(expanded);
    const main = path.resolve(repoPath);
    if (target === main || target.startsWith(main + path.sep)) {
      throw new Error('Không tạo worktree bên trong repo chính — chọn một thư mục ngoài repo (ví dụ cùng cấp với repo).');
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory() && fs.readdirSync(target).length) {
      throw new Error(`Directory is not empty: ${target}`);
    }
    const branch = body.branch ? validateBranchName(body.branch) : null;
    const ref = body.ref ? validateGitRef(body.ref) : null;
    const args = ['worktree', 'add'];
    if (branch) args.push('-b', branch);
    args.push(target);
    if (ref) args.push(ref);
    const result = await runGit(args);
    const entry = (await listWorktrees()).find((w) => path.resolve(w.path) === target) || null;
    return send(req, res, 200, { ok: true, worktree: entry, result: (result || '').trim() });
  }

  if (route === '/api/git/worktree/remove' && req.method === 'POST') {
    if (!repoPath) throw new Error('No repository connected');
    const expanded = expandHome(body.path);
    if (!expanded) throw new Error('Worktree path is required');
    if (!path.isAbsolute(expanded)) throw new Error('Worktree path must be absolute');
    const target = path.resolve(expanded);
    const main = path.resolve(repoPath);
    if (target === main) throw new Error('Không xóa được worktree chính của repo.');
    const found = (await listWorktrees()).find((w) => path.resolve(w.path) === target);
    if (!found) throw new Error(`Không tìm thấy worktree: ${target}`);
    const args = ['worktree', 'remove'];
    if (body.force === true) args.push('--force');
    args.push(target);
    const result = await runGit(args);
    return send(req, res, 200, { ok: true, path: target, result: (result || '').trim() });
  }

  if (route === '/api/git/graph' && req.method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    if (!(await hasHead())) return send(req, res, 200, { ok: true, lines: [] });
    const raw = await runGit(['log', '--graph', '--all', '--decorate', '--oneline', '-n', String(limit)]);
    return send(req, res, 200, { ok: true, lines: raw.split('\n').filter((l) => l.trim()) });
  }

  // v3.5.0: blame for one file, via `git blame --line-porcelain`.
  // Shape matches what dashboard.js showBlame() accepts:
  // { ok, path, ref, lines: [{ line, sha, author, email, date (ISO), summary, content }] }
  if (route === '/api/git/blame' && req.method === 'GET') {
    const rel = safeRel(url.searchParams.get('path'));
    const ref = url.searchParams.get('ref') ? validateGitRef(url.searchParams.get('ref')) : 'HEAD';
    if (!(await hasHead())) return send(req, res, 200, { ok: true, path: rel, ref, lines: [] });
    const raw = await runGit(['blame', '--line-porcelain', ref, '--', rel]);
    const lines = [];
    let cur = null;
    for (const rawLine of raw.split('\n')) {
      // Porcelain header is "<sha> <orig-line> <final-line> [num-lines]":
      // the trailing count is omitted for the last group of a boundary
      // commit, so it must be optional (a strict 4-field match silently
      // drops that group and merges its line into the previous one).
      const header = rawLine.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
      if (header) {
        if (cur) lines.push(cur);
        cur = { line: Number(header[2]), sha: header[1], author: '', email: '', date: '', summary: '', content: '' };
        continue;
      }
      if (!cur) continue;
      if (rawLine.startsWith('author ')) cur.author = rawLine.slice(7);
      else if (rawLine.startsWith('author-mail ')) cur.email = rawLine.slice(12).replace(/^<|>$/g, '');
      else if (rawLine.startsWith('author-time ')) {
        const ts = Number(rawLine.slice(12));
        cur.date = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : '';
      } else if (rawLine.startsWith('summary ')) cur.summary = rawLine.slice(8);
      else if (rawLine.startsWith('\t')) cur.content = rawLine.slice(1);
    }
    if (cur) lines.push(cur);
    return send(req, res, 200, { ok: true, path: rel, ref, lines, blame: lines });
  }

  // v3.5.0: commit history of one file (`git log --follow`).
  // Shape matches dashboard.js showFileHistory() and /api/git/log:
  // { ok, path, commits: [{ sha, hash, subject, author, date, email }] }
  if (route === '/api/git/file-history' && req.method === 'GET') {
    const rel = safeRel(url.searchParams.get('path'));
    if (!(await hasHead())) return send(req, res, 200, { ok: true, path: rel, commits: [] });
    const raw = await runGit(['log', '--follow', '--max-count=50', '--date=short', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%ae', '--', rel]);
    const commits = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, hash, subject, author, date, email] = line.split('\x1f');
        return { sha, hash, subject, author, date, email };
      });
    return send(req, res, 200, { ok: true, path: rel, commits, history: commits });
  }

  if (route === '/api/git/upstream' && req.method === 'GET') {
    const ab = await aheadBehind();
    if (!ab.upstream) {
      return send(req, res, 200, { ok: true, upstream: null, remote: null, branch: ab.branch, ahead: null, behind: null });
    }
    return send(req, res, 200, { ok: true, upstream: ab.upstream, remote: ab.upstream.split('/')[0], branch: ab.branch, ahead: ab.ahead, behind: ab.behind });
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

  /* ---- v3.0: cherry-pick / revert / reset / tags / archive-zip ---- */
  if (route === '/api/git/archive-zip' && req.method === 'POST') {
    const ref = String(body.ref || 'HEAD').trim();
    validateGitRef(ref);
    const repoName = path.basename(repoPath).replace(/[^A-Za-z0-9._-]+/g, '-');
    const buf = await runGitBuffer(['archive', '--format=zip', ref]);
    const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${repoName}-${safeRef}.zip"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
    return;
  }

  if (route === '/api/git/cherry-pick' && req.method === 'POST') {
    const sha = validateSha(body.sha);
    try {
      const result = await runGit(['cherry-pick', sha]);
      return send(req, res, 200, { ok: true, conflict: false, sha, result: (result || '').trim() });
    } catch (err) {
      const text = `${err.message || ''} ${err.gitStderr || ''}`;
      if (/CONFLICT/i.test(text) || /Automatic cherry-pick failed/i.test(text)) {
        return send(req, res, 200, { ok: false, conflict: true, conflicts: await conflictedFiles(), sha, result: text.trim() });
      }
      throw err;
    }
  }

  if (route === '/api/git/revert' && req.method === 'POST') {
    const sha = validateSha(body.sha);
    try {
      const result = await runGit(['revert', '--no-edit', sha]);
      return send(req, res, 200, { ok: true, conflict: false, sha, result: (result || '').trim() });
    } catch (err) {
      const text = `${err.message || ''} ${err.gitStderr || ''}`;
      if (/CONFLICT/i.test(text)) {
        return send(req, res, 200, { ok: false, conflict: true, conflicts: await conflictedFiles(), sha, result: text.trim() });
      }
      throw err;
    }
  }

  if (route === '/api/git/reset' && req.method === 'POST') {
    const mode = String(body.mode || 'mixed').trim();
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error("Reset mode must be 'soft', 'mixed' or 'hard'");
    if (mode === 'hard' && body.confirm !== true) {
      throw new Error('Reset --hard xóa thay đổi chưa commit — cần xác nhận (gửi { confirm: true }).');
    }
    const ref = validateGitRef(String(body.ref || 'HEAD').trim());
    const result = await runGit(['reset', `--${mode}`, ref]);
    return send(req, res, 200, { ok: true, mode, ref, result: (result || '').trim() });
  }

  if (route === '/api/git/tags' && req.method === 'GET') {
    const raw = await runGit(['tag', '--list']);
    const names = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const tags = [];
    for (const name of names) {
      let sha = null;
      try { sha = (await runGit(['rev-list', '-n', '1', name])).trim() || null; } catch (_) { sha = null; }
      tags.push({ name, sha });
    }
    return send(req, res, 200, { ok: true, tags });
  }

  if (route === '/api/git/tag/create' && req.method === 'POST') {
    const name = validateBranchName(body.name);
    const message = String(body.message || '').trim();
    const ref = body.ref ? validateGitRef(String(body.ref).trim()) : null;
    const args = ['tag'];
    if (message) { args.push('-a', name, '-m', message); } else { args.push(name); }
    if (ref) args.push(ref);
    const result = await runGit(args);
    return send(req, res, 200, { ok: true, tag: name, annotated: !!message, result: (result || '').trim() });
  }

  if (route === '/api/git/tag/delete' && req.method === 'POST') {
    const name = validateBranchName(body.name);
    const result = await runGit(['tag', '-d', name]);
    return send(req, res, 200, { ok: true, tag: name, result: (result || '').trim() });
  }

  if (route === '/api/git/tag/push' && req.method === 'POST') {
    const name = validateBranchName(body.name);
    const remote = validateRemoteName(body.remote || 'origin');
    const result = await runGit(['push', remote, name]);
    return send(req, res, 200, { ok: true, tag: name, remote, result: (result || '').trim() });
  }

  return send(req, res, 404, { error: `Unknown endpoint: ${req.method} ${route}` });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

loadState();
loadGhConfig();
loadOAuthAppConfig();
function envBoolean(name, fallback) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(process.env[name]).trim());
}
autoUpdate.enabled = envBoolean('GITHUB_AUTO_UPDATE_ENABLED', !!(ghConfig.autoUpdate && ghConfig.autoUpdate.enabled));
autoUpdate.intervalSeconds = process.env.GITHUB_AUTO_UPDATE_INTERVAL_SECONDS !== undefined && process.env.GITHUB_AUTO_UPDATE_INTERVAL_SECONDS !== ''
  ? clampInterval(process.env.GITHUB_AUTO_UPDATE_INTERVAL_SECONDS)
  : clampInterval(ghConfig.autoUpdate && ghConfig.autoUpdate.intervalSeconds);
autoUpdate.autoSync = envBoolean('GITHUB_AUTO_SYNC', !!(ghConfig.autoUpdate && ghConfig.autoUpdate.autoSync));
scheduleAutoUpdate();

/* v3.5.1: auto-configure from .env / environment before listening,   */
/* so opening the extension just works: a GITHUB_PAT signs in         */
/* automatically (validated first — an invalid one only logs a        */
/* warning, the bridge still starts), and DEFAULT_REPO_PATH selects   */
/* that local repo when no repo was remembered. Nothing here ever     */
/* logs a secret value, only login names and paths.                   */
async function autoConfigureFromEnv() {
  if (DOTENV_KEYS.length) log(`.env loaded (${DOTENV_KEYS.join(', ')}) — real environment variables take precedence.`);
  if (!ghAuthed()) {
    const pat = String(process.env.GITHUB_PAT || '').trim();
    if (pat) {
      try {
        const { user, scopes } = await ghValidateToken(pat);
        signInWithToken(pat, user, scopes, 'pat');
        log(`Auto sign-in from .env: GitHub user ${(user && user.login) || 'unknown'} (PAT).`);
      } catch (err) {
        log(`GITHUB_PAT from .env is invalid or GitHub rejected it (${(err && err.message) || err}) — sign in from the extension instead.`);
      }
    }
  }
  const defaultRepo = String(process.env.DEFAULT_REPO_PATH || '').trim();
  if (defaultRepo && !repoPath) {
    try {
      const abs = path.resolve(defaultRepo);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && fs.existsSync(path.join(abs, '.git'))) {
        repoPath = abs;
        saveState();
        log(`Auto-selected repository from .env: ${abs}`);
      } else {
        log(`DEFAULT_REPO_PATH from .env is not a Git repository: ${abs}`);
      }
    } catch (err) {
      log(`Could not auto-select DEFAULT_REPO_PATH: ${err.message}`);
    }
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof GhError ? (err.status || 400) : 400;
    const payload = { error: (err && err.message) || 'Bridge error' };
    if (err && err.code) payload.code = err.code;
    // v3.1.0: structured push/pull failure info (reason, hint, refs…)
    if (err && err.details && typeof err.details === 'object') {
      for (const [k, v] of Object.entries(err.details)) if (!(k in payload)) payload[k] = v;
    }
    return send(req, res, status, payload);
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

// v3.5.1: auto-configure from .env first, then start listening, so
// the first request already sees the signed-in state and the repo.
(async () => {
  await autoConfigureFromEnv();
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
})();

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
