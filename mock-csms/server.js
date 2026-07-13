/**
 * Minimal multi-version CSMS for local testing of Rey.
 *
 * Speaks OCPP 1.6, 2.0.1 and 2.1 (whichever subprotocol the station negotiates)
 * and answers the core messages so you can drive Rey end-to-end without a real
 * CSMS running. It is NOT a real CSMS — it accepts every station and returns
 * Accepted for everything. Point Rey at a real CSMS (CitrineOS, SteVe, or your
 * own) for the real thing.
 *
 * The three versions share most responses (BootNotification, Heartbeat and
 * StatusNotification answer identically), and differ where the message sets
 * diverge: 1.6 carries a session with StartTransaction / MeterValues /
 * StopTransaction and authorises a bare idTag, while 2.0.1 / 2.1 use the
 * TransactionEvent lifecycle and an idToken object.
 */
import { RPCServer, createRPCError } from 'ocpp-rpc';
import { createPKI, signLeaf } from '../src/certs.js';

export async function startMockCSMS(port = 9000) {
  const server = new RPCServer({
    protocols: ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'],
    strictMode: false,
  });

  // A throwaway 3-tier PKI (Root → Sub-CA 1 → Sub-CA 2) so the demo CSMS can
  // sign charge-point CSRs into a realistic chain, for real.
  const pkiChain = createPKI();

  // Track connected stations by identity so the CSMS can push a message to a
  // specific one (used to kick off certificate provisioning in demo mode).
  const clients = new Map();

  // Accept every station. A real CSMS would check identity + password here.
  server.auth((accept, reject, handshake) => {
    accept({ identity: handshake.identity });
  });

  // 1.6 makes the CSMS assign the transactionId; hand out simple ascending ints.
  let nextTxId = 1000;

  server.on('client', (client) => {
    const proto = client.protocol || 'ocpp?';
    clients.set(client.identity, client);
    console.log(`[mock-csms] ${client.identity} connected (${proto})`);

    // ---- shared across all versions ------------------------------------
    client.handle('BootNotification', ({ params }) => {
      console.log(`[mock-csms] BootNotification from ${client.identity}`, params?.chargingStation || params?.chargePointModel || '');
      return { currentTime: new Date().toISOString(), interval: 30, status: 'Accepted' };
    });
    client.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    client.handle('StatusNotification', () => ({}));

    // Authorize differs by version: 1.6 sends { idTag }, 2.0.1/2.1 send
    // { idToken: {...} } and expect idTokenInfo back.
    client.handle('Authorize', ({ params }) => {
      if (params && 'idTag' in params) return { idTagInfo: { status: 'Accepted' } };
      return { idTokenInfo: { status: 'Accepted' } };
    });

    // ---- OCPP 1.6 session -----------------------------------------------
    client.handle('StartTransaction', () => ({
      transactionId: ++nextTxId,
      idTagInfo: { status: 'Accepted' },
    }));
    client.handle('MeterValues', () => ({}));
    client.handle('StopTransaction', () => ({ idTagInfo: { status: 'Accepted' } }));
    client.handle('DataTransfer', () => ({ status: 'Accepted' }));

    // ---- OCPP 2.0.1 / 2.1 session ---------------------------------------
    client.handle('TransactionEvent', ({ params }) => {
      if (params?.eventType === 'Ended') return { totalCost: 4.2 };
      return {};
    });
    client.handle('NotifyReport', () => ({}));
    client.handle('NotifyEvent', () => ({}));

    // ---- certificate management (OCPP 2.0.1 / 2.1) ----------------------
    // The station sends a CSR; we sign it under Sub-CA 2, then provision it the
    // way a real CSMS does: install the ROOT trust anchor first, then deliver
    // the signed leaf chain (leaf + Sub-CA 2 + Sub-CA 1), then read back what's
    // installed. (Provisioning is usually kicked off by the TriggerMessage the
    // relay sends in demo mode — see triggerCertProvisioning below.)
    client.handle('SignCertificate', ({ params }) => {
      console.log(`[mock-csms] SignCertificate (CSR) from ${client.identity}`);
      let signed;
      try {
        signed = signLeaf(params.csr, pkiChain);
      } catch (err) {
        console.log(`[mock-csms] CSR rejected: ${err.message}`);
        return { status: 'Rejected' };
      }
      setTimeout(async () => {
        try {
          await client.call('InstallCertificate', { certificateType: 'V2GRootCertificate', certificate: pkiChain.rootPem });
          await client.call('CertificateSigned', { certificateChain: signed.chainPem, certificateType: 'ChargingStationCertificate' });
          const ids = await client.call('GetInstalledCertificateIds', {});
          console.log(`[mock-csms] ${client.identity} now reports ${ids?.certificateHashDataChain?.length || 0} installed cert(s)`);
        } catch (err) {
          console.log(`[mock-csms] cert delivery failed: ${err.message}`);
        }
      }, 100);
      return { status: 'Accepted' };
    });

    // Anything else → CALLERROR NotImplemented (like a real minimal CSMS).
    client.handle(({ method }) => {
      throw createRPCError('NotImplemented', `${method} is not implemented by the mock CSMS`);
    });

    client.on('close', () => { clients.delete(client.identity); console.log(`[mock-csms] ${client.identity} disconnected`); });
  });

  // The relay calls this (demo mode) to make the CSMS kick off certificate
  // provisioning on a station: it sends a TriggerMessage asking the station to
  // sign a new charge-point certificate, which starts the SignCertificate flow.
  server.triggerCertProvisioning = (identity) => {
    const client = clients.get(identity);
    if (!client) return false;
    client.call('TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' }).catch(() => {});
    return true;
  };

  await server.listen(port);
  console.log(`[mock-csms] OCPP 1.6 / 2.0.1 / 2.1 CSMS listening on ws://localhost:${port}`);
  return server;
}

// Run directly:  node mock-csms/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  startMockCSMS(process.env.PORT || 9000);
}
