'use strict';
/*
 * Test helper (v3.1.0): Node 16.13 has no global fetch. The test suites
 * talk to the bridge with fetch(), so on Node < 18 this installs a small
 * built-in-only replacement. On Node 18+ it does nothing.
 *
 * Network failures reject with TypeError('fetch failed') + err.cause,
 * exactly like Node 18's undici fetch, so the "Failed to fetch"
 * translation tests behave the same on every Node version.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function makeHeaders(raw) {
  return {
    get(name) {
      const v = raw[String(name).toLowerCase()];
      return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v);
    },
    has(name) { return raw[String(name).toLowerCase()] !== undefined; },
    forEach(cb) { for (const k of Object.keys(raw)) cb(String(raw[k]), k); },
  };
}

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h) && typeof h.get === 'function') {
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return out; }
  return Object.assign(out, h);
}

function polyFetch(input, init = {}, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(String(input && input.url ? input.url : input)); } catch (e) {
      return reject(new TypeError('Failed to parse URL from ' + input));
    }
    const lib = target.protocol === 'https:' ? https : http;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(init.headers);
    let payload = null;
    if (init.body !== undefined && init.body !== null) {
      payload = Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body), 'utf8');
      headers['Content-Length'] = String(payload.length);
    }
    const req = lib.request(target, { method, headers }, (res) => {
      const status = res.statusCode || 0;
      if (init.redirect !== 'manual' && [301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        const nextInit = Object.assign({}, init);
        if (status === 303) { nextInit.method = 'GET'; delete nextInit.body; }
        return resolve(polyFetch(next, nextInit, redirectsLeft - 1));
      }
      let done = null;
      const readAll = () => done || (done = new Promise((ok, bad) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => ok(Buffer.concat(chunks)));
        res.on('error', bad);
      }));
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: res.statusMessage || '',
        url: target.toString(),
        headers: makeHeaders(res.headers),
        body: res,
        text: async () => (await readAll()).toString('utf8'),
        json: async () => JSON.parse((await readAll()).toString('utf8')),
        arrayBuffer: async () => { const b = await readAll(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        blob: async () => {
          const { Blob } = require('buffer');
          const b = await readAll();
          return new Blob([b], { type: res.headers['content-type'] || '' });
        },
      });
    });
    req.on('error', (cause) => {
      const err = new TypeError('fetch failed');
      err.cause = cause;
      reject(err);
    });
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error('aborted'));
      else init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        req.destroy(e);
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = polyFetch;
}
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => {
      const e = new Error('The operation timed out');
      e.name = 'TimeoutError';
      c.abort(e);
    }, ms).unref();
    return c.signal;
  };
}

module.exports = { polyFetch };
