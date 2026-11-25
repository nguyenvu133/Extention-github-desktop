#!/usr/bin/env node
// bridge/native-host.js - Native Messaging host for PixiJS GitHub Bridge.
// v3.7.1 - Node 12+, NO dependencies (only built-in modules).
//
// Chrome extensions cannot run .bat files. The one-time-registered
// native host below is the only way the extension can start the bridge
// with one click: the extension talks to this host over stdio using the
// standard Native Messaging protocol (4-byte little-endian length
// prefix + UTF-8 JSON), and this host spawns the known launcher scripts
// and hands the bridge token back.
//
// SECURITY:
//  - This host ONLY ever spawns the two known launcher scripts that
//    live in this same bridge/ directory (start-windows.bat /
//    start-mac-linux.sh, setup-env.bat / setup-env.sh). It NEVER runs
//    an arbitrary command taken from a message.
//  - stdout is RESERVED for the protocol. All logging goes to stderr.
//  - The bridge token is NEVER printed or logged (not even partially).
//    Only its presence / length is ever reported in logs.
//  - Env overrides exist ONLY for tests:
//      NATIVE_HOST_LAUNCHER        absolute path to a replacement
//                                  bridge launcher (test stub)
//      NATIVE_HOST_SETUP_LAUNCHER  absolute path to a replacement
//                                  setup launcher (test stub)
//
// Usage (via the .bat wrapper / manifest, never directly):
//   node native-host.js
// Protocol: one JSON message per frame, one JSON reply per frame.
//   {"action":"start-bridge"} -> {"ok":true,"token":"...",
//                                  "bridgeUrl":"http://127.0.0.1:17321",
//                                  "alreadyRunning":false}
//   {"action":"setup-env"}    -> {"ok":true,"started":true}
//   {"action":"get-token"}    -> {"ok":true,"token":"...",
//                                  "bridgeUrl":"http://127.0.0.1:17321"}
//   {"action":"status"}       -> {"ok":true,"running":true,
//                                  "bridgeUrl":"http://127.0.0.1:17321",
//                                  "version":"3.5.1"}
//   anything else             -> {"ok":false,"error":"..."}
'use strict';

var fs = require('fs');
var http = require('http');
var path = require('path');
var childProcess = require('child_process');

var VERSION = '3.7.1';
var BRIDGE_DIR = __dirname;
var PORT = Number(process.env.BRIDGE_PORT || 17321) || 17321;
var HOST = '127.0.0.1';
var BRIDGE_URL = 'http://' + HOST + ':' + PORT;
var DATA_DIR = process.env.BRIDGE_DATA_DIR
  ? path.resolve(process.env.BRIDGE_DATA_DIR)
  : BRIDGE_DIR;
var TOKEN_FILE = path.join(DATA_DIR, '.bridge-token');
var HEALTH_TIMEOUT_MS = 15000; // max wait for /health after spawn
var HEALTH_POLL_MS = 500;
var HEALTH_CHECK_TIMEOUT_MS = 2000; // single /health probe timeout

function log() {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[native-host]');
  console.error.apply(console, args);
}

// ------------------------------------------------------------------
// Protocol: 4-byte little-endian length + UTF-8 JSON, over stdio.
// stdout is ONLY for framed replies. Everything else -> stderr.
// ------------------------------------------------------------------

var inBuffer = Buffer.alloc(0);

function sendMessage(obj) {
  try {
    var payload = Buffer.from(JSON.stringify(obj), 'utf8');
    var header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    process.stdout.write(Buffer.concat([header, payload]));
  } catch (err) {
    log('failed to write reply:', err.message);
  }
}

function sendError(error, extra) {
  var out = { ok: false, error: String(error) };
  if (extra) {
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  }
  sendMessage(out);
}

process.stdin.on('data', function (chunk) {
  inBuffer = Buffer.concat([inBuffer, chunk]);
  processFrames();
});

process.stdin.on('error', function (err) {
  log('stdin error:', err.message);
});

process.stdin.on('end', function () {
  // Chrome closes stdin when the extension goes away; exit quietly.
  process.exit(0);
});

