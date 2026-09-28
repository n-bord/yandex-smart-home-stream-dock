'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LOG_FILE = path.join(__dirname, 'backend.log');
const LEGACY_PLUGIN_DATA_DIR = process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support', 'Yandex Smart Home Stream Dock') : __dirname;
const PLUGIN_DATA_DIR = process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support', 'n-bord Yandex Smart Home Stream Dock') : __dirname;
function migrateLegacyPluginDataDir() {
  if (!process.env.HOME || PLUGIN_DATA_DIR === LEGACY_PLUGIN_DATA_DIR) return;
  try {
    if (!fs.existsSync(PLUGIN_DATA_DIR) && fs.existsSync(LEGACY_PLUGIN_DATA_DIR)) {
      fs.renameSync(LEGACY_PLUGIN_DATA_DIR, PLUGIN_DATA_DIR);
    }
  } catch (_) {
    try {
      fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
      for (const name of ['sensor-history.json','usage-stats.json']) {
        const src=path.join(LEGACY_PLUGIN_DATA_DIR,name), dst=path.join(PLUGIN_DATA_DIR,name);
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src,dst);
      }
    } catch (_) {}
  }
}
migrateLegacyPluginDataDir();
const SENSOR_HISTORY_DIR = PLUGIN_DATA_DIR;
const SENSOR_HISTORY_FILE = path.join(SENSOR_HISTORY_DIR, 'sensor-history.json');
const USAGE_STATS_FILE = path.join(SENSOR_HISTORY_DIR, 'usage-stats.json');
const SENSOR_HISTORY_MAX_MS = 26 * 60 * 60 * 1000;
const SENSOR_HISTORY_MIN_SAMPLE_MS = 60 * 1000;
let sensorHistoryStore = null;
let sensorHistorySaveTimer = null;
let usageStatsStore = null;
let usageStatsSaveTimer = null;
let usageStatsMtime = 0;
const usageStatsThrottle = new Map();
let debugLoggingEnabled = false;
function logPart(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}
function appendLogLine(parts) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${parts.map(logPart).join(' ')}\n`
    );
  } catch (_) {}
}
function logLine(...parts) {
  // Обычный подробный журнал пишется только в режиме отладки.
  if (!debugLoggingEnabled) return;
  appendLogLine(parts);
}
function errorLine(...parts) {
  // Ошибки пишем всегда, даже когда режим отладки выключен.
  appendLogLine(['ERROR', ...parts]);
}
function debugLine(...parts) {
  logLine('DEBUG', ...parts);
}

process.on('uncaughtException', err => {
  errorLine('UNCAUGHT_EXCEPTION', err);
  console.error('Uncaught exception:', err);
  setTimeout(() => process.exit(1), 25).unref();
});
process.on('unhandledRejection', reason => {
  errorLine('UNHANDLED_REJECTION', reason instanceof Error ? reason : String(reason));
  console.error('Unhandled rejection:', reason);
});

const ACTION_TOGGLE = 'com.yandex.smarthome.streamdock.toggle';
const ACTION_LIGHT_POWER = 'com.yandex.smarthome.streamdock.light.power';
const ACTION_BRIGHTNESS = 'com.yandex.smarthome.streamdock.brightness';
const ACTION_SENSOR = 'com.yandex.smarthome.streamdock.sensor';
const ACTION_SENSOR_MULTI = 'com.yandex.smarthome.streamdock.sensor.multi';
const ACTION_CURTAIN = 'com.yandex.smarthome.streamdock.curtain';
const ACTION_VACUUM_SPEED = 'com.yandex.smarthome.streamdock.vacuum.speed';
const ACTION_CLIMATE_MODE = 'com.yandex.smarthome.streamdock.climate.mode';
const ACTION_KETTLE_TEMP = 'com.yandex.smarthome.streamdock.kettle.temperature';
const ACTION_LIGHT_TEMP = 'com.yandex.smarthome.streamdock.light.temperature';
const ACTION_LIGHT_COLOR_DIAL = 'com.yandex.smarthome.streamdock.light.color.dial';
const ACTION_LIGHT_COLOR = 'com.yandex.smarthome.streamdock.light.color';
const ACTION_LIGHT_PRESET = 'com.yandex.smarthome.streamdock.light.preset';
const ACTION_MEDIA_VOLUME = 'com.yandex.smarthome.streamdock.media.volume';
const ACTION_MEDIA_CHANNEL = 'com.yandex.smarthome.streamdock.media.channel';
const ACTION_DASHBOARD = 'com.yandex.smarthome.streamdock.dashboard';
const ACTION_MEDIA = 'com.yandex.smarthome.streamdock.media.command';
const ACTION_SCENARIO = 'com.yandex.smarthome.streamdock.scenario';
const ACTIONS = new Set([
  ACTION_TOGGLE, ACTION_LIGHT_POWER, ACTION_BRIGHTNESS, ACTION_SENSOR, ACTION_SENSOR_MULTI, ACTION_CURTAIN,
  ACTION_VACUUM_SPEED, ACTION_CLIMATE_MODE, ACTION_KETTLE_TEMP, ACTION_LIGHT_TEMP, ACTION_LIGHT_COLOR_DIAL,
  ACTION_LIGHT_COLOR, ACTION_LIGHT_PRESET, ACTION_MEDIA_VOLUME, ACTION_MEDIA_CHANNEL, ACTION_DASHBOARD, ACTION_MEDIA, ACTION_SCENARIO
]);
const YANDEX_API = 'https://api.iot.yandex.net/v1.0';
const CAP_ONOFF = 'devices.capabilities.on_off';
const CAP_RANGE = 'devices.capabilities.range';
const CAP_MODE = 'devices.capabilities.mode';
const CAP_TOGGLE = 'devices.capabilities.toggle';
const CAP_COLOR = 'devices.capabilities.color_setting';
const PROP_FLOAT = 'devices.properties.float';
const PROP_EVENT = 'devices.properties.event';

const PORT = Number(process.argv[3]);
const PLUGIN_UUID = process.argv[5];
const REGISTER_EVENT = process.argv[7];

class LocalWebSocket {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.key = crypto.randomBytes(16).toString('base64');
    this.listeners = { open: [], message: [], close: [], error: [] };
  }

  on(name, fn) {
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
    return this;
  }

  emit(name, value) {
    for (const fn of this.listeners[name] || []) {
      try { fn(value); } catch (e) { errorLine('LISTENER_ERROR', e); console.error(e); }
    }
  }

  connect() {
    this.socket = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
      const request = [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1:' + this.port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + this.key,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ].join('\r\n');
      this.socket.write(request);
    });

    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.handshakeDone) this._consumeHandshake();
      if (this.handshakeDone) this._consumeFrames();
    });
    this.socket.on('error', (e) => this.emit('error', e));
    this.socket.on('close', () => this.emit('close'));
  }

  _consumeHandshake() {
    const marker = this.buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const header = this.buffer.subarray(0, marker).toString('utf8');
    this.buffer = this.buffer.subarray(marker + 4);
    const accept = header.split(/\r\n/).find(x => /^Sec-WebSocket-Accept:/i.test(x));
    const expected = crypto.createHash('sha1')
      .update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    if (!accept || accept.split(':').slice(1).join(':').trim() !== expected) {
      this.emit('error', new Error('Некорректный WebSocket handshake Stream Dock'));
      this.socket.destroy();
      return;
    }
    this.handshakeDone = true;
    this.emit('open');
  }

  _consumeFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0) throw new Error('WebSocket frame too large');
        length = low;
        offset = 10;
      }

      const masked = Boolean(b1 & 0x80);
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const maskStart = offset - 4;
        const mask = this.buffer.subarray(maskStart, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
      else if (opcode === 0x8) {
        this._sendFrame(0x8, Buffer.alloc(0));
        this.socket.end();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xA, payload);
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || !this.handshakeDone) return;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(body.length, 6);
    }
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj) {
    this._sendFrame(0x1, JSON.stringify(obj));
  }
}

const ws = new LocalWebSocket(PORT);
const settingsByContext = Object.create(null);
const actionByContext = Object.create(null);
const visibleContexts = new Set();
const togglingContexts = new Set();
const brightnessRuntime = new Map();
const curtainRuntime = new Map();
const rangeRuntime = new Map();
const colorTempRuntime = new Map();
const colorDialRuntime = new Map();
const modeRuntime = new Map();
const combinedRuntime = new Map();
const sensorMultiDialRuntime = new Map();
const sensorMultiDialContexts = new Set();
const informationContexts = new Set();
const scenarioDialContexts = new Set();
const scenarioDialRuntime = new Map();
const targetPresence = new Map();

const DEFAULT_ACTION_REFRESH_SECONDS = 30;
const ACTION_REFRESH_SECONDS = new Set([0, 15, 30, 45, 60, 120, 300]);
const ACTION_REFRESH_STAGGER_MS = 120;

let actionRefreshTimer = null;
let globalSettings = { token: '', tokenExpiresAt: 0, tokenLifetimeSeconds: 0, tokenExpiryCapturedAt: 0, actionRefreshSeconds: DEFAULT_ACTION_REFRESH_SECONDS };
let globalSettingsReady = false;
let userInfoCache = { token: '', at: 0, data: null };
let userInfoInFlight = { token: '', promise: null };
let dashboardDataCache = { token: '', at: 0, data: null };
let dashboardPresenceCache = { token: '', at: 0, devices: [], groups: [] };

function targetStatusKey(targetType, id) { return `${targetType === 'group' ? 'group' : 'device'}:${String(id || '')}`; }
function noteTargetPresence(targetType, id, online) {
  const key=targetStatusKey(targetType,id), now=Date.now(), prev=targetPresence.get(key)||{lastOnline:0,offlineSince:0,online:null,checkedAt:0};
  if(online===true){prev.online=true;prev.checkedAt=now;prev.lastOnline=now;prev.offlineSince=0;}
  else if(online===false){prev.online=false;prev.checkedAt=now;if(!prev.offlineSince)prev.offlineSince=now;}
  targetPresence.set(key,prev); return prev;
}
function ageShort(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return `${sec}с`;const min=Math.floor(sec/60);if(min<60)return `${min}м`;const h=Math.floor(min/60);if(h<24)return `${h}ч`;return `${Math.floor(h/24)}д`;}
function offlineStatusText(targetType,id){const st=targetPresence.get(targetStatusKey(targetType,id));if(!st)return 'НЕ В СЕТИ';if(st.lastOnline)return `OFFLINE · ${ageShort(Date.now()-st.lastOnline)}`;if(st.offlineSince)return `OFFLINE · ${ageShort(Date.now()-st.offlineSince)}`;return 'НЕ В СЕТИ';}
function decoratePresence(entity){const st=targetPresence.get(targetStatusKey(entity.entityType,entity.id)),fresh=st&&Number(st.checkedAt)>0&&Date.now()-Number(st.checkedAt)<90000,resolved=fresh&&typeof st.online==='boolean'?st.online:entity.online;return {...entity,online:resolved,lastOnlineAt:st?.lastOnline||null,offlineSince:st?.offlineSince||null,offlineText:resolved===false?offlineStatusText(entity.entityType,entity.id):''};}

function normalizeActionRefreshSeconds(value) {
  const seconds = Number(value);
  return ACTION_REFRESH_SECONDS.has(seconds) ? seconds : DEFAULT_ACTION_REFRESH_SECONDS;
}

function stopActionRefreshScheduler() {
  if (actionRefreshTimer) clearTimeout(actionRefreshTimer);
  actionRefreshTimer = null;
}

function scheduleActionRefresh() {
  stopActionRefreshScheduler();
  const seconds = normalizeActionRefreshSeconds(globalSettings.actionRefreshSeconds);
  if (seconds <= 0) return;

  actionRefreshTimer = setTimeout(() => {
    actionRefreshTimer = null;
    let delay = 0;
    for (const context of visibleContexts) {
      const action = actionByContext[context];
      if (!action) continue;
      setTimeout(() => {
        if (visibleContexts.has(context)) refreshAction(context, action);
      }, delay);
      delay += ACTION_REFRESH_STAGGER_MS;
    }
    scheduleActionRefresh();
  }, seconds * 1000);
  actionRefreshTimer.unref?.();
}

function send(message) {
  if (ws.handshakeDone) ws.send(message);
}

function sendToPropertyInspector(context, payload, action) {
  send({
    event: 'sendToPropertyInspector',
    action: action || actionByContext[context] || ACTION_TOGGLE,
    context,
    payload
  });
}

function setTitle(context, title) {
  send({ event: 'setTitle', context, payload: { target: 0, title: String(title) } });
}
function setState(context, state) {
  send({ event: 'setState', context, payload: { state } });
}
function setImage(context, image) {
  send({ event: 'setImage', context, payload: { target: 0, image } });
}
function showAlert(context) { send({ event: 'showAlert', context }); }
function persist(context, settings) { send({ event: 'setSettings', context, payload: settings }); }

function normalizeActionSettings(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const mode = ['toggle', 'on', 'off'].includes(String(raw.powerMode || '')) ? String(raw.powerMode) : 'toggle';
  const out = {
    deviceId: String(raw.deviceId || ''),
    deviceName: String(raw.deviceName || ''),
    targetType: raw.targetType === 'group' ? 'group' : 'device',
    brightnessStep: Number(raw.brightnessStep) > 0 ? Number(raw.brightnessStep) : 5,
    brightnessDialStep: [1,5,10,20].includes(Number(raw.brightnessDialStep)) ? Number(raw.brightnessDialStep) : 1,
    brightnessAcceleration: raw.brightnessAcceleration !== false,
    curtainStep: Number(raw.curtainStep) > 0 ? Number(raw.curtainStep) : 10,
    curtainDialStep: [1,5,10,20].includes(Number(raw.curtainDialStep)) ? Number(raw.curtainDialStep) : 1,
    curtainAcceleration: raw.curtainAcceleration !== false,
    curtainReverse: Boolean(raw.curtainReverse),
    temperatureStep: Number(raw.temperatureStep) > 0 ? Number(raw.temperatureStep) : 5,
    colorTemperatureStep: Number(raw.colorTemperatureStep) > 0 ? Number(raw.colorTemperatureStep) : 250,
    colorDialIndex: Number.isFinite(Number(raw.colorDialIndex)) ? Math.max(0, Math.floor(Number(raw.colorDialIndex))) : 0,
    propertyInstance: String(raw.propertyInstance || ''),
    powerMode: mode,
    colorPreset: String(raw.colorPreset || 'white'),
    mediaCommand: String(raw.mediaCommand || 'power_toggle'),
    mediaVolumeStep: Math.max(1, Math.min(20, Number(raw.mediaVolumeStep) || 1)),
    mediaValue: String(raw.mediaValue || ''),
    sensorThresholdEnabled: Boolean(raw.sensorThresholdEnabled),
    sensorWarn: raw.sensorWarn == null ? '' : String(raw.sensorWarn),
    sensorDanger: raw.sensorDanger == null ? '' : String(raw.sensorDanger),
    sensorDirection: String(raw.sensorDirection || 'high') === 'low' ? 'low' : 'high',
    combinedInstances: String(raw.combinedInstances || ''),
    sensorDialStyle: ['minimal','widget'].includes(String(raw.sensorDialStyle||'')) ? String(raw.sensorDialStyle) : 'widget',
    climateModeInstance: String(raw.climateModeInstance || ''),
    presetName: String(raw.presetName || 'Пресет'),
    presetPower: raw.presetPower !== false,
    presetUseBrightness: raw.presetUseBrightness !== false,
    presetBrightness: Math.max(1, Math.min(100, Number(raw.presetBrightness) || 50)),
    presetUseTemperature: Boolean(raw.presetUseTemperature),
    presetTemperature: Math.max(1500, Math.min(10000, Number(raw.presetTemperature) || 3000)),
    presetColor: String(raw.presetColor || 'none'),
    scenarioId: String(raw.scenarioId || ''),
    scenarioName: String(raw.scenarioName || ''),
    scenarioDialSource: ['favorites','all'].includes(String(raw.scenarioDialSource || '')) ? String(raw.scenarioDialSource) : 'favorites',
    infoTemplate: ['home','climate','alerts','favorites'].includes(String(raw.infoTemplate || '')) ? String(raw.infoTemplate) : 'home',
    __fullResetAt: Number(raw.__fullResetAt) || 0
  };
  // legacy v1.2.x token: keep in memory until it has been migrated to global settings
  if (raw.token) out.token = String(raw.token);
  return out;
}

function getSettings(context) {
  return settingsByContext[context] || normalizeActionSettings({});
}

function saveSettings(context, patch) {
  const next = Object.assign({}, getSettings(context), patch || {});
  delete next.token;
  settingsByContext[context] = next;
  persist(context, next);
  return next;
}

function setGlobalSettings(patch) {
  const next = Object.assign({}, globalSettings, patch || {});
  next.token = String(next.token || '').trim();
  next.tokenExpiresAt = Math.max(0, Number(next.tokenExpiresAt) || 0);
  next.tokenLifetimeSeconds = Math.max(0, Number(next.tokenLifetimeSeconds) || 0);
  next.tokenExpiryCapturedAt = Math.max(0, Number(next.tokenExpiryCapturedAt) || 0);
  next.actionRefreshSeconds = normalizeActionRefreshSeconds(next.actionRefreshSeconds);
  globalSettings = next;
  debugLoggingEnabled = globalSettings.debugMode === true;
  syncDashboardDebugFlag();
  globalSettingsReady = true;
  userInfoCache = { token: '', at: 0, data: null };
  dashboardPresenceCache = { token: '', at: 0, devices: [], groups: [] };
  scheduleActionRefresh();
  send({ event: 'setGlobalSettings', context: PLUGIN_UUID, payload: next });
  return next;
}

function tokenForContext(context, suppliedToken = '') {
  return String(
    suppliedToken ||
    globalSettings.token ||
    getSettings(context).token ||
    ''
  ).trim();
}

function tryMigrateLegacyToken() {
  if (!globalSettingsReady) return;
  if (Number(globalSettings.fullResetAt) > 0) return;
  if (String(globalSettings.token || '').trim()) return;
  for (const context of Object.keys(settingsByContext)) {
    const legacy = String(settingsByContext[context]?.token || '').trim();
    if (legacy) {
      logLine('MIGRATE_TOKEN', 'from_context=' + context);
      setGlobalSettings({ token: legacy });
      return;
    }
  }
}

function normalizedSettingsForCurrentReset(raw, context, persistIfReset = false) {
  const resetAt = Number(globalSettings.fullResetAt) || 0;
  const current = normalizeActionSettings(raw || {});
  if (!resetAt || Number(current.__fullResetAt) === resetAt) return current;
  const fresh = normalizeActionSettings({ __fullResetAt: resetAt });
  if (persistIfReset && context) persist(context, fresh);
  return fresh;
}

function resetPluginCompletely() {
  const resetAt = Date.now();
  try { if (sensorHistorySaveTimer) clearTimeout(sensorHistorySaveTimer); } catch (_) {}
  try { if (usageStatsSaveTimer) clearTimeout(usageStatsSaveTimer); } catch (_) {}
  sensorHistorySaveTimer = null;
  usageStatsSaveTimer = null;
  sensorHistoryStore = { version: 1, devices: {} };
  usageStatsStore = { version: 1, entries: {} };
  usageStatsMtime = 0;
  usageStatsThrottle.clear();
  targetPresence.clear();
  for (const map of [brightnessRuntime,curtainRuntime,rangeRuntime,colorTempRuntime,colorDialRuntime,modeRuntime]) {
    for (const value of map.values()) if (value?.timer) { try { clearTimeout(value.timer); } catch (_) {} }
    map.clear();
  }
  combinedRuntime.clear(); sensorMultiDialRuntime.clear(); scenarioDialRuntime.clear();
  userInfoCache = { token: '', at: 0, data: null };
  userInfoInFlight = { token: '', promise: null };
  dashboardDataCache = { token: '', at: 0, data: null };
  dashboardPresenceCache = { token: '', at: 0, devices: [], groups: [] };

  for (const context of Object.keys(settingsByContext)) {
    const fresh = normalizeActionSettings({ __fullResetAt: resetAt });
    settingsByContext[context] = fresh;
    persist(context, fresh);
  }

  globalSettings = { token: '', tokenExpiresAt: 0, tokenLifetimeSeconds: 0, tokenExpiryCapturedAt: 0, actionRefreshSeconds: DEFAULT_ACTION_REFRESH_SECONDS, fullResetAt: resetAt };
  scheduleActionRefresh();
  for (const context of visibleContexts) { try { refreshAction(context, actionByContext[context]); } catch (_) {} }
  debugLoggingEnabled = false;
  globalSettingsReady = true;
  syncDashboardDebugFlag();
  send({ event: 'setGlobalSettings', context: PLUGIN_UUID, payload: globalSettings });

  const dirs = [...new Set([PLUGIN_DATA_DIR, LEGACY_PLUGIN_DATA_DIR])];
  for (const dir of dirs) {
    if (!dir || dir === __dirname) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  for (const file of [DASHBOARD_STATE_FILE, DASHBOARD_LOCK_FILE, DASHBOARD_FOCUS_FILE, DASHBOARD_DEBUG_FLAG_FILE]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  try {
    const tmpDir=process.env.TMPDIR||'/tmp';
    for(const name of fs.readdirSync(tmpDir)){
      if(name.startsWith('yandex-smarthome-streamdock-dashboard')||name.startsWith('nbord-yandex-smarthome-streamdock-dashboard')){
        try{fs.unlinkSync(path.join(tmpDir,name));}catch(_){}
      }
    }
  } catch (_) {}
  try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
  return { ok: true, resetAt, message: 'Данные плагина очищены. Авторизация и настройки сброшены.' };
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function powerIconDataUri(isOn, offline = false) {
  const accent = offline ? '#777777' : (isOn ? '#35D8A2' : '#747474');
  const ring = offline ? '#3D3D3D' : (isOn ? '#35D8A2' : '#565656');
  const slash = offline ? '<path d="M35 35l74 74" stroke="#FF7B7B" stroke-width="8" stroke-linecap="round"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111"/><circle cx="72" cy="75" r="38" fill="none" stroke="${ring}" stroke-width="8"/><path d="M72 25v54" stroke="${accent}" stroke-width="11" stroke-linecap="round"/><path d="M45 48a38 38 0 1 0 54 0" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round"/>${slash}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function lightIconDataUri(isOn, offline = false) {
  const bulb = offline ? '#666666' : (isOn ? '#FFD43B' : '#767676');
  const glow = offline ? '#000000' : (isOn ? '#FFD43B' : '#000000');
  const opacity = isOn && !offline ? '0.28' : '0';
  const slash = offline ? '<path d="M37 37l70 70" stroke="#FF7B7B" stroke-width="8" stroke-linecap="round"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111"/><circle cx="72" cy="61" r="35" fill="${glow}" opacity="${opacity}"/><path d="M72 25c-20 0-36 16-36 36 0 12 6 22 14 29 6 5 8 10 9 16h26c1-6 3-11 9-16 8-7 14-17 14-29 0-20-16-36-36-36z" fill="${bulb}"/><rect x="56" y="106" width="32" height="7" rx="3" fill="#ccc"/><rect x="60" y="116" width="24" height="6" rx="3" fill="#999"/>${slash}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
const ICON_ON = powerIconDataUri(true);
const ICON_OFF = powerIconDataUri(false);
const ICON_OFFLINE = powerIconDataUri(false, true);
const LIGHT_ICON_ON = lightIconDataUri(true);
const LIGHT_ICON_OFF = lightIconDataUri(false);
const LIGHT_ICON_OFFLINE = lightIconDataUri(false, true);
function powerIconsForAction(action) {
  return action === ACTION_LIGHT_POWER
    ? { on: LIGHT_ICON_ON, off: LIGHT_ICON_OFF, offline: LIGHT_ICON_OFFLINE }
    : { on: ICON_ON, off: ICON_OFF, offline: ICON_OFFLINE };
}

function knobImageDataUri(name, value, power, min = 0, max = 100, statusText = '') {
  const safeName = escapeXml((name || 'Лампочка').slice(0, 24));
  const numeric = Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
  const pct = numeric === null ? 0 : Math.max(0, Math.min(1, (numeric - min) / Math.max(1, max - min)));
  const barW = Math.round(142 * pct);
  const on = power !== false;
  const accent = on ? '#FFD43B' : '#777777';
  const percentText = numeric === null ? '—%' : `${numeric}%`;
  const stateText = statusText || (power === false ? 'ВЫКЛ' : 'ЯРКОСТЬ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
    <rect width="176" height="122" rx="14" fill="#121212"/>
    <circle cx="24" cy="25" r="11" fill="${accent}" opacity="${on ? 1 : 0.55}"/>
    <path d="M24 16c-5.2 0-9.4 4.2-9.4 9.4 0 3 1.5 5.8 3.8 7.6 1.6 1.3 2.2 2.7 2.4 4.1h6.4c.3-1.5.8-2.8 2.4-4.1 2.3-1.9 3.8-4.6 3.8-7.6C33.4 20.2 29.2 16 24 16z" fill="#111" opacity=".75"/>
    <text x="42" y="22" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="600">${safeName}</text>
    <text x="42" y="36" fill="#929292" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(stateText)}</text>
    <text x="88" y="83" text-anchor="middle" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="38" font-weight="700">${percentText}</text>
    <rect x="17" y="101" width="142" height="7" rx="3.5" fill="#313131"/>
    <rect x="17" y="101" width="${barW}" height="7" rx="3.5" fill="${accent}"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}


const PROPERTY_LABELS = {
  temperature: 'Температура',
  humidity: 'Влажность',
  co2_level: 'CO₂',
  illumination: 'Освещённость',
  pressure: 'Давление',
  pm1_density: 'PM1',
  'pm2.5_density': 'PM2.5',
  pm10_density: 'PM10',
  tvoc: 'TVOC',
  battery_level: 'Батарея',
  water_level: 'Уровень воды',
  food_level: 'Уровень корма',
  amperage: 'Ток',
  voltage: 'Напряжение',
  power: 'Мощность',
  meter: 'Счётчик',
  electricity_meter: 'Электроэнергия',
  gas_meter: 'Газ',
  heat_meter: 'Тепло',
  open: 'Открытие',
  motion: 'Движение',
  smoke: 'Дым',
  gas: 'Газ',
  water_leak: 'Протечка',
  vibration: 'Вибрация',
  button: 'Кнопка'
};

const EVENT_VALUE_LABELS = {
  click: 'Нажатие', double_click: 'Двойное', long_press: 'Удержание',
  opened: 'Открыто', closed: 'Закрыто',
  detected: 'Обнаружено', not_detected: 'Нет',
  tilt: 'Наклон', fall: 'Падение', vibration: 'Вибрация',
  low: 'Низкий', normal: 'Норма',
  dry: 'Сухо', leak: 'Протечка',
  empty: 'Пусто', full: 'Полный'
};

function propertyLabel(instance) {
  return PROPERTY_LABELS[String(instance || '')] || String(instance || 'Показание').replaceAll('_', ' ');
}

function unitSymbol(unit, instance = '') {
  const u = String(unit || '');
  const map = {
    'unit.temperature.celsius': '°C',
    'unit.temperature.kelvin': 'K',
    'unit.percent': '%',
    'unit.ppm': 'ppm',
    'unit.pressure.mmhg': 'мм рт.ст.',
    'unit.pressure.atm': 'атм',
    'unit.illumination.lux': 'лк',
    'unit.density.mcg_m3': 'мкг/м³',
    'unit.amperage.ampere': 'А',
    'unit.voltage.volt': 'В',
    'unit.power.watt': 'Вт',
    'unit.energy.kilowatt_hour': 'кВт⋅ч',
    'unit.volume.cubic_meter': 'м³'
  };
  if (map[u]) return map[u];
  if (String(instance) === 'co2_level') return 'ppm';
  return '';
}

function normalizeProperty(prop) {
  const type = String(prop?.type || '');
  const instance = String(prop?.parameters?.instance || prop?.state?.instance || '');
  if (!instance) return null;
  const rawValue = prop?.state?.value;
  const numeric = Number.isFinite(Number(rawValue)) && rawValue !== '' && rawValue !== null && rawValue !== undefined;
  const isFloat = type === PROP_FLOAT;
  const value = isFloat && numeric ? Number(rawValue) : rawValue;
  const unit = String(prop?.parameters?.unit || '');
  return {
    type,
    instance,
    label: propertyLabel(instance),
    value,
    unit,
    unitText: unitSymbol(unit, instance),
    retrievable: prop?.retrievable !== false,
    reportable: Boolean(prop?.reportable),
    stateChangedAt: prop?.state_changed_at || null,
    lastUpdated: prop?.last_updated || null,
    events: Array.isArray(prop?.parameters?.events) ? prop.parameters.events.map(e => ({ value: e?.value, name: e?.name || '' })) : []
  };
}

function formatPropertyValue(prop) {
  if (!prop) return '—';
  if (prop.type === PROP_EVENT) return EVENT_VALUE_LABELS[String(prop.value)] || String(prop.value ?? '—');
  if (!Number.isFinite(Number(prop.value))) return String(prop.value ?? '—');
  const value = Number(prop.value);
  const digits = Math.abs(value) < 10 && value % 1 ? 1 : 0;
  return `${value.toFixed(digits)}${prop.unitText ? ' ' + prop.unitText : ''}`;
}

function sensorImageDataUri(name, prop, statusText = '', severity = '', style = 'widget') {
  const safeName = escapeXml((name || 'Датчик').slice(0, 22));
  const label = escapeXml((prop?.label || 'Показание').slice(0, 18));
  const parts = sensorValueParts(prop);
  const value = escapeXml(statusText || parts.value || '—');
  const unit = statusText ? '' : escapeXml(parts.unit || '');
  const accent = sensorAccent(prop?.instance, severity);
  const state = statusText ? escapeXml(statusText) : (severity === 'danger' ? 'КРИТИЧНО' : severity === 'warn' ? 'ВНИМАНИЕ' : 'АКТУАЛЬНО');
  const valueSize = value.length > 10 ? 18 : value.length > 7 ? 22 : value.length > 4 ? 27 : 32;
  let svg='';
  if(style==='minimal'){
    svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="24" fill="#111214"/>
      <circle cx="16" cy="18" r="3" fill="${accent}"/><text x="24" y="21" fill="#858B93" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.5" font-weight="650">${safeName}</text>
      <text x="14" y="45" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10.5" font-weight="750">${label}</text>
      <text x="72" y="89" text-anchor="middle" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${valueSize}" font-weight="800">${value}</text>
      ${unit?`<text x="72" y="105" text-anchor="middle" fill="#9AA0A7" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8.5" font-weight="650">${unit}</text>`:''}
      <rect x="14" y="119" width="116" height="3" rx="1.5" fill="#2A2D31"/><rect x="14" y="119" width="116" height="3" rx="1.5" fill="${accent}" opacity=".7"/>
      <text x="72" y="134" text-anchor="middle" fill="${severity?accent:'#70767E'}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="750">${state}</text>
    </svg>`;
  }else{
    svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <defs><linearGradient id="sg" x1="0" x2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".18"/><stop offset="1" stop-color="${accent}" stop-opacity=".02"/></linearGradient></defs>
      <rect width="144" height="144" rx="24" fill="#111214"/>
      <rect x="9" y="9" width="126" height="111" rx="18" fill="#191B1F" stroke="#2B2E33"/><rect x="9" y="9" width="126" height="111" rx="18" fill="url(#sg)"/>
      <circle cx="35" cy="57" r="20" fill="#202329" stroke="${accent}" stroke-opacity=".34"/>
      ${sensorMetricIconSvg(prop?.instance,35,57,accent)}
      <circle cx="19" cy="20" r="3" fill="${accent}"/><text x="27" y="23" fill="#90969D" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7" font-weight="650">${safeName}</text>
      <text x="62" y="47" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="9.5" font-weight="760">${label}</text>
      <text x="62" y="76" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${Math.max(18,valueSize-4)}" font-weight="800">${value}</text>
      ${unit?`<text x="124" y="89" text-anchor="end" fill="#A5ABB2" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8" font-weight="650">${unit}</text>`:''}
      <rect x="62" y="96" width="60" height="11" rx="5.5" fill="${accent}" opacity=".12"/><text x="92" y="104" text-anchor="middle" fill="${severity?accent:'#858B92'}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.2" font-weight="760">${state}</text>
      <rect x="18" y="127" width="108" height="3" rx="1.5" fill="#2B2E33"/><rect x="18" y="127" width="108" height="3" rx="1.5" fill="${accent}" opacity=".72"/>
    </svg>`;
  }
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function sensorSeverity(prop, settings) {
  if(!settings?.sensorThresholdEnabled || !prop || !Number.isFinite(Number(prop.value))) return '';
  const v=Number(prop.value), warn=String(settings.sensorWarn??'').trim()===''?null:Number(settings.sensorWarn), danger=String(settings.sensorDanger??'').trim()===''?null:Number(settings.sensorDanger), low=settings.sensorDirection==='low';
  if(Number.isFinite(danger) && (low ? v<=danger : v>=danger)) return 'danger';
  if(Number.isFinite(warn) && (low ? v<=warn : v>=warn)) return 'warn';
  return '';
}
function sensorAccent(instance, severity='') {
  if (severity === 'danger') return '#FF6673';
  if (severity === 'warn') return '#FFCC57';
  const key=String(instance||'').toLowerCase();
  const map={temperature:'#FF9D66',humidity:'#66B8FF',co2_level:'#38D7A5',illumination:'#FFD15A',pressure:'#A98CFF',battery_level:'#75DB8B',pm1_density:'#F1B55A','pm2.5_density':'#F1B55A',pm10_density:'#F09A59',tvoc:'#BD8BFF',motion:'#FFAF61',open:'#64C9FF',water_leak:'#59C7FF',smoke:'#FF6D72',gas:'#FFD166'};
  return map[key]||'#62C7FF';
}
function sensorValueParts(prop){
  if(!prop)return {value:'—',unit:''};
  if(prop.type===PROP_EVENT)return {value:EVENT_VALUE_LABELS[String(prop.value)]||String(prop.value??'—'),unit:''};
  if(!Number.isFinite(Number(prop.value)))return {value:String(prop.value??'—'),unit:prop.unitText||''};
  const n=Number(prop.value), digits=Math.abs(n)<10&&n%1?1:0;
  return {value:n.toFixed(digits),unit:prop.unitText||''};
}
function sensorMetricIconSvg(instance,cx,cy,color){
  const k=String(instance||'').toLowerCase();
  if(k==='temperature')return `<g fill="none" stroke="${color}" stroke-width="2.1" stroke-linecap="round"><path d="M ${cx} ${cy-10}v14"/><rect x="${cx-3.5}" y="${cy-12}" width="7" height="17" rx="3.5"/><circle cx="${cx}" cy="${cy+7}" r="5" fill="${color}" stroke="none"/></g>`;
  if(k==='humidity')return `<path d="M ${cx} ${cy-12} C ${cx-8} ${cy-2},${cx-10} ${cy+3},${cx-10} ${cy+7} a10 10 0 0 0 20 0 c0-4-2-9-10-19z" fill="${color}"/>`;
  if(k==='co2_level')return `<g><circle cx="${cx}" cy="${cy}" r="14" fill="${color}" opacity=".13"/><text x="${cx}" y="${cy+4}" text-anchor="middle" fill="${color}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10" font-weight="800">CO₂</text></g>`;
  if(k.includes('pm')||k==='tvoc')return `<g fill="${color}"><circle cx="${cx-7}" cy="${cy-5}" r="3"/><circle cx="${cx+4}" cy="${cy-8}" r="2.2" opacity=".8"/><circle cx="${cx+8}" cy="${cy+2}" r="3.6" opacity=".9"/><circle cx="${cx-5}" cy="${cy+7}" r="2.5" opacity=".7"/><circle cx="${cx+1}" cy="${cy+1}" r="2" opacity=".55"/></g>`;
  if(k==='pressure')return `<g fill="none" stroke="${color}" stroke-width="2"><path d="M ${cx-11} ${cy+7}a13 13 0 1 1 22 0"/><path d="M ${cx} ${cy+2}l7-7"/><circle cx="${cx}" cy="${cy+2}" r="2.5" fill="${color}" stroke="none"/></g>`;
  if(k==='battery_level')return `<g fill="none" stroke="${color}" stroke-width="2"><rect x="${cx-11}" y="${cy-7}" width="20" height="14" rx="3"/><path d="M ${cx+10} ${cy-3}v6"/><rect x="${cx-7}" y="${cy-3.5}" width="11" height="7" rx="1.5" fill="${color}" stroke="none"/></g>`;
  if(k==='illumination')return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="6" fill="${color}" opacity=".18"/><circle cx="${cx}" cy="${cy}" r="5"/><path d="M ${cx} ${cy-12}v3M ${cx} ${cy+9}v3M ${cx-12} ${cy}h3M ${cx+9} ${cy}h3M ${cx-8.5} ${cy-8.5}l2 2M ${cx+6.5} ${cy+6.5}l2 2M ${cx+8.5} ${cy-8.5}l-2 2M ${cx-6.5} ${cy+6.5}l-2 2"/></g>`;
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="12" opacity=".25"/><path d="M ${cx-6} ${cy-4}h12M ${cx-4} ${cy}h8M ${cx-2} ${cy+4}h4"/></g>`;
}
function sensorPageDots(index,total,accent){
  const count=Math.max(1,Math.min(Number(total)||1,6)), active=Math.max(0,Math.min(Number(index)||0,count-1));
  const gap=8,w=active<0?4:4,start=88-(count-1)*gap/2;
  let out='';
  for(let i=0;i<count;i++){const x=start+i*gap;out+=`<rect x="${x-(i===active?4:2)}" y="108" width="${i===active?8:4}" height="4" rx="2" fill="${i===active?accent:'#50545A'}"/>`;}
  return out;
}
function sensorDialImageDataUri(name,prop,index,total,style='widget',severity='',thresholdsEnabled=false,statusText=''){
  const safeName=escapeXml((name||'Датчик').slice(0,25));
  const label=escapeXml((prop?.label||'Показание').slice(0,22));
  const parts=sensorValueParts(prop), value=escapeXml(parts.value), unit=escapeXml(parts.unit);
  const accent=sensorAccent(prop?.instance,severity);
  const page=`${Math.max(0,Number(index)||0)+1}/${Math.max(1,Number(total)||1)}`;
  const state=statusText?escapeXml(statusText):(thresholdsEnabled?(severity==='danger'?'КРИТИЧНО':severity==='warn'?'ВНИМАНИЕ':'НОРМА'):'ПОВЕРНИТЕ');
  const valueSize=value.length>9?21:value.length>6?26:value.length>4?31:36;
  let svg='';
  if(style==='minimal'){
    svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
      <rect width="176" height="122" rx="14" fill="#111214"/>
      <text x="14" y="18" fill="#868B93" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8" font-weight="600">${safeName}</text>
      <text x="14" y="38" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="750">${label}</text>
      <text x="14" y="80" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${valueSize}" font-weight="780">${value}</text>
      ${unit?`<text x="160" y="79" text-anchor="end" fill="#92979E" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="650">${unit}</text>`:''}
      <rect x="14" y="92" width="148" height="2" rx="1" fill="#282B2F"/><rect x="14" y="92" width="148" height="2" rx="1" fill="${accent}" opacity=".42"/>
      <text x="14" y="111" fill="#777D85" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7" font-weight="650">${page}</text>
      <text x="162" y="111" text-anchor="end" fill="${severity?accent:'#777D85'}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7" font-weight="700">${state}</text>
    </svg>`;
  }else{
    svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
      <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".17"/><stop offset="1" stop-color="${accent}" stop-opacity=".02"/></linearGradient></defs>
      <rect width="176" height="122" rx="14" fill="#111214"/>
      <rect x="8" y="8" width="160" height="86" rx="13" fill="#181A1E" stroke="#2A2D32"/>
      <rect x="8" y="8" width="160" height="86" rx="13" fill="url(#g)"/>
      <circle cx="35" cy="49" r="22" fill="#202329" stroke="${accent}" stroke-opacity=".32"/>
      ${sensorMetricIconSvg(prop?.instance,35,49,accent)}
      <text x="66" y="27" fill="#8F949B" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.5" font-weight="600">${safeName}</text>
      <text x="66" y="43" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10" font-weight="750">${label}</text>
      <text x="66" y="72" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${Math.max(20,valueSize-5)}" font-weight="780">${value}</text>
      ${unit?`<text x="160" y="71" text-anchor="end" fill="#B0B4BA" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10" font-weight="650">${unit}</text>`:''}
      <rect x="66" y="79" width="${Math.min(91,Math.max(36,state.length*4.4+16))}" height="10" rx="5" fill="${accent}" opacity=".12"/>
      <text x="72" y="86.5" fill="${severity?accent:'#868B93'}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="750">${state}</text>
      ${sensorPageDots(index,total,accent)}
      <text x="14" y="112" fill="#666C73" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">${page}</text>
      <text x="162" y="112" text-anchor="end" fill="#666C73" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">ВРАЩЕНИЕ</text>
    </svg>`;
  }
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
function combinedSensorImageDataUri(name, props, statusText='', style='widget') {
  const safeName=escapeXml((name||'Датчик').slice(0,20));
  const list=(props||[]).slice(0,3);
  const fallbackAccent=list.length?sensorAccent(list[0]?.instance):'#38D7A5';
  let rows='';
  if(style==='minimal'){
    rows=list.map((p,i)=>{const y=48+i*27,accent=sensorAccent(p.instance),label=escapeXml((p.label||p.instance||'').slice(0,13)),parts=sensorValueParts(p),val=escapeXml(parts.value),unit=escapeXml(parts.unit||'');return `<rect x="12" y="${y-11}" width="3" height="18" rx="1.5" fill="${accent}"/><text x="22" y="${y}" fill="#858B93" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.5" font-weight="650">${label}</text><text x="126" y="${y}" text-anchor="end" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="13" font-weight="780">${val}${unit?` <tspan fill="#92989F" font-size="7.5">${unit}</tspan>`:''}</text>`;}).join('');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111214"/><circle cx="16" cy="18" r="3" fill="${fallbackAccent}"/><text x="24" y="21" fill="#8B9198" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.5" font-weight="650">${safeName}</text><text x="14" y="34" fill="#E8EAED" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8.5" font-weight="750">ПОКАЗАТЕЛИ</text>${rows}<text x="72" y="133" text-anchor="middle" fill="#686E75" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="650">${escapeXml(statusText||'ДАТЧИК')}</text></svg>`;
    return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  }
  rows=list.map((p,i)=>{const y=47+i*27,accent=sensorAccent(p.instance),label=escapeXml((p.label||p.instance||'').slice(0,12)),parts=sensorValueParts(p),val=escapeXml(parts.value),unit=escapeXml(parts.unit||'');return `<circle cx="22" cy="${y-4}" r="9" fill="${accent}" opacity=".13"/>${sensorMetricIconSvg(p.instance,22,y-4,accent)}<text x="39" y="${y-7}" fill="#858B93" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="650">${label}</text><text x="39" y="${y+7}" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="780">${val}</text>${unit?`<text x="126" y="${y+7}" text-anchor="end" fill="#9AA0A7" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.3" font-weight="650">${unit}</text>`:''}`;}).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><defs><linearGradient id="mg" x1="0" x2="1"><stop offset="0" stop-color="${fallbackAccent}" stop-opacity=".15"/><stop offset="1" stop-color="${fallbackAccent}" stop-opacity=".02"/></linearGradient></defs><rect width="144" height="144" rx="24" fill="#111214"/><rect x="8" y="8" width="128" height="116" rx="18" fill="#191B1F" stroke="#2B2E33"/><rect x="8" y="8" width="128" height="116" rx="18" fill="url(#mg)"/><circle cx="18" cy="19" r="3" fill="${fallbackAccent}"/><text x="26" y="22" fill="#92979E" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7" font-weight="650">${safeName}</text>${rows}<text x="72" y="136" text-anchor="middle" fill="#686E75" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.2" font-weight="650">${escapeXml(statusText||'НЕСКОЛЬКО ПОКАЗАНИЙ')}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

function homeSummaryImageDataUri(summary={}, statusText=''){
  const total=Math.max(0,Number(summary.total)||0),online=Math.max(0,Number(summary.online)||0),offline=Math.max(0,total-online),lights=Math.max(0,Number(summary.lightsOn)||0);
  const accent=offline>0?'#FFCC57':'#38D7A5';
  const status=escapeXml(statusText||(offline>0?`${offline} НЕ В СЕТИ`:'ВСЁ В СЕТИ'));
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><defs><linearGradient id="hg" x1="0" x2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".16"/><stop offset="1" stop-color="${accent}" stop-opacity=".02"/></linearGradient></defs><rect width="144" height="144" rx="24" fill="#111214"/><rect x="8" y="8" width="128" height="116" rx="18" fill="#191B1F" stroke="#2B2E33"/><rect x="8" y="8" width="128" height="116" rx="18" fill="url(#hg)"/><path d="M20 36l16-14 16 14v18H41V41H31v13H20z" fill="${accent}" opacity=".92"/><text x="61" y="27" fill="#8E949B" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7" font-weight="650">УМНЫЙ ДОМ</text><text x="61" y="48" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="18" font-weight="800">${online}/${total||'—'}</text><text x="61" y="59" fill="#8D939A" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5">УСТРОЙСТВ В СЕТИ</text><rect x="16" y="72" width="112" height="1" fill="#2D3035"/><circle cx="21" cy="88" r="4" fill="#FFD15A"/><text x="31" y="91" fill="#9399A0" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">Свет включён</text><text x="123" y="91" text-anchor="end" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10" font-weight="750">${lights}</text><circle cx="21" cy="105" r="4" fill="${offline?'#FF6673':'#38D7A5'}"/><text x="31" y="108" fill="#9399A0" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">Офлайн</text><text x="123" y="108" text-anchor="end" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="10" font-weight="750">${offline}</text><text x="72" y="134" text-anchor="middle" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="750">${status}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

function averageProperty(devices, instance) {
  const vals=[];
  for(const d of devices||[]){
    if(d?.online===false) continue;
    for(const p of d.properties||[]) if(p.instance===instance&&Number.isFinite(Number(p.value))) vals.push(Number(p.value));
  }
  return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
}
function informationClimateImageDataUri(devices=[], statusText=''){
  const t=averageProperty(devices,'temperature'),h=averageProperty(devices,'humidity'),co2=averageProperty(devices,'co2_level');
  const fmt=(v,d=0)=>Number.isFinite(v)?v.toFixed(d):'—';
  const accent=Number.isFinite(co2)&&co2>=1200?'#FF6673':Number.isFinite(co2)&&co2>=900?'#FFCC57':'#38D7A5';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><defs><linearGradient id="cg" x1="0" x2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".16"/><stop offset="1" stop-color="${accent}" stop-opacity=".02"/></linearGradient></defs><rect width="144" height="144" rx="24" fill="#111214"/><rect x="8" y="8" width="128" height="116" rx="18" fill="#191B1F" stroke="#2B2E33"/><rect x="8" y="8" width="128" height="116" rx="18" fill="url(#cg)"/><text x="16" y="25" fill="#E8EAED" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="9" font-weight="800">КЛИМАТ ДОМА</text><circle cx="20" cy="48" r="5" fill="#FF9D57"/><text x="31" y="51" fill="#92989F" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">Температура</text><text x="126" y="51" text-anchor="end" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="760">${fmt(t,1)}°</text><circle cx="20" cy="72" r="5" fill="#57A9FF"/><text x="31" y="75" fill="#92989F" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">Влажность</text><text x="126" y="75" text-anchor="end" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="760">${fmt(h)}%</text><circle cx="20" cy="96" r="5" fill="${accent}"/><text x="31" y="99" fill="#92989F" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">CO₂</text><text x="126" y="99" text-anchor="end" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="760">${fmt(co2)} <tspan fill="#858B93" font-size="7">ppm</tspan></text><text x="72" y="135" text-anchor="middle" fill="#6F757C" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5">${escapeXml(statusText||'СРЕДНИЕ ПОКАЗАТЕЛИ')}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
function informationAlertsImageDataUri(devices=[], statusText=''){
  const offline=devices.filter(d=>d.online===false).length;
  const lowBattery=devices.filter(d=>(d.properties||[]).some(p=>p.instance==='battery_level'&&Number.isFinite(Number(p.value))&&Number(p.value)<=20)).length;
  const alarms=devices.filter(d=>(d.properties||[]).some(p=>['water_leak','smoke','gas','motion','open'].includes(p.instance)&&['leak','detected','opened'].includes(String(p.value)))).length;
  const problems=offline+lowBattery+alarms, accent=problems?'#FFCC57':'#38D7A5';
  const row=(y,color,label,val)=>`<circle cx="20" cy="${y-3}" r="5" fill="${color}"/><text x="31" y="${y}" fill="#92989F" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">${label}</text><text x="126" y="${y}" text-anchor="end" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="760">${val}</text>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111214"/><rect x="8" y="8" width="128" height="116" rx="18" fill="#191B1F" stroke="#2B2E33"/><path d="M20 29l9-16 9 16z" fill="${accent}"/><text x="46" y="25" fill="#E8EAED" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="9" font-weight="800">СОСТОЯНИЕ</text>${row(54,'#FF6673','Офлайн',offline)}${row(78,'#FFB257','Батарея ≤20%',lowBattery)}${row(102,'#E38BFF','Тревоги',alarms)}<text x="72" y="135" text-anchor="middle" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="6.5" font-weight="750">${escapeXml(statusText||(problems?`${problems} ТРЕБУЮТ ВНИМАНИЯ`:'ВСЁ СПОКОЙНО'))}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
function informationFavoritesImageDataUri(devices=[],groups=[],scenarios=[],statusText=''){
  const fav=globalSettings?.dashboardPrefs?.favorites||{}, keys=Object.keys(fav), deviceIds=new Set(),groupIds=new Set(),scenarioIds=new Set();
  for(const [k,v] of Object.entries(fav)){const type=v?.type||(k.split(':')[0]);const id=String(v?.id||k.split(':').slice(1).join(':')||'');if(type==='scenario')scenarioIds.add(id);else if(type==='group')groupIds.add(id);else if(type==='device')deviceIds.add(id);}
  const targets=[...devices.filter(d=>deviceIds.has(String(d.id))),...groups.filter(g=>groupIds.has(String(g.id)))],online=targets.filter(x=>x.online!==false).length;
  const accent='#8B6DE1';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111214"/><rect x="8" y="8" width="128" height="116" rx="18" fill="#191B1F" stroke="#2B2E33"/><circle cx="26" cy="27" r="13" fill="${accent}" opacity=".22"/><text x="26" y="33" text-anchor="middle" fill="#D9C8FF" font-family="Arial" font-size="17">★</text><text x="48" y="25" fill="#E8EAED" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="9" font-weight="800">ИЗБРАННОЕ</text><text x="18" y="59" fill="#92989F" font-family="Arial" font-size="7">Устройства</text><text x="124" y="59" text-anchor="end" fill="#FFF" font-family="Arial" font-size="15" font-weight="760">${targets.length}</text><text x="18" y="82" fill="#92989F" font-family="Arial" font-size="7">В сети</text><text x="124" y="82" text-anchor="end" fill="#38D7A5" font-family="Arial" font-size="15" font-weight="760">${online}</text><text x="18" y="105" fill="#92989F" font-family="Arial" font-size="7">Сценарии</text><text x="124" y="105" text-anchor="end" fill="#FFF" font-family="Arial" font-size="15" font-weight="760">${scenarioIds.size}</text><text x="72" y="135" text-anchor="middle" fill="#747A82" font-family="Arial" font-size="6.5">${escapeXml(statusText||(keys.length?'ИЗ ПАНЕЛИ УМНОГО ДОМА':'ДОБАВЬТЕ ★ В ПАНЕЛИ'))}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

function curtainImageDataUri(name, value, statusText = '') {
  const safeName = escapeXml((name || 'Шторы').slice(0, 24));
  const numeric = Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
  const pct = numeric === null ? 0 : Math.max(0, Math.min(1, numeric / 100));
  const barW = Math.round(142 * pct);
  const percentText = numeric === null ? '—%' : `${numeric}%`;
  const stateText = statusText || (numeric === 0 ? 'ЗАКРЫТО' : numeric === 100 ? 'ОТКРЫТО' : 'ОТКРЫТИЕ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
    <rect width="176" height="122" rx="14" fill="#121212"/>
    <rect x="16" y="14" width="18" height="26" rx="3" fill="#6CAEFF" opacity=".9"/>
    <path d="M25 15v24M18 21h14M18 27h14M18 33h14" stroke="#111" stroke-width="1.5" opacity=".7"/>
    <text x="42" y="22" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="600">${safeName}</text>
    <text x="42" y="36" fill="#929292" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(stateText)}</text>
    <text x="88" y="83" text-anchor="middle" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="38" font-weight="700">${percentText}</text>
    <rect x="17" y="101" width="142" height="7" rx="3.5" fill="#313131"/>
    <rect x="17" y="101" width="${barW}" height="7" rx="3.5" fill="#6CAEFF"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function yandexRequest(token, apiPath, options = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('OAuth-токен не указан');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(YANDEX_API + apiPath, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body,
      signal: controller.signal
    });

    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Токен недействителен или не имеет нужного доступа. Нужны iot:view и iot:control.');
      }
      throw new Error(json?.message || `HTTP ${response.status}`);
    }
    if (json?.status === 'error') throw new Error(json.message || 'Яндекс вернул ошибку');
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Яндекс не ответил за 12 секунд.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function logDiscoverySummary(data) {
  try {
    const rooms = Object.fromEntries((data?.rooms || []).map(r => [String(r?.id || ''), String(r?.name || 'Без комнаты')]));
    logLine('DISCOVERY_SUMMARY', `devices=${(data?.devices || []).length}`, `groups=${(data?.groups || []).length}`, `rooms=${(data?.rooms || []).length}`);
    for (const d of (data?.devices || [])) {
      const caps = (Array.isArray(d?.capabilities) ? d.capabilities : []).map(c => {
        const inst = String(c?.parameters?.instance || c?.state?.instance || '');
        const shortType = String(c?.type || '').replace('devices.capabilities.', '');
        return `${shortType}${inst ? ':' + inst : ''}${c?.retrievable === false ? ':NR' : ''}`;
      }).join(',');
      logLine('DISCOVERY_DEVICE', `id=${String(d?.id || '')}`, `name=${String(d?.name || '')}`, `room=${rooms[String(d?.room || '')] || 'Без комнаты'}`, `type=${String(d?.type || '')}`, `skill=${String(d?.skill_id || '')}`, `caps=${caps || '-'}`);
    }
  } catch (e) {
    logLine('DISCOVERY_WARN', e?.message || String(e));
  }
}

async function getUserInfo(token, force = false) {
  const now = Date.now();
  if (!force && userInfoCache.data && userInfoCache.token === token && now - userInfoCache.at < 5000) {
    return userInfoCache.data;
  }
  if (userInfoInFlight.promise && userInfoInFlight.token === token) {
    return userInfoInFlight.promise;
  }

  const promise = (async () => {
    logLine('YANDEX_REQUEST', '/user/info');
    const data = await yandexRequest(token, '/user/info');
    logLine('YANDEX_OK', '/user/info');
    logDiscoverySummary(data);
    userInfoCache = { token, at: Date.now(), data };
    captureSensorHistoryFromData(data);
    return data;
  })();
  userInfoInFlight = { token, promise };
  try {
    return await promise;
  } finally {
    if (userInfoInFlight.promise === promise) userInfoInFlight = { token: '', promise: null };
  }
}

function capability(device, type, instance) {
  const caps = Array.isArray(device?.capabilities) ? device.capabilities : [];
  return caps.find(c => c?.type === type && (!instance || c?.parameters?.instance === instance || c?.state?.instance === instance));
}

function rangeDescriptor(cap, defaultMin = 0, defaultMax = 100) {
  if (!cap) return null;
  const r = cap?.parameters?.range || {};
  const rawValue = cap?.state?.value;
  return {
    value: Number.isFinite(Number(rawValue)) ? Number(rawValue) : null,
    min: Number.isFinite(Number(r.min)) ? Number(r.min) : defaultMin,
    max: Number.isFinite(Number(r.max)) ? Number(r.max) : defaultMax,
    precision: Number.isFinite(Number(r.precision)) && Number(r.precision) > 0 ? Number(r.precision) : 1,
    randomAccess: cap?.parameters?.random_access !== false,
    retrievable: cap?.retrievable !== false
  };
}

function normalizeModeCapability(cap) {
  if (!cap) return null;
  const instance = String(cap?.parameters?.instance || cap?.state?.instance || '');
  if (!instance) return null;
  const modes = Array.isArray(cap?.parameters?.modes)
    ? cap.parameters.modes.map(m => String(m?.value || '')).filter(Boolean)
    : [];
  return {
    instance,
    value: cap?.state?.value == null ? null : String(cap.state.value),
    modes,
    retrievable: cap?.retrievable !== false,
    reportable: Boolean(cap?.reportable)
  };
}

function normalizeToggleCapability(cap) {
  if (!cap) return null;
  const instance = String(cap?.parameters?.instance || cap?.state?.instance || '');
  if (!instance) return null;
  return {
    instance,
    value: cap?.state?.value == null ? null : Boolean(cap.state.value),
    retrievable: cap?.retrievable !== false,
    reportable: Boolean(cap?.reportable)
  };
}

function normalizeRangeCapability(cap) {
  if (!cap) return null;
  const instance = String(cap?.parameters?.instance || cap?.state?.instance || '');
  if (!instance) return null;
  const d = rangeDescriptor(cap, 0, 100) || {};
  return {
    instance,
    value: d.value,
    min: d.min,
    max: d.max,
    precision: d.precision,
    randomAccess: d.randomAccess,
    retrievable: d.retrievable,
    unit: String(cap?.parameters?.unit || ''),
    unitText: unitSymbol(cap?.parameters?.unit || '', instance)
  };
}

const YANDEX_WHITE_TEMPERATURE_PRESETS = [
  { id:'fire', name:'Огненный белый', value:1500 },
  { id:'soft', name:'Мягкий белый', value:2700 },
  { id:'warm', name:'Тёплый белый', value:3400 },
  { id:'white', name:'Белый', value:4500 },
  { id:'daylight', name:'Дневной белый', value:5600 },
  { id:'cold', name:'Холодный белый', value:6500 },
  { id:'mist', name:'Туманный белый', value:7500 },
  { id:'sky', name:'Небесный белый', value:9000 }
];

function whiteTemperaturePresets(min, max) {
  const lo = Number.isFinite(Number(min)) ? Number(min) : 2000;
  const hi = Number.isFinite(Number(max)) ? Number(max) : 9000;
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  if (Math.abs(b - a) < 1) {
    let nearest = YANDEX_WHITE_TEMPERATURE_PRESETS[0];
    for (const item of YANDEX_WHITE_TEMPERATURE_PRESETS) {
      if (Math.abs(item.value - a) < Math.abs(nearest.value - a)) nearest = item;
    }
    return [{ ...nearest, value: Math.round(a), exact: nearest.value === Math.round(a) }];
  }
  const within = YANDEX_WHITE_TEMPERATURE_PRESETS.filter(x => x.value >= a && x.value <= b).map(x => ({ ...x, exact:true }));
  if (within.length) return within;
  const fallback = Math.max(a, Math.min(b, 4500));
  return [{ id:'white', name:'Белый', value:Math.round(fallback), exact:false }];
}

function normalizeColorCapability(cap) {
  if (!cap) return null;
  const p = cap.parameters || {};
  const temp = p.temperature_k || null;
  const rawModel = String(p.color_model || '').toLowerCase();
  const model = rawModel === 'rgb' || rawModel === 'hsv' ? rawModel : '';
  const scene = p.color_scene || null;
  const stateInstance = String(cap?.state?.instance || '');
  const raw = cap?.state?.value;
  let stateValue = raw;
  if (stateInstance === 'rgb' && Number.isFinite(Number(raw))) stateValue = Number(raw);
  if (stateInstance === 'temperature_k' && Number.isFinite(Number(raw))) stateValue = Number(raw);
  const temperatureMin = Number.isFinite(Number(temp?.min)) ? Number(temp.min) : 2000;
  const temperatureMax = Number.isFinite(Number(temp?.max)) ? Number(temp.max) : 9000;
  const scenes = Array.isArray(scene?.scenes) ? scene.scenes.map(x => String(x?.id || x?.value || '')).filter(Boolean) : [];
  const supportsTemperature = Boolean(temp);
  return {
    retrievable: cap?.retrievable !== false,
    reportable: Boolean(cap?.reportable),
    colorModel: model,
    supportsRgb: model === 'rgb',
    supportsHsv: model === 'hsv',
    supportsArbitraryColor: model === 'rgb' || model === 'hsv',
    supportsTemperature,
    temperatureMin,
    temperatureMax,
    temperaturePresets: supportsTemperature ? whiteTemperaturePresets(temperatureMin, temperatureMax) : [],
    supportsScene: Boolean(scene) && scenes.length > 0,
    scenes,
    availableModes: [model ? 'color' : '', supportsTemperature ? 'temperature' : '', scenes.length ? 'scene' : ''].filter(Boolean),
    stateInstance,
    stateValue
  };
}

function deviceCategory(type) {
  const t = String(type || '');
  if (t.startsWith('devices.types.light')) return 'light';
  if (t.startsWith('devices.types.vacuum_cleaner')) return 'vacuum';
  if (t.includes('openable.curtain')) return 'curtain';
  if (t.startsWith('devices.types.cooking.kettle')) return 'kettle';
  if (t.startsWith('devices.types.cooking')) return 'kitchen';
  if (t.startsWith('devices.types.sensor')) return 'sensor';
  if (t.startsWith('devices.types.media_device')) return 'media';
  if (t.startsWith('devices.types.smart_speaker')) return 'speaker';
  if (t.startsWith('devices.types.hub')) return 'hub';
  if (t.startsWith('devices.types.thermostat') || t.startsWith('devices.types.ventilation') || t.includes('purifier') || t.includes('humidifier')) return 'climate';
  if (t.startsWith('devices.types.socket') || t.startsWith('devices.types.switch')) return 'power';
  return 'other';
}

function normalizeDevices(data) {
  const rooms = Object.create(null);
  for (const room of data?.rooms || []) {
    if (room?.id) rooms[room.id] = room.name || 'Без комнаты';
  }

  return (data?.devices || []).map(d => {
    const caps = Array.isArray(d?.capabilities) ? d.capabilities : [];
    const onOff = caps.find(c => c?.type === CAP_ONOFF);
    const rangeCaps = caps.filter(c => c?.type === CAP_RANGE).map(normalizeRangeCapability).filter(Boolean);
    const modeCaps = caps.filter(c => c?.type === CAP_MODE).map(normalizeModeCapability).filter(Boolean);
    const toggleCaps = caps.filter(c => c?.type === CAP_TOGGLE).map(normalizeToggleCapability).filter(Boolean);
    const color = normalizeColorCapability(caps.find(c => c?.type === CAP_COLOR));
    const brightness = rangeCaps.find(c => c.instance === 'brightness') || null;
    const open = rangeCaps.find(c => c.instance === 'open') || null;
    const temperature = rangeCaps.find(c => c.instance === 'temperature') || null;
    const pValue = onOff?.state?.value;
    const type = String(d?.type || '');
    const hasNonRetrievable = Boolean(onOff && onOff?.retrievable === false)
      || rangeCaps.some(x => x.retrievable === false)
      || modeCaps.some(x => x.retrievable === false)
      || toggleCaps.some(x => x.retrievable === false)
      || Boolean(color && color.retrievable === false);
    const isKnownNative = type.startsWith('devices.types.light')
      || type.startsWith('devices.types.vacuum_cleaner')
      || type.startsWith('devices.types.cooking')
      || type.startsWith('devices.types.sensor')
      || type.startsWith('devices.types.socket')
      || type.startsWith('devices.types.switch')
      || type.includes('openable.curtain')
      || type.includes('purifier')
      || type.includes('humidifier')
      || type.startsWith('devices.types.smart_speaker');
    const explicitIrType = type.startsWith('devices.types.media_device')
      || (hasNonRetrievable && (
        type.startsWith('devices.types.thermostat.ac')
        || type.startsWith('devices.types.ventilation.fan')
        || type.includes('air_conditioner')
        || type.includes('receiver')
      ));
    const isIrCandidate = explicitIrType || (!isKnownNative && hasNonRetrievable);
    const properties = (Array.isArray(d?.properties) ? d.properties : [])
      .map(normalizeProperty)
      .filter(Boolean);
    return {
      id: String(d?.id || ''),
      name: d?.name || 'Без названия',
      aliases: Array.isArray(d?.aliases) ? d.aliases : [],
      externalId: String(d?.external_id || ''),
      skillId: String(d?.skill_id || ''),
      householdId: String(d?.household_id || ''),
      entityType: 'device',
      isGroup: false,
      online: d?.state === 'offline' ? false : (d?.state === 'online' ? true : null),
      groups: Array.isArray(d?.groups) ? d.groups.map(String) : [],
      room: rooms[d?.room] || 'Без комнаты',
      roomId: d?.room || null,
      type,
      category: deviceCategory(type),
      isLight: type.startsWith('devices.types.light'),
      isSensor: type.startsWith('devices.types.sensor'),
      isMedia: type.startsWith('devices.types.media_device'),
      isIrCandidate,
      isHub: type.startsWith('devices.types.hub'),
      isVacuum: type.startsWith('devices.types.vacuum_cleaner'),
      isKettle: type.startsWith('devices.types.cooking.kettle'),
      isCurtain: type.includes('openable.curtain') || Boolean(open),
      power: pValue === undefined ? null : Boolean(pValue),
      hasOnOff: Boolean(onOff),
      onOffRetrievable: Boolean(onOff) && onOff?.retrievable !== false,
      brightness,
      open,
      temperature,
      ranges: rangeCaps,
      modes: modeCaps,
      toggles: toggleCaps,
      color,
      properties
    };
  }).sort((a, b) => {
    const ar = a.room === 'Без комнаты' ? '\uffff' : a.room;
    const br = b.room === 'Без комнаты' ? '\uffff' : b.room;
    return ar.localeCompare(br, 'ru') || a.name.localeCompare(b.name, 'ru');
  });
}

function ensureSensorHistoryLoaded() {
  if (sensorHistoryStore) return sensorHistoryStore;
  try {
    try { fs.mkdirSync(SENSOR_HISTORY_DIR, { recursive: true }); } catch (_) {}
    if (fs.existsSync(SENSOR_HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SENSOR_HISTORY_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object') {
        sensorHistoryStore = parsed;
      }
    }
  } catch (e) {
    errorLine('SENSOR_HISTORY_READ_ERROR', e?.message || String(e));
  }
  if (!sensorHistoryStore) sensorHistoryStore = { version: 1, devices: {} };
  return sensorHistoryStore;
}

function scheduleSensorHistorySave() {
  if (sensorHistorySaveTimer) return;
  sensorHistorySaveTimer = setTimeout(() => {
    sensorHistorySaveTimer = null;
    try {
      const store = ensureSensorHistoryLoaded();
      try { fs.mkdirSync(SENSOR_HISTORY_DIR, { recursive: true }); } catch (_) {}
      const tmp = SENSOR_HISTORY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, SENSOR_HISTORY_FILE);
    } catch (e) {
      errorLine('SENSOR_HISTORY_WRITE_ERROR', e?.message || String(e));
    }
  }, 900);
  sensorHistorySaveTimer.unref?.();
}

function captureSensorHistoryEntities(devices) {
  try {
    const now = Date.now(), cutoff = now - SENSOR_HISTORY_MAX_MS;
    const store = ensureSensorHistoryLoaded();
    let changed = false;
    for (const d of Array.isArray(devices) ? devices : []) {
      if (!d?.id) continue;
      const numeric = (d.properties || []).filter(p => p.type === PROP_FLOAT && Number.isFinite(Number(p.value)));
      if (!numeric.length) continue;
      const dev = store.devices[d.id] || (store.devices[d.id] = { name: d.name || '', room: d.room || '', properties: {} });
      dev.name = d.name || dev.name || '';
      dev.room = d.room || dev.room || '';
      for (const p of numeric) {
        const prop = dev.properties[p.instance] || (dev.properties[p.instance] = { label: p.label || p.instance, unitText: p.unitText || '', points: [] });
        prop.label = p.label || prop.label || p.instance;
        prop.unitText = p.unitText || prop.unitText || '';
        prop.points = Array.isArray(prop.points) ? prop.points.filter(x => Array.isArray(x) && Number(x[0]) >= cutoff && Number.isFinite(Number(x[1]))) : [];
        const last = prop.points[prop.points.length - 1];
        if (!last || now - Number(last[0]) >= SENSOR_HISTORY_MIN_SAMPLE_MS) {
          prop.points.push([now, Number(p.value)]);
          changed = true;
        }
      }
    }
    if (changed) scheduleSensorHistorySave();
  } catch (e) {
    errorLine('SENSOR_HISTORY_CAPTURE_ERROR', e?.message || String(e));
  }
}
function captureSensorHistoryFromData(data) { captureSensorHistoryEntities(normalizeDevices(data)); }

function sensorHistoryQuery(deviceId, instance, hours = 1) {
  const h = [1, 6, 24].includes(Number(hours)) ? Number(hours) : 1;
  const store = ensureSensorHistoryLoaded();
  const dev = store.devices[String(deviceId || '')] || null;
  if (!dev) return { deviceId: String(deviceId || ''), instance: String(instance || ''), hours: h, points: [], stats: null, name: '', label: '', unitText: '' };
  let key = String(instance || '');
  if (!key || !dev.properties?.[key]) key = Object.keys(dev.properties || {})[0] || '';
  const prop = dev.properties?.[key] || null;
  if (!prop) return { deviceId: String(deviceId || ''), instance: key, hours: h, points: [], stats: null, name: dev.name || '', label: '', unitText: '' };
  const to = Date.now(), cutoff = to - h * 60 * 60 * 1000;
  const points = (Array.isArray(prop.points) ? prop.points : []).filter(x => Number(x?.[0]) >= cutoff && Number.isFinite(Number(x?.[1]))).map(x => [Number(x[0]), Number(x[1])]);
  const values = points.map(x => x[1]);
  const stats = values.length ? { min: Math.min(...values), max: Math.max(...values), avg: values.reduce((a,b)=>a+b,0)/values.length, current: values[values.length-1] } : null;
  return { deviceId: String(deviceId || ''), instance: key, hours: h, from: cutoff, to, points, stats, name: dev.name || '', room: dev.room || '', label: prop.label || key, unitText: prop.unitText || '', availableInstances: Object.entries(dev.properties || {}).map(([id,x]) => ({ instance:id, label:x?.label||id, unitText:x?.unitText||'' })) };
}

function normalizeGroups(data, normalizedDevices = null) {
  const devices = normalizedDevices || normalizeDevices(data);
  const byId = new Map(devices.map(d => [d.id, d]));
  return (Array.isArray(data?.groups) ? data.groups : []).map(g => {
    const caps = Array.isArray(g?.capabilities) ? g.capabilities : [];
    const onOff = caps.find(c => c?.type === CAP_ONOFF);
    const rangeCaps = caps.filter(c => c?.type === CAP_RANGE).map(normalizeRangeCapability).filter(Boolean);
    const modeCaps = caps.filter(c => c?.type === CAP_MODE).map(normalizeModeCapability).filter(Boolean);
    const toggleCaps = caps.filter(c => c?.type === CAP_TOGGLE).map(normalizeToggleCapability).filter(Boolean);
    const color = normalizeColorCapability(caps.find(c => c?.type === CAP_COLOR));
    const brightness = rangeCaps.find(c => c.instance === 'brightness') || null;
    const open = rangeCaps.find(c => c.instance === 'open') || null;
    const temperature = rangeCaps.find(c => c.instance === 'temperature') || null;
    const type = String(g?.type || '');
    const memberIds = Array.isArray(g?.devices) ? g.devices.map(x => String((x && typeof x === 'object') ? (x.id || '') : x)).filter(Boolean) : [];
    const members = memberIds.map(id => byId.get(id)).filter(Boolean);
    const memberRooms = [...new Set(members.map(d => d.room).filter(Boolean))];
    const room = memberRooms.length === 1 ? memberRooms[0] : (memberRooms.length > 1 ? 'Несколько комнат' : 'Без комнаты');
    const pValue = onOff?.state?.value;
    return {
      id: String(g?.id || ''),
      name: g?.name || 'Группа',
      aliases: Array.isArray(g?.aliases) ? g.aliases : [],
      entityType: 'group',
      isGroup: true,
      online: g?.state === 'offline' ? false : (g?.state === 'online' ? true : null),
      room,
      roomId: memberRooms.length === 1 ? (members[0]?.roomId || null) : null,
      type,
      category: deviceCategory(type),
      isLight: type.startsWith('devices.types.light'),
      isSensor: false,
      isMedia: type.startsWith('devices.types.media_device'),
      isSpeaker: type.startsWith('devices.types.smart_speaker'),
      isHub: false,
      isVacuum: type.startsWith('devices.types.vacuum_cleaner'),
      isKettle: type.startsWith('devices.types.cooking.kettle'),
      isCurtain: type.includes('openable.curtain') || Boolean(open),
      power: pValue === undefined || pValue === null ? null : Boolean(pValue),
      hasOnOff: Boolean(onOff),
      onOffRetrievable: Boolean(onOff) && onOff?.retrievable !== false,
      brightness, open, temperature,
      ranges: rangeCaps,
      modes: modeCaps,
      toggles: toggleCaps,
      color,
      properties: [],
      memberIds,
      memberNames: members.map(d => d.name),
      memberCount: memberIds.length
    };
  }).filter(g => g.id).sort((a,b) => a.name.localeCompare(b.name,'ru'));
}

function hasNonRetrievableControl(d) {
  if (!d || d.isGroup || d.isHub || d.isLight || d.isSensor) return false;
  if (d.hasOnOff && !d.onOffRetrievable) return true;
  if ((d.ranges || []).some(x => x.retrievable === false)) return true;
  if ((d.modes || []).some(x => x.retrievable === false)) return true;
  if ((d.toggles || []).some(x => x.retrievable === false)) return true;
  return false;
}

function scenariosFromInfo(data) {
  return (Array.isArray(data?.scenarios) ? data.scenarios : [])
    .map(x => { const name=String(x?.name || 'Сценарий'); const [visualKind,visualGlyph,visualAccent]=scenarioVisual(name); return { id:String(x?.id||''), name, isActive:x?.is_active!==false, visualKind, visualGlyph, visualAccent }; })
    .filter(x => x.id)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function devicesForAction(allTargets, action) {
  if (action === ACTION_LIGHT_POWER) return allTargets.filter(d => d.isLight && d.hasOnOff);
  if (action === ACTION_BRIGHTNESS) return allTargets.filter(d => d.brightness);
  if (action === ACTION_SENSOR) return allTargets.filter(d => !d.isGroup && Array.isArray(d.properties) && d.properties.length);
  if (action === ACTION_SENSOR_MULTI) return allTargets.filter(d => !d.isGroup && Array.isArray(d.properties) && d.properties.length >= 2);
  if (action === ACTION_CURTAIN) return allTargets.filter(d => !d.isGroup && d.open);
  if (action === ACTION_VACUUM_SPEED) return allTargets.filter(d => !d.isGroup && d.isVacuum && d.modes.some(m => m.instance === 'work_speed'));
  if (action === ACTION_CLIMATE_MODE) return allTargets.filter(d => !d.isGroup && d.category === 'climate' && Array.isArray(d.modes) && d.modes.length);
  if (action === ACTION_KETTLE_TEMP) return allTargets.filter(d => !d.isGroup && d.isKettle && d.temperature);
  if (action === ACTION_LIGHT_TEMP) return allTargets.filter(d => d.isLight && d.color?.supportsTemperature);
  if ([ACTION_LIGHT_COLOR, ACTION_LIGHT_COLOR_DIAL].includes(action)) return allTargets.filter(d => d.isLight && (d.color?.supportsRgb || d.color?.supportsHsv));
  if (action === ACTION_LIGHT_PRESET) return allTargets.filter(d => d.isLight && (d.hasOnOff || d.brightness || d.color));
  if (action === ACTION_MEDIA_VOLUME) return allTargets.filter(d => !d.isGroup && !d.isHub && (d.ranges||[]).some(r=>r.instance==='volume'));
  if (action === ACTION_MEDIA_CHANNEL) return allTargets.filter(d => !d.isGroup && !d.isHub && (d.ranges||[]).some(r=>r.instance==='channel'));
  if (action === ACTION_MEDIA) return allTargets.filter(d => !d.isGroup && !d.isHub && !d.isSensor && d.isIrCandidate && (d.hasOnOff || d.ranges.length || d.modes.length || d.toggles.length));
  if (action === ACTION_DASHBOARD) return [];
  if (action === ACTION_SCENARIO) return [];
  if (action === ACTION_TOGGLE) return allTargets.filter(d => !d.isGroup && !d.isLight && d.hasOnOff);
  return allTargets.filter(d => d.hasOnOff);
}

async function loadDevicesForAction(context, action, suppliedToken = '', force = false) {
  if (action === ACTION_DASHBOARD) { refreshSimpleAction(context, action); sendToPropertyInspector(context,{type:'selected',deviceName:'Панель готова'},action); return; }
  const token = tokenForContext(context, suppliedToken);
  if (!token) {
    sendToPropertyInspector(context, { type: 'error', message: 'Сначала сохраните OAuth-токен.' }, action);
    return;
  }
  if (suppliedToken && suppliedToken.trim() !== String(globalSettings.token || '').trim()) {
    setGlobalSettings({ token: suppliedToken.trim() });
  }

  sendToPropertyInspector(context, { type: 'loading' }, action);
  try {
    const data = await getUserInfo(token, force);
    const allDevices = normalizeDevices(data);
    const allGroups = normalizeGroups(data, allDevices);
    const allTargets = [...allDevices, ...allGroups];
    const current = getSettings(context);
    if (action === ACTION_SCENARIO) {
      const scenarios = scenariosFromInfo(data);
      const selected = scenarios.find(x => x.id === current.scenarioId) || scenarios[0] || null;
      if (selected && current.scenarioId !== selected.id) {
        saveSettings(context, { scenarioId: selected.id, scenarioName: selected.name });
      }
      sendToPropertyInspector(context, {
        type: 'scenarios', scenarios,
        selectedScenarioId: selected?.id || '',
        message: `Подключено. Найдено сценариев: ${scenarios.length}`
      }, action);
      if (!selected) {
        setTitle(context, 'Нет сценариев');
        setImage(context, ICON_OFF);
      } else {
        setTitle(context, selected.name.slice(0, 14));
      }
      return;
    }
    const devices = devicesForAction(allTargets, action);
    const selected = devices.find(d => d.id === current.deviceId && d.entityType === current.targetType) || devices.find(d => d.id === current.deviceId) || devices[0] || null;

    if (selected) {
      const patch = { deviceId: selected.id, deviceName: selected.name, targetType: selected.entityType || 'device' };
      if (action === ACTION_SENSOR) {
        const hasCurrent = selected.properties.some(p => p.instance === current.propertyInstance);
        patch.propertyInstance = hasCurrent ? current.propertyInstance : (selected.properties[0]?.instance || '');
      }
      if (action === ACTION_SENSOR_MULTI) {
        const wanted=String(current.combinedInstances||'').split(',').filter(x=>selected.properties.some(p=>p.instance===x));
        patch.combinedInstances=(wanted.length?wanted:selected.properties.slice(0,3).map(p=>p.instance)).join(',');
      }
      if (action === ACTION_CLIMATE_MODE) {
        const m=selected.modes.find(x=>x.instance===current.climateModeInstance)||selected.modes.find(x=>['fan_speed','work_speed'].includes(x.instance))||selected.modes[0];
        patch.climateModeInstance=m?.instance||'';
      }
      if (current.deviceId !== selected.id || current.targetType !== patch.targetType || current.deviceName !== patch.deviceName || (action === ACTION_SENSOR && patch.propertyInstance !== current.propertyInstance) || (action === ACTION_SENSOR_MULTI && patch.combinedInstances !== current.combinedInstances) || (action === ACTION_CLIMATE_MODE && patch.climateModeInstance !== current.climateModeInstance)) {
        saveSettings(context, patch);
      }
    }

    const nouns = {
      [ACTION_TOGGLE]: 'устройств с Вкл/Выкл',
      [ACTION_LIGHT_POWER]: 'ламп и групп света',
      [ACTION_BRIGHTNESS]: 'устройств с яркостью',
      [ACTION_SENSOR]: 'устройств с датчиками',
      [ACTION_SENSOR_MULTI]: 'комбинированных датчиков',
      [ACTION_CURTAIN]: 'штор/жалюзи',
      [ACTION_VACUUM_SPEED]: 'пылесосов со скоростью',
      [ACTION_CLIMATE_MODE]: 'очистителей/вентиляторов с режимами',
      [ACTION_KETTLE_TEMP]: 'чайников с температурой',
      [ACTION_LIGHT_TEMP]: 'ламп с температурой света',
      [ACTION_LIGHT_COLOR]: 'цветных ламп',
      [ACTION_LIGHT_COLOR_DIAL]: 'цветных ламп для крутилки',
      [ACTION_LIGHT_PRESET]: 'ламп и групп для пресетов',
      [ACTION_MEDIA_VOLUME]: 'ТВ/ИК-устройств с громкостью',
      [ACTION_MEDIA_CHANNEL]: 'ТВ/ИК-устройств с каналами',
      [ACTION_MEDIA]: 'ИК/командных устройств'
    };
    const message = `Подключено. Найдено ${nouns[action] || 'устройств'}: ${devices.length}`;
    sendToPropertyInspector(context, {
      type: 'devices',
      devices,
      selectedDeviceId: selected?.id || '',
      selectedTargetType: selected?.entityType || 'device',
      selectedPropertyInstance: getSettings(context).propertyInstance || '',
      allDeviceCount: allDevices.length,
      allGroupCount: allGroups.length,
      message
    }, action);

    if (!devices.length) {
      if (action === ACTION_BRIGHTNESS) {
        setImage(context, knobImageDataUri('Нет устройств', null, false, 0, 100, 'НЕТ ЯРКОСТИ'));
      } else if (action === ACTION_CURTAIN) {
        setImage(context, curtainImageDataUri('Нет штор', null, 'НЕ НАЙДЕНО'));
      } else if (action === ACTION_SENSOR) {
        setTitle(context, '');
        setImage(context, sensorImageDataUri('Нет датчиков', null, '—'));
      } else if ([ACTION_VACUUM_SPEED, ACTION_KETTLE_TEMP, ACTION_LIGHT_TEMP, ACTION_MEDIA_VOLUME, ACTION_MEDIA_CHANNEL].includes(action)) {
        setImage(context, knobImageDataUri('Нет устройств', null, false, 0, 100, 'НЕ НАЙДЕНО'));
      } else {
        setTitle(context, 'Нет устройств');
        setImage(context, ICON_OFF);
      }
      return;
    }

    await refreshAction(context, action);
  } catch (e) {
    errorLine('YANDEX_ERROR', e?.message || String(e));
    console.error('loadDevicesForAction:', e);
    sendToPropertyInspector(context, { type: 'error', message: e?.message || 'Ошибка получения списка устройств.' }, action);
  }
}

function decorateDevicesForDashboard(devices) {
  // Панель показывает положение штор ровно так, как его отдаёт Яндекс.
  // curtainReverse — настройка отдельного действия Stream Dock и не должна
  // переопределять значение в общей панели, иначе карточка и окно деталей расходятся.
  return devices.map(d => ({ ...d, curtainReverse: false }));
}

async function hydrateEntitiesOnline(token, devices, groups) {
  const items = [
    ...devices.map((entity, index) => ({ entity, index, targetType: 'device' })),
    ...groups.map((entity, index) => ({ entity, index, targetType: 'group' }))
  ];
  const outDevices = devices.map(x => ({ ...x }));
  const outGroups = groups.map(x => ({ ...x }));
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const snap = await readTargetSnapshot(token, item.targetType, item.entity.id);
        const merged = {
          ...item.entity,
          online: snap.online,
          power: snap.power,
          hasOnOff: snap.hasOnOff,
          onOffRetrievable: snap.onOffRetrievable,
          brightness: snap.brightness,
          open: snap.open,
          temperature: snap.temperature,
          ranges: snap.ranges,
          modes: snap.modes,
          toggles: snap.toggles,
          color: snap.color,
          properties: item.targetType === 'device' ? snap.properties : (item.entity.properties || [])
        };
        if (item.targetType === 'group') outGroups[item.index] = merged;
        else outDevices[item.index] = merged;
      } catch (e) {
        // Ошибка запроса не равна offline. Оставляем unknown, чтобы не вводить пользователя в заблуждение.
        logLine('STATUS_REFRESH_WARN', item.targetType, item.entity.id, e?.message || String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, items.length)) }, () => worker()));
  return { devices: outDevices, groups: outGroups };
}

async function dashboardPresenceSnapshot(token, force=false) {
  const now=Date.now();
  if(!force && dashboardPresenceCache.token===token && now-dashboardPresenceCache.at<60000){
    return {devices:dashboardPresenceCache.devices,groups:dashboardPresenceCache.groups,checkedAt:dashboardPresenceCache.at,cached:true};
  }
  let baseDevices=Array.isArray(dashboardDataCache.data?.devices)?dashboardDataCache.data.devices:[];
  let baseGroups=Array.isArray(dashboardDataCache.data?.groups)?dashboardDataCache.data.groups:[];
  if(!baseDevices.length&&!baseGroups.length){
    const info=await getUserInfo(token,false);
    baseDevices=normalizeDevices(info);
    baseGroups=normalizeGroups(info,baseDevices);
  }
  const started=Date.now();
  const hydrated=await hydrateEntitiesOnline(token,baseDevices,baseGroups);
  const devices=hydrated.devices.map(d=>({id:String(d.id||''),online:typeof d.online==='boolean'?d.online:null,offlineText:d.online===false?offlineStatusText('device',d.id):''}));
  const groups=hydrated.groups.map(g=>({id:String(g.id||''),online:typeof g.online==='boolean'?g.online:null,offlineText:g.online===false?offlineStatusText('group',g.id):''}));
  dashboardPresenceCache={token,at:Date.now(),devices,groups};
  if(dashboardDataCache.data&&dashboardDataCache.token===token){
    const dMap=new Map(devices.map(x=>[x.id,x])),gMap=new Map(groups.map(x=>[x.id,x]));
    dashboardDataCache.data={...dashboardDataCache.data,
      devices:(dashboardDataCache.data.devices||[]).map(d=>{const st=dMap.get(String(d.id));return st&&typeof st.online==='boolean'?{...d,online:st.online,offlineText:st.offlineText||''}:d;}),
      groups:(dashboardDataCache.data.groups||[]).map(g=>{const st=gMap.get(String(g.id));return st&&typeof st.online==='boolean'?{...g,online:st.online,offlineText:st.offlineText||''}:g;})
    };
  }
  debugLine('DASHBOARD_PRESENCE',`ms=${Date.now()-started}`,`devices=${devices.length}`,`groups=${groups.length}`);
  return {devices,groups,checkedAt:dashboardPresenceCache.at,cached:false};
}

async function loadDashboardDevices(context, action, suppliedToken = '', force = false, quiet = false) {
  const token = tokenForContext(context, suppliedToken);
  if (!token) {
    sendToPropertyInspector(context, { type: 'dashboardError', message: 'OAuth-токен не сохранён.' }, action);
    return;
  }
  if (suppliedToken && suppliedToken.trim() !== String(globalSettings.token || '').trim()) {
    setGlobalSettings({ token: suppliedToken.trim() });
  }

  if (!quiet) sendToPropertyInspector(context, { type: 'dashboardLoading' }, action);
  try {
    const startedAt=Date.now();
    const data = await getUserInfo(token, force);
    const fast = dashboardDataFromUserInfo(data,token,startedAt);
    debugLine('DASHBOARD_PI_FAST_LOAD',`ms=${fast.loadMs}`,`devices=${fast.devices.length}`,`groups=${fast.groups.length}`,`force=${force?1:0}`);
    sendToPropertyInspector(context, {
      type: 'dashboardDevices',
      devices: fast.devices,
      groups: fast.groups,
      scenarios: fast.scenarios,
      rooms: fast.rooms,
      message: fast.message,
      loadMs: fast.loadMs
    }, action);
  } catch (e) {
    errorLine('YANDEX_ERROR', e?.message || String(e));
    sendToPropertyInspector(context, { type: 'dashboardError', message: e?.message || 'Не удалось загрузить устройства.' }, action);
  }
}

function snapshotFromApiObject(data) {
  const caps = Array.isArray(data?.capabilities) ? data.capabilities : [];
  const onOff = caps.find(c => c?.type === CAP_ONOFF);
  const ranges = caps.filter(c => c?.type === CAP_RANGE).map(normalizeRangeCapability).filter(Boolean);
  const modes = caps.filter(c => c?.type === CAP_MODE).map(normalizeModeCapability).filter(Boolean);
  const toggles = caps.filter(c => c?.type === CAP_TOGGLE).map(normalizeToggleCapability).filter(Boolean);
  const color = normalizeColorCapability(caps.find(c => c?.type === CAP_COLOR));
  const properties = (Array.isArray(data?.properties) ? data.properties : [])
    .map(normalizeProperty)
    .filter(Boolean);
  return {
    online: data?.state === 'offline' ? false : (data?.state === 'online' ? true : null),
    power: onOff?.state?.value === undefined || onOff?.state?.value === null ? null : Boolean(onOff.state.value),
    hasOnOff: Boolean(onOff),
    onOffRetrievable: Boolean(onOff) && onOff?.retrievable !== false,
    brightness: ranges.find(x => x.instance === 'brightness') || null,
    open: ranges.find(x => x.instance === 'open') || null,
    temperature: ranges.find(x => x.instance === 'temperature') || null,
    ranges, modes, toggles, color, properties
  };
}

async function readDeviceSnapshot(token, deviceId) {
  const data = await yandexRequest(token, `/devices/${encodeURIComponent(deviceId)}`);
  return snapshotFromApiObject(data);
}

async function readGroupSnapshot(token, groupId) {
  const data = await yandexRequest(token, `/groups/${encodeURIComponent(groupId)}`);
  return snapshotFromApiObject(data);
}

async function readTargetSnapshot(token, targetType, id) {
  const snap = targetType === 'group' ? await readGroupSnapshot(token, id) : await readDeviceSnapshot(token, id);
  noteTargetPresence(targetType,id,snap.online);
  return snap;
}

function findActionResult(result, deviceId, type, instance) {
  const devices = result?.devices || result?.payload?.devices || [];
  const device = devices.find(d => d?.id === deviceId) || devices[0];
  const caps = device?.capabilities || [];
  const cap = caps.find(c => c?.type === type && (!instance || c?.state?.instance === instance));
  return cap?.state?.action_result;
}

function assertActionDone(result, deviceId, type, instance, fallback) {
  const actionResult = findActionResult(result, deviceId, type, instance);
  if (actionResult?.status === 'ERROR') {
    throw new Error(actionResult.error_message || actionResult.error_code || fallback);
  }
  if (actionResult?.status && actionResult.status !== 'DONE') {
    throw new Error(`Неожиданный статус команды: ${actionResult.status}`);
  }
}

async function setDevicePower(token, deviceId, value) {
  const result = await yandexRequest(token, '/devices/actions', {
    method: 'POST',
    body: JSON.stringify({
      devices: [{
        id: deviceId,
        actions: [{
          type: CAP_ONOFF,
          state: { instance: 'on', value: Boolean(value) }
        }]
      }]
    })
  });
  assertActionDone(result, deviceId, CAP_ONOFF, 'on', 'Яндекс не выполнил команду включения/выключения.');
  return result;
}

async function setRangeValue(token, deviceId, instance, value, relative = false) {
  const state = { instance: String(instance), value: Number(value) };
  if (relative) state.relative = true;
  const result = await yandexRequest(token, '/devices/actions', {
    method: 'POST',
    body: JSON.stringify({
      devices: [{
        id: deviceId,
        actions: [{ type: CAP_RANGE, state }]
      }]
    })
  });
  assertActionDone(result, deviceId, CAP_RANGE, String(instance), `Яндекс не выполнил изменение ${instance}.`);
  return result;
}

async function setLightBrightness(token, deviceId, value, relative = false) {
  return setRangeValue(token, deviceId, 'brightness', value, relative);
}

async function setModeValue(token, deviceId, instance, value) {
  const result = await yandexRequest(token, '/devices/actions', {
    method: 'POST',
    body: JSON.stringify({ devices: [{ id: deviceId, actions: [{
      type: CAP_MODE, state: { instance: String(instance), value: String(value) }
    }] }] })
  });
  assertActionDone(result, deviceId, CAP_MODE, String(instance), `Яндекс не выполнил изменение режима ${instance}.`);
  return result;
}

async function setToggleValue(token, deviceId, instance, value) {
  const result = await yandexRequest(token, '/devices/actions', {
    method: 'POST',
    body: JSON.stringify({ devices: [{ id: deviceId, actions: [{
      type: CAP_TOGGLE, state: { instance: String(instance), value: Boolean(value) }
    }] }] })
  });
  assertActionDone(result, deviceId, CAP_TOGGLE, String(instance), `Яндекс не выполнил переключатель ${instance}.`);
  return result;
}

async function setColorValue(token, deviceId, instance, value) {
  const result = await yandexRequest(token, '/devices/actions', {
    method: 'POST',
    body: JSON.stringify({ devices: [{ id: deviceId, actions: [{
      type: CAP_COLOR, state: { instance: String(instance), value }
    }] }] })
  });
  assertActionDone(result, deviceId, CAP_COLOR, String(instance), `Яндекс не выполнил изменение цвета ${instance}.`);
  return result;
}

function assertGroupActionDone(result, type, instance, fallback) {
  const devices = Array.isArray(result?.devices) ? result.devices : [];
  const errors = [];
  for (const d of devices) {
    const caps = Array.isArray(d?.capabilities) ? d.capabilities : [];
    const cap = caps.find(c => c?.type === type && (!instance || c?.state?.instance === instance));
    const ar = cap?.state?.action_result;
    if (ar?.status === 'ERROR') errors.push(ar.error_message || ar.error_code || d?.id || 'ошибка устройства');
    else if (ar?.status && ar.status !== 'DONE') errors.push(`статус ${ar.status}`);
  }
  if (errors.length) throw new Error(`${fallback} ${errors[0]}`.trim());
}

async function sendTargetAction(token, targetType, id, type, state, fallback) {
  if (targetType !== 'group') {
    const result = await yandexRequest(token, '/devices/actions', {
      method: 'POST',
      body: JSON.stringify({ devices: [{ id, actions: [{ type, state }] }] })
    });
    assertActionDone(result, id, type, state?.instance, fallback);
    return result;
  }
  const result = await yandexRequest(token, `/groups/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    body: JSON.stringify({ actions: [{ type, state }] })
  });
  assertGroupActionDone(result, type, state?.instance, fallback);
  return result;
}

async function setTargetPower(token, targetType, id, value) {
  return sendTargetAction(token, targetType, id, CAP_ONOFF, { instance:'on', value:Boolean(value) }, 'Яндекс не выполнил команду питания.');
}
async function setTargetRange(token, targetType, id, instance, value, relative=false) {
  const state={instance:String(instance), value:Number(value)}; if(relative) state.relative=true;
  return sendTargetAction(token, targetType, id, CAP_RANGE, state, `Яндекс не выполнил изменение ${instance}.`);
}
async function setTargetMode(token, targetType, id, instance, value) {
  return sendTargetAction(token, targetType, id, CAP_MODE, {instance:String(instance), value:String(value)}, `Яндекс не выполнил изменение режима ${instance}.`);
}
async function setTargetToggle(token, targetType, id, instance, value) {
  return sendTargetAction(token, targetType, id, CAP_TOGGLE, {instance:String(instance), value:Boolean(value)}, `Яндекс не выполнил переключатель ${instance}.`);
}
async function setTargetColor(token, targetType, id, instance, value) {
  return sendTargetAction(token, targetType, id, CAP_COLOR, {instance:String(instance), value}, `Яндекс не выполнил изменение цвета ${instance}.`);
}

async function runScenario(token, scenarioId) {
  const result = await yandexRequest(token, `/scenarios/${encodeURIComponent(scenarioId)}/actions`, { method: 'POST' });
  if (result?.status && result.status !== 'ok') throw new Error(result?.message || 'Сценарий не запущен.');
  return result;
}

const COLOR_PRESETS = {
  white: 0xFFFFFF,
  red: 0xFF2D2D,
  green: 0x27D35A,
  blue: 0x318CFF,
  yellow: 0xFFD83D,
  orange: 0xFF8A2B,
  purple: 0xA45BFF,
  pink: 0xFF63B7,
  cyan: 0x32D7E5
};

const COLOR_DIAL_PALETTE = [
  ['Красный',0xFF2D20],['Розовый',0xF95CB5],['Малиновый',0xC72D86],['Бордовый',0x9D160D],
  ['Коралловый',0xE82343],['Оранжевый',0xFF9F18],['Персиковый',0xFF7A4C],['Золотой',0xFFD52B],
  ['Лимонный',0xFFF01A],['Лайм',0xCBE32B],['Зелёный',0x16E52D],['Мятный',0x21DD46],
  ['Тёмно-зелёный',0x238B2E],['Бирюзовый',0x25AEA9],['Аква',0x40D0C9],['Циан',0x11DDE9],
  ['Голубой',0x80E6DF],['Небесный',0xA5D6DE],['Синий',0x1675EA],['Индиго',0x426ADA],
  ['Фиолетовый',0x573B91],['Лиловый',0x9457D8],['Пурпурный',0xEA55ED],['Оливковый',0x7C7E09],
  ['Слива',0x68246A],['Белый',0xFFFFFF],['Серый',0x858585]
].map((x,i)=>({index:i,name:x[0],rgb:x[1]}));
function rgbHex(rgb){return '#'+Number(rgb||0).toString(16).padStart(6,'0').toUpperCase();}
function hsvToRgbInt(v){if(!v||typeof v!=='object')return null;let h=Number(v.h??v.hue),s=Number(v.s??v.saturation),val=Number(v.v??v.value);if(![h,s,val].every(Number.isFinite))return null;s/=100;val/=100;const c=val*s,x=c*(1-Math.abs((h/60)%2-1)),m=val-c;let r=0,g=0,b=0;if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}return ((Math.round((r+m)*255)&255)<<16)|((Math.round((g+m)*255)&255)<<8)|(Math.round((b+m)*255)&255);}
function colorStateRgb(color){if(!color)return null;if(color.stateInstance==='rgb'&&Number.isFinite(Number(color.stateValue)))return Number(color.stateValue);if(color.stateInstance==='hsv')return hsvToRgbInt(color.stateValue);return null;}
function nearestPaletteIndex(rgb){if(!Number.isFinite(Number(rgb)))return 0;const r=(rgb>>16)&255,g=(rgb>>8)&255,b=rgb&255;let best=0,dist=Infinity;for(const p of COLOR_DIAL_PALETTE){const pr=(p.rgb>>16)&255,pg=(p.rgb>>8)&255,pb=p.rgb&255,d=(r-pr)**2+(g-pg)**2+(b-pb)**2;if(d<dist){dist=d;best=p.index;}}return best;}
function colorDialImageDataUri(name,paletteItem,power=true,status='ЦВЕТ'){const item=paletteItem||COLOR_DIAL_PALETTE[0];const safe=escapeXml((name||'Свет').slice(0,24)),label=escapeXml(item.name),hex=rgbHex(item.rgb),muted=power===false;const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122"><rect width="176" height="122" rx="14" fill="#121212"/><text x="16" y="21" fill="#F2F2F2" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="650">${safe}</text><text x="16" y="34" fill="#888" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(status)}</text><circle cx="55" cy="73" r="25" fill="${hex}" opacity="${muted?'.38':'1'}"/><circle cx="55" cy="73" r="29" fill="none" stroke="#FFFFFF" stroke-opacity=".16" stroke-width="2"/><text x="91" y="68" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="13" font-weight="700">${label}</text><text x="91" y="84" fill="#858585" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="9">${hex}</text><text x="16" y="111" fill="#666" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">Вращайте для смены цвета</text></svg>`;return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');}
function scenarioVisual(name){const n=String(name||'').toLocaleLowerCase('ru');if(/ноч|сон|спать|луна/.test(n))return['Ночь','☾','#7057D9'];if(/утр|доброе утро|рассвет|подъ[её]м/.test(n))return['Утро','☀','#F5A623'];if(/кино|фильм|тв|телевиз/.test(n))return['Кино','▶','#568BB5'];if(/штор|жалюз|занавес/.test(n))return['Шторы','▥','#CC9B35'];if(/свет|ламп|люстр|подсвет/.test(n))return['Свет','✦','#E9A12A'];if(/выключ|всё|все|домой|ухожу/.test(n))return['Питание','⏻','#E17A27'];if(/обед|ужин|еда|чай|кофе|готов/.test(n))return['Еда','●','#D98B2C'];if(/прихож|дом|приход/.test(n))return['Дом','⌂','#D0A83B'];return['Сценарий','▶','#8B6DE1'];}
function scenarioIconDataUri(name){const [kind,glyph,accent]=scenarioVisual(name);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="24" fill="#111"/><circle cx="72" cy="62" r="35" fill="${accent}"/><text x="72" y="77" text-anchor="middle" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="42" font-weight="700">${escapeXml(glyph)}</text><text x="72" y="119" text-anchor="middle" fill="#CFCFCF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11">${escapeXml(kind)}</text></svg>`;return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');}

function favoriteScenarioIds() {
  const fav = globalSettings?.dashboardPrefs?.favorites;
  if (!fav || typeof fav !== 'object' || Array.isArray(fav)) return new Set();
  const ids = new Set();
  for (const [key, value] of Object.entries(fav)) {
    if (key.startsWith('scenario:')) ids.add(key.slice('scenario:'.length));
    if (value?.type === 'scenario' && value?.id) ids.add(String(value.id));
  }
  return ids;
}
function scenarioDialList(all, settings) {
  const list = Array.isArray(all) ? all : [];
  if (settings?.scenarioDialSource !== 'all') {
    const ids = favoriteScenarioIds();
    return list.filter(x => ids.has(String(x.id)));
  }
  return list;
}
function scenarioDialRuntimeFor(context) {
  let rt = scenarioDialRuntime.get(context);
  if (!rt) { rt = { index: 0, scenarios: [], total: 0 }; scenarioDialRuntime.set(context, rt); }
  return rt;
}
function scenarioDialImageDataUri(sc, index=0, total=1, source='favorites', status='') {
  if (!sc) {
    const title = source === 'favorites' ? 'Нет избранных' : 'Нет сценариев';
    const hint = source === 'favorites' ? 'Добавьте ★ в панели' : 'Сценарии не найдены';
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122"><rect width="176" height="122" rx="14" fill="#111214"/><circle cx="35" cy="53" r="23" fill="#26232E"/><text x="35" y="61" text-anchor="middle" fill="#8B6DE1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="28">★</text><text x="69" y="47" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="750">${escapeXml(title)}</text><text x="69" y="63" fill="#777D84" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(hint)}</text><text x="16" y="109" fill="#60666E" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">${source==='favorites'?'ИЗБРАННЫЕ':'ВСЕ СЦЕНАРИИ'}</text></svg>`;
    return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  }
  const [kind,glyph,accent]=scenarioVisual(sc.name), safe=escapeXml((sc.name||'Сценарий').slice(0,27));
  const page=`${Math.max(1,index+1)}/${Math.max(1,total)}`, state=escapeXml(status||'НАЖМИТЕ · ЗАПУСТИТЬ');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122"><defs><linearGradient id="sg" x1="0" x2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".20"/><stop offset="1" stop-color="${accent}" stop-opacity=".03"/></linearGradient></defs><rect width="176" height="122" rx="14" fill="#111214"/><rect x="8" y="8" width="160" height="87" rx="13" fill="#191A1E" stroke="#2B2D33"/><rect x="8" y="8" width="160" height="87" rx="13" fill="url(#sg)"/><circle cx="36" cy="51" r="24" fill="${accent}" opacity=".92"/><text x="36" y="61" text-anchor="middle" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="30" font-weight="750">${escapeXml(glyph)}</text><text x="69" y="29" fill="${accent}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8" font-weight="750">${escapeXml(kind.toUpperCase())}</text><text x="69" y="49" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="12" font-weight="760">${safe}</text><text x="69" y="66" fill="#8B9097" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7.2">${state}</text><text x="16" y="110" fill="#666C73" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="7">${source==='favorites'?'★ ИЗБРАННЫЕ':'ВСЕ СЦЕНАРИИ'}</text><text x="160" y="110" text-anchor="end" fill="#858B93" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8" font-weight="700">${page}</text></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
async function refreshScenarioDial(context) {
  const s=getSettings(context), token=tokenForContext(context), rt=scenarioDialRuntimeFor(context);
  setTitle(context,'');
  if(!token){rt.scenarios=[];rt.total=0;setImage(context,scenarioDialImageDataUri(null,0,0,s.scenarioDialSource,'НУЖЕН ТОКЕН'));return;}
  try{
    const data=await getUserInfo(token,false), list=scenarioDialList(scenariosFromInfo(data),s);
    rt.scenarios=list;rt.total=list.length;
    if(!list.length){rt.index=0;setImage(context,scenarioDialImageDataUri(null,0,0,s.scenarioDialSource));return;}
    const wanted=list.findIndex(x=>x.id===s.scenarioId);rt.index=wanted>=0?wanted:Math.max(0,Math.min(rt.index,list.length-1));
    const sc=list[rt.index];
    if(sc && (s.scenarioId!==sc.id||s.scenarioName!==sc.name)) saveSettings(context,{scenarioId:sc.id,scenarioName:sc.name});
    setImage(context,scenarioDialImageDataUri(sc,rt.index,list.length,s.scenarioDialSource));
  }catch(e){errorLine('SCENARIO_DIAL_ERROR',e?.message||String(e));setImage(context,scenarioDialImageDataUri(null,0,0,s.scenarioDialSource,'НЕТ СВЯЗИ'));}
}
function cycleScenarioDial(context,ticks=1){
  scenarioDialContexts.add(context);const rt=scenarioDialRuntimeFor(context),s=getSettings(context);
  if(!rt.scenarios.length){refreshScenarioDial(context);return;}
  const dir=(Number(ticks)||0)>0?1:-1;rt.index=(rt.index+dir+rt.scenarios.length)%rt.scenarios.length;const sc=rt.scenarios[rt.index];
  saveSettings(context,{scenarioId:sc.id,scenarioName:sc.name});setImage(context,scenarioDialImageDataUri(sc,rt.index,rt.scenarios.length,s.scenarioDialSource));
}
async function executeScenarioDial(context){
  const s=getSettings(context),token=tokenForContext(context),rt=scenarioDialRuntimeFor(context),sc=rt.scenarios[rt.index]||null;
  if(!token||!sc){showAlert(context);return;}
  try{setImage(context,scenarioDialImageDataUri(sc,rt.index,rt.scenarios.length,s.scenarioDialSource,'ЗАПУСК…'));await runScenario(token,sc.id);recordUsageFromContext(context,ACTION_SCENARIO,'streamdock');setImage(context,scenarioDialImageDataUri(sc,rt.index,rt.scenarios.length,s.scenarioDialSource,'✓ ЗАПУЩЕН'));setTimeout(()=>{if(visibleContexts.has(context))setImage(context,scenarioDialImageDataUri(sc,rt.index,rt.scenarios.length,getSettings(context).scenarioDialSource));},850);}
  catch(e){errorLine('SCENARIO_ERROR',e?.message||String(e));showAlert(context);setImage(context,scenarioDialImageDataUri(sc,rt.index,rt.scenarios.length,s.scenarioDialSource,'ОШИБКА'));sendToPropertyInspector(context,{type:'error',message:e?.message||'Ошибка запуска сценария.'},ACTION_SCENARIO);}
}

function rgbIntToHsv(rgb) {
  const r=((rgb>>16)&255)/255, g=((rgb>>8)&255)/255, b=(rgb&255)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if (d) {
    if (max===r) h=60*(((g-b)/d)%6);
    else if (max===g) h=60*((b-r)/d+2);
    else h=60*((r-g)/d+4);
  }
  if (h<0) h+=360;
  return { h: Math.round(h), s: Math.round(max===0?0:(d/max)*100), v: Math.round(max*100) };
}

async function refreshToggle(context, action = ACTION_TOGGLE) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  const icons = powerIconsForAction(action);
  if (!token || !s.deviceId) {
    setTitle(context, 'Настройте');
    setImage(context, icons.off);
    return;
  }
  try {
    const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
    if (snapshot.online === false) {
      setImage(context, icons.offline);
      setTitle(context, offlineStatusText(s.targetType,s.deviceId));
      return;
    }
    if (!snapshot.hasOnOff) throw new Error('У устройства нет управления Вкл/Выкл.');
    if (typeof snapshot.power === 'boolean') {
      setImage(context, snapshot.power ? icons.on : icons.off);
      setState(context, snapshot.power ? 1 : 0);
      setTitle(context, snapshot.power ? 'ВКЛ' : 'ВЫКЛ');
      return;
    }
    if (s.powerMode === 'on') {
      setImage(context, icons.on);
      setTitle(context, 'ВКЛ');
    } else if (s.powerMode === 'off') {
      setImage(context, icons.off);
      setTitle(context, 'ВЫКЛ');
    } else {
      setImage(context, icons.off);
      setTitle(context, s.targetType === 'group' ? 'Группа' : 'Команда');
    }
  } catch (e) {
    errorLine('TOGGLE_REFRESH_ERROR', e?.message || String(e));
    console.warn('refreshToggle:', e?.message || e);
    setImage(context, icons.offline);
    setTitle(context, 'Нет связи');
  }
}

function runtimeFor(context) {
  let rt = brightnessRuntime.get(context);
  if (!rt) {
    rt = {
      deviceId: '', value: null, confirmedValue: null, min: 0, max: 100, precision: 1,
      randomAccess: true, retrievable: true, hasBrightness: false, power: null, hasOnOff: true, loading: false, pendingTicks: 0,
      relativeDelta: 0, timer: null, sending: false, dirty: false, lastRotateAt: 0
    };
    brightnessRuntime.set(context, rt);
  }
  return rt;
}

function renderBrightness(context, statusText = '') {
  const s = getSettings(context);
  const rt = runtimeFor(context);
  setImage(context, knobImageDataUri(s.deviceName || 'Лампочка', rt.value, rt.power, rt.min, rt.max, statusText));
}

async function refreshBrightness(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  if (!token || !s.deviceId) {
    const rt = runtimeFor(context);
    rt.value = null;
    rt.power = false;
    renderBrightness(context, 'НАСТРОЙТЕ');
    return;
  }

  const rt = runtimeFor(context);
  if (rt.loading) return;
  rt.loading = true;
  rt.deviceId = s.deviceId;
  renderBrightness(context, 'ОБНОВЛЕНИЕ');
  try {
    const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
    if (snapshot.online === false) { rt.value=null; rt.hasBrightness=false; rt.power=null; renderBrightness(context,offlineStatusText(s.targetType,s.deviceId)); return; }
    if (!snapshot.brightness) throw new Error('У лампы нет управления яркостью.');
    rt.value = snapshot.brightness.value;
    rt.confirmedValue = snapshot.brightness.value;
    rt.min = snapshot.brightness.min;
    rt.max = snapshot.brightness.max;
    rt.precision = snapshot.brightness.precision;
    rt.randomAccess = snapshot.brightness.randomAccess;
    rt.retrievable = snapshot.brightness.retrievable;
    rt.hasBrightness = true;
    rt.power = snapshot.power;
    rt.hasOnOff = snapshot.hasOnOff;
    renderBrightness(context);
  } catch (e) {
    errorLine('BRIGHTNESS_REFRESH_ERROR', e?.message || String(e));
    rt.value = null;
    renderBrightness(context, 'НЕТ СВЯЗИ');
  } finally {
    rt.loading = false;
    if (rt.pendingTicks) {
      const ticks = rt.pendingTicks;
      rt.pendingTicks = 0;
      applyBrightnessTicks(context, ticks);
    }
  }
}

function snapBrightness(value, min, max, precision) {
  const p = Math.max(0.000001, Number(precision) || 1);
  let v = Math.max(min, Math.min(max, value));
  v = min + Math.round((v - min) / p) * p;
  v = Math.max(min, Math.min(max, v));
  return Math.round(v * 1000) / 1000;
}

function normalizedPercentDialStep(value) {
  const n = Number(value);
  return [1,5,10,20].includes(n) ? n : 1;
}

function acceleratedPercentDialStep(rt, configuredStep, ticks, enabled = true) {
  const base = normalizedPercentDialStep(configuredStep);
  const now = Date.now();
  const amount = Math.max(1, Math.abs(Number(ticks) || 1));
  const elapsedPerTick = rt.lastRotateAt ? Math.max(1, now - rt.lastRotateAt) / amount : Number.POSITIVE_INFINITY;
  rt.lastRotateAt = now;
  if (!enabled) return base;
  // Плавная логика: медленное вращение использует выбранный базовый шаг,
  // среднее ускоряется минимум до 5%, быстрое — минимум до 10%.
  if (amount >= 3 || elapsedPerTick < 80) return Math.max(base, 10);
  if (amount >= 2 || elapsedPerTick < 155) return Math.max(base, 5);
  return base;
}

function applyBrightnessTicks(context, ticks) {
  ticks = Number(ticks) || 0;
  if (!ticks) return;
  const s = getSettings(context);
  const token = tokenForContext(context);
  if (!token || !s.deviceId) {
    showAlert(context);
    renderBrightness(context, 'НАСТРОЙТЕ');
    return;
  }

  const rt = runtimeFor(context);
  if (rt.deviceId !== s.deviceId || (!rt.hasBrightness && (rt.value === null || rt.value === undefined))) {
    rt.pendingTicks += ticks;
    refreshBrightness(context);
    return;
  }

  const configuredStep = normalizedPercentDialStep(s.brightnessDialStep);
  const acceleratedStep = acceleratedPercentDialStep(rt, configuredStep, ticks, s.brightnessAcceleration !== false);
  const effectiveStep = Math.max(acceleratedStep, Number(rt.precision) || 1);

  // Некоторые устройства не отдают текущую яркость. Для них крутилка всё равно
  // работает через относительное изменение, а точное значение на дисплее остаётся неизвестным.
  if (rt.value === null || rt.value === undefined) {
    rt.relativeDelta += ticks * effectiveStep;
    const sign = rt.relativeDelta > 0 ? '+' : '';
    renderBrightness(context, `ИЗМЕНЕНИЕ ${sign}${Math.round(rt.relativeDelta)}%`);
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = setTimeout(() => commitBrightness(context), 180);
    return;
  }

  const target = snapBrightness(rt.value + ticks * effectiveStep, rt.min, rt.max, rt.precision);
  if (target === rt.value) return;

  rt.value = target;
  renderBrightness(context);
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = setTimeout(() => commitBrightness(context), 180);
}

async function commitBrightness(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  const rt = runtimeFor(context);
  if (!token || !s.deviceId) return;
  if (rt.value === null && !rt.relativeDelta) return;
  if (rt.sending) {
    rt.dirty = true;
    return;
  }

  rt.sending = true;
  rt.dirty = false;
  const target = rt.value;
  const relativeDelta = rt.relativeDelta;
  try {
    if (target === null || target === undefined) {
      if (relativeDelta !== 0) await setTargetRange(token, s.targetType, s.deviceId, 'brightness', relativeDelta, true);
      rt.relativeDelta -= relativeDelta;
    } else if (rt.randomAccess === false) {
      const base = Number.isFinite(Number(rt.confirmedValue)) ? Number(rt.confirmedValue) : target;
      const delta = target - base;
      if (delta !== 0) await setTargetRange(token, s.targetType, s.deviceId, 'brightness', delta, true);
      rt.confirmedValue = target;
    } else {
      await setTargetRange(token, s.targetType, s.deviceId, 'brightness', target, false);
      rt.confirmedValue = target;
    }
    renderBrightness(context);
  } catch (e) {
    errorLine('BRIGHTNESS_SET_ERROR', e?.message || String(e));
    showAlert(context);
    renderBrightness(context, 'ОШИБКА');
    sendToPropertyInspector(context, { type: 'error', message: e?.message || 'Ошибка изменения яркости.' }, ACTION_BRIGHTNESS);
    setTimeout(() => refreshBrightness(context), 350);
  } finally {
    rt.sending = false;
    if (rt.dirty || rt.value !== target || rt.relativeDelta !== 0) {
      rt.timer = setTimeout(() => commitBrightness(context), 100);
    }
  }
}

async function refreshSensor(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  setTitle(context, '');
  if (!token || !s.deviceId) {
    setImage(context, sensorImageDataUri('Датчик', null, 'НАСТРОЙТЕ', '', s.sensorDialStyle));
    return;
  }
  try {
    const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
    if (snapshot.online === false) { setImage(context, sensorImageDataUri(s.deviceName || 'Датчик', null, offlineStatusText(s.targetType,s.deviceId), '', s.sensorDialStyle)); return; }
    if (!snapshot.properties.length) throw new Error('У устройства нет доступных показаний.');
    let prop = snapshot.properties.find(p => p.instance === s.propertyInstance) || snapshot.properties[0];
    if (prop.instance !== s.propertyInstance) saveSettings(context, { propertyInstance: prop.instance });
    setImage(context, sensorImageDataUri(s.deviceName || 'Датчик', prop, '', sensorSeverity(prop,s), s.sensorDialStyle));
    sendToPropertyInspector(context, {
      type: 'sensorSnapshot',
      property: prop,
      properties: snapshot.properties
    }, ACTION_SENSOR);
  } catch (e) {
    errorLine('SENSOR_REFRESH_ERROR', e?.message || String(e));
    setImage(context, sensorImageDataUri(s.deviceName || 'Датчик', null, 'НЕТ СВЯЗИ', '', s.sensorDialStyle));
  }
}

function combinedRuntimeFor(context){let r=combinedRuntime.get(context);if(!r){r={page:0,totalPages:1};combinedRuntime.set(context,r);}return r;}
function selectedCombinedProps(snapshot,s){const wanted=String(s.combinedInstances||'').split(',').filter(Boolean);const all=snapshot.properties||[];let props=wanted.length?wanted.map(x=>all.find(p=>p.instance===x)).filter(Boolean):[];if(!props.length){const priority=['temperature','humidity','co2_level','pm2.5_density','pm10_density','battery_level'];props=[...priority.map(x=>all.find(p=>p.instance===x)).filter(Boolean),...all.filter(p=>!priority.includes(p.instance))].slice(0,6);}return props;}
async function refreshCombinedSensor(context){
  const s=getSettings(context),token=tokenForContext(context),rt=combinedRuntimeFor(context),style=['minimal','widget'].includes(s.sensorDialStyle)?s.sensorDialStyle:'widget';setTitle(context,'');
  if(!token||!s.deviceId){setImage(context,combinedSensorImageDataUri('Датчик',[],'НАСТРОЙТЕ',style));return;}
  try{
    const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);
    if(snap.online===false){setImage(context,combinedSensorImageDataUri(s.deviceName||'Датчик',[],offlineStatusText(s.targetType,s.deviceId),style));return;}
    const props=selectedCombinedProps(snap,s);if(!props.length)throw new Error('Показания не найдены.');
    if(informationContexts.has(context)){
      rt.page=0;rt.totalPages=1;
      setImage(context,combinedSensorImageDataUri(s.deviceName||'Датчик',props.slice(0,3),props.length>3?'3 ИЗ '+props.length:'ИНФОРМАЦИОННАЯ ДОСКА',style));
    }else{
      rt.totalPages=Math.max(1,Math.ceil(props.length/3));rt.page=Math.min(rt.page,rt.totalPages-1);const page=props.slice(rt.page*3,rt.page*3+3);
      setImage(context,combinedSensorImageDataUri(s.deviceName||'Датчик',page,rt.totalPages>1?`${rt.page+1}/${rt.totalPages} · НАЖАТЬ ДАЛЬШЕ`:'',style));
    }
    sendToPropertyInspector(context,{type:'sensorSnapshot',properties:snap.properties},ACTION_SENSOR_MULTI);
  }catch(e){errorLine('MULTI_SENSOR_ERROR',e?.message||String(e));setImage(context,combinedSensorImageDataUri(s.deviceName||'Датчик',[],'НЕТ СВЯЗИ',style));}
}

