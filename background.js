const DB_NAME = "PromptLogger";
const DB_VERSION = 2;
const STORE_NAME = "prompts";
const POPUP_PATH = "popup.html";
const POPUP_SIZE = { width: 1200, height: 860 };

const SUPABASE_CONFIG_KEY = "supabaseConfig";
const DEFAULT_SUPABASE_CONFIG = {
  url: "https://napkejnulxjorjavjnod.supabase.co",
  key: "sb_publishable_SsBYghF8TF8VoF8riSh3Dw_tBaE8PJj",
  table: "prompts",
};
const TABLE_NAME_FALLBACKS = [
  "prompt_logs",
  "prompt_logger",
  "promptlogger",
  "ai_prompts",
  "logs",
];
const SYNC_ALARM = "prompt-logger-sync";
const SYNC_INTERVAL_MINUTES = 2;
const MAX_SYNC_BATCH = 100;
const MAX_RETRY = 6;

let popupWindowId = null;
let writeQueue = Promise.resolve();
let syncInProgress = false;

const debugState = {
  saveAttempts: 0,
  saveSuccess: 0,
  saveFail: 0,
  lastError: "",
  lastSavedId: null,
  lastSavedAt: "",
  dbCount: 0,
  syncAttempts: 0,
  syncSuccess: 0,
  syncFail: 0,
  syncLastAt: "",
  syncLastError: "",
  lastSyncHttpStatus: 0,
  pendingCount: 0,
  failedCount: 0,
  restoredFromRemote: 0,
  configValid: false,
  lastRestoreAt: "",
  lastRestoreError: "",
  remoteCount: -1,
  contentReadyCount: 0,
  lastContentReadyAt: "",
  lastContentSite: "",
  captureAttempts: 0,
  lastCaptureReason: "",
  lastCapturePromptLen: 0,
};

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options);
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      let store;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
      } else {
        store = event.target.transaction.objectStore(STORE_NAME);
      }

      ensureIndex(store, "site", "site", { unique: false });
      ensureIndex(store, "createdAt", "createdAt", { unique: false });
      ensureIndex(store, "tags", "tags", { unique: false, multiEntry: true });
      ensureIndex(store, "hashKey", "hashKey", { unique: false });
      ensureIndex(store, "syncStatus", "syncStatus", { unique: false });
      ensureIndex(store, "nextRetryAt", "nextRetryAt", { unique: false });
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildHashKey(data) {
  const base = [
    data.site || "",
    data.url || "",
    data.prompt || "",
    data.response || "",
    data.createdAt || "",
  ].join("||");
  return sha256Hex(base);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function normalizePromptInput(data, createdAtOverride = null) {
  const createdAt = createdAtOverride || new Date().toISOString();
  const normalized = {
    eventId: crypto.randomUUID(),
    site: data.site || "unknown",
    url: data.url || "",
    prompt: data.prompt || "",
    response: data.response || "",
    promptTokens: Number(data.promptTokens ?? (data.prompt || "").length),
    responseTokens: Number(data.responseTokens ?? (data.response || "").length),
    createdAt,
    tags: Array.isArray(data.tags) ? data.tags : [],
    memo: data.memo || "",
    syncStatus: "PENDING",
    retryCount: Number(data.retryCount || 0),
    lastError: data.lastError || "",
    nextRetryAt: toIsoOrNull(data.nextRetryAt),
    syncedAt: toIsoOrNull(data.syncedAt),
  };

  if (normalized.syncedAt) {
    normalized.syncStatus = "SYNCED";
  }

  normalized.hashKey = data.hashKey || (await buildHashKey(normalized));
  return normalized;
}

async function getPromptCount() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  return idbRequest(store.count());
}

async function getAllPrompts() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const rows = await idbRequest(store.getAll());
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function savePromptLocal(data) {
  const normalized = await normalizePromptInput(data);
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const hashIndex = store.index("hashKey");
  const existing = await idbRequest(hashIndex.get(normalized.hashKey));

  if (existing) {
    return { id: existing.id, duplicate: true };
  }

  const id = await idbRequest(store.add(normalized));
  return { id, duplicate: false };
}

async function upsertFromRemote(row) {
  const createdAt = row.created_at || row.createdAt || new Date().toISOString();
  const normalized = await normalizePromptInput(
    {
      site: row.site,
      url: row.url,
      prompt: row.prompt,
      response: row.response,
      promptTokens: row.prompt_tokens ?? row.promptTokens,
      responseTokens: row.response_tokens ?? row.responseTokens,
      tags: row.tags,
      memo: row.memo,
      hashKey: row.hash_key,
      syncedAt: row.created_at || new Date().toISOString(),
    },
    createdAt
  );

  normalized.syncStatus = "SYNCED";
  normalized.retryCount = 0;
  normalized.lastError = "";
  normalized.nextRetryAt = null;

  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const hashIndex = store.index("hashKey");
  const existing = await idbRequest(hashIndex.get(normalized.hashKey));

  if (existing) return false;

  await idbRequest(store.add(normalized));
  return true;
}

