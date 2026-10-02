/*
 * 리뷰 서브에이전트 한도 — 고친 뒤 평가가 서브에이전트를 이어 부르며 시간을 쓰지 않게 실행 쪽에서 막는다.
 *
 * 실측(v2 벤치, 대형 저장소 입력 길이 제한 수정): 마지막 수정 뒤 430초 중 약 300초가 평가 서브에이전트 셋
 * (change-safety → pattern-conformance → change-safety 재평가)이었다. 지침에서 패턴 대조 서브에이전트를 뺐는데도
 * 모델이 HOLD 사유를 보고 다시 불렀다. 지침은 지켜지지 않을 수 있어 여기서 센다.
 *
 * 세는 것은 평가 · 분석 역할(change-safety · pattern-conformance · impact-analyzer)뿐이다. 짝 저장소 수정을
 * 나눠 맡기는 general-purpose 같은 작업 서브에이전트는 세지 않는다.
 * 의존성 없음. claude -p 연결은 이 파일을 훅 명령으로 돌린다(맨 아래, 횟수는 임시 파일에 센다).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEW_AGENT = /^(?:ax-navi:)?(?:change-safety|pattern-conformance|impact-analyzer)$/;

export const REVIEW_LIMIT_MESSAGE = (/** @type {number} */ limit) =>
  `axnavi: 이 실행의 평가 서브에이전트 한도(${limit}번)를 다 썼다. 재평가 · 패턴 대조를 서브에이전트로 다시 부르지 말고, 이미 받은 평가와 직접 확인한 근거로 결정(GO/HOLD/STOP)을 내려라.`;

/**
 * @param {any} toolInput   Agent/Task 도구 입력
 * @param {{ limit: number, used: number }} state  호출부가 쥔 횟수(이 함수가 늘린다)
 */
export function reviewBudgetDecision(toolInput, state) {
  const type = typeof toolInput?.subagent_type === "string" ? toolInput.subagent_type : "";
  if (!REVIEW_AGENT.test(type)) return {};
  if (state.used >= state.limit) {
    return {
      hookSpecificOutput: {
        hookEventName: /** @type {const} */ ("PreToolUse"),
        permissionDecision: /** @type {const} */ ("deny"),
        permissionDecisionReason: REVIEW_LIMIT_MESSAGE(state.limit),
      },
    };
  }
  state.used += 1;
  return {};
}

/* 훅 명령으로 돌 때 — AXNAVI_REVIEW_LIMIT 이 있을 때만. 횟수는 AXNAVI_REVIEW_COUNTER 파일에 센다(실행마다 새 파일). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env["AXNAVI_REVIEW_LIMIT"] && process.env["AXNAVI_REVIEW_COUNTER"]) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    /** @type {any} */
    let event = {};
    try { event = JSON.parse(raw || "{}"); } catch { return; }
    const counter = /** @type {string} */ (process.env["AXNAVI_REVIEW_COUNTER"]);
    let used = 0;
    try { used = Number(readFileSync(counter, "utf8")) || 0; } catch { used = 0; }
    const state = { limit: Number(process.env["AXNAVI_REVIEW_LIMIT"]) || 0, used };
    const decision = reviewBudgetDecision(event.tool_input ?? {}, state);
    if (state.used !== used) { try { writeFileSync(counter, String(state.used)); } catch { /* 세지 못하면 막지 않는다 */ } }
    if (decision.hookSpecificOutput) process.stdout.write(JSON.stringify(decision));
  });
}
