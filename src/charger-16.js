/**
 * VirtualCharger16 — a virtual OCPP 1.6 (1.6-J) charge point.
 *
 * OCPP 1.6 is a different message set from 2.0.1: the session is carried by
 * StartTransaction / MeterValues / StopTransaction (not TransactionEvent), the
 * CSMS *assigns* the integer transactionId in the StartTransaction response,
 * auth uses a bare idTag string (not an idToken object), configuration is flat
 * key/value (GetConfiguration/ChangeConfiguration), and connector statuses are
 * Available / Preparing / Charging / SuspendedEV(SE) / Finishing / Reserved /
 * Unavailable / Faulted.
 *
 * Same shape as src/charger.js (the 2.0.1 charger) so the relay + UI drive both
 * identically — each version just builds its own messages. Kept self-contained
 * on purpose: reading this file shows a full 1.6 charger end to end.
 */
import { RPCClient, createRPCError } from 'ocpp-rpc';

const FRAME_NAME = { 2: 'CALL', 3: 'CALLRESULT', 4: 'CALLERROR' };

export class VirtualCharger16 {
  constructor({
    endpoint,
    identity,
    password,
    model = 'Rey-1',
    vendor = 'Learn EV Charging',
    onLog = () => {},
    onState = () => {},
    onVars = () => {},
    onCerts = () => {},
  }) {
    this.endpoint = endpoint;
    this.identity = identity;
    this.model = model;
    this.vendor = vendor;
    this.protocol = 'ocpp1.6';
    this.onLog = onLog;
    this.onState = onState;
    this.onVars = onVars;
    this.onCerts = onCerts;

    this.state = {
      connection: 'disconnected',
      connectorStatus: 'Available',
      chargingState: 'Idle', // derived, for the UI only — not an OCPP 1.6 field
      transactionId: null,
      seqNo: 0, // not used by 1.6; kept so the UI state shape matches
      meterWh: 0,
      powerW: 0,
      heartbeatInterval: 300,
      idToken: null,
    };

    // 1.6 configuration is a flat key/value map (GetConfiguration/ChangeConfiguration).
    this.config = {
      HeartbeatInterval: '300',
      MeterValueSampleInterval: '60',
      ConnectorPhaseRotation: 'RST',
      AuthorizeRemoteTxRequests: 'true',
      NumberOfConnectors: '1',
    };

    this._hbTimer = null;
    this._meterTimer = null;
    this._pending = new Map();

    const opts = { endpoint, identity, protocols: ['ocpp1.6'] };
    if (password) opts.password = password;
    this.client = new RPCClient(opts);
    this._wire();
  }

  // ---- logging (identical to the 2.0.1 charger) ---------------------------
  _log(entry) { this.onLog({ t: Date.now(), ...entry }); }
  _note(text) { this._log({ kind: 'note', text }); }
  _setState(patch) { Object.assign(this.state, patch); this.onState({ ...this.state }); }

  _frame(raw, outbound) {
    let arr = null;
    try { arr = JSON.parse(raw); } catch { /* non-JSON */ }
    const type = Array.isArray(arr) ? arr[0] : null;
    let action = null;
    const id = Array.isArray(arr) ? arr[1] : null;
    if (type === 2) {
      action = arr[2];
      if (id) this._pending.set(id, action);
    } else if ((type === 3 || type === 4) && id && this._pending.has(id)) {
      action = this._pending.get(id);
      this._pending.delete(id);
    }
    this._log({ kind: 'frame', dir: outbound ? 'out' : 'in', frameType: FRAME_NAME[type] || 'RAW', type, action, id, raw });
  }

  // ---- wiring -------------------------------------------------------------
  _wire() {
    const c = this.client;
    c.on('message', ({ message, outbound }) => this._frame(message, outbound));
    c.on('connecting', () => this._setState({ connection: 'connecting' }));
    c.on('open', () => {
      this._setState({ connection: 'connected' });
      this._note(`Connected to ${this.endpoint} as ${this.identity} (subprotocol ocpp1.6)`);
      this._pushVars();
      this.onCerts([]); // OCPP 1.6 has no certificate-management messages
    });
    c.on('close', () => {
      this._stopTimers();
      this._setState({ connection: 'disconnected' });
      this._note('Connection closed');
    });

    // CSMS-initiated calls.
    c.handle('RemoteStartTransaction', ({ params }) => {
      const idTag = params?.idTag || 'REMOTE';
      this._note(`CSMS requested a remote start (idTag ${idTag})`);
      setTimeout(() => this.startTransaction(idTag), 50);
      return { status: 'Accepted' };
    });
    c.handle('RemoteStopTransaction', ({ params }) => {
      this._note(`CSMS requested a remote stop (transactionId ${params?.transactionId})`);
      setTimeout(() => this.stopTransaction('Remote'), 50);
      return { status: 'Accepted' };
    });
    c.handle('Reset', ({ params }) => {
      this._note(`CSMS requested a ${params?.type || ''} Reset`);
      return { status: 'Accepted' };
    });
    c.handle('ChangeAvailability', ({ params }) => {
      if (params?.type === 'Inoperative') setTimeout(() => this.setStatus('Unavailable'), 50);
      if (params?.type === 'Operative') setTimeout(() => this.setStatus('Available'), 50);
      return { status: 'Accepted' };
    });
    c.handle('ChangeConfiguration', ({ params }) => {
      if (params?.key) { this.config[params.key] = params.value; this._pushVars(); }
      return { status: 'Accepted' };
    });
    c.handle('GetConfiguration', ({ params }) => {
      const keys = params?.key && params.key.length ? params.key : Object.keys(this.config);
      const configurationKey = [];
      const unknownKey = [];
      for (const k of keys) {
        if (k in this.config) configurationKey.push({ key: k, readonly: false, value: this.config[k] });
        else unknownKey.push(k);
      }
      return { configurationKey, unknownKey };
    });
    c.handle('TriggerMessage', ({ params }) => {
      this._note(`CSMS triggered ${params?.requestedMessage}`);
      setTimeout(() => this._handleTrigger(params?.requestedMessage), 50);
      return { status: 'Accepted' };
    });
    c.handle('UnlockConnector', () => ({ status: 'Unlocked' }));
    c.handle('DataTransfer', () => ({ status: 'Accepted' }));

    c.handle(({ method }) => {
      throw createRPCError('NotImplemented', `${method} is not supported by Rey (OCPP 1.6)`);
    });
  }

