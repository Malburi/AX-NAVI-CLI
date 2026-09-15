/*
 * 실행 모드 검증.
 *
 * Claude Code 는 Shift+Tab 으로 normal / auto-accept / plan 을 돈다. 그중 auto-accept 는
 * 여기에 대응이 없다 — 우리 Gateway 에는 도구마다 사람에게 묻는 단계가 아예 없어서
 * 자동 수락할 대상이 없다. 그래서 실제로 강제할 수 있는 축으로만 만들었고,
 * 여기서 확인하는 것은 그 강제가 진짜인가다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODE, MODES, applyMode, modeOf, nextMode } from "../../cli/src/mode.mjs";
import { createDefaultRegistry } from "../src/tools/builtin/index.mjs";

/** @type {import("@ax-navi/core").AgentDefinition} */
const WRITER = {
  name: "writer",
  description: "쓰기가 필요한 역할",
  systemPrompt: "너는 writer 다.",
  tier: "standard",
  sourcePath: "(테스트)",
  warnings: [],
  role: { name: "writer", allowedTools: null, allowMutations: true },
};

/* ---------- 돌기 ---------- */

test("Shift+Tab 은 모드를 한 바퀴 돌고 제자리로 온다", () => {
  let id = DEFAULT_MODE;
  const seen = [id];
  for (let i = 0; i < MODES.length - 1; i += 1) {
    id = nextMode(id);
    seen.push(id);
  }
  assert.equal(new Set(seen).size, MODES.length, "같은 모드를 두 번 거쳤다");
  assert.equal(nextMode(id), DEFAULT_MODE, "한 바퀴 뒤 기본으로 안 돌아온다");
});

test("모르는 모드는 기본으로 떨어진다 — 빈 화면이 되지 않게", () => {
  assert.equal(modeOf("없는모드").id, DEFAULT_MODE);
});

/* ---------- 강제되는가 ---------- */

test("계획 모드는 쓰기 도구를 실제로 막는다 — 지침이 아니라 차단이다", () => {
  const registry = createDefaultRegistry();
  const before = registry.definitionsFor(WRITER.role).map((t) => t.name);
  assert.ok(before.includes("Write") && before.includes("Edit"), "기본 상태에서 쓰기가 있어야 비교가 된다");

  const locked = applyMode(WRITER, "plan");
  const after = registry.definitionsFor(locked.role).map((t) => t.name);
  for (const tool of ["Write", "Edit"]) {
    assert.ok(!after.includes(tool), `계획 모드인데 ${tool} 이 남았다`);
  }
  assert.ok(after.includes("Read") && after.includes("Grep"), "읽기까지 막으면 아무것도 못 한다");
});

test("계획 모드는 그 사실을 모델에게도 알린다 — 막힌 도구를 찾아 헤매지 않게", () => {
  assert.match(applyMode(WRITER, "plan").systemPrompt, /계획 모드/);
});

/* ---------- 지침에 그치는가 ---------- */

test("빠름은 도구를 건드리지 않는다 — 권한이 아니라 절차에 관한 것이다", () => {
  const registry = createDefaultRegistry();
  const before = registry.definitionsFor(WRITER.role).map((t) => t.name);
  const after = registry.definitionsFor(applyMode(WRITER, "vibe").role).map((t) => t.name);
  assert.deepEqual(after, before);
});

test("빠름이어도 위험한 변경은 멈추라고 적는다 — 검증 생략이지 무단 질주가 아니다", () => {
  const prompt = applyMode(WRITER, "vibe").systemPrompt;
  assert.match(prompt, /스키마 변경/);
  assert.match(prompt, /트랜잭션 경계/);
  assert.match(prompt, /3개 이상 파일/);
});

test("강제인지 지침인지를 모드 자신이 밝힌다 — 화면에서 갈라 적어야 한다", () => {
  assert.equal(modeOf("plan").enforced, true);
  assert.equal(modeOf("vibe").enforced, false);
});

/* ---------- 원본 보존 ---------- */

test("원본 정의를 고치지 않는다 — 같은 정의가 다음 턴에도 쓰인다", () => {
  applyMode(WRITER, "plan");
  applyMode(WRITER, "vibe");
  assert.equal(WRITER.role.allowMutations, true, "원본의 권한이 바뀌었다");
  assert.equal(WRITER.systemPrompt, "너는 writer 다.", "원본 지침이 오염됐다");
});

test("기본 모드는 아무것도 바꾸지 않는다", () => {
  assert.equal(applyMode(WRITER, DEFAULT_MODE), WRITER);
});

test("계획 모드는 Provider 에게도 알린다 — 도구를 빼는 것만으로는 계획이 안 나온다", () => {
  // claude CLI 는 이걸 받아 --permission-mode plan 을 넣는다. 그쪽은 막기만 하지 않고
  // 계획을 내놓고 승인을 기다린다(실측).
  assert.equal(applyMode(WRITER, "plan").planOnly, true);
  assert.equal(applyMode(WRITER, "vibe").planOnly, undefined);
  assert.equal(applyMode(WRITER, DEFAULT_MODE).planOnly, undefined);
});
