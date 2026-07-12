/**
 * Minimal OCPP 2.0.1 CSMS for local testing of Rey.
 *
 * This is NOT a real CSMS — it accepts any station and answers the core
 * messages so you can drive Rey end-to-end without CitrineOS running. Point Rey
 * at a real CSMS (CitrineOS, or your own) for the real thing.
 */
import { RPCServer, createRPCError } from 'ocpp-rpc';

export async function startMockCSMS(port = 9000) {
  const server = new RPCServer({ protocols: ['ocpp2.0.1'], strictMode: false });

  // Accept every station. A real CSMS would check identity + password here.
  server.auth((accept, reject, handshake) => {
    accept({ identity: handshake.identity });
  });

  server.on('client', (client) => {
    console.log(`[mock-csms] ${client.identity} connected`);

    client.handle('BootNotification', ({ params }) => {
      console.log(`[mock-csms] BootNotification from ${client.identity}`, params?.chargingStation || '');
      return { currentTime: new Date().toISOString(), interval: 30, status: 'Accepted' };
    });
    client.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    client.handle('StatusNotification', () => ({}));
    client.handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' } }));
    client.handle('TransactionEvent', ({ params }) => {
      if (params?.eventType === 'Ended') return { totalCost: 4.2 };
      return {};
    });
    client.handle('NotifyReport', () => ({}));
    client.handle('NotifyEvent', () => ({}));

    // Anything else → CALLERROR NotImplemented (like a real minimal CSMS).
    client.handle(({ method }) => {
      throw createRPCError('NotImplemented', `${method} is not implemented by the mock CSMS`);
    });

    client.on('close', () => console.log(`[mock-csms] ${client.identity} disconnected`));
  });

  await server.listen(port);
  console.log(`[mock-csms] OCPP 2.0.1 CSMS listening on ws://localhost:${port}`);
  return server;
}

// Run directly:  node mock-csms/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  startMockCSMS(process.env.PORT || 9000);
}
