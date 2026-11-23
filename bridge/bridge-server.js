#!/usr/bin/env node
'use strict';

/*
 * PixiJS GitHub Desktop Sync - Local Git Bridge
 * v1.0.1
 *
 * A dependency-free local HTTP bridge that exposes a small, safe subset of
 * Git operations to the companion Chrome extension.
 *
 * Design rules:
 *  - Binds to 127.0.0.1 only.
 *  - Every /api/* route requires a bearer token.
 *  - Git is always spawned with shell:false (no shell injection).
 *  - Paths are validated as repository-relative (no absolute, no traversal).
 *  - No reset / force-push / arbitrary shell endpoint.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = '1.0.1';
const HOST = '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 17321);
const ROOT = path.resolve(__dirname);
const TOKEN_FILE = path.join(ROOT, '.bridge-token');
const STATE_FILE = path.join(ROOT, '.bridge-state.json');

const GIT_TIMEOUT_MS = 120000; // hard cap so a credential prompt can never hang the bridge
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 400000;

/* ------------------------------------------------------------------ */
/* Token                                                               */
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
/* State (repo path survives a bridge restart)                         */
/* ------------------------------------------------------------------ */

let repoPath = null;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.repoPath === 'string' && raw.repoPath) {
      const abs = path.resolve(raw.repoPath);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) repoPath = abs;
    }
  } catch (_) {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ repoPath }, null, 2), { mode: 0o600 });
  } catch (_) {}
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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
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
/* Git                                                                 */
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

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!repoPath) return reject(new Error('No repository connected'));
    let child;
    try {
      child = spawn('git', args, {
        cwd: repoPath,
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
      const message = (err || out || `git exited with code ${code}`).trim();
      const error = new Error(message);
      error.gitCode = code;
      error.gitStderr = err;
      reject(error);
    });
  });
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
  try {
    return (await runGit(['remote', 'get-url', 'origin'])).trim() || null;
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

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(req, res, 204, null);
  }

  // Public health check (no token) so the popup can show a lamp.
  if (route === '/health' && req.method === 'GET') {
    return send(req, res, 200, {
      ok: true,
      version: VERSION,
      repository: await repoSummary(),
    });
  }

  if (!tokenMatches(req.headers.authorization)) {
    return send(req, res, 401, { error: 'Unauthorized: invalid or missing bridge token' });
  }

  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
  }

  /* ---- repository selection ---- */
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

  /* ---- commit ---- */
  if (route === '/api/git/commit' && req.method === 'POST') {
    const summary = String(body.summary || '').trim();
    if (!summary) throw new Error('Commit summary is required');
    const description = String(body.description || '').trim();
    const message = description ? `${summary}\n\n${description}` : summary;

    // Fail with a readable message instead of git's cryptic identity error.
    try {
      await runGit(['var', 'GIT_AUTHOR_IDENT']);
    } catch (_) {
      throw new Error(
        'Git author identity is not configured. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"'
      );
    }

    const staged = (await runGit(['diff', '--cached', '--name-only'])).trim();
    if (!staged) throw new Error('Nothing is staged. Stage files before committing.');

    const result = await runGit(['commit', '-m', message]);
    return send(req, res, 200, { ok: true, result: result.trim() });
  }

  /* ---- remote sync ---- */
  if (route === '/api/git/fetch' && req.method === 'POST') {
    return send(req, res, 200, { ok: true, result: (await runGit(['fetch', '--all', '--prune'])).trim() });
  }

  if (route === '/api/git/pull' && req.method === 'POST') {
    const branch = await currentBranch();
    if (!branch || branch.startsWith('(')) throw new Error('Cannot pull: no branch checked out');
    const upstream = await upstreamOf(branch);
    const args = upstream ? ['pull', '--ff-only'] : ['pull', '--ff-only', 'origin', branch];
    return send(req, res, 200, { ok: true, result: (await runGit(args)).trim() });
  }

  if (route === '/api/git/push' && req.method === 'POST') {
    const branch = await currentBranch();
    if (!branch || branch.startsWith('(')) throw new Error('Cannot push: no branch checked out');
    const upstream = await upstreamOf(branch);
    // First push of a new branch needs -u, otherwise `git push` fails with
    // "fatal: The current branch has no upstream branch".
    const args = upstream ? ['push'] : ['push', '-u', 'origin', branch];
    return send(req, res, 200, { ok: true, result: (await runGit(args)).trim() });
  }

  /* ---- branches ---- */
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
    return send(req, res, 200, { branches });
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

  /* ---- history ---- */
  if (route === '/api/git/log' && req.method === 'GET') {
    if (!(await hasHead())) return send(req, res, 200, { commits: [] });
    const raw = await runGit(['log', '-30', '--date=short', '--pretty=format:%h%x1f%s%x1f%an%x1f%ad']);
    const commits = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, date] = line.split('\x1f');
        return { hash, subject, author, date };
      });
    return send(req, res, 200, { commits });
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

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
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
  console.log(`PixiJS Git Bridge v${VERSION}`);
  console.log(`Listening:  http://${HOST}:${PORT}`);
  console.log(`Token file: ${TOKEN_FILE}`);
  console.log(`TOKEN:      ${TOKEN}`);
  if (repoPath) console.log(`Repository: ${repoPath}`);
  console.log('');
  console.log('Paste the TOKEN into the extension dashboard, then click "Connect Bridge".');
  console.log('Keep this terminal open. Press Ctrl+C to stop.');
  console.log('');
});

function shutdown() {
  console.log('\nStopping bridge…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
