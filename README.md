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
npm run mock-csms     # terminal 1 — a minimal OCPP 2.0.1 CSMS on ws://localhost:9000
npm start             # terminal 2 — the relay + UI on http://localhost:8080
```

Open http://localhost:8080, click **Connect** (defaults to the mock), then drive
the station: Boot → Plug in → Tap RFID → Start → Stop → Unplug, and watch every
frame in the live log. Point the endpoint at a real `wss://` CSMS to test yours.

```bash
npm run smoke         # headless end-to-end check against the mock
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
- **Hosted demo CSMS** (CitrineOS) so anyone can try it with zero setup.
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
