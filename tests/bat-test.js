'use strict';
require('./_node16-fetch'); // Node 16.13 has no global fetch

/*
 * tests/bat-test.js — Windows launcher / doctor script checks (v3.7.0).
 *
 * Covers the five launcher/doctor scripts, which the bridge tests never
 * execute:
 *   bridge/start-windows.bat, bridge/bridge-doctor.bat,
 *   bridge/start-windows.ps1, bridge/start-mac-linux.sh,
 *   bridge/bridge-doctor.sh
 * plus (section [9], v3.7.0) the native-host register/unregister
 * scripts bridge/register-native-host.bat and (if it exists)
 * bridge/unregister-native-host.bat — same bytes + structure rules,
 * plus the registry key + manifest generation checks.
 *
 * HONEST LIMIT: cmd.exe cannot run on Linux, so the .bat files are
 * verified by BYTES + STRUCTURE only — they are NEVER executed here
 * (and never on real Windows by this harness). The .sh files DO run
 * for real on Linux (bridge-doctor.sh against a live bridge and a
 * dead port; start-mac-linux.sh starting a real bridge copy).
 * The .ps1 is checked by bytes + structure only (no PowerShell here).
 *
 * What is checked:
 *   - Bytes: .bat = CRLF on every line, 100% ASCII, no BOM.
 *     .sh = LF only, 100% ASCII, no BOM. .ps1 = UTF-8 with BOM,
 *     ASCII after the BOM.
 *   - Structure per file: node check, port 17321 check (or, for
 *     start-mac-linux.sh, an explicit 17321 mention — it runs the
 *     bridge in the foreground and lets node report a busy port),
 *     /health wait loop (launcher .bat/.ps1, doctor .sh), log/report
 *     file mentioned, version string matching the root manifest
 *     (so the check survives the v3.5.0 version bump).
 *   - Batch-line parser (start-windows.bat, bridge-doctor.bat):
 *       * every label referenced by `goto :x` or `call :x` exists;
 *       * setlocal/endlocal: exactly one setlocal, and every
 *         TERMINAL exit (an `exit /b` in a block that is not a
 *         subroutine and not reachable from one via goto) is
 *         immediately preceded by `endlocal`, while subroutine
 *         returns (`exit /b` inside a `call`ed label or a label
 *         reachable from one) are NOT — the scope must close on
 *         every exit path, exactly once per path, and must stay
 *         open while subroutines are still being called;
 *       * every `exit /b 1` is preceded (same block, previous few
 *         lines) by a `pause`, so the window never closes before
 *         the user can read the error;
 *       * no `!` inside a `call :log "..."` message (delayed
 *         expansion would eat it);
 *       * balanced parens/braces.
 *   - PowerShell parser (start-windows.ps1): balanced braces/parens,
 *     every `exit` preceded (previous few lines) by `Read-Host` so
 *     the window stays open, `Fail` pauses before exiting.
 *   - README: the .bat troubleshooting paragraph is still there.
 *
 * Usage: node tests/bat-test.js
 * No call to api.github.com or github.com is ever made.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge', 'bridge-server.js');
const BRIDGE_PORT = 17389; // live bridge for the doctor.sh live run
const SH_PORT = 17390; // bridge started by start-mac-linux.sh
const DEAD_PORT = 17496; // nothing ever listens here
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`  PASS  ${name}`); }
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Byte rules                                                          */
/* ------------------------------------------------------------------ */

// .bat: CRLF on every line, 100% ASCII, no BOM. Returns text.
function checkBatchBytes(buf, label) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(`${label}: no UTF-8 BOM`, !hasBom);
  let nonAscii = 0;
  for (const b of buf) if (b >= 128) nonAscii += 1;
  check(`${label}: 100% ASCII (0 non-ASCII bytes)`, nonAscii === 0, `${nonAscii} non-ASCII bytes`);
  const crCount = [...buf].filter((b) => b === 0x0d).length;
  const lfCount = [...buf].filter((b) => b === 0x0a).length;
  check(`${label}: CRLF on every line (CR == LF)`, crCount === lfCount && lfCount > 0, `CR=${crCount} LF=${lfCount}`);
  let bareCr = false;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] !== 0x0a) { bareCr = true; break; }
  }
  check(`${label}: no bare CR`, !bareCr);
  return buf.toString('utf8');
}

