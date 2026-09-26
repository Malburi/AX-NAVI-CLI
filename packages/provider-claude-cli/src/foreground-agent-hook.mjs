/*
 * PreToolUse 훅 — 위임된 claude 가 서브에이전트를 뒤에서 돌리려 하면 포그라운드로 바꾼다.
 *
 * 왜 필요한지는 index.mjs 의 FOREGROUND_HOOK_SCRIPT 설명에 있다. 입력은 stdin 의
 * 훅 JSON 이고, 바꿀 것이 없으면 아무것도 쓰지 않고 끝낸다(그대로 진행).
 */
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  /** @type {{ tool_input?: Record<string, unknown> }} */
  let event = {};
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  const input = event.tool_input ?? {};
  // 값이 없으면 Claude 기본값(뒤에서 실행)을 따른다 — 명시적 false 만 그대로 둔다.
  if (input["run_in_background"] === false) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "axnavi: 이 실행에서는 서브에이전트를 포그라운드로 돌린다(뒤에서 돌면 대기 상한에 죽고 승인도 못 받는다)",
        updatedInput: { ...input, run_in_background: false },
      },
    }),
  );
});