function cycleCombinedSensor(context){const rt=combinedRuntimeFor(context);rt.page=rt.totalPages>1?(rt.page+1)%rt.totalPages:0;refreshCombinedSensor(context);}
function sensorMultiDialRuntimeFor(context){let r=sensorMultiDialRuntime.get(context);if(!r){r={index:0,total:0};sensorMultiDialRuntime.set(context,r);}return r;}
async function refreshSensorMultiDial(context){
  const s=getSettings(context),token=tokenForContext(context),rt=sensorMultiDialRuntimeFor(context);setTitle(context,'');
  const style=['minimal','widget'].includes(s.sensorDialStyle)?s.sensorDialStyle:'widget';
  if(!token||!s.deviceId){setImage(context,sensorDialImageDataUri('Датчик',null,0,1,style,'',false,'НАСТРОЙТЕ'));return;}
  try{
    const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);
    if(snap.online===false){setImage(context,sensorDialImageDataUri(s.deviceName||'Датчик',null,0,1,style,'',false,offlineStatusText(s.targetType,s.deviceId)));return;}
    const props=selectedCombinedProps(snap,s);if(!props.length)throw new Error('Показания не найдены.');
    rt.total=props.length;rt.index=Math.max(0,Math.min(rt.index,props.length-1));
    const prop=props[rt.index],severity=sensorSeverity(prop,s);
    setImage(context,sensorDialImageDataUri(s.deviceName||'Датчик',prop,rt.index,props.length,style,severity,Boolean(s.sensorThresholdEnabled),''));
    sendToPropertyInspector(context,{type:'sensorSnapshot',property:prop,properties:snap.properties},ACTION_SENSOR_MULTI);
  }catch(e){errorLine('SENSOR_DIAL_ERROR',e?.message||String(e));setImage(context,sensorDialImageDataUri(s.deviceName||'Датчик',null,0,1,style,'',false,'НЕТ СВЯЗИ'));}
}
function cycleSensorMultiDial(context,ticks=1){sensorMultiDialContexts.add(context);const rt=sensorMultiDialRuntimeFor(context);if(!rt.total){refreshSensorMultiDial(context);return;}const dir=(Number(ticks)||0)>0?1:-1;rt.index=(rt.index+dir+rt.total)%rt.total;refreshSensorMultiDial(context);}

