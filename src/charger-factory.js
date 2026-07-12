/**
 * createCharger — pick the right virtual charge point for an OCPP version.
 *
 * Rey speaks three OCPP versions, and each is a genuinely different station:
 *   1.6   → VirtualCharger16  (StartTransaction / MeterValues / StopTransaction,
 *                              flat configuration, idTag auth)
 *   2.0.1 → VirtualCharger    (TransactionEvent lifecycle, device model, idToken)
 *   2.1   → VirtualCharger21  (2.0.1 messages over the ocpp2.1 subprotocol)
 *
 * The relay and the browser UI drive all three through the same method surface
 * (boot / plugIn / authorize / startTransaction / sendMeterUpdate /
 * stopTransaction / unplug), so the only version-specific choice is which class
 * to instantiate — this factory.
 */
import { VirtualCharger } from './charger.js';
import { VirtualCharger16 } from './charger-16.js';
import { VirtualCharger21 } from './charger-21.js';

export const OCPP_VERSIONS = ['1.6', '2.0.1', '2.1'];

// Map a UI version string to its WebSocket subprotocol (handy for the mock CSMS).
export const SUBPROTOCOL = {
  '1.6': 'ocpp1.6',
  '2.0.1': 'ocpp2.0.1',
  '2.1': 'ocpp2.1',
};

export function createCharger(version, opts = {}) {
  switch (version) {
    case '1.6':
      return new VirtualCharger16(opts);
    case '2.1':
      return new VirtualCharger21(opts);
    case '2.0.1':
    default:
      return new VirtualCharger(opts);
  }
}
