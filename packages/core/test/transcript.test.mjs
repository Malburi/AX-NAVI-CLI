/*
 * 도구 기록 렌더링 검증.
 *
 * 예전 방식(호출 한 줄, 결과 한 줄을 오는 대로)이 읽히지 않았던 이유가 둘이었다.
 *   - claude 는 도구를 병렬로 돌린다. 호출이 먼저 쏟아지고 결과가 뒤늦게 오니
 *     어느 결과가 어느 호출의 것인지 알 수 없었다 → 짝을 지어 한 덩어리로 찍는다
 *   - 인자를 다 펼쳐 이어 붙이니 폭을 넘겨 접히고 첫 인자가 잘렸다 → 핵심 인자만
 * 둘 다 여기서 못 박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { headline, renderCall, resultBlock, shorten, summarizeResult } from "../../cli/src/transcript.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const plainUi = {
  dim: (/** @type {string} */ s) => s,
  cyan: (/** @type {string} */ s) => s,
  green: (/** @type {string} */ s) => s,
  red: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
  bold: (/** @type {string} */ s) => s,
};

/* ---------- 제목 줄 ---------- */

test("도구마다 그것만 보면 아는 인자를 고른다", () => {
  assert.equal(headline("Bash", { command: "ls -la", description: "목록" }), "Bash(ls -la)");
  assert.equal(headline("Grep", { pattern: "TODO", path: "src" }), "Grep(TODO)");
  assert.equal(headline("Task", { subagent_type: "general-purpose", description: "분석" }), "Task(분석)");
});

test("모르는 도구는 첫 문자열 인자를 쓴다 — 지어내지 않는다", () => {
  assert.equal(headline("낯선도구", { foo: 3, bar: "값" }), "낯선도구(값)");
  assert.equal(headline("인자없음", {}), "인자없음");
});

test("브리지 전송 이름은 걷어낸다", () => {
  assert.equal(headline("mcp__axnavi__QueryIndex", { command: "symbols" }), "QueryIndex(symbols)");
});

test("프로젝트 안 경로는 짧게 줄인다 — 절대경로가 한 줄을 다 먹는다", () => {
  const B = String.fromCharCode(92); // 소스에 역슬래시를 직접 쓰지 않는다 — 도구를 거치며 먹힌 적이 있다.
  const root = `C:${B}Users${B}HHI${B}proj`;
  assert.equal(shorten(`${root}${B}src${B}Main.java`, root), "src/Main.java");
  // 밖의 경로는 건드리지 않는다. 어디인지가 정보다.
  const outside = `D:${B}other${B}x.java`;
  assert.equal(shorten(outside, root), outside);
});

test("줄바꿈이 든 인자도 한 줄로 눕힌다 — 안 그러면 줄 수가 어긋난다", () => {
  const head = headline("Bash", { command: "const fs = require('fs')\nfs.readdirSync('.')" });
  assert.ok(!head.includes("\n"), "제목이 여러 줄이 됐다");
});

/* ---------- 결과 ---------- */

test("앞 몇 줄만 보이고 나머지는 개수로 알린다", () => {
  const { lines, hidden } = resultBlock(Array.from({ length: 24 }, (_, i) => `줄 ${i}`).join("\n"));
  assert.equal(lines.length, 4);
  assert.equal(hidden, 20);
});

test("짧은 결과는 숨기지 않는다", () => {
  const { lines, hidden } = resultBlock("한 줄");
  assert.deepEqual(lines, ["한 줄"]);
  assert.equal(hidden, 0);
});

test("앞뒤 빈 줄은 자리만 먹으므로 버린다", () => {
  const { lines } = resultBlock("\n\n진짜 내용\n\n");
  assert.deepEqual(lines, ["진짜 내용"]);
});

/* ---------- 덩어리 ---------- */

/** @param {Partial<Parameters<typeof renderCall>[0]>} over */
const render = (over = {}) =>
  renderCall({ tool: "Bash", input: { command: "ls" }, result: "a\nb", width: 100, ui: plainUi, ...over });

test("호출과 결과가 한 덩어리로 붙는다", () => {
  const lines = render();
  assert.match(/** @type {string} */ (lines[0]), /Bash\(ls\)/);
  assert.match(/** @type {string} */ (lines[1]), /⎿/);
  assert.match(lines.join("\n"), /a[\s\S]*b/);
});

test("실패와 성공을 표시로 가른다", () => {
  assert.ok(/** @type {string} */ (render({ isError: false })[0]).startsWith("●"));
  assert.ok(/** @type {string} */ (render({ isError: true })[0]).startsWith("●"));
});

test("결과를 못 받고 끝난 호출은 그 사실을 밝힌다 — 조용히 버리지 않는다", () => {
  const lines = render({ pending: true, result: undefined });
  assert.match(lines.join("\n"), /받지 못했다/);
});

test("출력이 없어도 빈칸으로 두지 않는다", () => {
  assert.match(render({ result: "" }).join("\n"), /출력 없음/);
});

test("어떤 폭에서도 줄이 폭을 넘지 않는다 — 접히면 상태 표시가 어긋난다", () => {
  const long = { command: "cd \"C:/Users/HHI/xu43\" && node build-index.mjs --root . --verbose --out _workspace/index" };
  for (const width of [30, 40, 80, 120, 200]) {
    for (const line of render({ input: long, result: "가".repeat(300), width })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}자`);
    }
  }
});

/* ---------- 요약 ---------- */

/*
 * Read 의 결과는 파일 내용 그 자체다. 그 앞 네 줄을 찍어 봐야 "이 파일을 읽었다"는
 * 사실 외에 알 수 있는 게 없고, 파일 수십 개를 읽는 동안 화면이 남의 파일 앞도리로
 * 덮인다 — 실측으로 harness-init 중 화면의 대부분이 이것이었다.
 */
test("파일 내용은 뿌리지 않고 얼마나 했는지만 남긴다", () => {
  const file = Array.from({ length: 60 }, (_, i) => `${i + 1}  코드`).join("\n");
  assert.equal(summarizeResult("Read", file), "60줄 읽음");
  assert.equal(summarizeResult("Glob", "a\nb\nc"), "파일 3개");
  assert.equal(summarizeResult("Grep", "m1\nm2"), "2건");
});

test("Bash 출력은 줄이지 않는다 — 출력 자체가 보고 싶은 것이다", () => {
  assert.equal(summarizeResult("Bash", "a\nb\nc"), null);
});

test("실패는 줄이지 않는다 — 왜 실패했는지가 본문에 있다", () => {
  assert.equal(summarizeResult("Read", "a\nb\nc", true), null);
});

test("한 줄짜리 안내는 줄이지 않는다 — '파일 없음'이 사라진다", () => {
  assert.equal(summarizeResult("Glob", "No files found"), null);
});

/* ---------- 중첩 ---------- */

test("서브에이전트 안의 일은 들여써서 누가 한 일인지 보인다", () => {
  const inner = render({ depth: 1 });
  const outer = render({ depth: 0 });
  assert.ok(/** @type {string} */ (inner[0]).startsWith("│"), "들여쓰지 않았다");
  assert.ok(!(/** @type {string} */ (outer[0]).startsWith("│")));
  // 결과 줄까지 같이 들여써야 블록으로 읽힌다.
  assert.ok(inner.every((l) => l.startsWith("│")), "결과 줄이 블록 밖으로 샜다");
});

test("들여써도 폭을 넘지 않는다", () => {
  for (const width of [30, 60, 120]) {
    for (const line of render({ depth: 1, result: "가".repeat(300), width })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}칸`);
    }
  }
});