async function refreshHomeSummary(context){
  const token=tokenForContext(context),s=getSettings(context),template=s.infoTemplate||'home';setTitle(context,'');
  const offlineImage=()=>template==='climate'?informationClimateImageDataUri([],'НЕТ СВЯЗИ'):template==='alerts'?informationAlertsImageDataUri([],'НЕТ СВЯЗИ'):template==='favorites'?informationFavoritesImageDataUri([],[],[],'НЕТ СВЯЗИ'):homeSummaryImageDataUri({},'НЕТ СВЯЗИ');
  if(!token){setImage(context,template==='climate'?informationClimateImageDataUri([],'НУЖЕН ТОКЕН'):template==='alerts'?informationAlertsImageDataUri([],'НУЖЕН ТОКЕН'):template==='favorites'?informationFavoritesImageDataUri([],[],[],'НУЖЕН ТОКЕН'):homeSummaryImageDataUri({},'НУЖЕН ТОКЕН'));return;}
  try{
    const data=await getUserInfo(token,false),devices=normalizeDevices(data),groups=normalizeGroups(data,devices),scenarios=scenariosFromInfo(data);
    if(template==='climate')setImage(context,informationClimateImageDataUri(devices));
    else if(template==='alerts')setImage(context,informationAlertsImageDataUri(devices));
    else if(template==='favorites')setImage(context,informationFavoritesImageDataUri(devices,groups,scenarios));
    else{const total=devices.length,online=devices.filter(d=>d.online!==false).length,lightsOn=devices.filter(d=>d.isLight&&d.power===true).length;setImage(context,homeSummaryImageDataUri({total,online,lightsOn}));}
  }catch(e){errorLine('HOME_SUMMARY_ERROR',e?.message||String(e));setImage(context,offlineImage());}
}