function processFrames() {
  for (;;) {
    if (inBuffer.length < 4) return;
    var len = inBuffer.readUInt32LE(0);
    // Sanity cap: a control message is tiny. Refuse absurd frames
    // instead of buffering forever on a corrupt stream. A corrupt
    // length prefix cannot be resynced (no sync marker), so exit
    // CLEANLY with code 1 and a clear stderr log — not a crash, and
    // Chrome relaunches the host on the next connectNative. (Framed
    // invalid JSON is different: framing is intact, so handleFrame
    // answers an error and the host stays alive.)
    if (len > 1024 * 1024) {
      log('frame too large (' + len + ' bytes), dropping connection');
      process.exit(1);
    }
    if (inBuffer.length < 4 + len) return;
    var text = inBuffer.slice(4, 4 + len).toString('utf8');
    inBuffer = inBuffer.slice(4 + len);
    handleFrame(text);
  }
}

function handleFrame(text) {
  var msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    log('invalid JSON frame received');
    sendError('invalid-json');
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendError('invalid-message');
    return;
  }
  if (typeof msg.action !== 'string' || !msg.action) {
    sendError('missing-action');
    return;
  }
  dispatch(msg).catch(function (err) {
    // Never crash on a bad action: answer with an error instead.
    log('action "' + msg.action + '" failed:', err && err.message);
    sendError('internal-error');
  });
}

// ------------------------------------------------------------------
// Bridge helpers
// ------------------------------------------------------------------

function healthCheck(timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var req;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        try { req.destroy(); } catch (_) {}
        resolve(null);
      }
    }, timeoutMs || HEALTH_CHECK_TIMEOUT_MS);
    try {
      req = http.get(BRIDGE_URL + '/health', function (res) {
        var body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve({ ok: true });
          }
        });
      });
    } catch (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
      return;
    }
    req.on('error', function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function waitForHealth(timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    (function poll() {
      healthCheck(HEALTH_CHECK_TIMEOUT_MS).then(function (payload) {
        if (payload) { resolve(payload); return; }
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(poll, HEALTH_POLL_MS);
      });
    })();
  });
}

function readToken() {
  // Returns the bridge token string, or null when unreadable/missing.
  // The token itself is NEVER logged.
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    var token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token || /\s/.test(token)) return null;
    return token;
  } catch (_) {
    return null;
  }
}

// Resolve the launcher to spawn. Only the two known scripts in this
// directory are ever used, unless a test override (absolute path) is set.
function resolveLauncher(kind) {
  // kind: 'bridge' | 'setup'
  var isWin = process.platform === 'win32';
  var override = kind === 'bridge'
    ? process.env.NATIVE_HOST_LAUNCHER
    : process.env.NATIVE_HOST_SETUP_LAUNCHER;
  if (override) {
    var abs = path.resolve(override);
    if (!path.isAbsolute(abs)) {
      throw new Error('test-launcher-not-absolute');
    }
    if (!fs.existsSync(abs)) {
      throw new Error('launcher-not-found');
    }
    return abs;
  }
  var name;
  if (kind === 'bridge') {
    name = isWin ? 'start-windows.bat' : 'start-mac-linux.sh';
  } else {
    name = isWin ? 'setup-env.bat' : 'setup-env.sh';
  }
  var full = path.join(BRIDGE_DIR, name);
  if (!fs.existsSync(full)) {
    throw new Error('launcher-not-found');
  }
  return full;
}

