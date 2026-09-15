/*
 * 방향키 선택지 검증.
 *
 * 커서 제어 자체는 TTY 없이 못 보지만, **몇 줄을 그렸는지**와 **폭을 넘지 않는지**는
 * 여기서 잡힌다. 그 둘이 어긋나면 지우는 줄 수가 틀려 선택지가 화면에 쌓인다 —
 * 이 저장소에서 이미 세 번 겪은 결함이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAnswer, renderPicker, windowFor } from "../../cli/src/picker.mjs";
import { visibleLength, wrapToWidth } from "../../cli/src/width.mjs";

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
};

/** @param {number} n */
const opts = (n) => Array.from({ length: n }, (_, i) => `선택지 ${i + 1}`);

/** @param {Partial<Parameters<typeof renderPicker>[0]>} over */
const render = (over = {}) =>
  renderPicker({
    question: "무엇으로 할까요?",
    options: opts(4),
    cursor: 0,
    checked: new Set(),
    multiSelect: false,
    width: 100,
    ui: plainUi,
    ...over,
  });

/* ---------- 창 ---------- */

test("다 들어가면 창을 나누지 않는다", () => {
  assert.deepEqual(windowFor(4, 0, 9), { start: 0, end: 4 });
});

test("넘치면 고른 항목이 창 안에 남도록 민다", () => {
  const { start, end } = windowFor(30, 25, 9);
  assert.ok(start <= 25 && 25 < end, `25번이 창(${start}~${end}) 밖이다`);
  assert.equal(end - start, 9);
});

test("끝으로 가도 창이 목록 밖으로 나가지 않는다", () => {
  const { start, end } = windowFor(30, 29, 9);
  assert.equal(end, 30);
  assert.equal(start, 21);
});

/* ---------- 그리기 ---------- */

test("고른 항목만 화살표를 받는다 — 색 없는 터미널에서도 구분된다", () => {
  const lines = render({ cursor: 2 });
  const marked = lines.filter((l) => l.startsWith("❯"));
  assert.equal(marked.length, 1, "화살표가 하나가 아니다");
  assert.match(/** @type {string} */ (marked[0]), /선택지 3/);
});

test("4개를 넘는 선택지도 다 보인다 — 호스트의 4옵션 상한을 물려받지 않는다", () => {
  const lines = render({ options: opts(6) });
  for (const label of opts(6)) {
    assert.ok(lines.some((l) => l.includes(label)), `${label}이 사라졌다`);
  }
});

test("복수 선택은 고른 것과 아닌 것을 표시로 가른다", () => {
  const body = render({ multiSelect: true, checked: new Set([1, 3]), options: opts(4) }).join("\n");
  assert.match(body, /◉ 2\. 선택지 2/);
  assert.match(body, /◉ 4\. 선택지 4/);
  assert.match(body, /◯ 1\. 선택지 1/);
});

test("조작법을 알려 준다 — 방향키를 쓰는 줄 모르면 멈춘 화면으로 보인다", () => {
  assert.match(/** @type {string} */ (render().at(-1)), /↑↓/);
  assert.match(/** @type {string} */ (render({ multiSelect: true }).at(-1)), /Space/);
});

test("창을 넘기면 위아래로 더 있다고 알린다", () => {
  const lines = render({ options: opts(30), cursor: 15 });
  assert.ok(lines.some((l) => l.includes("위로")), "가려진 앞부분을 안 알렸다");
  assert.ok(lines.some((l) => l.includes("아래로")), "가려진 뒷부분을 안 알렸다");
});

/* ---------- 폭 ---------- */