function curtainDisplayValue(settings, raw, min, max) {
  if (!Number.isFinite(Number(raw))) return null;
  const v = Number(raw);
  return settings?.curtainReverse ? (Number(min) + Number(max) - v) : v;
}

function curtainApiValue(settings, display, min, max) {
  if (!Number.isFinite(Number(display))) return display;
  const v = Number(display);
  return settings?.curtainReverse ? (Number(min) + Number(max) - v) : v;
}

function curtainApiDelta(settings, displayDelta) {
  return settings?.curtainReverse ? -Number(displayDelta) : Number(displayDelta);
}

function curtainRuntimeFor(context) {
  let rt = curtainRuntime.get(context);
  if (!rt) {
    rt = {
      deviceId: '', value: null, confirmedValue: null, min: 0, max: 100, precision: 1,
      randomAccess: true, retrievable: true, hasOpen: false, loading: false, pendingTicks: 0,
      relativeDelta: 0, timer: null, sending: false, dirty: false, lastRotateAt: 0
    };
    curtainRuntime.set(context, rt);
  }
  return rt;
}

function renderCurtain(context, statusText = '') {
  const s = getSettings(context);
  const rt = curtainRuntimeFor(context);
  setImage(context, curtainImageDataUri(s.deviceName || 'Шторы', rt.value, statusText));
}

