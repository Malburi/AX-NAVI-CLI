/*
 * 자동완성 메뉴 검증.
 *
 * 실측된 결함 — `/context` 를 타이핑하는 동안 메뉴가 화면에 쌓이고, 글자가
 * `/pontext`·`/coetext` 처럼 섞여 보였다. 둘 다 한 원인이었다.
 *
 * 커서 저장/복원(ESC 7 / ESC 8)은 화면의 **절대 행**을 기억한다. 메뉴를 화면
 * 밑쪽에서 그리면 터미널이 스크롤하고, 그 순간 저장해 둔 행이 한 칸씩 밀려
 * 복원이 엉뚱한 자리로 간다. 그 뒤로는 지우지도 못하고 이전 메뉴 위에 어긋나게
 * 덮어써서 글자가 섞인 것처럼 보인다.
 *
 * 그래서 전부 상대 이동으로 바꿨고, 여기서 **그린 줄 수와 되돌린 줄 수가 늘
 * 같은지**를 못 박는다. 그게 어긋나는 순간 같은 증상이 다시 난다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachAutocomplete, computeWindow } from "../../cli/src/autocomplete.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const ESC = String.fromCharCode(27);
const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
};

/** @param {number} columns */
function harness(columns = 100) {
  const input = /** @type {any} */ (new EventEmitter());
  /** @type {string[]} */
  const chunks = [];
  const output = /** @type {any} */ ({ columns, write: (/** @type {string} */ s) => chunks.push(s) });
  const rl = /** @type {any} */ ({
    line: "",
    cursor: 0,
    getPrompt: () => "> ",
    getCursorPos: () => ({ rows: 0, cols: 2 + rl.line.length }),
    write: () => {},
  });
  return {
    input, output, rl,
    text: () => chunks.join(""),
    reset: () => chunks.splice(0),
    /** @param {string} line */
    type(line) {
      rl.line = line;
      rl.cursor = line.length;
      input.emit("keypress", line.at(-1), { name: line.at(-1) });
    },
  };
}

/** 화면에 쓴 내용에서 아래로 내려간 줄 수와 위로 올라간 줄 수를 센다. */
function balance(/** @type {string} */ text) {
  let down = 0;
  let upTotal = 0;
  for (const part of text.split(ESC + "[")) {
    down += (part.match(/\n/g) ?? []).length;
    const m = /^(\d+)A/.exec(part);
    if (m) upTotal += Number(m[1]);
  }
  return { down, up: upTotal };
}

/**
 * 화면에 쓴 내용에서 "오른쪽으로 n칸" 이동만 개다.
 * 정규식을 안 쓰는 건 도구를 거치며 역슬래시가 먹히는 일이 잦기 때문이다.
 * @param {string} text
 * @returns {number[]}
 */
function cursorRightMoves(text) {
  /** @type {number[]} */
  const out = [];
  for (const part of text.split(ESC + "[").slice(1)) {
    const end = part.indexOf("C");
    if (end <= 0) continue;
    const digits = part.slice(0, end);
    if ([...digits].every((c) => c >= "0" && c <= "9")) out.push(Number(digits));
  }
  return out;
}

const ITEMS = [
  { value: "/context", hint: "진행 중인 대화 상태" },
  { value: "/cross-repo-modify", hint: "페어 연동된 백엔드·프론트엔드" },
  { value: "/cross-repo-scaffold", hint: "페어 연동된 백엔드+프론트엔드" },
];

test("창 계산은 고른 항목을 늘 안에 둔다", () => {
  const { start, end } = computeWindow(30, 25, 7);
  assert.ok(start <= 25 && 25 < end);
});

test("커서 저장·복원을 쓰지 않는다 — 스크롤하면 절대 행이 밀린다", async () => {
  const h = harness();
  attachAutocomplete({ rl: h.rl, input: h.input, output: h.output, source: () => ITEMS, ui: plainUi });
  h.type("/c");
  await new Promise((r) => setImmediate(r));

  const text = h.text();
  assert.ok(!text.includes(`${ESC}7`), "커서 저장(ESC 7)이 남아 있다");
  assert.ok(!text.includes(`${ESC}8`), "커서 복원(ESC 8)이 남아 있다");
  assert.ok(text.includes(`${ESC}[0J`), "아래를 지우지 않는다 — 이전 메뉴가 남는다");
});

test("내려간 줄 수와 올라온 줄 수가 같다 — 어긋나면 메뉴가 쌓인다", async () => {
  const h = harness();
  attachAutocomplete({ rl: h.rl, input: h.input, output: h.output, source: () => ITEMS, ui: plainUi });

  // 한 글자씩 치는 동안 매번 맞아야 한다. 한 번만 어긋나도 그 뒤로 계속 쌓인다.
  for (const partial of ["/c", "/co", "/con", "/cont", "/conte", "/contex", "/context"]) {
    h.reset();
    h.type(partial);
    await new Promise((r) => setImmediate(r));
    const { down, up } = balance(h.text());
    assert.equal(down, up, `'${partial}' 에서 내려간 ${down} / 올라온 ${up}`);
  }
});

test("메뉴 줄은 터미널 폭을 넘지 않는다 — 접히면 올라올 줄 수가 틀린다", async () => {
  const h = harness(40);
  attachAutocomplete({ rl: h.rl, input: h.input, output: h.output, source: () => ITEMS, ui: plainUi });
  h.type("/c");
  await new Promise((r) => setImmediate(r));

  for (const line of h.text().split(String.fromCharCode(10))) {
    const clean = line.split(ESC + "[")[0] ?? "";
    assert.ok(visibleLength(clean) < 40, `${visibleLength(clean)}칸`);
  }
});

test("슬래시로 시작하지 않으면 메뉴를 닫는다", async () => {
  const h = harness();
  const menu = attachAutocomplete({ rl: h.rl, input: h.input, output: h.output, source: () => ITEMS, ui: plainUi });
  h.type("/c");
  await new Promise((r) => setImmediate(r));
  h.reset();
  h.type("안녕");
  await new Promise((r) => setImmediate(r));

  const { down, up } = balance(h.text());
  assert.equal(down, up, "닫으면서 줄 수가 어긋났다");
  assert.ok(!h.text().includes("/context"), "닫았는데 메뉴를 또 그렸다");
  menu.dispose();
});

/*
 * 실측된 결함 — `AX-NAVI > ` 에 /find 를 치면 `AX-find> /` 가 됐다.
 *
 * 프롬프트를 직접 찍고 readline 에게 알리지 않으면 getCursorPos() 가 프롬프트 폭을
 * 빼고 돌려준다. 그 값으로 커서를 되돌리면 프롬프트 안쪽으로 들어가 글자를 덮어쓴다.
 */
test("커서를 프롬프트 뒤로 되돌린다 — 안쪽으로 들어가면 프롬프트를 덮어쓴다", async () => {
  const PROMPT_COLS = 10; // "AX-NAVI > "
  const h = harness();
  // readline 이 프롬프트를 알고 있는 상태를 흔내낸다.
  h.rl.getCursorPos = () => ({ rows: 0, cols: PROMPT_COLS + h.rl.line.length });

  attachAutocomplete({ rl: h.rl, input: h.input, output: h.output, source: () => ITEMS, ui: plainUi });
  h.reset();
  h.type("/find");
  await new Promise((r) => setImmediate(r));

  const moves = cursorRightMoves(h.text());
  assert.ok(moves.length > 0, "좌표를 되돌리지 않았다");
  for (const col of moves) {
    assert.ok(col >= PROMPT_COLS, `프롬프트 안쪽(${col}칸)으로 들어갔다`);
  }
});
