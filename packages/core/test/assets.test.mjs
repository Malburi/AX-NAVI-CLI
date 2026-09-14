/*
 * 기존 자산이 무수정으로 로딩되는지 검증한다.
 *
 * 이 파일이 가장 값진 테스트다. 다른 테스트는 내가 방금 쓴 코드를 확인하지만,
 * 여기는 **실제 agents/*.md 19종과 skills/<name>/SKILL.md 24종**을 그대로 읽어
 * "플러그인 자산을 고치지 않고 쓴다"는 전환의 전제가 계속 참인지 고정한다.
 * 누군가 .md를 고쳐 계약이 깨지면 여기서 먼저 잡힌다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadAgent, loadAllAgents, applyPromptShim, parseFrontmatter } from "../src/agents/loader.mjs";
import { loadAllSkills, resolveSkill } from "../src/skills/loader.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const AGENTS = join(REPO, "agents");
const SKILLS = join(REPO, "skills");
const ENV = { pluginRoot: REPO, projectRoot: REPO };

test("에이전트 19종이 전부 로딩되고 name·description이 비지 않는다", async () => {
  const agents = await loadAllAgents(AGENTS, ENV);
  assert.equal(agents.length, 19, "에이전트 수");
  for (const a of agents) {
    assert.ok(a.name.length > 0, `${a.sourcePath}: name 비어 있음`);
    assert.ok(a.description.length > 20, `${a.name}: description이 너무 짧다`);
    assert.ok(a.systemPrompt.length > 100, `${a.name}: 본문이 너무 짧다`);
    assert.ok(["fast", "standard", "deep"].includes(a.tier), `${a.name}: tier=${a.tier}`);
  }
});

test("소스를 수정하지 않는 에이전트 13종은 Edit 계열을 선언하지 않는다 (role-contract와 같은 불변식)", async () => {
  const agents = await loadAllAgents(AGENTS, ENV);
  /*
   * 이 저장소의 실제 계약은 "쓰기 금지"가 아니라 "소스 수정 금지"다 —
   * 13종은 `tools: Read, Grep, Glob, Bash, Write`를 선언한다. Write가 들어 있는 이유는
   * 리포트를 _workspace/에 남겨야 하기 때문이고, 빠진 것은 Edit 계열이다.
   * agents/lib/tests/role-contract.test.mjs:87-96이 고정한 것과 같은 불변식이다.
   */
  const declared = agents.filter((a) => a.role.allowedTools);
  const standard = declared.filter((a) => {
    const set = new Set(a.role.allowedTools ?? []);
    return ["Read", "Grep", "Glob", "Bash", "Write"].every((t) => set.has(t));
  });
  assert.equal(standard.length, 13, `표준 도구 세트 선언: ${standard.map((a) => a.name).join(",")}`);

  for (const a of declared) {
    for (const forbidden of ["Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(!a.role.allowedTools?.includes(forbidden), `${a.name}: ${forbidden}이 들어 있다`);
    }
  }

  // spec-clarifier만 AskUserQuestion을 추가로 선언한다.
  const askers = declared.filter((a) => a.role.allowedTools?.includes("AskUserQuestion"));
  assert.deepEqual(askers.map((a) => a.name), ["spec-clarifier"]);
});
test("도구 이름이 Gateway 기본 도구와 맞아떨어진다 — 본문 수정이 필요 없는 근거", async () => {
  const agents = await loadAllAgents(AGENTS, ENV);
  const gatewayTools = new Set([
    "Read", "Grep", "Glob", "Bash", "Write", "QueryIndex", "AskUserQuestion", "TaskUpdate",
  ]);
  for (const a of agents) {
    for (const tool of a.role.allowedTools ?? []) {
      assert.ok(gatewayTools.has(tool), `${a.name}이 선언한 '${tool}'을 Gateway가 제공하지 않는다`);
    }
  }
});

test("프롬프트 shim이 CLAUDE_PLUGIN_ROOT를 남기지 않는다", async () => {
  const agents = await loadAllAgents(AGENTS, ENV);
  const leaked = agents.filter((a) => a.systemPrompt.includes("CLAUDE_PLUGIN_ROOT"));
  assert.equal(leaked.length, 0, `치환 안 된 에이전트: ${leaked.map((a) => a.name).join(",")}`);
});

