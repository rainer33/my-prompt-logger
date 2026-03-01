// db.js의 함수들을 background에서 직접 사용
const DB_NAME = "PromptLogger";
const DB_VERSION = 1;
const STORE_NAME = "prompts";

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

// ✅ content.js 에서 오는 메시지 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "SAVE_PROMPT") {
    savePrompt(message.data)
      .then((id) => {
        console.log("[PromptLogger] 저장 완료, id:", id);
        sendResponse({ success: true, id });
      })
      .catch((err) => {
        console.error("[PromptLogger] 저장 실패:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // 비동기 응답을 위해 필수
  }

  if (message.action === "GET_ALL_PROMPTS") {
    getAllPrompts()
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "DELETE_PROMPT") {
    deletePrompt(message.id)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "CLEAR_ALL") {
    clearAllPrompts()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
})

