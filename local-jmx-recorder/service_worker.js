const DB_NAME = "local-jmx-recorder";
const DB_VERSION = 1;
const STORE = "requests";

const state = {
  recording: false,
  paused: false,
  tabId: null,
  startedAt: null,
  requestIds: new Map(),
  attached: false
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("startTime", "startTime", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAdd(item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetSession(sessionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("sessionId");
    const req = idx.getAll(sessionId);
    req.onsuccess = () => resolve(req.result.sort((a,b) => a.startTime - b.startTime));
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteSession(sessionId) {
  const db = await openDb();
  const rows = await dbGetSession(sessionId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const row of rows) store.delete(row.id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k] = String(v);
  return out;
}

async function redactHeaders(headers) {
  const settings = await chrome.storage.local.get({maskSecrets: true});
  if (!settings.maskSecrets) return headersToObject(headers);
  const sensitive = new Set([
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "x-auth-token", "x-access-token"
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = sensitive.has(k.toLowerCase()) ? "${REDACTED}" : v;
  }
  return out;
}

async function sendRuntime(message) {
  try { await chrome.runtime.sendMessage(message); } catch (_) {}
}

async function detach() {
  if (state.tabId !== null) {
    try { await chrome.debugger.detach({tabId: state.tabId}); } catch (_) {}
  }
  state.recording = false;
  state.paused = false;
  state.attached = false;
  state.tabId = null;
  state.requestIds.clear();
}

function isRecordableTab(tab) {
  return !!(tab?.id && /^https?:/i.test(tab.url || ""));
}

async function resolveTargetTab() {
  const meta = await chrome.storage.local.get("recorder");
  const preferredId = meta.recorder?.targetTabId;
  if (preferredId !== undefined && preferredId !== null) {
    try {
      const tab = await chrome.tabs.get(preferredId);
      if (isRecordableTab(tab)) return tab;
    } catch (_) {}
  }

  // In an undocked extension window, the focused window is the extension itself.
  // Prefer an active tab from a normal browser window instead.
  const wins = await chrome.windows.getAll({populate:true});
  const normal = wins.filter(w => w.type === "normal").sort((a,b) => Number(b.focused) - Number(a.focused));
  for (const win of normal) {
    const tab = (win.tabs || []).find(t => t.active && isRecordableTab(t));
    if (tab) return tab;
  }
  throw new Error("No HTTP/HTTPS web page found. Open the page you want to record first.");
}

async function startRecording(tabId) {
  if (state.recording) await detach();

  const sessionId = crypto.randomUUID();
  await chrome.storage.local.set({
    recorder: {
      recording: true,
      paused: false,
      sessionId,
      tabId,
      targetTabId: tabId,
      startedAt: Date.now()
    }
  });

  await chrome.debugger.attach({tabId}, "1.3");
  await chrome.debugger.sendCommand({tabId}, "Network.enable", {
    maxTotalBufferSize: 50 * 1024 * 1024,
    maxResourceBufferSize: 5 * 1024 * 1024,
    maxPostDataSize: 2 * 1024 * 1024
  });

  state.recording = true;
  state.paused = false;
  state.attached = true;
  state.tabId = tabId;
  state.startedAt = Date.now();
  state.sessionId = sessionId;
  state.requestIds.clear();

  await sendRuntime({type: "recording-state", recording: true, paused: false});
  return sessionId;
}

async function stopRecording() {
  const meta = await chrome.storage.local.get("recorder");
  if (state.tabId !== null) {
    try { await chrome.debugger.sendCommand({tabId: state.tabId}, "Network.disable"); } catch (_) {}
  }
  await detach();
  await chrome.storage.local.set({
    recorder: {
      recording: false,
      paused: false,
      sessionId: meta.recorder?.sessionId || state.sessionId || null,
      tabId: null,
      startedAt: meta.recorder?.startedAt || null
    }
  });
  await sendRuntime({type: "recording-state", recording: false});
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!state.recording || source.tabId !== state.tabId || state.paused) return;

  if (method === "Network.requestWillBeSent") {
    const r = params.request || {};
    const now = params.wallTime ? params.wallTime * 1000 : Date.now();
    const meta = await chrome.storage.local.get(["recorder","activeStepIndex"]);
    const item = {
      sessionId: meta.recorder?.sessionId || state.sessionId,
      requestId: params.requestId,
      stepIndex: Number(meta.activeStepIndex || 0),
      startTime: now,
      monotonicStartTime: typeof params.timestamp === "number" ? params.timestamp * 1000 : null,
      endTime: null,
      monotonicEndTime: null,
      url: r.url,
      method: r.method || "GET",
      requestHeaders: await redactHeaders(r.headers),
      postData: r.postData || "",
      hasPostData: !!r.hasPostData,
      responseStatus: null,
      responseStatusText: "",
      responseHeaders: {},
      mimeType: "",
      resourceType: params.type || "Other",
      initiator: params.initiator?.type || "",
      documentURL: params.documentURL || "",
      failed: false,
      errorText: "",
      responseBody: "",
      responseBodyBase64: false
    };
    state.requestIds.set(params.requestId, item);
    await dbAdd(item);
    await sendRuntime({type:"recording-progress", sessionId:item.sessionId, requestId:item.requestId});
  }

  if (method === "Network.responseReceived") {
    const item = state.requestIds.get(params.requestId);
    if (!item) return;
    item.responseStatus = params.response?.status ?? null;
    item.responseStatusText = params.response?.statusText || "";
    item.responseHeaders = await redactHeaders(headersToObject(params.response?.headers));
    item.mimeType = params.response?.mimeType || "";
    item.protocol = params.response?.protocol || "";
    item.fromCache = !!params.response?.fromDiskCache || !!params.response?.fromPrefetchCache;
    await replaceByRequestId(item);
  }

  if (method === "Network.loadingFailed") {
    const item = state.requestIds.get(params.requestId);
    if (!item) return;
    item.endTime = Date.now();
    item.monotonicEndTime = typeof params.timestamp === "number" ? params.timestamp * 1000 : null;
    item.failed = true;
    item.errorText = params.errorText || "";
    await replaceByRequestId(item);
    state.requestIds.delete(params.requestId);
  }

  if (method === "Network.loadingFinished") {
    const item = state.requestIds.get(params.requestId);
    if (!item) return;
    item.endTime = Date.now();
    item.monotonicEndTime = typeof params.timestamp === "number" ? params.timestamp * 1000 : null;

    const settings = await chrome.storage.local.get({captureResponseBodies: false});
    if (settings.captureResponseBodies) {
      try {
        const body = await chrome.debugger.sendCommand(
          {tabId: state.tabId},
          "Network.getResponseBody",
          {requestId: params.requestId}
        );
        item.responseBody = body.body || "";
        item.responseBodyBase64 = !!body.base64Encoded;
      } catch (_) {}
    }

    await replaceByRequestId(item);
    state.requestIds.delete(params.requestId);
  }
});

async function replaceByRequestId(item) {
  const db = await openDb();
  const rows = await dbGetSession(item.sessionId);
  const old = rows.find(x => x.requestId === item.requestId);
  if (!old) return;
  item.id = old.id;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

chrome.debugger.onDetach.addListener(async (source) => {
  if (source.tabId !== state.tabId) return;
  state.recording = false;
  state.paused = false;
  state.attached = false;
  state.requestIds.clear();
  await chrome.storage.local.set({recorder: {recording: false, paused: false, sessionId: state.sessionId || null, tabId: null, startedAt: state.startedAt || null}});
  await sendRuntime({type: "recording-state", recording: false, paused: false, reason: "detached"});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "start") {
        const tab = await resolveTargetTab();
        const sessionId = await startRecording(tab.id);
        sendResponse({ok: true, sessionId, tabId: tab.id, url: tab.url});
      } else if (msg.type === "stop") {
        await stopRecording();
        sendResponse({ok: true});
      } else if (msg.type === "pause") {
        if (!state.recording) throw new Error("Not currently recording.");
        state.paused = !state.paused;
        const meta = await chrome.storage.local.get("recorder");
        await chrome.storage.local.set({
          recorder: {
            ...(meta.recorder || {}),
            recording: true,
            paused: state.paused,
            sessionId: meta.recorder?.sessionId || state.sessionId || null,
            tabId: state.tabId
          }
        });
        if (state.paused) state.requestIds.clear();
        await sendRuntime({type:"recording-state", recording:true, paused:state.paused});
        sendResponse({ok:true, paused:state.paused});
      } else if (msg.type === "set-target-tab") {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!isRecordableTab(tab)) throw new Error("Select an HTTP/HTTPS page to record.");
        const meta = await chrome.storage.local.get("recorder");
        await chrome.storage.local.set({recorder:{...(meta.recorder || {}), targetTabId:tab.id}});
        sendResponse({ok:true, tabId:tab.id});
      } else if (msg.type === "get-state") {
        const meta = await chrome.storage.local.get("recorder");
        sendResponse({ok: true, recorder: meta.recorder || {recording:false, paused:false}});
      } else if (msg.type === "get-session") {
        const rows = await dbGetSession(msg.sessionId);
        sendResponse({ok: true, rows});
      } else if (msg.type === "delete-session") {
        await dbDeleteSession(msg.sessionId);
        sendResponse({ok: true});
      } else if (msg.type === "clear-all") {
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        sendResponse({ok: true});
      } else {
        sendResponse({ok:false, error:"Unknown message"});
      }
    } catch (e) {
      sendResponse({ok:false, error:e.message || String(e)});
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(async () => {
  const meta = await chrome.storage.local.get("recorder");
  if (meta.recorder?.recording) {
    await chrome.storage.local.set({recorder:{...meta.recorder, recording:false, tabId:null}});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    captureResponseBodies: false,
    recorder: {recording:false, paused:false, sessionId:null, tabId:null, startedAt:null}
  });
});