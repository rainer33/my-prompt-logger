// db.js 함수 사용을 위해 content script에서 background에 메시지로 저장 요청
// (IndexedDB는 background.js에서 관리)

let isWaitingResponse = false;
let mutationTimer = null;
let responseObserver = null;
let activeCapture = null;
let captureSeq = 0;
let recentSubmit = {
  at: 0,
};
let pendingPromptRetry = null;

function isContextInvalidatedError(message) {
  return typeof message === "string" && message.includes("Extension context invalidated");
}

function safeSendMessage(payload, onSuccess) {
  // 확장 리로드/업데이트 직후 무효 컨텍스트면 즉시 중단
  if (!chrome?.runtime?.id) return;

  try {
    chrome.runtime.sendMessage(payload, (res) => {
      const lastErrorMessage = chrome.runtime?.lastError?.message || "";
      if (lastErrorMessage) {
        if (!isContextInvalidatedError(lastErrorMessage)) {
          console.error("[PromptLogger] 메시지 실패:", lastErrorMessage);
        }
        return;
      }

      if (onSuccess) onSuccess(res);
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (!isContextInvalidatedError(message)) {
      console.error("[PromptLogger] 메시지 예외:", message);
    }
  }
}

// 현재 사이트 감지
function getSite() {
  const host = location.hostname;
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "chatgpt";
  if (host.includes("claude.ai")) return "claude";
  if (host.includes("gemini.google.com")) return "gemini";
  return "unknown";
}

function queryNodes(candidates) {
  for (const selector of candidates) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > 0) return Array.from(nodes);
  }
  return [];
}

function getLatestText(nodes) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const text = (nodes[i].innerText || nodes[i].textContent || "").trim();
    if (text) return text;
  }
  return "";
}

// ✅ 프롬프트 전송 감지
function getPromptText() {
  const candidates = [
    "#prompt-textarea",
    "textarea[data-id]",
    "textarea",
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]',
  ];

  for (const selector of candidates) {
    const input = document.querySelector(selector);
    if (!input) continue;
    const text = input.value || input.textContent || input.innerText || "";
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }

  return "";
}

function getUserNodes() {
  return queryNodes([
    '[data-message-author-role="user"]',
    '[data-testid*="user"]',
    '[data-testid*="conversation-turn"][data-role="user"]',
    "main article",
  ]);
}

function getAssistantNodes() {
  return queryNodes([
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[data-testid*="conversation-turn"][data-role="assistant"]',
    "main article",
  ]);
}

function startCaptureFromSubmit(reason = "submit") {
  const promptText = getPromptText() || getLatestText(getUserNodes());
  if (!promptText) {
    if (pendingPromptRetry) {
      clearTimeout(pendingPromptRetry);
    }
    pendingPromptRetry = setTimeout(() => {
      pendingPromptRetry = null;
      startCaptureFromSubmit("retry");
    }, 200);
    return;
  }

  // 동일 이벤트(클릭 + submit + Enter) 중복 저장 방지
  const now = Date.now();
  if (now - recentSubmit.at < 700) {
    return;
  }
  recentSubmit = { at: now };

  const assistantNodes = getAssistantNodes();
  const captureId = ++captureSeq;
  activeCapture = {
    id: captureId,
    prompt: promptText,
    response: "",
    url: location.href,
    site: getSite(),
    assistantCountAtStart: assistantNodes.length,
    assistantLastTextAtStart: getLatestText(assistantNodes),
  };
  isWaitingResponse = true;
  safeSendMessage({
    action: "CAPTURE_ATTEMPT",
    site: activeCapture.site,
    reason,
    promptLen: promptText.length,
  });

  console.log("[PromptLogger] 프롬프트 감지:", promptText);
  observeResponse();

  // 응답 감지가 누락되더라도 저장 경로를 닫아두지 않기 위한 안전 타임아웃
  setTimeout(() => {
    if (!activeCapture || activeCapture.id !== captureId || !isWaitingResponse) return;
    finalizeCapture();
  }, 90000);
}

