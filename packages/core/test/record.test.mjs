/*
 * 되짚기의 토대 — 기록과 뷰어.
 *
 * 여기서 지킬 것은 하나다. **화면에 나간 것과 기록에 남은 것이 같아야 한다.**
 * 갈라지면 되짚기가 "봤던 것"을 못 보여 주고, 그건 기록으로서 실격이다.
 * 그래서 기록은 서식이 걸린 줄을 그대로 담고, 줄마다 주인을 붙인다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allTurns,
  closeTurn,
  linesOf,
  openTurn,
  recordAgentEnd,
  recordAgentStart,
  recordLine,
  resetRecord,
} from "../../cli/src/record.mjs";
import { bodyOf, buildRows, renderViewer } from "../../cli/src/viewer.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const ESC = String.fromCharCode(27);
const ui = {
  dim: (/** @type {string} */ s) => `${ESC}[2m${s}${ESC}[0m`,
  cyan: (/** @type {string} */ s) => `${ESC}[36m${s}${ESC}[0m`,
  bold: (/** @type {string} */ s) => `${ESC}[1m${s}${ESC}[0m`,
  green: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
  red: (/** @type {string} */ s) => s,
};

/** 서브에이전트 둘이 동시에 돈 한 턴을 만든다. 실제 위임 턴의 모양이다. */
function twoAgentTurn() {
  resetRecord();
  const turn = openTurn({ title: "하네스 초기화" });
  recordLine(turn, "시작한다");
  recordAgentStart(turn, "t1", "feature-finder");
  recordLine(turn, "● Task(feature-finder)", "t1");
  recordAgentStart(turn, "t2", "logic-tracer");
  recordLine(turn, "● Task(logic-tracer)", "t2");
  recordLine(turn, "│ 위치를 찾았다", "t1");
  recordLine(turn, "│ 흐름을 추적했다", "t2");
  recordLine(turn, "정리하면");
  recordAgentEnd(turn, "t1", 3);
  recordAgentEnd(turn, "t2", 5);
  closeTurn(turn, "done");
  return turn;
}

/* ---------- 기록 ---------- */

test("줄마다 주인이 붙는다 — 없으면 되짚어도 누가 한 말인지 모른다", () => {
  const turn = twoAgentTurn();
  assert.deepEqual(linesOf(turn, "t1"), ["● Task(feature-finder)", "│ 위치를 찾았다"]);
  assert.deepEqual(linesOf(turn, "t2"), ["● Task(logic-tracer)", "│ 흐름을 추적했다"]);
  // 주인 없는 줄 = 오케스트레이터 본인이 낸 것.
  assert.deepEqual(linesOf(turn), ["시작한다", "정리하면"]);
});

test("서로 얽혀 들어와도 갈라진다 — 동시에 도는 것이 정상이다", () => {
  const turn = twoAgentTurn();
  // 기록 순서 자체는 화면에 나간 순서 그대로여야 한다.
  assert.deepEqual(
    turn.lines.map((l) => l.owner ?? "-"),
    ["-", "t1", "t2", "t1", "t2", "-"],
  );
});

test("에이전트 블록에 걸린 시간과 도구 수가 남는다", () => {
  const turn = twoAgentTurn();
  const t2 = turn.agents.find((a) => a.id === "t2");
  assert.equal(t2?.tools, 5);
  assert.ok(t2?.endedAt, "닫히지 않았다 — 되짚기에서 영영 '도는 중'으로 보인다");
});

test("턴이 쌓여도 무한히 들고 있지 않는다", () => {
  resetRecord();
  for (let i = 0; i < 40; i += 1) closeTurn(openTurn({ title: `t${i}` }), "done");
  assert.ok(allTurns().length <= 20, `${allTurns().length}개나 들고 있다`);
  // 버리는 쪽은 오래된 것이어야 한다.
  assert.equal(allTurns().at(-1)?.title, "t39");
});

