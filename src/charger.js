/**
 * VirtualCharger — a virtual OCPP 2.0.1 charge point (the OCPP *client*).
 *
 * Wraps an ocpp-rpc RPCClient with a station state machine: boot, heartbeat,
 * connector status, authorize, and the full TransactionEvent lifecycle, plus
 * handlers for the CSMS-initiated calls (RequestStart/Stop, Reset, Trigger,
 * Get/SetVariables, ChangeAvailability, GetBaseReport).
 *
 * Every OCPP-J frame in and out is surfaced through onLog(), and every state
 * change through onState() — that's what the browser UI (Rey) renders live.
 *
 * This is the station side only. It connects to a CSMS that already exists
 * (a mock for local dev, or a real one like CitrineOS). It does NOT need a CPMS.
 */
import { RPCClient, createRPCError } from 'ocpp-rpc';
import { generateKeyAndCsr, splitPemChain, summarizeCert, certHashData } from './certs.js';

const FRAME_NAME = { 2: 'CALL', 3: 'CALLRESULT', 4: 'CALLERROR' };

export class VirtualCharger {
  constructor({
    endpoint,
    identity,
    password,
    model = 'Rey-1',
    vendor = 'Learn EV Charging',
    protocol = 'ocpp2.0.1',
    serialNumber = 'REY-SIM-0001',
    firmwareVersion = '1.0.0',
    connectorType = 'CCS2',
    connectorCount = 1,
    maxPowerKw = 150,
    maxVoltageV = 500,
    maxCurrentA = 300,
    countryCode = 'DE',
    operatorId = 'REY',
    evseId = 'E000001',
    chargingStationId = 'REY-STATION-01',
    tariff = '',
    defaultEmaid = 'DE-REY-C12345-3',
    onLog = () => {},
    onState = () => {},
    onVars = () => {},
    onCerts = () => {},
    onLocalList = () => {},
    onIdentity = () => {},
  }) {
    this.endpoint = endpoint;
    this.identity = identity;
    this.model = model;
    this.vendor = vendor;
    this.protocol = protocol;
    this.serialNumber = serialNumber;
    this.firmwareVersion = firmwareVersion;
    this.connectorType = connectorType;
    this.connectorCount = connectorCount;
    this.maxPowerKw = maxPowerKw;
    this.maxVoltageV = maxVoltageV;
    this.maxCurrentA = maxCurrentA;
    this.countryCode = countryCode;
    this.operatorId = operatorId;
    this.evseId = evseId;
    this.chargingStationId = chargingStationId;
    this.tariff = tariff;
    this.defaultEmaid = defaultEmaid;
    this.authMode = 'rfid'; // rfid | app | pnc (Plug & Charge)
    this.onLog = onLog;
    this.onState = onState;
    this.onVars = onVars;
    this.onCerts = onCerts;
    this.onLocalList = onLocalList;
    this.onIdentity = onIdentity;

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
    // The identity rows mirror the station nameplate (see _identityVarMap).
    this.variables = {
      'SampledDataCtrlr/TxUpdatedInterval': '30',
      'OCPPCommCtrlr/HeartbeatInterval': '300',
      'AuthCtrlr/AuthorizeRemoteStart': 'true',
      'DeviceDataCtrlr/BytesPerMessageGetReport': '0',
      'Connector/ConnectorType': this.connectorType,
      'ChargingStation/ConnectorCount': String(this.connectorCount),
      'ChargingStation/RatedPowerKW': String(this.maxPowerKw),
      'Connector/MaxVoltage': String(this.maxVoltageV),
      'Connector/MaxCurrent': String(this.maxCurrentA),
      'ChargingStation/ChargingStationId': this.chargingStationId,
      'ISO15118Ctrlr/CountryCode': this.countryCode,
      'ISO15118Ctrlr/EVSEOperatorID': this.operatorId,
      'ISO15118Ctrlr/EVSEID': this.evseId,
      'TariffCostCtrlr/DefaultTariff': this.tariff,
    };

    // Device-model variable key -> nameplate field. Editing one of these (in
    // the Configuration panel or via SetVariables) updates the nameplate.
    this._identityVarMap = {
      'Connector/ConnectorType': 'connectorType',
      'ChargingStation/ConnectorCount': 'connectorCount',
      'ChargingStation/RatedPowerKW': 'maxPowerKw',
      'Connector/MaxVoltage': 'maxVoltageV',
      'Connector/MaxCurrent': 'maxCurrentA',
      'ChargingStation/ChargingStationId': 'chargingStationId',
      'ISO15118Ctrlr/CountryCode': 'countryCode',
      'ISO15118Ctrlr/EVSEOperatorID': 'operatorId',
      'ISO15118Ctrlr/EVSEID': 'evseId',
      'TariffCostCtrlr/DefaultTariff': 'tariff',
    };

    // Installed certificates (real X.509, from CertificateSigned / InstallCertificate).
    this.certificates = [];
    this._pendingKeyPem = null; // private key held on the CP after we send a CSR

    // Local Authorization List (SendLocalList / offline auth) — whitelisted idTokens.
    this.localAuthList = [];

    this._hbTimer = null;
    this._meterTimer = null;
    this._pending = new Map(); // msgId -> action, to annotate CALLRESULT/CALLERROR
    this._txCounter = 0;

    const opts = { endpoint, identity, protocols: [this.protocol] };
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
      this._note(`Connected to ${this.endpoint} as ${this.identity} (subprotocol ${this.protocol})`);
      this._pushVars();
      this._pushCerts();
      this._pushLocalList();
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
      let identityChanged = false;
      const results = (params?.setVariableData || []).map((d) => {
        const key = `${d.component?.name}/${d.variable?.name}`;
        this.variables[key] = d.attributeValue;
        if (this._syncIdentityFromVar(key, d.attributeValue)) identityChanged = true;
        return { attributeStatus: 'Accepted', component: d.component, variable: d.variable };
      });
      this._pushVars();
      if (identityChanged) this._pushIdentity();
      return { setVariableResult: results };
    });
    c.handle('GetBaseReport', ({ params }) => {
      setTimeout(() => this._sendBaseReport(params?.requestId), 50);
      return { status: 'Accepted' };
    });

    // ---- certificate management (security profiles 2/3, PnC rails) --------
    // The CSMS returns the signed certificate for a CSR the CP sent earlier.
    c.handle('CertificateSigned', ({ params }) => {
      this.certificates = this.certificates.filter((cert) => cert.tier !== 'leaf'); // a renewal replaces the old leaf
      const n = this._installCertChain(params?.certificateChain || '', params?.certificateType || 'ChargingStationCertificate', 'signed');
      this._note(`Installed the signed leaf chain (${n} cert(s): leaf + intermediate sub-CAs)`);
      this._pendingKeyPem = null;
      return { status: n > 0 ? 'Accepted' : 'Rejected' };
    });
    // The CSMS installs a root/CA certificate into the CP trust store.
    c.handle('InstallCertificate', ({ params }) => {
      const n = this._installCertChain(params?.certificate || '', params?.certificateType || 'V2GRootCertificate', 'root');
      this._note(`Installed the ${params?.certificateType || 'root'} trust anchor`);
      return { status: n > 0 ? 'Accepted' : 'Failed' };
    });
    // The CSMS asks which certificates the CP has installed.
    c.handle('GetInstalledCertificateIds', ({ params }) => {
      const wanted = params?.certificateType;
      const list = this.certificates.filter((cert) => !wanted || !wanted.length || wanted.includes(cert.type));
      if (!list.length) return { status: 'NotFound' };
      return {
        status: 'Accepted',
        certificateHashDataChain: list.map((cert) => ({ certificateType: cert.type, certificateHashData: cert.hashData })),
      };
    });
    // The CSMS removes an installed certificate by its hash data.
    c.handle('DeleteCertificate', ({ params }) => {
      const serial = params?.certificateHashData?.serialNumber;
      const before = this.certificates.length;
      this.certificates = this.certificates.filter((cert) => cert.hashData.serialNumber !== serial);
      this._pushCerts();
      return { status: this.certificates.length < before ? 'Accepted' : 'NotFound' };
    });

    // ---- Local Authorization List (offline / local auth) ------------------
    c.handle('SendLocalList', ({ params }) => {
      if (params?.updateType === 'Full') this.localAuthList = [];
      (params?.localAuthorizationList || []).forEach((e) => { if (e?.idToken?.idToken) this._addLocal(e.idToken.idToken); });
      this._pushLocalList();
      this._note(`CSMS sent a ${params?.updateType || ''} Local Authorization List (${this.localAuthList.length} entries)`);
      return { status: 'Accepted' };
    });
    c.handle('GetLocalListVersion', () => ({ versionNumber: this.localAuthList.length ? 1 : 0 }));

    // Anything we don't implement → CALLERROR NotSupported (recognized but unsupported).
    c.handle(({ method }) => {
      throw createRPCError('NotSupported', `${method} is not supported by Rey`);
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

  // ---- identity / nameplate (what a backend needs to register the station) --
  // ISO 15118 EVSEID in eMI3 form: <Country>*<Operator>*<EVSE id>, e.g. DE*REY*E000001.
  evseIdFull() {
    return `${this.countryCode}*${this.operatorId}*${this.evseId}`;
  }

  identityInfo() {
    return {
      identity: this.identity,
      protocol: this.protocol,
      vendor: this.vendor,
      model: this.model,
      serialNumber: this.serialNumber,
      firmwareVersion: this.firmwareVersion,
      connectorType: this.connectorType,
      connectorCount: this.connectorCount,
      maxPowerKw: this.maxPowerKw,
      maxVoltageV: this.maxVoltageV,
      maxCurrentA: this.maxCurrentA,
      countryCode: this.countryCode,
      operatorId: this.operatorId,
      evseId: this.evseId,
      evseIdFull: this.evseIdFull(),
      chargingStationId: this.chargingStationId,
      tariff: this.tariff,
      defaultEmaid: this.defaultEmaid,
    };
  }

  // Keep the nameplate in sync when a mirrored device-model variable is edited
  // (locally in the Configuration panel, or by the CSMS via SetVariables).
  _syncIdentityFromVar(key, value) {
    const field = this._identityVarMap?.[key];
    if (!field) return false;
    const numeric = ['maxPowerKw', 'maxVoltageV', 'maxCurrentA', 'connectorCount'];
    this[field] = numeric.includes(field) ? (Number(value) || this[field]) : value;
    return true;
  }

  _pushIdentity() {
    this.onIdentity(this.identityInfo());
  }

  // ---- boot + heartbeat ---------------------------------------------------
  async boot(reason = 'PowerUp') {
    const res = await this.client.call('BootNotification', {
      reason,
      chargingStation: {
        model: this.model,
        vendorName: this.vendor,
        serialNumber: this.serialNumber,
        firmwareVersion: this.firmwareVersion,
      },
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
    if (this._isWhitelisted(idToken)) {
      this._note(`"${idToken}" is on the Local Authorization List — authorized locally, no Authorize sent to the CSMS`);
      return { idTokenInfo: { status: 'Accepted' } };
    }
    return this.client.call('Authorize', { idToken: { idToken, type } });
  }

  // Plug & Charge (ISO 15118): the car presents a contract certificate; the
  // charge point validates it via OCPP and authorizes by eMAID — no RFID tap.
  // The 15118 EV↔charger leg itself is out of a browser's reach, so it's noted;
  // everything the charge point does over OCPP (Get15118EVCertificate, Authorize
  // with an eMAID idToken) is real.
  async authorizePnC(eMAID = 'DE-REY-C12345-3') {
    this._note(`SECC presented EVSEID ${this.evseIdFull()} to the EV (ISO 15118 SessionSetup)`);
    this._note(`EV presented an ISO 15118 contract certificate (eMAID ${eMAID}) — Plug & Charge`);
    this._setState({ idToken: eMAID });
    await this.client
      .call('Get15118EVCertificate', {
        iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
        action: 'Install',
        exiRequest: 'gA==', // placeholder EXI — the 15118 leg is represented, not wire-accurate
      })
      .catch(() => {});
    if (this._isWhitelisted(eMAID)) {
      this._note(`eMAID ${eMAID} is on the Local Authorization List — authorized locally`);
      return { idTokenInfo: { status: 'Accepted' } };
    }
    return this.client.call('Authorize', { idToken: { idToken: eMAID, type: 'eMAID' } });
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
    this._setState({ seqNo: this.state.seqNo + 1, chargingState: 'Charging', powerW: this.maxPowerKw * 1000 });
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
      case 'SignChargingStationCertificate':
      case 'SignV2GCertificate':
        return this.requestCertificate().catch(() => {});
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

  // ---- device model (browse/edit variables live) -------------------------
  _varsList() {
    return Object.entries(this.variables).map(([key, value]) => {
      const [component, variable] = key.split('/');
      return { key, component, variable, value };
    });
  }

  _pushVars() {
    this.onVars(this._varsList());
  }

  // Edit a variable locally (as if changed on the station), then re-render.
  setLocalVariable(key, value) {
    if (!(key in this.variables)) return;
    this.variables[key] = value;
    this._pushVars();
    if (this._syncIdentityFromVar(key, value)) this._pushIdentity();
    this._note(`Set ${key} = ${value} locally`);
  }

  // ---- certificate management --------------------------------------------
  // Generate a real key pair + CSR on the charge point and send SignCertificate.
  async requestCertificate() {
    this._note('Generating an RSA-2048 key pair and a PKCS#10 CSR on the charge point…');
    const { privateKeyPem, csrPem } = generateKeyAndCsr({
      commonName: this.identity || 'Rey-001',
      organization: this.vendor,
      country: this.countryCode,
    });
    this._pendingKeyPem = privateKeyPem; // stays on the CP; only the CSR is sent
    const res = await this.client.call('SignCertificate', {
      csr: csrPem,
      certificateType: 'ChargingStationCertificate',
    });
    this._note(
      res?.status === 'Accepted'
        ? 'CSMS accepted the CSR — awaiting CertificateSigned with the signed certificate'
        : `CSMS ${res?.status || 'did not accept'} the CSR`
    );
    return res;
  }

  // Parse a PEM chain and add each certificate to the store, tagged by tier.
  // kind: 'root' (a trust anchor from InstallCertificate) or 'signed' (a leaf
  // chain from CertificateSigned — leaf first, then intermediate sub-CAs).
  _installCertChain(pem, type, kind) {
    const parts = splitPemChain(pem);
    let parsed = 0;
    parts.forEach((certPem, i) => {
      let summary;
      let hashData;
      try {
        summary = summarizeCert(certPem);
        hashData = certHashData(certPem, parts[i + 1] || certPem); // issuer is the next cert up the chain
      } catch {
        return; // skip anything that isn't a parseable certificate
      }
      parsed++;
      if (this.certificates.some((c) => c.summary.fingerprint === summary.fingerprint)) return; // idempotent install
      let tier;
      let t;
      if (kind === 'root') { tier = 'root'; t = type || 'V2GRootCertificate'; }
      else if (i === 0) { tier = 'leaf'; t = type || 'ChargingStationCertificate'; }
      else { tier = 'intermediate'; t = 'SubCA'; }
      this.certificates.push({ type: t, tier, certPem, summary, hashData });
    });
    this._pushCerts();
    return parsed;
  }

  _certList() {
    return this.certificates.map((c) => ({ type: c.type, tier: c.tier, pem: c.certPem, ...c.summary }));
  }

  _pushCerts() {
    this.onCerts(this._certList());
  }

  // ---- Local Authorization List ------------------------------------------
  _isWhitelisted(token) { return this.localAuthList.includes(token); }
  _addLocal(token) { if (token && !this.localAuthList.includes(token)) this.localAuthList.push(token); }
  addLocalAuth(token) {
    if (!token || this.localAuthList.includes(token)) return;
    this.localAuthList.push(token);
    this._pushLocalList();
    this._note(`Added "${token}" to the Local Authorization List`);
  }
  removeLocalAuth(token) {
    this.localAuthList = this.localAuthList.filter((t) => t !== token);
    this._pushLocalList();
  }
  _pushLocalList() { this.onLocalList([...this.localAuthList]); }
}
