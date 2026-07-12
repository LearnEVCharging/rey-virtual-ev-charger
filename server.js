/**
 * Rey relay — serves the browser UI and bridges each browser session to a real
 * CSMS over OCPP 2.0.1.
 *
 *   [ browser UI ] --ws--> [ this relay ] --wss/ws (ocpp2.0.1)--> [ CSMS ]
 *
 * The relay exists because a browser WebSocket can't set the Authorization
 * header (OCPP Basic auth) or present a client cert (mTLS) — the relay holds the
 * real OCPP socket and does that. Each browser connection gets its own isolated
 * VirtualCharger, so many users can run at once (the CSMS just sees N stations).
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import { VirtualCharger } from './src/charger.js';
import { startMockCSMS } from './mock-csms/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

// A built-in OCPP 2.0.1 CSMS runs inside this process on a loopback-only port,
// so visitors can explore a full session with no backend of their own ("demo"
// mode). It is never exposed publicly — only this relay, on localhost, dials it.
const MOCK_PORT = process.env.MOCK_PORT || 9000;
const DEMO_ENDPOINT = `ws://127.0.0.1:${MOCK_PORT}`;
try {
  await startMockCSMS(MOCK_PORT);
} catch (err) {
  console.warn(`[Rey] built-in demo CSMS not started (${err.message}) — demo mode may be unavailable`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- static file server -------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/') path = '/index.html';
  const filePath = normalize(join(PUBLIC, path));
  if (!filePath.startsWith(PUBLIC) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end('Error');
  }
});

// ---- guardrails ---------------------------------------------------------
// The relay opens outbound sockets to a user-supplied URL, so restrict what it
// will dial: wss:// anywhere, or ws:// only to localhost (for the mock CSMS).
function endpointAllowed(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol === 'wss:') return true;
  if (u.protocol === 'ws:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return false;
}

// ---- browser <-> relay bridge -------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (browser) => {
  let charger = null;

  const send = (msg) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(msg));
  };

  browser.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    try {
      if (msg.type === 'connect') {
        if (charger) await charger.disconnect().catch(() => {});
        // Demo mode → the built-in CSMS (fixed, trusted). Otherwise the user's
        // own CSMS, subject to the guardrail.
        const endpoint = msg.demo ? DEMO_ENDPOINT : msg.endpoint;
        if (!msg.demo && !endpointAllowed(endpoint)) {
          send({ type: 'error', message: 'Endpoint not allowed. Use wss:// (any) or ws://localhost.' });
          return;
        }
        charger = new VirtualCharger({
          endpoint,
          identity: msg.identity || `CS-${Math.floor(Math.random() * 1e6)}`,
          password: msg.demo ? undefined : (msg.password || undefined),
          model: msg.model || 'Rey-1',
          onLog: (entry) => send({ type: 'log', entry }),
          onState: (state) => send({ type: 'state', state }),
        });
        await charger.connect();
        send({ type: 'connected', identity: charger.identity, demo: !!msg.demo });
        return;
      }

      if (!charger) {
        send({ type: 'error', message: 'Not connected to a CSMS yet.' });
        return;
      }

      switch (msg.action) {
        case 'boot': await charger.boot(msg.reason || 'PowerUp'); break;
        case 'plugIn': await charger.plugIn(); break;
        case 'authorize': await charger.authorize(msg.idToken || '045A2B3C4D5E80', msg.tokenType || 'ISO14443'); break;
        case 'start': await charger.startTransaction(msg.idToken || '045A2B3C4D5E80'); break;
        case 'meter': await charger.sendMeterUpdate(); break;
        case 'stop': await charger.stopTransaction(); break;
        case 'unplug': await charger.unplug(); break;
        case 'status': await charger.setStatus(msg.status || 'Available'); break;
        case 'disconnect':
          await charger.disconnect();
          charger = null;
          send({ type: 'disconnected' });
          break;
        default:
          send({ type: 'error', message: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      send({ type: 'error', message: String(err?.message || err) });
    }
  });

  browser.on('close', async () => {
    if (charger) await charger.disconnect().catch(() => {});
    charger = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Rey] relay + UI on http://localhost:${PORT}`);
  console.log(`[Rey] built-in demo CSMS on ${DEMO_ENDPOINT} — "Explore" mode uses it, no setup needed`);
});