async function refreshCurtain(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  if (!token || !s.deviceId) {
    const rt = curtainRuntimeFor(context);
    rt.value = null;
    renderCurtain(context, 'НАСТРОЙТЕ');
    return;
  }
  const rt = curtainRuntimeFor(context);
  if (rt.loading) return;
  rt.loading = true;
  rt.deviceId = s.deviceId;
  renderCurtain(context, 'ОБНОВЛЕНИЕ');
  try {
    const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
    if (snapshot.online === false) { rt.value=null; rt.hasOpen=false; renderCurtain(context,offlineStatusText(s.targetType,s.deviceId)); return; }
    if (!snapshot.open) throw new Error('У устройства нет управления открытием.');
    rt.min = snapshot.open.min;
    rt.max = snapshot.open.max;
    rt.value = curtainDisplayValue(s, snapshot.open.value, rt.min, rt.max);
    rt.confirmedValue = rt.value;
    rt.precision = snapshot.open.precision;
    rt.randomAccess = snapshot.open.randomAccess;
    rt.retrievable = snapshot.open.retrievable;
    rt.hasOpen = true;
    renderCurtain(context);
  } catch (e) {
    errorLine('CURTAIN_REFRESH_ERROR', e?.message || String(e));
    rt.value = null;
    renderCurtain(context, 'НЕТ СВЯЗИ');
  } finally {
    rt.loading = false;
    if (rt.pendingTicks) {
      const ticks = rt.pendingTicks;
      rt.pendingTicks = 0;
      applyCurtainTicks(context, ticks);
    }
  }
}

function applyCurtainTicks(context, ticks) {
  ticks = Number(ticks) || 0;
  if (!ticks) return;
  const s = getSettings(context);
  const token = tokenForContext(context);
  if (!token || !s.deviceId) {
    showAlert(context);
    renderCurtain(context, 'НАСТРОЙТЕ');
    return;
  }
  const rt = curtainRuntimeFor(context);
  if (rt.deviceId !== s.deviceId || !rt.hasOpen) {
    rt.pendingTicks += ticks;
    refreshCurtain(context);
    return;
  }
  const configuredStep = normalizedPercentDialStep(s.curtainDialStep);
  const acceleratedStep = acceleratedPercentDialStep(rt, configuredStep, ticks, s.curtainAcceleration !== false);
  const effectiveStep = Math.max(acceleratedStep, Number(rt.precision) || 1);
  if (rt.value === null || rt.value === undefined) {
    rt.relativeDelta += ticks * effectiveStep;
    const sign = rt.relativeDelta > 0 ? '+' : '';
    renderCurtain(context, `ИЗМЕНЕНИЕ ${sign}${Math.round(rt.relativeDelta)}%`);
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = setTimeout(() => commitCurtain(context), 180);
    return;
  }
  const target = snapBrightness(rt.value + ticks * effectiveStep, rt.min, rt.max, rt.precision);
  if (target === rt.value) return;
  rt.value = target;
  renderCurtain(context);
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = setTimeout(() => commitCurtain(context), 180);
}

async function commitCurtain(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  const rt = curtainRuntimeFor(context);
  if (!token || !s.deviceId) return;
  if (rt.value === null && !rt.relativeDelta) return;
  if (rt.sending) {
    rt.dirty = true;
    return;
  }
  rt.sending = true;
  rt.dirty = false;
  const target = rt.value;
  const relativeDelta = rt.relativeDelta;
  try {
    if (target === null || target === undefined) {
      if (relativeDelta !== 0) await setRangeValue(token, s.deviceId, 'open', curtainApiDelta(s, relativeDelta), true);
      rt.relativeDelta -= relativeDelta;
    } else if (rt.randomAccess === false) {
      const base = Number.isFinite(Number(rt.confirmedValue)) ? Number(rt.confirmedValue) : target;
      const delta = target - base;
      if (delta !== 0) await setRangeValue(token, s.deviceId, 'open', curtainApiDelta(s, delta), true);
      rt.confirmedValue = target;
    } else {
      await setRangeValue(token, s.deviceId, 'open', curtainApiValue(s, target, rt.min, rt.max), false);
      rt.confirmedValue = target;
    }
    renderCurtain(context);
  } catch (e) {
    errorLine('CURTAIN_SET_ERROR', e?.message || String(e));
    showAlert(context);
    renderCurtain(context, 'ОШИБКА');
    sendToPropertyInspector(context, { type: 'error', message: e?.message || 'Ошибка управления шторами.' }, ACTION_CURTAIN);
    setTimeout(() => refreshCurtain(context), 350);
  } finally {
    rt.sending = false;
    if (rt.dirty || rt.value !== target || rt.relativeDelta !== 0) {
      rt.timer = setTimeout(() => commitCurtain(context), 100);
    }
  }
}

async function toggleCurtain(context) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  if (!token || !s.deviceId) {
    showAlert(context);
    renderCurtain(context, 'НАСТРОЙТЕ');
    return;
  }
  const rt = curtainRuntimeFor(context);
  try {
    if (!Number.isFinite(Number(rt.value))) await refreshCurtain(context);
    if (!Number.isFinite(Number(rt.value))) throw new Error('Текущее положение штор недоступно.');
    const midpoint = (rt.min + rt.max) / 2;
    const target = rt.value > midpoint ? rt.min : rt.max;
    if (rt.randomAccess === false) {
      await setRangeValue(token, s.deviceId, 'open', curtainApiDelta(s, target - rt.value), true);
    } else {
      await setRangeValue(token, s.deviceId, 'open', curtainApiValue(s, target, rt.min, rt.max), false);
    }
    rt.value = target;
    rt.confirmedValue = target;
    renderCurtain(context);
  } catch (e) {
    errorLine('CURTAIN_TOGGLE_ERROR', e?.message || String(e));
    showAlert(context);
    renderCurtain(context, 'ОШИБКА');
    sendToPropertyInspector(context, { type: 'error', message: e?.message || 'Ошибка управления шторами.' }, ACTION_CURTAIN);
  }
}

function relativeMediaImageDataUri(name, label, direction = '', delta = 0, accent = '#8B6DE1') {
  const safeName=escapeXml((name||'ТВ / ИК').slice(0,24));
  const safeLabel=escapeXml(label||'КОМАНДА');
  const positive=Number(delta)>0, negative=Number(delta)<0;
  const dirText=direction || (positive?'БОЛЬШЕ':negative?'МЕНЬШЕ':'ВРАЩАЙТЕ РУЧКУ');
  const amount=Math.abs(Number(delta)||0);
  const center=amount?`${positive?'+':'−'}${amount}`:'↔';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
    <rect width="176" height="122" rx="14" fill="#121212"/>
    <text x="16" y="21" fill="#F2F2F2" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="650">${safeName}</text>
    <text x="16" y="35" fill="#8C8C8C" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${safeLabel}</text>
    <rect x="16" y="49" width="42" height="42" rx="12" fill="${negative?accent:'#242424'}" opacity="${negative?'.95':'1'}"/>
    <text x="37" y="77" text-anchor="middle" fill="#FFF" font-family="Arial" font-size="24" font-weight="700">−</text>
    <rect x="118" y="49" width="42" height="42" rx="12" fill="${positive?accent:'#242424'}" opacity="${positive?'.95':'1'}"/>
    <text x="139" y="77" text-anchor="middle" fill="#FFF" font-family="Arial" font-size="24" font-weight="700">+</text>
    <text x="88" y="72" text-anchor="middle" fill="#FFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="17" font-weight="750">${escapeXml(center)}</text>
    <text x="88" y="107" text-anchor="middle" fill="#777" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(dirText)}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

function modeIconSvg(mode,cx,cy,color){
  mode=String(mode||'').toLowerCase();
  if(mode==='turbo'||mode==='max')return `<path d="M ${cx-8} ${cy-7} Q ${cx+3} ${cy-11} ${cx+8} ${cy-5} Q ${cx+2} ${cy-2} ${cx-5} ${cy-2} M ${cx-6} ${cy+1} Q ${cx+2} ${cy-2} ${cx+6} ${cy+2} Q ${cx+1} ${cy+5} ${cx-4} ${cy+5} M ${cx-3} ${cy+8} Q ${cx+1} ${cy+6} ${cx+3} ${cy+8}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
  const scale=(mode==='low'||mode==='slow'||mode==='quiet')?.72:(mode==='medium'||mode==='normal')?.86:1;
  let blades='';for(let i=0;i<5;i++)blades+=`<ellipse cx="${cx}" cy="${cy-5.7}" rx="2.15" ry="5" fill="${color}" transform="rotate(${i*72} ${cx} ${cy}) scale(${scale})"/>`;
  return `<g><circle cx="${cx}" cy="${cy}" r="2.2" fill="${color}"/>${blades}</g>`;
}
function modeGridImageDataUri(name, modes, selectedIndex=0, subtitle='СКОРОСТЬ', accent='#6BD3B3') {
  const safeName=escapeXml((name||'Вентилятор').slice(0,24));
  const list=(Array.isArray(modes)?modes:[]).slice(0,4);
  const labels=list.map(v=>MODE_LABELS[v]||v);
  const coords=[[12,48],[90,48],[12,82],[90,82]];
  let tiles='';
  for(let i=0;i<list.length;i++){
    const [x,y]=coords[i],active=i===selectedIndex,label=escapeXml(String(labels[i]).slice(0,9)),fg=active?'#FFFFFF':'#DADADA';
    tiles+=`<rect x="${x}" y="${y}" width="72" height="29" rx="9" fill="${active?accent:'#25262A'}" opacity="${active?'.96':'1'}"/>${modeIconSvg(list[i],x+14,y+14.5,fg)}<text x="${x+28}" y="${y+18}" fill="${fg}" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8" font-weight="${active?'750':'600'}">${label}</text>`;
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122"><rect width="176" height="122" rx="14" fill="#121212"/><text x="14" y="19" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="650">${safeName}</text><text x="14" y="33" fill="#8B8B8B" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${escapeXml(subtitle)}</text>${tiles}</svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

function modeGlyphForValue(value){
  const v=String(value||'').toLowerCase();
  if(['turbo','max'].includes(v)) return '✦';
  if(['high','fast'].includes(v)) return '✹';
  if(['medium','normal'].includes(v)) return '✣';
  if(['low','slow','quiet','min'].includes(v)) return '◌';
  if(['eco'].includes(v)) return '◇';
  return '●';
}
function selectedModeImageDataUri(name, value, subtitle='СКОРОСТЬ', accent='#7C5CFF'){
  const label=MODE_LABELS[value]||String(value||'—');
  const safeName=escapeXml((name||'Устройство').slice(0,24));
  const safeLabel=escapeXml(label);
  const safeSub=escapeXml(String(subtitle||''));
  const fs=safeLabel.length>12?14:safeLabel.length>9?16:19;
  const icon=modeIconSvg(value,51,71,accent);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
    <rect width="176" height="122" rx="14" fill="#121212"/>
    <text x="16" y="20" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="650">${safeName}</text>
    <text x="16" y="33" fill="#8A8A8A" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${safeSub}</text>
    <circle cx="51" cy="71" r="30" fill="${accent}" opacity=".12"/>
    <circle cx="51" cy="71" r="24" fill="#202126" stroke="${accent}" stroke-opacity=".45"/>
    ${icon}
    <text x="91" y="68" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${fs}" font-weight="750">${safeLabel}</text>
    <text x="91" y="85" fill="#777" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">Поверните для смены</text>
  </svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}


function genericKnobImageDataUri(name, valueText, progress = 0, subtitle = '', accent = '#FFD43B') {
  const safeName = escapeXml((name || 'Устройство').slice(0, 24));
  const safeValue = escapeXml(String(valueText ?? '—'));
  const safeSub = escapeXml(String(subtitle || ''));
  const pct = Math.max(0, Math.min(1, Number(progress) || 0));
  const barW = Math.round(142 * pct);
  const fs = safeValue.length > 11 ? 22 : safeValue.length > 7 ? 28 : 36;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="122">
    <rect width="176" height="122" rx="14" fill="#121212"/>
    <circle cx="25" cy="26" r="11" fill="${accent}" opacity=".95"/>
    <circle cx="25" cy="26" r="5" fill="#121212" opacity=".65"/>
    <text x="43" y="22" fill="#F1F1F1" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="11" font-weight="600">${safeName}</text>
    <text x="43" y="36" fill="#929292" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="8">${safeSub}</text>
    <text x="88" y="83" text-anchor="middle" fill="#FFFFFF" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${fs}" font-weight="700">${safeValue}</text>
    <rect x="17" y="101" width="142" height="7" rx="3.5" fill="#313131"/>
    <rect x="17" y="101" width="${barW}" height="7" rx="3.5" fill="${accent}"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function rangeRuntimeFor(context) {
  let rt = rangeRuntime.get(context);
  if (!rt) {
    rt = { deviceId:'', value:null, confirmedValue:null, min:0, max:100, precision:1, randomAccess:true, retrievable:true, power:null, timer:null, sending:false, dirty:false, pendingTicks:0 };
    rangeRuntime.set(context, rt);
  }
  return rt;
}

function rangeActionConfig(action) {
  if (action === ACTION_KETTLE_TEMP) return { instance:'temperature', label:'ТЕМПЕРАТУРА', unit:'°C', accent:'#FF9B52', defaultStep:5 };
  if (action === ACTION_MEDIA_VOLUME) return { instance:'volume', label:'ГРОМКОСТЬ', unit:'%', accent:'#8B6DE1', defaultStep:1 };
  if (action === ACTION_MEDIA_CHANNEL) return { instance:'channel', label:'КАНАЛ', unit:'', accent:'#6F91FF', defaultStep:1 };
  return null;
}

function renderRangeKnob(context, action, status='') {
  const cfg = rangeActionConfig(action);
  const s = getSettings(context), rt = rangeRuntimeFor(context);
  const valueText = Number.isFinite(Number(rt.value)) ? `${Math.round(rt.value*10)/10}${cfg?.unit||''}` : '—';
  const progress = Number.isFinite(Number(rt.value)) ? (rt.value-rt.min)/Math.max(1,rt.max-rt.min) : 0;
  setImage(context, genericKnobImageDataUri(s.deviceName || 'Устройство', valueText, progress, status || cfg?.label || '', cfg?.accent));
}

async function refreshRangeKnob(context, action) {
  const cfg=rangeActionConfig(action), s=getSettings(context), token=tokenForContext(context), rt=rangeRuntimeFor(context);
  if (!cfg || !token || !s.deviceId) { renderRangeKnob(context, action, 'НАСТРОЙТЕ'); return; }
  try {
    const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);
    if(snap.online===false){renderRangeKnob(context,action,offlineStatusText(s.targetType,s.deviceId));return;}
    const desc=snap.ranges.find(x=>x.instance===cfg.instance);
    if (!desc) throw new Error('Нужный диапазон не поддерживается.');
    Object.assign(rt,{deviceId:s.deviceId,value:desc.value,confirmedValue:desc.value,min:desc.min,max:desc.max,precision:desc.precision,randomAccess:desc.randomAccess,retrievable:desc.retrievable,power:snap.power,relativeDelta:0});
    if([ACTION_MEDIA_VOLUME,ACTION_MEDIA_CHANNEL].includes(action) && (desc.randomAccess===false || desc.retrievable===false || !Number.isFinite(Number(desc.value)))){
      setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,'',0,cfg.accent));setTitle(context,'');return;
    }
    renderRangeKnob(context,action);
  } catch(e) { errorLine('RANGE_REFRESH_ERROR',action,e?.message||String(e)); renderRangeKnob(context,action,'НЕТ СВЯЗИ'); }
}

function applyRangeTicks(context, action, ticks) {
  ticks=Number(ticks)||0; if(!ticks) return;
  const cfg=rangeActionConfig(action), s=getSettings(context), token=tokenForContext(context), rt=rangeRuntimeFor(context);
  if(!cfg||!token||!s.deviceId){showAlert(context);renderRangeKnob(context,action,'НАСТРОЙТЕ');return;}
  if(rt.deviceId!==s.deviceId){rt.pendingTicks+=ticks;refreshRangeKnob(context,action).then(()=>{if(rt.pendingTicks){const t=rt.pendingTicks;rt.pendingTicks=0;applyRangeTicks(context,action,t);}});return;}
  if([ACTION_MEDIA_VOLUME,ACTION_MEDIA_CHANNEL].includes(action) && (rt.randomAccess===false || rt.retrievable===false || !Number.isFinite(Number(rt.value)))){
    const step=action===ACTION_MEDIA_VOLUME?Math.max(1,Math.min(20,Number(s.mediaVolumeStep)||1)):Math.max(1,Number(cfg.defaultStep)||1);rt.relativeDelta=(Number(rt.relativeDelta)||0)+ticks*step;
    const dir=rt.relativeDelta>0?(action===ACTION_MEDIA_VOLUME?'ГРОМЧЕ':'СЛЕДУЮЩИЙ КАНАЛ'):(action===ACTION_MEDIA_VOLUME?'ТИШЕ':'ПРЕДЫДУЩИЙ КАНАЛ');
    setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,dir,rt.relativeDelta,cfg.accent));setTitle(context,'');
    if(rt.timer)clearTimeout(rt.timer);rt.timer=setTimeout(()=>commitRelativeMedia(context,action),110);return;
  }
  if(!Number.isFinite(Number(rt.value))){rt.pendingTicks+=ticks;refreshRangeKnob(context,action).then(()=>{if(rt.pendingTicks){const t=rt.pendingTicks;rt.pendingTicks=0;applyRangeTicks(context,action,t);}});return;}
  const baseSetting = action===ACTION_KETTLE_TEMP ? Number(s.temperatureStep) : (action===ACTION_MEDIA_VOLUME ? Number(s.mediaVolumeStep) : cfg.defaultStep);
  const configured=Math.max(1,Math.min(25,baseSetting||cfg.defaultStep));
  const step=Math.max(configured,Number(rt.precision)||1);
  const target=snapBrightness(rt.value+ticks*step,rt.min,rt.max,rt.precision);
  if(target===rt.value)return; rt.value=target; renderRangeKnob(context,action);
  if(rt.timer)clearTimeout(rt.timer); rt.timer=setTimeout(()=>commitRangeKnob(context,action),180);
}

async function commitRelativeMedia(context,action){const cfg=rangeActionConfig(action),s=getSettings(context),token=tokenForContext(context),rt=rangeRuntimeFor(context);if(!cfg||!token||!s.deviceId)return;const delta=Number(rt.relativeDelta)||0;if(!delta)return;rt.relativeDelta=0;try{await setTargetRange(token,s.targetType,s.deviceId,cfg.instance,delta,true);setTimeout(()=>{if((Number(rt.relativeDelta)||0)===0)setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,'',0,cfg.accent));},450);}catch(e){errorLine('RELATIVE_MEDIA_ERROR',action,e?.message||String(e));showAlert(context);setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,'ОШИБКА',0,'#D65A5A'));}}

async function commitRangeKnob(context, action) {
  const cfg=rangeActionConfig(action), s=getSettings(context), token=tokenForContext(context), rt=rangeRuntimeFor(context);
  if(!cfg||!token||!s.deviceId||!Number.isFinite(Number(rt.value)))return;
  if(rt.sending){rt.dirty=true;return;} rt.sending=true;rt.dirty=false;const target=rt.value;
  try {
    if(rt.randomAccess===false){const base=Number.isFinite(Number(rt.confirmedValue))?rt.confirmedValue:target;const delta=target-base;if(delta)await setRangeValue(token,s.deviceId,cfg.instance,delta,true);}
    else await setRangeValue(token,s.deviceId,cfg.instance,target,false);
    rt.confirmedValue=target; renderRangeKnob(context,action);
  }catch(e){errorLine('RANGE_SET_ERROR',action,e?.message||String(e));showAlert(context);renderRangeKnob(context,action,'ОШИБКА');}
  finally{rt.sending=false;if(rt.dirty||rt.value!==target)rt.timer=setTimeout(()=>commitRangeKnob(context,action),100);}
}

function colorTempRuntimeFor(context) {
  let rt=colorTempRuntime.get(context);
  if(!rt){rt={deviceId:'',value:null,min:2000,max:9000,power:null,timer:null,sending:false,dirty:false,pendingTicks:0};colorTempRuntime.set(context,rt);} return rt;
}

function renderColorTemp(context,status=''){
  const s=getSettings(context),rt=colorTempRuntimeFor(context);
  const valueText=Number.isFinite(Number(rt.value))?`${Math.round(rt.value)}K`:'—';
  const progress=Number.isFinite(Number(rt.value))?(rt.value-rt.min)/Math.max(1,rt.max-rt.min):0;
  setImage(context,genericKnobImageDataUri(s.deviceName||'Свет',valueText,progress,status||'ТЕМП. СВЕТА','#FFB85A'));
}
async function refreshColorTemp(context){
  const s=getSettings(context),token=tokenForContext(context),rt=colorTempRuntimeFor(context);
  if(!token||!s.deviceId){renderColorTemp(context,'НАСТРОЙТЕ');return;}
  try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false){renderColorTemp(context,offlineStatusText(s.targetType,s.deviceId));return;}if(!snap.color?.supportsTemperature)throw new Error('Температура света не поддерживается.');rt.deviceId=s.deviceId;rt.min=snap.color.temperatureMin;rt.max=snap.color.temperatureMax;rt.value=snap.color.stateInstance==='temperature_k'&&Number.isFinite(Number(snap.color.stateValue))?Number(snap.color.stateValue):Math.max(rt.min,Math.min(rt.max,4500));rt.power=snap.power;renderColorTemp(context);}catch(e){errorLine('COLORTEMP_REFRESH_ERROR',e?.message||String(e));renderColorTemp(context,'НЕТ СВЯЗИ');}
}
function applyColorTempTicks(context,ticks){
  ticks=Number(ticks)||0;if(!ticks)return;const s=getSettings(context),token=tokenForContext(context),rt=colorTempRuntimeFor(context);
  if(!token||!s.deviceId){showAlert(context);renderColorTemp(context,'НАСТРОЙТЕ');return;}
  if(rt.deviceId!==s.deviceId||!Number.isFinite(Number(rt.value))){rt.pendingTicks+=ticks;refreshColorTemp(context).then(()=>{if(rt.pendingTicks){const t=rt.pendingTicks;rt.pendingTicks=0;applyColorTempTicks(context,t);}});return;}
  const step=Math.max(50,Math.min(1000,Number(s.colorTemperatureStep)||250));rt.value=Math.max(rt.min,Math.min(rt.max,rt.value+ticks*step));renderColorTemp(context);if(rt.timer)clearTimeout(rt.timer);rt.timer=setTimeout(()=>commitColorTemp(context),180);
}
async function commitColorTemp(context){const s=getSettings(context),token=tokenForContext(context),rt=colorTempRuntimeFor(context);if(!token||!s.deviceId||!Number.isFinite(Number(rt.value)))return;if(rt.sending){rt.dirty=true;return;}rt.sending=true;rt.dirty=false;const target=Math.round(rt.value);try{await setTargetColor(token,s.targetType,s.deviceId,'temperature_k',target);renderColorTemp(context);}catch(e){errorLine('COLORTEMP_SET_ERROR',e?.message||String(e));showAlert(context);renderColorTemp(context,'ОШИБКА');}finally{rt.sending=false;if(rt.dirty||Math.round(rt.value)!==target)rt.timer=setTimeout(()=>commitColorTemp(context),100);}}

