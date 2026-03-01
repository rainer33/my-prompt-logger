// db.js의 함수들을 background에서 직접 사용
const DB_NAME = "PromptLogger";
const DB_VERSION = 1;
const STORE_NAME = "prompts";
const POPUP_PATH = "popup.html";
const POPUP_SIZE = {
  width: 1200,
  height: 860,
};

let popupWindowId = null;
const debugState = {
  saveAttempts: 0,
  saveSuccess: 0,
  saveFail: 0,
  lastError: "",
  lastSavedId: null,
  lastSavedAt: "",
  dbCount: 0,
};

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.createObjectStore(STORE_NAME, {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("site", "site", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
      store.createIndex("tags", "tags", { unique: false, multiEntry: true });
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function savePrompt(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.add({
      site: data.site,
      url: data.url,
      prompt: data.prompt,
      response: data.response,
      promptTokens: data.prompt.length,
      responseTokens: data.response.length,
      createdAt: new Date().toISOString(),
      tags: data.tags || [],
      memo: data.memo || "",
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllPrompts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result.reverse());
    request.onerror = () => reject(request.error);
  });
}

async function getPromptCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => reject(request.error);
  });
}

async function deletePrompt(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearAllPrompts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
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

chrome.action.onClicked.addListener(() => {
  openOrFocusPopupWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// ✅ content.js 에서 오는 메시지 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "SAVE_PROMPT") {
    debugState.saveAttempts += 1;
    savePrompt(message.data)
      .then((id) => {
        debugState.saveSuccess += 1;
        debugState.lastSavedId = id;
        debugState.lastSavedAt = new Date().toISOString();
        debugState.lastError = "";
        getPromptCount()
          .then((count) => {
            debugState.dbCount = count;
          })
          .catch(() => {});

        console.log("[PromptLogger] 저장 완료, id:", id);

        // popup이 열려 있으면 동기화 트리거용 이벤트 전달
        chrome.runtime.sendMessage({ action: "PROMPT_SAVED", id }, () => {
          if (chrome.runtime.lastError) {
            // popup이 닫혀 있으면 에러가 나지만 무시해도 됨
          }
        });

        sendResponse({ success: true, id });
      })
      .catch((err) => {
        debugState.saveFail += 1;
        debugState.lastError = err?.message || String(err);

        console.error("[PromptLogger] 저장 실패:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // 비동기 응답을 위해 필수
  }

  if (message.action === "GET_ALL_PROMPTS") {
    getAllPrompts()
      .then((data) => {
        debugState.dbCount = data.length;
        sendResponse({ success: true, data });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "GET_DEBUG_STATE") {
    sendResponse({
      success: true,
      data: {
        ...debugState,
      },
    });
    return false;
  }

  if (message.action === "DELETE_PROMPT") {
    deletePrompt(message.id)
      .then(async () => {
        try {
          debugState.dbCount = await getPromptCount();
        } catch (_error) {}
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "CLEAR_ALL") {
    clearAllPrompts()
      .then(() => {
        debugState.dbCount = 0;
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});
