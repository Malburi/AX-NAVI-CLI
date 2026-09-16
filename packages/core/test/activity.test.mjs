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
const NEWLINE = String.fromCharCode(10);
const CR = String.fromCharCode(13);

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
  assert.ok(text.includes(`${ESC}[0J`), "지우기 시퀀스가 없다 — 글자로 찍히고 있을 수 있다");
  // ESC 없는 제어 문자열이 섞이면 화면에 글자로 남는다.
  assert.ok(!text.split(`${ESC}[`).join("").includes("[0J"), "ESC 없는 제어 문자열이 있다");
});

test("멈추면 화면에서 지운다 — 잔상을 남기지 않는다", () => {
  const out = fakeOutput();
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("axnavi");
  out.reset();
  activity.stop();

  // 지우기만 하고 새로 그리지 않아야 한다.
  assert.ok(out.text().includes(`${ESC}[0J`));
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

test("판의 모든 줄이 터미널 폭을 넘지 않는다", () => {
  const out = fakeOutput(true, 30);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("아주아주긴에이전트이름".repeat(5));
  activity.set({ tool: "매우긴도구이름".repeat(5), queued: 99, typing: "긴 입력".repeat(20) });

  // 접히면 올라갈 줄 수가 틀려 판이 화면에 쌓인다.
  for (const chunk of out.text().split(`${ESC}[0J`)) {
    for (const line of chunk.split(NEWLINE)) {
      const clean = line.replace(CR, "");
      if (clean.trim()) assert.ok(visibleLength(clean) < 30, `폭 초과: ${visibleLength(clean)}`);
    }
  }
  activity.stop();
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

/* ---------- 판이 쌓이지 않는가 ---------- */

/*
 * 여기가 예전에 무너진 자리다. 프롬프트에 붙박이를 달았더니 Enter 가 커서를 한 줄
 * 내려 우리가 센 줄 수와 어긋났고, 출력마다 상태줄이 쌓였다.
 *
 * 지금은 턴 중에만 그리고 그 구간에는 화면 바닥을 우리가 소유한다. 그래서 규칙은
 * 하나다 — **그린 줄 수만큼 정확히 올라간다.** 이게 어긋나면 그때부터 계속 쌓인다.
 */
test("그린 줄 수만큼 정확히 올라간다 — 어긋나면 그때부터 계속 쌓인다", () => {
  const out = fakeOutput(true, 100);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("harness-init");

  for (let i = 0; i < 8; i += 1) {
    out.reset();
    activity.suspend();                 // 지우기: 위로 N-1
    const erased = out.text();
    activity.resume();                  // 다시 그리기: 줄바꿈 N-1개
    const painted = out.text().slice(erased.length);

    const up = Number(/\u001b\[(\d+)A/.exec(erased)?.[1] ?? 0);
    const newlines = (painted.match(new RegExp(NEWLINE, "g")) ?? []).length;
    assert.equal(up, newlines, `${i}번째: 올라간 ${up} / 그린 ${newlines + 1}줄`);
  }
  activity.stop();
});

test("멈춘 뒤에는 화면에 아무것도 남지 않는다", () => {
  const out = fakeOutput(true, 100);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("harness-init");
  out.reset();
  activity.stop();

  const visible = out.text().split(ESC).map((p) => p.replace(/^\[[\d;]*[A-Za-z]/, "")).join("").replace(CR, "");
  assert.equal(visible.trim(), "", `남은 글자: ${JSON.stringify(visible)}`);
});

test("우측에 실행 경로와 컨텍스트를 밝힌다 — 모델을 바꿔 놓고 확인할 길이 있어야 한다", () => {
  const out = fakeOutput(true, 120);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("analyzer");
  activity.set({ runtime: "claude-cli 2.1.259", model: "deep", contextTokens: 27_100 });
  const text = out.text();
  assert.match(text, /claude-cli 2\.1\.259/);
  assert.match(text, /deep/);
  assert.match(text, /Ctx 27\.1k/);
  activity.stop();
});

test("자리가 모자라면 우측을 버린다 — 진행 상황이 더 급하다", () => {
  const out = fakeOutput(true, 40);
  const activity = createActivity({ output: /** @type {any} */ (out), ui: plainUi });
  activity.start("아주긴에이전트이름".repeat(3));
  out.reset();
  activity.set({ runtime: "claude-cli 2.1.259", contextTokens: 27_100 });

  /*
   * 마지막으로 그린 한 프레임만 본다.
   * 프레임은 마지막 줄에 줄바꿈을 붙이지 않으므로, 날것 스트림을 줄바꿈으로만 자르면
   * 앞 프레임의 끝과 다음 프레임의 머리가 한 줄로 붙어 보인다 — 터미널에서는
   * 복귀 문자가 줄 처음으로 돌리므로 그럴 일이 없다.
   */
  const frame = out.text().split(CR).at(-1) ?? "";
  for (const line of frame.split(NEWLINE)) {
    assert.ok(visibleLength(line) < 40, `${visibleLength(line)}칸: ${JSON.stringify(line.slice(0, 50))}`);
  }
  activity.stop();
});
