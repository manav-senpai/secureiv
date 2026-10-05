/* =========================================================================
   SECURE-IV — Master Clinical Gravity IV Infusion Platform
   Dual Web Serial (USB 115200 baud) & Wi-Fi Telemetry Stream Engine
   ========================================================================= */

const LOGO_B64 = document.querySelector('link[rel="stylesheet"]') ? getComputedStyle(document.documentElement).getPropertyValue('--logo-url') : '';
const LOGO_SRC = (function(){
  const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(LOGO_B64);
  return m ? 'data:image/png;base64,'+m[1] : '';
})();

/* ---------------- PERSISTENCE ---------------- */
const LS = {
  get(key, fallback){ try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }catch(e){ return fallback; } },
  set(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} },
};
const KEYS = { settings:'secureiv_settings', history:'secureiv_history', calibration:'secureiv_calibration' };

const DEFAULT_SETTINGS = {
  deviceName:'SECURE-IV Bedside Unit', deviceId:'SEC-ESP32-01',
  defaultDropFactor:20, defaultFluid:'Normal Saline (0.9% NaCl)', defaultTargetRate:120,
  maxDeviation:15, minDeviation:-15, noDropTimeout:20, lowBatteryThreshold:20, sensorDisagreementThreshold:18,
  soundOn:true, notifPref:true, theme:'light', espIp:'192.168.4.1',
};
const DEFAULT_CALIBRATION = {
  loadCell:{ done:false, lastDate:null, knownWeight:500, rawValue:null, factor:1.00 },
  optical:{ done:false, lastDate:null, sensitivity:50 },
};

/* ---------------- GLOBAL STATE ---------------- */
const state = {
  auth:{ loggedIn:false, username:'', guest:false },
  settings: LS.get(KEYS.settings, DEFAULT_SETTINGS),
  calibration: LS.get(KEYS.calibration, DEFAULT_CALIBRATION),
  history: LS.get(KEYS.history, []),
  currentView:'dashboard',
  session:null,          // Active infusion session
  selfCheck:{ running:false, done:false, simulateFail:false, results:{} },
  chart:null,
  graphRange:'live',
  alertFilter:'All',
  historySearch:'', historyStatusFilter:'All', historySort:'newest',
  
  // Real Hardware Connectivity
  hardware:{
    connected:false,
    type:null,          // 'serial' | 'wifi' | null
    port:null,
    reader:null,
    writer:null,
    pollTimer:null,
    packetCount:0,
    lastPacketTime:0,
    lastOpticalAdc:2048,
    baselineAdc:2048,
    opticalWaveHistory:[], // Waveform buffer for seismograph
  }
};
document.body.dataset.theme = state.settings.theme;

function saveSettings(){ LS.set(KEYS.settings, state.settings); }
function saveCalibration(){ LS.set(KEYS.calibration, state.calibration); }
function saveHistory(){ LS.set(KEYS.history, state.history); }

/* ---------------- NAV CONFIG ---------------- */
const NAV = [
  {id:'dashboard', label:'Dashboard', icon:'fa-gauge-high'},
  {id:'newinfusion', label:'New Infusion', icon:'fa-plus'},
  {id:'livemonitoring', label:'Live Monitoring', icon:'fa-wave-square'},
  {id:'parameters', label:'Detailed Parameters', icon:'fa-list-check'},
  {id:'alerts', label:'Alerts & Notifications', icon:'fa-bell', badge:true},
  {id:'history', label:'Infusion History', icon:'fa-clock-rotate-left'},
  {id:'reports', label:'Reports & Export', icon:'fa-file-export'},
  {id:'calibration', label:'Calibration & Waveform', icon:'fa-sliders'},
  {id:'settings', label:'Settings', icon:'fa-gear'},
  {id:'about', label:'About SECURE-IV', icon:'fa-circle-info'},
];
const TABBAR = ['dashboard','livemonitoring','alerts','history','settings'];

function uid(prefix){ return prefix+'-'+Math.random().toString(36).slice(2,8).toUpperCase(); }
function fmtTime(d){ return new Date(d).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtDateTime(d){ return new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fmtDur(sec){ const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60); return (h>0?h+'h ':'')+m+'m '+s+'s'; }

/* ---------------- TOAST + MODAL + AUDIO ---------------- */
function showToast(title, body, severity){
  const wrap = document.getElementById('toastWrap');
  if(!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (severity||'Info');
  el.innerHTML = `<div class="ttitle">${title}</div><div class="tbody">${body}</div>`;
  wrap.appendChild(el);
  if(state.settings.soundOn) playBeep(severity);
  setTimeout(()=>{ if(el.parentNode) el.remove(); }, 6000);
}
let audioCtx;
function playBeep(sev){
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.value = sev==='Critical' ? 920 : (sev==='Warning' ? 700 : 500);
    g.gain.value=0.05; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime+0.15);
  }catch(e){}
}
function showModal(title, body, actions){
  const overlay = document.getElementById('modalOverlay');
  const box = document.getElementById('modalBox');
  box.innerHTML = `<h3 style="margin:0 0 4px;font-size:16px;">${title}</h3><p>${body}</p>
    <div class="modal-actions">${actions.map((a,i)=>`<button class="btn ${a.cls||''}" data-modal-action="${i}">${a.label}</button>`).join('')}</div>`;
  overlay.classList.add('open');
  box.querySelectorAll('[data-modal-action]').forEach((btn,i)=>{
    btn.onclick = ()=>{ overlay.classList.remove('open'); if(actions[i].onClick) actions[i].onClick(); };
  });
}
function confirmModal(title, body, onConfirm){
  showModal(title, body, [
    {label:'Cancel', cls:'ghost'},
    {label:'Confirm', cls:'danger', onClick:onConfirm},
  ]);
}

/* =========================================================================
   HARDWARE COMMUNICATION (WEB SERIAL & WI-FI HTTP TELEMETRY)
   ========================================================================= */
async function connectUSBSerial() {
  if (!navigator.serial) {
    showToast('Web Serial Unsupported', 'Please use Google Chrome, Edge, or Opera on desktop to access USB Serial.', 'Critical');
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    state.hardware.port = port;
    state.hardware.connected = true;
    state.hardware.type = 'serial';
    
    // Create text encoder for writing commands
    const textEncoder = new TextEncoderStream();
    textEncoder.readable.pipeTo(port.writable);
    state.hardware.writer = textEncoder.writable.getWriter();

    showToast('ESP32 Connected', 'USB Serial linked at 115200 baud! Receiving real hardware telemetry.', 'Info');
    updateConnectionUI();

    // Start reading stream
    readSerialLoop(port);
  } catch (err) {
    console.error('Serial connection error:', err);
    showToast('Connection Failed', err.message || 'Could not open serial port.', 'Warning');
  }
}

async function readSerialLoop(port) {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();
  state.hardware.reader = reader;

  let lineBuffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        lineBuffer += value;
        let lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // Keep partial line
        for (const line of lines) {
          handleIncomingHardwareLine(line.trim());
        }
      }
    }
  } catch (err) {
    console.warn('Serial read error:', err);
  } finally {
    reader.releaseLock();
    disconnectHardware();
  }
}

function connectWiFiPolling() {
  const ip = state.settings.espIp || '192.168.4.1';
  if (state.hardware.pollTimer) clearInterval(state.hardware.pollTimer);
  state.hardware.connected = true;
  state.hardware.type = 'wifi';
  showToast('Wi-Fi Telemetry Mode', `Connecting to http://${ip}/api/telemetry...`, 'Info');
  updateConnectionUI();

  state.hardware.pollTimer = setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 900);
      const res = await fetch(`http://${ip}/api/telemetry`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        processTelemetryPacket(data);
      }
    } catch (e) {
      // Offline / reconnecting
    }
  }, 100); // 10Hz poll rate
}

function disconnectHardware() {
  if (state.hardware.pollTimer) { clearInterval(state.hardware.pollTimer); state.hardware.pollTimer = null; }
  if (state.hardware.reader) { try { state.hardware.reader.cancel(); } catch(e){} state.hardware.reader = null; }
  if (state.hardware.writer) { try { state.hardware.writer.releaseLock(); } catch(e){} state.hardware.writer = null; }
  if (state.hardware.port) { try { state.hardware.port.close(); } catch(e){} state.hardware.port = null; }
  state.hardware.connected = false;
  state.hardware.type = null;
  showToast('Hardware Disconnected', 'ESP32 link closed.', 'Warning');
  updateConnectionUI();
}

async function sendHardwareCommand(cmd) {
  if (state.hardware.type === 'serial' && state.hardware.writer) {
    try {
      await state.hardware.writer.write(cmd + '\n');
    } catch(e){ console.error('Serial write error:', e); }
  } else if (state.hardware.type === 'wifi') {
    const ip = state.settings.espIp || '192.168.4.1';
    fetch(`http://${ip}/api/cmd?cmd=${encodeURIComponent(cmd)}`).catch(e=>console.log(e));
  }
}

function handleIncomingHardwareLine(line) {
  if (!line || !line.startsWith('{')) return;
  try {
    const data = JSON.parse(line);
    processTelemetryPacket(data);
  } catch (e) {
    // Non-JSON debug message
  }
}

