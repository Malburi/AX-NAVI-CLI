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