function modeRuntimeFor(context){let rt=modeRuntime.get(context);if(!rt){rt={deviceId:'',modes:[],value:null,index:0,power:null,timer:null};modeRuntime.set(context,rt);}return rt;}
const MODE_LABELS={auto:'Авто',fast:'Быстро',medium:'Средняя',slow:'Медленно',low:'Низкая',high:'Высокая',turbo:'Турбо',max:'Максимум',min:'Минимум',quiet:'Тихо',eco:'Эко',normal:'Обычная',express:'Экспресс',cool:'Охлаждение',heat:'Нагрев',fan_only:'Вентиляция',dry:'Осушение',wet_cleaning:'Влажная',dry_cleaning:'Сухая',mixed_cleaning:'Смешанная'};
function renderVacuum(context,status=''){const s=getSettings(context),rt=modeRuntimeFor(context);if(rt.value){setImage(context,selectedModeImageDataUri(s.deviceName||'Пылесос',rt.value,status||'СКОРОСТЬ','#62A8FF'));return;}setImage(context,genericKnobImageDataUri(s.deviceName||'Пылесос','—',0,status||'СКОРОСТЬ','#62A8FF'));}
async function refreshVacuum(context){const s=getSettings(context),token=tokenForContext(context),rt=modeRuntimeFor(context);if(!token||!s.deviceId){renderVacuum(context,'НАСТРОЙТЕ');return;}try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false){renderVacuum(context,offlineStatusText(s.targetType,s.deviceId));return;}const m=snap.modes.find(x=>x.instance==='work_speed');if(!m||!m.modes.length)throw new Error('Скорость работы не поддерживается.');rt.deviceId=s.deviceId;rt.modes=m.modes;rt.value=m.value&&m.modes.includes(m.value)?m.value:m.modes[0];rt.index=Math.max(0,m.modes.indexOf(rt.value));rt.power=snap.power;renderVacuum(context);}catch(e){errorLine('VACUUM_REFRESH_ERROR',e?.message||String(e));renderVacuum(context,'НЕТ СВЯЗИ');}}
function applyVacuumTicks(context,ticks){ticks=Number(ticks)||0;if(!ticks)return;const s=getSettings(context),rt=modeRuntimeFor(context),token=tokenForContext(context);if(!token||!s.deviceId){showAlert(context);renderVacuum(context,'НАСТРОЙТЕ');return;}if(rt.deviceId!==s.deviceId||!rt.modes.length){refreshVacuum(context);return;}rt.index=Math.max(0,Math.min(rt.modes.length-1,rt.index+(ticks>0?1:-1)));rt.value=rt.modes[rt.index];renderVacuum(context);if(rt.timer)clearTimeout(rt.timer);rt.timer=setTimeout(async()=>{try{await setTargetMode(token,s.targetType,s.deviceId,'work_speed',rt.value);renderVacuum(context);}catch(e){errorLine('VACUUM_SET_ERROR',e?.message||String(e));showAlert(context);renderVacuum(context,'ОШИБКА');}},160);}

function climateModeForSnapshot(snap,settings){return snap.modes.find(x=>x.instance===settings.climateModeInstance)||snap.modes.find(x=>['fan_speed','work_speed'].includes(x.instance))||snap.modes[0]||null;}
function renderClimate(context,status=''){const s=getSettings(context),rt=modeRuntimeFor(context);if(rt.value&&['fan_speed','work_speed'].includes(rt.modeInstance)){setImage(context,selectedModeImageDataUri(s.deviceName||'Климат',rt.value,status||'СКОРОСТЬ','#7C5CFF'));return;}const v=rt.value?MODE_LABELS[rt.value]||rt.value:'—';const progress=rt.modes.length>1?rt.index/(rt.modes.length-1):0;setImage(context,genericKnobImageDataUri(s.deviceName||'Климат',v,progress,status||'РЕЖИМ','#6BD3B3'));}
async function refreshClimate(context){const s=getSettings(context),token=tokenForContext(context),rt=modeRuntimeFor(context);if(!token||!s.deviceId){renderClimate(context,'НАСТРОЙТЕ');return;}try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false){renderClimate(context,offlineStatusText(s.targetType,s.deviceId));return;}const m=climateModeForSnapshot(snap,s);if(!m||!m.modes.length)throw new Error('Режимы устройства не найдены.');if(m.instance!==s.climateModeInstance)saveSettings(context,{climateModeInstance:m.instance});rt.deviceId=s.deviceId;rt.modeInstance=m.instance;rt.modes=m.modes;rt.value=m.value&&m.modes.includes(m.value)?m.value:m.modes[0];rt.index=Math.max(0,m.modes.indexOf(rt.value));rt.power=snap.power;renderClimate(context);}catch(e){errorLine('CLIMATE_REFRESH_ERROR',e?.message||String(e));renderClimate(context,'НЕТ СВЯЗИ');}}
function applyClimateTicks(context,ticks){ticks=Number(ticks)||0;if(!ticks)return;const s=getSettings(context),rt=modeRuntimeFor(context),token=tokenForContext(context);if(!token||!s.deviceId){showAlert(context);renderClimate(context,'НАСТРОЙТЕ');return;}if(rt.deviceId!==s.deviceId||!rt.modes.length){refreshClimate(context);return;}rt.index=Math.max(0,Math.min(rt.modes.length-1,rt.index+(ticks>0?1:-1)));rt.value=rt.modes[rt.index];renderClimate(context);if(rt.timer)clearTimeout(rt.timer);rt.timer=setTimeout(async()=>{try{await setTargetMode(token,s.targetType,s.deviceId,rt.modeInstance||s.climateModeInstance,rt.value);renderClimate(context);}catch(e){errorLine('CLIMATE_SET_ERROR',e?.message||String(e));showAlert(context);renderClimate(context,'ОШИБКА');}},160);}

async function toggleKnobPower(context, action, refreshFn){const s=getSettings(context),token=tokenForContext(context);if(!token||!s.deviceId){showAlert(context);return;}try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false)throw new Error('Устройство не в сети.');if(!snap.hasOnOff||snap.power===null)throw new Error('Устройство не сообщает состояние Вкл/Выкл.');await setTargetPower(token,s.targetType,s.deviceId,!snap.power);await refreshFn(context);}catch(e){errorLine('KNOB_POWER_ERROR',action,e?.message||String(e));showAlert(context);}}

async function toggleMediaVolumePress(context){const s=getSettings(context),token=tokenForContext(context);if(!token||!s.deviceId)return;try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false)return;const mute=(snap.toggles||[]).find(t=>t.instance==='mute');if(mute&&mute.retrievable&&typeof mute.value==='boolean'){await setTargetToggle(token,s.targetType,s.deviceId,'mute',!mute.value);await refreshRangeKnob(context,ACTION_MEDIA_VOLUME);return;}if(snap.hasOnOff&&snap.onOffRetrievable&&snap.power!==null){await setTargetPower(token,s.targetType,s.deviceId,!snap.power);await refreshRangeKnob(context,ACTION_MEDIA_VOLUME);return;}const cfg=rangeActionConfig(ACTION_MEDIA_VOLUME);setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,'НАЖАТИЕ НЕ НАЗНАЧЕНО',0,cfg.accent));setTimeout(()=>refreshRangeKnob(context,ACTION_MEDIA_VOLUME),700);}catch(e){errorLine('MEDIA_VOLUME_PRESS_ERROR',e?.message||String(e));}}
async function mediaChannelPress(context){const s=getSettings(context);const cfg=rangeActionConfig(ACTION_MEDIA_CHANNEL);setImage(context,relativeMediaImageDataUri(s.deviceName||'ТВ / ИК',cfg.label,'НАЖАТИЕ НЕ НАЗНАЧЕНО',0,cfg.accent));setTimeout(()=>refreshRangeKnob(context,ACTION_MEDIA_CHANNEL),700);}



function colorDialRuntimeFor(context){let rt=colorDialRuntime.get(context);if(!rt){rt={index:0,power:true,deviceId:'',timer:null,sending:false,dirty:false};colorDialRuntime.set(context,rt);}return rt;}
function renderColorDial(context,status='ЦВЕТ'){const s=getSettings(context),rt=colorDialRuntimeFor(context),item=COLOR_DIAL_PALETTE[((rt.index%COLOR_DIAL_PALETTE.length)+COLOR_DIAL_PALETTE.length)%COLOR_DIAL_PALETTE.length];setImage(context,colorDialImageDataUri(s.deviceName||'Свет',item,rt.power,status));setTitle(context,'');}
async function refreshColorDial(context){const s=getSettings(context),token=tokenForContext(context),rt=colorDialRuntimeFor(context);if(!token||!s.deviceId){setImage(context,colorDialImageDataUri('Настройте',COLOR_DIAL_PALETTE[0],false,'НЕТ УСТРОЙСТВА'));setTitle(context,'');return;}try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false){rt.power=false;setImage(context,colorDialImageDataUri(s.deviceName||'Свет',COLOR_DIAL_PALETTE[rt.index]||COLOR_DIAL_PALETTE[0],false,offlineStatusText(s.targetType,s.deviceId)));return;}if(!snap.color||( !snap.color.supportsRgb && !snap.color.supportsHsv))throw new Error('Цвет не поддерживается.');rt.deviceId=s.deviceId;rt.power=snap.power;const current=colorStateRgb(snap.color);rt.index=Number.isFinite(current)?nearestPaletteIndex(current):Math.max(0,Math.min(COLOR_DIAL_PALETTE.length-1,Number(s.colorDialIndex)||0));renderColorDial(context);}catch(e){errorLine('COLORDIAL_REFRESH_ERROR',e?.message||String(e));renderColorDial(context,'НЕТ СВЯЗИ');}}
function applyColorDialTicks(context,ticks){ticks=Number(ticks)||0;if(!ticks)return;const rt=colorDialRuntimeFor(context);rt.index=(rt.index+(ticks>0?Math.max(1,Math.abs(Math.trunc(ticks))):-Math.max(1,Math.abs(Math.trunc(ticks))))+COLOR_DIAL_PALETTE.length)%COLOR_DIAL_PALETTE.length;rt.power=true;renderColorDial(context,'ЦВЕТ');if(rt.timer)clearTimeout(rt.timer);rt.timer=setTimeout(()=>commitColorDial(context),85);}
async function commitColorDial(context){const s=getSettings(context),token=tokenForContext(context),rt=colorDialRuntimeFor(context);if(!token||!s.deviceId)return;if(rt.sending){rt.dirty=true;return;}rt.sending=true;rt.dirty=false;const item=COLOR_DIAL_PALETTE[rt.index]||COLOR_DIAL_PALETTE[0];try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false)throw new Error('Устройство не в сети.');if(snap.hasOnOff&&snap.power===false)await setTargetPower(token,s.targetType,s.deviceId,true);if(snap.color?.supportsRgb)await setTargetColor(token,s.targetType,s.deviceId,'rgb',item.rgb);else if(snap.color?.supportsHsv)await setTargetColor(token,s.targetType,s.deviceId,'hsv',rgbIntToHsv(item.rgb));else throw new Error('Устройство не поддерживает RGB/HSV.');rt.power=true;saveSettings(context,{colorDialIndex:rt.index});renderColorDial(context);}catch(e){errorLine('COLORDIAL_SET_ERROR',e?.message||String(e));showAlert(context);renderColorDial(context,'ОШИБКА');}finally{rt.sending=false;if(rt.dirty){rt.timer=setTimeout(()=>commitColorDial(context),80);}}}

async function executeLightColor(context){
  const s=getSettings(context),token=tokenForContext(context);if(!token||!s.deviceId){showAlert(context);return;}
  try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false)throw new Error('Устройство не в сети.');const color=snap.color;if(!color)throw new Error('Устройство не поддерживает цвет.');const preset=s.colorPreset||'white';const rgb=COLOR_PRESETS[preset]??COLOR_PRESETS.white;if(snap.hasOnOff&&snap.power===false)await setTargetPower(token,s.targetType,s.deviceId,true);
    if((color.supportsRgb||color.supportsHsv)){if(color.supportsRgb)await setTargetColor(token,s.targetType,s.deviceId,'rgb',rgb);else await setTargetColor(token,s.targetType,s.deviceId,'hsv',rgbIntToHsv(rgb));}
    else if(color.supportsTemperature){const whiteK=Math.max(color.temperatureMin,Math.min(color.temperatureMax,4500));await setTargetColor(token,s.targetType,s.deviceId,'temperature_k',whiteK);}else throw new Error('Нет доступной модели цвета.');
    setTitle(context,preset==='white'?'Белый':preset==='red'?'Красный':preset==='green'?'Зелёный':preset==='blue'?'Синий':preset);
  }catch(e){errorLine('COLOR_ERROR',e?.message||String(e));showAlert(context);sendToPropertyInspector(context,{type:'error',message:e?.message||'Ошибка цвета.'},ACTION_LIGHT_COLOR);}
}

async function executeLightPreset(context){const s=getSettings(context),token=tokenForContext(context);if(!token||!s.deviceId){showAlert(context);return;}try{const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);if(snap.online===false)throw new Error('Устройство не в сети.');if(s.presetPower&&snap.hasOnOff&&snap.power!==true)await setTargetPower(token,s.targetType,s.deviceId,true);if(s.presetUseBrightness&&snap.brightness){const v=Math.max(Number(snap.brightness.min)||1,Math.min(Number(snap.brightness.max)||100,Number(s.presetBrightness)||50));await setTargetRange(token,s.targetType,s.deviceId,'brightness',v,false);}const preset=String(s.presetColor||'none');if(preset!=='none'&&snap.color&&(snap.color.supportsRgb||snap.color.supportsHsv)){const rgb=COLOR_PRESETS[preset]??COLOR_PRESETS.white;if(snap.color.supportsRgb)await setTargetColor(token,s.targetType,s.deviceId,'rgb',rgb);else await setTargetColor(token,s.targetType,s.deviceId,'hsv',rgbIntToHsv(rgb));}else if(s.presetUseTemperature&&snap.color?.supportsTemperature){const k=Math.max(snap.color.temperatureMin,Math.min(snap.color.temperatureMax,Number(s.presetTemperature)||3000));await setTargetColor(token,s.targetType,s.deviceId,'temperature_k',k);}setTitle(context,(s.presetName||'Пресет').slice(0,14));}catch(e){errorLine('PRESET_ERROR',e?.message||String(e));showAlert(context);sendToPropertyInspector(context,{type:'error',message:e?.message||'Ошибка пресета света.'},ACTION_LIGHT_PRESET);}}

const COMMAND_RANGE_LABELS = {
  volume:'Громкость', channel:'Канал', temperature:'Температура', brightness:'Яркость',
  open:'Открытие', humidity:'Влажность', heat:'Нагрев', water_level:'Уровень'
};
const COMMAND_TOGGLE_LABELS = {
  mute:'Звук', pause:'Пауза', oscillation:'Поворот', ionization:'Ионизация',
  backlight:'Подсветка', controls_locked:'Блокировка', keep_warm:'Поддержание температуры'
};
const COMMAND_MODE_LABELS = {
  input_source:'Источник', fan_speed:'Скорость вентилятора', thermostat:'Режим',
  work_speed:'Скорость', cleanup_mode:'Уборка', heat:'Нагрев', tea_mode:'Режим чая'
};
const COMMAND_VALUE_LABELS = {
  auto:'Авто', cool:'Охлаждение', heat:'Нагрев', fan_only:'Вентиляция', dry:'Осушение',
  low:'Низкая', medium:'Средняя', high:'Высокая', turbo:'Турбо', quiet:'Тихо', eco:'Эко',
  one:'Вход 1', two:'Вход 2', three:'Вход 3', four:'Вход 4', five:'Вход 5'
};
function mediaCommandsForDevice(d) {
  const out=[];
  if(d?.hasOnOff){
    if(d.onOffRetrievable) out.push({id:'power_toggle',label:'Переключить питание'});
    out.push({id:'power_on',label:'Включить'});
    out.push({id:'power_off',label:'Выключить'});
  }
  for(const r of d?.ranges||[]){
    const label=COMMAND_RANGE_LABELS[r.instance]||r.instance;
    const step=r.instance==='volume'?5:(r.instance==='channel'?1:Math.max(1,Number(r.precision)||1));
    out.push({id:`range_delta:${r.instance}:${step}`,label:`${label} +`});
    out.push({id:`range_delta:${r.instance}:${-step}`,label:`${label} −`});
  }
  for(const t of d?.toggles||[]){
    const label=COMMAND_TOGGLE_LABELS[t.instance]||t.instance;
    out.push({id:`toggle:${t.instance}:on`,label:`${label}: Вкл`});
    out.push({id:`toggle:${t.instance}:off`,label:`${label}: Выкл`});
  }
  for(const m of d?.modes||[]){
    const label=COMMAND_MODE_LABELS[m.instance]||m.instance;
    for(const value of m.modes||[]) out.push({id:`mode:${m.instance}:${value}`,label:`${label}: ${COMMAND_VALUE_LABELS[value]||value}`});
  }
  return out;
}

async function executeMediaCommand(context) {
  const s=getSettings(context), token=tokenForContext(context);
  if(!token||!s.deviceId){showAlert(context);return;}
  try{
    const snap=await readTargetSnapshot(token,s.targetType,s.deviceId);
    if(snap.online===false) throw new Error('Устройство не в сети.');
    const cmd=s.mediaCommand||'power_toggle';
    if(cmd==='power_on') await setTargetPower(token,s.targetType,s.deviceId,true);
    else if(cmd==='power_off') await setTargetPower(token,s.targetType,s.deviceId,false);
    else if(cmd==='power_toggle'){
      if(snap.power===null) throw new Error('ИК-устройство не знает состояние. Выберите «Включить» или «Выключить».');
      await setTargetPower(token,s.targetType,s.deviceId,!snap.power);
    }
    // legacy command IDs from v1.5
    else if(cmd==='volume_up') await setTargetRange(token,s.targetType,s.deviceId,'volume',5,true);
    else if(cmd==='volume_down') await setTargetRange(token,s.targetType,s.deviceId,'volume',-5,true);
    else if(cmd==='channel_up') await setTargetRange(token,s.targetType,s.deviceId,'channel',1,true);
    else if(cmd==='channel_down') await setTargetRange(token,s.targetType,s.deviceId,'channel',-1,true);
    else if(cmd==='mute_on') await setTargetToggle(token,s.targetType,s.deviceId,'mute',true);
    else if(cmd==='mute_off') await setTargetToggle(token,s.targetType,s.deviceId,'mute',false);
    else if(cmd==='pause_on') await setTargetToggle(token,s.targetType,s.deviceId,'pause',true);
    else if(cmd==='pause_off') await setTargetToggle(token,s.targetType,s.deviceId,'pause',false);
    else if(cmd.startsWith('input_source:')) await setTargetMode(token,s.targetType,s.deviceId,'input_source',cmd.split(':').slice(1).join(':'));
    else if(cmd.startsWith('range_delta:')){
      const parts=cmd.split(':'); const instance=parts[1]; const delta=Number(parts.slice(2).join(':'));
      if(!instance||!Number.isFinite(delta)) throw new Error('Некорректная команда диапазона.');
      await setTargetRange(token,s.targetType,s.deviceId,instance,delta,true);
    }
    else if(cmd.startsWith('toggle:')){
      const parts=cmd.split(':'); const instance=parts[1]; const value=parts[2]==='on';
      if(!instance) throw new Error('Некорректная toggle-команда.');
      await setTargetToggle(token,s.targetType,s.deviceId,instance,value);
    }
    else if(cmd.startsWith('mode:')){
      const parts=cmd.split(':'); const instance=parts[1]; const value=parts.slice(2).join(':');
      if(!instance||!value) throw new Error('Некорректная mode-команда.');
      await setTargetMode(token,s.targetType,s.deviceId,instance,value);
    }
    else throw new Error('Команда не поддерживается.');
    setTitle(context,'Готово');
    setTimeout(()=>setTitle(context,s.deviceName?.slice(0,14)||'ИК'),500);
  }catch(e){
    errorLine('MEDIA_ERROR',e?.message||String(e));showAlert(context);
    sendToPropertyInspector(context,{type:'error',message:e?.message||'Ошибка ИК-команды.'},ACTION_MEDIA);
  }
}

async function executeScenario(context){const s=getSettings(context),token=tokenForContext(context);if(!token||!s.scenarioId){showAlert(context);return;}try{await runScenario(token,s.scenarioId);recordUsageFromContext(context,ACTION_SCENARIO,'streamdock');setTitle(context,'Запущен');setTimeout(()=>setTitle(context,(s.scenarioName||'Сценарий').slice(0,14)),700);}catch(e){errorLine('SCENARIO_ERROR',e?.message||String(e));showAlert(context);sendToPropertyInspector(context,{type:'error',message:e?.message||'Ошибка запуска сценария.'},ACTION_SCENARIO);}}

async function dashboardCommand(context, action, payload){
  await performDashboardCommand(payload,payload.token||'');
  sendToPropertyInspector(context,{type:'dashboardCommandResult',ok:true,message:'Команда выполнена.'},action);
  setTimeout(()=>loadDashboardDevices(context,action,'',true),180);
}

async function executePower(context, action = ACTION_TOGGLE) {
  const s = getSettings(context);
  const token = tokenForContext(context);
  const icons = powerIconsForAction(action);
  if (!token || !s.deviceId) {
    showAlert(context);
    sendToPropertyInspector(context, { type: 'error', message: 'Сначала подключите Яндекс и выберите устройство.' }, action);
    return;
  }
  if (togglingContexts.has(context)) return;

  togglingContexts.add(context);
  if ([ACTION_TOGGLE, ACTION_LIGHT_POWER].includes(action)) setTitle(context, '…');
  else renderBrightness(context, 'ПЕРЕКЛЮЧЕНИЕ');
  try {
    if (action === ACTION_BRIGHTNESS) {
      const rt = runtimeFor(context);
      const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
      if (snapshot.online === false) throw new Error('Устройство не в сети.');
      let current = typeof rt.power === 'boolean' ? rt.power : snapshot.power;
      if (current === null) throw new Error('У устройства нет доступного состояния Вкл/Выкл.');
      const next = !current;
      await setTargetPower(token, s.targetType, s.deviceId, next);
      rt.power = next;
      renderBrightness(context);
    } else {
      const snapshot = await readTargetSnapshot(token, s.targetType, s.deviceId);
      if (snapshot.online === false) throw new Error('Устройство не в сети.');
      if (!snapshot.hasOnOff) throw new Error('У устройства нет управления Вкл/Выкл.');
      let next;
      if (s.powerMode === 'on') next = true;
      else if (s.powerMode === 'off') next = false;
      else if (snapshot.power === null) {
        if (s.targetType === 'group') next = true; // смешанная группа: первая команда «переключить» включает всю группу
        else throw new Error('Устройство не сообщает текущее состояние. В настройках выберите команду «Включить» или «Выключить».');
      } else next = !snapshot.power;
      await setTargetPower(token, s.targetType, s.deviceId, next);
      setImage(context, next ? icons.on : icons.off);
      setState(context, next ? 1 : 0);
      setTitle(context, next ? 'ВКЛ' : 'ВЫКЛ');
    }
  } catch (e) {
    errorLine('POWER_ERROR', e?.message || String(e));
    if ([ACTION_TOGGLE, ACTION_LIGHT_POWER].includes(action)) setTitle(context, 'Ошибка');
    else renderBrightness(context, 'ОШИБКА');
    showAlert(context);
    sendToPropertyInspector(context, { type: 'error', message: e?.message || 'Ошибка управления.' }, action);
  } finally {
    togglingContexts.delete(context);
  }
}

async function refreshSimpleAction(context, action) {
  const s=getSettings(context);
  if(action===ACTION_LIGHT_PRESET){setTitle(context,(s.presetName||'Пресет').slice(0,14));return;}
  if(action===ACTION_LIGHT_COLOR){const labels={white:'Белый',red:'Красный',green:'Зелёный',blue:'Синий',yellow:'Жёлтый',orange:'Оранжевый',purple:'Фиолетовый',pink:'Розовый',cyan:'Бирюзовый'};setTitle(context,labels[s.colorPreset]||'Цвет');return;}
  if(action===ACTION_MEDIA_VOLUME){setTitle(context,'');return;}
  if(action===ACTION_MEDIA_CHANNEL){setTitle(context,'');return;}
  if(action===ACTION_DASHBOARD){setTitle(context,'Панель');return;}
  if(action===ACTION_MEDIA){setTitle(context,(s.deviceName||'Медиа').slice(0,14));return;}
  if(action===ACTION_SCENARIO){setTitle(context,(s.scenarioName||'Сценарий').slice(0,14));setImage(context,scenarioIconDataUri(s.scenarioName||'Сценарий'));return;}
}

async function refreshAction(context, action) {
  if (action === ACTION_BRIGHTNESS) return refreshBrightness(context);
  if (action === ACTION_SENSOR) return refreshSensor(context);
  if (action === ACTION_SENSOR_MULTI) return sensorMultiDialContexts.has(context)?refreshSensorMultiDial(context):refreshCombinedSensor(context);
  if (action === ACTION_CURTAIN) return refreshCurtain(context);
  if (action === ACTION_VACUUM_SPEED) return refreshVacuum(context);
  if (action === ACTION_CLIMATE_MODE) return refreshClimate(context);
  if ([ACTION_KETTLE_TEMP, ACTION_MEDIA_VOLUME, ACTION_MEDIA_CHANNEL].includes(action)) return refreshRangeKnob(context, action);
  if (action === ACTION_LIGHT_TEMP) return refreshColorTemp(context);
  if (action === ACTION_LIGHT_COLOR_DIAL) return refreshColorDial(context);
  if (action === ACTION_DASHBOARD && informationContexts.has(context)) return refreshHomeSummary(context);
  if (action === ACTION_SCENARIO && scenarioDialContexts.has(context)) return refreshScenarioDial(context);
  if ([ACTION_LIGHT_COLOR, ACTION_LIGHT_PRESET, ACTION_DASHBOARD, ACTION_MEDIA, ACTION_SCENARIO].includes(action)) return refreshSimpleAction(context, action);
  if ([ACTION_TOGGLE, ACTION_LIGHT_POWER].includes(action)) return refreshToggle(context, action);
}

function cleanupContext(context) {
  visibleContexts.delete(context);
  delete settingsByContext[context];
  delete actionByContext[context];
  const rt = brightnessRuntime.get(context);
  if (rt?.timer) clearTimeout(rt.timer);
  brightnessRuntime.delete(context);
  const crt = curtainRuntime.get(context);
  if (crt?.timer) clearTimeout(crt.timer);
  curtainRuntime.delete(context);
  const rr = rangeRuntime.get(context); if (rr?.timer) clearTimeout(rr.timer); rangeRuntime.delete(context);
  const ct = colorTempRuntime.get(context); if (ct?.timer) clearTimeout(ct.timer); colorTempRuntime.delete(context);
  const cd = colorDialRuntime.get(context); if (cd?.timer) clearTimeout(cd.timer); colorDialRuntime.delete(context);
  const mr = modeRuntime.get(context); if (mr?.timer) clearTimeout(mr.timer); modeRuntime.delete(context);
  combinedRuntime.delete(context);
  sensorMultiDialRuntime.delete(context);
  sensorMultiDialContexts.delete(context);
  informationContexts.delete(context);
  scenarioDialContexts.delete(context);
  scenarioDialRuntime.delete(context);
}