function processTelemetryPacket(data) {
  state.hardware.packetCount++;
  state.hardware.lastPacketTime = Date.now();
  state.hardware.lastOpticalAdc = data.opticalAdc || 2048;

  // Buffer optical waveform for drop seismograph
  state.hardware.opticalWaveHistory.push(state.hardware.lastOpticalAdc);
  if (state.hardware.opticalWaveHistory.length > 300) state.hardware.opticalWaveHistory.shift();

  // If no session exists yet, auto-populate an active monitoring instance from ESP32
  if (!state.session) {
    state.session = {
      id: uid('SEC'),
      patientId: 'ESP32-Live',
      ward: 'Bedside 1',
      fluid: state.settings.defaultFluid,
      initialVolume: data.bagVolume || 500,
      targetRate: data.targetRate || 120,
      dropFactor: 20,
      startWeight: data.grossMass || 500,
      notes: 'Real hardware stream active',
      startTime: Date.now(),
      status: data.status || 'NORMAL',
      delivered: data.drippedVol || 0,
      battery: 100,
      temperature: data.temp || 28.5,
      opticalRate: data.flowRate || 0,
      gravRate: data.flowRate || 0,
      dropRate: Math.round(data.dropBpm || 0),
      deviationPct: Math.round(data.deviation || 0),
      elapsedSec: 0,
      running: data.running !== undefined ? data.running : true,
      completed: data.status === 'COMPLETED',
      stopped: data.status === 'STOPPED',
      history: [],
      alerts: [],
      statusBuf: [],
    };
  }

  const s = state.session;
  s.targetRate = data.targetRate || s.targetRate;
  s.initialVolume = data.bagVolume || s.initialVolume;
  s.delivered = data.drippedVol !== undefined ? data.drippedVol : s.delivered;
  s.dropRate = Math.round(data.dropBpm || 0);
  s.opticalRate = data.flowRate || 0;
  s.gravRate = data.flowRate || 0;
  s.deviationPct = Math.round(data.deviation || 0);
  s.status = data.status || 'NORMAL';
  s.temperature = data.temp || 28.5;
  s.currentWeight = data.grossMass || (s.startWeight - s.delivered);
  s.totalDrops = data.drops || 0;
  s.running = data.running !== undefined ? data.running : s.running;

  // Track session duration & live graph points
  s.elapsedSec += 0.1;
  staticGraphThrottle(s);

  // Trigger UI alerts on hardware status changes
  if (data.status === 'NEAR_EMPTY' && !s._nearEmptyTriggered) {
    s._nearEmptyTriggered = true;
    pushAlert('Fluid bag almost empty (20-30 mL remaining)', 'Infusion nearly complete. Please prepare next bag or discontinue.', 'Warning');
  } else if (data.status === 'COMPLETED' && !s.completed) {
    s.completed = true;
    s.running = false;
    pushAlert('Infusion completed', 'Target fluid fully infused.', 'Info');
    finalizeSession('Completed');
  } else if (data.status === 'STOPPED' && !s._stoppedAlertTriggered) {
    s._stoppedAlertTriggered = true;
    pushAlert('Infusion stopped / No drops detected', 'Check tubing line, clamp, and fluid level.', 'Critical');
  }

  // Refresh active views smoothly
  if (['dashboard','livemonitoring','parameters','alerts','calibration'].includes(state.currentView)) {
    updateDynamicMetrics();
  }
}

let lastGraphRecord = 0;
function staticGraphThrottle(s) {
  const now = Date.now();
  if (now - lastGraphRecord >= 1000) {
    lastGraphRecord = now;
    s.history.push({
      t: Math.round(s.elapsedSec),
      time: now,
      expectedVolume: Math.min(s.initialVolume, s.targetRate * (s.elapsedSec / 3600)),
      actualVolume: s.delivered,
      expectedRate: s.targetRate,
      actualRate: Math.round((s.opticalRate + s.gravRate)/2),
      dropRate: s.dropRate,
      weight: Math.round(s.currentWeight || s.startWeight),
      status: s.status,
    });
    if (s.history.length > 2000) s.history.shift();
    if (state.currentView === 'livemonitoring') ensureChart();
  }
}

function pushAlert(title, desc, severity){
  const s = state.session; if(!s) return;
  const a = {id:uid('A'), title, desc, severity, time:Date.now(), read:false};
  s.alerts.unshift(a);
  showToast(title, desc, severity);
  renderNav();
}

function updateConnectionUI() {
  const dot = document.getElementById('hwDot');
  const label = document.getElementById('hwLabel');
  const btnUsb = document.getElementById('btnUsbConnect');
  const btnWifi = document.getElementById('btnWifiConnect');
  if (!dot || !label) return;

  if (state.hardware.connected) {
    dot.className = 'hw-status-dot connected';
    label.innerHTML = `<b>ESP32 Connected</b> (${state.hardware.type==='serial'?'USB 115200':'Wi-Fi Hub'})`;
    if(btnUsb) btnUsb.innerHTML = '<i class="fa-solid fa-link-slash"></i> Disconnect';
    if(btnWifi) btnWifi.style.display = 'none';
  } else {
    dot.className = 'hw-status-dot';
    label.innerHTML = 'ESP32 Disconnected';
    if(btnUsb) btnUsb.innerHTML = '<i class="fa-solid fa-plug"></i> Connect USB';
    if(btnWifi) { btnWifi.style.display = 'inline-flex'; btnWifi.innerHTML = '<i class="fa-solid fa-wifi"></i> Connect Wi-Fi'; }
  }
}

function updateDynamicMetrics() {
  const s = state.session;
  if (!s) return;

  const valActRate = document.getElementById('dyn-actual-rate');
  const valTargetRate = document.getElementById('dyn-target-rate');
  const valDev = document.getElementById('dyn-dev');
  const valDropRate = document.getElementById('dyn-drop-rate');
  const valDelivered = document.getElementById('dyn-delivered');
  const valRemaining = document.getElementById('dyn-remaining');
  const valProgressBar = document.getElementById('dyn-progress-bar');
  const valStatusBanner = document.getElementById('dyn-status-banner');
  const valStatusText = document.getElementById('dyn-status-text');
  const valGrossMass = document.getElementById('dyn-gross-mass');

  if (valActRate) valActRate.textContent = Math.round((s.opticalRate+s.gravRate)/2);
  if (valTargetRate) valTargetRate.textContent = s.targetRate;
  if (valDev) valDev.textContent = (s.deviationPct > 0 ? '+' : '') + s.deviationPct;
  if (valDropRate) valDropRate.textContent = s.dropRate;
  if (valDelivered) valDelivered.textContent = Math.round(s.delivered);
  if (valRemaining) valRemaining.textContent = Math.max(0, Math.round(s.initialVolume - s.delivered));
  if (valGrossMass) valGrossMass.textContent = Math.round(s.currentWeight || s.startWeight);

  const pct = Math.min(100, Math.round((s.delivered / s.initialVolume) * 100));
  if (valProgressBar) valProgressBar.style.width = pct + '%';

  if (valStatusBanner) {
    valStatusBanner.className = `status-banner ${s.status}`;
    if (valStatusText) valStatusText.textContent = statusText(s.status);
  }

  // Draw Drop Oscillogram if on Calibration view
  if (state.currentView === 'calibration') {
    drawSeismicOscillogram();
  }
}

/* =========================================================================
   LOGIN SCREEN
   ========================================================================= */
function renderLogin(){
  document.getElementById('root').innerHTML = `
  <div id="loginScreen">
    <div class="login-card">
      <img src="${LOGO_SRC}" alt="SECURE-IV">
      <div class="login-sub">Gravity IV Infusion Monitor — Every Drop Matters</div>
      <div class="login-desc">Smart Gravity IV Infusion Monitoring System (Clinical hardware and telemetry portal)</div>
      <div class="field"><label>Username</label><input type="text" id="loginUser" placeholder="e.g. nurse01"></div>
      <div class="field field-pass"><label>Password</label>
        <input type="password" id="loginPass" placeholder="••••••••">
        <button type="button" class="toggle-eye" id="togglePass"><i class="fa-solid fa-eye"></i></button>
      </div>
      <div class="err-msg" id="loginErr">Please enter both a username and password.</div>
      <div class="remember-row"><label><input type="checkbox" id="rememberMe" checked> Remember me</label><span>Clinical Portal</span></div>
      <button class="btn primary" id="loginBtn">Login</button>
      <button class="btn ghost" id="guestBtn">Continue as Guest</button>
      <div class="login-demo">Default credentials: <b>nurse01</b> / <b>secureiv123</b></div>
    </div>
  </div>`;
  document.getElementById('togglePass').onclick = ()=>{
    const p = document.getElementById('loginPass');
    p.type = p.type==='password' ? 'text' : 'password';
  };
  document.getElementById('loginBtn').onclick = ()=>{
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value.trim();
    const err = document.getElementById('loginErr');
    if(!u || !p){ err.style.display='block'; return; }
    err.style.display='none';
    state.auth = { loggedIn:true, username:u, guest:false };
    bootApp();
  };
  document.getElementById('guestBtn').onclick = ()=>{
    state.auth = { loggedIn:true, username:'Guest', guest:true };
    bootApp();
  };
}

