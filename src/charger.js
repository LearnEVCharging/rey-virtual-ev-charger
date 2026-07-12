/**
 * VirtualCharger — a virtual OCPP 2.0.1 charge point (the OCPP *client*).
 *
 * Wraps an ocpp-rpc RPCClient with a station state machine: boot, heartbeat,
 * connector status, authorize, and the full TransactionEvent lifecycle, plus
 * handlers for the CSMS-initiated calls (RequestStart/Stop, Reset, Trigger,
 * Get/SetVariables, ChangeAvailability, GetBaseReport).
 *
 * Every OCPP-J frame in and out is surfaced through onLog(), and every state
 * change through onState() — that's what the browser UI (SAL) renders live.
 *
 * This is the station side only. It connects to a CSMS that already exists
 * (a mock for local dev, or a real one like CitrineOS). It does NOT need a CPMS.
 */
import { RPCClient, createRPCError } from 'ocpp-rpc';

const FRAME_NAME = { 2: 'CALL', 3: 'CALLRESULT', 4: 'CALLERROR' };

export class VirtualCharger {
  constructor({
    endpoint,
    identity,
    password,
    model = 'SAL-1',
    vendor = 'Learn EV Charging',
    onLog = () => {},
    onState = () => {},
  }) {
    this.endpoint = endpoint;
    this.identity = identity;
    this.model = model;
    this.vendor = vendor;
    this.onLog = onLog;
    this.onState = onState;

    this.state = {
      connection: 'disconnected',
      connectorStatus: 'Available',
      chargingState: 'Idle',
      transactionId: null,
      seqNo: 0,
      meterWh: 0,
      powerW: 0,
      heartbeatInterval: 300,
      idToken: null,
    };

    // A tiny slice of a Device Model so Get/SetVariables do something real.
    this.variables = {
      'SampledDataCtrlr/TxUpdatedInterval': '30',
      'OCPPCommCtrlr/HeartbeatInterval': '300',
      'AuthCtrlr/AuthorizeRemoteStart': 'true',
      'DeviceDataCtrlr/BytesPerMessageGetReport': '0',
    };

    this._hbTimer = null;
    this._meterTimer = null;
    this._pending = new Map(); // msgId -> action, to annotate CALLRESULT/CALLERROR
    this._txCounter = 0;

    const opts = { endpoint, identity, protocols: ['ocpp2.0.1'] };
    if (password) opts.password = password; // HTTP Basic auth (security profile 1/2)
    this.client = new RPCClient(opts);
    this._wire();
  }

  // ---- logging ------------------------------------------------------------
  _log(entry) {
    this.onLog({ t: Date.now(), ...entry });
  }

  _frame(raw, outbound) {
    let arr = null;
    try {
      arr = JSON.parse(raw);
    } catch {
      /* non-JSON */
    }
    const type = Array.isArray(arr) ? arr[0] : null;
    let action = null;
    const id = Array.isArray(arr) ? arr[1] : null;
    if (type === 2) {
      action = arr[2];
      if (id) this._pending.set(id, action);
    } else if ((type === 3 || type === 4) && id && this._pending.has(id)) {
      action = this._pending.get(id); // correlate reply to its request
      this._pending.delete(id);
    }
    this._log({
      kind: 'frame',
      dir: outbound ? 'out' : 'in',
      frameType: FRAME_NAME[type] || 'RAW',
      type,
      action,
      id,
      raw,
    });
  }

  _note(text) {
    this._log({ kind: 'note', text });
  }

  _setState(patch) {
    Object.assign(this.state, patch);
    this.onState({ ...this.state });
  }

