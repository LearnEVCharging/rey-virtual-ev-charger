/**
 * Smoke test: prove the full loop end-to-end against the mock CSMS, for every
 * OCPP version Rey speaks (1.6, 2.0.1, 2.1).
 *
 * For each version it boots, plugs in, authorizes, runs a transaction, meters,
 * stops and unplugs — then confirms the version's expected actions all appeared
 * and every CALL got a correlated CALLRESULT.
 *
 * Run:  npm run smoke
 */
import { startMockCSMS } from '../mock-csms/server.js';
import { createCharger } from '../src/charger-factory.js';

const PORT = 9099;
const server = await startMockCSMS(PORT);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Which CALLs each version must produce for a complete drive-through.
const EXPECTED = {
  '1.6': ['BootNotification', 'StatusNotification', 'Authorize', 'StartTransaction', 'MeterValues', 'StopTransaction'],
  '2.0.1': ['BootNotification', 'StatusNotification', 'Authorize', 'TransactionEvent'],
  '2.1': ['BootNotification', 'StatusNotification', 'Authorize', 'TransactionEvent'],
};

async function runVersion(version) {
  console.log(`\n=== OCPP ${version} ===`);
  const frames = [];
  const charger = createCharger(version, {
    endpoint: `ws://localhost:${PORT}`,
    identity: `CS-SMOKE-${version}`,
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

  await charger.connect();
  const boot = await charger.boot();
  console.log(`  boot status: ${boot.status}, interval ${boot.interval}`);
  await charger.plugIn();
  await charger.authorize('045A2B3C4D5E80');
  await charger.startTransaction('045A2B3C4D5E80');
  await charger.sendMeterUpdate();
  await charger.stopTransaction();
  await charger.unplug();
  await wait(200);
  await charger.disconnect();

  const callFrames = frames.filter((f) => f.kind === 'frame' && f.type === 2);
  const resultFrames = frames.filter((f) => f.kind === 'frame' && f.type === 3);
  const actions = [...new Set(callFrames.map((f) => f.action))];
  const missing = EXPECTED[version].filter((a) => !actions.includes(a));
  const resultsCorrelated = resultFrames.filter((f) => f.action).length;

  const ok =
    boot.status === 'Accepted' &&
    missing.length === 0 &&
    callFrames.length === resultFrames.length &&
    resultsCorrelated === resultFrames.length;

  console.log(`  CALLs: ${callFrames.length}, CALLRESULTs: ${resultFrames.length}`);
  console.log(`  Actions seen: ${actions.join(', ')}`);
  if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`);
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}`);
  return ok;
}

// Certificate management + device model (OCPP 2.0.1).
async function runCertAndVars() {
  console.log('\n=== Certificate management + device model (2.0.1) ===');
  const frames = [];
  let certs = [];
  let vars = [];
  const charger = createCharger('2.0.1', {
    endpoint: `ws://localhost:${PORT}`,
    identity: 'CS-CERT',
    onLog: (e) => { if (e.kind === 'frame') frames.push(e.action); },
    onCerts: (c) => { certs = c; },
    onVars: (v) => { vars = v; },
  });
  await charger.connect();
  await charger.boot();

  // Device model: edit a variable locally and confirm it takes.
  const key = 'OCPPCommCtrlr/HeartbeatInterval';
  charger.setLocalVariable(key, '600');
  const edited = vars.find((v) => v.key === key)?.value === '600';

  // Certificate: CSMS-triggered provisioning — TriggerMessage → SignCertificate
  // → InstallCertificate(root) → CertificateSigned(leaf chain) → GetInstalledCertificateIds.
  server.triggerCertProvisioning('CS-CERT');
  await wait(900);

  const actions = new Set(frames);
  const has = (a) => actions.has(a);
  const tiers = certs.reduce((m, c) => ((m[c.tier] = (m[c.tier] || 0) + 1), m), {});
  const leaf = certs.find((c) => c.tier === 'leaf');
  const root = certs.find((c) => c.tier === 'root');

  const ok =
    edited &&
    has('TriggerMessage') && has('SignCertificate') && has('InstallCertificate') &&
    has('CertificateSigned') && has('GetInstalledCertificateIds') &&
    tiers.root === 1 && tiers.intermediate === 2 && tiers.leaf === 1 &&
    !!leaf?.fingerprint && !!root?.fingerprint;

  console.log(`  device model edit took: ${edited}`);
  console.log(`  flow: TriggerMessage=${has('TriggerMessage')} SignCertificate=${has('SignCertificate')} InstallCertificate=${has('InstallCertificate')} CertificateSigned=${has('CertificateSigned')} GetInstalledCertificateIds=${has('GetInstalledCertificateIds')}`);
  console.log(`  installed: ${certs.length} certs — tiers ${JSON.stringify(tiers)}${leaf ? ` (leaf ${leaf.subject} ← ${leaf.issuer})` : ''}`);
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}`);
  await charger.disconnect();
  return ok;
}

let allOk = true;
try {
  for (const version of ['1.6', '2.0.1', '2.1']) {
    const ok = await runVersion(version);
    allOk = allOk && ok;
  }
  allOk = (await runCertAndVars()) && allOk;
  console.log(`\n${allOk ? '✓ ALL CHECKS PASS' : '✗ SOME CHECKS FAILED'}`);
  await server.close();
  process.exit(allOk ? 0 : 1);
} catch (err) {
  console.error('\n✗ ERROR:', err);
  try { await server.close(); } catch {}
  process.exit(1);
}
