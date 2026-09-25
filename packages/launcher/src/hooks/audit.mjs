/*
 * PostToolUse 훅 — 실행된 도구 호출을 프로젝트의 .axnavi/logs/audit.jsonl 에 한 줄씩 남긴다.
 *
 * axnavi 화면이 하던 기록을 Claude Code 화면에서도 이어 가기 위한 것이다. 기록에 실패해도
 * 작업을 막지 않는다 — 훅이 오류로 끝나면 사용자 화면에 경고가 뜨므로 조용히 끝낸다.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 2000;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(raw || "{}");
    const root = event.cwd || process.cwd();
    const input = JSON.stringify(event.tool_input ?? {});
    const line = {
      at: new Date().toISOString(),
      session: event.session_id ?? null,
      agent: event.agent_type ?? null,
      tool: event.tool_name ?? null,
      input: input.length > LIMIT ? `${input.slice(0, LIMIT)}…` : input,
      outcome: event.tool_response?.is_error || event.tool_response?.error ? "error" : "ok",
    };
    const dir = join(root, ".axnavi", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // 기록 실패로 작업을 멈추지 않는다.
  }
});