/* ---------- 뷰어 ---------- */

test("최신 턴이 위로 온다 — 되짚는 것은 대개 방금 것이다", () => {
  resetRecord();
  closeTurn(openTurn({ title: "예전 것" }), "done");
  closeTurn(openTurn({ title: "방금 것" }), "done");
  const rows = buildRows(allTurns(), new Set(), ui);
  assert.match(rows[0]?.text ?? "", /방금 것/);
});

test("접힌 턴은 자식을 펼치지 않는다 — 다 펴면 목록이 또 하나의 흘러가는 기록이 된다", () => {
  const turn = twoAgentTurn();
  const closed = buildRows(allTurns(), new Set(), ui);
  assert.equal(closed.length, 1, "접었는데 자식이 나왔다");
  const open = buildRows(allTurns(), new Set([turn.id]), ui);
  assert.ok(open.length > 1, "펼쳤는데 자식이 없다");
  assert.ok(open.some((r) => r.kind === "agent" && r.owner === "t1"));
  assert.ok(open.some((r) => r.kind === "agent" && r.owner === "t2"));
});

test("에이전트 행을 고르면 그 에이전트의 줄만 나온다", () => {
  const turn = twoAgentTurn();
  const rows = buildRows(allTurns(), new Set([turn.id]), ui);
  const row = rows.find((r) => r.kind === "agent" && r.owner === "t2");
  assert.ok(row);
  assert.deepEqual(bodyOf(row), ["● Task(logic-tracer)", "│ 흐름을 추적했다"]);
});

test("턴 행을 고르면 찍힌 차례 그대로 전부 나온다 — 순서가 곧 맥락이다", () => {
  const turn = twoAgentTurn();
  const rows = buildRows(allTurns(), new Set([turn.id]), ui);
  const row = /** @type {any} */ (rows[0]);
  assert.equal(bodyOf(row).length, turn.lines.length);
  assert.equal(bodyOf(row)[0], "시작한다");
});

test("화면 밖으로 넘치지 않는다 — 접히면 우리가 센 줄 수가 틀린다", () => {
  const turn = twoAgentTurn();
  for (let i = 0; i < 200; i += 1) recordLine(turn, `${"가".repeat(80)} ${i}`, "t1");
  const rows = buildRows(allTurns(), new Set([turn.id]), ui);
  const lines = renderViewer({
    rows, cursor: 0, body: bodyOf(/** @type {any} */ (rows[0])), bodyTop: 0,
    columns: 60, rowsHeight: 20, ui,
  });
  assert.ok(lines.length <= 20, `${lines.length}줄이나 그렸다`);
  for (const l of lines) assert.ok(visibleLength(l) <= 59, `줄이 폭을 넘었다: ${visibleLength(l)}`);
});

test("커서가 목록 안에 보인다 — 아래로 내려가도 창이 따라간다", () => {
  resetRecord();
  for (let i = 0; i < 30; i += 1) closeTurn(openTurn({ title: `턴 ${i}` }), "done");
  const rows = buildRows(allTurns(), new Set(), ui);
  const at = 25;
  const lines = renderViewer({ rows, cursor: at, body: [], bodyTop: 0, columns: 80, rowsHeight: 24, ui });
  const wanted = rows[at]?.text.replace(/\[\d+m/g, "") ?? "";
  assert.ok(
    lines.some((l) => l.replace(/\[\d+m/g, "").includes(wanted.slice(0, 20))),
    "고른 줄이 화면에 없다",
  );
});

test("본문이 길면 남은 줄 수를 알린다 — 없으면 여기가 끝인 줄 안다", () => {
  const body = Array.from({ length: 500 }, (_, i) => `줄 ${i}`);
  const lines = renderViewer({ rows: [], cursor: 0, body, bodyTop: 0, columns: 80, rowsHeight: 24, ui });
  assert.ok(lines.some((l) => l.includes("더 (PgDn)")), "더 있다는 표시가 없다");
});