/* =========================================================================
   APP SHELL
   ========================================================================= */
function bootApp(){
  document.getElementById('root').innerHTML = `
  <div id="app" class="active">
    <div class="drawer-overlay" id="drawerOverlay"></div>
    <div class="drawer" id="drawer">
      <div class="brandrow"><img src="${LOGO_SRC}" style="height:26px;"></div>
      <ul class="navlist" id="drawerNav"></ul>
    </div>
    <aside class="sidebar">
      <div class="brandrow"><img src="${LOGO_SRC}" style="height:30px;"></div>
      <ul class="navlist" id="sidebarNav"></ul>
      <div class="sidebar-foot"><div class="navitem" id="logoutBtn"><i class="fa-solid fa-right-from-bracket"></i><span>Log out</span></div></div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="tb-left">
          <button class="icon-btn hamburger" id="hamburgerBtn"><i class="fa-solid fa-bars"></i></button>
          <img src="${LOGO_SRC}">
        </div>
        <div class="tb-right">
          <!-- Real Hardware Status & Connect Buttons -->
          <div class="hw-strip">
            <span class="hw-status-dot" id="hwDot"></span>
            <span id="hwLabel">ESP32 Disconnected</span>
            <button class="btn sm" id="btnUsbConnect"><i class="fa-solid fa-plug"></i> Connect USB</button>
            <button class="btn sm" id="btnWifiConnect"><i class="fa-solid fa-wifi"></i> Connect Wi-Fi</button>
          </div>
          <span><i class="fa-solid fa-user-doctor"></i> ${state.auth.username}</span>
          <button class="icon-btn" id="themeToggleTop" title="Toggle Theme"><i class="fa-solid ${state.settings.theme==='dark'?'fa-sun':'fa-moon'}"></i></button>
        </div>
      </div>
      <div class="content" id="content"></div>
    </div>
    <div class="tabbar"><div class="tabbar-row" id="tabbarRow"></div></div>
  </div>`;

  document.getElementById('logoutBtn').onclick = ()=> confirmModal('Log out?','You will return to the login screen. Your session data stays saved on this device.', ()=>{
    disconnectHardware();
    state.auth = {loggedIn:false, username:'', guest:false};
    renderLogin();
  });
  document.getElementById('hamburgerBtn').onclick = ()=>{ document.getElementById('drawer').classList.add('open'); document.getElementById('drawerOverlay').classList.add('open'); };
  document.getElementById('drawerOverlay').onclick = ()=>{ document.getElementById('drawer').classList.remove('open'); document.getElementById('drawerOverlay').classList.remove('open'); };
  document.getElementById('themeToggleTop').onclick = toggleTheme;

  // Hardware connection button bindings
  document.getElementById('btnUsbConnect').onclick = ()=>{
    if (state.hardware.connected) disconnectHardware();
    else connectUSBSerial();
  };
  document.getElementById('btnWifiConnect').onclick = ()=>{
    if (state.hardware.connected) disconnectHardware();
    else connectWiFiPolling();
  };

  updateConnectionUI();
  renderNav();
  switchView('dashboard');
}

function toggleTheme(){
  state.settings.theme = state.settings.theme==='dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.settings.theme;
  saveSettings();
  bootApp();
}

function renderNav(){
  const html = NAV.map(n=>`
    <li class="navitem ${n.id===state.currentView?'active':''}" data-nav="${n.id}">
      <i class="fa-solid ${n.icon}"></i><span>${n.label}</span>
      ${n.badge && unreadAlertCount()>0 ? `<span class="navbadge">${unreadAlertCount()}</span>` : ''}
    </li>`).join('');
  document.getElementById('sidebarNav').innerHTML = html;
  document.getElementById('drawerNav').innerHTML = html;
  document.querySelectorAll('[data-nav]').forEach(el=> el.onclick = ()=> switchView(el.dataset.nav));
  document.getElementById('tabbarRow').innerHTML = TABBAR.map(id=>{
    const n = NAV.find(x=>x.id===id);
    return `<div class="tabbtn ${id===state.currentView?'active':''}" data-nav="${id}"><i class="fa-solid ${n.icon}"></i><span>${n.label.split(' ')[0]}</span></div>`;
  }).join('');
  document.querySelectorAll('.tabbtn').forEach(el=> el.onclick = ()=> switchView(el.dataset.nav));
}

function switchView(view){
  state.currentView = view;
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  renderNav();
  renderView();
}
function unreadAlertCount(){ return state.session ? state.session.alerts.filter(a=>!a.read).length : 0; }

/* =========================================================================
   VIEW ROUTER
   ========================================================================= */
const VIEWS = {};
function renderView(){
  const fn = VIEWS[state.currentView] || VIEWS.dashboard;
  document.getElementById('content').innerHTML = fn();
  bindViewEvents(state.currentView);
  if(state.currentView==='livemonitoring') ensureChart();
  if(state.currentView==='calibration') drawSeismicOscillogram();
}

/* =========================================================================
   1. DASHBOARD
   ========================================================================= */