function isSendButtonTarget(target) {
  if (!target || !target.closest) return false;
  return Boolean(
    target.closest('[data-testid="send-button"]') ||
      target.closest('[data-testid*="composer-send"]') ||
      target.closest('button[data-testid*="send"]') ||
      target.closest('button[type="submit"]') ||
      target.closest('button[aria-label*="Send"]') ||
      target.closest('button[aria-label*="전송"]') ||
      target.closest('button[aria-label*="submit"]')
  );
}

function isComposerTarget(target) {
  if (!target) return false;
  if (target.matches && (target.matches("#prompt-textarea") || target.matches("textarea"))) return true;
  if (target.closest && target.closest('[contenteditable="true"]')) return true;
  return false;
}

function observeSubmit() {
  // 클릭 전 단계에서 먼저 감지해서 textarea가 비워지기 전에 읽는다.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!isSendButtonTarget(e.target)) return;
      startCaptureFromSubmit();
    },
    true
  );

  // 폼 submit 자체를 잡아 fallback으로 사용
  document.addEventListener(
    "submit",
    () => {
      setTimeout(startCaptureFromSubmit, 0);
    },
    true
  );

  // Enter 전송(버튼 클릭 없이 제출) 대응
  document.addEventListener("keydown", (e) => {
    const isEnterSubmit =
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.isComposing &&
      isComposerTarget(e.target);

    if (!isEnterSubmit) return;
    // 입력값 반영 이후에 읽기 위해 다음 tick에서 캡처
    setTimeout(startCaptureFromSubmit, 0);
  });
}

function updateResponseFromDom() {
  if (!activeCapture) return;

  const responses = getAssistantNodes();
  if (responses.length === 0) return;

  const currentText = getLatestText(responses);
  const hasNewAssistant =
    responses.length > activeCapture.assistantCountAtStart ||
    currentText !== activeCapture.assistantLastTextAtStart;

  if (hasNewAssistant && currentText) {
    activeCapture.response = currentText;
  }
}

// ✅ 응답 감지 (MutationObserver)
function observeResponse() {
  if (responseObserver) {
    responseObserver.disconnect();
  }

  responseObserver = new MutationObserver(() => {
    if (!activeCapture) return;

    updateResponseFromDom();

    // 타이머 리셋 — 일정 시간 변화 없으면 출력 완료로 판단
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (!isWaitingResponse) return;
      finalizeCapture();
    }, 2200); // 2.2초 동안 변화 없으면 완료
  });

  responseObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function finalizeCapture() {
  if (!activeCapture) return;
  const capture = activeCapture;

  isWaitingResponse = false;
  activeCapture = null;

  if (responseObserver) {
    responseObserver.disconnect();
    responseObserver = null;
  }
  clearTimeout(mutationTimer);

  // 마지막 시점에 한 번 더 DOM에서 응답 확보 시도
  const fallbackAssistantText = getLatestText(getAssistantNodes());
  if (!capture.response && fallbackAssistantText && fallbackAssistantText !== capture.assistantLastTextAtStart) {
    capture.response = fallbackAssistantText;
  }

  if (!capture.response) {
    capture.response = "(응답 감지 실패)";
  }

  console.log("[PromptLogger] 응답 완료, 저장 시작");

  // background.js에 저장 요청
  safeSendMessage(
    {
      action: "SAVE_PROMPT",
      data: {
        site: capture.site,
        url: capture.url,
        prompt: capture.prompt,
        response: capture.response,
      },
    },
    (res) => {
      if (!res?.success) {
        console.error("[PromptLogger] 저장 실패:", res?.error || "unknown error");
      }
    }
  );
}

// ✅ 시작
safeSendMessage({
  action: "CONTENT_SCRIPT_READY",
  site: getSite(),
  url: location.href,
});
observeSubmit();
