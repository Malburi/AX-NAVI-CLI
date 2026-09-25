/*
 * PreToolUse 훅 — 묻지 않아도 되는 셸 명령만 허용하고, 나머지는 Claude Code 승인 창에 맡긴다.
 *
 * 판단은 axnavi 가 쓰던 analyzeBash 를 그대로 쓴다(읽기 전용 명령, axnavi 스크립트,
 * 복합 명령 조각별 판단). 확신이 없으면 아무것도 쓰지 않는다 — 그러면 Claude Code 가
 * 평소처럼 사람에게 묻는다. 이 훅은 "허용"만 하고 "거부"는 하지 않는다.
 */
import { analyzeBash } from "../../../cli/src/approval.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  /** @type {{ tool_name?: string, tool_input?: Record<string, unknown> }} */
  let event = {};
  try { event = JSON.parse(raw || "{}"); } catch { return; }
  if (event.tool_name !== "Bash") return;
  const command = typeof event.tool_input?.["command"] === "string" ? event.tool_input["command"] : "";
  if (!command) return;
  const verdict = analyzeBash(command, process.env["CLAUDE_PLUGIN_ROOT"] ?? "");
  if (!verdict.readOnly) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "axnavi: 읽기 전용 명령·axnavi 스크립트",
    },
  }));
});
