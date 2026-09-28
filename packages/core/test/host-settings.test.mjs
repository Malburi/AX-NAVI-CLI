/*
 * 위임 실행 관리 설정의 재료 검증 — 호스트 플러그인 끄기, 이름이 겹치는 계정 스킬 막기.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPlugins, pluginSkillNames } from "../../provider-agent-sdk/src/host-settings.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

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
 * SDK 는 선택 의존성이다 — 폐쇄망에서 설치 파일 하나로 옮기면 없을 수 있다. 없으면 claude -p 연결로 간다.
 * 실측: SDK 폴더를 치운 채 axnavi doctor 가 "claude-cli · 구독 인증"을, 되돌리면 "agent-sdk"를 보였다.
 */
test("SDK 설치 여부는 이 설치본의 node_modules 와 한 단계 위를 본다", async () => {
  const { sdkInstalled } = await import("../../cli/src/provider.mjs");
  assert.equal(sdkInstalled(REPO.replace(/[\/]+$/, "")), true, "개발 폴더에 설치된 SDK 를 못 찾았다");
  const empty = mkdtempSync(join(tmpdir(), "ax-nosdk-"));
  try {
    assert.equal(sdkInstalled(join(empty, "axnavi")), false, "없는데 있다고 했다");
    mkdirSync(join(empty, "@anthropic-ai", "claude-agent-sdk"), { recursive: true });
    writeFileSync(join(empty, "@anthropic-ai", "claude-agent-sdk", "package.json"), "{}");
    assert.equal(sdkInstalled(join(empty, "axnavi")), true, "끌어올려진 node_modules 의 SDK 를 못 찾았다");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/* 리뷰 실측: --omit=optional 설치에 API 키가 있으면 doctor 는 ✓ 인데 실행은 "sdk 가 없다" 로 죽었다. */
test("Messages API SDK 가 없으면 키가 있어도 anthropic 경로를 고르지 않는다", async () => {
  const { anthropicSdkInstalled } = await import("../../cli/src/provider.mjs");
  const empty = mkdtempSync(join(tmpdir(), "ax-noapisdk-"));
  try {
    assert.equal(anthropicSdkInstalled(join(empty, "axnavi")), false);
    mkdirSync(join(empty, "@anthropic-ai", "sdk"), { recursive: true });
    writeFileSync(join(empty, "@anthropic-ai", "sdk", "package.json"), "{}");
    assert.equal(anthropicSdkInstalled(join(empty, "axnavi")), true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const src = readFileSync(new URL("../../cli/src/provider.mjs", import.meta.url), "utf8");
  assert.match(src, /hasApiKey\(\) && anthropicSdkInstalled\(\)/, "auto 선택이 SDK 설치를 보지 않는다");
});

/*
 * 실측(2026-09-28, Bedrock PC): 위임 설정에 `Skill(anthropic-skills:harness-init)` 차단 규칙을 넣었더니
 * 자동 모드 판정기가 그 규칙을 "다른 도구로 같은 일을 하면 막아라" 는 지시와 함께 받아, axnavi 자신의
 * mcp__axnavi__Skill(name=harness-init) 까지 우회로 보고 막았다. "하네스 초기화 해줘" 가 첫 호출에서 거부됐다.
 *
 * 동기화 스킬은 내장 Skill 도구를 꺼서 막는다. 두 조건을 함께 고정한다 — 차단 규칙이 없어도 되는 이유가
 * 내장 Skill 도구가 꺼져 있다는 사실이기 때문이다.
 */
test("위임 설정에 스킬 차단 규칙을 넣지 않는다 — 판정기가 axnavi 자신의 스킬까지 막는다", async () => {
  const { selectProvider } = await import("../../cli/src/provider.mjs");
  const picked = selectProvider({ provider: "agent-sdk", cwd: REPO });
  if ("error" in picked) return; // SDK 없는 설치 — 이 경로 자체가 없다
  const settings = JSON.parse(/** @type {any} */ (picked.provider).options.settings ?? "{}");
  assert.equal(settings.permissions?.deny, undefined, `차단 규칙이 들어갔다: ${JSON.stringify(settings.permissions)}`);
});

test("내장 Skill 도구는 모든 경로에서 꺼져 있다 — 계정 동기화 스킬을 부를 수 없게", async () => {
  const { toDisallowedTools } = await import("../../provider-claude-cli/src/index.mjs");
  for (const delegation of [false, true]) {
    const tools = /** @type {any[]} */ ([{ name: "Read" }, { name: "Write" }, { name: "Bash" }]);
    const off = toDisallowedTools(tools, delegation);
    assert.ok(off.includes("Skill"), `위임 ${delegation} 에서 내장 Skill 도구가 열렸다`);
  }
});

/*
 * 실측(2026-09-28, Bedrock PC 최신판): "하네스 초기화 해줘" 가 또 막혔다 — 이번에는 우리가 넣은 차단 규칙이
 * 아니라 내장 도구를 `--disallowedTools` 로 끈 것 자체가 원인이었다. 끄기는 claude 안에서 출처 cliArg 의
 * 차단 규칙이 되고, 자동 모드 판정기는 그것을 "사용자 차단 규칙" 으로 받아 mcp__axnavi__Skill 을
 * 우회로 막았다. `--tools`(쓸 목록)로 좁힌 것은 출처 toolsNarrowing 이라 판정기 목록에서 빠진다.
 */
test("claude-cli 는 끌 목록이 아니라 쓸 목록으로 넘긴다 — 판정기가 우리 도구를 우회로 보지 않게", async () => {
  const { buildDelegatedArgs, toAllowedTools } = await import("../../provider-claude-cli/src/index.mjs");
  const tools = /** @type {any[]} */ ([{ name: "Read" }, { name: "Grep" }, { name: "Write" }]);
  const args = buildDelegatedArgs(/** @type {any} */ ({ tier: "standard", tools, allowDelegation: false }), {}, null);
  assert.ok(!args.includes("--disallowedTools"), "차단 규칙으로 끄면 판정기에 사용자 차단 규칙으로 넘어간다");
  const at = args.indexOf("--tools");
  assert.ok(at !== -1, "--tools 가 없다");
  const listed = args.slice(at + 1, at + 1 + toAllowedTools(tools, false).length);
  assert.deepEqual(listed, toAllowedTools(tools, false));
  assert.ok(!listed.includes("Skill") && !listed.includes("Edit"), "끄려던 도구가 쓸 목록에 들어갔다");
});

test("agent-sdk 도 tools 옵션으로 넘긴다 — disallowedTools 를 쓰지 않는다", () => {
  const src = readFileSync(new URL("../../provider-agent-sdk/src/index.mjs", import.meta.url), "utf8");
  assert.match(src, /tools: \[\.\.\.toAllowedTools\(spec\.tools, allowDelegation\), "AskUserQuestion"\]/);
  assert.ok(!/^\s*disallowedTools:/m.test(src), "disallowedTools 로 끄면 판정기가 우리 스킬 도구를 막는다");
});

test("쓸 목록과 끌 목록은 서로를 정확히 채운다 — 방식만 바뀌고 쓸 수 있는 도구는 같다", async () => {
  const { toAllowedTools, toDisallowedTools } = await import("../../provider-claude-cli/src/index.mjs");
  for (const [names, deleg] of /** @type {Array<[string[], boolean]>} */ ([[["Read", "Write"], false], [["Read", "Write", "Edit"], true]])) {
    const tools = /** @type {any[]} */ (names.map((name) => ({ name })));
    const on = toAllowedTools(tools, deleg);
    const off = toDisallowedTools(tools, deleg);
    assert.deepEqual(on.filter((n) => off.includes(n)), [], "켜고 끄는 목록이 겹친다");
    assert.ok(!on.includes("Skill"));
  }
});
