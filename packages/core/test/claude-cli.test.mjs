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
import { buildDelegatedArgs, flattenToolContent, toDisallowedTools, toolBriefing, translateEvent } from "../../provider-claude-cli/src/index.mjs";

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

/* ---------- 위임 배선 ---------- */

/*
 * 서브에이전트 팬아웃이 조용히 사라진 적이 있다.
 *
 * 오케스트레이터는 Agent(subagent_type="ax-navi:analyzer") 로 위임하는데, 위임된
 * claude 는 우리 agents/ 를 모르고 호스트 플러그인도 꺼 둔 상태였다. 그래서 전부
 *   Agent type 'ax-navi:feature-finder' not found.
 *   Available agents: claude, Explore, general-purpose, Plan, statusline-setup
 * 로 끝났고, 오케스트레이터가 혼자 다 했다. **화면에는 그냥 잘 도는 것처럼 보였다** —
 * 그래서 오래 눈에 띄지 않았다. 여기서 배선 자체를 고정한다.
 */

/**
 * 인자 조립만 보는 테스트라 도구는 이름만 있으면 된다.
 * @param {object} [over]
 * @returns {import("@ax-navi/core").SessionSpec}
 */
const spec = (over = {}) =>
  /** @type {any} */ ({ tier: "standard", system: "", tools: [{ name: "Read" }], ...over });

test("위임 실행에는 설치본을 플러그인으로 물린다 — 서브에이전트 이름이 여기서 나온다", () => {
  const args = buildDelegatedArgs(spec({ allowDelegation: true }), { pluginDir: "/opt/axnavi" }, null);
  const at = args.indexOf("--plugin-dir");
  assert.ok(at >= 0, "--plugin-dir 이 빠졌다 — ax-navi:* 이름이 전부 not found 가 된다");
  assert.equal(args[at + 1], "/opt/axnavi");
  assert.ok(args.includes("--forward-subagent-text"), "서브에이전트가 한 말이 화면에 안 온다");
});

test("위임하지 않는 실행에는 플러그인을 물리지 않는다", () => {
  /* 못 띄우는 역할에게 이름만 보여 주면 부르려다 한 턴을 날린다. */
  const args = buildDelegatedArgs(spec(), { pluginDir: "/opt/axnavi" }, null);
  assert.ok(!args.includes("--plugin-dir"));
  assert.ok(!args.includes("--forward-subagent-text"));
});

test("호스트 플러그인을 끄는 설정은 위임 여부와 무관하게 유지된다", () => {
  /* 예전 설치본이 끼어들면 어느 쪽이 돌았는지 화면에서 구분되지 않는다. */
  for (const delegation of [true, false]) {
    const args = buildDelegatedArgs(spec({ allowDelegation: delegation }), { pluginDir: "/opt/axnavi" }, "/tmp/s.json");
    const at = args.indexOf("--settings");
    assert.ok(at >= 0 && args[at + 1] === "/tmp/s.json", `delegation=${delegation} 에서 뮤트가 빠졌다`);
  }
});

test("위임할 수 있으면 그 사실을 모델에게 알린다", () => {
  /*
   * 안내문을 Gateway 도구 목록만으로 만들었더니 모델이 위임을 포기했다(실측):
   *   "서브에이전트 호출(Task/Agent) 도구가 이 실행 환경에 없어서 …
   *    대신 각 에이전트 정의 파일을 직접 읽어 역할을 확인하겠다"
   * 위임 도구는 Gateway 가 아니라 claude 자신이 가진 것이라 목록에 없었다.
   */
  const on = toolBriefing([{ name: "Read" }, { name: "Grep" }], true);
  assert.match(on, /Task/);
  assert.match(on, /ax-navi:/, "subagent_type 형식을 안 알려 주면 이름을 지어낸다");

  const off = toolBriefing([{ name: "Read" }, { name: "Grep" }], false);
  assert.ok(!/Task/.test(off), "못 쓰는 도구를 있다고 알렸다");
});
