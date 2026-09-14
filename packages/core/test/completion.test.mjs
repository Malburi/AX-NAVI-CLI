/*
 * 슬래시 명령·자동완성 검증.
 *
 * Tab 키 자체는 TTY에서만 동작해 여기서 눌러 볼 수 없다. 그래서 readline에 넘기는
 * completer 함수와 명령 레지스트리를 순수 함수로 떼어 두고 그쪽을 고정한다 —
 * 실제 skills/ 를 읽어 만들기 때문에 스킬이 추가·삭제되면 여기서 먼저 드러난다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadAllSkills } from "../src/skills/loader.mjs";
import { buildCommands, complete, renderCommandMenu } from "../../cli/src/completion.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = join(REPO, "skills");

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
};

test("명령 목록 = 내장 7종 + 스킬 24종", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const builtins = commands.filter((c) => c.kind === "builtin");
  const skills = commands.filter((c) => c.kind === "skill");
  assert.equal(builtins.length, 7);
  assert.equal(skills.length, 24, "스킬이 전부 슬래시 명령이 돼야 한다");
});

test("원래 플러그인의 단축 7종이 그대로 슬래시 명령으로 산다", async () => {
  const names = new Set(buildCommands(await loadAllSkills(SKILLS)).map((c) => c.name));
  for (const alias of ["modify", "impact", "scaffold", "find", "flow", "sql", "wiki"]) {
    assert.ok(names.has(alias), `/${alias} 가 없다`);
  }
});

test("`/` 만 치면 전체 목록이 후보로 나온다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits, prefix] = complete("/", { commands, agentNames: [] });
  assert.equal(prefix, "/");
  assert.equal(hits.length, commands.length);
  assert.ok(hits.includes("/help"));
  assert.ok(hits.includes("/modify"));
});

test("접두어로 좁혀진다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits] = complete("/sk", { commands, agentNames: [] });
  assert.deepEqual(hits.sort(), ["/skills"]);

  const [wiki] = complete("/wi", { commands, agentNames: [] });
  assert.deepEqual(wiki.sort(), ["/wiki", "/wiki-hub"]);
});

test("맞는 게 없으면 빈 목록 — 엉뚱한 걸 채워 넣지 않는다", async () => {
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const [hits] = complete("/zzz", { commands, agentNames: [] });
  assert.deepEqual(hits, []);
});

test("/agent 뒤에는 에이전트 이름이 완성된다", () => {
  const ctx = { commands: buildCommands([]), agentNames: ["analyzer", "api-bridge", "qa"] };
  const [hits, prefix] = complete("/agent a", ctx);
  assert.equal(prefix, "a", "치환 대상은 인자 부분이어야 한다");
  assert.deepEqual(hits.sort(), ["analyzer", "api-bridge"]);
});

test("/index 뒤에는 하위 명령이 완성된다", () => {
  const ctx = { commands: buildCommands([]), agentNames: [] };
  const [hits] = complete("/index b", ctx);
  assert.deepEqual(hits, ["build"]);
});

test("슬래시로 시작하지 않으면 완성하지 않는다 — 자연어 입력을 방해하지 않는다", () => {
  const ctx = { commands: buildCommands([]), agentNames: ["analyzer"] };
  const [hits] = complete("주문 취소 로직", ctx);
  assert.deepEqual(hits, []);
});

test("메뉴에 명령·단축·스킬이 모두 들어간다", async () => {
  const menu = renderCommandMenu(buildCommands(await loadAllSkills(SKILLS)), plainUi);
  assert.match(menu, /명령/);
  assert.match(menu, /단축/);
  assert.match(menu, /\/modify/);
  assert.match(menu, /\/harness-init/);
  assert.match(menu, /Tab 자동완성/);
  // 별칭은 스킬 목록에 중복해서 나오지 않아야 한다.
  assert.equal((menu.match(/\/modify/g) ?? []).length, 1);
});

test("모든 스킬이 비지 않은 요약을 갖는다", async () => {
  // safe-modify는 description이 따옴표로 시작한다 — 벗기지 않으면 요약이 빈다.
  const commands = buildCommands(await loadAllSkills(SKILLS));
  const empty = commands.filter((c) => c.kind === "skill" && c.summary.trim().length === 0);
  assert.deepEqual(empty.map((c) => c.name), [], "요약이 빈 스킬이 있다");
});
