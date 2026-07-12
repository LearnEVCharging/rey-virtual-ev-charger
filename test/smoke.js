/**
 * Smoke test: prove the full loop end-to-end against the mock CSMS.
 * Boots, plugs in, authorizes, runs a transaction, meters, stops, unplugs —
 * and confirms every OCPP-J frame is captured for the live log.
 *
 * Run:  npm run smoke
 */
import { startMockCSMS } from '../mock-csms/server.js';
import { VirtualCharger } from '../src/charger.js';

const PORT = 9099;
const server = await startMockCSMS(PORT);

const frames = [];
const charger = new VirtualCharger({
  endpoint: `ws://localhost:${PORT}`,
  identity: 'CS-SMOKE',
  onLog: (e) => {
    frames.push(e);
    if (e.kind === 'frame') {
      const arrow = e.dir === 'out' ? '▲ CS→CSMS' : '▼ CSMS→CS';
      console.log(`  ${arrow}  ${e.frameType.padEnd(10)} ${(e.action || '').padEnd(20)} ${e.id || ''}`);
    } else if (e.kind === 'note') {
      console.log(`  · ${e.text}`);
    }
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('\n1) connect + boot');
  await charger.connect();
  const boot = await charger.boot();
  console.log(`   boot status: ${boot.status}, interval ${boot.interval}`);

  console.log('2) plug in + authorize');
  await charger.plugIn();
  await charger.authorize('045A2B3C4D5E80');

  console.log('3) start transaction + meter');
  await charger.startTransaction('045A2B3C4D5E80');
  await charger.sendMeterUpdate();

  console.log('4) stop + unplug');
  await charger.stopTransaction();
  await charger.unplug();

  await wait(200);

  const callFrames = frames.filter((f) => f.kind === 'frame' && f.type === 2);
  const resultFrames = frames.filter((f) => f.kind === 'frame' && f.type === 3);
  const actions = [...new Set(callFrames.map((f) => f.action))];
  console.log(`\nCaptured ${frames.filter((f) => f.kind === 'frame').length} frames total.`);
  console.log(`  CALLs: ${callFrames.length}, CALLRESULTs: ${resultFrames.length}`);
  console.log(`  Actions seen: ${actions.join(', ')}`);

  const expected = ['BootNotification', 'StatusNotification', 'Authorize', 'TransactionEvent'];
  const missing = expected.filter((a) => !actions.includes(a));
  const resultsCorrelated = resultFrames.filter((f) => f.action).length;

  let ok = missing.length === 0 && callFrames.length === resultFrames.length && resultsCorrelated === resultFrames.length;
  console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'} — expected actions present: ${missing.length === 0}; ` +
    `every CALL got a CALLRESULT: ${callFrames.length === resultFrames.length}; ` +
    `all results correlated to an action: ${resultsCorrelated === resultFrames.length}`);

  await charger.disconnect();
  await server.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('\n✗ ERROR:', err);
  try { await charger.disconnect(); } catch {}
  try { await server.close(); } catch {}
  process.exit(1);
}