test("shim은 호스트 전용 기능을 지우지 않고 안내로 무력화한다", () => {
  const body = "작업 상태는 TaskCreate로 만들고 Skill(skill=\"x\")로 넘긴다.";
  const { prompt, warnings } = applyPromptShim(body, { pluginRoot: "/p", projectRoot: "/r" });
  // 원문은 보존한다 — 지우면 에이전트가 무엇을 하려던 건지 알 수 없게 된다.
  assert.ok(prompt.includes("TaskCreate"), "원문이 사라졌다");
  assert.ok(prompt.includes("이 런타임에는"), "안내문이 없다");
  assert.ok(warnings.some((w) => w.includes("TaskCreate")), "경고가 없다");
});

test("analyzer.md는 690줄 규모인데 결합 지점만 바뀐다", async () => {
  const agent = await loadAgent(join(AGENTS, "analyzer.md"), ENV);
  assert.equal(agent.name, "analyzer");
  assert.equal(agent.tier, "standard", "frontmatter의 claude-sonnet-5가 standard로 정규화돼야 한다");
  assert.ok(agent.systemPrompt.includes("Phase A"), "본문 핵심 내용이 보존돼야 한다");
  assert.ok(!agent.systemPrompt.includes("$env:CLAUDE_PLUGIN_ROOT"), "경로가 치환돼야 한다");
});

test("스킬 24종 = 워크플로 17 + 별칭 7, 별칭은 전부 실제 스킬로 풀린다", async () => {
  const skills = await loadAllSkills(SKILLS);
  assert.equal(skills.length, 24, "전체 스킬 수");

  const aliases = skills.filter((s) => s.delegatesTo);
  assert.equal(aliases.length, 7, `별칭 수: ${aliases.map((a) => a.name).join(",")}`);

  const expected = {
    find: "find-feature",
    impact: "analyze-impact",
    modify: "safe-modify",
    scaffold: "scaffold-feature",
    sql: "review-sql",
    wiki: "generate-wiki",
    flow: "trace-logic",
  };
  for (const [alias, target] of Object.entries(expected)) {
    const { skill, via } = await resolveSkill(SKILLS, alias);
    assert.equal(skill.name, target, `/${alias} → ${target}`);
    assert.deepEqual(via, [alias], `${alias}의 위임 경로`);
  }
});

test("find-feature 스킬은 feature-finder를 지목한다 (MVP 실행 경로)", async () => {
  const { skill } = await resolveSkill(SKILLS, "find-feature");
  assert.ok(skill.agents.includes("feature-finder"), `지목된 에이전트: ${skill.agents.join(",")}`);
});

test("frontmatter 파서가 여러 줄 description을 이어 붙인다", () => {
  const { data, body } = parseFrontmatter(
    "---\nname: x\ndescription: 첫 줄\n  이어지는 줄\nmodel: sonnet\n---\n본문\n",
  );
  assert.equal(data["name"], "x");
  assert.equal(data["description"], "첫 줄 이어지는 줄");
  assert.equal(data["model"], "sonnet");
  assert.equal(body.trim(), "본문");
});

test("오케스트레이터 스킬이 정확히 구분된다", async () => {
  const skills = await loadAllSkills(SKILLS);
  const byName = new Map(skills.map((s) => [s.name, s]));

  /*
   * 이 구분이 실행 경로를 가른다. 오케스트레이터는 스킬 본문 자체가 지휘자의 지침이라
   * 특정 에이전트에게 넘기면 안 된다 — harness-init을 pipeline-runner에게 넘겼더니
   * 자기가 뭘 해야 하는지 몰랐다.
   */
  for (const name of ["harness-init", "safe-modify", "scaffold-feature", "pair-init",
                      "cross-repo-modify", "cross-repo-scaffold"]) {
    assert.equal(byName.get(name)?.isOrchestrator, true, `${name}은 오케스트레이터여야 한다`);
  }
  for (const name of ["find-feature", "trace-logic", "analyze-impact", "review-sql"]) {
    assert.equal(byName.get(name)?.isOrchestrator, false, `${name}은 단일 실행자여야 한다`);
  }
});
