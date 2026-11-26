import {
  ref,
  onValue,
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

// --- Application State ---
const state = {
  loadingDevices: true,
  rtdbError: '',
  devices: [],
  activeUid: '',
  rawUidNode: null,
  status: null,
  calllog: [],
  messages: [],
  contacts: [],
  apps: [],
  screen: 'home', // lock | home | phone | messages | contacts | apps | settings
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

function normalizeStatusNode(uid, uidNode) {
  const raw = uidNode?.status || uidNode || {};
  return {
    deviceName: raw.deviceName || raw.device_name || raw.name || raw.model || uid,
    model: raw.model || uidNode?.model || 'Android Device',
    osVersion: raw.osVersion || raw.os || raw.androidVersion || 'Android 15',
    batteryLevel: parseBatteryNumber(raw.batteryLevel ?? raw.battery ?? raw.batry ?? raw.level ?? 84),
    isCharging: Boolean(raw.isCharging ?? raw.charging ?? false),
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
    updatedAt: raw.updatedAt || Date.now(),
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
        state.devices = [];
      } else {
        state.devices = Object.entries(val)
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
  state.activeThreadPhone = null;
  state.expandedContactId = null;
  state.locked = false;
  state.screen = 'home';
  state.screenHistory = [];
  renderAll();

  const rtdb = getRtdb();
  state.deviceUnsub = onValue(
    ref(rtdb, deviceUid),
    (snapshot) => {
      const node = snapshot.val();
      state.rawUidNode = node;
      if (node && typeof node === 'object') {
        state.status = normalizeStatusNode(deviceUid, node);
        state.calllog = normalizeCallLog(node);
        state.messages = normalizeMessages(node);
        state.contacts = normalizeContacts(node);
        state.apps = normalizeApps(node);
      } else {
        state.status = null;
        state.calllog = [];
        state.messages = [];
        state.contacts = [];
        state.apps = [];
      }
      renderAll();
    },
    (error) => {
      handleRtdbError(error, OperationType.GET, `/${deviceUid}`);
      showErrorBanner(error.message || `Error listening to /${deviceUid}`);
    }
  );
}

// --- RTDB Mutation Helpers ---
async function updateDeviceStatusFields(fields) {
  if (!state.activeUid || !state.status) return;
  const rtdb = getRtdb();
  const path = `${state.activeUid}/status`;
  try {
    await update(ref(rtdb, path), {
      ...fields,
      updatedAt: Date.now(),
    });
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
  const path = `${state.activeUid}/${callKey}`;
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
  const path = `${state.activeUid}/${callKey}/${callId}`;
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
  const path = `${state.activeUid}/${msgKey}`;
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
    try {
      await update(ref(rtdb, `${state.activeUid}/${msgKey}/${m.id}`), { unread: false });
    } catch (err) {
      handleRtdbError(err, OperationType.UPDATE, `${state.activeUid}/${msgKey}/${m.id}`);
    }
  }
}

async function addContactEntry({ name, phoneNumber, email, company }) {
  if (!state.activeUid) return;
  const safeName = cleanText(name, 80);
  const safePhone = cleanText(phoneNumber, 32);
  if (!safeName || !safePhone) return;
  const contactKey = resolveCollectionKey(state.rawUidNode, ['contacts', 'contact'], 'contacts');
  const path = `${state.activeUid}/${contactKey}`;
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
  const path = `${state.activeUid}/${contactKey}/${contact.id}`;
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
  const path = `${state.activeUid}/${contactKey}/${contactId}`;
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
  const path = `${state.activeUid}/${appsKey}`;
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
  const path = `${state.activeUid}/${appsKey}/${appItem.id}`;
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
  const path = `${state.activeUid}/${appsKey}/${appItem.id}`;
  try {
    await remove(ref(getRtdb(), path));
    showPhoneToast('App Uninstalled', appItem.name);
  } catch (err) {
    handleRtdbError(err, OperationType.DELETE, path);
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
            <span class="text-emerald-400">/${esc(d.id)}</span> · ${esc(d.model)} · ${Math.round(d.batteryLevel)}%${d.isCharging ? ' (Charging)' : ''}
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
  if (shadeUid) shadeUid.textContent = state.activeUid ? `/${state.activeUid}/status` : 'uid: none';
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
  if (n.includes('system') || n.includes('setting')) return { bg: 'bg-slate-800 border border-emerald-500/30', label: 'SY' };
  return { bg: 'bg-slate-800 border border-emerald-500/25', label: (name || 'AP').slice(0, 2).toUpperCase() };
}

function launchAppByName(appName) {
  const n = (appName || '').toLowerCase();
  if (n.includes('phone') || n.includes('dialer')) return navigateTo('phone');
  if (n.includes('messag') || n.includes('sms')) return navigateTo('messages');
  if (n.includes('contact')) return navigateTo('contacts');
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
        <p class="text-xs font-mono-tabular text-slate-400 mt-1.5">${esc(state.activeUid)}/status</p>
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
              <p class="text-[11px] font-mono-tabular text-slate-400 truncate mt-0.5">${esc(state.activeUid)}/status</p>
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

      <div class="p-2 rounded-2xl bg-[#07130e]/90 border border-emerald-500/25 grid grid-cols-4 gap-1.5">
        <button type="button" data-nav="phone" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-emerald-600/80 border border-emerald-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">PH</span>
          <span class="text-[10px] text-slate-200 mt-1">Phone</span>
        </button>
        <button type="button" data-nav="messages" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-cyan-700/80 border border-cyan-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">MS</span>
          <span class="text-[10px] text-slate-200 mt-1">SMS${unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
        <button type="button" data-nav="contacts" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-teal-700/80 border border-teal-400/40 text-white text-[11px] font-mono-tabular font-bold flex items-center justify-center">CT</span>
          <span class="text-[10px] text-slate-200 mt-1">Contacts</span>
        </button>
        <button type="button" data-nav="apps" class="flex flex-col items-center justify-center py-2 rounded-xl hover:bg-emerald-500/10 cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-slate-800 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono-tabular font-bold flex items-center justify-center">AP</span>
          <span class="text-[10px] text-slate-200 mt-1">Apps</span>
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
        <div>
          <h2 class="text-sm font-bold text-white">Phone &amp; Call Log</h2>
          <p class="text-[11px] font-mono-tabular text-slate-400">${esc(state.activeUid)}/calllog · ${state.calllog.length} records</p>
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
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 class="text-sm font-bold text-white">Messages</h2>
          <p class="text-[11px] font-mono-tabular text-slate-400">${esc(state.activeUid)}/messages · ${threads.length} threads</p>
        </div>
        <button type="button" data-action="open-new-msg" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">
          + New
        </button>
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
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-sm font-bold text-white">Contacts</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400">${esc(state.activeUid)}/contacts · ${state.contacts.length} saved</p>
          </div>
          <button type="button" data-action="open-add-contact" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">+ Add</button>
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
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-sm font-bold text-white">App List</h2>
            <p class="text-[11px] font-mono-tabular text-slate-400">${esc(state.activeUid)}/apps · ${state.apps.length} installed</p>
          </div>
          <button type="button" data-action="open-install-app" class="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">+ Install</button>
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

function renderSettingsScreen() {
  const s = state.status;
  if (!s) {
    return `<div class="p-6 text-center text-xs text-slate-400">Loading ${esc(state.activeUid)}/status...</div>`;
  }

  const storagePct = Math.min(100, Math.round((s.storageUsedGb / Math.max(1, s.storageTotalGb)) * 100));
  const ramPct = Math.min(100, Math.round((s.ramUsedGb / Math.max(1, s.ramTotalGb)) * 100));
  const batt = Math.round(Number(s.batteryLevel) || 0);

  return `
    <div class="min-h-full bg-[#040a07] flex flex-col">
      <div class="sticky top-0 z-10 bg-[#040a07]/95 backdrop-blur-md px-4 py-3 border-b border-slate-800">
        <h2 class="text-sm font-bold text-white">System &amp; Battery</h2>
        <p class="text-[11px] font-mono-tabular text-slate-400">${esc(state.activeUid)}/status</p>
      </div>

      <div class="p-4 space-y-4">
        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-white">Battery Status</span>
            <span class="text-base font-bold font-mono-tabular ${s.isCharging ? 'text-emerald-400' : batt <= 20 ? 'text-amber-400' : 'text-white'}">${batt}%</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
            <div class="h-full ${s.isCharging ? 'bg-emerald-500' : batt <= 20 ? 'bg-amber-500' : 'bg-blue-500'}" style="width:${batt}%"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-400">
            <span>${s.isCharging ? 'Charging via USB-C' : 'Discharging'} · <span class="font-mono-tabular">${esc(s.temperatureC)}°C</span></span>
            <button type="button" data-action="phone-toggle-charging" class="text-blue-400 hover:text-blue-300 font-medium cursor-pointer">
              ${s.isCharging ? 'Unplug' : 'Plug In'}
            </button>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2.5">
          <p class="text-xs font-semibold text-white">Device Identity</p>
          <form id="form-phone-device-name" class="flex gap-2">
            <input
              name="deviceName"
              type="text"
              maxlength="64"
              value="${esc(s.deviceName)}"
              class="flex-1 h-9 px-2.5 text-xs bg-[#040a07] border border-slate-800 rounded-lg text-white"
            />
            <button type="submit" class="px-3 h-9 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer">Rename</button>
          </form>
          <div class="text-[11px] text-slate-400 space-y-1 pt-1">
            <div class="flex justify-between"><span>Model</span><span class="text-slate-200">${esc(s.model)}</span></div>
            <div class="flex justify-between"><span>OS Version</span><span class="text-slate-200 font-mono-tabular">${esc(s.osVersion)}</span></div>
            <div class="flex justify-between gap-3"><span>Device UID</span><span class="text-slate-200 font-mono-tabular truncate">${esc(state.activeUid)}</span></div>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-2">
          <p class="text-xs font-semibold text-white">Radio &amp; Connectivity</p>
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

        <div class="p-3.5 rounded-2xl bg-[#07130e] border border-emerald-500/20 space-y-3">
          <p class="text-xs font-semibold text-white">Storage &amp; Memory</p>
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

  const uidDisplay = state.activeUid || '{uid}';
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
  } else {
    pathEl.textContent = `${uidDisplay}/${tab}`;
    const listMap = {
      calllog: state.calllog,
      messages: state.messages,
      contacts: state.contacts,
      apps: state.apps,
    };
    jsonEl.textContent = state.activeUid
      ? JSON.stringify(listMap[tab] || [], null, 2)
      : 'Select a device UID to inspect Realtime Database nodes.';
  }
}

function renderAll() {
  renderViewStage();
  renderDeviceUidList();
  if (state.activeUid) {
    renderPhoneStatusBarAndShade();
    renderPhoneScreen();
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
      }
    });
  }
}

// --- Boot: Stage 1 (Device UID List First via Realtime Database) ---
wireStaticListeners();
updateClocks();
bootRtdbDirectory();
