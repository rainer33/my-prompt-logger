let allPrompts = [];
let currentId = null;
let lastRenderedTotal = 0;

// ✅ 초기 로드
document.addEventListener("DOMContentLoaded", () => {
  loadPrompts();

  document.getElementById("searchInput").addEventListener("input", renderList);
  document.getElementById("siteFilter").addEventListener("change", renderList);
  document.getElementById("btnExport").addEventListener("click", exportExcel);
  document.getElementById("btnClear").addEventListener("click", clearAll);
  document.getElementById("btnClose").addEventListener("click", closeModal);
  document.getElementById("btnModalDelete").addEventListener("click", () => {
    deletePrompt(currentId);
  });

  // 모달 외부 클릭시 닫기
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modalOverlay")) closeModal();
  });
});

// ✅ 전체 데이터 로드
function loadPrompts() {
  chrome.runtime.sendMessage({ action: "GET_ALL_PROMPTS" }, (res) => {
    if (res.success) {
      allPrompts = res.data;
      renderList();
      loadDebugState();
    }
  });
}

function loadDebugState() {
  chrome.runtime.sendMessage({ action: "GET_DEBUG_STATE" }, (res) => {
    if (!res?.success) return;
    const d = res.data;
    const lastSaved = d.lastSavedAt ? `마지막저장 ${formatDate(d.lastSavedAt)}` : "마지막저장 없음";
    const lastError = d.lastError ? ` | 오류 ${d.lastError}` : "";
    document.getElementById("debugBar").textContent =
      `저장시도 ${d.saveAttempts} / 성공 ${d.saveSuccess} / 실패 ${d.saveFail} / DB ${d.dbCount} | ${lastSaved}${lastError}`;
  });
}

// ✅ 리스트 렌더링
function renderList() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const site = document.getElementById("siteFilter").value;

  const filtered = allPrompts.filter((p) => {
    const matchSite = site === "all" || p.site === site;
    const matchSearch =
      p.prompt.toLowerCase().includes(search) ||
      p.response.toLowerCase().includes(search);
    return matchSite && matchSearch;
  });

  document.getElementById("countBar").textContent = `표시 ${filtered.length}개 / 전체 ${allPrompts.length}개`;

  const list = document.getElementById("list");

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">저장된 프롬프트가 없습니다</div>`;
    return;
  }

  list.innerHTML = filtered
    .map((p) => `
      <div class="card" data-id="${p.id}">
        <div class="card-header">
          <span class="site-badge ${p.site}">${p.site}</span>
          <span class="card-date">${formatDate(p.createdAt)}</span>
        </div>
        <div class="card-prompt">${escapeHtml(p.prompt)}</div>
        <div class="card-response">${escapeHtml(p.response)}</div>
        <div class="card-footer">
          <button class="btn-delete" data-id="${p.id}">삭제</button>
        </div>
      </div>
    `)
    .join("");

  // 데이터가 갱신되면 최신 항목이 보이도록 상단으로 자동 스크롤
  if (allPrompts.length !== lastRenderedTotal) {
    list.scrollTo({ top: 0, behavior: "smooth" });
    lastRenderedTotal = allPrompts.length;
  }

  // 카드 클릭 → 모달
  list.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", (e) => {
      // 삭제 버튼 클릭은 모달 안 열기
      if (e.target.classList.contains("btn-delete")) return;
      const id = parseInt(card.dataset.id);
      openModal(id);
    });
  });

  // 삭제 버튼
  list.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePrompt(parseInt(btn.dataset.id));
    });
  });
}

// ✅ 모달 열기
function openModal(id) {
  const p = allPrompts.find((p) => p.id === id);
  if (!p) return;

  currentId = id;
  document.getElementById("modalPrompt").textContent = p.prompt;
  document.getElementById("modalResponse").textContent = p.response;
  document.getElementById("modalOverlay").classList.add("show");
}

// ✅ 모달 닫기
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("show");
  currentId = null;
}

// ✅ 개별 삭제
function deletePrompt(id) {
  if (!confirm("삭제하시겠습니까?")) return;
  chrome.runtime.sendMessage({ action: "DELETE_PROMPT", id }, (res) => {
    if (res.success) {
      allPrompts = allPrompts.filter((p) => p.id !== id);
      closeModal();
      renderList();
      loadDebugState();
    }
  });
}

// ✅ 전체 삭제
function clearAll() {
  if (!confirm("전체 삭제하시겠습니까?")) return;
  chrome.runtime.sendMessage({ action: "CLEAR_ALL" }, (res) => {
    if (res.success) {
      allPrompts = [];
      renderList();
      loadDebugState();
    }
  });
}

// ✅ 엑셀 다운로드 (CSV)
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
    `"${p.prompt.replace(/"/g, '""')}"`,
    `"${p.response.replace(/"/g, '""')}"`,
    p.promptTokens,
    p.responseTokens,
    p.url,
  ]);

  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const bom = "\uFEFF"; // 한글 깨짐 방지
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `prompt-logger-${formatDateSimple(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ✅ 유틸
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