// .sh: LF only, 100% ASCII, no BOM. Returns text.
function checkShBytes(buf, label) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(`${label}: no UTF-8 BOM`, !hasBom);
  check(`${label}: no CR bytes (LF only)`, !buf.includes(0x0d));
  let nonAscii = 0;
  let firstNonAscii = -1;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] >= 128) { nonAscii += 1; if (firstNonAscii < 0) firstNonAscii = i; }
  }
  check(`${label}: 100% ASCII (0 non-ASCII bytes)`, nonAscii === 0,
    nonAscii ? `${nonAscii} non-ASCII bytes, first at offset ${firstNonAscii}: ${JSON.stringify(buf.toString('utf8').slice(Math.max(0, firstNonAscii - 20), firstNonAscii + 10))}` : '');
  return buf.toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Small batch-line parser                                             */
/* ------------------------------------------------------------------ */

// Splits a .bat into label blocks. Returns { blocks, order } where each
// block is { label, lines: [{no, text}] }; the pre-label flow is '__main__'.
function parseBatch(text) {
  const rawLines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks = { __main__: { label: '__main__', lines: [] } };
  const order = ['__main__'];
  let current = '__main__';
  rawLines.forEach((line, idx) => {
    // A label is a line that is just ":name" (a "::" line is a comment).
    const m = line.match(/^:([A-Za-z0-9_]+)\s*$/);
    if (m && !line.startsWith('::')) {
      current = m[1].toLowerCase();
      if (!blocks[current]) { blocks[current] = { label: current, lines: [] }; order.push(current); }
      return;
    }
    blocks[current].lines.push({ no: idx + 1, text: line });
  });
  return { blocks, order };
}

