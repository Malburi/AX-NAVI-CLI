/*
 * Claude Code 플러그인 훅(packages/plugin/src/hooks.mjs) — 훅 JSON 을 stdin 으로 받아 규약대로 답한다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../plugin/src/hooks.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ax-plugin-hook-"));
mkdirSync(join(root, "src"), { recursive: true });
const sid = `t-${process.pid}-${Date.now()}`;
/** @param {string} sub @param {Record<string, unknown>} body */
const run = (sub, body) => {
  const out = execFileSync(process.execPath, [HOOK, sub], { input: JSON.stringify({ session_id: sid, cwd: root, ...body }), env: { ...process.env, AXNAVI_ENCODING_HOOK: "" } }).toString();
  return out ? JSON.parse(out) : null;
};

test("셸로 소스를 쓰면 묻고, 디스크 전체 검색은 막는다 — 읽기는 그대로", () => {
  assert.equal(run("pre-tool", { tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' src/A.java" } })?.hookSpecificOutput?.permissionDecision, "ask");
  assert.equal(run("pre-tool", { tool_name: "Bash", tool_input: { command: "find / -name x.jar" } })?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(run("pre-tool", { tool_name: "Bash", tool_input: { command: "grep -rn x src" } }), null);
  assert.equal(run("pre-tool", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "A.java") } }), null, "Edit 승인은 Claude Code 권한 모드에 맡긴다");
});

test("평가 서브에이전트는 요청마다 1번 — 새 요청이면 다시 센다", () => {
  run("prompt", { prompt: "고쳐줘" });
  assert.equal(run("pre-tool", { tool_name: "Agent", tool_input: { subagent_type: "ax-navi:change-safety" } }), null);
  assert.equal(run("pre-tool", { tool_name: "Agent", tool_input: { subagent_type: "ax-navi:change-safety" } })?.hookSpecificOutput?.permissionDecision, "deny");
  run("prompt", { prompt: "다른 것도 고쳐줘" });
  assert.equal(run("pre-tool", { tool_name: "Agent", tool_input: { subagent_type: "ax-navi:change-safety" } }), null);
});

test("axnavi CLI 가 띄운 실행에서는 비킨다", () => {
  const out = execFileSync(process.execPath, [HOOK, "pre-tool"], { input: JSON.stringify({ session_id: sid, cwd: root, tool_name: "Bash", tool_input: { command: "find / -name x" } }), env: { ...process.env, AXNAVI_ENCODING_HOOK: "1" } }).toString();
  assert.equal(out, "");
});

test("플러그인 훅 매니페스트가 모든 이벤트를 훅 스크립트에 잇는다", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../../hooks/hooks.json", import.meta.url)), "utf8"));
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]) assert.ok(JSON.stringify(manifest.hooks[ev]).includes("packages/plugin/src/hooks.mjs"), ev);
});