  // ---- connection ---------------------------------------------------------
  async connect() { await this.client.connect(); }
  async disconnect() { this._stopTimers(); await this.client.close(); }
  _stopTimers() {
    if (this._hbTimer) clearInterval(this._hbTimer);
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._hbTimer = null;
    this._meterTimer = null;
  }

  // ---- boot + heartbeat ---------------------------------------------------
  async boot(reason = 'PowerUp') {
    const res = await this.client.call('BootNotification', {
      chargePointVendor: this.vendor,
      chargePointModel: this.model,
    });
    if (res?.interval) this._setState({ heartbeatInterval: res.interval });
    if (res?.status === 'Accepted') {
      this._startHeartbeat(res.interval || 300);
      await this.setStatus('Available');
    } else {
      this._note(`Boot ${res?.status} — the CSMS did not accept the charge point`);
    }
    return res;
  }

  _startHeartbeat(interval) {
    if (this._hbTimer) clearInterval(this._hbTimer);
    const ms = Math.min(Math.max(interval, 5), 300) * 1000;
    this._hbTimer = setInterval(() => { this.client.call('Heartbeat', {}).catch(() => {}); }, ms);
  }

  // ---- connector status ---------------------------------------------------
  async setStatus(status) {
    this._setState({ connectorStatus: status });
    return this.client.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status,
      timestamp: new Date().toISOString(),
    });
  }

  // ---- driver actions -----------------------------------------------------
  async plugIn() {
    this._setState({ chargingState: 'EVConnected' });
    return this.setStatus('Preparing');
  }

  async authorize(idTag) {
    this._setState({ idToken: idTag });
    return this.client.call('Authorize', { idTag });
  }

  async startTransaction(idTag = 'LOCAL01') {
    if (this.state.transactionId) return; // already running
    // In 1.6 the CSMS assigns the transactionId in the response.
    const res = await this.client.call('StartTransaction', {
      connectorId: 1,
      idTag,
      meterStart: this.state.meterWh,
      timestamp: new Date().toISOString(),
    });
    this._setState({
      transactionId: res?.transactionId ?? null,
      chargingState: 'Charging',
      powerW: 11000,
    });
    await this.setStatus('Charging');
    this._startMeterLoop();
  }

  _startMeterLoop() {
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._meterTimer = setInterval(() => this.sendMeterUpdate().catch(() => {}), 10000);
  }

  async sendMeterUpdate() {
    if (this.state.transactionId == null) return;
    this._setState({ meterWh: Math.round(this.state.meterWh + (this.state.powerW * 10) / 3600) });
    await this.client.call('MeterValues', {
      connectorId: 1,
      transactionId: this.state.transactionId,
      meterValue: [this._meterValue()],
    });
  }

  async stopTransaction(reason = 'Local') {
    if (this.state.transactionId == null) return;
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._meterTimer = null;
    await this.client.call('StopTransaction', {
      transactionId: this.state.transactionId,
      idTag: this.state.idToken || 'LOCAL01',
      meterStop: this.state.meterWh,
      timestamp: new Date().toISOString(),
      reason,
    });
    this._setState({ transactionId: null, chargingState: 'Idle', powerW: 0 });
    await this.setStatus('Finishing');
  }

  async unplug() {
    this._setState({ chargingState: 'Idle' });
    return this.setStatus('Available');
  }

  // OCPP 1.6 SampledValue.value is a string; measurand + unit are flat fields.
  _meterValue() {
    return {
      timestamp: new Date().toISOString(),
      sampledValue: [
        { value: String(this.state.meterWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        { value: String(this.state.powerW), measurand: 'Power.Active.Import', unit: 'W' },
      ],
    };
  }

  async _handleTrigger(requested) {
    switch (requested) {
      case 'Heartbeat': return this.client.call('Heartbeat', {}).catch(() => {});
      case 'StatusNotification': return this.setStatus(this.state.connectorStatus).catch(() => {});
      case 'BootNotification': return this.boot('Triggered').catch(() => {});
      default: this._note(`No trigger handler for ${requested}`);
    }
  }

  // ---- configuration (the 1.6 equivalent of a device model) --------------
  // 1.6 configuration is flat key/value, so there is no component — the UI
  // renders these the same way it renders 2.0.1 device-model variables.
  _varsList() {
    return Object.entries(this.config).map(([key, value]) => ({ key, component: '', variable: key, value }));
  }

  _pushVars() {
    this.onVars(this._varsList());
  }

  setLocalVariable(key, value) {
    if (!(key in this.config)) return;
    this.config[key] = value;
    this._pushVars();
    this._note(`Set ${key} = ${value} locally`);
  }
}