function batchChecks(text, label) {
  const { blocks, order } = parseBatch(text);

  // --- goto / call targets all exist ---
  const defined = new Set(order);
  const missingGoto = [];
  const missingCall = [];
  const callTargets = new Set();
  for (const name of order) {
    for (const { text: line } of blocks[name].lines) {
      for (const m of line.matchAll(/\bgoto\s+:([A-Za-z0-9_]+)/gi)) {
        if (!defined.has(m[1].toLowerCase())) missingGoto.push(m[1]);
      }
      for (const m of line.matchAll(/\bcall\s+:([A-Za-z0-9_]+)/gi)) {
        callTargets.add(m[1].toLowerCase());
        if (!defined.has(m[1].toLowerCase())) missingCall.push(m[1]);
      }
    }
  }
  check(`${label}: every goto target exists`, missingGoto.length === 0, missingGoto.join(','));
  check(`${label}: every call target exists`, missingCall.length === 0, missingCall.join(','));

  // --- subroutine blocks: call targets + anything reachable from them
  // via goto only (e.g. :tryhealth_curl is part of :tryhealth). ---
  const gotoEdges = {};
  for (const name of order) {
    gotoEdges[name] = new Set();
    for (const { text: line } of blocks[name].lines) {
      for (const m of line.matchAll(/\bgoto\s+:([A-Za-z0-9_]+)/gi)) gotoEdges[name].add(m[1].toLowerCase());
    }
  }
  const subBlocks = new Set(callTargets);
  const queue = [...callTargets];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of gotoEdges[cur] || []) {
      if (!subBlocks.has(next)) { subBlocks.add(next); queue.push(next); }
    }
  }

  // --- setlocal / endlocal ---
  let setlocalCount = 0;
  let endlocalCount = 0;
  let terminalExits = 0;
  let terminalExitsClosed = 0;
  let subReturns = 0;
  let subReturnsClosed = 0; // must stay 0: a return must NOT close the scope
  let exit1WithoutPause = [];
  for (const name of order) {
    const lines = blocks[name].lines;
    const isSub = subBlocks.has(name);
    lines.forEach((entry, i) => {
      const line = entry.text;
      if (/^\s*setlocal\b/i.test(line)) setlocalCount += 1;
      if (/^\s*endlocal\b/i.test(line)) endlocalCount += 1;
      const exitMatch = line.match(/^\s*exit\s+\/b\s+(\d+)/i);
      if (!exitMatch) return;
      const code = exitMatch[1];
      // Previous non-empty line in the same block.
      let prev = '';
      for (let j = i - 1; j >= 0; j -= 1) {
        if (lines[j].text.trim() !== '') { prev = lines[j].text; break; }
      }
      if (isSub) {
        subReturns += 1;
        if (/^\s*endlocal\b/i.test(prev)) subReturnsClosed += 1;
      } else {
        terminalExits += 1;
        if (/^\s*endlocal\b/i.test(prev)) terminalExitsClosed += 1;
      }
      if (code === '1') {
        // A pause (or a Read-Host-style wait) in the same block, in the
        // previous 6 non-empty lines, so the user can read the error.
        let sawPause = false;
        let seen = 0;
        for (let j = i - 1; j >= 0 && seen < 6; j -= 1) {
          if (lines[j].text.trim() === '') continue;
          seen += 1;
          if (/^\s*pause\b/i.test(lines[j].text)) { sawPause = true; break; }
        }
        if (!sawPause) exit1WithoutPause.push(`${label}:${entry.no}`);
      }
    });
  }
  check(`${label}: exactly one setlocal`, setlocalCount === 1, `found ${setlocalCount}`);
  check(`${label}: every terminal exit is preceded by endlocal (${terminalExitsClosed}/${terminalExits})`,
    terminalExits > 0 && terminalExitsClosed === terminalExits,
    `${terminalExits - terminalExitsClosed} terminal exit(s) without endlocal`);
  check(`${label}: endlocal count == terminal exit count (one scope close per path)`,
    endlocalCount === terminalExits, `endlocal=${endlocalCount} terminal exits=${terminalExits}`);
  check(`${label}: no subroutine return closes the setlocal scope`,
    subReturnsClosed === 0, `${subReturnsClosed} of ${subReturns} returns preceded by endlocal`);
  check(`${label}: every exit /b 1 is preceded by a pause`,
    exit1WithoutPause.length === 0, exit1WithoutPause.join(', '));

  // --- no `!` inside a call :log "..." message (delayed expansion eats it) ---
  const bangLog = [];
  for (const name of order) {
    for (const { no, text: line } of blocks[name].lines) {
      const m = line.match(/^\s*call\s+:log\s+"([^"]*)"/i);
      if (m && m[1].includes('!')) bangLog.push(`${label}:${no}`);
    }
  }
  check(`${label}: no ! inside :log messages`, bangLog.length === 0, bangLog.join(', '));

  // --- balanced parens / braces ---
  const opens = (text.match(/\(/g) || []).length;
  const closes = (text.match(/\)/g) || []).length;
  check(`${label}: balanced parens`, opens === closes, `(${opens} vs )${closes}`);
  const braceOpens = (text.match(/\{/g) || []).length;
  const braceCloses = (text.match(/\}/g) || []).length;
  check(`${label}: balanced braces`, braceOpens === braceCloses, `{${braceOpens} vs }${braceCloses}`);
}

/* ------------------------------------------------------------------ */
/* PowerShell structure checks                                         */
/* ------------------------------------------------------------------ */

