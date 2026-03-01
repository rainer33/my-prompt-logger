// db.js 함수 사용을 위해 content script에서 background에 메시지로 저장 요청
// (IndexedDB는 background.js에서 관리)

let lastPrompt = "";
let isWaitingResponse = false;
let mutationTimer = null;
let lastResponseText = "";
let responseObserver = null;

// 현재 사이트 감지
function getSite() {
  const host = location.hostname;
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "chatgpt";
  if (host.includes("claude.ai")) return "claude";
  if (host.includes("gemini.google.com")) return "gemini";
  return "unknown";
}

// ✅ 프롬프트 전송 감지
function getPromptText() {
  const input = document.querySelector("#prompt-textarea");
  if (!input) return "";
  const text = input.value || input.textContent || input.innerText || "";
  return text.trim();
}

function startCaptureFromSubmit() {
  const promptText = getPromptText();
  if (!promptText || promptText === lastPrompt) return;

  lastPrompt = promptText;
  isWaitingResponse = true;
  lastResponseText = "";

  console.log("[PromptLogger] 프롬프트 감지:", promptText);
  observeResponse();
}

function observeSubmit() {
  document.addEventListener("click", (e) => {
    const sendBtn = e.target.closest('[data-testid="send-button"]');
    if (!sendBtn) return;
    startCaptureFromSubmit();
  });

  // Enter 전송(버튼 클릭 없이 제출) 대응
  document.addEventListener("keydown", (e) => {
    const isEnterSubmit =
      e.key === "Enter" &&
      !e.shiftKey &&
      e.target &&
      e.target.id === "prompt-textarea";
    if (!isEnterSubmit) return;
    // 입력값 반영 이후에 읽기 위해 다음 tick에서 캡처
    setTimeout(startCaptureFromSubmit, 0);
  });
}

// ✅ 응답 감지 (MutationObserver)
function observeResponse() {
  if (responseObserver) {
    responseObserver.disconnect();
  }

  responseObserver = new MutationObserver(() => {
    // 마지막 응답 메시지 가져오기
    const responses = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    if (responses.length === 0) return;

    const lastResponse = responses[responses.length - 1];
    const currentText = lastResponse.innerText.trim();

    if (currentText) {
      lastResponseText = currentText;
    }

    // 타이머 리셋 — 일정 시간 변화 없으면 출력 완료로 판단
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (!isWaitingResponse || !lastResponseText) return;

      isWaitingResponse = false;
      responseObserver.disconnect();
      responseObserver = null;

      console.log("[PromptLogger] 응답 완료, 저장 시작");

      // background.js에 저장 요청
      chrome.runtime.sendMessage({
        action: "SAVE_PROMPT",
        data: {
          site: getSite(),
          url: location.href,
          prompt: lastPrompt,
          response: lastResponseText,
        },
      }, (res) => {
        if (chrome.runtime.lastError) {
          console.error("[PromptLogger] 저장 메시지 실패:", chrome.runtime.lastError.message);
          return;
        }
        if (!res?.success) {
          console.error("[PromptLogger] 저장 실패:", res?.error || "unknown error");
        }
      });
    }, 2000); // 2초 동안 변화 없으면 완료
  });

  responseObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// ✅ 시작
observeSubmit();
