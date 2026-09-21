/*
 * 스킬 24종 전수 점검.
 *
 * 왜 필요했나 — 스킬을 하나씩 손으로 돌려 보기 전까지 **6종이 실행조차 되지 않는다는
 * 것을 아무도 몰랐다.** 화면에는 "담당 에이전트를 지목하지 않는다" 한 줄만 나왔고,
 * 그건 사용자가 고칠 수 있는 말이 아니다.
 *
 * 그래서 여기서 24종 전부에 대해 **실행 경로가 정해져 있는지**를 고정한다.
 * 새 스킬이 들어오거나 frontmatter 가 바뀌어 경로가 사라지면 여기서 먼저 잡힌다.
 *
 * 이 파일은 LLM을 부르지 않는다. 실제 실행 품질은 여기서 보지 못한다 — 그건 사람이
 * 돌려 봐야 한다. 여기서 보는 것은 "부르면 무슨 일이든 일어나는가"다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadAllAgents, loadAllSkills, resolveSkill } from "../src/index.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = join(REPO, "skills");
const AGENTS = join(REPO, "agents");

const agents = await loadAllAgents(AGENTS, { pluginRoot: REPO, projectRoot: REPO });
const agentNames = new Set(agents.map((a) => a.name));
const skills = await loadAllSkills(SKILLS);

/*
 * 절차로 돌리면 안 되는 것들. commands.mjs 의 SPECIAL_SKILLS 와 짝이다.
 * 하나는 실행 모드로 옮겼고(vibe), 하나는 이 배포본에 없는 바이너리를 요구한다(wiki-hub).
 */
const SPECIAL = new Set(["vibe", "wiki-hub"]);

/**
 * runSkill 의 판정을 그대로 옮긴다. 여기서 갈라지면 테스트가 거짓말을 한다.
 * @param {import("@ax-navi/core").SkillDefinition} target
 * @returns {"오케스트레이터" | "에이전트" | "절차"}
 */
function pathOf(target) {
  if (target.isOrchestrator) return "오케스트레이터";
  if ((target.agents ?? [])[0]) return "에이전트";
  return "절차";
}

test("스킬이 24종 그대로다 — 수가 바뀌면 이 표를 다시 봐야 한다", () => {
  assert.equal(skills.length, 24, `스킬 ${skills.length}종`);
});

test("모든 스킬에 실행 경로가 있다", async () => {
  /** @type {string[]} */
  const orphans = [];
  for (const s of skills) {
    if (SPECIAL.has(s.name)) continue;
    const { skill: target } = await resolveSkill(SKILLS, s.name);
    if (SPECIAL.has(target.name)) continue;
    // 세 경로 중 하나로 반드시 떨어진다. "절차"가 생기기 전에는 여기서 6종이 죽었다.
    const path = pathOf(target);
    if (!["오케스트레이터", "에이전트", "절차"].includes(path)) orphans.push(s.name);
  }
  assert.deepEqual(orphans, [], `실행 경로 없는 스킬: ${orphans.join(", ")}`);
});

test("별칭 7종이 전부 본편으로 해석된다", async () => {
  const aliases = skills.filter((s) => s.delegatesTo);
  assert.equal(aliases.length, 7, `별칭 ${aliases.length}종 — 7종이어야 한다`);
  for (const a of aliases) {
    const { skill: target } = await resolveSkill(SKILLS, a.name);
    assert.notEqual(target.name, a.name, `${a.name} 이 자기 자신으로 끝났다`);
    assert.ok(
      skills.some((s) => s.name === target.name),
      `${a.name} → ${target.name} 인데 그런 스킬이 없다`,
    );
  }
});

test("스킬이 지목한 에이전트가 전부 존재한다", () => {
  /** @type {string[]} */
  const missing = [];
  for (const s of skills) {
    for (const a of s.agents ?? []) if (!agentNames.has(a)) missing.push(`${s.name} → ${a}`);
  }
  assert.deepEqual(missing, [], `없는 에이전트: ${missing.join(", ")}`);
});

test("본문이 가리키는 플러그인 파일이 전부 존재한다", () => {
  /** @type {string[]} */
  const missing = [];
  for (const s of skills) {
    const raw = readFileSync(join(SKILLS, s.name, "SKILL.md"), "utf8");
    for (const m of raw.matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?[\/\\]([\w\-.\/\\]+)/g)) {
      const rel = String(m[1]).replace(/\\/g, "/");
      if (!existsSync(join(REPO, rel))) missing.push(`${s.name} → ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `없는 파일: ${missing.join(", ")}`);
});

test("references 로 가리킨 문서가 어느 스킬에든 실제로 있다", () => {
  /*
   * 스킬이 **다른 스킬의** references 를 가리키는 경우가 실제로 있다
   * (pair-init 이 harness-init 의 split-repo.md 를 가리킨다). 폴더를 한정하지 않는다.
   */
  /** @type {string[]} */
  const missing = [];
  for (const s of skills) {
    const raw = readFileSync(join(SKILLS, s.name, "SKILL.md"), "utf8");
    for (const m of raw.matchAll(/`?references\/([\w\-.]+\.md)`?/g)) {
      const file = String(m[1]);
      const found = skills.some((k) => existsSync(join(SKILLS, k.name, "references", file)));
      if (!found) missing.push(`${s.name} → references/${file}`);
    }
  }
  assert.deepEqual(missing, [], `없는 참조 문서: ${missing.join(", ")}`);
});

test("특수 취급 스킬은 안내를 갖고 있다 — 조용히 실패하지 않는다", () => {
  const src = readFileSync(join(REPO, "packages", "cli", "src", "commands.mjs"), "utf8");
  for (const name of SPECIAL) {
    assert.ok(
      new RegExp(`["']?${name}["']?\\s*:`).test(src),
      `${name} 에 대한 안내가 commands.mjs 에 없다 — 부르면 엉뚱한 절차가 돈다`,
    );
  }
});