function ps1Checks(text, label) {
  const braceOpens = (text.match(/\{/g) || []).length;
  const braceCloses = (text.match(/\}/g) || []).length;
  check(`${label}: balanced braces`, braceOpens === braceCloses && braceOpens > 0, `{${braceOpens} vs }${braceCloses}`);
  const parenOpens = (text.match(/\(/g) || []).length;
  const parenCloses = (text.match(/\)/g) || []).length;
  check(`${label}: balanced parens`, parenOpens === parenCloses, `(${parenOpens} vs )${parenCloses}`);
  // Every `exit N` must be preceded (previous 5 non-empty lines) by a
  // Read-Host, so the window stays open for the user to read the error.
  const lines = text.split('\n');
  const noPauseExit = [];
  lines.forEach((line, i) => {
    if (!/^\s*exit\s+\d+/.test(line)) return;
    let sawPause = false;
    let seen = 0;
    for (let j = i - 1; j >= 0 && seen < 5; j -= 1) {
      if (lines[j].trim() === '') continue;
      seen += 1;
      if (/Read-Host/.test(lines[j])) { sawPause = true; break; }
    }
    if (!sawPause) noPauseExit.push(`${label}:${i + 1}`);
  });
  check(`${label}: every exit is preceded by Read-Host`, noPauseExit.length === 0, noPauseExit.join(', '));
}

/* ------------------------------------------------------------------ */
/* Bridge spawner (for the .sh real runs)                              */
/* ------------------------------------------------------------------ */

function startBridge(port, dataDir, extraEnv) {
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_DATA_DIR: dataDir, ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box = { proc, out: '' };
  proc.stdout.on('data', (d) => { box.out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { box.out += d.toString('utf8'); });
  return box;
}

async function waitListening(box) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (box.out.includes('Listening:')) return true;
    if (box.proc.exitCode !== null) return false;
    await sleep(100);
  }
  return false;
}

