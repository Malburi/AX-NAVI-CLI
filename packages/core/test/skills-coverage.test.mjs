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

const NL = String.fromCharCode(10);
// 끝의 구분자를 뗀다 — 소스의 REPO_ROOT 와 같은 모양이어야 치환 결과와 맞는다.
const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(new RegExp("[\\\\/]+$"), "");
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

/* ---------- 스크립트 경로 ---------- */

/*
 * 지시문은 모델에게 "스크립트 경로는 이미 절대경로로 치환돼 있다" 고 말한다.
 * 그런데 프롬프트 shim 은 agents/*.md 에만 걸렸고 스킬 본문은 "무수정"으로 실렸다.
 * 말과 실제가 달랐고, 그 결과 scaffold-feature 가 이렇게 보고했다(실측).
 *
 *   이 런타임에서 인덱싱 스크립트 경로를 확보하지 못해 갱신 못함
 *
 * CLI 에는 CLAUDE_PLUGIN_ROOT 가 없으므로 빈 문자열로 펼쳐지고,
 * node "/agents/lib/build-index.mjs" 가 되어 실패한다.
 */
test("스킬 본문의 플러그인 루트 참조가 실제 경로로 바뀐다", async () => {
  const { resolveSkillPaths } = await import("../../cli/src/commands.mjs");
  const body = [
    'node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --check-stale',
    "node $CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs symbol",
    "${CLAUDE_PLUGIN_ROOT}/agents/lib/validate-harness.mjs",
    "${env:CLAUDE_PLUGIN_ROOT}/agents/lib/ai-budget.mjs",
  ].join(NL);
  const out = resolveSkillPaths(body);
  assert.ok(!out.includes("CLAUDE_PLUGIN_ROOT"), `치환되지 않은 참조가 남았다: ${out}`);
  // 네 가지 표기 모두 같은 경로로 간다. 하나만 다루면 나머지가 조용히 샌다.
  assert.equal(out.split(REPO).length - 1, 4, "네 표기 중 일부만 바뀌었다");
});

test("스킬 본문을 넣는 자리마다 치환을 거친다", () => {
  /*
   * 주입 지점이 셋이다 — 에이전트 경로·오케스트레이터·절차 실행기.
   * 한 곳만 빼먹으면 그 경로의 스킬만 조용히 실패한다.
   */
  const src = readFileSync(join(REPO, "packages", "cli", "src", "commands.mjs"), "utf8");
  const wrapped = (src.match(/resolveSkillPaths\(skill\.body\)/g) ?? []).length;
  const raw = (src.match(/^\s+skill\.body,$/gm) ?? []).length;
  assert.equal(wrapped, 3, `치환을 거치는 주입 지점이 ${wrapped}곳 — 3곳이어야 한다`);
  assert.equal(raw, 0, "치환 없이 본문을 그대로 넣는 자리가 남았다");
});

test("위임 프로세스에 CLAUDE_PLUGIN_ROOT 를 채워 준다 — 두 번째 방어선", () => {
  const src = readFileSync(join(REPO, "packages", "provider-claude-cli", "src", "index.mjs"), "utf8");
  assert.match(src, /CLAUDE_PLUGIN_ROOT: this\.options\.pluginDir/);
});

/* ---------- 무응답과 스킵 ---------- */

/*
 * 실측 사고. 2026-09-15 실행에서 구성 질문에 답이 없었고, 스킬이 기본값을 적용한 뒤
 * 그것을 "사용자 확인 내용"으로 파일에 적었다. 일주일 뒤 실행은 그 파일이 있다는
 * 이유로 Phase -1 을 건너뛰었다 — 사용자는 단일/멀티레포를 한 번도 고른 적이 없는데
 * 그 선택에 묶였다. 한 번의 무응답이 되돌릴 수 없는 결정이 되면 안 된다.
 */
test("무응답을 '사용자 확인'으로 기록하지 말라고 알린다", () => {
  const src = readFileSync(join(REPO, "packages", "cli", "src", "mcp", "server.mjs"), "utf8");
  const at = src.indexOf("사용자가 응답하지 않았다");
  assert.ok(at > 0, "무응답 안내 자체가 없다");
  const block = src.slice(at, at + 400);
  assert.match(block, /확인했다.*기록하지 마라|기록하지 마라/, "무응답이 확인으로 굳는 것을 막지 않는다");
  assert.match(block, /다시 물어야/, "다음 실행에서 다시 묻게 하지 않는다");
});

