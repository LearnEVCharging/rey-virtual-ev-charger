# Rey — Virtual OCPP Charge Point Simulator

Rey is a **browser-based virtual charge point** — an OCPP charge-point simulator
you drive in a browser. Point it at a **real CSMS** to test your backend with no
hardware, or explore a full OCPP session against a **built-in demo CSMS** with
zero setup. Every OCPP-J frame is shown live.

**OCPP 2.0.1** today; **1.6 and 2.1** are on the roadmap (Rey is the one charger,
across versions).

```
[ browser UI ] ── ws ──▶ [ Rey relay ] ── wss/ws (ocpp2.0.1) ──▶ [ CSMS ]
```

The relay exists because a browser `WebSocket` can't set the `Authorization`
header (OCPP Basic auth) or present a client certificate (mTLS) — the relay
holds the real OCPP socket and does that. Each browser session gets its own
isolated charger, so many people can use it at once (the CSMS just sees N
distinct stations).

> Rey does **not** require you to build a CSMS. It's the OCPP *client*; it
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
  password) and Rey connects to it — the relay presents the auth your browser can't.

```bash
npm run smoke         # headless end-to-end check against the mock
npm run mock-csms     # (optional) run the mock CSMS standalone on ws://localhost:9000
```

## What works today

- Real OCPP-J WebSocket to a CSMS (subprotocol `ocpp2.0.1`), Basic-auth ready.
- Built-in demo CSMS (in-process, loopback-only) so anyone can try it with no setup.
- Boot + heartbeat, connector status, Authorize, the full `TransactionEvent`
  lifecycle (Started / Updated / Ended) with meter values.
- Responds to CSMS-initiated calls: `RequestStartTransaction`,
  `RequestStopTransaction`, `Reset`, `TriggerMessage`, `ChangeAvailability`,
  `GetVariables`, `SetVariables`, `GetBaseReport → NotifyReport`.
- A live frame log with direction, CALL/CALLRESULT/CALLERROR badges, correlated
  message ids, and expandable JSON.
- Relay guardrails: `wss://` (any) or `ws://localhost` only.

## Roadmap

- **OCPP 1.6** support — the largest install base (do next).
- **OCPP 2.1** support — the newest version.
- **Device Model panel** — browse/edit components & variables live.
- **Certificate store** — security profiles 1/2/3, mTLS, ISO 15118 Plug & Charge.
- **Smart charging** — `SetChargingProfile` with a power-limit chart.
- Faults, multi-EVSE, reservations, scenario replay.
- A headless npm package to wire Rey into CSMS CI suites.

## Layout

```
server.js          relay: serves the UI + bridges browser ⇄ CSMS + built-in demo CSMS
src/charger.js     the virtual charge point state machine (OCPP 2.0.1)
mock-csms/         a minimal OCPP 2.0.1 CSMS (the built-in demo backend)
public/            the browser UI (station console + live log)
test/smoke.js      end-to-end check
```

A free teaching + testing tool from [Learn EV Charging](https://learnevcharging.com).
Not a product — a tool. Contributions welcome via pull request.