async function waitExit(proc) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return true;
    await sleep(50);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-test-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let bridge = null;
  let shProc = null;
  const cleanup = (code) => {
    try { if (bridge) bridge.proc.kill('SIGTERM'); } catch (_) {}
    if (shProc) {
      try { process.kill(-shProc.pid, 'SIGTERM'); } catch (_) { try { shProc.kill('SIGTERM'); } catch (_) {} }
    }
    if (failures > 0 && bridge) {
      console.log('\n--- bridge log (last 20 lines, token redacted) ---');
      console.log(bridge.out.split('\n').slice(-20).join('\n').replace(/TOKEN:\s*\S+/g, 'TOKEN: [redacted]'));
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nbat-test: ${passes} passed, ${failures} failed`);
    process.exit(code);
  };

  /* ==================== 0. start-windows.bat ==================== */
  console.log('\n[0] start-windows.bat — bytes + batch parser (cmd.exe cannot run on Linux)');
  let batText = '';
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'start-windows.bat'));
    batText = checkBatchBytes(buf, 'start-windows.bat');
    for (const [name, re] of [
      ['checks node is installed', /where node/],
      ['checks Node version >= 16.13', /LSS 16/ && /EQU 16 if %NODEMINOR% LSS 13/],
      ['checks bridge-server.js exists', /if not exist bridge-server\.js/],
      ['checks port with netstat', /netstat/],
      ['mentions port 17321', /17321/],
      ['logs to bridge-start.log', /bridge-start\.log/],
      ['pauses so the user can read errors', /pause/],
      ['waits for /health', /\/health/],
      ['tries curl first, PowerShell fallback', /curl\.exe/ && /powershell/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
      ['prints TOKEN from the log', /TOKEN:/],
      ['space before >> in :log (digit-eating fix)', /echo %~1 >> /],
    ]) {
      check(`start-windows.bat: ${name}`, re.test(batText), batText.slice(0, 200));
    }
    batchChecks(batText, 'start-windows.bat');
  }

  /* ==================== 1. bridge-doctor.bat ==================== */
  console.log('\n[1] bridge-doctor.bat — bytes + batch parser (cmd.exe cannot run on Linux)');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.bat'));
    const text = checkBatchBytes(buf, 'bridge-doctor.bat');
    for (const [name, re] of [
      ['writes bridge-doctor-report.txt', /bridge-doctor-report\.txt/],
      ['checks node', /where node/],
      ['checks port with netstat', /netstat/],
      ['checks /health', /\/health/],
      ['checks bridge-server.js', /bridge-server\.js/],
      ['pauses at the end so the report can be read', /pause/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
    ]) {
      check(`bridge-doctor.bat: ${name}`, re.test(text));
    }
    batchChecks(text, 'bridge-doctor.bat');
  }

  /* ==================== 2. start-windows.ps1 ==================== */
  console.log('\n[2] start-windows.ps1 — bytes + structure (no PowerShell on Linux)');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'start-windows.ps1'));
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    check('start-windows.ps1: UTF-8 BOM present', hasBom);
    let nonAscii = 0;
    for (const b of buf.slice(3)) if (b >= 128) nonAscii += 1;
    check('start-windows.ps1: ASCII after BOM (0 non-ASCII bytes)', nonAscii === 0, `${nonAscii} non-ASCII bytes`);
    const ps = buf.slice(3).toString('utf8');
    for (const [name, re] of [
      ['checks node is installed', /Get-Command node/],
      ['checks Node version >= 16.13', /-lt 16 -or/],
      ['checks bridge-server.js exists', /Test-Path 'bridge-server\.js'/],
      ['checks port (TCP connect)', /BeginConnect/],
      ['checks an already-running bridge via /health', /Invoke-WebRequest/ && /\/health/],
      ['logs to bridge-start.log', /bridge-start\.log/],
      ['waits for /health in a loop', /for \(\$i = 1; \$i -le 10/],
      ['pauses at the end (Read-Host)', /Read-Host/],
      ['Fail() pauses before exiting', /function Fail/ && /Read-Host \| Out-Null\n  exit 1/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
      ['documents ExecutionPolicy Bypass', /ExecutionPolicy Bypass/],
    ]) {
      check(`start-windows.ps1: ${name}`, re.test(ps), ps.slice(0, 200));
    }
    ps1Checks(ps, 'start-windows.ps1');
  }

  /* ==================== 3. start-mac-linux.sh ==================== */
  console.log('\n[3] start-mac-linux.sh — bytes + structure');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'));
    const text = checkShBytes(buf, 'start-mac-linux.sh');
    for (const [name, re] of [
      ['checks node is installed', /command -v node/],
      ['mentions port 17321', /17321/],
      ['runs node bridge-server.js in the foreground', /node bridge-server\.js/],
      ['keeps the window open on error (read prompt, tty-guarded)', /read -r -p/ && /\[ -t 0 \]/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
    ]) {
      check(`start-mac-linux.sh: ${name}`, re.test(text));
    }
    check('start-mac-linux.sh: executable bit set', (fs.statSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh')).mode & 0o111) !== 0);
  }

  /* ==================== 4. bridge-doctor.sh ==================== */
  console.log('\n[4] bridge-doctor.sh — bytes + structure');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.sh'));
    const text = checkShBytes(buf, 'bridge-doctor.sh');
    for (const [name, re] of [
      ['writes bridge-doctor-report.txt', /bridge-doctor-report\.txt/],
      ['checks node version', /node -v/],
      ['checks /health with curl', /curl/ && /\/health/],
      ['respects BRIDGE_PORT env', /BRIDGE_PORT:-17321/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
    ]) {
      check(`bridge-doctor.sh: ${name}`, re.test(text));
    }
    check('bridge-doctor.sh: executable bit set', (fs.statSync(path.join(ROOT, 'bridge', 'bridge-doctor.sh')).mode & 0o111) !== 0);
  }

  /* ==================== 5. bridge-doctor.sh RUNS FOR REAL ==================== */
  console.log('\n[5] bridge-doctor.sh — runs for real on Linux');
  bridge = startBridge(BRIDGE_PORT, dataDir);
  if (!(await waitListening(bridge))) {
    console.log('  FAIL  bridge starts for doctor.sh live run -> ' + bridge.out.slice(-300));
    cleanup(1);
    return;
  }
  check('bridge starts for doctor.sh live run', true);
  {
    const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => ({}));
    check('live bridge /health reports manifest version', h.ok === true && h.version === MANIFEST_VERSION, JSON.stringify(h).slice(0, 120));
  }
  {
    const docDir = path.join(tmp, 'doctor');
    fs.mkdirSync(docDir, { recursive: true });
    fs.copyFileSync(BRIDGE_ENTRY, path.join(docDir, 'bridge-server.js'));
    fs.copyFileSync(path.join(ROOT, 'bridge', 'bridge-doctor.sh'), path.join(docDir, 'bridge-doctor.sh'));
    const runDoctor = (port) => new Promise((resolve) => {
      const p = spawn('/bin/sh', [path.join(docDir, 'bridge-doctor.sh')], {
        env: { ...process.env, BRIDGE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString('utf8'); });
      p.stderr.on('data', (d) => { out += d.toString('utf8'); });
      const timer = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} resolve({ out, timedOut: true }); }, 15000);
      p.on('exit', () => { clearTimeout(timer); resolve({ out, timedOut: false }); });
    });

    const live = await runDoctor(BRIDGE_PORT);
    const liveReport = path.join(docDir, 'bridge-doctor-report.txt');
    check('doctor.sh (live bridge): exits', !live.timedOut, live.out.slice(-200));
    check('doctor.sh (live bridge): report file created', fs.existsSync(liveReport));
    if (fs.existsSync(liveReport)) {
      const rep = fs.readFileSync(liveReport, 'utf8');
      for (const [name, re] of [
        ['report: Node.js section + version', /1\. Node\.js:/ && /Node\.js: v\d+/],
        ['report: bridge-server.js found', /Tim thay bridge-server\.js/],
        ['report: /health OK', /\/health tra loi OK/],
        ['report: write-permission OK', /Ghi file trong thu muc bridge: OK/],
        ['report: file list section', /6\. Danh sach file/],
      ]) {
        check(`doctor.sh (live bridge): ${name}`, re.test(rep), rep.slice(0, 300));
      }
    }

    const dead = await runDoctor(DEAD_PORT);
    check('doctor.sh (dead port): exits', !dead.timedOut, dead.out.slice(-200));
    if (fs.existsSync(liveReport)) {
      const rep = fs.readFileSync(liveReport, 'utf8');
      check('doctor.sh (dead port): report says /health does NOT answer',
        /\/health KHONG tra loi/.test(rep), rep.slice(0, 300));
      check('doctor.sh (dead port): report names the dead port',
        new RegExp(`Cong ${DEAD_PORT}`).test(rep), rep.slice(0, 200));
    }
  }

  /* ==================== 6. start-mac-linux.sh RUNS FOR REAL ==================== */
  console.log('\n[6] start-mac-linux.sh — runs a real bridge copy');
  {
    const copyDir = path.join(tmp, 'sh-copy');
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(BRIDGE_ENTRY, path.join(copyDir, 'bridge-server.js'));
    fs.copyFileSync(path.join(ROOT, 'bridge', 'start-mac-linux.sh'), path.join(copyDir, 'start-mac-linux.sh'));
    const copyData = path.join(tmp, 'sh-copy-data');
    fs.mkdirSync(copyData, { recursive: true });
    shProc = spawn('/bin/sh', [path.join(copyDir, 'start-mac-linux.sh')], {
      env: { ...process.env, BRIDGE_PORT: String(SH_PORT), BRIDGE_DATA_DIR: copyData },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let shOut = '';
    shProc.stdout.on('data', (d) => { shOut += d.toString('utf8'); });
    shProc.stderr.on('data', (d) => { shOut += d.toString('utf8'); });
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      const onData = () => { if (shOut.includes('Listening:')) { clearTimeout(timer); resolve(true); } };
      shProc.stdout.on('data', onData);
      shProc.stderr.on('data', onData);
      shProc.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    check('start-mac-linux.sh: bridge starts (Listening:)', started === true, shOut.slice(-300));
    if (started) {
      const h = await fetch(`http://127.0.0.1:${SH_PORT}/health`).then((r) => r.json()).catch(() => ({}));
      check('start-mac-linux.sh bridge: /health ok, manifest version',
        h.ok === true && h.version === MANIFEST_VERSION, JSON.stringify(h).slice(0, 120));
    }
    try { process.kill(-shProc.pid, 'SIGTERM'); } catch (_) { try { shProc.kill('SIGTERM'); } catch (_) {} }
    await waitExit(shProc);
    shProc = null;
  }

  /* ==================== 7. README covers the .bat failure ==================== */
  console.log('\n[7] README — .bat failure troubleshooting paragraph');
  {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const [name, re] of [
      ['mentions start-windows.bat', /start-windows\.bat/i],
      ['mentions start-windows.ps1', /start-windows\.ps1/i],
      ['mentions extracting the ZIP first', /giải nén/i],
      ['mentions installing Node.js', /Node\.js 18/i],
      ['mentions SmartScreen', /SmartScreen/i],
      ['mentions Unblock', /Unblock/i],
      ['mentions manual cmd run', /node bridge-server\.js/i],
      ['mentions bridge-doctor', /bridge-doctor/i],
      ['mentions bridge-start.log', /bridge-start\.log/i],
      ['has a dedicated .bat section', /Không mở được start-windows\.bat/i],
    ]) {
      check(`README: ${name}`, re.test(readme), readme.slice(0, 200));
    }
  }

  /* ==================== 8. setup-env scripts (v3.5.1) ==================== */
  console.log('\n[8] setup-env.bat + setup-env.sh — .env one-time setup');
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'setup-env.bat'));
    const text = checkBatchBytes(buf, 'setup-env.bat');
    for (const [name, re] of [
      ['writes bridge/.env', /\.env/],
      ['asks for the GitHub PAT', /GITHUB_PAT=/],
      ['asks for OAuth Client ID + Secret', /GITHUB_OAUTH_CLIENT_ID=/ && /GITHUB_OAUTH_CLIENT_SECRET=/],
      ['asks for DEFAULT_REPO_PATH', /DEFAULT_REPO_PATH=/],
      ['generates a stable BRIDGE_TOKEN', /BRIDGE_TOKEN=/],
      ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
    ]) {
      check(`setup-env.bat: ${name}`, re.test(text));
    }
    batchChecks(text, 'setup-env.bat');
  }
  {
    const buf = fs.readFileSync(path.join(ROOT, 'bridge', 'setup-env.sh'));
    const text = checkShBytes(buf, 'setup-env.sh');
    for (const [name, re] of [
      ['writes bridge/.env', /\.env/],
      ['asks for the GitHub PAT', /GITHUB_PAT=/],
      ['asks for OAuth Client ID + Secret', /GITHUB_OAUTH_CLIENT_ID=/ && /GITHUB_OAUTH_CLIENT_SECRET=/],
      ['writes the file with chmod 600', /chmod 600/],
      ['generates a BRIDGE_TOKEN', /BRIDGE_TOKEN=/],
    ]) {
      check(`setup-env.sh: ${name}`, re.test(text));
    }
    check('setup-env.sh: executable bit set', (fs.statSync(path.join(ROOT, 'bridge', 'setup-env.sh')).mode & 0o111) !== 0);
  }

  /* ==================== 9. register/unregister native host (v3.7.0) ==================== */
  console.log('\n[9] register-native-host.bat + unregister-native-host.bat — native host 1 lan (v3.7.0)');
  {
    // HONEST LIMIT (same as [0]/[1]): .bat files are verified by BYTES +
    // STRUCTURE only — cmd.exe cannot run on Linux, and the registry
    // write + manifest generation have never run on real Windows here.
    // If workstream 1 has not landed register-native-host.bat yet, this
    // section reports it as missing instead of faking a pass.
    const regPath = path.join(ROOT, 'bridge', 'register-native-host.bat');
    if (!fs.existsSync(regPath)) {
      check('register-native-host.bat: exists (cho workstream 1 — host + script chua co)', false,
        'bridge/register-native-host.bat chua ton tai; chay lai sau khi workstream 1 tao file');
    } else {
      const buf = fs.readFileSync(regPath);
      const text = checkBatchBytes(buf, 'register-native-host.bat');
      for (const [name, re] of [
        ['closes the setlocal scope (endlocal)', /^\s*endlocal\b/im],
        ['writes the Chrome NativeMessagingHosts registry key (literal or %HOST_NAME%)',
          /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\(%HOST_NAME%|com\.pixijs\.github\.bridge)/],
        ['defines HOST_NAME=com.pixijs.github.bridge',
          /set\s+"HOST_NAME=com\.pixijs\.github\.bridge"/],
        ['uses reg add (HKCU, no admin needed)', /reg\s+add\s+"?HKCU\\/i],
        ['generates the native host manifest (native-host-manifest.json)', /native-host-manifest\.json/],
        ['manifest points at the host (native-host.js)', /native-host\.js/],
        ['manifest names the host com.pixijs.github.bridge', /com\.pixijs\.github\.bridge/],
        ['asks for the extension id (placeholder, never a hardcoded real id)', /EXTENSION_ID|chrome-extension:\/\//i],
        ['manifest allows the extension origin (allowed_origins)', /allowed_origins/],
        ['version string matches manifest (v' + MANIFEST_VERSION + ')', new RegExp('v' + MANIFEST_VERSION.replace(/\./g, '\\.'))],
      ]) {
        check(`register-native-host.bat: ${name}`, re.test(text));
      }
      // batchChecks only fits a script with exactly one setlocal whose
      // terminal exits close the scope (see batchChecks above). A
      // register script that never opens a scope gets the endlocal
      // regex check above instead of a parser failure.
      const setlocalCount = (text.match(/^\s*setlocal\b/gim) || []).length;
      if (setlocalCount === 1) batchChecks(text, 'register-native-host.bat');
      else check('register-native-host.bat: exactly one setlocal (or none + plain endlocal)', setlocalCount === 0, `found ${setlocalCount}`);
    }
    const unregPath = path.join(ROOT, 'bridge', 'unregister-native-host.bat');
    if (!fs.existsSync(unregPath)) {
      console.log('  NOTE  unregister-native-host.bat: chua co — bo qua (chi kiem tra neu file ton tai)');
    } else {
      const buf = fs.readFileSync(unregPath);
      const text = checkBatchBytes(buf, 'unregister-native-host.bat');
      for (const [name, re] of [
        ['closes the setlocal scope (endlocal)', /^\s*endlocal\b/im],
        ['deletes the Chrome NativeMessagingHosts registry key (literal or %HOST_NAME%)',
          /reg\s+delete\s+"?HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\(%HOST_NAME%|com\.pixijs\.github\.bridge)/i],
        ['defines HOST_NAME=com.pixijs.github.bridge',
          /set\s+"HOST_NAME=com\.pixijs\.github\.bridge"/],
      ]) {
        check(`unregister-native-host.bat: ${name}`, re.test(text));
      }
      check('unregister-native-host.bat: no bare reg delete of HKCU (only the host key)',
        !/reg\s+delete\s+"?HKCU\\Software\\Google\\Chrome"?\s*$/im.test(text));
      const setlocalCount = (text.match(/^\s*setlocal\b/gim) || []).length;
      if (setlocalCount === 1) batchChecks(text, 'unregister-native-host.bat');
      else check('unregister-native-host.bat: exactly one setlocal (or none + plain endlocal)', setlocalCount === 0, `found ${setlocalCount}`);
    }
  }

  cleanup(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('bat-test crashed:', err);
  process.exit(1);
});
