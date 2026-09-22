/*
 * 자유 입력 질문.
 *
 * 실측 사고: 페어 초기화가 P-PAIR 앞에서 "파트너 API base URL" 을 물었는데
 * 사용자가 이렇게 보고했다 — "이 상황에서 입력이 안 되. 엔터도 안 쳐지고".
 *
 * 원인은 이 경우만 REPL 의 줄 큐로 받았던 것이다. 턴이 도는 동안에는 readline 이
 * 물러나 있고 대신 들어선 typeahead 는 **화면에 글자를 찍지 않는다** — 친 글을
 * 바닥 판에 보여 주는 구조인데, 질문을 띄우려고 그 판을 걷어 낸 상태였다.
 * 그래서 선택지 질문과 같은 방식(키를 직접 받고 우리가 그린다)으로 맞췄다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { askText } from "../../cli/src/picker.mjs";

const ESC = String.fromCharCode(27);
const ui = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
};

/** 키를 보낼 수 있는 가짜 터미널. 화면에 쓰인 것을 그대로 모은다. */
function fakeTty() {
  const input = /** @type {any} */ (new EventEmitter());
  input.isRaw = false;
  input.setRawMode = (/** @type {boolean} */ v) => { input.isRaw = v; };
  /** @type {string[]} */
  const written = [];
  const output = /** @type {any} */ ({
    columns: 80,
    write: (/** @type {string} */ s) => { written.push(s); return true; },
  });
  /** @param {string} text */
  const type = (text) => {
    for (const ch of text) input.emit("keypress", ch, { name: ch });
  };
  /** @param {string} name */
  const press = (name) => input.emit("keypress", undefined, { name });
  return { input, output, written, type, press, screen: () => written.join("") };
}

test("친 글자가 화면에 보인다 — 이게 없으면 눈먼 타이핑이다", async () => {
  const t = fakeTty();
  const p = askText({ question: "API base URL 은?", input: t.input, output: t.output, ui });
  t.type("http://localhost:8080");
  assert.match(t.screen(), /http:\/\/localhost:8080/, "친 글자가 화면에 안 나왔다");
  t.press("return");
  assert.deepEqual(await p, ["http://localhost:8080"]);
});

test("Enter 가 답을 넘긴다", async () => {
  const t = fakeTty();
  const p = askText({ question: "값은?", input: t.input, output: t.output, ui });
  t.type("42");
  t.press("return");
  assert.deepEqual(await p, ["42"]);
});

test("Backspace 로 지운다", async () => {
  const t = fakeTty();
  const p = askText({ question: "값은?", input: t.input, output: t.output, ui });
  t.type("abc");
  t.press("backspace");
  t.press("return");
  assert.deepEqual(await p, ["ab"]);
});

test("ESC 는 이 질문만 건너뛴다 — 작업 전체 중단이 아니다", async () => {
  const t = fakeTty();
  let interrupted = false;
  const p = askText({
    question: "값은?", input: t.input, output: t.output, ui,
    onInterrupt: () => { interrupted = true; },
  });
  t.type("무시될 값");
  t.press("escape");
  assert.deepEqual(await p, [], "ESC 인데 답이 돌아왔다");
  assert.equal(interrupted, false, "ESC 가 턴 전체를 중단시켰다");
});

test("빈 답은 건너뛴 것으로 본다", async () => {
  const t = fakeTty();
  const p = askText({ question: "값은?", input: t.input, output: t.output, ui });
  t.press("return");
  assert.deepEqual(await p, []);
});

test("readline 의 키 처리를 뗐다가 그대로 되돌린다", async () => {
  const t = fakeTty();
  const mine = () => {};
  t.input.on("keypress", mine);
  const p = askText({ question: "값은?", input: t.input, output: t.output, ui });
  // 질문이 떠 있는 동안에는 우리 것만 듣는다 — 안 그러면 같은 키가 두 번 해석된다.
  assert.ok(!t.input.listeners("keypress").includes(mine), "기존 청취자를 안 뗐다");
  t.press("return");
  await p;
  assert.ok(t.input.listeners("keypress").includes(mine), "청취자를 안 돌려놨다");
  assert.equal(t.input.isRaw, false, "raw 모드를 안 돌려놨다");
});

test("커서를 숨겼다 되살린다", async () => {
  const t = fakeTty();
  const p = askText({ question: "값은?", input: t.input, output: t.output, ui });
  assert.ok(t.screen().includes(`${ESC}[?25l`), "커서를 안 숨겼다");
  t.press("return");
  await p;
  assert.ok(t.screen().includes(`${ESC}[?25h`), "커서를 안 되살렸다");
});
