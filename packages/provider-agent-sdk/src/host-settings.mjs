/*
 * 위임 실행에 얹는 관리 설정의 재료 — 호스트 플러그인 끄기, 이름이 겹치는 계정 동기화 스킬 막기.
 *
 * axnavi 는 자기 설치본의 ax-navi 플러그인을 쓴다. 사용자가 따로 켠 플러그인·계정에서 동기화된
 * 같은 이름 스킬(예전 판)이 끼어들면 누가 돌려도 같은 결과라는 성질이 깨진다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 이 설치본의 스킬 이름. 계정에서 동기화된 같은 이름 스킬을 막는 데 쓴다.
 * 실측: claude.ai 에서 동기화된 generate-wiki·publish-wiki·wiki-hub 가 ax-navi 스킬과 이름이 같았다.
 * @param {string} pluginRoot
 */
export function pluginSkillNames(pluginRoot) {
  const dir = join(pluginRoot, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/**
 * 끌 호스트 플러그인. 설치 목록과 사용자 설정에서 켜 둔 것을 모두 본다.
 * 실측: wmux-orchestrator 는 사용자 설정에서 켜져 있지만 installed_plugins.json 에는 없었다.
 * @param {string} [home]
 */
export function hostPlugins(home = homedir()) {
  /** @type {Set<string>} */
  const names = new Set();
  const read = (/** @type {string} */ p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  for (const name of Object.keys(read(join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins ?? {})) names.add(name);
  for (const [name, on] of Object.entries(read(join(home, ".claude", "settings.json"))?.enabledPlugins ?? {})) if (on) names.add(name);
  return [...names].sort();
}