const ACTION_USAGE_LABELS = {
  [ACTION_TOGGLE]:'Устройство · Вкл/Выкл', [ACTION_LIGHT_POWER]:'Свет · Вкл/Выкл',
  [ACTION_BRIGHTNESS]:'Свет · Яркость', [ACTION_SENSOR]:'Датчик · Показание',
  [ACTION_SENSOR_MULTI]:'Датчик · Показатели', [ACTION_CURTAIN]:'Шторы · Положение',
  [ACTION_VACUUM_SPEED]:'Пылесос · Скорость', [ACTION_CLIMATE_MODE]:'Очиститель / Вентилятор',
  [ACTION_KETTLE_TEMP]:'Чайник · Температура', [ACTION_LIGHT_TEMP]:'Свет · Температура',
  [ACTION_LIGHT_COLOR_DIAL]:'Свет · Цвета', [ACTION_LIGHT_COLOR]:'Свет · Цвет',
  [ACTION_LIGHT_PRESET]:'Свет · Пресет', [ACTION_MEDIA_VOLUME]:'Медиа · Громкость',
  [ACTION_MEDIA_CHANNEL]:'Медиа · Канал', [ACTION_MEDIA]:'Медиа · Команда',
  [ACTION_DASHBOARD]:'Панель умного дома', [ACTION_SCENARIO]:'Сценарий'
};
function usageDayKey(ts=Date.now()){const d=new Date(ts);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function loadUsageStats(){
  try{
    fs.mkdirSync(SENSOR_HISTORY_DIR,{recursive:true});
    if(fs.existsSync(USAGE_STATS_FILE)){
      const stat=fs.statSync(USAGE_STATS_FILE),mtime=Number(stat.mtimeMs||0);
      if(!usageStatsStore||mtime>usageStatsMtime+0.5){
        const parsed=JSON.parse(fs.readFileSync(USAGE_STATS_FILE,'utf8'));
        if(parsed&&typeof parsed==='object'&&parsed.entries&&typeof parsed.entries==='object')usageStatsStore=parsed;
        usageStatsMtime=mtime;
      }
    }
  }catch(e){errorLine('USAGE_STATS_READ_ERROR',e?.message||String(e));}
  if(!usageStatsStore)usageStatsStore={version:1,entries:{}};
  return usageStatsStore;
}
function saveUsageStatsSoon(){
  if(usageStatsSaveTimer)return;
  usageStatsSaveTimer=setTimeout(()=>{usageStatsSaveTimer=null;try{fs.mkdirSync(SENSOR_HISTORY_DIR,{recursive:true});const tmp=USAGE_STATS_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(loadUsageStats(),null,2));fs.renameSync(tmp,USAGE_STATS_FILE);try{usageStatsMtime=Number(fs.statSync(USAGE_STATS_FILE).mtimeMs||Date.now());}catch(_){}}catch(e){errorLine('USAGE_STATS_WRITE_ERROR',e?.message||String(e));}},180);
  usageStatsSaveTimer.unref?.();
}
function pruneUsageDaily(daily){
  const cutoff=Date.now()-95*24*60*60*1000;
  for(const key of Object.keys(daily||{})){const t=Date.parse(key+'T00:00:00');if(Number.isFinite(t)&&t<cutoff)delete daily[key];}
}
function usageEntryKey(context,action){
  const s=getSettings(context);
  if(action===ACTION_SCENARIO)return `scenario:${s.scenarioId||s.scenarioName||context}`;
  if(s.deviceId)return `action:${action}:${s.targetType||'device'}:${s.deviceId}`;
  return `action:${action}:${context}`;
}
function usageStatsEnabled(){ return globalSettings.usageStatsEnabled !== false; }
function recordUsageFromContext(context,action,source='streamdock',throttleMs=0){
  if(!usageStatsEnabled()||!action)return;
  const s=getSettings(context),isScenario=action===ACTION_SCENARIO;
  if(isScenario&&!s.scenarioId)return;
  if(!isScenario&&action!==ACTION_DASHBOARD&&!s.deviceId)return;
  const key=usageEntryKey(context,action);
  const now=Date.now();
  if(throttleMs>0){const prev=Number(usageStatsThrottle.get(key)||0);if(now-prev<throttleMs)return;usageStatsThrottle.set(key,now);}
  const store=loadUsageStats();
  const entry=store.entries[key]||{key,kind:isScenario?'scenario':'action',action,actionLabel:ACTION_USAGE_LABELS[action]||action,count:0,firstUsedAt:now,lastUsedAt:0,daily:{}};
  entry.kind=isScenario?'scenario':'action'; entry.action=action; entry.actionLabel=ACTION_USAGE_LABELS[action]||action; entry.source=source;
  if(isScenario){entry.scenarioId=String(s.scenarioId||'');entry.name=String(s.scenarioName||'Сценарий');}
  else{entry.deviceId=String(s.deviceId||'');entry.targetType=s.targetType==='group'?'group':'device';entry.name=String(s.deviceName||entry.actionLabel);}
  entry.count=Number(entry.count||0)+1;entry.lastUsedAt=now;entry.daily=entry.daily&&typeof entry.daily==='object'?entry.daily:{};const day=usageDayKey(now);entry.daily[day]=Number(entry.daily[day]||0)+1;pruneUsageDaily(entry.daily);store.entries[key]=entry;saveUsageStatsSoon();
}
function recordScenarioUsageById(scenarioId,source='panel'){
  if(!usageStatsEnabled())return;
  const id=String(scenarioId||'');if(!id)return;const now=Date.now(),store=loadUsageStats(),key=`scenario:${id}`;
  const sc=dashboardDataCache.data?.scenarios?.find(x=>String(x.id)===id);
  const entry=store.entries[key]||{key,kind:'scenario',action:ACTION_SCENARIO,actionLabel:'Сценарий',scenarioId:id,name:sc?.name||'Сценарий',count:0,firstUsedAt:now,lastUsedAt:0,daily:{}};
  entry.scenarioId=id;entry.name=sc?.name||entry.name||'Сценарий';entry.source=source;entry.count=Number(entry.count||0)+1;entry.lastUsedAt=now;entry.daily=entry.daily&&typeof entry.daily==='object'?entry.daily:{};const day=usageDayKey(now);entry.daily[day]=Number(entry.daily[day]||0)+1;pruneUsageDaily(entry.daily);store.entries[key]=entry;saveUsageStatsSoon();
}
function usageStatsSnapshot(days=7){
  const store=loadUsageStats(), countDays=Math.max(1,Math.min(60,Number(days)||7)), wanted=[];
  for(let i=0;i<countDays;i++)wanted.push(usageDayKey(Date.now()-i*24*60*60*1000));
  const todayKey=usageDayKey(), rows=[];let total=0,today=0,period=0;
  for(const raw of Object.values(store.entries||{})){const daily=raw.daily&&typeof raw.daily==='object'?raw.daily:{};const periodCount=wanted.reduce((sum,k)=>sum+Number(daily[k]||0),0),todayCount=Number(daily[todayKey]||0),allCount=Number(raw.count||0);total+=allCount;today+=todayCount;period+=periodCount;rows.push({...raw,allCount,todayCount,periodCount});}
  rows.sort((a,b)=>b.periodCount-a.periodCount||b.allCount-a.allCount||Number(b.lastUsedAt||0)-Number(a.lastUsedAt||0));
  return{enabled:usageStatsEnabled(),days:countDays,summary:{total,today,period,unique:rows.length,scenarios:rows.filter(x=>x.kind==='scenario').reduce((n,x)=>n+x.allCount,0)},rows};
}
function clearUsageStats(){usageStatsStore={version:1,entries:{}};try{fs.mkdirSync(SENSOR_HISTORY_DIR,{recursive:true});fs.writeFileSync(USAGE_STATS_FILE,JSON.stringify(usageStatsStore,null,2));usageStatsMtime=Number(fs.statSync(USAGE_STATS_FILE).mtimeMs||Date.now());}catch(e){errorLine('USAGE_STATS_CLEAR_ERROR',e?.message||String(e));}return usageStatsSnapshot(7);}


let dashboardHttpServer = null;
let dashboardHttpPort = 0;
const DASHBOARD_VERSION = '1.0.0';

function dashboardMime(filePath){
  const ext=path.extname(filePath).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'})[ext]||'application/octet-stream';
}
function jsonResponse(res,status,obj){const body=Buffer.from(JSON.stringify(obj));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});res.end(body);}
function readJsonBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>1024*1024){reject(new Error('Слишком большой запрос'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch(e){reject(e);}});req.on('error',reject);});}
function tokenExpirySnapshot(token=''){
  const saved=String(globalSettings.token||'').trim(),candidate=String(token||saved).trim();
  const same=!candidate||candidate===saved;
  return same?{expiresAt:Math.max(0,Number(globalSettings.tokenExpiresAt)||0),lifetimeSeconds:Math.max(0,Number(globalSettings.tokenLifetimeSeconds)||0),capturedAt:Math.max(0,Number(globalSettings.tokenExpiryCapturedAt)||0)}:{expiresAt:0,lifetimeSeconds:0,capturedAt:0};
}
function tokenExpiryLabel(){
  const meta=tokenExpirySnapshot(),expiresAt=Number(meta.expiresAt)||0;if(!expiresAt)return 'Срок неизвестен';
  const diff=expiresAt-Date.now();if(diff<=0)return 'Срок истёк';
  const days=Math.floor(diff/86400000);return days>0?`ещё ${days} дн.`:`ещё ${Math.max(1,Math.floor(diff/3600000))} ч.`;
}
function dashboardDataFromUserInfo(data, token='', startedAt=Date.now()){
  const baseDevices=normalizeDevices(data), baseGroups=normalizeGroups(data,baseDevices);
  // /user/info уже содержит capabilities/properties/state. Раньше после него панель
  // дополнительно делала GET для КАЖДОГО устройства и группы, что превращало
  // один быстрый запрос в N+1 запросов и добавляло несколько секунд ожидания.
  for(const d of baseDevices){const key=targetStatusKey('device',d.id);if(d.online===false||(!targetPresence.has(key)&&typeof d.online==='boolean'))noteTargetPresence('device',d.id,d.online);}
  for(const g of baseGroups){const key=targetStatusKey('group',g.id);if(g.online===false||(!targetPresence.has(key)&&typeof g.online==='boolean'))noteTargetPresence('group',g.id,g.online);}
  captureSensorHistoryEntities(baseDevices);
  const devices=decorateDevicesForDashboard(baseDevices).map(decoratePresence);
  const groups=decorateDevicesForDashboard(baseGroups).map(decoratePresence);
  const elapsed=Math.max(0,Date.now()-startedAt);
  const out={devices,groups,scenarios:scenariosFromInfo(data),rooms:Array.isArray(data?.rooms)?data.rooms.map(r=>({id:r.id,name:r.name})):[],message:`Получено устройств: ${devices.length}, групп: ${groups.length} · ${elapsed} мс`,loadMs:elapsed};
  if(token) dashboardDataCache={token,at:Date.now(),data:out};
  return out;
}
async function buildDashboardData(token,force=false){
  const startedAt=Date.now();
  const data=await getUserInfo(token,force);
  const out=dashboardDataFromUserInfo(data,token,startedAt);
  debugLine('DASHBOARD_FAST_LOAD',`ms=${out.loadMs}`,`devices=${out.devices.length}`,`groups=${out.groups.length}`,`force=${force?1:0}`);
  return out;
}
async function performDashboardCommand(payload, explicitToken=''){
  const token=String(explicitToken||globalSettings.token||'').trim();
  if(!token)throw new Error('OAuth-токен не сохранён.');
  const id=String(payload.deviceId||''),kind=String(payload.kind||''),targetType=payload.targetType==='group'?'group':'device';
  debugLine('DASHBOARD_COMMAND',`kind=${kind}`,`target=${targetType}`,`id=${id||'-'}`);
  if(kind!=='scenario'&&!id)throw new Error('Устройство или группа не выбраны.');
  if(kind==='power')await setTargetPower(token,targetType,id,Boolean(payload.value));
  else if(kind==='range'){const inst=String(payload.instance),rel=Boolean(payload.relative),v=Number(payload.value);await setTargetRange(token,targetType,id,inst,v,rel);}
  else if(kind==='mode')await setTargetMode(token,targetType,id,String(payload.instance),String(payload.value));
  else if(kind==='toggle')await setTargetToggle(token,targetType,id,String(payload.instance),Boolean(payload.value));
  else if(kind==='color')await setTargetColor(token,targetType,id,String(payload.instance),payload.value);
  else if(kind==='lightSetup'){const snap=await readTargetSnapshot(token,targetType,id);if(snap.online===false)throw new Error('Устройство не в сети.');if(snap.hasOnOff&&snap.power!==true)await setTargetPower(token,targetType,id,true);if(snap.brightness&&Number.isFinite(Number(payload.brightness)))await setTargetRange(token,targetType,id,'brightness',Math.max(snap.brightness.min,Math.min(snap.brightness.max,Number(payload.brightness))),false);if(Number.isFinite(Number(payload.rgb))&&snap.color&&(snap.color.supportsRgb||snap.color.supportsHsv)){const rgb=Math.max(0,Math.min(0xFFFFFF,Number(payload.rgb)));if(snap.color.supportsRgb)await setTargetColor(token,targetType,id,'rgb',rgb);else await setTargetColor(token,targetType,id,'hsv',rgbIntToHsv(rgb));}else if(Number.isFinite(Number(payload.temperature))&&snap.color?.supportsTemperature)await setTargetColor(token,targetType,id,'temperature_k',Math.max(snap.color.temperatureMin,Math.min(snap.color.temperatureMax,Number(payload.temperature))));}
  else if(kind==='lightPreset'){const snap=await readTargetSnapshot(token,targetType,id);if(snap.online===false)throw new Error('Устройство не в сети.');if(snap.hasOnOff&&snap.power!==true)await setTargetPower(token,targetType,id,true);if(snap.brightness&&Number.isFinite(Number(payload.brightness)))await setTargetRange(token,targetType,id,'brightness',Math.max(snap.brightness.min,Math.min(snap.brightness.max,Number(payload.brightness))),false);if(payload.color&&snap.color&&(snap.color.supportsRgb||snap.color.supportsHsv)){const rgb=COLOR_PRESETS[String(payload.color)]??COLOR_PRESETS.white;if(snap.color.supportsRgb)await setTargetColor(token,targetType,id,'rgb',rgb);else await setTargetColor(token,targetType,id,'hsv',rgbIntToHsv(rgb));}else if(Number.isFinite(Number(payload.temperature))&&snap.color?.supportsTemperature)await setTargetColor(token,targetType,id,'temperature_k',Math.max(snap.color.temperatureMin,Math.min(snap.color.temperatureMax,Number(payload.temperature))));}
  else if(kind==='scenario'){const scenarioId=String(payload.scenarioId||'');await runScenario(token,scenarioId);recordScenarioUsageById(scenarioId,'panel');}
  else throw new Error('Неизвестная команда панели.');
  userInfoCache={token:'',at:0,data:null};
}
function diagnosticsLogTail(maxLines=320){
  try{
    if(!fs.existsSync(LOG_FILE))return '';
    const raw=fs.readFileSync(LOG_FILE,'utf8');
    const lines=raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(20,Math.min(1000,Number(maxLines)||320))).join('\n');
  }catch(e){return 'Не удалось прочитать лог: '+(e?.message||String(e));}
}
function diagnosticsLogSize(){try{return fs.existsSync(LOG_FILE)?fs.statSync(LOG_FILE).size:0;}catch(_){return 0;}}
function diagnosticsChecks(){
  const hasToken=Boolean(String(globalSettings.token||'').trim());
  return [
    {id:'backend',name:'Backend',ok:true,value:`PID ${process.pid} · ${process.version}`},
    {id:'streamdock',name:'Stream Dock',ok:Boolean(ws.handshakeDone),value:ws.handshakeDone?'WebSocket подключен':'Нет соединения'},
    {id:'dashboard',name:'Локальная панель',ok:Boolean(dashboardHttpPort),value:dashboardHttpPort?`127.0.0.1:${dashboardHttpPort}`:'Не запущена'},
    {id:'token',name:'OAuth-токен',ok:hasToken,value:hasToken?`Сохранён · ${tokenExpiryLabel()}`:'Не сохранён'},
    {id:'version',name:'Версия плагина',ok:true,value:DASHBOARD_VERSION},
    {id:'action-refresh',name:'Обновление кнопок и ручек',ok:true,value:normalizeActionRefreshSeconds(globalSettings.actionRefreshSeconds)===0?'Только вручную':`${normalizeActionRefreshSeconds(globalSettings.actionRefreshSeconds)} сек`},
    {id:'load',name:'Последняя загрузка панели',ok:true,value:dashboardDataCache.data?`${Number(dashboardDataCache.data.loadMs)||0} мс · ${ageShort(Date.now()-dashboardDataCache.at)} назад`:'Ещё не выполнялась'},
    {id:'log',name:'Журнал',ok:true,value:`${Math.max(0,Math.round(diagnosticsLogSize()/1024))} КБ`}
  ];
}
async function runDiagnosticsTests(){
  const started=Date.now(), results=[];
  const add=(name,ok,detail)=>results.push({name,ok:Boolean(ok),detail:String(detail||'')});
  add('Stream Dock',ws.handshakeDone,ws.handshakeDone?'Соединение активно':'WebSocket не подключен');
  add('Глобальные настройки',globalSettingsReady,globalSettingsReady?'Загружены':'Ещё не получены от хоста');
  add('Локальная панель',Boolean(dashboardHttpPort),dashboardHttpPort?`Порт ${dashboardHttpPort}`:'HTTP-сервер не запущен');
  const token=String(globalSettings.token||'').trim();
  add('OAuth-токен',Boolean(token),token?'Сохранён':'Не сохранён');
  if(token){
    const t0=Date.now();
    try{
      const info=await getUserInfo(token,true);
      const baseDevices=normalizeDevices(info);
      const dc=baseDevices.length, gc=normalizeGroups(info,baseDevices).length, sc=scenariosFromInfo(info).length;
      add('Яндекс Smart Home API',true,`Ответ ${Date.now()-t0} мс · устройств ${dc}, групп ${gc}, сценариев ${sc}`);
    }catch(e){add('Яндекс Smart Home API',false,e?.message||String(e));}
  }else add('Яндекс Smart Home API',false,'Сначала сохраните OAuth-токен');
  try{
    const ok=String(ICON_ON||'').startsWith('data:image/svg+xml;base64,')&&String(LIGHT_ICON_ON||'').startsWith('data:image/svg+xml;base64,');
    add('Рендеринг кнопок',ok,ok?'SVG-рендерер работает':'Не удалось сформировать изображения');
  }catch(e){add('Рендеринг кнопок',false,e?.message||String(e));}
  logLine('DIAGNOSTICS_TESTS',`passed=${results.filter(x=>x.ok).length}/${results.length}`,`duration=${Date.now()-started}ms`);
  return {results,passed:results.filter(x=>x.ok).length,total:results.length,durationMs:Date.now()-started,at:Date.now()};
}
function readSystemClipboard(){
  try{const r=spawnSync('/usr/bin/pbpaste',[],{encoding:'utf8',timeout:1200,maxBuffer:2*1024*1024});if(r.error)throw r.error;return String(r.stdout||'');}catch(e){errorLine('CLIPBOARD_READ_ERROR',e?.message||String(e));return null;}
}
function writeSystemClipboard(value){
  try{const r=spawnSync('/usr/bin/pbcopy',[],{input:String(value??''),encoding:'utf8',timeout:1200,maxBuffer:2*1024*1024});if(r.error)throw r.error;return r.status===0;}catch(e){errorLine('CLIPBOARD_WRITE_ERROR',e?.message||String(e));return false;}
}

