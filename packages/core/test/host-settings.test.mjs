/*
 * 위임 실행 관리 설정의 재료 검증 — 호스트 플러그인 끄기, 이름이 겹치는 계정 스킬 막기.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
