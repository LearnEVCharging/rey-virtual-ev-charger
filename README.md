# Rey — Virtual OCPP Charge Point Simulator

Rey is a **browser-based virtual charge point** — an OCPP charge-point simulator
you drive in a browser. Point it at a **real CSMS** to test your backend with no
hardware, or explore a full OCPP session against a **built-in demo CSMS** with
zero setup. Every OCPP-J frame is shown live.

Speaks **OCPP 1.6, 2.0.1 and 2.1** — pick the version in the UI before you
connect. Rey is the one charger across versions, so each speaks its own real
message set (StartTransaction / MeterValues / StopTransaction in 1.6, the
TransactionEvent lifecycle in 2.0.1 / 2.1).

```
[ browser UI ] ── ws ──▶ [ Rey relay ] ── wss/ws (ocpp1.6 / 2.0.1 / 2.1) ──▶ [ CSMS ]
```

The relay exists because a browser `WebSocket` can't set the `Authorization`
header (OCPP Basic auth) or present a client certificate (mTLS) — the relay
holds the real OCPP socket and does that. Each browser session gets its own
isolated charger, so many people can use it at once (the CSMS just sees N
distinct stations).

> Rey does **not** require you to build a CSMS. It's the OCPP *client*; it
> connects to a CSMS that already exists — your own, or an open-source one like
> [CitrineOS](https://citrineos.github.io/) (OCPP 2.0.1) or
> [SteVe](https://github.com/steve-community/steve) (OCPP 1.6).

## Run it locally

```bash
npm install
npm start             # relay + UI on http://localhost:8080 (a demo CSMS runs in-process)
```

Open http://localhost:8080. Pick an OCPP version (1.6 / 2.0.1 / 2.1), then choose
a mode:

- **🎬 Explore — demo CSMS** (default): a built-in CSMS runs inside the server and
  answers whichever version you picked, so you just click **Connect** and drive
  the station — no backend of your own needed. Boot → Plug in → Tap RFID → Start
  → Stop → Unplug, and watch every frame in the live log.
- **🔌 Connect my CSMS**: enter your CSMS's `wss://` URL (+ station id / Basic-auth
  password) and Rey connects to it — the relay presents the auth your browser can't.

```bash
npm run smoke         # headless end-to-end check across 1.6 / 2.0.1 / 2.1
npm run mock-csms     # (optional) run the mock CSMS standalone on ws://localhost:9000
```

## What works today

- Real OCPP-J WebSocket to a CSMS on **all three versions** (subprotocols
  `ocpp1.6`, `ocpp2.0.1`, `ocpp2.1`), Basic-auth ready.
- Built-in demo CSMS (in-process, loopback-only) that speaks all three, so anyone
  can try it with no setup.
- **OCPP 1.6**: Boot + heartbeat, `StatusNotification`, `Authorize` (idTag), the
  `StartTransaction` → `MeterValues` → `StopTransaction` session (CSMS-assigned
  transactionId), flat `GetConfiguration` / `ChangeConfiguration`. Responds to
  `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`,
  `ChangeAvailability`, `TriggerMessage`, `UnlockConnector`, `DataTransfer`.
- **OCPP 2.0.1 / 2.1**: Boot + heartbeat, connector status, `Authorize` (idToken),
  the full `TransactionEvent` lifecycle (Started / Updated / Ended) with meter
  values. Responds to `RequestStartTransaction`, `RequestStopTransaction`,
  `Reset`, `TriggerMessage`, `ChangeAvailability`, `GetVariables`, `SetVariables`,
  `GetBaseReport → NotifyReport`.
- A live frame log with direction, CALL/CALLRESULT/CALLERROR badges, correlated
  message ids, and expandable JSON.
- Relay guardrails: `wss://` (any) or `ws://localhost` only.

## Roadmap

- **Device Model panel** — browse/edit components & variables live.
- **Certificate store** — security profiles 1/2/3, mTLS, ISO 15118 Plug & Charge.
- **Smart charging** — `SetChargingProfile` with a power-limit chart.
- **OCPP 2.1 extras** — bidirectional / V2X, DER control, battery swap.
- Faults, multi-EVSE, reservations, scenario replay.
- A headless npm package to wire Rey into CSMS CI suites.

## Layout

```
server.js               relay: serves the UI + bridges browser ⇄ CSMS + built-in demo CSMS
src/charger-factory.js  createCharger(version, opts) — picks the right station
src/charger.js          the virtual charge point state machine (OCPP 2.0.1)
src/charger-16.js       the OCPP 1.6 station (StartTransaction / MeterValues / StopTransaction)
src/charger-21.js       the OCPP 2.1 station (2.0.1 messages over the ocpp2.1 subprotocol)
mock-csms/              a minimal multi-version CSMS (the built-in demo backend)
public/                 the browser UI (station console + live log)
test/smoke.js           end-to-end check across all three versions
```

A free teaching + testing tool from [Learn EV Charging](https://learnevcharging.com).
Not a product — a tool. Contributions welcome via pull request.