test("스킵할 때 무엇을 재사용하는지 밝히라고 지시한다", () => {
  const src = readFileSync(join(REPO, "packages", "cli", "src", "commands.mjs"), "utf8");
  assert.match(src, /스킵 조건에 걸려 이전 결정을 재사용할 때는 화면에 밝혀라/);
  // 미확인 값이면 스킵하지 말고 다시 물어야 한다 — 이게 없으면 위 사고가 반복된다.
  assert.match(src, /unconfirmed.*기록돼 있으면 건너뛰지 말고/);
});

/* ---------- 백그라운드 서브에이전트 ---------- */

/*
 * 실측. 페어 하네스 초기화에서 서브에이전트 넷을 띄우고 27분 34초 · $14.31 을 쓴 뒤
 * 모델이 "백그라운드에서 돌고 있다 — 완료되면 이어서 진행하겠다"며 턴을 끝냈다.
 * 이 실행 경로에는 나중에 깨어날 방법이 없어서 파이프라인이 그 자리에서 죽었고,
 * 사용자는 확인할 수단도 없었다.
 *
 * 화면은 더 나빴다 — 우리가 턴 끝에 열린 블록을 닫으면서 "끝남"이라고 찍었다.
 * 모델은 돌고 있다고 하는데 화면은 끝났다고 한 것이다.
 */
test("서브에이전트 상태를 관측한 대로만 적는다", () => {
  /*
   * 두 번 틀렸다. 처음에는 열린 블록을 전부 "끝남"으로 닫았고(거짓 완료),
   * 그다음에는 전부 "결과를 못 받았다"로 닫았다 — 정상 완료한 21건이 전부
   * 경고로 찍혔다(실측). 비동기 에이전트에는 완료 이벤트가 없어 끝났는지는 알 수 없다.
   * 알 수 있는 것은 무엇을 냈는가뿐이고, 그것만 적는다.
   */
  const src = readFileSync(join(REPO, "packages", "cli", "src", "execute.mjs"), "utf8");
  assert.match(src, /closeSubagent = \(key, finished\)/, "종료 여부를 구분하지 않는다");
  assert.match(src, /produced/, "무엇을 냈는지 세지 않는다");
  assert.match(src, /마지막 출력/, "관측한 사실(마지막 출력 시각)을 안 적는다");
  assert.match(src, /출력 없이 턴이 끝났습니다/, "정말 조용한 경우를 구분하지 않는다");
  // 경고는 조용한 것에만. 늘 뜨는 경고는 경고가 아니다.
  assert.match(src, /const silent = open\.filter/, "경고를 열린 것 전부에 내고 있다");
});

test("결과를 받기 전에 턴을 끝내지 말라고 지시한다", () => {
  const src = readFileSync(join(REPO, "packages", "cli", "src", "commands.mjs"), "utf8");
  assert.match(src, /띄운 서브에이전트의 결과를 받기 전에 턴을 끝내지 마라/);
  assert.match(src, /TaskOutput/, "결과를 받을 수단을 안 알려 준다");
  // 정말 못 기다릴 때의 출구도 있어야 한다. 없으면 모델이 거짓 완료를 낸다.
  assert.match(src, /체크포인트 파일에 적고/);
});

test("서브에이전트가 많으면 닫는 줄을 한 줄로 갈무리한다", () => {
  /*
   * 비동기 에이전트는 완료 이벤트가 없어 전부 턴 끝에서 닫힌다. 스물 몇 개가
   * 열려 있으면 닫는 줄만 스물 몇 줄이 한꺼번에 쏟아져, 마지막에 읽어야 할
   * 요약을 밀어낸다(실측: 21줄이 쏟아진 뒤에야 결론이 나왔다).
   */
  const src = readFileSync(join(REPO, "packages", "cli", "src", "execute.mjs"), "utf8");
  assert.match(src, /ROSTER_MAX/, "갈무리 기준이 없다");
  assert.match(src, /출력 받음/, "몇 건이 일했는지 안 적는다");
});
