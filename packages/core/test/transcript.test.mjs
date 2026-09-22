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
import { headline, renderCall, renderSkillHeader, resultBlock, shorten, summarizeResult } from "../../cli/src/transcript.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const BS = String.fromCharCode(92);

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
test("본문이 쓸모없는 도구만 수자로 줄인다", () => {
  const file = Array.from({ length: 60 }, (_, i) => `${i + 1}  코드`).join("\n");
  assert.equal(summarizeResult("Read", file), "60줄 읽음");
  assert.equal(summarizeResult("Glob", "a\nb\nc"), "파일 3개");
});

/*
 * Grep·QueryIndex 는 찾은 것 자체가 답이다. "16건" 만 남기면 무엇을 찾았는지 몰라
 * 따라갈 수가 없다 — 실측으로 호출 30개가 전부 숫자만 남았다.
 */
test("찾은 것 자체가 답인 도구는 줄이지 않는다", () => {
  assert.equal(summarizeResult("Grep", "a\nb\nc"), null);
  assert.equal(summarizeResult("QueryIndex", "a\nb\nc"), null);
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

/* ---------- 한 줄로 눕히기 ---------- */

/*
 * Read·Grep 은 연속으로 수십 번 불린다. 두 줄씩 차지하면 화면이 그것만으로 차버린다 —
 * 실측으로 도구 25회가 50줄이 됐다. 내용은 그대로 두고 줄 수만 반으로 줄인다.
 */
test("결과는 제목 줄과 나뉘어 적는다 — 붙이면 호출과 결과가 눈으로 안 갈린다", () => {
  const file = Array.from({ length: 25 }, (_, i) => `${i + 1} x`).join("\n");
  const lines = render({ tool: "Read", input: { file_path: "A.java" }, result: file });
  assert.equal(lines.length, 2);
  assert.match(/** @type {string} */ (lines[0]), /Read\(A\.java\)$/);
  assert.match(/** @type {string} */ (lines[1]), /⎿ 25줄 읽음/);
});

test("한 줄짜리 결과도 제 자리를 갖는다", () => {
  const lines = render({ tool: "Grep", input: { pattern: "x" }, result: "No matches found" });
  assert.equal(lines.length, 2);
  assert.match(/** @type {string} */ (lines[1]), /No matches found/);
});

test("긴 한 줄은 잘라 버리지 않고 폭에 맞춘다", () => {
  const long = "아주 긴 한 줄 결과 ".repeat(20);
  for (const line of render({ tool: "Grep", input: { pattern: "x" }, result: long, width: 60 })) {
    assert.ok(visibleLength(line) < 60, `${visibleLength(line)}칸`);
  }
});

test("여러 줄 결과는 덩어리로 남긴다 — Bash 출력은 그 자체가 보고 싶은 것이다", () => {
  const lines = render({ tool: "Bash", input: { command: "ls" }, result: "a\nb\nc\nd\ne" });
  assert.ok(lines.length > 2);
  assert.match(lines.join("\n"), /⎿/);
});

test("Write 결과의 긴 안내를 되풀이하지 않는다 — 경로는 이미 제목에 있다", () => {
  const lines = render({
    tool: "Write",
    input: { file_path: "_workspace/index/owasp_top10.json" },
    result: "File created successfully at: C:" + BS + "Users" + BS + "HHI ... (file state is current in your context — no need to Read it back)",
  });
  assert.equal(lines.length, 2);
  assert.match(/** @type {string} */ (lines[1]), /저장됨/);
  assert.ok(!lines.join("").includes("file state"), "안내 문구가 그대로 남았다");
});

test("실패는 눈에 띄게 남는다 — 줄이느라 감추면 안 된다", () => {
  const lines = render({
    tool: "Edit",
    input: { file_path: "a.json" },
    result: "<tool_use_error>Error: No such tool available: Edit.</tool_use_error>",
    isError: true,
    width: 60,
  });
  assert.match(lines.join("\n"), /No such tool available/);
});

/* ---------- 스킬 머리말 ---------- */

/*
 * 자연어로 부르든 /find 로 부르든 같은 모양이어야 한다. 예전에는 자연어 경로에만
 * 표시가 붙고 슬래시는 그냥 답부터 찍혀서 무엇이 돌고 있는지 구분이 안 됐다.
 */
test("스킬을 썼다는 것과 그 설명을 보여 준다", () => {
  const lines = renderSkillHeader({
    name: "find-feature",
    description: "기능명·키워드·도메인 용어로 관련 파일·클래스·메서드·SQL을 찾아 목록으로 반환한다",
    width: 120,
    ui: plainUi,
  });
  assert.match(/** @type {string} */ (lines[0]), /Skill\(find-feature\)/);
  assert.match(/** @type {string} */ (lines[1]), /기능명/);
});

test("별칭으로 들어왔으면 어느 이름으로 불렀는지도 남긴다", () => {
  const lines = renderSkillHeader({ name: "find-feature", via: ["find"], width: 120, ui: plainUi });
  assert.match(/** @type {string} */ (lines[0]), /find-feature/);
  assert.match(/** @type {string} */ (lines[0]), /\/find/);
});

test("설명이 없으면 빈 줄을 만들지 않는다", () => {
  assert.equal(renderSkillHeader({ name: "x", width: 120, ui: plainUi }).length, 1);
  assert.equal(renderSkillHeader({ name: "x", description: "   ", width: 120, ui: plainUi }).length, 1);
});

test("어떤 폭에서도 머리말이 폭을 넘지 않는다", () => {
  for (const width of [30, 60, 120]) {
    for (const line of renderSkillHeader({
      name: "cross-repo-scaffold",
      description: "아주 긴 설명 ".repeat(20),
      via: ["scaffold"],
      width,
      ui: plainUi,
    })) {
      assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}칸`);
    }
  }
});

/* ---------- 긴 명령 ---------- */

/*
 * 한 줄에서 자르면 `cd "..." && python -c "` 에서 끝나 정작 무엇을 했는지가 안 보인다.
 * 두 줄까지 이어 보이되, 그래도 남으면 줄임표로 끝낸다 — 본문보다 명령이 화면을
 * 차지하면 그것대로 안 읽힌다.
 */
/*
 * 예전에는 두 줄까지 썼다. 한 줄에서 자르면 `cd "<절대경로>" && python -c "` 에서
 * 끝나 정작 무엇을 했는지가 안 보였기 때문이다. 지금은 headline 이 그 cd 접두사를
 * 걷어 내므로 첫 줄에 실제 명령이 온다 — 두 번째 줄을 쓸 이유가 사라졌다.
 *
 * 한 줄로 고정하면 도구 호출 하나의 높이가 일정해진다. 서브에이전트 스물 몇이
 * 동시에 말할 때 그 일정함이 화면을 읽히게 만든다(실측으로 그 화면이 "엉망"이었다).
 */
test("프로젝트 루트로 가는 cd 접두사는 걷어 낸다 — 아는 값이 40칸을 먹는다", () => {
  const root = "D:/AI/새 폴더/AX-NAVI";
  const head = headline("Bash", { command: `cd "${root}" && grep -rn TODO src` }, { root });
  assert.equal(head, "Bash(grep -rn TODO src)", head);
});

test("다른 곳으로 가는 cd 는 남긴다 — 그건 정보다", () => {
  const head = headline("Bash", { command: 'cd "D:/다른곳" && ls' }, { root: "D:/AI/새 폴더/AX-NAVI" });
  assert.ok(head.includes('cd "D:/다른곳"'), head);
});

test("호출은 한 줄로 끝난다 — 높이가 일정해야 읽힌다", () => {
  const lines = render({ tool: "Bash", input: { command: "x".repeat(2000) }, result: "ok", width: 80 });
  // 제목 1줄 + 결과 1줄
  assert.equal(lines.length, 2, `${lines.length}줄이나 됐다`);
  assert.ok((lines[0] ?? "").endsWith("…)"), "잘렸다는 표시가 없다");
});

test("어떤 폭에서도 줄이 폭을 넘지 않는다", () => {
  for (const width of [40, 80, 120]) {
    const lines = render({ tool: "Bash", input: { command: "가".repeat(500) }, result: "ok", width });
    for (const line of lines) assert.ok(visibleLength(line) < width, `폭 ${width}에서 ${visibleLength(line)}칸`);
  }
});

/* ---------- 인덱스 질의 ---------- */

/*
 * 그대로 보여 주면 옆으로 벌어진 JSON 의 앞 네 줄, 즉 `{ "query": { "q": ... }` 만 보인다.
 * 질문을 되풀이한 것이지 답이 아니다 — 실측으로 /flow 화면이 이걸로 덮였다.
 */
test("인덱스 질의는 몇 건 나왔고 첫 건이 무엇인지 보여 준다", () => {
  const body = JSON.stringify({
    query: { q: "수강신청" },
    items: [{ kind: "endpoint", id: "root::POST /TransData.do::FrontCourseApplyService.doApply" }, {}],
    total: 44,
  });
  const summary = summarizeResult("QueryIndex", body);
  assert.match(/** @type {string} */ (summary), /^44건/);
  assert.match(/** @type {string} */ (summary), /doApply/);
  assert.ok(!(/** @type {string} */ (summary)).includes('"query"'), "질문을 되풀이했다");
});

test("0건은 0건이라고 한다 — 빈 목록과 실패를 헷갈리면 안 된다", () => {
  assert.equal(summarizeResult("QueryIndex", JSON.stringify({ items: [], total: 0 })), "0건");
});

test("목록이 아닌 결과는 무엇이 들었는지 키로 알린다", () => {
  const summary = summarizeResult("QueryIndex", JSON.stringify({ tier: "Full", source_file_count: 4003 }));
  assert.match(/** @type {string} */ (summary), /tier/);
  assert.match(/** @type {string} */ (summary), /source_file_count/);
});

test("JSON 이 아니면 손대지 않는다", () => {
  assert.equal(summarizeResult("QueryIndex", "인덱스가 없다 (transactions)."), null);
});

test("실패는 요약하지 않는다 — 사유가 본문에 있다", () => {
  assert.equal(summarizeResult("QueryIndex", JSON.stringify({ items: [], total: 0 }), true), null);
});

test("잘린 결과에서도 몇 건인지 건져 낸다 — 위임 경로는 도구 결과를 2000자로 자른다", () => {
  const body = JSON.stringify({
    total: 384, returned: 50, truncated: 334,
    items: Array.from({ length: 50 }, () => ({ id: "eduport.common.login.action.LoginAction" })),
  }, null, 2);
  const summary = summarizeResult("QueryIndex", body.slice(0, 2000));
  assert.match(/** @type {string} */ (summary), /^384건/, `잘린 JSON 요약: ${summary}`);
  assert.match(/** @type {string} */ (summary), /LoginAction/);
});

test("숫자를 이어 붙이지 않는다 — total·returned·truncated 가 나란히 있다", () => {
  // 앞쪽 연속 숫자만 읽어야 한다. 전체에서 걸러 이으면 384+50+334 가 38450334 가 된다.
  const body = '{ "total": 384, "returned": 50, "truncated": 334, "items": [ { "id": "A" }';
  assert.match(/** @type {string} */ (summarizeResult("QueryIndex", body)), /^384건/);
});

test("건질 게 없으면 손대지 않는다", () => {
  assert.equal(summarizeResult("QueryIndex", '{ "query": { "q"'), null);
});

test("질문은 기록에 다시 찍지 않는다 — 선택기가 이미 남겼다", () => {
  const lines = render({ tool: "mcp__axnavi__AskUserQuestion", input: { question: "어떤 색?" }, result: "파랑" });
  assert.deepEqual(lines, [], `질문이 두 번 나온다: ${JSON.stringify(lines)}`);
});

test("질문이 실패하면 보여 준다 — 답을 못 받았는데 조용하면 안 된다", () => {
  const lines = render({
    tool: "mcp__axnavi__AskUserQuestion", input: { question: "어떤 색?" },
    result: "질문 통로가 끊겼다", isError: true,
  });
  assert.ok(lines.length > 0);
  assert.match(lines.join("\n"), /끊겼다/);
});