function openLogsInFinder(){
  try{const child=spawn('/usr/bin/open',['-R',LOG_FILE],{detached:true,stdio:'ignore'});child.unref();return true;}catch(e){errorLine('OPEN_LOGS_ERROR',e?.message||String(e));return false;}
}
function startDashboardHttpServer(){
  if(dashboardHttpServer)return;
  const pluginRoot=path.resolve(__dirname,'..');
  dashboardHttpServer=http.createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://127.0.0.1');
      debugLine('HTTP',req.method,u.pathname);
      if(u.pathname==='/api/diagnostics'&&req.method==='GET')return jsonResponse(res,200,{version:DASHBOARD_VERSION,debugMode:Boolean(globalSettings.debugMode),checks:diagnosticsChecks(),log:diagnosticsLogTail(),logSize:diagnosticsLogSize()});
      if(u.pathname==='/api/diagnostics/log'&&req.method==='GET')return jsonResponse(res,200,{debugMode:Boolean(globalSettings.debugMode),log:diagnosticsLogTail(Number(u.searchParams.get('lines'))||320),logSize:diagnosticsLogSize(),at:Date.now()});
      if(u.pathname==='/api/diagnostics/debug'&&req.method==='POST'){const body=await readJsonBody(req);const enabled=Boolean(body.enabled);setGlobalSettings({debugMode:enabled});if(enabled)logLine('DEBUG_MODE','on');return jsonResponse(res,200,{ok:true,enabled});}
      if(u.pathname==='/api/diagnostics/clear-log'&&req.method==='POST'){try{fs.writeFileSync(LOG_FILE,'');return jsonResponse(res,200,{ok:true});}catch(e){errorLine('CLEAR_LOG_ERROR',e?.message||String(e));return jsonResponse(res,500,{ok:false,message:e?.message||'Не удалось очистить лог.'});}}
      if(u.pathname==='/api/diagnostics/open-logs'&&req.method==='POST'){const ok=openLogsInFinder();return jsonResponse(res,ok?200:500,{ok,message:ok?'Файл журнала открыт в Finder.':'Не удалось открыть Finder.'});}
      if(u.pathname==='/api/diagnostics/tests'&&req.method==='POST'){const result=await runDiagnosticsTests();return jsonResponse(res,200,result);}
      if(u.pathname==='/api/plugin/reset'&&req.method==='POST'){const result=resetPluginCompletely();return jsonResponse(res,200,result);}
      if(u.pathname==='/api/history'&&req.method==='GET'){return jsonResponse(res,200,sensorHistoryQuery(u.searchParams.get('deviceId')||'',u.searchParams.get('instance')||'',Number(u.searchParams.get('hours'))||1));}
      if(u.pathname==='/api/usage'&&req.method==='GET'){return jsonResponse(res,200,usageStatsSnapshot(Number(u.searchParams.get('days'))||7));}
      if(u.pathname==='/api/usage/settings'&&req.method==='POST'){const body=await readJsonBody(req);setGlobalSettings({usageStatsEnabled:Boolean(body.enabled)});return jsonResponse(res,200,usageStatsSnapshot(Number(body.days)||7));}
      if(u.pathname==='/api/usage/clear'&&req.method==='POST'){return jsonResponse(res,200,clearUsageStats());}
      if(u.pathname==='/api/snapshot'){
        const cached=dashboardDataCache.data&&dashboardDataCache.token===String(globalSettings.token||'').trim()?dashboardDataCache.data:null;
        return jsonResponse(res,200,{version:DASHBOARD_VERSION,globalSettings:{token:globalSettings.token||'',tokenExpiresAt:Number(globalSettings.tokenExpiresAt)||0,tokenLifetimeSeconds:Number(globalSettings.tokenLifetimeSeconds)||0,tokenExpiryCapturedAt:Number(globalSettings.tokenExpiryCapturedAt)||0,dashboardPrefs:globalSettings.dashboardPrefs||null,actionRefreshSeconds:normalizeActionRefreshSeconds(globalSettings.actionRefreshSeconds)},devices:cached?.devices||[],groups:cached?.groups||[],scenarios:cached?.scenarios||[],rooms:cached?.rooms||[],dashboardCacheAt:cached?dashboardDataCache.at:0,backendReady:true,status:{text:cached?'Панель готова · показываю последние данные':'Панель подключена напрямую к backend',cls:'ok'}});
      }
      if(u.pathname==='/api/devices'){const token=String(globalSettings.token||'').trim();if(!token)return jsonResponse(res,401,{message:'OAuth-токен не сохранён.'});const data=await buildDashboardData(token,u.searchParams.get('force')==='1');return jsonResponse(res,200,data);}
      if(u.pathname==='/api/presence'){const token=String(globalSettings.token||'').trim();if(!token)return jsonResponse(res,401,{message:'OAuth-токен не сохранён.'});const data=await dashboardPresenceSnapshot(token,u.searchParams.get('force')==='1');return jsonResponse(res,200,data);}
      if(u.pathname==='/api/clipboard/read'&&req.method==='GET'){const text=readSystemClipboard();if(text===null)return jsonResponse(res,500,{message:'Не удалось прочитать буфер обмена.'});return jsonResponse(res,200,{ok:true,text});}
      if(u.pathname==='/api/clipboard/write'&&req.method==='POST'){const payload=await readJsonBody(req);const ok=writeSystemClipboard(payload?.text??'');return jsonResponse(res,ok?200:500,ok?{ok:true}:{message:'Не удалось записать в буфер обмена.'});}
      if(u.pathname==='/api/entity-detail'&&req.method==='GET'){const token=String(globalSettings.token||'').trim();if(!token)return jsonResponse(res,401,{message:'OAuth-токен не сохранён.'});const deviceId=String(u.searchParams.get('deviceId')||'').trim();const targetType=String(u.searchParams.get('targetType')||'device')==='group'?'group':'device';if(!deviceId)return jsonResponse(res,400,{message:'Не указан идентификатор устройства.'});let entity={id:deviceId,...(await readTargetSnapshot(token,targetType,deviceId)||{})};if(targetType==='device')entity=decorateDevicesForDashboard([entity])[0]||entity;return jsonResponse(res,200,{ok:true,entity});}
      if(u.pathname==='/api/command'&&req.method==='POST'){const payload=await readJsonBody(req);await performDashboardCommand(payload);return jsonResponse(res,200,{ok:true,message:'Команда выполнена.'});}
      if(u.pathname==='/api/token'&&req.method==='POST'){const body=await readJsonBody(req);const token=String(body.token||'').trim(),expiresIn=Math.max(0,Number(body.expiresIn)||0),sameToken=token&&token===String(globalSettings.token||'').trim();let tokenExpiresAt=sameToken?Math.max(0,Number(globalSettings.tokenExpiresAt)||0):0,tokenLifetimeSeconds=sameToken?Math.max(0,Number(globalSettings.tokenLifetimeSeconds)||0):0,tokenExpiryCapturedAt=sameToken?Math.max(0,Number(globalSettings.tokenExpiryCapturedAt)||0):0;if(token&&expiresIn>0){tokenLifetimeSeconds=expiresIn;tokenExpiryCapturedAt=Date.now();tokenExpiresAt=tokenExpiryCapturedAt+expiresIn*1000;}if(!token){tokenExpiresAt=0;tokenLifetimeSeconds=0;tokenExpiryCapturedAt=0;}setGlobalSettings({token,tokenExpiresAt,tokenLifetimeSeconds,tokenExpiryCapturedAt});return jsonResponse(res,200,{ok:true,hasToken:Boolean(token),tokenExpiry:tokenExpirySnapshot(token),message:token?'Токен сохранён.':'Токен удалён.'});}
      if(u.pathname==='/api/preferences'&&req.method==='POST'){const body=await readJsonBody(req);const prefs=body&&typeof body.prefs==='object'&&body.prefs&&!Array.isArray(body.prefs)?body.prefs:{};setGlobalSettings({dashboardPrefs:prefs});return jsonResponse(res,200,{ok:true});}
      if(u.pathname==='/api/action-refresh'&&req.method==='POST'){const body=await readJsonBody(req);const actionRefreshSeconds=normalizeActionRefreshSeconds(body.actionRefreshSeconds);setGlobalSettings({actionRefreshSeconds});return jsonResponse(res,200,{ok:true,actionRefreshSeconds});}
      if(u.pathname==='/api/open-external'&&req.method==='POST'){const body=await readJsonBody(req);const url=String(body.url||'').trim();if(!/^https?:\/\//i.test(url))return jsonResponse(res,400,{ok:false,message:'Некорректная ссылка.'});openExternalBrowser(url);return jsonResponse(res,200,{ok:true});}
      if(u.pathname==='/api/validate'&&req.method==='POST'){const body=await readJsonBody(req);const token=String(body.token||globalSettings.token||'').trim();if(!token)return jsonResponse(res,400,{valid:false,message:'Токен не указан.'});try{const info=await getUserInfo(token,true);return jsonResponse(res,200,{valid:true,tokenExpiry:tokenExpirySnapshot(token),message:`Токен работает. Устройств: ${normalizeDevices(info).length}`});}catch(e){errorLine('TOKEN_VALIDATE_ERROR',e?.message||String(e));return jsonResponse(res,400,{valid:false,message:e?.message||'Токен не прошёл проверку.'});}}
      let rel=u.pathname==='/'?'dashboard/index.html':u.pathname.replace(/^\//,'');
      if(rel==='dashboard')rel='dashboard/index.html';
      const file=path.resolve(pluginRoot,rel);if(!file.startsWith(pluginRoot+path.sep))return jsonResponse(res,403,{message:'Forbidden'});
      if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
      const body=fs.readFileSync(file);res.writeHead(200,{'Content-Type':dashboardMime(file),'Content-Length':body.length,'Cache-Control':'no-store'});res.end(body);
    }catch(e){errorLine('DASHBOARD_HTTP_ERROR',e?.message||String(e));jsonResponse(res,500,{message:e?.message||'Ошибка локальной панели.'});}
  });
  dashboardHttpServer.listen(0,'127.0.0.1',()=>{dashboardHttpPort=dashboardHttpServer.address()?.port||0;logLine('DASHBOARD_HTTP','port='+dashboardHttpPort);});
  dashboardHttpServer.on('error',e=>errorLine('DASHBOARD_HTTP_SERVER_ERROR',e?.message||String(e)));
}
function openExternalBrowser(url){
  const target=String(url||'').trim();
  if(!/^https?:\/\//i.test(target)) return;
  try{
    const child=spawn('/usr/bin/open',[target],{detached:true,stdio:'ignore'});
    child.unref();
  }catch(e){
    errorLine('OPEN_EXTERNAL_ERROR',e?.message||String(e));
    send({event:'openUrl',payload:{url:target}});
  }
}
const DASHBOARD_STATE_FILE = path.join(process.env.TMPDIR || '/tmp', 'nbord-yandex-smarthome-streamdock-dashboard.json');
const DASHBOARD_LOCK_FILE = path.join(process.env.TMPDIR || '/tmp', 'nbord-yandex-smarthome-streamdock-dashboard.lock');
const DASHBOARD_FOCUS_FILE = path.join(process.env.TMPDIR || '/tmp', 'nbord-yandex-smarthome-streamdock-dashboard.focus');
const DASHBOARD_DEBUG_FLAG_FILE = path.join(process.env.TMPDIR || '/tmp', `nbord-yandex-smarthome-streamdock-dashboard-debug-${process.pid}.flag`);
function syncDashboardDebugFlag(){
  try{
    if(debugLoggingEnabled) fs.writeFileSync(DASHBOARD_DEBUG_FLAG_FILE,'1');
    else fs.unlinkSync(DASHBOARD_DEBUG_FLAG_FILE);
  }catch(e){
    if(debugLoggingEnabled && e && e.code!=='ENOENT') errorLine('DASHBOARD_DEBUG_FLAG_ERROR',e?.message||String(e));
  }
}
function dashboardProcessAlive(pid){try{return Number(pid)>0&&(process.kill(Number(pid),0),true);}catch(_){return false;}}
function readDashboardState(){try{const x=JSON.parse(fs.readFileSync(DASHBOARD_STATE_FILE,'utf8'));return x&&typeof x==='object'?x:null;}catch(_){return null;}}
function writeDashboardState(state){try{fs.writeFileSync(DASHBOARD_STATE_FILE,JSON.stringify(state));}catch(_){} }
function clearDashboardState(){try{fs.unlinkSync(DASHBOARD_STATE_FILE);}catch(_){} }
function dashboardBackendAlive(url){return new Promise(resolve=>{try{const u=new URL(String(url||''));u.pathname='/api/snapshot';u.search='';const req=http.get(u,{timeout:650},res=>{res.resume();resolve(res.statusCode>=200&&res.statusCode<500);});req.on('timeout',()=>{req.destroy();resolve(false);});req.on('error',()=>resolve(false));}catch(_){resolve(false);}});}
function focusDashboardProcess(pid){try{const n=Number(pid);const stamp=JSON.stringify({pid:n,at:Date.now(),nonce:Math.random().toString(36).slice(2)});fs.writeFileSync(DASHBOARD_FOCUS_FILE,stamp);const notification='com.yandex.smarthome.streamdock.dashboard.focus.'+n;const code=`ObjC.import('Cocoa');try{$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('${notification}',null,null,true);}catch(e){};var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${n});if(a){a.activateWithOptions($.NSApplicationActivateAllWindows|$.NSApplicationActivateIgnoringOtherApps);}`;const c=spawn('/usr/bin/osascript',['-l','JavaScript','-e',code],{detached:true,stdio:'ignore'});c.unref();logLine('DASHBOARD_NATIVE_FOCUS','pid='+pid,'focusFile='+DASHBOARD_FOCUS_FILE);return true;}catch(e){errorLine('DASHBOARD_NATIVE_FOCUS_ERROR',e?.message||String(e));return false;}}
function acquireDashboardLaunchLock(){try{const fd=fs.openSync(DASHBOARD_LOCK_FILE,'wx');fs.closeSync(fd);return true;}catch(_){try{const st=fs.statSync(DASHBOARD_LOCK_FILE);if(Date.now()-st.mtimeMs>3000){fs.unlinkSync(DASHBOARD_LOCK_FILE);const fd=fs.openSync(DASHBOARD_LOCK_FILE,'wx');fs.closeSync(fd);return true;}}catch(__){}return false;}}
function releaseDashboardLaunchLock(){try{fs.unlinkSync(DASHBOARD_LOCK_FILE);}catch(_){} }
function cleanupOrphanDashboardHelpers(keepPid=0){
  try{
    const script=path.join(__dirname,'dashboard-window.jxa.js');
    const out=spawnSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8',timeout:1500});
    if(out.error||typeof out.stdout!=='string')return 0;
    let killed=0;
    for(const line of out.stdout.split(/\r?\n/)){
      const m=line.match(/^\s*(\d+)\s+(.+)$/);if(!m)continue;
      const pid=Number(m[1]),cmd=m[2]||'';
      if(!pid||pid===Number(keepPid))continue;
      if(!cmd.includes('osascript')||!cmd.includes(script))continue;
      try{process.kill(pid,'SIGTERM');killed++;logLine('DASHBOARD_NATIVE_ORPHAN_CLOSED','pid='+pid);}catch(_){}
    }
    return killed;
  }catch(e){errorLine('DASHBOARD_NATIVE_ORPHAN_CLEANUP_ERROR',e?.message||String(e));return 0;}
}
async function openDashboardFromKey(){
  startDashboardHttpServer();
  const existing=readDashboardState();
  const existingMatchesVersion=existing&&String(existing.version||'')===DASHBOARD_VERSION;
  if(existingMatchesVersion&&dashboardProcessAlive(existing.pid)&&await dashboardBackendAlive(existing.url)){
    cleanupOrphanDashboardHelpers(existing.pid);
    focusDashboardProcess(existing.pid);
    return;
  }
  if(existing){
    if(dashboardProcessAlive(existing.pid)){try{process.kill(Number(existing.pid),'SIGTERM');}catch(_){} }
    clearDashboardState();
    logLine('DASHBOARD_NATIVE_STALE_CLOSED','oldVersion='+(existing.version||'unknown'),'newVersion='+DASHBOARD_VERSION);
  }
  // There must be only one native helper. This also cleans up orphan windows left by
  // the experimental Spaces builds before a fresh window is created.
  const orphanCount=cleanupOrphanDashboardHelpers(0);
  if(orphanCount)await new Promise(r=>setTimeout(r,180));
  if(!acquireDashboardLaunchLock()){setTimeout(()=>openDashboardFromKey(),220);return;}
  try{
    const afterLock=readDashboardState();
    if(afterLock&&String(afterLock.version||'')===DASHBOARD_VERSION&&dashboardProcessAlive(afterLock.pid)&&await dashboardBackendAlive(afterLock.url)){
      cleanupOrphanDashboardHelpers(afterLock.pid);
      focusDashboardProcess(afterLock.pid);
      return;
    }
    if(afterLock){
      if(dashboardProcessAlive(afterLock.pid)){try{process.kill(Number(afterLock.pid),'SIGTERM');}catch(_){} }
      clearDashboardState();
    }
    const extraOrphans=cleanupOrphanDashboardHelpers(0);
    if(extraOrphans)await new Promise(r=>setTimeout(r,180));
    let wait=0;while(!dashboardHttpPort&&wait<2500){await new Promise(r=>setTimeout(r,80));wait+=80;}
    if(!dashboardHttpPort)throw new Error('Локальный сервер панели не запущен.');
    const url=`http://127.0.0.1:${dashboardHttpPort}/dashboard/index.html?standalone=1&native=1&v=${encodeURIComponent(DASHBOARD_VERSION)}`;
    const script=path.join(__dirname,'dashboard-window.jxa.js');
    const child=spawn('/usr/bin/osascript',['-l','JavaScript',script,url,DASHBOARD_FOCUS_FILE,LOG_FILE,DASHBOARD_DEBUG_FLAG_FILE],{detached:true,stdio:'ignore'});
    child.on('error',e=>{errorLine('DASHBOARD_NATIVE_ERROR',e?.message||String(e));clearDashboardState();send({event:'openUrl',payload:{url}});});
    if(child.pid)writeDashboardState({pid:child.pid,url,version:DASHBOARD_VERSION,openedAt:Date.now()});
    child.unref();
    logLine('DASHBOARD_NATIVE_OPEN',url,'pid='+String(child.pid||''));
  }catch(e){errorLine('DASHBOARD_NATIVE_ERROR',e?.message||String(e));}
  finally{releaseDashboardLaunchLock();}
}

ws.on('open', () => {
  send({ event: REGISTER_EVENT, uuid: PLUGIN_UUID });
  send({ event: 'getGlobalSettings', context: PLUGIN_UUID });
  startDashboardHttpServer();
  logLine('WS_OPEN', 'port=' + PORT, 'pluginUUID=' + PLUGIN_UUID);
  console.log('n-bord Yandex Smart Home plugin connected to StreamDock');
}).on('error', e => {
  errorLine('WS_ERROR', e?.message || String(e));
  console.error('StreamDock socket error:', e);
}).on('close', () => {
  logLine('WS_CLOSE');
  process.exit(0);
});

ws.on('message', raw => {
  let data;
  try { data = JSON.parse(raw); } catch (_) { return; }
  const event = data.event;
  const context = data.context;
  const action = data.action || actionByContext[context] || '';
  if (context && data.action) actionByContext[context] = data.action;
  debugLine('WS_EVENT',String(event||'-'),String(data.action||action||'-'),String(context||'').slice(0,24));
  if (event) {
    logLine(
      'EVENT', event, data.action || '', context || '',
      event === 'sendToPlugin' ? ('command=' + String(data.payload?.command || '')) : ''
    );
  }

  if (event === 'didReceiveGlobalSettings') {
    const incoming = data.payload?.settings || data.payload || {};
    const currentResetAt = Number(globalSettings.fullResetAt) || 0;
    const incomingResetAt = Number(incoming?.fullResetAt) || 0;
    if (currentResetAt && incomingResetAt < currentResetAt) {
      send({ event: 'setGlobalSettings', context: PLUGIN_UUID, payload: globalSettings });
      return;
    }
    globalSettings = Object.assign({ token: '', tokenExpiresAt: 0, tokenLifetimeSeconds: 0, tokenExpiryCapturedAt: 0, actionRefreshSeconds: DEFAULT_ACTION_REFRESH_SECONDS }, incoming && typeof incoming === 'object' ? incoming : {});
    globalSettings.token = String(globalSettings.token || '').trim();
    globalSettings.tokenExpiresAt = Math.max(0, Number(globalSettings.tokenExpiresAt) || 0);
    globalSettings.tokenLifetimeSeconds = Math.max(0, Number(globalSettings.tokenLifetimeSeconds) || 0);
    globalSettings.tokenExpiryCapturedAt = Math.max(0, Number(globalSettings.tokenExpiryCapturedAt) || 0);
    globalSettings.actionRefreshSeconds = normalizeActionRefreshSeconds(globalSettings.actionRefreshSeconds);
    debugLoggingEnabled = globalSettings.debugMode === true;
    syncDashboardDebugFlag();
    globalSettingsReady = true;
    if (debugLoggingEnabled) logLine('DEBUG_MODE', 'restored');
    userInfoCache = { token: '', at: 0, data: null };
    scheduleActionRefresh();
    tryMigrateLegacyToken();
    for (const ctx of visibleContexts) {
      refreshAction(ctx, actionByContext[ctx]);
    }
    return;
  }

  if (event === 'willAppear' && ACTIONS.has(data.action)) {
    visibleContexts.add(context);
    const ctl=String(data.payload?.controller||data.payload?.controllerType||data.controller||data.actionLocation||data.payload?.actionLocation||'').toLowerCase();
    if(ctl.includes('information')||ctl.includes('secondaryscreen')) informationContexts.add(context); else informationContexts.delete(context);
    if(data.action===ACTION_SENSOR_MULTI){if(ctl.includes('knob')||ctl.includes('dial')||ctl.includes('encoder'))sensorMultiDialContexts.add(context);else sensorMultiDialContexts.delete(context);}
    if(data.action===ACTION_SCENARIO){if(ctl.includes('knob')||ctl.includes('dial')||ctl.includes('encoder'))scenarioDialContexts.add(context);else scenarioDialContexts.delete(context);}
    if(ctl) logLine('CONTROLLER',data.action,context,ctl);
    settingsByContext[context] = normalizedSettingsForCurrentReset(data.payload?.settings || {}, context, true);
    tryMigrateLegacyToken();
    refreshAction(context, data.action);
    return;
  }

  if (event === 'willDisappear' && ACTIONS.has(data.action)) {
    cleanupContext(context);
    return;
  }

  if (event === 'propertyInspectorDidAppear' && ACTIONS.has(data.action)) {
    sendToPropertyInspector(context, {
      type: 'backendReady',
      message: `Backend запущен (${process.version})`,
      hasGlobalToken: Boolean(String(globalSettings.token || '').trim()),
      globalSettingsReady
    }, data.action);
    return;
  }

  if (event === 'didReceiveSettings' && ACTIONS.has(data.action)) {
    settingsByContext[context] = normalizedSettingsForCurrentReset(data.payload?.settings || {}, context, true);
    tryMigrateLegacyToken();
    if (visibleContexts.has(context)) refreshAction(context, data.action);
    return;
  }

  if (event === 'keyDown' && ACTIONS.has(data.action) && data.action!==ACTION_SCENARIO) recordUsageFromContext(context, data.action, 'streamdock');
  if (event === 'dialDown' && ACTIONS.has(data.action) && data.action!==ACTION_SCENARIO) recordUsageFromContext(context, data.action, 'streamdock');
  if (event === 'dialRotate' && [ACTION_BRIGHTNESS,ACTION_CURTAIN,ACTION_VACUUM_SPEED,ACTION_CLIMATE_MODE,ACTION_KETTLE_TEMP,ACTION_MEDIA_VOLUME,ACTION_MEDIA_CHANNEL,ACTION_LIGHT_TEMP,ACTION_LIGHT_COLOR_DIAL].includes(data.action)) recordUsageFromContext(context, data.action, 'streamdock', 2400);

  if (event === 'keyDown' && [ACTION_TOGGLE, ACTION_LIGHT_POWER].includes(data.action)) {
    executePower(context, data.action);
    return;
  }

  if (event === 'keyDown' && data.action === ACTION_SENSOR) { if(!informationContexts.has(context)) refreshSensor(context); return; }
  if (event === 'keyDown' && data.action === ACTION_SENSOR_MULTI) { if(!informationContexts.has(context)){sensorMultiDialContexts.delete(context);cycleCombinedSensor(context);} return; }
  if (event === 'dialRotate' && data.action === ACTION_SENSOR_MULTI) { cycleSensorMultiDial(context, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_SENSOR_MULTI) { sensorMultiDialContexts.add(context); refreshSensorMultiDial(context); return; }
  if (event === 'dialRotate' && data.action === ACTION_SCENARIO) { cycleScenarioDial(context, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_SCENARIO) { executeScenarioDial(context); return; }

  if (event === 'dialRotate' && data.action === ACTION_BRIGHTNESS) {
    applyBrightnessTicks(context, data.payload?.ticks || 0);
    return;
  }

  if (event === 'dialDown' && data.action === ACTION_BRIGHTNESS) {
    executePower(context, ACTION_BRIGHTNESS);
    return;
  }

  if (event === 'dialRotate' && data.action === ACTION_CURTAIN) {
    applyCurtainTicks(context, data.payload?.ticks || 0);
    return;
  }

  if (event === 'dialDown' && data.action === ACTION_CURTAIN) {
    toggleCurtain(context);
    return;
  }

  if (event === 'dialRotate' && data.action === ACTION_VACUUM_SPEED) { applyVacuumTicks(context, data.payload?.ticks || 0); return; }
  if (event === 'dialRotate' && data.action === ACTION_CLIMATE_MODE) { applyClimateTicks(context, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_VACUUM_SPEED) { toggleKnobPower(context, ACTION_VACUUM_SPEED, refreshVacuum); return; }
  if (event === 'dialDown' && data.action === ACTION_CLIMATE_MODE) { toggleKnobPower(context, ACTION_CLIMATE_MODE, refreshClimate); return; }
  if (event === 'dialRotate' && data.action === ACTION_KETTLE_TEMP) { applyRangeTicks(context, ACTION_KETTLE_TEMP, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_KETTLE_TEMP) { toggleKnobPower(context, ACTION_KETTLE_TEMP, c => refreshRangeKnob(c, ACTION_KETTLE_TEMP)); return; }
  if (event === 'dialRotate' && data.action === ACTION_MEDIA_VOLUME) { applyRangeTicks(context, ACTION_MEDIA_VOLUME, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_MEDIA_VOLUME) { toggleMediaVolumePress(context); return; }
  if (event === 'dialRotate' && data.action === ACTION_MEDIA_CHANNEL) { applyRangeTicks(context, ACTION_MEDIA_CHANNEL, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_MEDIA_CHANNEL) { mediaChannelPress(context); return; }
  if (event === 'dialRotate' && data.action === ACTION_LIGHT_TEMP) { applyColorTempTicks(context, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_LIGHT_TEMP) { toggleKnobPower(context, ACTION_LIGHT_TEMP, refreshColorTemp); return; }
  if (event === 'dialRotate' && data.action === ACTION_LIGHT_COLOR_DIAL) { applyColorDialTicks(context, data.payload?.ticks || 0); return; }
  if (event === 'dialDown' && data.action === ACTION_LIGHT_COLOR_DIAL) { toggleKnobPower(context, ACTION_LIGHT_COLOR_DIAL, refreshColorDial); return; }
  if (event === 'keyDown' && data.action === ACTION_LIGHT_COLOR) { executeLightColor(context); return; }
  if (event === 'keyDown' && data.action === ACTION_LIGHT_PRESET) { executeLightPreset(context); return; }
  if (event === 'keyDown' && data.action === ACTION_DASHBOARD) { openDashboardFromKey(); return; }
  if (event === 'keyDown' && data.action === ACTION_MEDIA) { executeMediaCommand(context); return; }
  if (event === 'keyDown' && data.action === ACTION_SCENARIO) { executeScenario(context); return; }

  if (event !== 'sendToPlugin' || !ACTIONS.has(data.action)) return;

  const payload = data.payload || {};
  const command = payload.command;
  if (command === 'loadDevices') {
    loadDevicesForAction(context, data.action, payload.token || '', Boolean(payload.force));
  } else if (command === 'refreshDevices') {
    loadDevicesForAction(context, data.action, '', true);
  } else if (command === 'selectDevice') {
    saveSettings(context, {
      deviceId: String(payload.deviceId || ''),
      deviceName: String(payload.deviceName || ''),
      targetType: payload.targetType === 'group' ? 'group' : 'device',
      brightnessStep: Number(payload.brightnessStep) > 0 ? Number(payload.brightnessStep) : getSettings(context).brightnessStep,
      brightnessDialStep: [1,5,10,20].includes(Number(payload.brightnessDialStep)) ? Number(payload.brightnessDialStep) : getSettings(context).brightnessDialStep,
      brightnessAcceleration: payload.brightnessAcceleration == null ? getSettings(context).brightnessAcceleration : Boolean(payload.brightnessAcceleration),
      curtainStep: Number(payload.curtainStep) > 0 ? Number(payload.curtainStep) : getSettings(context).curtainStep,
      curtainDialStep: [1,5,10,20].includes(Number(payload.curtainDialStep)) ? Number(payload.curtainDialStep) : getSettings(context).curtainDialStep,
      curtainAcceleration: payload.curtainAcceleration == null ? getSettings(context).curtainAcceleration : Boolean(payload.curtainAcceleration),
      curtainReverse: payload.curtainReverse == null ? getSettings(context).curtainReverse : Boolean(payload.curtainReverse),
      temperatureStep: Number(payload.temperatureStep) > 0 ? Number(payload.temperatureStep) : getSettings(context).temperatureStep,
      colorTemperatureStep: Number(payload.colorTemperatureStep) > 0 ? Number(payload.colorTemperatureStep) : getSettings(context).colorTemperatureStep,
      propertyInstance: String(payload.propertyInstance || getSettings(context).propertyInstance || ''),
      combinedInstances: String(payload.combinedInstances || getSettings(context).combinedInstances || ''),
      sensorDialStyle: ['minimal','widget'].includes(String(payload.sensorDialStyle||'')) ? String(payload.sensorDialStyle) : getSettings(context).sensorDialStyle,
      climateModeInstance: String(payload.climateModeInstance || getSettings(context).climateModeInstance || ''),
      powerMode: ['toggle', 'on', 'off'].includes(String(payload.powerMode || '')) ? String(payload.powerMode) : getSettings(context).powerMode,
      colorPreset: String(payload.colorPreset || getSettings(context).colorPreset || 'white'),
      mediaCommand: String(payload.mediaCommand || getSettings(context).mediaCommand || 'power_toggle'),
      mediaVolumeStep: Number(payload.mediaVolumeStep) > 0 ? Math.max(1,Math.min(20,Number(payload.mediaVolumeStep))) : getSettings(context).mediaVolumeStep,
      sensorThresholdEnabled: payload.sensorThresholdEnabled == null ? getSettings(context).sensorThresholdEnabled : Boolean(payload.sensorThresholdEnabled),
      sensorWarn: payload.sensorWarn == null ? getSettings(context).sensorWarn : String(payload.sensorWarn), sensorDanger: payload.sensorDanger == null ? getSettings(context).sensorDanger : String(payload.sensorDanger), sensorDirection: payload.sensorDirection === 'low' ? 'low' : (payload.sensorDirection === 'high' ? 'high' : getSettings(context).sensorDirection),
      presetName: String(payload.presetName || getSettings(context).presetName || 'Пресет'), presetPower: payload.presetPower == null ? getSettings(context).presetPower : Boolean(payload.presetPower), presetUseBrightness: payload.presetUseBrightness == null ? getSettings(context).presetUseBrightness : Boolean(payload.presetUseBrightness), presetBrightness: Number(payload.presetBrightness) || getSettings(context).presetBrightness, presetUseTemperature: payload.presetUseTemperature == null ? getSettings(context).presetUseTemperature : Boolean(payload.presetUseTemperature), presetTemperature: Number(payload.presetTemperature) || getSettings(context).presetTemperature, presetColor: String(payload.presetColor || getSettings(context).presetColor || 'none')
    });
    const rt = brightnessRuntime.get(context);
    if (rt) {
      if (rt.timer) clearTimeout(rt.timer);
      brightnessRuntime.delete(context);
    }
    const crt = curtainRuntime.get(context);
    if (crt) { if (crt.timer) clearTimeout(crt.timer); curtainRuntime.delete(context); }
    const rr = rangeRuntime.get(context); if (rr?.timer) clearTimeout(rr.timer); rangeRuntime.delete(context);
    const ct = colorTempRuntime.get(context); if (ct?.timer) clearTimeout(ct.timer); colorTempRuntime.delete(context);
    const cd = colorDialRuntime.get(context); if (cd?.timer) clearTimeout(cd.timer); colorDialRuntime.delete(context);
    const mr = modeRuntime.get(context); if (mr?.timer) clearTimeout(mr.timer); modeRuntime.delete(context);
    sendToPropertyInspector(context, {
      type: 'selected',
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      targetType: payload.targetType === 'group' ? 'group' : 'device'
    }, data.action);
    refreshAction(context, data.action);
  } else if (command === 'setBrightnessStep') {
    saveSettings(context, { brightnessStep: Math.max(1, Math.min(50, Number(payload.brightnessStep) || 5)) });
  } else if (command === 'setBrightnessDial') {
    saveSettings(context, { brightnessDialStep: normalizedPercentDialStep(payload.brightnessDialStep), brightnessAcceleration: payload.brightnessAcceleration !== false });
  } else if (command === 'setCurtainStep') {
    saveSettings(context, { curtainStep: Math.max(1, Math.min(50, Number(payload.curtainStep) || 10)) });
  } else if (command === 'setCurtainDial') {
    saveSettings(context, { curtainDialStep: normalizedPercentDialStep(payload.curtainDialStep), curtainAcceleration: payload.curtainAcceleration !== false });
  } else if (command === 'setCurtainReverse') {
    const reverse=Boolean(payload.curtainReverse); const ss=saveSettings(context, { curtainReverse: reverse });
    if(ss.deviceId){const map={...(globalSettings.curtainReverseByDevice||{})};map[ss.deviceId]=reverse;setGlobalSettings({curtainReverseByDevice:map});}
    curtainRuntime.delete(context); refreshCurtain(context);
  } else if (command === 'setTemperatureStep') {
    saveSettings(context, { temperatureStep: Math.max(1, Math.min(25, Number(payload.temperatureStep) || 5)) });
  } else if (command === 'setColorTemperatureStep') {
    saveSettings(context, { colorTemperatureStep: Math.max(50, Math.min(1000, Number(payload.colorTemperatureStep) || 250)) });
  } else if (command === 'setColorPreset') {
    saveSettings(context, { colorPreset: String(payload.colorPreset || 'white') }); refreshSimpleAction(context, data.action);
  } else if (command === 'setMediaCommand') {
    saveSettings(context, { mediaCommand: String(payload.mediaCommand || 'power_toggle') }); refreshSimpleAction(context, data.action);
  } else if (command === 'setMediaVolumeStep') {
    saveSettings(context, { mediaVolumeStep: Math.max(1, Math.min(20, Number(payload.mediaVolumeStep) || 1)) }); refreshRangeKnob(context, ACTION_MEDIA_VOLUME);
  } else if (command === 'selectScenario') {
    saveSettings(context, { scenarioId: String(payload.scenarioId || ''), scenarioName: String(payload.scenarioName || '') }); refreshAction(context, ACTION_SCENARIO);
  } else if (command === 'setScenarioDialSource') {
    const scenarioDialSource=payload.scenarioDialSource==='all'?'all':'favorites';saveSettings(context,{scenarioDialSource});scenarioDialRuntime.delete(context);refreshAction(context,ACTION_SCENARIO);
  } else if (command === 'setInfoTemplate') {
    const infoTemplate=['home','climate','alerts','favorites'].includes(String(payload.infoTemplate||''))?String(payload.infoTemplate):'home';saveSettings(context,{infoTemplate});refreshAction(context,ACTION_DASHBOARD);
  } else if (command === 'setSensorProperty') {
    saveSettings(context, { propertyInstance: String(payload.propertyInstance || '') });
    refreshSensor(context);
  } else if (command === 'setSensorThresholds') {
    saveSettings(context,{sensorThresholdEnabled:Boolean(payload.sensorThresholdEnabled),sensorWarn:String(payload.sensorWarn??''),sensorDanger:String(payload.sensorDanger??''),sensorDirection:payload.sensorDirection==='low'?'low':'high'});refreshAction(context,data.action);
  } else if (command === 'setCombinedProperties') {
    saveSettings(context,{combinedInstances:String(payload.combinedInstances||'')});const rt=combinedRuntimeFor(context);rt.page=0;const dr=sensorMultiDialRuntimeFor(context);dr.index=0;if(sensorMultiDialContexts.has(context))refreshSensorMultiDial(context);else refreshCombinedSensor(context);
  } else if (command === 'setSensorDialStyle') {
    const sensorDialStyle=['minimal','widget'].includes(String(payload.sensorDialStyle||''))?String(payload.sensorDialStyle):'widget';saveSettings(context,{sensorDialStyle});refreshAction(context,data.action);
  } else if (command === 'setClimateMode') {
    saveSettings(context,{climateModeInstance:String(payload.climateModeInstance||'')});modeRuntime.delete(context);refreshClimate(context);
  } else if (command === 'setLightPreset') {
    saveSettings(context,{presetName:String(payload.presetName||'Пресет'),presetPower:Boolean(payload.presetPower),presetUseBrightness:Boolean(payload.presetUseBrightness),presetBrightness:Math.max(1,Math.min(100,Number(payload.presetBrightness)||50)),presetUseTemperature:Boolean(payload.presetUseTemperature),presetTemperature:Math.max(1500,Math.min(10000,Number(payload.presetTemperature)||3000)),presetColor:String(payload.presetColor||'none')});refreshSimpleAction(context,ACTION_LIGHT_PRESET);
  } else if (command === 'setPowerMode') {
    const powerMode = ['toggle', 'on', 'off'].includes(String(payload.powerMode || '')) ? String(payload.powerMode) : 'toggle';
    saveSettings(context, { powerMode });
    refreshToggle(context, data.action);
  } else if (command === 'refreshState') {
    Promise.resolve(refreshAction(context, data.action))
      .then(() => sendToPropertyInspector(context, {
        type: 'stateRefreshed',
        message: 'Состояние обновлено.'
      }, data.action))
      .catch(e => sendToPropertyInspector(context, {
        type: 'error',
        message: e?.message || 'Не удалось обновить состояние.'
      }, data.action));
  } else if (command === 'setActionRefreshSeconds') {
    const seconds = normalizeActionRefreshSeconds(payload.actionRefreshSeconds);
    setGlobalSettings({ actionRefreshSeconds: seconds });
    sendToPropertyInspector(context, {
      type: 'actionRefreshChanged',
      actionRefreshSeconds: seconds
    }, data.action);
  } else if (command === 'openExternalUrl') {
    openExternalBrowser(payload.url);
  } else if (command === 'openDashboardWindow') {
    openDashboardFromKey();
  } else if (command === 'saveDashboardPrefs') {
    const prefs=payload.dashboardPrefs&&typeof payload.dashboardPrefs==='object'&&!Array.isArray(payload.dashboardPrefs)?payload.dashboardPrefs:{};
    setGlobalSettings({dashboardPrefs:prefs});
  } else if (command === 'saveGlobalToken') {
    const token = String(payload.token || '').trim();
    setGlobalSettings({ token, tokenExpiresAt: token===String(globalSettings.token||'').trim()?globalSettings.tokenExpiresAt:0, tokenLifetimeSeconds: token===String(globalSettings.token||'').trim()?globalSettings.tokenLifetimeSeconds:0, tokenExpiryCapturedAt: token===String(globalSettings.token||'').trim()?globalSettings.tokenExpiryCapturedAt:0 });
    if (token) {
      loadDevicesForAction(context, data.action, token, true);
    } else {
      sendToPropertyInspector(context, { type: 'tokenSaved', hasToken: false, message: 'Токен удалён.' }, data.action);
    }
  } else if (command === 'loadDashboardDevices') {
    loadDashboardDevices(context, data.action, payload.token || '', Boolean(payload.force), Boolean(payload.quiet));
  } else if (command === 'dashboardCommand') {
    dashboardCommand(context, data.action, payload).catch(e => {
      errorLine('DASHBOARD_COMMAND_ERROR', e?.message || String(e));
      sendToPropertyInspector(context, { type:'dashboardCommandResult', ok:false, message:e?.message || 'Ошибка команды.' }, data.action);
    });
  } else if (command === 'validateToken') {
    const token = tokenForContext(context, payload.token || '');
    if (!token) {
      sendToPropertyInspector(context, { type: 'tokenStatus', valid: false, message: 'Токен не указан.' }, data.action);
    } else {
      getUserInfo(token, true)
        .then(info => {
          const devices = normalizeDevices(info);
          sendToPropertyInspector(context, {
            type: 'tokenStatus', valid: true,
            message: `Токен работает. Устройств: ${devices.length}`,
            tokenExpiry: tokenExpirySnapshot(token)
          }, data.action);
        })
        .catch(e => sendToPropertyInspector(context, {
          type: 'tokenStatus', valid: false, message: e?.message || 'Токен не прошёл проверку.'
        }, data.action));
    }
  }
});

scheduleActionRefresh();
const sensorHistoryTimer=setInterval(()=>{const token=String(globalSettings.token||'').trim();if(token)getUserInfo(token,true).catch(e=>errorLine('SENSOR_HISTORY_SAMPLE_ERROR',e?.message||String(e)));},5*60*1000);sensorHistoryTimer.unref?.();

ws.connect();
