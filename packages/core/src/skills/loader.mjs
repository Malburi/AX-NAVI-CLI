/*
 * 스킬 로더.
 *
 * 기존 skills/<name>/SKILL.md 24종을 무수정으로 읽는다. 두 가지를 해석해야 한다.
 *
 * 1) 별칭 스텁 — 7종(find/impact/modify/scaffold/sql/wiki/flow)은 8~11줄짜리 위임 스텁이라
 *    `Skill(skill="ax-navi:<대상>")` 한 줄이 본문의 전부다. CLI에서는 서브커맨드가 그 자리를
 *    대신하므로, 로더가 위임 대상을 풀어 실제 스킬을 가리키게 한다.
 *
 * 2) 담당 에이전트 — 본문에 `Agent(subagent_type="ax-navi:<이름>", ...)`로 적혀 있다.
 *    MVP에는 서브에이전트 팬아웃이 없으므로, 스킬이 지목한 에이전트 하나를 실행자로 쓴다.
 *    지목이 여러 개면 첫 번째를 쓰고 나머지는 경고로 남긴다 — 조용히 삼키지 않는다.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../agents/loader.mjs";

/**
 * @typedef {object} SkillDefinition
 * @property {string} name
 * @property {string} description
 * @property {string} body                 SKILL.md 본문 (무수정)
 * @property {string | null} delegatesTo    별칭 스텁이면 위임 대상 스킬 이름
 * @property {string[]} agents              본문이 지목한 에이전트 이름 (등장 순)
 * @property {string} sourcePath
 */

const AGENT_CALL = /subagent_type\s*=\s*["']ax-navi:([a-z0-9-]+)["']/gi;
/* 별칭이 위임을 적는 방식은 두 가지다. 하나만 보면 놓친다. */
const SKILL_DELEGATE = /Skill\s*\(\s*skill\s*=\s*["']ax-navi:([a-z0-9-]+)["']/i;
/* skills/wiki처럼 `Skill(...)` 예시 없이 산문으로만 위임하는 별칭이 있다. */
const PROSE_DELEGATE = /`ax-navi:([a-z0-9-]+)`(?:를|을)?\s*(?:호출|위임)/i;

/**
 * @param {string} skillsDir
 * @param {string} name
 * @returns {Promise<SkillDefinition>}
 */
export async function loadSkill(skillsDir, name) {
  const sourcePath = join(skillsDir, name, "SKILL.md");
  const text = await readFile(sourcePath, "utf8");
  const { data, body } = parseFrontmatter(text);

  /*
   * 별칭 판정. 명시적 `Skill(...)` 호출이 우선이고, 없으면 "별칭"이라고 밝힌 스킬에 한해
   * 산문 속 `ax-navi:<대상>` 참조를 위임으로 읽는다. 자기 자신을 가리키는 것은 제외한다.
   */
  const selfName = data["name"] || name;
  const declaresAlias = /별칭|alias/i.test(`${data["description"] ?? ""} ${body.slice(0, 400)}`);
  const delegateMatch =
    SKILL_DELEGATE.exec(body) ?? (declaresAlias ? PROSE_DELEGATE.exec(body) : null);
  const delegatesTo = delegateMatch?.[1] && delegateMatch[1] !== selfName ? delegateMatch[1] : null;
  /** @type {string[]} */
  const agents = [];
  AGENT_CALL.lastIndex = 0;
  for (let m = AGENT_CALL.exec(body); m; m = AGENT_CALL.exec(body)) {
    const agentName = m[1];
    if (agentName && !agents.includes(agentName)) agents.push(agentName);
  }

  return {
    name: selfName,
    description: data["description"] ?? "",
    body,
    delegatesTo,
    agents,
    sourcePath,
  };
}

/**
 * 별칭을 끝까지 따라가 실제 스킬을 돌려준다.
 * 순환이 있으면 무한 루프 대신 사유를 밝히고 멈춘다.
 * @param {string} skillsDir
 * @param {string} name
 * @returns {Promise<{ skill: SkillDefinition, via: string[] }>}
 */
export async function resolveSkill(skillsDir, name) {
  /** @type {string[]} */
  const via = [];
  let current = await loadSkill(skillsDir, name);
  while (current.delegatesTo) {
    if (via.includes(current.delegatesTo)) {
      throw new Error(`스킬 위임이 순환한다: ${[...via, current.delegatesTo].join(" → ")}`);
    }
    via.push(current.name);
    current = await loadSkill(skillsDir, current.delegatesTo);
  }
  return { skill: current, via };
}

/**
 * @param {string} skillsDir
 * @returns {Promise<SkillDefinition[]>}
 */
export async function loadAllSkills(skillsDir) {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name);
  const loaded = await Promise.all(names.map((n) => loadSkill(skillsDir, n)));
  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}
