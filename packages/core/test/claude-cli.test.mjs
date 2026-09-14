/*
 * claude CLI Provider의 순수 함수 검증.
 *
 * 프로세스를 띄우는 부분은 여기서 테스트하지 않는다(구독 호출은 실제 비용이 든다).
 * 대신 계약의 핵심인 두 변환을 고정한다.
 *   - 역할 → --disallowedTools   : 통제 주체가 옮겨가도 불변식은 유지되는가
 *   - stream-json → ProviderEvent: 실측한 이벤트 형태를 정확히 옮기는가
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenToolContent, toDisallowedTools, translateEvent } from "@ax-navi/provider-claude-cli";

/** @param {string[]} names */
const tools = (names) =>
  names.map((name) => ({ name, description: "", inputSchema: { type: "object" }, mutates: name === "Write" }));

test("읽기 전용 역할이면 수정 도구가 전부 꺼진다", () => {
  const off = toDisallowedTools(tools(["Read", "Grep", "Glob", "Bash"]));
  for (const name of ["Edit", "MultiEdit", "NotebookEdit", "Write"]) {
    assert.ok(off.includes(name), `${name}이 꺼져야 한다`);
  }
});

test("Write를 허용한 역할이면 Write는 남고 Edit 계열만 꺼진다", () => {
  // 저장소의 13개 에이전트가 바로 이 형태다 — 리포트를 쓰되 소스는 고치지 않는다.
  const off = toDisallowedTools(tools(["Read", "Grep", "Glob", "Bash", "Write"]));
  assert.ok(!off.includes("Write"), "Write는 살아 있어야 한다");
  for (const name of ["Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(off.includes(name), `${name}이 꺼져야 한다`);
  }
});

test("우리 계약 밖의 claude 기능은 역할과 무관하게 꺼진다", () => {
  const off = toDisallowedTools(tools(["Read", "Grep", "Glob", "Bash", "Write"]));
  // Task/Skill은 관측할 수 없는 서브에이전트를 띄우고, Web* 는 컨텍스트를 외부로 보낸다.
  for (const name of ["Task", "Skill", "WebSearch", "WebFetch"]) {
    assert.ok(off.includes(name), `${name}이 꺼져야 한다`);
  }
});

test("assistant 이벤트에서 텍스트와 도구 호출을 뽑는다", () => {
  const events = translateEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "읽어보겠다." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.java" } },
      ],
    },
  });
  assert.deepEqual(events[0], { type: "text_delta", text: "읽어보겠다." });
  assert.equal(events[1]?.type, "tool_use");
  assert.equal(/** @type {any} */ (events[1]).name, "Read");
});

test("user 이벤트의 tool_result를 옮기고 길이를 제한한다", () => {
  const events = translateEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) }] },
  });
  assert.equal(events[0]?.type, "tool_result");
  assert.equal(/** @type {any} */ (events[0]).content.length, 2000);
  assert.equal(/** @type {any} */ (events[0]).isError, false);
});

test("result 이벤트에서 실제 비용을 싣는다 — 추정치가 아니다", () => {
  const events = translateEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0.1837,
    usage: { input_tokens: 16, output_tokens: 2315, cache_read_input_tokens: 197483 },
    permission_denials: [],
  });
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage);
  assert.equal(/** @type {any} */ (usage).usage.costUsd, 0.1837);
  assert.equal(/** @type {any} */ (usage).usage.cacheReadTokens, 197483);
  assert.ok(events.some((e) => e.type === "turn_end"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("권한 거부를 조용히 넘기지 않는다", () => {
  const events = translateEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: {},
    permission_denials: [{ tool_name: "Edit" }, { tool_name: "Write" }],
  });
  const denial = events.find((e) => e.type === "tool_result");
  assert.ok(denial, "거부가 보고되지 않았다");
  assert.match(/** @type {any} */ (denial).content, /Edit/);
  assert.equal(/** @type {any} */ (denial).isError, true);
});

test("실패로 끝난 실행을 성공으로 옮기지 않는다", () => {
  const events = translateEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "무언가 실패",
    usage: {},
  });
  assert.ok(events.some((e) => e.type === "error"));
  assert.ok(!events.some((e) => e.type === "done"), "done이 나오면 안 된다");
});

test("서브에이전트 호출은 기본으로 꺼져 있다", () => {
  const off = toDisallowedTools(tools(["Read", "Grep", "Glob", "Bash", "Write"]));
  assert.ok(off.includes("Task"), "관측할 수 없는 실행을 기본으로 열어 두면 안 된다");
});

test("오케스트레이터가 요청하면 서브에이전트를 연다", () => {
  // harness-init 같은 절차는 여러 전문 에이전트를 부르는 것이 본체라, 막으면 성립하지 않는다.
  const off = toDisallowedTools(tools(["Read", "Grep", "Glob", "Bash", "Write"]), true);
  assert.ok(!off.includes("Task"), "Task가 여전히 막혀 있다");
  // 열어 주는 것은 Task 하나뿐 — 나머지 계약 밖 기능은 그대로 닫혀 있어야 한다.
  for (const name of ["Skill", "WebSearch", "WebFetch"]) {
    assert.ok(off.includes(name), `${name}까지 열렸다`);
  }
});

test("MCP 도구 결과의 봉투를 벗겨 낸다", () => {
  // 그대로 찍으면 화면에 JSON 봉투가 보이고 정작 내용은 이스케이프된 채로 묻힌다.
  const wrapped = [{ type: "text", text: '{"tier":"Full"}' }];
  assert.equal(flattenToolContent(wrapped), '{"tier":"Full"}');
  assert.equal(flattenToolContent("그냥 문자열"), "그냥 문자열");
});

test("텍스트가 아닌 블록이 섞이면 원형을 보여 준다 — 조용히 버리지 않는다", () => {
  const mixed = [{ type: "text", text: "가" }, { type: "image", data: "..." }];
  assert.match(flattenToolContent(mixed), /image/);
});

test("도구 결과에서도 봉투가 벗겨진 채로 전달된다", () => {
  const events = translateEvent({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "결과 본문" }] }],
    },
  });
  assert.equal(/** @type {any} */ (events[0]).content, "결과 본문");
});