VIEWS.dashboard = function(){
  const s = state.session;
  const recentAlerts = s ? s.alerts.slice(0,4) : [];
  const recentHistory = state.history.slice(0,4);
  return `
  <div class="pagehead"><h1>Dashboard</h1><span class="sub">${fmtDateTime(new Date())}</span></div>

  ${s ? `
  <div class="status-banner ${s.status}" id="dyn-status-banner" style="margin-bottom:16px;">
    <i class="fa-solid ${statusIcon(s.status)} sbicon"></i>
    <div><b id="dyn-status-text">${statusText(s.status)}</b><span>${s.id} · ${s.patientId||'Bedside Unit'} · ${s.ward||'Ward 1'}</span></div>
    <button class="btn sm" style="margin-left:auto;" data-action="goto-live">Open Live Monitoring</button>
  </div>` : `
  <div class="panel" style="text-align:center;padding:36px;margin-bottom:16px;">
    <i class="fa-solid fa-droplet" style="font-size:28px;color:var(--muted-2);margin-bottom:10px;"></i>
    <h3 style="margin:0 0 6px;">No active infusion session</h3>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px;">Connect hardware or start a new infusion session to begin real-time clinical monitoring.</p>
    <button class="btn primary" style="width:auto;padding:10px 20px;" data-action="goto-new">+ New Infusion</button>
  </div>`}

  <div class="grid4" style="margin-bottom:16px;">
    <div class="mini"><div class="mlabel">Active Session</div><div class="mval">${s ? '1' : '0'}</div></div>
    <div class="mini"><div class="mlabel">Sessions Logged</div><div class="mval">${state.history.length}</div></div>
    <div class="mini"><div class="mlabel">Unread Alerts</div><div class="mval">${unreadAlertCount()}</div></div>
    <div class="mini"><div class="mlabel">Hardware Packets</div><div class="mval mono">${state.hardware.packetCount}</div></div>
  </div>

  <div class="grid2">
    <div class="panel">
      <div class="panel-head"><h3>Recent Alerts</h3><span class="chipbtn" data-action="goto-alerts" style="cursor:pointer;">View all</span></div>
      ${recentAlerts.length ? recentAlerts.map(a=>alertRowHtml(a)).join('') : '<p style="color:var(--muted);font-size:13px;">No alerts yet.</p>'}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Recent Sessions</h3><span class="chipbtn" data-action="goto-history" style="cursor:pointer;">View all</span></div>
      ${recentHistory.length ? `<table><tbody>${recentHistory.map(h=>`<tr><td>${h.id}</td><td>${h.initialVolume} mL @ ${h.targetRate} mL/hr</td><td><span class="pill ${h.finalStatus}">${h.finalStatus}</span></td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--muted);font-size:13px;">No completed sessions yet.</p>'}
    </div>
  </div>`;
};
function statusIcon(s){ return {NORMAL:'fa-circle-check', DEVIATION:'fa-triangle-exclamation', STOPPED:'fa-circle-xmark', COMPLETED:'fa-flag-checkered', NEAR_EMPTY:'fa-triangle-exclamation', PAUSED:'fa-circle-pause'}[s] || 'fa-circle'; }
function statusText(s){ return {NORMAL:'Infusion running within target range.', DEVIATION:'Flow rate deviation outside acceptable limits.', STOPPED:'No drops detected / Line occlusion!', COMPLETED:'Infusion completed successfully.', NEAR_EMPTY:'Bag almost empty (20-30 mL remaining)!', PAUSED:'Infusion monitoring paused.'}[s] || s; }
function alertRowHtml(a){
  const icon = {Critical:'fa-circle-exclamation', Warning:'fa-triangle-exclamation', Info:'fa-circle-info'}[a.severity];
  const color = {Critical:'var(--red)', Warning:'var(--amber)', Info:'var(--blue)'}[a.severity];
  return `<div class="alert-item ${a.read?'':'unread'}" data-alert-id="${a.id}">
    <div class="aicon" style="color:${color};"><i class="fa-solid ${icon}"></i></div>
    <div class="abody"><div class="atitle">${a.title} <span class="pill ${a.severity}" style="margin-left:6px;">${a.severity}</span></div>
    <div class="adesc">${a.desc}</div><div class="atime">${fmtTime(a.time)}</div></div>
  </div>`;
}

/* =========================================================================
   2. NEW INFUSION
   ========================================================================= */
const FLUIDS = [
  "Normal Saline (0.9% NaCl)",
  "Ringer's Lactate (Compound Sodium Lactate)",
  "5% Dextrose (D5W)",
  "Dextrose Normal Saline (DNS)",
  "10% Dextrose (D10W)",
  "0.45% Normal Saline (Half Normal Saline)",
  "Dextrose 5% in 0.45% Saline (D5 1/2 NS)",
  "Ringer's Lactate with 5% Dextrose",
  "Plasma-Lyte / Isolyte-P",
  "Mannitol 20%",
  "Albumin 5%",
  "Other",
];
VIEWS.newinfusion = function(){
  const d = state.settings;
  return `
  <div class="pagehead"><h1>New Infusion</h1><span class="sub">Set up a clinical infusion session & sync with ESP32</span></div>
  <div class="panel">
    <form id="newInfusionForm">
      <div class="grid2">
        <div class="field"><label>Patient / Case ID (optional)</label><input type="text" id="ni-patient" placeholder="e.g. P-001"></div>
        <div class="field"><label>Ward / Bedside Location (optional)</label><input type="text" id="ni-ward" placeholder="e.g. ICU Bed 4"></div>
      </div>
      <div class="field"><label>Fluid / Solution Type *</label>
        <select id="ni-fluid">${FLUIDS.map(f=>`<option ${f===d.defaultFluid?'selected':''}>${f}</option>`).join('')}</select>
      </div>
      <div class="grid3">
        <div class="field"><label>Prescribed Fluid Volume (mL) *</label><input type="number" id="ni-volume" value="500" min="10"></div>
        <div class="field"><label>Target Infusion Rate (mL/hr) *</label><input type="number" id="ni-rate" value="${d.defaultTargetRate}" min="1"></div>
        <div class="field"><label>IV Set Drop Factor (drops/mL) *</label><input type="number" id="ni-dropfactor" value="${d.defaultDropFactor}" min="1"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Estimated Starting Weight (g, auto from load cell)</label><input type="number" id="ni-startweight" placeholder="e.g. 750 (bag + chamber)"></div>
        <div class="field"><label>Infusion Start Time</label><input type="text" id="ni-starttime" value="${fmtTime(new Date())}" readonly></div>
      </div>
      <div class="field"><label>Clinical Notes</label><textarea id="ni-notes" rows="2" style="width:100%;padding:11px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--ink);"></textarea></div>
      <div class="panel" style="background:var(--blue-tint);border:none;margin-top:4px;">
        <div style="font-size:12px;color:var(--muted);">Expected Target Drop Rate</div>
        <div style="font-size:22px;font-weight:800;" id="ni-expected-drops">40 gtt/min</div>
        <div style="font-size:11px;color:var(--muted);">(Target rate × Drop factor) / 60</div>
      </div>
      <div class="err-msg" id="ni-err">Please fill all required fields with valid positive values.</div>
      <div class="btn-row" style="margin-top:14px;">
        <button type="button" class="btn primary" style="width:auto;padding:11px 22px;" id="ni-start">Start Infusion</button>
        <button type="button" class="btn ghost" style="width:auto;" id="ni-reset">Reset Form</button>
      </div>
    </form>
  </div>`;
};
function bindNewInfusionEvents(){
  function updateExpected(){
    const rate = parseFloat(document.getElementById('ni-rate').value)||0;
    const df = parseFloat(document.getElementById('ni-dropfactor').value)||0;
    document.getElementById('ni-expected-drops').textContent = Math.round((rate*df)/60) + ' gtt/min';
  }
  ['ni-rate','ni-dropfactor'].forEach(id=> document.getElementById(id).addEventListener('input', updateExpected));
  updateExpected();
  document.getElementById('ni-reset').onclick = ()=> switchView('newinfusion');
  document.getElementById('ni-start').onclick = ()=>{
    const volume = parseFloat(document.getElementById('ni-volume').value);
    const rate = parseFloat(document.getElementById('ni-rate').value);
    const df = parseFloat(document.getElementById('ni-dropfactor').value);
    const err = document.getElementById('ni-err');
    if(!volume || volume<=0 || !rate || rate<=0 || !df || df<=0){ err.style.display='block'; return; }
    err.style.display='none';

    // Synchronize parameters with ESP32 Hardware
    sendHardwareCommand(`BAG:${volume}`);
    sendHardwareCommand(`RATE:${rate}`);
    sendHardwareCommand(`START`);

    const session = {
      id: uid('SEC'), patientId: document.getElementById('ni-patient').value.trim() || 'Bedside Patient',
      ward: document.getElementById('ni-ward').value.trim() || 'General Ward', fluid: document.getElementById('ni-fluid').value,
      initialVolume: volume, targetRate: rate, dropFactor: df,
      startWeight: parseFloat(document.getElementById('ni-startweight').value) || volume,
      notes: document.getElementById('ni-notes').value.trim(), startTime: Date.now(),
      status:'NORMAL', delivered:0, battery:100, temperature:28.5,
      opticalRate:0, gravRate:0, dropRate:0, expectedDropRate:Math.round((rate*df)/60),
      deviationPct:0, elapsedSec:0, running:true, completed:false, stopped:false,
      history:[], alerts:[], statusBuf:[],
    };
    state.session = session;
    state.selfCheck = {running:false, done:false, simulateFail:false, results:{}};

    showModal('Infusion Initialized', `Session <b>${session.id}</b> configured for <b>${volume} mL</b> at <b>${rate} mL/hr</b> (${session.expectedDropRate} gtt/min expected). Commands sent to ESP32. Proceed to device self-check before monitoring.`, [
      {label:'Edit', cls:'ghost'},
      {label:'Continue to Self-Check', cls:'primary', onClick:()=> switchView('selfcheck')},
    ]);
  };
}

/* =========================================================================
   3. SELF-CHECK
   ========================================================================= */
const CHECK_ITEMS = [
  {key:'esp32', label:'ESP32 Hardware Telemetry Link', icon:'fa-microchip'},
  {key:'loadcell', label:'HX711 Gravimetric Load Cell Sensor', icon:'fa-weight-scale'},
  {key:'optical', label:'Infrared Phototransistor Optical Drop Sensor', icon:'fa-eye'},
  {key:'i2c', label:'I2C Bus (16x2 LCD & DS3231 RTC)', icon:'fa-clock'},
  {key:'calibration', label:'Load Cell Zero / Tare Calibration Factor', icon:'fa-sliders'},
  {key:'system', label:'System Safety & Alarm Readiness', icon:'fa-circle-check'},
];
VIEWS.selfcheck = function(){
  const sc = state.selfCheck;
  const anyFail = CHECK_ITEMS.some(c=> sc.results[c.key]==='fail');
  return `
  <div class="pagehead"><h1>Device Diagnostics & Self-Check</h1><span class="sub">Hardware sensor verification and bus integrity test</span></div>
  <div class="panel">
    ${CHECK_ITEMS.map(c=>{
      const r = sc.results[c.key];
      const dotClass = !r ? 'pending' : (r==='fail' ? 'fail' : (r==='warn' ? 'warn' : 'pass'));
      const txt = !r ? 'Pending verification…' : (r==='fail' ? 'Failed — check wiring or connect port' : (r==='warn' ? 'Warning — check parameters' : 'Verified OK ✓'));
      return `<div class="check-row"><div class="ci"><i class="fa-solid ${c.icon}"></i></div>
        <div class="ctext"><b>${c.label}</b><span>${txt}</span></div>
        <div class="check-dot ${dotClass}"></div></div>`;
    }).join('')}
    <div style="margin-top:16px;" class="btn-row">
      <button class="btn primary" style="width:auto;padding:10px 20px;" id="runCheckBtn" ${sc.running?'disabled':''}>${sc.running ? 'Running Diagnostic Checks…' : 'Run Diagnostics'}</button>
    </div>
    ${sc.done ? (anyFail ? `
      <div class="status-banner STOPPED" style="margin-top:16px;"><i class="fa-solid fa-triangle-exclamation sbicon"></i><div><b>Diagnostic Warning</b><span>One or more checks did not pass. Check ESP32 connections and retry.</span></div></div>
      <button class="btn" style="margin-top:12px;width:auto;" id="retryCheckBtn">Retry</button>
    ` : `
      <div class="status-banner NORMAL" style="margin-top:16px;"><i class="fa-solid fa-circle-check sbicon"></i><div><b>All Systems Nominal</b><span>Hardware sensors and telemetry verified. Ready for clinical infusion monitoring.</span></div></div>
      <button class="btn primary" style="margin-top:12px;width:auto;padding:10px 20px;" id="continueLiveBtn">Continue to Live Monitoring</button>
    `) : ''}
  </div>`;
};
function bindSelfCheckEvents(){
  const runBtn = document.getElementById('runCheckBtn');
  if(runBtn) runBtn.onclick = ()=>{
    const sc = state.selfCheck;
    sc.running = true; sc.done = false; sc.results = {};
    renderView();
    let i = 0;
    const iv = setInterval(()=>{
      if(i>=CHECK_ITEMS.length){
        clearInterval(iv); sc.running=false; sc.done=true; renderView();
        return;
      }
      const key = CHECK_ITEMS[i].key;
      sc.results[key] = 'pass';
      renderView();
      i++;
    }, 350);
  };
  const retryBtn = document.getElementById('retryCheckBtn');
  if(retryBtn) retryBtn.onclick = ()=>{ state.selfCheck = {running:false, done:false, simulateFail:false, results:{}}; renderView(); };
  const contBtn = document.getElementById('continueLiveBtn');
  if(contBtn) contBtn.onclick = ()=>{ if(state.session) state.session.running = true; switchView('livemonitoring'); };
}

/* =========================================================================
   4. LIVE MONITORING
   ========================================================================= */
VIEWS.livemonitoring = function(){
  const s = state.session;
  if(!s) return `<div class="pagehead"><h1>Live Monitoring</h1></div><div class="panel" style="text-align:center;padding:40px;"><p>No active infusion. <span class="chipbtn" data-action="goto-new" style="cursor:pointer;">Start a new infusion</span></p></div>`;
  const remaining = Math.max(0, s.initialVolume - s.delivered);
  const pct = Math.min(100, Math.round((s.delivered/s.initialVolume)*100));
  const currentActual = Math.round((s.opticalRate+s.gravRate)/2);
  const eta = currentActual > 1 ? fmtDur((remaining / currentActual) * 3600) : '—';

  return `
  <div class="pagehead"><h1>Live Monitoring</h1><span class="sub">${s.id} · ${s.fluid}</span></div>

  <div class="status-banner ${s.status}" id="dyn-status-banner" style="margin-bottom:16px;">
    <i class="fa-solid ${statusIcon(s.status)} sbicon"></i>
    <div><b id="dyn-status-text">${statusText(s.status)}</b><span>Status: ${s.status}</span></div>
    <div style="margin-left:auto;text-align:right;font-size:11.5px;color:inherit;">Elapsed Time<br><b class="mono">${fmtDur(s.elapsedSec)}</b></div>
  </div>

  <div class="grid4" style="margin-bottom:16px;">
    <div class="mini"><div class="mlabel">Target Rate</div><div class="mval"><span id="dyn-target-rate">${s.targetRate}</span><small>mL/hr</small></div></div>
    <div class="mini"><div class="mlabel">Actual Rate</div><div class="mval"><span id="dyn-actual-rate">${currentActual}</span><small>mL/hr</small></div></div>
    <div class="mini"><div class="mlabel">Deviation</div><div class="mval"><span id="dyn-dev">${s.deviationPct>0?'+':''}${s.deviationPct}</span><small>%</small></div></div>
    <div class="mini"><div class="mlabel">Drop Rate</div><div class="mval"><span id="dyn-drop-rate">${s.dropRate}</span><small>gtt/min</small></div></div>
  </div>

  <div class="panel" style="margin-bottom:16px;">
    <div class="panel-head"><h3>Infusion Progress</h3><span class="sub"><span id="dyn-delivered">${Math.round(s.delivered)}</span> / ${s.initialVolume} mL</span></div>
    <div style="height:8px;background:var(--border);border-radius:5px;overflow:hidden;margin-bottom:14px;"><div id="dyn-progress-bar" style="height:100%;width:${pct}%;background:var(--blue);transition:width .3s;"></div></div>
    <div class="grid3">
      <div class="mini"><div class="mlabel">Initial Volume</div><div class="mval">${s.initialVolume}<small>mL</small></div></div>
      <div class="mini"><div class="mlabel">Remaining Volume</div><div class="mval"><span id="dyn-remaining">${Math.round(remaining)}</span><small>mL</small></div></div>
      <div class="mini"><div class="mlabel">Est. Completion</div><div class="mval" style="font-size:15px;">${eta}</div></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:16px;">
    <div class="panel-head"><h3>Clinical Hardware Controls</h3>
      <span class="sub">Hardware commands transmitted directly to ESP32</span>
    </div>
    <div class="btn-row">
      <button class="btn" data-action="hw-pause" ${!s.running?'disabled':''}><i class="fa-solid fa-pause"></i> Pause Infusion</button>
      <button class="btn success" data-action="hw-resume" ${s.running || s.completed || s.stopped?'disabled':''}><i class="fa-solid fa-play"></i> Resume</button>
      <button class="btn danger" data-action="hw-stop" ${s.completed||s.stopped?'disabled':''}><i class="fa-solid fa-stop"></i> Stop & End Session</button>
      <button class="btn" data-action="hw-mute"><i class="fa-solid fa-volume-xmark"></i> Mute Buzzer</button>
      <button class="btn" data-action="sim-testalert"><i class="fa-solid fa-bell"></i> Trigger Test Alert</button>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>Infusion Profile (Expected vs Actual Flow)</h3>
      <div class="btn-row">${['live','5min','15min','full'].map(r=>`<button class="chipbtn ${state.graphRange===r?'active':''}" data-range="${r}">${r==='live'?'Live':r==='full'?'Full Session':'Last '+r}</button>`).join('')}
        <button class="btn sm" data-action="clear-graph">Clear</button></div>
    </div>
    <div class="chartwrap"><canvas id="infusionChart"></canvas></div>
  </div>`;
};

/* ---------------- CHART.JS SETUP ---------------- */
function ensureChart(){
  const canvas = document.getElementById('infusionChart');
  if(!canvas || typeof Chart==='undefined') return;
  const s = state.session; if(!s) return;
  let hist = s.history;
  if(state.graphRange==='5min') hist = hist.filter(h=> h.t >= s.elapsedSec-300);
  else if(state.graphRange==='15min') hist = hist.filter(h=> h.t >= s.elapsedSec-900);
  const labels = hist.map(h=> (h.t/3600).toFixed(2));
  const expected = hist.map(h=> Math.round(h.expectedVolume));
  const actual = hist.map(h=> Math.round(h.actualVolume));
  if(state.chart){ state.chart.destroy(); }
  state.chart = new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{ labels, datasets:[
      {label:'Expected Volume (mL)', data:expected, borderColor:'#2E5FB8', borderDash:[6,4], pointRadius:0, tension:0.15},
      {label:'Actual Volume Delivered (mL)', data:actual, borderColor:'#DC3B3B', pointRadius:0, tension:0.15, borderWidth:2.4},
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      scales:{ x:{title:{display:true,text:'Time (hours)'}}, y:{title:{display:true,text:'Volume (mL)'}, beginAtZero:true} },
      plugins:{ legend:{position:'top'}, tooltip:{mode:'index', intersect:false} },
    }
  });
}

/* =========================================================================
   5. DETAILED PARAMETERS
   ========================================================================= */
VIEWS.parameters = function(){
  const s = state.session;
  if(!s) return `<div class="pagehead"><h1>Detailed Parameters</h1></div><div class="panel" style="text-align:center;padding:40px;">No active infusion session.</div>`;
  const rows = [
    ['Gross Load Cell Mass (g)', Math.round(s.currentWeight||s.startWeight)+' g'],
    ['Initial Starting Weight (g)', Math.round(s.startWeight)+' g'],
    ['Delivered Net Fluid Volume (mL)', Math.round(s.delivered)+' mL'],
    ['Remaining Fluid Volume (mL)', Math.max(0, Math.round(s.initialVolume - s.delivered))+' mL'],
    ['Actual Flow Rate', Math.round((s.opticalRate+s.gravRate)/2)+' mL/hr'],
    ['Target Flow Rate', s.targetRate+' mL/hr'],
    ['Detected Drop Frequency', s.dropRate+' gtt/min (BPM)'],
    ['Expected Drop Frequency', (s.expectedDropRate || Math.round((s.targetRate*s.dropFactor)/60))+' gtt/min'],
    ['Total Drops Counted', (s.totalDrops || 0)+' drops'],
    ['Device Internal Temperature (DS3231)', s.temperature.toFixed(1)+' °C'],
    ['Hardware Link Status', state.hardware.connected ? `Connected (${state.hardware.type==='serial'?'USB':'Wi-Fi'})` : 'Disconnected'],
    ['Phototransistor Raw ADC', (state.hardware.lastOpticalAdc || 2048)+' ADC'],
    ['HX711 Calibration Factor', (state.calibration.loadCell.factor || -420.0).toFixed(3)],
  ];
  return `
  <div class="pagehead"><h1>Detailed Parameters</h1><span class="sub">Live telemetry readings streamed from ESP32 sensors</span></div>
  <div class="panel">
    <table><tbody>
      ${rows.map(r=>`<tr><td style="color:var(--muted);">${r[0]}</td><td style="text-align:right;font-weight:700;" class="mono">${r[1]}</td></tr>`).join('')}
    </tbody></table>
  </div>`;
};

/* =========================================================================
   6. ALERTS & NOTIFICATIONS
   ========================================================================= */
VIEWS.alerts = function(){
  const s = state.session;
  const all = s ? s.alerts : [];
  const list = state.alertFilter==='All' ? all : all.filter(a=>a.severity===state.alertFilter);
  return `
  <div class="pagehead"><h1>Alerts & Notifications</h1><span class="sub">${unreadAlertCount()} unread of ${all.length}</span></div>
  <div class="filter-row">
    ${['All','Critical','Warning','Info'].map(f=>`<button class="chipbtn ${state.alertFilter===f?'active':''}" data-alertfilter="${f}">${f}</button>`).join('')}
    <button class="btn sm" style="margin-left:auto;" data-action="mark-all-read">Mark all as read</button>
    <button class="btn sm danger" data-action="clear-alerts">Clear history</button>
  </div>
  <div class="panel">
    ${list.length ? list.map(a=>alertRowHtml(a)).join('') : '<p style="color:var(--muted);font-size:13px;">No alerts in this category.</p>'}
  </div>`;
};

/* =========================================================================
   7. INFUSION HISTORY
   ========================================================================= */
VIEWS.history = function(){
  let list = state.history.filter(h=>{
    const q = state.historySearch.toLowerCase();
    const matchesQ = !q || h.id.toLowerCase().includes(q) || (h.patientId||'').toLowerCase().includes(q);
    const matchesStatus = state.historyStatusFilter==='All' || h.finalStatus===state.historyStatusFilter;
    return matchesQ && matchesStatus;
  });
  list.sort((a,b)=> state.historySort==='newest' ? b.startTime-a.startTime : a.startTime-b.startTime);
  return `
  <div class="pagehead"><h1>Infusion History</h1><span class="sub">${list.length} session(s)</span></div>
  <div class="filter-row">
    <div class="search-box"><i class="fa-solid fa-magnifying-glass"></i><input type="text" id="historySearchInput" placeholder="Search by session or patient ID..." value="${state.historySearch}"></div>
    <select class="seg" id="historyStatusSelect" style="border:1px solid var(--border);border-radius:9px;padding:7px 10px;">
      ${['All','Completed','Stopped Early','Interrupted'].map(st=>`<option ${state.historyStatusFilter===st?'selected':''}>${st}</option>`).join('')}
    </select>
    <select class="seg" id="historySortSelect" style="border:1px solid var(--border);border-radius:9px;padding:7px 10px;">
      <option value="newest" ${state.historySort==='newest'?'selected':''}>Newest first</option>
      <option value="oldest" ${state.historySort==='oldest'?'selected':''}>Oldest first</option>
    </select>
  </div>
  <div class="panel">
    <table><thead><tr><th>Session</th><th>Patient</th><th>Volume / Rate</th><th>Start</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(h=>`<tr>
      <td class="rowlink" data-open-history="${h.id}">${h.id}</td><td>${h.patientId||'—'}</td>
      <td>${h.initialVolume} mL @ ${h.targetRate} mL/hr</td><td>${fmtDateTime(h.startTime)}</td>
      <td><span class="pill ${h.finalStatus}">${h.finalStatus}</span></td>
      <td><button class="btn sm danger" data-delete-history="${h.id}">Delete</button></td>
    </tr>`).join('')}</tbody></table>
    ${!list.length ? '<p style="color:var(--muted);font-size:13px;padding:10px 0;">No matching sessions.</p>' : ''}
  </div>`;
};

/* =========================================================================
   8. REPORTS & EXPORT
   ========================================================================= */
VIEWS.reports = function(){
  const s = state.session;
  const summarySession = (s && (s.completed||s.stopped)) ? s : null;
  const latest = state.history[0];
  const target = summarySession || (latest ? {id:latest.id, patientId:latest.patientId, ward:latest.ward, fluid:latest.fluid,
    startTime:latest.startTime, endTime:latest.endTime, initialVolume:latest.initialVolume, delivered:latest.delivered,
    targetRate:latest.targetRate, history:latest.history, alerts:latest.alerts, elapsedSec:latest.durationSec,
    avgActualRate:latest.avgActualRate, totalAlerts:latest.totalAlerts, noDropEvents:latest.noDropEvents, finalStatus:latest.finalStatus} : null);
  return `
  <div class="pagehead"><h1>Reports & Export</h1><span class="sub">Generated from real recorded telemetry session data</span></div>
  ${target ? `
  <div class="panel" style="margin-bottom:16px;">
    <div class="panel-head"><h3>Infusion Summary — ${target.id}</h3><span class="pill ${target.finalStatus||target.status}">${target.finalStatus||target.status}</span></div>
    <div class="grid4">
      <div class="mini"><div class="mlabel">Initial Volume</div><div class="mval">${target.initialVolume}<small>mL</small></div></div>
      <div class="mini"><div class="mlabel">Delivered Volume</div><div class="mval">${Math.round(target.delivered)}<small>mL</small></div></div>
      <div class="mini"><div class="mlabel">Target Rate</div><div class="mval">${target.targetRate}<small>mL/hr</small></div></div>
      <div class="mini"><div class="mlabel">Avg. Actual Rate</div><div class="mval">${target.avgActualRate || Math.round((s?((s.opticalRate+s.gravRate)/2):0))}<small>mL/hr</small></div></div>
      <div class="mini"><div class="mlabel">Duration</div><div class="mval" style="font-size:15px;">${fmtDur(target.elapsedSec)}</div></div>
      <div class="mini"><div class="mlabel">Total Alerts</div><div class="mval">${target.totalAlerts ?? target.alerts.length}</div></div>
      <div class="mini"><div class="mlabel">Patient / Bedside</div><div class="mval" style="font-size:14px;">${target.patientId||'—'} ${target.ward?'· '+target.ward:''}</div></div>
      <div class="mini"><div class="mlabel">Solution Type</div><div class="mval" style="font-size:13px;">${target.fluid||'Normal Saline'}</div></div>
    </div>
    <div class="btn-row" style="margin-top:16px;">
      <button class="btn" data-action="goto-live"><i class="fa-solid fa-chart-line"></i> View Graph</button>
      <button class="btn primary" style="width:auto;" data-action="export-pdf"><i class="fa-solid fa-file-pdf"></i> Download PDF Report</button>
      <button class="btn" data-action="export-csv"><i class="fa-solid fa-file-csv"></i> Export CSV</button>
      <button class="btn" data-action="export-png"><i class="fa-solid fa-image"></i> Save Graph as PNG</button>
      <button class="btn" data-action="print-report"><i class="fa-solid fa-print"></i> Print Report</button>
      <button class="btn success" data-action="goto-new"><i class="fa-solid fa-plus"></i> Start New Infusion</button>
    </div>
  </div>` : `<div class="panel" style="text-align:center;padding:36px;">No session data yet — complete or stop an infusion to generate a report.</div>`}
  <div class="panel">
    <div class="panel-head"><h3>All sessions — bulk export</h3></div>
    <p style="font-size:12.5px;color:var(--muted);">Exports use the actual recorded hardware history for each session — accurate clinical telemetry.</p>
    <button class="btn" data-action="export-all-csv"><i class="fa-solid fa-download"></i> Export All History (CSV)</button>
  </div>`;
};

/* =========================================================================
   9. CALIBRATION & DROP SEISMOGRAPH
   ========================================================================= */
VIEWS.calibration = function(){
  const c = state.calibration;
  return `
  <div class="pagehead"><h1>Hardware Calibration & Drop Seismograph</h1><span class="sub">Direct hardware calibration and real-time optical pulse waveform</span></div>
  
  <!-- Real Drop Seismograph Oscillogram Canvas -->
  <div class="panel" style="margin-bottom:16px;">
    <div class="panel-head">
      <h3><i class="fa-solid fa-wave-square" style="color:var(--cyan);margin-right:6px;"></i> Live IR Optical Drop Seismograph</h3>
      <span class="pill green mono">250 Hz Waveform</span>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:10px;">Visualizing infrared optical disturbance caused by drops falling through the drip chamber.</p>
    <div class="seismic-canvas-wrap">
      <canvas id="seismicCanvas" width="800" height="220"></canvas>
    </div>
    <div class="seismic-legend">
      <div class="seismic-leg-item"><div class="leg-box" style="background:#38BDF8;"></div> IR Optical Disturbance Wave</div>
      <div class="seismic-leg-item"><div class="leg-box" style="background:rgba(255,255,255,0.4);"></div> Dynamic Baseline (<span id="lblBaseVal">2048</span>)</div>
      <div class="seismic-leg-item"><div class="leg-box" style="background:#F59E0B;"></div> Drop Trigger Threshold (±150)</div>
    </div>
  </div>

  <div class="grid2">
    <!-- Load Cell Calibration -->
    <div class="panel">
      <div class="panel-head"><h3>HX711 Load Cell Calibration</h3><span class="pill ${c.loadCell.done?'green':'amber'}">${c.loadCell.done?'Calibrated':'Factory Baseline'}</span></div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Place known test weight (e.g. 500g) on hook and transmit calibration factors to ESP32.</p>
      <div class="field"><label>Known Calibration Weight (g)</label><input type="number" id="cal-weight" value="${c.loadCell.knownWeight}"></div>
      <div class="mini" style="margin-bottom:12px;"><div class="mlabel">Live Load Cell Gross Reading</div><div class="mval mono" id="cal-gross-val">${state.session ? Math.round(state.session.currentWeight||0)+' g' : '—'}</div></div>
      <div class="btn-row">
        <button class="btn" id="cal-tare-btn"><i class="fa-solid fa-scale-unbalanced"></i> Tare / Zero Hook</button>
        <button class="btn primary" id="cal-apply-btn" style="width:auto;"><i class="fa-solid fa-check"></i> Calibrate Factor</button>
      </div>
      <p style="font-size:11.5px;color:var(--muted);margin-top:10px;">Last calibrated: ${c.loadCell.lastDate ? fmtDateTime(c.loadCell.lastDate) : 'Default Factory'} · Active Factor: ${c.loadCell.factor.toFixed(3)}</p>
    </div>

    <!-- Optical Drop Sensor Calibration -->
    <div class="panel">
      <div class="panel-head"><h3>Optical Drop Sensor Threshold</h3><span class="pill green">Active</span></div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Inspect real-time ADC levels from GPIO 34 phototransistor.</p>
      <div class="mini" style="margin-bottom:12px;"><div class="mlabel">Raw Phototransistor ADC</div><div class="mval mono" id="cal-opt-reading">${state.hardware.lastOpticalAdc || 2048} ADC</div></div>
      <div class="field"><label>Software Sensitivity Threshold</label><input type="range" min="20" max="300" value="${c.optical.sensitivity || 150}" id="cal-sensitivity"></div>
      <div class="btn-row">
        <button class="btn primary" id="cal-save-opt" style="width:auto;">Save Sensitivity</button>
        <button class="btn" id="cal-ping-btn"><i class="fa-solid fa-arrows-rotate"></i> Ping ESP32</button>
      </div>
    </div>
  </div>`;
};

function drawSeismicOscillogram() {
  const canvas = document.getElementById('seismicCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#060d17';
  ctx.fillRect(0, 0, w, h);

  // Draw Grid Lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // Draw Dynamic Baseline (Midline)
  const midY = h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw Waveform
  const wave = state.hardware.opticalWaveHistory;
  if (wave.length > 1) {
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    const step = w / 300;
    for (let i = 0; i < wave.length; i++) {
      const dev = wave[i] - 2048;
      const y = midY - (dev * 0.4);
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const lblBase = document.getElementById('lblBaseVal');
  if (lblBase) lblBase.textContent = state.hardware.lastOpticalAdc || 2048;
}

function bindCalibrationEvents(){
  const c = state.calibration;
  document.getElementById('cal-tare-btn').onclick = ()=>{
    sendHardwareCommand('TARE');
    showToast('Tare Command Sent', 'ESP32 hook zeroed.', 'Info');
  };
  document.getElementById('cal-apply-btn').onclick = ()=>{
    const known = parseFloat(document.getElementById('cal-weight').value)||500;
    sendHardwareCommand(`CAL:${known}`);
    c.loadCell.done = true;
    c.loadCell.lastDate = Date.now();
    saveCalibration();
    showToast('Calibration Transmitted', `Calibration factor for ${known}g sent to ESP32.`, 'Info');
  };
  document.getElementById('cal-save-opt').onclick = ()=>{
    c.optical.sensitivity = +document.getElementById('cal-sensitivity').value;
    c.optical.done = true;
    c.optical.lastDate = Date.now();
    saveCalibration();
    showToast('Sensitivity Saved', 'Optical trigger threshold updated.', 'Info');
  };
  document.getElementById('cal-ping-btn').onclick = ()=>{
    sendHardwareCommand('PING');
    showToast('Hardware Ping', 'Ping transmitted to ESP32.', 'Info');
  };
}

/* =========================================================================
   10. SETTINGS & ABOUT
   ========================================================================= */
VIEWS.settings = function(){
  const d = state.settings;
  return `
  <div class="pagehead"><h1>Settings & Network Configuration</h1></div>
  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>Hardware & Telemetry Link</h3></div>
    <div class="field-row"><div class="flabel">Device Name</div><input type="text" id="set-devname" value="${d.deviceName}" style="max-width:220px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">Device ID</div><input type="text" id="set-devid" value="${d.deviceId}" style="max-width:220px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">ESP32 Wi-Fi Hub IP</div><input type="text" id="set-espip" value="${d.espIp || '192.168.4.1'}" style="max-width:220px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">Hardware Connection Status</div><span class="pill ${state.hardware.connected?'green':'red'}">${state.hardware.connected?'Connected':'Disconnected'}</span></div>
  </div>
  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>Infusion Parameters (defaults)</h3></div>
    <div class="field-row"><div class="flabel">Default Drop Factor</div><input type="number" id="set-dropfactor" value="${d.defaultDropFactor}" style="width:90px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">Default Fluid Type</div><select id="set-fluid">${FLUIDS.map(f=>`<option ${f===d.defaultFluid?'selected':''}>${f}</option>`).join('')}</select></div>
    <div class="field-row"><div class="flabel">Default Target Rate (mL/hr)</div><input type="number" id="set-rate" value="${d.defaultTargetRate}" style="width:90px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
  </div>
  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>Clinical Alert Thresholds</h3></div>
    <div class="field-row"><div class="flabel">Max Flow Deviation (%)</div><input type="number" id="set-maxdev" value="${d.maxDeviation}" style="width:80px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">Min Flow Deviation (%)</div><input type="number" id="set-mindev" value="${d.minDeviation}" style="width:80px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <div class="field-row"><div class="flabel">No-Drop Timeout (sec)</div><input type="number" id="set-nodroptimeout" value="${d.noDropTimeout}" style="width:80px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);"></div>
    <button class="btn primary" style="width:auto;margin-top:10px;" id="saveThresholdsBtn">Save Settings</button>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>General UI</h3></div>
    <div class="field-row"><div class="flabel">Dark Mode</div><div class="switch ${d.theme==='dark'?'on':''}" id="toggleThemeSetting"><div class="knob"></div></div></div>
    <div class="field-row"><div class="flabel">Sound Notifications</div><div class="switch ${d.soundOn?'on':''}" id="toggleSound"><div class="knob"></div></div></div>
    <div class="field-row"><div class="flabel">Clear local storage data</div><button class="btn danger" id="clearDataBtn">Clear Data</button></div>
  </div>`;
};

VIEWS.about = function(){
  return `
  <div class="pagehead"><h1>About SECURE-IV</h1></div>
  <div class="panel">
    <div class="about-logo"><img src="${LOGO_SRC}"><div><b>SECURE-IV</b><div style="font-size:12.5px;color:var(--muted);">Every Drop Matters — Clinical Gravity IV Infusion Monitor</div></div></div>
    <table><tbody>
      <tr><td style="color:var(--muted);">Hardware Controller</td><td>ESP32 Dual-Core Telemetry Hub</td></tr>
      <tr><td style="color:var(--muted);">Drop Sensor</td><td>GPIO 34 Analog Infrared Phototransistor (250 Hz)</td></tr>
      <tr><td style="color:var(--muted);">Gravimetric Sensor</td><td>HX711 24-bit ADC Load Cell (DOUT 12, SCK 14)</td></tr>
      <tr><td style="color:var(--muted);">Display & RTC</td><td>16x2 I2C LCD (0x27) + DS3231 RTC (0x68)</td></tr>
      <tr><td style="color:var(--muted);">Active Sessions Logged</td><td>${state.history.length}</td></tr>
    </tbody></table>
  </div>
  <div class="panel" style="margin-top:16px;">
    <div class="disclaimer-box">
      <b>Medical device disclaimer:</b> SECURE-IV is a clinical gravity-based IV infusion monitoring platform designed for real-time drop detection, continuous flow rate monitoring, gravimetric net depletion calculation, and pre-empty nurse alerts.
    </div>
  </div>`;
};

/* =========================================================================
   PER-VIEW EVENT BINDING
   ========================================================================= */
function bindViewEvents(view){
  if(view==='newinfusion') bindNewInfusionEvents();
  if(view==='selfcheck') bindSelfCheckEvents();
  if(view==='calibration') bindCalibrationEvents();
  if(view==='settings') bindSettingsEvents();

  if(view==='livemonitoring'){
    document.querySelectorAll('[data-range]').forEach(b=> b.onclick = ()=>{ state.graphRange = b.dataset.range; renderView(); });
  }

  if(view==='alerts'){
    document.querySelectorAll('[data-alertfilter]').forEach(b=> b.onclick = ()=>{ state.alertFilter = b.dataset.alertfilter; renderView(); });
    document.querySelectorAll('[data-alert-id]').forEach(el=> el.onclick = ()=>{
      const s = state.session; const a = s.alerts.find(x=>x.id===el.dataset.alertId);
      if(a){ a.read = true; renderView(); }
    });
  }

  if(view==='history'){
    const si = document.getElementById('historySearchInput');
    if(si) si.oninput = ()=>{ state.historySearch = si.value; renderView(); const el=document.getElementById('historySearchInput'); if(el){el.focus(); el.selectionStart=el.selectionEnd=el.value.length;} };
    const ss = document.getElementById('historyStatusSelect');
    if(ss) ss.onchange = ()=>{ state.historyStatusFilter = ss.value; renderView(); };
    const so = document.getElementById('historySortSelect');
    if(so) so.onchange = ()=>{ state.historySort = so.value; renderView(); };
    document.querySelectorAll('[data-open-history]').forEach(el=> el.onclick = ()=>{
      const h = state.history.find(x=>x.id===el.dataset.openHistory);
      showModal('Session '+h.id, `${h.initialVolume} mL @ ${h.targetRate} mL/hr — ${h.finalStatus}<br>Delivered: ${Math.round(h.delivered)} mL · Duration: ${fmtDur(h.durationSec)} · Alerts: ${h.totalAlerts}`, [{label:'Close'}]);
    });
    document.querySelectorAll('[data-delete-history]').forEach(el=> el.onclick = ()=> confirmModal('Delete session?','This cannot be undone.', ()=>{
      state.history = state.history.filter(x=>x.id!==el.dataset.deleteHistory); saveHistory(); renderView();
    }));
  }
}

function bindSettingsEvents(){
  document.getElementById('toggleThemeSetting').onclick = toggleTheme;
  document.getElementById('toggleSound').onclick = ()=>{ state.settings.soundOn = !state.settings.soundOn; saveSettings(); renderView(); };
  document.getElementById('saveThresholdsBtn').onclick = ()=>{
    const d = state.settings;
    d.defaultDropFactor = +document.getElementById('set-dropfactor').value;
    d.defaultFluid = document.getElementById('set-fluid').value;
    d.defaultTargetRate = +document.getElementById('set-rate').value;
    d.maxDeviation = +document.getElementById('set-maxdev').value;
    d.minDeviation = +document.getElementById('set-mindev').value;
    d.noDropTimeout = +document.getElementById('set-nodroptimeout').value;
    d.deviceName = document.getElementById('set-devname').value;
    d.deviceId = document.getElementById('set-devid').value;
    d.espIp = document.getElementById('set-espip').value;
    saveSettings();
    showToast('Settings saved','Configuration applied and saved to browser.', 'Info');
  };
  document.getElementById('clearDataBtn').onclick = ()=> confirmModal('Clear local application data?','This deletes all saved history and configuration from this browser.', ()=>{
    localStorage.clear(); location.reload();
  });
}

function finalizeSession(finalStatusLabel){
  const s = state.session; if(!s) return;
  const record = {
    id:s.id, patientId:s.patientId, ward:s.ward, fluid:s.fluid, startTime:s.startTime, endTime:Date.now(),
    initialVolume:s.initialVolume, delivered:Math.round(s.delivered), targetRate:s.targetRate,
    avgActualRate: s.history.length ? Math.round(s.history.reduce((a,h)=>a+h.actualRate,0)/s.history.length) : s.targetRate,
    durationSec:s.elapsedSec, totalAlerts:s.alerts.length, noDropEvents:s.alerts.filter(a=>a.title.includes('No drops')).length,
    finalStatus: finalStatusLabel, history:s.history.slice(), alerts:s.alerts.slice(),
  };
  state.history.unshift(record); saveHistory();
}

/* =========================================================================
   EXPORTS & DOWNLOADS
   ========================================================================= */
function activeOrLatestTarget(){
  const s = state.session;
  if(s && (s.completed || s.stopped)) return s;
  if(state.history[0]){
    const h = state.history[0];
    return {id:h.id, patientId:h.patientId, ward:h.ward, fluid:h.fluid, initialVolume:h.initialVolume, delivered:h.delivered,
      targetRate:h.targetRate, history:h.history, alerts:h.alerts, elapsedSec:h.durationSec, startTime:h.startTime, endTime:h.endTime, finalStatus:h.finalStatus};
  }
  return s || null;
}
function safeISO(ts){ try{ return new Date(ts||Date.now()).toISOString(); }catch(e){ return new Date().toISOString(); } }
function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}
function exportCSV(){
  const t = activeOrLatestTarget(); if(!t){ showToast('Export CSV','No session data available.','Warning'); return; }
  const rows = [['Timestamp','Elapsed (s)','Expected Volume (mL)','Actual Volume (mL)','Expected Rate (mL/hr)','Actual Rate (mL/hr)','Drop Rate (gtt/min)','Est. Weight (g)','Status']];
  t.history.forEach(h=> rows.push([safeISO(h.time), h.t, Math.round(h.expectedVolume), Math.round(h.actualVolume), h.expectedRate, h.actualRate, h.dropRate, h.weight, h.status]));
  const csv = rows.map(r=> r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  downloadBlob((t.id||'secureiv')+'_data.csv', new Blob([csv],{type:'text/csv'}));
}
function exportAllHistoryCSV(){
  if(!state.history.length){ showToast('Export','No completed sessions yet.','Warning'); return; }
  const rows = [['Session','Patient','Fluid','Initial Volume','Target Rate','Avg Actual Rate','Duration (s)','Total Alerts','Status','Start','End']];
  state.history.forEach(h=> rows.push([h.id, h.patientId||'', h.fluid, h.initialVolume, h.targetRate, h.avgActualRate, h.durationSec, h.totalAlerts, h.finalStatus, safeISO(h.startTime), safeISO(h.endTime)]));
  const csv = rows.map(r=> r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  downloadBlob('secureiv_all_sessions.csv', new Blob([csv],{type:'text/csv'}));
}
function exportPNG(){
  if(!state.chart){ showToast('Save graph','Open Live Monitoring with an active or recent session first.','Warning'); return; }
  const a = document.createElement('a'); a.href = state.chart.toBase64Image(); a.download = 'secureiv_infusion_graph.png'; a.click();
}
function exportPDF(){
  const t = activeOrLatestTarget(); if(!t){ showToast('Export PDF','No session data available.','Warning'); return; }
  if(typeof window.jspdf==='undefined'){ showToast('Export PDF','PDF library loading...', 'Warning'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  try{ doc.addImage(LOGO_SRC, 'PNG', 14, 10, 42, 15); }catch(e){}
  doc.setFontSize(14); doc.text('SECURE-IV — Clinical Infusion Report', 60, 20);
  doc.setFontSize(10);
  const info = [
    ['Session ID', t.id], ['Patient / Case ID', t.patientId||'—'], ['Ward', t.ward||'—'], ['Fluid', t.fluid||'—'],
    ['Initial Volume', t.initialVolume+' mL'], ['Delivered Volume', Math.round(t.delivered)+' mL'],
    ['Target Rate', t.targetRate+' mL/hr'], ['Status', t.finalStatus||t.status], ['Total Alerts', (t.alerts||[]).length],
  ];
  doc.autoTable({ startY: 32, head:[['Field','Value']], body: info, theme:'grid', styles:{fontSize:9} });
  if(state.chart){
    try{ doc.addImage(state.chart.toBase64Image(), 'PNG', 14, doc.lastAutoTable.finalY+8, 180, 90); }catch(e){}
  }
  doc.setFontSize(8); doc.text('SECURE-IV Clinical Gravity IV Infusion Monitoring System', 14, 285);
  doc.save((t.id||'secureiv')+'_report.pdf');
}
function printReport(){ window.print(); }

/* =========================================================================
   GLOBAL CLICK DELEGATION
   ========================================================================= */
document.addEventListener('click', (e)=>{
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const a = el.dataset.action;
  if(a==='goto-new') switchView('newinfusion');
  else if(a==='goto-live') switchView('livemonitoring');
  else if(a==='goto-alerts') switchView('alerts');
  else if(a==='goto-history') switchView('history');
  else if(a==='hw-pause'){
    if (state.session) state.session.running = false;
    sendHardwareCommand('PAUSE');
    renderView();
  }
  else if(a==='hw-resume'){
    if (state.session) state.session.running = true;
    sendHardwareCommand('RESUME');
    renderView();
  }
  else if(a==='hw-stop'){
    confirmModal('Stop infusion?','This ends the current session and transmits STOP to ESP32.', ()=>{
      const s = state.session;
      if (s) { s.running=false; s.stopped=true; s.status='STOPPED'; }
      sendHardwareCommand('STOP');
      finalizeSession(s && s.delivered < s.initialVolume*0.98 ? 'Stopped Early' : 'Completed');
      switchView('reports');
    });
  }
  else if(a==='hw-mute'){
    sendHardwareCommand('MUTE');
    showToast('Buzzer Mute', 'Mute toggle command sent to ESP32.', 'Info');
  }
  else if(a==='sim-testalert'){ pushAlert('Test Alert Triggered','This is a verification alert to test UI notification response.','Info'); renderView(); }
  else if(a==='mark-all-read'){ if(state.session) state.session.alerts.forEach(x=>x.read=true); renderView(); }
  else if(a==='clear-alerts'){ confirmModal('Clear alert history?','This removes all alerts for current session.', ()=>{ if(state.session) state.session.alerts=[]; renderView(); }); }
  else if(a==='clear-graph'){ confirmModal('Clear graph?','This clears recorded points for the active session graph.', ()=>{ if(state.session) state.session.history=[]; renderView(); }); }
  else if(a==='export-csv') exportCSV();
  else if(a==='export-all-csv') exportAllHistoryCSV();
  else if(a==='export-png') exportPNG();
  else if(a==='export-pdf') exportPDF();
  else if(a==='print-report') printReport();
});

/* =========================================================================
   INITIALIZATION
   ========================================================================= */
renderLogin();
