/*
 * 실행기(Claude Code 대화 화면을 axnavi 설정과 함께 띄우기) 검증.
 *
 * 대화 화면 자체는 Claude Code 것이라 여기서 시험하지 않는다. 우리가 붙이는 것 —
 * 인자·관리 설정·훅 — 이 약속대로인지만 본다. 실제 claude 로 확인한 사실은 각 테스트 주석에 적는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunch, hostPlugins, pluginSkillNames } from "../../launcher/src/launch.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const plan = () => buildLaunch({
  pluginRoot: "C:/axnavi", projectRoot: "C:/proj", node: "C:/Program Files/nodejs/node.exe",
  skillNames: ["generate-wiki", "harness-init"], mutePlugins: ["total-ito@total-ito"],
  settingsPath: "C:/t/settings.json", mcpPath: "C:/t/mcp.json", passthrough: ["--continue"],
});

test("고정한 플러그인·관리 설정·우리 MCP 만 붙이고, 나머지 인자는 그대로 넘긴다", () => {
  const { args } = plan();
  assert.deepEqual(args, ["--plugin-dir", "C:/axnavi", "--settings", "C:/t/settings.json", "--strict-mcp-config", "--mcp-config", "C:/t/mcp.json", "--continue"]);
});

test("관리 설정은 다른 플러그인을 끄고, 이름이 겹치는 계정 스킬을 막고, 인덱스 조회는 묻지 않는다", () => {
  const { settings } = plan();
  assert.deepEqual(settings.enabledPlugins, { "total-ito@total-ito": false });
  // 실측: 이 거부 규칙이 있으면 anthropic-skills:generate-wiki 호출이 "blocked by permission rules" 로 막힌다.
  assert.deepEqual(settings.permissions.deny, ["Skill(anthropic-skills:generate-wiki)", "Skill(anthropic-skills:harness-init)"]);
  // 실측: 허용 목록에 없으면 QueryIndex 를 부를 때마다 승인 창이 뜬다.
  assert.deepEqual(settings.permissions.allow, ["mcp__axnavi__QueryIndex"]);
  assert.equal(settings.hooks.PreToolUse[0]?.matcher, "Bash");
  assert.match(String(settings.hooks.PreToolUse[0]?.hooks[0]?.command), /^"C:\/Program Files\/nodejs\/node\.exe" ".*approve\.mjs"$/);
  assert.match(String(settings.hooks.PostToolUse[0]?.hooks[0]?.command), /audit\.mjs"$/);
});

test("인덱스 도구는 QueryIndex 하나만 내놓게 띄운다 — 질문·승인·스킬은 Claude Code 몫이다", () => {
  const server = plan().mcp.mcpServers.axnavi;
  assert.equal(server.env.AXNAVI_MCP_TOOLS, "QueryIndex");
  assert.equal(server.env.AXNAVI_PROJECT_ROOT, "C:/proj");
  assert.match(String(server.args[0]), /packages\/cli\/src\/mcp\/server\.mjs$/);
});

test("끌 플러그인은 설치 목록과 사용자 설정에서 켠 것을 모두 본다", () => {
  // 실측: wmux-orchestrator 는 사용자 설정에서 켜져 있지만 installed_plugins.json 에는 없었다.
  const home = mkdtempSync(join(tmpdir(), "ax-home-"));
  try {
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "total-ito@total-ito": [] } }));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "wmux-orchestrator@wmux": true, "off@x": false } }));
    assert.deepEqual(hostPlugins(home), ["total-ito@total-ito", "wmux-orchestrator@wmux"]);
    assert.deepEqual(hostPlugins(join(home, "없음")), [], "설정이 없어도 멈추지 않는다");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("스킬 이름은 이 설치본의 skills/ 에서 읽는다", () => {
  const names = pluginSkillNames(REPO);
  assert.ok(names.includes("harness-init") && names.includes("generate-wiki"), names.join(","));
});

/*
 * 실측: 훅이 있으면 axnavi 스크립트 실행이 묻지 않고 지나가고(거부 0), 없으면 claude -p 에서 거부된다(1).
 */
test("승인 훅은 읽기 전용 명령만 허용하고, 나머지는 아무 말 없이 Claude Code 승인 창에 넘긴다", () => {
  const hook = join(REPO, "packages", "launcher", "src", "hooks", "approve.mjs");
  const run = (/** @type {object} */ event) => spawnSync(process.execPath, [hook], { input: JSON.stringify(event), encoding: "utf8" }).stdout;
  const allowed = JSON.parse(run({ tool_name: "Bash", tool_input: { command: "git status --short && ls" } }));
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm -rf dist" } }), "", "쓰기 명령을 허용했다");
  assert.equal(run({ tool_name: "Bash", tool_input: { command: "echo hi > a.txt" } }), "", "리다이렉트를 허용했다");
  assert.equal(run({ tool_name: "Write", tool_input: { file_path: "a" } }), "", "셸 밖의 도구에 끼어들었다");
});

test("기록 훅은 실행된 도구를 프로젝트의 .axnavi/logs/audit.jsonl 에 남긴다", () => {
  const root = mkdtempSync(join(tmpdir(), "ax-audit-"));
  try {
    const hook = join(REPO, "packages", "launcher", "src", "hooks", "audit.mjs");
    spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: root, session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }), encoding: "utf8" });
    const line = JSON.parse(readFileSync(join(root, ".axnavi", "logs", "audit.jsonl"), "utf8").trim());
    assert.equal(line.tool, "Bash");
    assert.equal(line.session, "s1");
    assert.match(line.input, /ls/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

