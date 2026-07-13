/* Rey browser client — talks to the relay over a WebSocket, renders the
   station controls and the live OCPP-J frame log. */
(() => {
  const $ = (s) => document.querySelector(s);
  const logEl = $('[data-log]');
  const connPill = $('[data-conn]');
  const form = $('[data-connect-form]');
  const connectBtn = $('[data-connect-btn]');
  const autoscroll = $('[data-autoscroll]');

  const section = $('[data-connect-section]');
  let ws = null;
  let connected = false;
  let sessionDemo = true; // whether the current session is the built-in demo CSMS
  let ctaShown = false;
  let version = '2.0.1'; // selected OCPP version — sent to the relay on connect

  // ---- OCPP version selector ---------------------------------------------
  function setVersionUI(v) {
    version = v;
    document.querySelectorAll('[data-ver-select] .ver-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.ver === v)
    );
    const label = 'OCPP ' + v;
    const badge = $('[data-ver-badge]');
    if (badge) badge.textContent = label;
    document.querySelectorAll('[data-demo-ver], [data-cta-ver]').forEach((el) => { el.textContent = v; });
    // Certificate management is an OCPP 2.0.1 / 2.1 feature — hide it for 1.6.
    const certPanel = $('[data-cert-panel]');
    if (certPanel) certPanel.style.display = v === '1.6' ? 'none' : '';
  }
  document.querySelectorAll('[data-ver-select] .ver-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (connected) return; // don't switch mid-session
      setVersionUI(btn.dataset.ver);
    });
  });

  // ---- demo / own mode toggle --------------------------------------------
  document.querySelectorAll('[data-mode-toggle] .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (connected) return; // don't switch mid-session
      const mode = btn.dataset.mode;
      section.className = 'connect mode-' + mode;
      document
        .querySelectorAll('[data-mode-toggle] .mode-btn')
        .forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  // ---- relay socket -------------------------------------------------------
  function relayUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function openRelay() {
    ws = new WebSocket(relayUrl());
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => { setConn('disconnected'); connected = false; setControls(); };
  }

  function sendRelay(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---- inbound messages ---------------------------------------------------
  function handle(msg) {
    if (msg.type === 'log') { renderEntry(msg.entry); maybeShowCta(msg.entry); return; }
    if (msg.type === 'state') return renderState(msg.state);
    if (msg.type === 'vars') return renderVars(msg.vars);
    if (msg.type === 'certs') return renderCerts(msg.certs);
    if (msg.type === 'connected') { connected = true; sessionDemo = !!msg.demo; ctaShown = false; setConn('connected'); setControls(); return; }
    if (msg.type === 'disconnected') { connected = false; setConn('disconnected'); setControls(); clearPanels(); return; }
    if (msg.type === 'error') return renderNote('⚠ ' + msg.message, true);
  }

  // ---- device model + certificates ---------------------------------------
  function renderVars(vars) {
    const list = $('[data-dm-list]');
    const count = $('[data-dm-count]');
    if (count) count.textContent = vars.length ? String(vars.length) : '';
    if (!list) return;
    list.innerHTML = '';
    vars.forEach((v) => {
      const row = document.createElement('div');
      row.className = 'dm-row';
      const label = v.component ? `${v.component}/${v.variable}` : v.variable;
      row.innerHTML = `<label title="${escapeHtml(label)}">${escapeHtml(label)}</label>`;
      const input = document.createElement('input');
      input.value = v.value == null ? '' : v.value;
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => {
        sendRelay({ type: 'action', action: 'setVariable', key: v.key, value: input.value });
      });
      row.appendChild(input);
      list.appendChild(row);
    });
  }

  // Order the store as the chain reads: root (trust anchor) → intermediates → leaf.
  const TIER_RANK = { root: 0, intermediate: 1, leaf: 2 };
  const TIER_LABEL = { root: 'Root CA · trust anchor', intermediate: 'Intermediate CA', leaf: 'Charging station cert' };

  function renderCerts(certs) {
    const list = $('[data-cert-list]');
    const count = $('[data-cert-count]');
    if (count) count.textContent = certs.length ? String(certs.length) : '';
    if (!list) return;
    if (!certs.length) {
      list.innerHTML = '<p class="cert-empty">No certificates installed yet. Click “Request a certificate”.</p>';
      return;
    }
    const ordered = certs.slice().sort(
      (a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || (a.subject || '').localeCompare(b.subject || '')
    );
    list.innerHTML = '';
    ordered.forEach((c) => {
      const tier = c.tier || (/Root/.test(c.type) || c.selfSigned ? 'root' : 'leaf');
      const card = document.createElement('div');
      card.className = `cert-card tier-${tier}`;
      card.innerHTML =
        `<span class="cert-type">${escapeHtml(TIER_LABEL[tier] || c.type || 'certificate')}</span>` +
        `<div class="cert-cn">${escapeHtml(c.subject || '')}</div>` +
        `<div class="cert-meta">issuer: ${escapeHtml(c.issuer || '')} · serial ${escapeHtml((c.serialNumber || '').slice(0, 16))}</div>` +
        `<div class="cert-meta">valid ${escapeHtml((c.notBefore || '').slice(0, 10))} → ${escapeHtml((c.notAfter || '').slice(0, 10))}</div>` +
        `<div class="cert-fp">SHA-256 ${escapeHtml(c.fingerprint || '')}</div>`;
      list.appendChild(card);
    });
    const panel = $('[data-cert-panel]');
    if (panel) panel.open = true; // surface it once a cert lands
  }

  function clearPanels() {
    const dm = $('[data-dm-list]'); if (dm) dm.innerHTML = '';
    const cl = $('[data-cert-list]'); if (cl) cl.innerHTML = '';
    const dc = $('[data-dm-count]'); if (dc) dc.textContent = '';
    const cc = $('[data-cert-count]'); if (cc) cc.textContent = '';
  }

  // The aha moment: a user's OWN CSMS accepting a real handshake = a course buyer.
  // Show the waitlist CTA then (never in demo mode).
  function maybeShowCta(e) {
    if (ctaShown || sessionDemo) return;
    if (e.kind === 'frame' && e.action === 'BootNotification' && e.frameType === 'CALLRESULT' && summarize(e) === 'Accepted') {
      const cta = $('[data-cta]');
      if (cta) { cta.hidden = false; ctaShown = true; }
    }
  }
  $('[data-cta-dismiss]')?.addEventListener('click', () => { const c = $('[data-cta]'); if (c) c.hidden = true; });

  // ---- connection form ----------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (connected) { sendRelay({ type: 'action', action: 'disconnect' }); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      openRelay();
      ws.addEventListener('open', doConnect, { once: true });
    } else {
      doConnect();
    }
  });

  function doConnect() {
    setConn('connecting');
    if (section.classList.contains('mode-demo')) {
      sendRelay({ type: 'connect', demo: true, identity: 'Rey-DEMO', version });
    } else {
      sendRelay({
        type: 'connect',
        endpoint: $('#endpoint').value.trim(),
        identity: $('#identity').value.trim(),
        password: $('#password').value,
        version,
      });
    }
  }

  // ---- station controls ---------------------------------------------------
  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.act;
      const payload = { type: 'action', action };
      if (action === 'authorize' || action === 'start') payload.idToken = $('[data-idtoken]').value.trim();
      sendRelay(payload);
    });
  });

  $('[data-clear]').addEventListener('click', () => { logEl.innerHTML = ''; });

  // ---- rendering ----------------------------------------------------------
  function setConn(status) {
    connPill.className = 'conn-pill ' + status;
    connPill.textContent = '● ' + status;
    connectBtn.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
  }

  function setControls() {
    document.querySelectorAll('[data-act]').forEach((b) => { b.disabled = !connected; });
    // Lock the version + mode pickers during a live session.
    document.querySelectorAll('[data-ver-select] .ver-btn, [data-mode-toggle] .mode-btn').forEach((b) => {
      b.disabled = connected;
    });
  }

  function renderState(s) {
    $('[data-connector]').textContent = s.connectorStatus || '—';
    $('[data-charging]').textContent = s.chargingState || '—';
    $('[data-energy]').textContent = (s.meterWh || 0).toLocaleString() + ' Wh';
    $('[data-power]').textContent = (s.powerW || 0).toLocaleString() + ' W';
  }

  function renderNote(text, isError) {
    const div = document.createElement('div');
    div.className = 'entry entry--note';
    div.innerHTML = `<p class="note-text">${escapeHtml(text)}</p>`;
    if (isError) div.style.borderLeftColor = '#c0152f';
    logEl.appendChild(div);
    scroll();
  }

  // Pull the headline field out of a frame (status / connectorStatus / eventType)
  // so the key result — e.g. BootNotification → "Accepted" — shows without expanding.
  function summarize(e) {
    try {
      const arr = JSON.parse(e.raw);
      const payload = e.type === 2 ? arr[3] : e.type === 3 ? arr[2] : null;
      if (payload && typeof payload === 'object') {
        const v =
          payload.status ||
          payload.connectorStatus ||
          payload.eventType ||
          (payload.idTokenInfo && payload.idTokenInfo.status);
        if (v) return String(v);
      }
    } catch {}
    return '';
  }

  function renderEntry(e) {
    if (e.kind === 'note') return renderNote(e.text, false);
    const badgeCls = { CALL: 'call', CALLRESULT: 'result', CALLERROR: 'error' }[e.frameType] || 'call';
    const div = document.createElement('div');
    div.className = `entry entry--${e.dir} open`; // open by default — the JSON is the point
    const sum = summarize(e);
    div.innerHTML =
      `<div class="entry-head">` +
        `<span class="dir">${e.dir === 'out' ? 'CS ▶ CSMS' : 'CSMS ▶ CS'}</span>` +
        `<span class="badge badge--${badgeCls}">${e.frameType}</span>` +
        (e.action ? `<span class="action">${escapeHtml(e.action)}</span>` : '') +
        (sum ? `<span class="summary">${escapeHtml(sum)}</span>` : '') +
        `<span class="msgid">${escapeHtml(e.id || '')}</span>` +
        `<span class="entry-toggle" data-toggle>hide ▾</span>` +
      `</div>` +
      `<div class="entry-body"><pre>${highlight(e.raw)}</pre></div>`;
    div.querySelector('.entry-head').addEventListener('click', () => {
      div.classList.toggle('open');
      div.querySelector('[data-toggle]').textContent = div.classList.contains('open') ? 'hide ▾' : 'show ▸';
    });
    logEl.appendChild(div);
    scroll();
  }

  function scroll() {
    if (autoscroll.checked) {
      const last = logEl.lastElementChild;
      if (last) last.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- helpers ------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(raw) {
    let pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
    return escapeHtml(pretty).replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (m) => {
        let cls = 'num';
        if (/^"/.test(m)) cls = /:\s*$/.test(m) ? 'key' : 'str';
        else if (m === 'true' || m === 'false') cls = 'bool';
        else if (m === 'null') cls = 'nul';
        return `<span class="t-${cls}">${m}</span>`;
      }
    );
  }
})();
