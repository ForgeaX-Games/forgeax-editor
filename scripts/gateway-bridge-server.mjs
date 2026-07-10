#!/usr/bin/env node
// gateway-bridge-server.mjs — DEV-only relay between a CLI and the live editor page.
//
// WHY THIS EXISTS
// ---------------
// A browser page can only DIAL OUT (WebSocket/fetch); nothing outside can dial
// INTO it without the browser exposing a CDP debug port. The editor already
// mounts a DEV-only eval channel on `globalThis.__forgeaxEval`
// (edit-runtime ViewportComponent.tsx). What was missing is a way to feed that
// channel from a shell WITHOUT relaunching the browser under CDP.
//
// This relay is the meeting point both sides CAN reach:
//   • the editor page connects OUT to  ws://127.0.0.1:15295/bridge  (page dials the relay)
//   • the CLI POSTs code to            http://127.0.0.1:15295/eval  (shell dials the relay)
// The relay forwards {id, code} to the page, awaits {id, result}, and answers
// the CLI's still-open HTTP request with that JSON. One in-memory pending-map
// correlates request↔reply by id. No persistence, no new dependency (reuses the
// `ws` package the editor already vendors), 127.0.0.1-only, DEV-only.
//
// SECURITY: this grants "run arbitrary JS in the editor page" to anything that
// can POST to :15295. It is bound to loopback and is only started by the dev
// stack. Never run it against a production build / public interface.

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FORGEAX_BRIDGE_PORT ?? 15295);
const HOST = '127.0.0.1';

// The single page socket (last connection wins — one editor window at a time).
let pageSocket = null;
// id -> { resolve, timer }  correlating a CLI POST with the page's reply.
const pending = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Health / status probe — lets the CLI tell "relay down" from "page not connected".
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, pageConnected: !!pageSocket, pending: pending.size });
  }

  // CLI entrypoint: POST { code } → forward to page → reply with { ok, value|error }.
  if (req.method === 'POST' && url.pathname === '/eval') {
    if (!pageSocket || pageSocket.readyState !== pageSocket.OPEN) {
      // Structured, property-access discriminable (charter P3) — not a bare 500.
      return sendJson(res, 200, {
        ok: false,
        error: { code: 'PAGE_NOT_CONNECTED', hint: 'no editor page attached to the bridge; open/refresh the editor at :15290' },
      });
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      let code;
      try { code = JSON.parse(body).code; } catch { code = undefined; }
      if (typeof code !== 'string') {
        return sendJson(res, 200, { ok: false, error: { code: 'BAD_REQUEST', hint: 'POST body must be JSON {"code": "<js>"}' } });
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          sendJson(res, 200, { ok: false, error: { code: 'EVAL_TIMEOUT', hint: 'page did not answer within 30s (dead loop? refresh the window)' } });
        }
      }, 30_000);
      pending.set(id, { res, timer });
      try {
        pageSocket.send(JSON.stringify({ type: 'eval', id, code }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        sendJson(res, 200, { ok: false, error: { code: 'SEND_FAILED', hint: String(e?.message ?? e) } });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', hint: 'endpoints: GET /health, POST /eval' } });
});

// Page side: the editor bridge connects here. It sends back {type:'result', id, payload}.
const wss = new WebSocketServer({ server, path: '/bridge' });
wss.on('connection', (ws) => {
  pageSocket = ws;
  log('editor page connected');
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return; // already timed out
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    // msg.payload is the {ok, value|error} envelope the page produced.
    sendJson(entry.res, 200, msg.payload ?? { ok: false, error: { code: 'EMPTY_RESULT', hint: 'page returned no payload' } });
  });
  ws.on('close', () => {
    if (pageSocket === ws) pageSocket = null;
    log('editor page disconnected');
  });
  ws.on('error', () => { try { ws.close(); } catch { /* */ } });
});

server.listen(PORT, HOST, () => {
  log(`relay up on http://${HOST}:${PORT}  (POST /eval, GET /health, page WS /bridge)`);
});

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function log(m) { console.log(`[gateway-bridge] ${m}`); }