async function updatePromptFields(id, patch) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const current = await idbRequest(store.get(id));
  if (!current) return false;
  await idbRequest(store.put({ ...current, ...patch }));
  return true;
}

async function deletePrompt(id) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await idbRequest(store.delete(id));
}

async function clearAllPrompts() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await idbRequest(store.clear());
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function getSupabaseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SUPABASE_CONFIG_KEY], (result) => {
      const config = result?.[SUPABASE_CONFIG_KEY] || null;
      resolve(config);
    });
  });
}

function normalizeSupabaseConfig(config, fallback = {}) {
  return {
    url: String(config?.url ?? fallback.url ?? "").trim().replace(/\/+$/, ""),
    key: String(config?.key ?? fallback.key ?? "").trim(),
    table: String(config?.table ?? fallback.table ?? "prompts").trim(),
  };
}

function setSupabaseConfig(config) {
  const normalized = normalizeSupabaseConfig(config);

  return new Promise((resolve) => {
    chrome.storage.local.set({ [SUPABASE_CONFIG_KEY]: normalized }, () => {
      resolve(normalized);
    });
  });
}

function isValidSupabaseConfig(config) {
  return Boolean(config?.url && config?.key && config?.table);
}

function parseSupabaseError(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function isMissingTableError(status, text) {
  if (status !== 404) return false;
  const parsed = parseSupabaseError(text);
  if (parsed?.code === "PGRST205") return true;
  return text.includes("Could not find the table");
}

function pickTableCandidates(paths, currentTable) {
  const tableNames = Object.keys(paths || {})
    .map((key) => key.replace(/^\/+/, ""))
    .filter((name) => name && !name.startsWith("rpc/"))
    .map((name) => name.split("?")[0]);

  const ordered = tableNames.sort((a, b) => {
    const aScore = a.toLowerCase().includes("prompt") ? 1 : 0;
    const bScore = b.toLowerCase().includes("prompt") ? 1 : 0;
    return bScore - aScore;
  });

  return ordered.filter((name, idx) => name !== currentTable && ordered.indexOf(name) === idx);
}

async function discoverReadableTable(config) {
  let candidates = [];
  try {
    const openApiResponse = await fetch(`${config.url}/rest/v1/`, {
      method: "GET",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Accept: "application/openapi+json",
      },
    });

    if (openApiResponse.ok) {
      const openApi = await openApiResponse.json();
      candidates = pickTableCandidates(openApi?.paths || {}, config.table);
    }
  } catch (_error) {
    // OpenAPI 접근이 막혀도 fallback 테이블 탐색은 계속 진행
  }

  const withFallbacks = [...candidates, ...TABLE_NAME_FALLBACKS].filter(
    (name, idx, arr) => name && name !== config.table && arr.indexOf(name) === idx
  );

  const readable = [];
  for (const table of withFallbacks) {
    const probe = await fetch(`${config.url}/rest/v1/${table}?select=*&limit=1`, {
      method: "GET",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
    });
    if (probe.ok) readable.push(table);
  }

  return readable;
}

async function recoverFromMissingTable(config) {
  try {
    const readable = await discoverReadableTable(config);
    if (readable.length === 0) return null;

    const nextConfig = { ...config, table: readable[0] };
    await setSupabaseConfig(nextConfig);
    debugState.configValid = true;
    debugState.lastRestoreError = `테이블 자동전환: ${config.table} -> ${nextConfig.table}`;
    return nextConfig;
  } catch (_error) {
    return null;
  }
}

async function getEffectiveSupabaseConfig() {
  const raw = await getSupabaseConfig();
  const normalized = normalizeSupabaseConfig(raw);
  if (isValidSupabaseConfig(normalized)) {
    debugState.configValid = true;
    return normalized;
  }

  const fallback = normalizeSupabaseConfig(raw, DEFAULT_SUPABASE_CONFIG);
  if (!isValidSupabaseConfig(fallback)) {
    debugState.configValid = false;
    return null;
  }

  const saved = await setSupabaseConfig(fallback);
  debugState.configValid = true;
  return saved;
}

function toSupabaseRow(prompt) {
  return {
    event_id: prompt.eventId,
    hash_key: prompt.hashKey,
    site: prompt.site,
    url: prompt.url,
    prompt: prompt.prompt,
    response: prompt.response,
    prompt_tokens: prompt.promptTokens,
    response_tokens: prompt.responseTokens,
    created_at: prompt.createdAt,
    tags: prompt.tags || [],
    memo: prompt.memo || "",
    source: "chrome-extension",
  };
}