  // ---- wiring -------------------------------------------------------------
  _wire() {
    const c = this.client;
    c.on('message', ({ message, outbound }) => this._frame(message, outbound));
    c.on('connecting', () => this._setState({ connection: 'connecting' }));
    c.on('open', () => {
      this._setState({ connection: 'connected' });
      this._note(`Connected to ${this.endpoint} as ${this.identity} (subprotocol ocpp2.0.1)`);
    });
    c.on('close', () => {
      this._stopTimers();
      this._setState({ connection: 'disconnected' });
      this._note('Connection closed');
    });

    // CSMS-initiated calls (station acts as server for these).
    c.handle('RequestStartTransaction', ({ params }) => {
      const idToken = params?.idToken?.idToken || 'REMOTE';
      this._note(`CSMS requested a remote start (remoteStartId ${params?.remoteStartId})`);
      // Kick off the transaction right after we accept.
      setTimeout(() => this.startTransaction(idToken, 'RemoteStart', params?.remoteStartId), 50);
      return { status: 'Accepted' };
    });
    c.handle('RequestStopTransaction', ({ params }) => {
      this._note(`CSMS requested a remote stop (transactionId ${params?.transactionId})`);
      setTimeout(() => this.stopTransaction('Remote'), 50);
      return { status: 'Accepted' };
    });
    c.handle('Reset', ({ params }) => {
      this._note(`CSMS requested a ${params?.type || ''} Reset`);
      return { status: 'Accepted' };
    });
    c.handle('TriggerMessage', ({ params }) => {
      const req = params?.requestedMessage;
      this._note(`CSMS triggered ${req}`);
      setTimeout(() => this._handleTrigger(req), 50);
      return { status: 'Accepted' };
    });
    c.handle('ChangeAvailability', ({ params }) => {
      const op = params?.operationalStatus;
      if (op === 'Inoperative') setTimeout(() => this.setStatus('Unavailable'), 50);
      if (op === 'Operative') setTimeout(() => this.setStatus('Available'), 50);
      return { status: 'Accepted' };
    });
    c.handle('GetVariables', ({ params }) => {
      const results = (params?.getVariableData || []).map((d) => {
        const key = `${d.component?.name}/${d.variable?.name}`;
        const value = this.variables[key];
        return {
          attributeStatus: value !== undefined ? 'Accepted' : 'UnknownVariable',
          attributeValue: value,
          component: d.component,
          variable: d.variable,
        };
      });
      return { getVariableResult: results };
    });
    c.handle('SetVariables', ({ params }) => {
      const results = (params?.setVariableData || []).map((d) => {
        const key = `${d.component?.name}/${d.variable?.name}`;
        this.variables[key] = d.attributeValue;
        return { attributeStatus: 'Accepted', component: d.component, variable: d.variable };
      });
      return { setVariableResult: results };
    });
    c.handle('GetBaseReport', ({ params }) => {
      setTimeout(() => this._sendBaseReport(params?.requestId), 50);
      return { status: 'Accepted' };
    });

    // Anything we don't implement → CALLERROR NotSupported (recognized but unsupported).
    c.handle(({ method }) => {
      throw createRPCError('NotSupported', `${method} is not supported by SAL`);
    });
  }

  // ---- connection ---------------------------------------------------------
  async connect() {
    await this.client.connect();
  }

  async disconnect() {
    this._stopTimers();
    await this.client.close();
  }

  _stopTimers() {
    if (this._hbTimer) clearInterval(this._hbTimer);
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._hbTimer = null;
    this._meterTimer = null;
  }

  // ---- boot + heartbeat ---------------------------------------------------
  async boot(reason = 'PowerUp') {
    const res = await this.client.call('BootNotification', {
      reason,
      chargingStation: { model: this.model, vendorName: this.vendor },
    });
    if (res?.interval) this._setState({ heartbeatInterval: res.interval });
    if (res?.status === 'Accepted') {
      this._startHeartbeat(res.interval || 300);
      await this.setStatus('Available');
    } else {
      this._note(`Boot ${res?.status} — the CSMS did not accept the station`);
    }
    return res;
  }

  _startHeartbeat(interval) {
    if (this._hbTimer) clearInterval(this._hbTimer);
    // Cap at a friendly cadence for the demo so the log shows life.
    const ms = Math.min(Math.max(interval, 5), 300) * 1000;
    this._hbTimer = setInterval(() => {
      this.client.call('Heartbeat', {}).catch(() => {});
    }, ms);
  }

