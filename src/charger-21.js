/**
 * VirtualCharger21 — a virtual OCPP 2.1 charge point.
 *
 * OCPP 2.1 is additive on 2.0.1: the same core message set (BootNotification,
 * StatusNotification, Authorize, the TransactionEvent lifecycle, Get/SetVariables,
 * GetBaseReport) carried over the `ocpp2.1` WebSocket subprotocol. The 2.1-only
 * features (bidirectional / V2X, DER control, battery-swap, enhanced ISO 15118-20
 * plug-and-charge) layer on top of that base and aren't needed to demonstrate a
 * live session — so VirtualCharger21 reuses the 2.0.1 station machine verbatim
 * and only swaps the negotiated subprotocol. That's exactly how a real charger
 * that speaks both would start: same frames, newer subprotocol.
 */
import { VirtualCharger } from './charger.js';

export class VirtualCharger21 extends VirtualCharger {
  constructor(opts = {}) {
    super({ ...opts, protocol: 'ocpp2.1' });
  }
}