function buildBackoffMinutes(retryCount) {
  const pow = Math.min(retryCount, 10);
  return Math.min(60, 2 ** pow);
}

async function getSyncCandidates(limit = MAX_SYNC_BATCH) {
  const now = new Date();
  const rows = await getAllPrompts();
  const pending = rows.filter((p) => {
    // v1 로컬 데이터(syncStatus 없음)도 업로드 대상으로 포함
    const status = p.syncStatus || "PENDING";
    if (status !== "PENDING") return false;
    if (!p.nextRetryAt) return true;
    return new Date(p.nextRetryAt) <= now;
  });
  return pending.slice(0, limit);
}

async function syncBatchToSupabase(batch, config) {
  if (batch.length === 0) return { success: true, count: 0 };

  debugState.syncAttempts += 1;

  const endpoint = `${config.url}/rest/v1/${config.table}?on_conflict=hash_key`;
  const payload = batch.map(toSupabaseRow);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    debugState.lastSyncHttpStatus = response.status;
    const txt = await response.text();
    throw new Error(txt || `HTTP ${response.status}`);
  }

  const nowIso = new Date().toISOString();
  for (const item of batch) {
    await updatePromptFields(item.id, {
      syncStatus: "SYNCED",
      syncedAt: nowIso,
      retryCount: 0,
      nextRetryAt: null,
      lastError: "",
    });
  }

  debugState.syncSuccess += 1;
  debugState.syncLastAt = nowIso;
  debugState.syncLastError = "";
  debugState.lastSyncHttpStatus = response.status;
  return { success: true, count: batch.length };
}

async function markBatchFailed(batch, errorMessage) {
  for (const item of batch) {
    const retry = Number(item.retryCount || 0) + 1;
    const status = retry >= MAX_RETRY ? "FAILED" : "PENDING";
    const nextRetry = status === "PENDING"
      ? new Date(Date.now() + buildBackoffMinutes(retry) * 60 * 1000).toISOString()
      : null;

    await updatePromptFields(item.id, {
      syncStatus: status,
      retryCount: retry,
      nextRetryAt: nextRetry,
      lastError: errorMessage,
    });
  }

  debugState.syncFail += 1;
  debugState.syncLastError = errorMessage;
}

async function refreshQueueMetrics() {
  const rows = await getAllPrompts();
  debugState.pendingCount = rows.filter((r) => r.syncStatus === "PENDING").length;
  debugState.failedCount = rows.filter((r) => r.syncStatus === "FAILED").length;
  debugState.dbCount = rows.length;
}

async function getRemotePromptCount(config) {
  const url = `${config.url}/rest/v1/${config.table}?select=id&limit=1`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });

  if (!response.ok) {
    debugState.lastSyncHttpStatus = response.status;
    const txt = await response.text();
    throw new Error(txt || `Count HTTP ${response.status}`);
  }

  debugState.lastSyncHttpStatus = response.status;
  const contentRange = response.headers.get("content-range") || "";
  const total = contentRange.split("/")[1];
  if (total && total !== "*") {
    const parsed = Number(total);
    debugState.remoteCount = Number.isFinite(parsed) ? parsed : -1;
  } else {
    debugState.remoteCount = -1;
  }
  return debugState.remoteCount;
}

async function restoreFromSupabase(config, force = false, retried = false) {
  const localCount = await getPromptCount();
  if (!force && localCount > 0) return 0;

  debugState.lastRestoreError = "";
  const url = `${config.url}/rest/v1/${config.table}?select=*&order=created_at.desc&limit=5000`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    debugState.lastSyncHttpStatus = response.status;
    const txt = await response.text();
    if (!retried && isMissingTableError(response.status, txt)) {
      const recoveredConfig = await recoverFromMissingTable(config);
      if (recoveredConfig) {
        return restoreFromSupabase(recoveredConfig, force, true);
      }
    }
    const message = txt || `Restore HTTP ${response.status}`;
    debugState.lastRestoreError = message;
    throw new Error(message);
  }

  const rows = await response.json();
  let restored = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const inserted = await upsertFromRemote(row);
    if (inserted) restored += 1;
  }

  debugState.restoredFromRemote = restored;
  debugState.lastRestoreAt = new Date().toISOString();
  debugState.lastSyncHttpStatus = response.status;
  return restored;
}

async function runSyncCycle() {
  if (syncInProgress) return;
  syncInProgress = true;

  try {
    const config = await getEffectiveSupabaseConfig();
    if (!config) {
      await refreshQueueMetrics();
      return;
    }

    try {
      await restoreFromSupabase(config);
    } catch (error) {
      debugState.syncFail += 1;
      debugState.syncLastError = error?.message || String(error);
      await refreshQueueMetrics();
      return;
    }

    const batch = await getSyncCandidates(MAX_SYNC_BATCH);
    if (batch.length === 0) {
      await refreshQueueMetrics();
      return;
    }

    try {
      await syncBatchToSupabase(batch, config);
    } catch (error) {
      await markBatchFailed(batch, error?.message || String(error));
    }

    await refreshQueueMetrics();
  } finally {
    syncInProgress = false;
  }
}