  // ---- connector status ---------------------------------------------------
  async setStatus(status) {
    this._setState({ connectorStatus: status });
    return this.client.call('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: status,
      evseId: 1,
      connectorId: 1,
    });
  }

  // ---- driver actions -----------------------------------------------------
  async plugIn() {
    this._setState({ chargingState: 'EVConnected' });
    return this.setStatus('Occupied');
  }

  async authorize(idToken, type = 'ISO14443') {
    this._setState({ idToken });
    return this.client.call('Authorize', { idToken: { idToken, type } });
  }

  async startTransaction(idToken = 'LOCAL01', triggerReason = 'Authorized', remoteStartId) {
    if (this.state.transactionId) return; // already running
    const transactionId = `T-${Date.now()}-${++this._txCounter}`;
    this._setState({ transactionId, seqNo: 0, chargingState: 'EVConnected', meterWh: this.state.meterWh });
    const transactionInfo = { transactionId, chargingState: 'EVConnected' };
    if (remoteStartId != null) transactionInfo.remoteStartId = remoteStartId;
    await this.client.call('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason,
      seqNo: this.state.seqNo,
      transactionInfo,
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken, type: 'ISO14443' },
      meterValue: [this._meterValue()],
    });
    this._setState({ seqNo: this.state.seqNo + 1, chargingState: 'Charging', powerW: 11000 });
    this._startMeterLoop();
  }

  _startMeterLoop() {
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._meterTimer = setInterval(() => this.sendMeterUpdate().catch(() => {}), 10000);
  }

  async sendMeterUpdate() {
    if (!this.state.transactionId) return;
    // Accumulate ~11 kW over the elapsed interval (10s).
    this._setState({ meterWh: Math.round(this.state.meterWh + (this.state.powerW * 10) / 3600) });
    await this.client.call('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: this.state.seqNo,
      transactionInfo: { transactionId: this.state.transactionId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [this._meterValue()],
    });
    this._setState({ seqNo: this.state.seqNo + 1 });
  }

  async stopTransaction(stoppedReason = 'EVDisconnected') {
    if (!this.state.transactionId) return;
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._meterTimer = null;
    const transactionId = this.state.transactionId;
    await this.client.call('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: stoppedReason === 'Remote' ? 'RemoteStop' : 'EVDeparted',
      seqNo: this.state.seqNo,
      transactionInfo: { transactionId, chargingState: 'Idle', stoppedReason },
      evse: { id: 1, connectorId: 1 },
      meterValue: [this._meterValue()],
    });
    this._setState({
      transactionId: null,
      chargingState: 'Idle',
      powerW: 0,
      seqNo: this.state.seqNo + 1,
    });
  }

  async unplug() {
    this._setState({ chargingState: 'Idle' });
    return this.setStatus('Available');
  }

  _meterValue() {
    return {
      timestamp: new Date().toISOString(),
      sampledValue: [
        { value: this.state.meterWh, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } },
        { value: this.state.powerW, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
      ],
    };
  }

  // ---- responses to CSMS triggers ----------------------------------------
  async _handleTrigger(requested) {
    switch (requested) {
      case 'Heartbeat':
        return this.client.call('Heartbeat', {}).catch(() => {});
      case 'StatusNotification':
        return this.setStatus(this.state.connectorStatus).catch(() => {});
      case 'BootNotification':
        return this.boot('Triggered').catch(() => {});
      default:
        this._note(`No trigger handler for ${requested}`);
    }
  }

  async _sendBaseReport(requestId) {
    const reportData = Object.entries(this.variables).map(([key, value]) => {
      const [comp, variable] = key.split('/');
      return {
        component: { name: comp },
        variable: { name: variable },
        variableAttribute: [{ value }],
      };
    });
    await this.client
      .call('NotifyReport', {
        requestId: requestId ?? 0,
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        reportData,
      })
      .catch(() => {});
  }
}
