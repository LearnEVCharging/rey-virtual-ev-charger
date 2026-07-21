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
import { createCharger, OCPP_VERSIONS } from './src/charger-factory.js';
import { startMockCSMS } from './mock-csms/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

// A built-in OCPP 2.0.1 CSMS runs inside this process on a loopback-only port,
// so visitors can explore a full session with no backend of their own ("demo"
// mode). It is never exposed publicly — only this relay, on localhost, dials it.
const MOCK_PORT = process.env.MOCK_PORT || 9000;
const DEMO_ENDPOINT = `ws://127.0.0.1:${MOCK_PORT}`;
let mockCsms = null;
try {
  mockCsms = await startMockCSMS(MOCK_PORT);
} catch (err) {
  console.warn(`[Rey] built-in demo CSMS not started (${err.message}) — demo mode may be unavailable`);
}

// Unique station id per demo session so the demo CSMS can address one station
// (e.g. to trigger certificate provisioning) without colliding across visitors.
let demoSeq = 0;

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

// Clamp/whitelist the browser-supplied station nameplate so a user can't inject
// absurd values into what the station reports. Unset fields fall back to the
// charger's own defaults.
function sanitizeProfile(msg) {
  const out = {};
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : undefined);
  const serialNumber = str(msg.serialNumber, 40); if (serialNumber) out.serialNumber = serialNumber;
  const firmwareVersion = str(msg.firmwareVersion, 40); if (firmwareVersion) out.firmwareVersion = firmwareVersion;
  const connectorType = str(msg.connectorType, 20); if (connectorType) out.connectorType = connectorType;
  const connectorCount = num(msg.connectorCount, 1, 8); if (connectorCount != null) out.connectorCount = Math.round(connectorCount);
  const maxPowerKw = num(msg.maxPowerKw, 1, 1000); if (maxPowerKw != null) out.maxPowerKw = maxPowerKw;
  const maxVoltageV = num(msg.maxVoltageV, 1, 2000); if (maxVoltageV != null) out.maxVoltageV = maxVoltageV;
  const maxCurrentA = num(msg.maxCurrentA, 1, 1000); if (maxCurrentA != null) out.maxCurrentA = maxCurrentA;
  const countryCode = str(msg.countryCode, 4); if (countryCode) out.countryCode = countryCode.toUpperCase();
  const operatorId = str(msg.operatorId, 8); if (operatorId) out.operatorId = operatorId;
  const evseId = str(msg.evseId, 40); if (evseId) out.evseId = evseId;
  const chargingStationId = str(msg.chargingStationId, 48); if (chargingStationId) out.chargingStationId = chargingStationId;
  const tariff = str(msg.tariff, 60); if (tariff) out.tariff = tariff;
  const defaultEmaid = str(msg.defaultEmaid, 40); if (defaultEmaid) out.defaultEmaid = defaultEmaid;
  return out;
}

// ---- browser <-> relay bridge -------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (browser) => {
  let charger = null;
  let isDemo = false;

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
        const version = OCPP_VERSIONS.includes(msg.version) ? msg.version : '2.0.1';
        isDemo = !!msg.demo;
        const identity = isDemo ? `Rey-DEMO-${++demoSeq}` : (msg.identity || `CS-${Math.floor(Math.random() * 1e6)}`);
        charger = createCharger(version, {
          endpoint,
          identity,
          password: msg.demo ? undefined : (msg.password || undefined),
          model: msg.model || 'Rey-1',
          ...sanitizeProfile(msg),
          onLog: (entry) => send({ type: 'log', entry }),
          onState: (state) => send({ type: 'state', state }),
          onVars: (vars) => send({ type: 'vars', vars }),
          onCerts: (certs) => send({ type: 'certs', certs }),
          onLocalList: (list) => send({ type: 'localList', list }),
          onIdentity: (station) => send({ type: 'identity', station }),
        });
        await charger.connect();
        send({ type: 'connected', identity: charger.identity, demo: !!msg.demo, version, station: charger.identityInfo?.() });
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
        case 'setVariable': charger.setLocalVariable(msg.key, msg.value); break;
        case 'requestCertificate':
          if (typeof charger.requestCertificate !== 'function') {
            send({ type: 'error', message: 'Certificate management is an OCPP 2.0.1 / 2.1 feature.' });
          } else if (isDemo && mockCsms?.triggerCertProvisioning) {
            // Demo: let the CSMS drive it — it sends a TriggerMessage, the station
            // responds with SignCertificate, then the CSMS installs the root and
            // delivers the signed leaf chain. The full, realistic sequence.
            if (!mockCsms.triggerCertProvisioning(charger.identity)) await charger.requestCertificate();
          } else {
            // Own CSMS: the station initiates SignCertificate; the real CSMS responds.
            await charger.requestCertificate();
          }
          break;
        case 'authorizePnC':
          if (typeof charger.authorizePnC === 'function') await charger.authorizePnC(msg.eMAID || 'DE-REY-C12345-3');
          else send({ type: 'error', message: 'Plug & Charge requires OCPP 2.0.1 or 2.1.' });
          break;
        case 'appStart':
          if (isDemo && mockCsms?.triggerRemoteStart) {
            mockCsms.triggerRemoteStart(charger.identity, msg.idToken || 'APP-START-01');
          } else {
            send({ type: 'error', message: 'App/remote start is driven by the CSMS — in "Connect my CSMS" mode, trigger it from your backend.' });
          }
          break;
        case 'addLocalAuth': charger.addLocalAuth?.(msg.token); break;
        case 'removeLocalAuth': charger.removeLocalAuth?.(msg.token); break;
        case 'setAuthMode': charger.authMode = msg.mode || 'rfid'; break;
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