async function forceRestoreCycle() {
  const config = await getEffectiveSupabaseConfig();
  if (!config) return { restored: 0, configValid: false };
  const restored = await restoreFromSupabase(config, true);
  await refreshQueueMetrics();
  return { restored, configValid: true };
}

function getCenteredPosition(width, height) {
  return new Promise((resolve) => {
    chrome.windows.getCurrent((currentWindow) => {
      const left = Math.max(
        Math.round((currentWindow.left || 0) + ((currentWindow.width || width) - width) / 2),
        0
      );
      const top = Math.max(
        Math.round((currentWindow.top || 0) + ((currentWindow.height || height) - height) / 2),
        0
      );
      resolve({ left, top });
    });
  });
}

async function openOrFocusPopupWindow() {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, {
        focused: true,
        drawAttention: true,
        state: "normal",
      });
      return;
    } catch (_error) {
      popupWindowId = null;
    }
  }

  const url = chrome.runtime.getURL(POPUP_PATH);
  const { left, top } = await getCenteredPosition(POPUP_SIZE.width, POPUP_SIZE.height);

  const createdWindow = await chrome.windows.create({
    url,
    type: "popup",
    focused: true,
    width: POPUP_SIZE.width,
    height: POPUP_SIZE.height,
    left,
    top,
  });

  popupWindowId = createdWindow.id ?? null;
}

function ensureSyncAlarm() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSyncAlarm();
  getEffectiveSupabaseConfig().catch(() => {});
  runSyncCycle();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
  getEffectiveSupabaseConfig().catch(() => {});
  runSyncCycle();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    runSyncCycle();
  }
});

chrome.action.onClicked.addListener(() => {
  openOrFocusPopupWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "SAVE_PROMPT") {
    debugState.saveAttempts += 1;

    enqueueWrite(async () => {
      const result = await savePromptLocal(message.data || {});
      debugState.saveSuccess += 1;
      debugState.lastSavedId = result.id;
      debugState.lastSavedAt = new Date().toISOString();
      debugState.lastError = "";
      debugState.dbCount = await getPromptCount();

      // 저장 후 빠른 동기화를 위해 짧은 알람 재등록
      chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 0.1 });

      chrome.runtime.sendMessage({ action: "PROMPT_SAVED", id: result.id }, () => {
        if (chrome.runtime.lastError) {
          // popup이 없으면 무시
        }
      });

      sendResponse({ success: true, id: result.id, duplicate: result.duplicate });
    }).catch((err) => {
      debugState.saveFail += 1;
      debugState.lastError = err?.message || String(err);
      sendResponse({ success: false, error: debugState.lastError });
    });

    return true;
  }

  if (message.action === "CONTENT_SCRIPT_READY") {
    debugState.contentReadyCount += 1;
    debugState.lastContentReadyAt = new Date().toISOString();
    debugState.lastContentSite = message.site || "unknown";
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "CAPTURE_ATTEMPT") {
    debugState.captureAttempts += 1;
    debugState.lastCaptureReason = message.reason || "";
    debugState.lastCapturePromptLen = Number(message.promptLen || 0);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "GET_ALL_PROMPTS") {
    getAllPrompts()
      .then(async (rows) => {
        debugState.dbCount = rows.length;
        await refreshQueueMetrics();
        sendResponse({ success: true, data: rows });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "DELETE_PROMPT") {
    deletePrompt(message.id)
      .then(async () => {
        await refreshQueueMetrics();
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "CLEAR_ALL") {
    clearAllPrompts()
      .then(async () => {
        await refreshQueueMetrics();
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "SET_SUPABASE_CONFIG") {
    const incoming = normalizeSupabaseConfig(message.config || {}, DEFAULT_SUPABASE_CONFIG);
    setSupabaseConfig(incoming)
      .then((config) => {
        debugState.configValid = isValidSupabaseConfig(config);
        sendResponse({ success: true, config });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "RUN_SYNC_NOW") {
    runSyncCycle()
      .then(async () => {
        await refreshQueueMetrics();
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "FORCE_RESTORE") {
    forceRestoreCycle()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.action === "GET_DEBUG_STATE") {
    Promise.all([refreshQueueMetrics(), getEffectiveSupabaseConfig().catch(() => null)])
      .then(async ([, config]) => {
        if (config) {
          try {
            await getRemotePromptCount(config);
          } catch (error) {
            debugState.syncLastError = error?.message || String(error);
          }
        }
        sendResponse({ success: true, data: { ...debugState } });
      })
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  return false;
});