test("어떤 폭에서도 줄이 폭을 넘지 않는다 — 접히면 지울 줄 수가 어긋나 쌓인다", () => {
  const long = [
    "서버·클라이언트 각각 초기화 후 연결 (1:1) — 두 프로젝트를 독립적으로 초기화하고 pair-init으로 연결합니다",
    "기타 (부분 범위 / 허브형 1:N) — 특정 폴더만 분석하거나 백엔드 1개+클라이언트 여러 개 구조입니다",
  ];
  for (const width of [30, 40, 80, 120, 200]) {
    for (const line of render({ options: long, width })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}자`);
    }
  }
});

test("줄 수가 예측 가능하다 — 지울 때 그만큼 올라가야 한다", () => {
  // 질문 1 + 빈 줄 + 선택지 n + 빈 줄 + 조작법 1. 설명이 없는 선택지는 한 줄씩이다.
  assert.equal(render({ options: opts(4) }).length, 1 + 1 + 4 + 1 + 1);
  assert.equal(render({ options: opts(1) }).length, 1 + 1 + 1 + 1 + 1);
});

/* ---------- 키 처리 ---------- */

import { EventEmitter } from "node:events";
import { pick } from "../../cli/src/picker.mjs";

function fakeIo() {
  const input = /** @type {any} */ (new EventEmitter());
  input.isRaw = false;
  input.setRawMode = (/** @type {boolean} */ v) => { input.isRaw = v; };
  /** @type {string[]} */
  const chunks = [];
  const output = /** @type {any} */ ({ columns: 100, write: (/** @type {string} */ s) => chunks.push(s) });
  /** @param {string} ch @param {object} key */
  const key = (ch, key) => input.emit("keypress", ch, key);
  return { input, output, key, text: () => chunks.join("") };
}

test("방향키로 옮기고 Enter 로 고른다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나", "다"], input: io.input, output: io.output, ui: plainUi });
  io.key("", { name: "down" });
  io.key("", { name: "down" });
  io.key("", { name: "return" });
  assert.deepEqual(await answer, ["다"]);
});

test("맨 위에서 위로 가면 맨 아래로 돈다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나", "다"], input: io.input, output: io.output, ui: plainUi });
  io.key("", { name: "up" });
  io.key("", { name: "return" });
  assert.deepEqual(await answer, ["다"]);
});

test("Esc 는 건너뛴다 — 아무거나 골라 주지 않는다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나"], input: io.input, output: io.output, ui: plainUi });
  io.key("", { name: "escape" });
  assert.deepEqual(await answer, []);
});

test("Space 로 여러 개를 고르고 Enter 로 확정한다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나", "다"], multiSelect: true, input: io.input, output: io.output, ui: plainUi });
  io.key(" ", { name: "space" });
  io.key("", { name: "down" });
  io.key("", { name: "down" });
  io.key(" ", { name: "space" });
  io.key("", { name: "return" });
  assert.deepEqual(await answer, ["가", "다"]);
});

test("복수 선택에서 아무것도 안 고르고 Enter 면 커서 자리를 쓴다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나"], multiSelect: true, input: io.input, output: io.output, ui: plainUi });
  io.key("", { name: "down" });
  io.key("", { name: "return" });
  assert.deepEqual(await answer, ["나"], "빈손으로 돌려보냈다");
});

test("번호 키도 그대로 받는다 — 손에 익은 사람에게서 빼앗지 않는다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나", "다"], input: io.input, output: io.output, ui: plainUi });
  io.key("2", { name: "2" });
  assert.deepEqual(await answer, ["나"]);
});

test("readline 의 키 처리를 떼었다가 그대로 되돌린다", async () => {
  const io = fakeIo();
  const readlineHandler = () => {};
  io.input.on("keypress", readlineHandler);

  const answer = pick({ question: "무엇?", options: ["가", "나"], input: io.input, output: io.output, ui: plainUi });
  assert.equal(io.input.listeners("keypress").includes(readlineHandler), false,
    "readline 이 같은 키를 또 처리한다 — 프롬프트가 선택지 사이에 끼어든다");
  assert.equal(io.input.isRaw, true, "raw 모드로 못 바꿨다 — 키가 줄 단위로만 온다");

  io.key("", { name: "return" });
  await answer;

  assert.equal(io.input.listeners("keypress").includes(readlineHandler), true,
    "readline 을 되돌리지 않았다 — 이후 입력이 통째로 죽는다");
  assert.equal(io.input.isRaw, false, "raw 모드를 되돌리지 않았다");
});

test("선택지 위에서 Ctrl+C 는 작업을 중단시킨다", async () => {
  const io = fakeIo();
  let interrupted = false;
  const answer = pick({
    question: "무엇?", options: ["가", "나"], input: io.input, output: io.output, ui: plainUi,
    onInterrupt: () => { interrupted = true; },
  });
  io.key("", { name: "c", ctrl: true });
  assert.deepEqual(await answer, []);
  assert.equal(interrupted, true, "질문만 닫고 작업은 계속 돈다");
});

test("고른 뒤에는 결과 한 줄만 남긴다", async () => {
  const io = fakeIo();
  const answer = pick({ question: "무엇?", options: ["가", "나", "다"], input: io.input, output: io.output, ui: plainUi });
  io.key("", { name: "down" });
  io.key("", { name: "return" });
  await answer;
  const tail = io.text().split(String.fromCharCode(27) + "[0J").at(-1) ?? "";
  assert.match(tail, /나/);
  assert.ok(!tail.includes("↑↓"), "조작법이 화면에 남았다");
});

/* ---------- 줄 수 ---------- */

/*
 * 여기가 실제로 터졌던 자리다. harness-init 의 견적 안내가 여러 줄짜리 질문으로 왔는데
 * 그걸 한 줄로 세는 바람에, 방향키를 움직일 때마다 지우다 만 질문이 화면에 쌓였다.
 */
const MULTILINE = [
  "인덱싱 완료 — 백엔드 소스 2,575개·심볼 2,363개, 프론트엔드 소스 1,428개·심볼 13,532개. (여기까지 LLM 사용 없음)",
  "",
  "이제 LLM 분석 구간입니다. 예상 규모:",
  "- 백엔드: Full 기준 약 27분 · 약 318,000 토큰",
].join("\n");

test("여러 줄짜리 질문도 줄 수가 정확하다 — 틀리면 지우다 말아 화면에 쌓인다", () => {
  const lines = render({ question: MULTILINE, options: opts(3), width: 200 });
  for (const line of lines) {
    assert.ok(!line.includes("\n"), `줄 안에 줄바꿈이 남았다: ${JSON.stringify(line)}`);
  }
  // 질문 4 + 빈 줄 + 선택지 3 + 빈 줄 + 조작법 1
  assert.equal(lines.length, 4 + 1 + 3 + 1 + 1);
});

test("긴 선택지는 잘리지 않고 접힌다 — 내용 자체가 정보다", () => {
  const long = "서버·클라이언트 각각 초기화 후 연결 (1:1) — 두 프로젝트를 독립적으로 초기화하고 pair-init으로 연결합니다";
  const lines = render({ options: [long], width: 40 });
  const body = lines.join("").replace(/[❯?\s]/g, "");
  assert.ok(body.includes("pair-init으로"), "뒷부분이 잘려 나갔다");
});

test("접힌 줄은 화살표를 되풀이하지 않는다 — 항목이 여러 개로 보인다", () => {
  const lines = render({ options: ["아주 긴 선택지 ".repeat(10)], width: 40, cursor: 0 });
  const arrows = lines.filter((l) => l.startsWith("❯")).length;
  assert.equal(arrows, 1, `화살표가 ${arrows}개다`);
});

test("한글은 두 칸으로 세어 접는다 — 한 칸으로 세면 터미널이 접어 줄 수가 어긋난다", () => {
  assert.equal(visibleLength("한글"), 4);
  for (const line of wrapToWidth("한글".repeat(30), 20)) {
    assert.ok(visibleLength(line) <= 20, `${visibleLength(line)}칸`);
  }
});

test("답 기록도 여러 줄 질문을 그대로 담는다", () => {
  const lines = renderAnswer({ question: MULTILINE, answers: ["Standard로 진행"], width: 200, ui: plainUi });
  for (const line of lines) assert.ok(!line.includes("\n"));
  assert.equal(lines.length, 5, "질문 4줄 + 답 1줄이 아니다");
  assert.match(lines.join("\n"), /Standard로 진행/);
});

/* ---------- 새 배치 ---------- */

import { splitOption } from "../../cli/src/picker.mjs";

/*
 * 스킬들이 이미 "제목 — 설명" 꼴로 쓰고 있다(harness-init 의 구성 선택 등).
 * 한 줄로 두면 제목이 설명에 묻혀 무엇을 고르는지 한눈에 안 들어온다.
 */
test("선택지를 제목과 설명으로 가른다", () => {
  const { title, detail } = splitOption("단일 프로젝트로 초기화 (Recommended) — 지금 폴더 전체를 분석합니다");
  assert.equal(title, "단일 프로젝트로 초기화 (Recommended)");
  assert.equal(detail, "지금 폴더 전체를 분석합니다");
});

test("구분자가 없으면 통째로 제목이다", () => {
  assert.deepEqual(splitOption("기타"), { title: "기타", detail: "" });
});

test("맨 앞의 붙임표는 구분자로 보지 않는다 — 제목이 토막 난다", () => {
  assert.equal(splitOption("- 이건 목록 기호").title, "- 이건 목록 기호");
});

test("제목은 진하게, 설명은 흐리게 — 두 줄로 나온다", () => {
  const lines = render({ options: ["제목 — 설명입니다"], width: 120 });
  const body = lines.join("\n");
  assert.match(body, /1\. 제목/);
  assert.match(body, /설명입니다/);
  // 제목과 설명이 같은 줄에 붙으면 가른 의미가 없다.
  assert.ok(!lines.some((l) => l.includes("제목") && l.includes("설명입니다")));
});

test("번호를 보여 준다 — 번호로도 고를 수 있다는 걸 화면이 말해야 한다", () => {
  const body = render({ options: opts(3) }).join("\n");
  for (const n of [1, 2, 3]) assert.match(body, new RegExp(`${n}\. 선택지 ${n}`));
  assert.match(body, /번호 입력/);
});

test("주제말을 테두리로 두른다 — 무엇에 관한 질문인지 먼저 보여야 한다", () => {
  const lines = render({ header: "프로젝트 구성", options: opts(2), width: 100 });
  assert.match(/** @type {string} */ (lines[1]), /프로젝트 구성/);
  assert.ok(/** @type {string} */ (lines[0]).includes("╭"), "테두리가 없다");
});

test("주제말이 없으면 테두리도 없다 — 빈 상자를 그리지 않는다", () => {
  assert.ok(!/** @type {string} */ (render({ options: opts(2) })[0]).includes("╭"));
});

test("주제말이 길어도 폭을 넘지 않는다", () => {
  for (const width of [30, 60, 120]) {
    for (const line of render({ header: "아주 긴 주제말 ".repeat(10), options: opts(2), width })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}칸`);
    }
  }
});

test("주제말 테두리가 글자 폭에 맞는다 — 한글은 두 칸이다", () => {
  const lines = render({ header: "프로젝트 구성", options: opts(1), width: 90 });
  const [top, mid, bottom] = lines;
  assert.equal(visibleLength(/** @type {string} */ (top)), visibleLength(/** @type {string} */ (mid)), "위 테두리와 내용 폭이 다르다");
  assert.equal(visibleLength(/** @type {string} */ (top)), visibleLength(/** @type {string} */ (bottom)));
});

test("질문 표시는 도구 기록과 같은 ● 을 쓴다", () => {
  assert.ok(/** @type {string} */ (render({ options: opts(1) })[0]).startsWith("●"));
});
