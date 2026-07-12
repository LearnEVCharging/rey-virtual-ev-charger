# SAL — Virtual OCPP 2.0.1 Charge Point

SAL is a **virtual charge point** you drive from the browser. It mocks the
physical charging station and speaks **OCPP 2.0.1** to a **real CSMS** — so you
can test a Charging Station Management System, or just watch the protocol, with
no hardware.

```
[ browser UI ] ── ws ──▶ [ SAL relay ] ── wss/ws (ocpp2.0.1) ──▶ [ CSMS ]
```

The relay exists because a browser `WebSocket` can't set the `Authorization`
header (OCPP Basic auth) or present a client certificate (mTLS) — the relay
holds the real OCPP socket and does that. Each browser session gets its own
isolated charger, so many people can use it at once (the CSMS just sees N
distinct stations).

> SAL does **not** require you to build a CSMS. It's the OCPP *client*; it
> connects to a CSMS that already exists — your own, or an open-source one like
> [CitrineOS](https://citrineos.github.io/) (a free OCPP 2.0.1 CSMS).

## Run it locally

```bash
npm install
npm start             # relay + UI on http://localhost:8080 (a demo CSMS runs in-process)
```

Open http://localhost:8080. Two modes:

- **🎬 Explore — demo CSMS** (default): a built-in OCPP 2.0.1 CSMS runs inside the
  server, so you just click **Connect** and drive the station — no backend of
  your own needed. Boot → Plug in → Tap RFID → Start → Stop → Unplug, and watch
  every frame in the live log.
- **🔌 Connect my CSMS**: enter your CSMS's `wss://` URL (+ station id / Basic-auth
  password) and SAL connects to it — the relay presents the auth your browser can't.

```bash
npm run smoke         # headless end-to-end check against the mock
npm run mock-csms     # (optional) run the mock CSMS standalone on ws://localhost:9000
```

## What works today (walking skeleton)

- Real OCPP-J WebSocket to a CSMS (subprotocol `ocpp2.0.1`), Basic-auth ready.
- Boot + heartbeat, connector status, Authorize, the full `TransactionEvent`
  lifecycle (Started / Updated / Ended) with meter values.
- Responds to CSMS-initiated calls: `RequestStartTransaction`,
  `RequestStopTransaction`, `Reset`, `TriggerMessage`, `ChangeAvailability`,
  `GetVariables`, `SetVariables`, `GetBaseReport → NotifyReport`.
- A live frame log with direction, CALL/CALLRESULT/CALLERROR badges, correlated
  message ids, and expandable JSON.
- Relay guardrails: `wss://` (any) or `ws://localhost` only.

## Roadmap

- **Device Model panel** — browse/edit components & variables; watch the CSMS
  read and reconfigure the station live.
- **Certificate store** — security profiles 1/2/3, mTLS, ISO 15118 Plug & Charge
  cert flow (`InstallCertificate`, `SignCertificate`, `Get15118EVCertificate`).
- **Smart charging** — `SetChargingProfile` with a power-limit chart.
- **Faults, multi-EVSE, reservations, scenario replay.**
- **Demo CSMS** — ✅ shipped (a built-in mock runs in-process so anyone can try
  it with zero setup); could upgrade to a full open-source CSMS (CitrineOS) for
  more realistic behaviour.
- **MED** — a sibling that speaks OCPP 1.6 (if SAL proves out).

## Layout

```
server.js          relay: serves the UI + bridges browser ⇄ CSMS
src/charger.js     the virtual charge point state machine (OCPP 2.0.1)
mock-csms/         a minimal OCPP 2.0.1 CSMS for local dev
public/            the browser UI (station console + live log)
test/smoke.js      end-to-end check
```

A free teaching + testing tool, not a product.
