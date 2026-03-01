let allPrompts = [];
let currentId = null;
let lastRenderedTotal = 0;

document.addEventListener("DOMContentLoaded", () => {
  bootstrap();

  document.getElementById("searchInput").addEventListener("input", renderList);
  document.getElementById("siteFilter").addEventListener("change", renderList);
  document.getElementById("btnExport").addEventListener("click", exportExcel);
  document.getElementById("btnClear").addEventListener("click", clearAll);
  document.getElementById("btnClose").addEventListener("click", closeModal);
  document.getElementById("btnModalDelete").addEventListener("click", () => deletePrompt(currentId));

  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modalOverlay")) closeModal();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "PROMPT_SAVED") {
      loadPrompts();
      loadDebugState();
    }
  });
});

function bootstrap() {
  runSyncNow(() => {
    loadPrompts();
    loadDebugState();
  });
}

function runSyncNow(callback) {
  chrome.runtime.sendMessage({ action: "RUN_SYNC_NOW" }, () => {
    if (callback) callback();
  });
}

function loadPrompts() {
  chrome.runtime.sendMessage({ action: "GET_ALL_PROMPTS" }, (res) => {
    if (!res?.success) return;
    allPrompts = res.data || [];
    renderList();
  });
}

function loadDebugState() {
  chrome.runtime.sendMessage({ action: "GET_DEBUG_STATE" }, (res) => {
    if (!res?.success) return;
    const d = res.data;
    const lastSaved = d.lastSavedAt ? `마지막저장 ${formatDate(d.lastSavedAt)}` : "마지막저장 없음";
    const configState = d.configValid ? "설정정상" : "설정오류";
    const localError = d.lastError ? ` | 로컬오류 ${d.lastError}` : "";
    const syncError = d.syncLastError ? ` | 동기화오류 ${d.syncLastError}` : "";
    const restoreError = d.lastRestoreError ? ` | 복원오류 ${d.lastRestoreError}` : "";
    const httpStatus = d.lastSyncHttpStatus ? ` | HTTP ${d.lastSyncHttpStatus}` : "";
    const remoteCount = Number.isFinite(d.remoteCount) && d.remoteCount >= 0 ? d.remoteCount : "?";
    const contentReady = `${d.contentReadyCount || 0}(${d.lastContentSite || "-"})`;
    const captureAttempts = d.captureAttempts || 0;

    document.getElementById("debugBar").textContent =
      `${configState} | 콘텐츠연결 ${contentReady} / 캡처시도 ${captureAttempts} | 저장시도 ${d.saveAttempts} / 성공 ${d.saveSuccess} / 실패 ${d.saveFail} / DB ${d.dbCount} | 동기화시도 ${d.syncAttempts} / 성공 ${d.syncSuccess} / 실패 ${d.syncFail} | 대기 ${d.pendingCount} / 실패누적 ${d.failedCount} / 원격복원 ${d.restoredFromRemote} / 원격행 ${remoteCount} | ${lastSaved}${localError}${syncError}${restoreError}${httpStatus}`;
  });
}

function renderList() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const site = document.getElementById("siteFilter").value;

  const filtered = allPrompts.filter((p) => {
    const matchSite = site === "all" || p.site === site;
    const matchSearch =
      (p.prompt || "").toLowerCase().includes(search) ||
      (p.response || "").toLowerCase().includes(search);
    return matchSite && matchSearch;
  });

  document.getElementById("countBar").textContent = `표시 ${filtered.length}개 / 전체 ${allPrompts.length}개`;

  const list = document.getElementById("list");

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">저장된 프롬프트가 없습니다</div>';
    return;
  }

  list.innerHTML = filtered
    .map(
      (p) => `
      <div class="card" data-id="${p.id}">
        <div class="card-header">
          <span class="site-badge ${p.site}">${p.site}</span>
          <span class="card-date">${formatDate(p.createdAt)}</span>
        </div>
        <div class="card-prompt">${escapeHtml(p.prompt || "")}</div>
        <div class="card-footer">
          <button class="btn-delete" data-id="${p.id}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");

  if (allPrompts.length !== lastRenderedTotal) {
    list.scrollTo({ top: 0, behavior: "smooth" });
    lastRenderedTotal = allPrompts.length;
  }

  list.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : e.target?.parentElement;
      if (target?.closest(".btn-delete")) return;
      const id = Number(card.dataset.id);
      if (!Number.isFinite(id)) return;
      openModal(id);
    });
  });

  list.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (!Number.isFinite(id)) return;
      deletePrompt(id);
    });
  });
}

function openModal(id) {
  const numericId = Number(id);
  const p = allPrompts.find((item) => Number(item.id) === numericId);
  if (!p) return;

  const modalPrompt = document.getElementById("modalPrompt");
  const modalResponse = document.getElementById("modalResponse");
  const modalOverlay = document.getElementById("modalOverlay");
  if (!modalPrompt || !modalResponse || !modalOverlay) return;

  currentId = numericId;
  modalPrompt.textContent = p.prompt || "";
  modalResponse.textContent = p.response || "";
  modalOverlay.classList.add("show");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
  currentId = null;
}

function deletePrompt(id) {
  if (!confirm("삭제하시겠습니까?")) return;
  chrome.runtime.sendMessage({ action: "DELETE_PROMPT", id }, (res) => {
    if (!res?.success) return;
    allPrompts = allPrompts.filter((p) => p.id !== id);
    closeModal();
    renderList();
    loadDebugState();
  });
}

function clearAll() {
  if (!confirm("전체 삭제하시겠습니까?")) return;
  chrome.runtime.sendMessage({ action: "CLEAR_ALL" }, (res) => {
    if (!res?.success) return;
    allPrompts = [];
    renderList();
    loadDebugState();
  });
}

function exportExcel() {
  if (allPrompts.length === 0) {
    alert("저장된 데이터가 없습니다.");
    return;
  }

  const headers = ["ID", "사이트", "날짜", "프롬프트", "응답", "프롬프트길이", "응답길이", "URL"];
  const rows = allPrompts.map((p) => [
    p.id,
    p.site,
    formatDate(p.createdAt),
    `"${(p.prompt || "").replace(/"/g, '""')}"`,
    `"${(p.response || "").replace(/"/g, '""')}"`,
    p.promptTokens,
    p.responseTokens,
    p.url,
  ]);

  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const bom = "\uFEFF";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `prompt-logger-${formatDateSimple(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateSimple(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
