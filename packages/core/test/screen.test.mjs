/*
 * 화면 영역 관리 검증.
 *
 * 커서 제어는 눈으로만 보면 틀린 줄 모른다 — 실제로 ESC 바이트가 소스에서 사라져
 * `[1A[0J` 가 글자로 찍히고 키를 칠 때마다 상태줄이 쌓이는 일이 있었다.
 * 그래서 "제어 시퀀스가 진짜 제어 시퀀스인가"를 테스트로 못 박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScreen, physicalLines, visibleLength } from "../../cli/src/screen.mjs";
import { renderStatus } from "../../cli/src/status.mjs";

const ESC = String.fromCharCode(27);

/** 출력 스트림 흉내. TTY 여부를 지정할 수 있다. */
function fakeOutput(isTTY = true) {
  /** @type {string[]} */
  const chunks = [];
  return {
    isTTY,
    columns: 100,
    /** @param {string} s */
    write(s) {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(""),
    reset: () => chunks.splice(0),
  };
}

test("제어 시퀀스에 실제 ESC 가 들어 있다", () => {
  const out = fakeOutput();
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  screen.redraw();
  screen.redraw(); // 두 번째는 지우고 다시 그린다

  const text = out.text();
  assert.ok(text.includes(`${ESC}[0J`), "화면 지우기 시퀀스가 없다 — 글자로 찍히고 있을 수 있다");
  assert.ok(text.includes(`${ESC}[1A`), "커서 올리기 시퀀스가 없다");

  /*
   * ESC 없이 `[1A` 가 나오면 그건 화면에 글자로 찍힌다.
   * 정상 시퀀스는 항상 ESC가 바로 앞에 있으므로, 그것만 지운 뒤 남아 있으면 결함이다.
   */
  const withoutValid = text.split(`${ESC}[`).join("");
  assert.ok(!/\[\d+[AJ]/.test(withoutValid), "ESC 없는 제어 문자열이 섞여 있다");
});

test("다시 그려도 상태줄이 쌓이지 않는다", () => {
  const out = fakeOutput();
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  screen.setStatus(() => "STATUSLINE");

  screen.redraw();
  screen.redraw();
  screen.redraw();

  const text = out.text();
  const drawn = (text.match(/STATUSLINE/g) ?? []).length;
  const cleared = (text.match(new RegExp(`${ESC}\\[0J`, "g")) ?? []).length;
  // 세 번 그렸으면 두 번은 앞의 것을 지우고 그린 것이어야 한다.
  assert.equal(drawn, 3);
  assert.equal(cleared, 2, "지우지 않고 덧그리고 있다");
});

test("출력은 프롬프트 영역을 지우고 흘린 뒤 다시 그린다", () => {
  const out = fakeOutput();
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  screen.setStatus(() => "S");
  screen.redraw();
  out.reset();

  screen.print("에이전트 출력");

  const text = out.text();
  assert.ok(text.indexOf(`${ESC}[0J`) < text.indexOf("에이전트 출력"), "출력 전에 지우지 않았다");
  assert.ok(text.indexOf("에이전트 출력") < text.lastIndexOf("S"), "출력 후에 다시 그리지 않았다");
});

test("비TTY 에서는 커서 제어를 하지 않는다 — 파이프에 쓰레기가 남는다", () => {
  const out = fakeOutput(false);
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  screen.setStatus(() => "S");
  screen.redraw();
  screen.print("본문");

  const text = out.text();
  assert.ok(!text.includes(ESC), "비TTY 인데 제어 시퀀스를 썼다");
  // 한 덩어리는 한 줄이어야 한다 — 안 그러면 파이프 출력이 전부 붙어 나온다.
  assert.ok(text.endsWith("본문\n"), "줄바꿈 없이 붙여 썼다");
});

test("입력 중인 내용이 프롬프트 뒤에 다시 그려진다", () => {
  const out = fakeOutput();
  let typing = "";
  const screen = createScreen({
    output: /** @type {any} */ (out),
    prompt: "AX-NAVI > ",
    currentInput: () => typing,
  });
  typing = "주문 취소";
  screen.redraw();

  assert.match(out.text(), /AX-NAVI > 주문 취소/);
});

/* ---------- 상태줄 ---------- */

test("상태줄에 실행 경로·컨텍스트·대기 건수가 들어간다", () => {
  const plain = {
    dim: (/** @type {string} */ s) => s,
    cyan: (/** @type {string} */ s) => s,
    green: (/** @type {string} */ s) => s,
    yellow: (/** @type {string} */ s) => s,
  };
  const line = renderStatus({
    root: process.cwd(),
    runtime: "claude-cli 2.1.259",
    contextTokens: 12_300,
    maxTokens: 120_000,
    turns: 3,
    costUsd: 0.1234,
    queued: 2,
    ui: plain,
    width: 120,
  });

  assert.match(line, /claude-cli 2\.1\.259/);
  assert.match(line, /Ctx 12\.3k/);
  assert.match(line, /3턴/);
  assert.match(line, /\$0\.1234/);
  // 작업 중에 친 입력이 사라진 게 아니라 줄 서 있다는 것을 보여 줘야 한다.
  assert.match(line, /2건 대기/);
});

test("컨텍스트가 없거나 비용을 모르면 그 칸을 비운다 — 0을 지어내지 않는다", () => {
  const plain = {
    dim: (/** @type {string} */ s) => s,
    cyan: (/** @type {string} */ s) => s,
    green: (/** @type {string} */ s) => s,
    yellow: (/** @type {string} */ s) => s,
  };
  const line = renderStatus({
    root: process.cwd(),
    runtime: "anthropic",
    contextTokens: 0,
    maxTokens: 120_000,
    turns: 0,
    costUsd: null,
    queued: 0,
    ui: plain,
    width: 120,
  });

  assert.ok(!line.includes("$"), "비용을 모르는데 표시했다");
  assert.ok(!line.includes("턴"), "턴이 없는데 표시했다");
  assert.ok(!line.includes("대기"), "대기가 없는데 표시했다");
});

/* ---------- 줄 접힘 ---------- */

test("색 코드를 뺀 길이를 센다 — ESC 가 빠지면 폭 계산이 틀어진다", () => {
  const colored = `${ESC}[36m클로드${ESC}[0m`;
  assert.equal(visibleLength(colored), 3, "색 코드가 길이에 섞여 들어갔다");
});

test("폭을 넘으면 물리 줄 수를 그만큼 센다", () => {
  assert.equal(physicalLines("가".repeat(10), 80), 1);
  assert.equal(physicalLines("x".repeat(80), 80), 1);
  assert.equal(physicalLines("x".repeat(81), 80), 2);
  assert.equal(physicalLines("x".repeat(161), 80), 3);
});

test("상태줄이 접혀도 지울 때 그만큼 되짚어 올라간다", () => {
  const out = fakeOutput();
  out.columns = 40;
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  // 폭 40인데 60자짜리 상태줄 — 물리적으로 두 줄을 차지한다.
  screen.setStatus(() => "S".repeat(60));

  screen.redraw();
  out.reset();
  screen.redraw();

  // 상태줄 2줄 + 프롬프트 1줄 = 3줄. 마지막 줄에서 2줄 올라가야 첫 줄이다.
  assert.ok(out.text().includes(`${ESC}[2A`), `2줄 올라가지 않았다: ${JSON.stringify(out.text().slice(0, 40))}`);
});

test("상태줄은 터미널 폭을 넘지 않는다 — 넘으면 접혀서 쌓인다", () => {
  const plain = {
    dim: (/** @type {string} */ s) => s,
    cyan: (/** @type {string} */ s) => s,
    green: (/** @type {string} */ s) => s,
    yellow: (/** @type {string} */ s) => s,
  };
  for (const width of [40, 80, 100, 120]) {
    const line = renderStatus({
      root: process.cwd(),
      runtime: "claude-cli 2.1.259",
      contextTokens: 12_300,
      maxTokens: 120_000,
      turns: 3,
      costUsd: 0.1234,
      queued: 2,
      ui: plain,
      width,
    });
    assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}자 — 접힌다`);
  }
});

test("출력을 여러 번 해도 상태줄이 화면에 쌓이지 않는다", () => {
  const out = fakeOutput();
  out.columns = 60;
  const screen = createScreen({ output: /** @type {any} */ (out), prompt: "> ", currentInput: () => "" });
  screen.setStatus(() => "STATUS");
  screen.redraw();
  out.reset();

  screen.print("첫째 줄");
  screen.print("둘째 줄");
  screen.print("셋째 줄");

  const text = out.text();
  // 세 번 출력했으면 상태줄도 세 번 그려지되, 그 앞에 매번 지우기가 있어야 한다.
  assert.equal((text.match(/STATUS/g) ?? []).length, 3);
  // 지우기 시퀀스를 정규식 없이 센다 — ESC 를 정규식에 넣으면 이스케이프가 꼬인다.
  assert.equal(text.split(`${ESC}[0J`).length - 1, 3, "지우지 않고 덧그렸다");
});
