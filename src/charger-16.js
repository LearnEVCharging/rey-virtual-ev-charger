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
import { generateKeyAndCsr, splitPemChain, summarizeCert, certHashData } from './certs.js';

const FRAME_NAME = { 2: 'CALL', 3: 'CALLRESULT', 4: 'CALLERROR' };

export class VirtualCharger16 {
  constructor({
    endpoint,
    identity,
    password,
    model = 'Rey-1',
    vendor = 'Learn EV Charging',
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
    this.protocol = 'ocpp1.6';
    this.authMode = 'rfid'; // rfid | app (Plug & Charge is OCPP 2.0.1+)
    this.onLog = onLog;
    this.onState = onState;
    this.onVars = onVars;
    this.onCerts = onCerts;
    this.onLocalList = onLocalList;
    this.onIdentity = onIdentity;

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
    // The identity rows mirror the station nameplate (see _identityVarMap).
    this.config = {
      HeartbeatInterval: '300',
      MeterValueSampleInterval: '60',
      ConnectorPhaseRotation: 'RST',
      AuthorizeRemoteTxRequests: 'true',
      NumberOfConnectors: String(connectorCount),
      ConnectorType: this.connectorType,
      RatedPowerKW: String(this.maxPowerKw),
      MaxVoltageV: String(this.maxVoltageV),
      MaxCurrentA: String(this.maxCurrentA),
      ChargingStationId: this.chargingStationId,
      CountryCode: this.countryCode,
      EVSEOperatorID: this.operatorId,
      EVSEID: this.evseId,
      DefaultTariff: this.tariff,
    };

    // Config key -> nameplate field; editing one updates the nameplate.
    this._identityVarMap = {
      ConnectorType: 'connectorType',
      NumberOfConnectors: 'connectorCount',
      RatedPowerKW: 'maxPowerKw',
      MaxVoltageV: 'maxVoltageV',
      MaxCurrentA: 'maxCurrentA',
      ChargingStationId: 'chargingStationId',
      CountryCode: 'countryCode',
      EVSEOperatorID: 'operatorId',
      EVSEID: 'evseId',
      DefaultTariff: 'tariff',
    };

    // Certificate management (OCPP 1.6 Security Whitepaper extension).
    this.certificates = [];
    this._pendingKeyPem = null;

    // Local Authorization List (SendLocalList / offline auth) — whitelisted idTags.
    this.localAuthList = [];

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
      this._pushCerts();
      this._pushLocalList();
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
      if (params?.key) {
        this.config[params.key] = params.value;
        this._pushVars();
        if (this._syncIdentityFromVar(params.key, params.value)) this._pushIdentity();
      }
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

    // ---- OCPP 1.6 Security Whitepaper extension: certificate management ---
    // Not in core 1.6 — these come from the "Improved security for OCPP 1.6-J"
    // whitepaper, which uses ExtendedTriggerMessage + "Charge Point" naming.
    c.handle('ExtendedTriggerMessage', ({ params }) => {
      this._note(`CSMS sent an ExtendedTriggerMessage (${params?.requestedMessage})`);
      setTimeout(() => this._handleTrigger(params?.requestedMessage), 50);
      return { status: 'Accepted' };
    });
    c.handle('CertificateSigned', ({ params }) => {
      this.certificates = this.certificates.filter((cert) => cert.tier !== 'leaf');
      const n = this._installCertChain(params?.certificateChain || '', 'ChargePointCertificate', 'signed');
      this._note(`Installed the signed leaf chain (${n} cert(s): leaf + intermediate sub-CAs)`);
      this._pendingKeyPem = null;
      return { status: n > 0 ? 'Accepted' : 'Rejected' };
    });
    c.handle('InstallCertificate', ({ params }) => {
      const n = this._installCertChain(params?.certificate || '', params?.certificateType || 'CentralSystemRootCertificate', 'root');
      this._note(`Installed the ${params?.certificateType || 'root'} trust anchor`);
      return { status: n > 0 ? 'Accepted' : 'Failed' };
    });
    c.handle('GetInstalledCertificateIds', ({ params }) => {
      const wanted = params?.certificateType;
      const list = this.certificates.filter((cert) => !wanted || cert.type === wanted || cert.tier === 'root');
      if (!list.length) return { status: 'NotFound' };
      return { status: 'Accepted', certificateHashData: list.map((cert) => cert.hashData) };
    });
    c.handle('DeleteCertificate', ({ params }) => {
      const serial = params?.certificateHashData?.serialNumber;
      const before = this.certificates.length;
      this.certificates = this.certificates.filter((cert) => cert.hashData.serialNumber !== serial);
      this._pushCerts();
      return { status: this.certificates.length < before ? 'Accepted' : 'NotFound' };
    });

    // ---- OCPP 1.6 Local Authorization List -------------------------------
    c.handle('SendLocalList', ({ params }) => {
      if (params?.updateType === 'Full') this.localAuthList = [];
      (params?.localAuthorizationList || []).forEach((e) => {
        if (e?.idTag) this._addLocal(e.idTag);
      });
      this._pushLocalList();
      this._note(`CSMS sent a ${params?.updateType || ''} Local Authorization List (${this.localAuthList.length} entries)`);
      return { status: 'Accepted' };
    });
    c.handle('GetLocalListVersion', () => ({ listVersion: this.localAuthList.length ? 1 : 0 }));

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

  // Keep the nameplate in sync when a mirrored config key is edited
  // (locally in the Configuration panel, or by the CSMS via ChangeConfiguration).
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
      chargePointVendor: this.vendor,
      chargePointModel: this.model,
      chargePointSerialNumber: this.serialNumber,
      firmwareVersion: this.firmwareVersion,
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
    if (this._isWhitelisted(idTag)) {
      this._note(`"${idTag}" is on the Local Authorization List — authorized locally, no Authorize sent to the CSMS`);
      return { idTagInfo: { status: 'Accepted' } };
    }
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
      powerW: this.maxPowerKw * 1000,
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
      case 'SignChargePointCertificate': return this.requestCertificate().catch(() => {});
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
    if (this._syncIdentityFromVar(key, value)) this._pushIdentity();
    this._note(`Set ${key} = ${value} locally`);
  }

  // ---- certificate management (1.6 Security Whitepaper extension) ---------
  async requestCertificate() {
    this._note('Generating an RSA-2048 key pair and a PKCS#10 CSR on the charge point…');
    const { privateKeyPem, csrPem } = generateKeyAndCsr({ commonName: this.identity || 'Rey-CP', organization: this.vendor, country: this.countryCode });
    this._pendingKeyPem = privateKeyPem;
    const res = await this.client.call('SignCertificate', { csr: csrPem });
    this._note(res?.status === 'Accepted' ? 'CSMS accepted the CSR — awaiting CertificateSigned' : `CSMS ${res?.status || 'did not accept'} the CSR`);
    return res;
  }

  _installCertChain(pem, type, kind) {
    const parts = splitPemChain(pem);
    let parsed = 0;
    parts.forEach((certPem, i) => {
      let summary;
      let hashData;
      try { summary = summarizeCert(certPem); hashData = certHashData(certPem, parts[i + 1] || certPem); }
      catch { return; }
      parsed++;
      if (this.certificates.some((c) => c.summary.fingerprint === summary.fingerprint)) return;
      let tier;
      let t;
      if (kind === 'root') { tier = 'root'; t = type || 'CentralSystemRootCertificate'; }
      else if (i === 0) { tier = 'leaf'; t = type || 'ChargePointCertificate'; }
      else { tier = 'intermediate'; t = 'SubCA'; }
      this.certificates.push({ type: t, tier, certPem, summary, hashData });
    });
    this._pushCerts();
    return parsed;
  }

  _certList() { return this.certificates.map((c) => ({ type: c.type, tier: c.tier, pem: c.certPem, ...c.summary })); }
  _pushCerts() { this.onCerts(this._certList()); }

  // ---- Local Authorization List ------------------------------------------
  _isWhitelisted(token) { return this.localAuthList.includes(token); }
  _addLocal(token) { if (token && !this.localAuthList.includes(token)) this.localAuthList.push(token); }
  addLocalAuth(token) { if (!token || this.localAuthList.includes(token)) return; this.localAuthList.push(token); this._pushLocalList(); this._note(`Added "${token}" to the Local Authorization List`); }
  removeLocalAuth(token) { this.localAuthList = this.localAuthList.filter((t) => t !== token); this._pushLocalList(); }
  _pushLocalList() { this.onLocalList([...this.localAuthList]); }
}
