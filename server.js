/**
 * SAL relay — serves the browser UI and bridges each browser session to a real
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

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
        if (!endpointAllowed(msg.endpoint)) {
          send({ type: 'error', message: 'Endpoint not allowed. Use wss:// or ws://localhost.' });
          return;
        }
        charger = new VirtualCharger({
          endpoint: msg.endpoint,
          identity: msg.identity || `CS-${Math.floor(Math.random() * 1e6)}`,
          password: msg.password || undefined,
          model: msg.model || 'SAL-1',
          onLog: (entry) => send({ type: 'log', entry }),
          onState: (state) => send({ type: 'state', state }),
        });
        await charger.connect();
        send({ type: 'connected', identity: charger.identity });
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
  console.log(`[SAL] relay + UI on http://localhost:${PORT}`);
  console.log(`[SAL] start the mock CSMS with:  npm run mock-csms   (ws://localhost:9000)`);
});
