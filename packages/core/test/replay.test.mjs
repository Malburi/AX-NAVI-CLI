/*
 * 이어서 열 때 되살리는 대화 검증.
 *
 * 되살릴 내용을 우리가 따로 쌓는 이유는 위임 경로(claude CLI)가 대화를 그쪽에
 * 들고 있어 conversation.turns 가 비어 있기 때문이다 — 실제 저장된 세션을 열어
 * 확인했다. 그래서 여기서 보는 것은 "쌓는 규칙"과 "되살리는 모양" 둘이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendMessage } from "../src/context/sessions.mjs";
import { renderReplay, replayFrame } from "../../cli/src/replay.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
};

/** @param {Array<["user" | "assistant", string]>} pairs */
function log(pairs) {
  /** @type {import("../src/context/sessions.mjs").SessionMessage[]} */
  let messages = [];
  for (const [role, text] of pairs) messages = appendMessage(messages, role, text);
  return messages;
}

/* ---------- 쌓기 ---------- */

test("주고받은 말을 순서대로 쌓는다", () => {
  const messages = log([["user", "빌드 도구?"], ["assistant", "Ant"]]);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [["user", "빌드 도구?"], ["assistant", "Ant"]]);
});

test("빈 말은 쌓지 않는다 — 답이 비어 끝난 턴이 빈 줄로 남는다", () => {
  const messages = log([["user", "   "], ["assistant", ""]]);
  assert.equal(messages.length, 0);
});

test("오래된 것부터 떨어뜨려 세션 파일이 무한정 커지지 않는다", () => {
  /** @type {import("../src/context/sessions.mjs").SessionMessage[]} */
  let messages = [];
  for (let i = 0; i < 60; i += 1) messages = appendMessage(messages, "user", `질문 ${i}`);
  assert.equal(messages.length, 40);
  assert.match(/** @type {string} */ (messages[0]?.text), /질문 20/, "최근 것이 아니라 오래된 것이 남았다");
});

test("아주 긴 답은 잘라 두되 잘렸다는 걸 남긴다", () => {
  const messages = log([["assistant", "가".repeat(20_000)]]);
  const text = /** @type {string} */ (messages[0]?.text);
  assert.ok(text.length < 20_000);
  assert.match(text, /이하 생략/);
});

/* ---------- 되살리기 ---------- */

/** @param {Partial<Parameters<typeof renderReplay>[0]>} over */
const render = (over = {}) =>
  renderReplay({
    messages: log([["user", "빌드 도구?"], ["assistant", "Ant"]]),
    width: 100,
    ui: plainUi,
    ...over,
  });

test("사람 말과 답을 표시로 가른다 — 안 가르면 누가 한 말인지 모른다", () => {
  const lines = render();
  assert.ok(/** @type {string} */ (lines[0]).startsWith("›"), "사람 말에 표시가 없다");
  assert.ok(!(/** @type {string} */ (lines[1])).startsWith("›"), "답에도 같은 표시를 붙였다");
});

test("기록이 없으면 아무것도 그리지 않는다 — 빈 틀만 뜨면 혼란이다", () => {
  assert.deepEqual(renderReplay({ messages: [], width: 100, ui: plainUi }), []);
});

test("긴 답은 앞 몇 줄만 보이고 나머지는 줄 수로 알린다", () => {
  const long = Array.from({ length: 30 }, (_, i) => `줄 ${i}`).join("\n");
  const lines = render({ messages: log([["assistant", long]]) });
  assert.ok(lines.length < 12, `${lines.length}줄이나 그렸다`);
  assert.match(lines.join("\n"), /\+\d+줄/);
});

test("오래된 마디는 접고 몇 개를 접었는지 밝힌다", () => {
  const many = /** @type {Array<["user" | "assistant", string]>} */ (
    Array.from({ length: 20 }, (_, i) => [i % 2 ? "assistant" : "user", `말 ${i}`])
  );
  const lines = render({ messages: log(many), shown: 4 });
  assert.match(/** @type {string} */ (lines[0]), /앞선 16마디는 접었습니다/);
  assert.match(lines.join("\n"), /말 19/, "가장 최근 말이 빠졌다");
});

test("어떤 폭에서도 줄이 폭을 넘지 않는다 — 넘으면 접혀서 화면이 어긋난다", () => {
  const messages = log([
    ["user", "결제 승인 처리가 어디서 시작되고 어떤 트랜잭션 경계를 지나는지 알려줘"],
    ["assistant", "PaymentController.approve → PaymentService.doApprove → PaymentDao.update 순서입니다. ".repeat(5)],
  ]);
  for (const width of [30, 40, 80, 120, 200]) {
    for (const line of render({ messages, width })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}칸`);
    }
  }
});

/* ---------- 틀 ---------- */

test("틀이 무엇을 이어가는지 밝힌다", () => {
  const { head } = replayFrame({ title: "빌드 도구가 뭐야?", turns: 2, width: 100, ui: plainUi });
  assert.match(head, /이전 대화/);
  assert.match(head, /2턴/);
  assert.match(head, /빌드 도구가 뭐야\?/);
});

test("틀도 폭을 넘지 않는다", () => {
  for (const width of [30, 60, 120]) {
    const { head, tail } = replayFrame({ title: "아주 긴 제목 ".repeat(10), turns: 3, width, ui: plainUi });
    assert.ok(visibleLength(head) <= width, `머리말 ${visibleLength(head)}칸`);
    assert.ok(visibleLength(tail) <= width, `꼬리 ${visibleLength(tail)}칸`);
  }
});
