/*
 * 턴이 도는 동안의 입력 처리 검증.
 *
 * 실측된 결함 — 작업 중에 방향키를 누르면 앞서 쓴 `/harness-init` 이 누를 때마다
 * 화면에 다시 찍혔다. readline 이 그대로 살아 있어서 위·아래는 히스토리를 불러내
 * 프롬프트를 다시 그리고, 좌·우도 입력 줄을 다시 그렸기 때문이다. 그 자리엔 이미
 * 스트리밍 출력이 흐르고 있으니 섞여 버린다.
 *
 * 그래서 턴 동안에는 readline 의 키 처리를 떼어 두고 우리가 직접 받는다.
 * 여기서 보는 것은 그 대체 처리가 "떼어 냈다 그대로 되돌리는가"와
 * "방향키를 정말 흘려보내는가"다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivity } from "../../cli/src/activity.mjs";
import { createTypeahead } from "../../cli/src/typeahead.mjs";

const ESC = String.fromCharCode(27);
const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
};

/** 실제 repl 이 쓰는 그 모듈을 그대로 불러 쓴다 — 복사해 두면 규칙이 갈라져도 모른다. */
function makeCapture() {
  /** @type {string[]} */
  const delivered = [];
  /** @type {string[]} */
  const interrupts = [];
  const t = createTypeahead({
    onLine: (line) => delivered.push(line),
    onInterrupt: (how) => interrupts.push(how),
  });
  return { onKey: t.handle, delivered, interrupts, text: t.text, take: t.take };
}

test("방향키는 흘려보낸다 — 이것이 화면을 어지르던 범인이다", () => {
  const c = makeCapture();
  for (const name of ["up", "down", "left", "right", "home", "end", "pageup"]) {
    c.onKey(undefined, { name });
  }
  assert.equal(c.text(), "", "방향키가 입력으로 들어갔다");
  assert.deepEqual(c.delivered, []);
});

test("친 글자는 모이고 Enter 에서 한 줄로 넘어간다", () => {
  const c = makeCapture();
  for (const ch of "/harness-init") c.onKey(ch, { name: ch });
  assert.equal(c.text(), "/harness-init");
  c.onKey(undefined, { name: "return" });
  assert.deepEqual(c.delivered, ["/harness-init"]);
  assert.equal(c.text(), "", "넘긴 뒤에도 남아 있다");
});

test("빈 줄은 넘기지 않는다 — 턴 끝나고 빈 입력이 실행되면 곤란하다", () => {
  const c = makeCapture();
  c.onKey(undefined, { name: "return" });
  c.onKey(" ", { name: "space" });
  c.onKey(undefined, { name: "return" });
  assert.deepEqual(c.delivered, []);
});

test("Backspace 는 지우고, 지울 게 없으면 아무 일도 없다", () => {
  const c = makeCapture();
  for (const ch of "abc") c.onKey(ch, { name: ch });
  for (let i = 0; i < 5; i += 1) c.onKey(undefined, { name: "backspace" });
  assert.equal(c.text(), "");
});

test("Ctrl+C 와 ESC 는 입력이 아니라 중단이다", () => {
  const c = makeCapture();
  c.onKey("\u0003", { name: "c", ctrl: true });
  c.onKey(undefined, { name: "escape" });
  assert.deepEqual(c.interrupts, ["Ctrl+C", "ESC"]);
  assert.equal(c.text(), "", "중단 키가 글자로 들어갔다");
});

test("한글도 그대로 모인다", () => {
  const c = makeCapture();
  for (const ch of "인덱스 갱신해줘") c.onKey(ch, { name: ch });
  assert.equal(c.text(), "인덱스 갱신해줘");
});

/* ---------- 상태 줄 표시 ---------- */

test("치는 중인 글이 상태 줄에 보인다 — 안 보이면 장님 타이핑이다", () => {
  /** @type {string[]} */
  const chunks = [];
  const out = /** @type {any} */ ({ isTTY: true, columns: 100, write: (/** @type {string} */ s) => chunks.push(s) });
  const activity = createActivity({ output: out, ui: plainUi });
  activity.start("harness-init");
  activity.set({ typing: "/index refresh" });
  assert.match(chunks.join(""), /⌨ \/index refresh/);
  activity.stop();
});

test("치는 중이 아니면 대기 건수를 보여 준다", () => {
  /** @type {string[]} */
  const chunks = [];
  const out = /** @type {any} */ ({ isTTY: true, columns: 100, write: (/** @type {string} */ s) => chunks.push(s) });
  const activity = createActivity({ output: out, ui: plainUi });
  activity.start("harness-init");
  activity.set({ typing: "", queued: 2 });
  const text = chunks.join("");
  assert.match(text, /⌨ 2건 대기/);
  assert.ok(!text.includes(`${ESC}[2K⌨ `), "빈 타이핑을 글로 찍었다");
  activity.stop();
});

test("턴이 끝날 때 치던 글은 버리지 않고 꺼내 준다", () => {
  const c = makeCapture();
  for (const ch of "/index") c.onKey(ch, { name: ch });
  assert.equal(c.take(), "/index", "치던 글이 사라졌다");
  assert.equal(c.text(), "", "꺼낸 뒤에도 남아 있다");
});

test("보이지 않는 제어 문자는 줄에 섞이지 않는다", () => {
  const c = makeCapture();
  c.onKey("", { name: "a", ctrl: true });
  c.onKey("", {});
  c.onKey("", {});
  assert.equal(c.text(), "", "제어 문자가 들어갔다 — DEL(0x7f)은 공백보다 커서 빠져나간다");
});