// Spawn a launcher detached so it outlives this host process.
// On Windows the launcher gets its own console window (via `start`)
// because it is interactive (prints the token, waits at `pause`).
// On Mac/Linux it runs headless in the background.
function spawnLauncher(launcherPath) {
  var child;
  if (process.platform === 'win32') {
    if (/\.bat$/i.test(launcherPath) || /\.cmd$/i.test(launcherPath)) {
      child = childProcess.spawn('cmd.exe',
        ['/c', 'start', '"PixiJS GitHub Bridge"', '/D', BRIDGE_DIR,
         launcherPath],
        { detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      child = childProcess.spawn(launcherPath, [],
        { detached: true, stdio: 'ignore', windowsHide: true });
    }
  } else {
    var runner = /\.sh$/i.test(launcherPath) ? 'sh' : launcherPath;
    var args = /\.sh$/i.test(launcherPath) ? [launcherPath] : [];
    child = childProcess.spawn(runner, args,
      { detached: true, stdio: 'ignore', cwd: BRIDGE_DIR });
  }
  child.on('error', function (err) {
    log('failed to spawn launcher:', err.message);
  });
  try { child.unref(); } catch (_) {}
  return child;
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

function actionStatus() {
  return healthCheck(HEALTH_CHECK_TIMEOUT_MS).then(function (payload) {
    if (payload) {
      var out = { ok: true, running: true, bridgeUrl: BRIDGE_URL };
      if (payload.version) out.version = payload.version;
      return out;
    }
    return { ok: true, running: false, bridgeUrl: BRIDGE_URL };
  });
}

function actionGetToken() {
  return healthCheck(HEALTH_CHECK_TIMEOUT_MS).then(function (payload) {
    if (!payload) {
      return { ok: false, error: 'bridge-not-running',
               bridgeUrl: BRIDGE_URL };
    }
    var token = readToken();
    if (!token) {
      return { ok: false, error: 'token-not-found',
               bridgeUrl: BRIDGE_URL };
    }
    return { ok: true, token: token, bridgeUrl: BRIDGE_URL };
  });
}

function actionStartBridge() {
  return healthCheck(HEALTH_CHECK_TIMEOUT_MS).then(function (payload) {
    if (payload) {
      // Bridge is already up: reuse it, do NOT spawn another one.
      var token = readToken();
      if (!token) {
        return { ok: false, error: 'token-not-found',
                 bridgeUrl: BRIDGE_URL };
      }
      return { ok: true, token: token, bridgeUrl: BRIDGE_URL,
               alreadyRunning: true };
    }
    var launcher;
    try {
      launcher = resolveLauncher('bridge');
    } catch (err) {
      return { ok: false, error: err.message, bridgeUrl: BRIDGE_URL };
    }
    log('bridge not running, spawning launcher');
    try {
      spawnLauncher(launcher);
    } catch (err) {
      return { ok: false, error: 'spawn-failed', bridgeUrl: BRIDGE_URL };
    }
    return waitForHealth(HEALTH_TIMEOUT_MS).then(function (up) {
      if (!up) {
        return { ok: false, error: 'bridge-start-timeout',
                 bridgeUrl: BRIDGE_URL };
      }
      var freshToken = readToken();
      if (!freshToken) {
        return { ok: false, error: 'token-not-found',
                 bridgeUrl: BRIDGE_URL };
      }
      return { ok: true, token: freshToken, bridgeUrl: BRIDGE_URL,
               alreadyRunning: false };
    });
  });
}

function actionSetupEnv() {
  var launcher;
  try {
    launcher = resolveLauncher('setup');
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message });
  }
  try {
    spawnLauncher(launcher);
  } catch (err) {
    return Promise.resolve({ ok: false, error: 'spawn-failed' });
  }
  // setup-env is interactive (it asks for PAT / OAuth values), so the
  // host only starts it and returns at once; the user finishes the
  // prompts in the launcher window (Windows) or terminal (Mac/Linux).
  var note = process.platform === 'win32'
    ? 'setup window opened - answer the prompts there, then start the bridge'
    : 'setup-env.sh started in background - if it needs input, run it in a terminal instead: sh bridge/setup-env.sh';
  return Promise.resolve({ ok: true, started: true, note: note });
}

function dispatch(msg) {
  switch (msg.action) {
    case 'start-bridge': return actionStartBridge().then(sendMessage);
    case 'setup-env': return actionSetupEnv().then(sendMessage);
    case 'get-token': return actionGetToken().then(sendMessage);
    case 'status': return actionStatus().then(sendMessage);
    default:
      sendError('unknown-action: ' + msg.action);
      return Promise.resolve();
  }
}

// Never die on an unexpected error: log it and keep serving.
process.on('uncaughtException', function (err) {
  log('uncaught exception:', err && err.message);
});
process.on('unhandledRejection', function (err) {
  log('unhandled rejection:', err && err && err.message);
});

log('native host v' + VERSION + ' ready (bridge: ' + BRIDGE_URL + ')');
