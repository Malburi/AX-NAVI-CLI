/*
 * 작업 중 상태 표시 · 폭 계산 검증.
 *
 * 이 부류는 눈으로만 보면 틀린 줄 모른다. 실제로 겪은 것만 세 가지다.
 *   - ESC 바이트가 소스에서 사라져 `[1A[0J` 가 글자로 찍혔다
 *   - 색 코드를 길이에 섞어 세서 줄이 폭을 넘어 접혔다
 *   - 접힌 줄을 한 줄만 지워서 출력마다 상태줄이 쌓였다
 * 그래서 제어 시퀀스와 폭 계산을 테스트로 못 박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivity, elapsed } from "../../cli/src/activity.mjs";
import { clipToWidth, visibleLength } from "../../cli/src/width.mjs";
import { renderStatus } from "../../cli/src/status.mjs";

const ESC = String.fromCharCode(27);

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  green: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
};

/** @param {boolean} isTTY @param {number} columns */
function fakeOutput(isTTY = true, columns = 100) {
  /** @type {string[]} */
  const chunks = [];
  return {
    isTTY,
    columns,
    /** @param {string} s */
    write(s) {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(""),
    reset: () => chunks.splice(0),
  };
}

/* ---------- 폭 계산 ---------- */

test("색 코드는 길이에 세지 않고, 한글은 두 칸으로 센다", () => {
  // 터미널이 실제로 차지하는 칸을 센다. 글자 수로 세면 한글 줄이 접혀 줄 수가 틀어진다.
  assert.equal(visibleLength(`${ESC}[36m클로드${ESC}[0m`), 6);
  assert.equal(visibleLength("plain"), 5);
  assert.equal(visibleLength("ab가나"), 6, "섯임과 한글이 섞여도 칸을 제대로 센다");
});

test("폭을 넘으면 자르되 색 코드 중간에서 끊지 않는다", () => {
  const colored = `${ESC}[36m${"가".repeat(50)}${ESC}[0m`;
  const clipped = clipToWidth(colored, 10);
  assert.equal(visibleLength(clipped), 10);
  // 시작 색 코드는 살아 있어야 한다 — 잘려 나가면 이후 출력이 물든다.
  assert.ok(clipped.startsWith(`${ESC}[36m`));
});

test("폭 안에 들어가면 그대로 둔다", () => {
  assert.equal(clipToWidth("짧다", 10), "짧다");
});

/* ---------- 활동 줄 ---------- */

test("제어 시퀀스에 실제 ESC 가 들어 있다", () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("axnavi");
  activity.stop();

  const text = out.text();
  assert.ok(text.includes(`${ESC}[2K`), "줄 지우기 시퀀스가 없다 — 글자로 찍히고 있을 수 있다");
  // ESC 없는 제어 문자열이 섞이면 화면에 글자로 남는다.
  assert.ok(!text.split(`${ESC}[`).join("").includes("[2K"), "ESC 없는 제어 문자열이 있다");
});

test("멈추면 화면에서 지운다 — 잔상을 남기지 않는다", () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("axnavi");
  out.reset();
  activity.stop();

  // 지우기만 하고 새로 그리지 않아야 한다.
  assert.ok(out.text().includes(`${ESC}[2K`));
  assert.ok(!out.text().includes("axnavi"), "멈췄는데 다시 그렸다");
});

test("출력이 끼어들 때 지웠다 되살린다", () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("axnavi");
  out.reset();

  activity.suspend();
  const afterSuspend = out.text();
  activity.resume();

  assert.ok(!afterSuspend.includes("axnavi"), "지우지 않았다");
  assert.ok(out.text().includes("axnavi"), "되살리지 않았다");
});

test("진행 정보가 줄에 반영된다", () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("analyzer");
  activity.set({ tool: "QueryIndex" });
  activity.bump(2500);
  activity.set({ queued: 2 });

  const text = out.text();
  assert.match(text, /analyzer/);
  assert.match(text, /QueryIndex/);
  assert.match(text, /↓ 2\.5k tokens/);
  // 작업 중에 친 입력이 사라진 게 아니라 줄 서 있다는 신호.
  assert.match(text, /2건 대기/);
});

test("활동 줄은 터미널 폭을 넘지 않는다", () => {
  const out = fakeOutput(true, 30);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("아주아주긴에이전트이름".repeat(5));
  activity.set({ tool: "매우긴도구이름".repeat(5), queued: 99 });

  for (const chunk of out.text().split(`${ESC}[2K`)) {
    if (chunk.trim()) assert.ok(visibleLength(chunk.replace("\r", "")) < 30, `폭 초과: ${visibleLength(chunk)}`);
  }
});

test("비TTY 에서는 아무것도 그리지 않는다 — 파이프에 쓰레기가 남는다", () => {
  const out = fakeOutput(false);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("axnavi");
  activity.set({ tool: "Read" });
  activity.stop();

  assert.equal(out.text(), "", "비TTY 인데 출력했다");
});

/* ---------- 상태줄 ---------- */

test("상태줄에 실행 경로·컨텍스트·턴·비용이 들어간다", () => {
  const line = renderStatus({
    root: process.cwd(),
    runtime: "claude-cli 2.1.259",
    contextTokens: 12_300,
    maxTokens: 120_000,
    turns: 3,
    costUsd: 0.1234,
    queued: 0,
    ui: plainUi,
    width: 120,
  });
  assert.match(line, /claude-cli 2\.1\.259/);
  assert.match(line, /Ctx 12\.3k/);
  assert.match(line, /3턴/);
  assert.match(line, /\$0\.1234/);
});

test("모르는 값은 칸을 비운다 — 0을 지어내지 않는다", () => {
  const line = renderStatus({
    root: process.cwd(),
    runtime: "anthropic",
    contextTokens: 0,
    maxTokens: 120_000,
    turns: 0,
    costUsd: null,
    queued: 0,
    ui: plainUi,
    width: 120,
  });
  assert.ok(!line.includes("$"), "비용을 모르는데 표시했다");
  assert.ok(!line.includes("턴"), "턴이 없는데 표시했다");
});

test("어떤 폭에서도 상태줄이 폭을 넘지 않는다 — 넘으면 접혀서 쌓인다", () => {
  for (const width of [30, 40, 80, 100, 120, 200]) {
    const line = renderStatus({
      root: process.cwd(),
      runtime: "claude-cli 2.1.259",
      contextTokens: 12_300,
      maxTokens: 120_000,
      turns: 3,
      costUsd: 0.1234,
      queued: 2,
      ui: plainUi,
      width,
    });
    assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}자`);
  }
});

test("멈춰 세우면 회전자 타이머가 다시 그리지 않는다", async () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("harness-init");
  activity.suspend();
  out.reset();

  // 타이머가 여러 번 돌 만큼 기다린다. 예전에는 여기서 되살아나 질문지를 덮어썼다.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(out.text(), "", "멈춰 세웠는데 타이머가 다시 그렸다");

  activity.resume();
  assert.ok(out.text().includes("harness-init"), "되살리지 않았다");
  activity.stop();
});

test("경과 시간은 분·시로 끈는다 — 898s 는 암산해야 읽힌다", () => {
  assert.equal(elapsed(0), "0s");
  assert.equal(elapsed(58_000), "58s");
  assert.equal(elapsed(898_000), "14m 58s");
  assert.equal(elapsed(3_661_000), "1h 1m 1s");
  // 음수는 시계가 뒤로 갔을 때 생긴다. 0 으로 본다.
  assert.equal(elapsed(-5_000), "0s");
});
