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
import { BACKGROUND_WAIT_CEILING_MS, buildDelegatedArgs, createBackgroundWatch, delegatedEnv, delegatedPayload, delegatedSettings, flattenToolContent, toDisallowedTools, toolBriefing, translateEvent } from "../../provider-claude-cli/src/index.mjs";

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

/* ---------- 중단해도 이어붙기 ---------- */

/*
 * 사용자가 /find 를 59초에 끊고 "계속 해줘" 라고 했더니 앞 맥락이 없다고 답했다.
 *
 * 원인은 세션 식별자를 result 이벤트에서만 받았던 것이다. 중단하면 result 가 오지
 * 않으니 이어 붙일 id 가 없고, 그 대화는 통째로 사라진다. claude 는 맨 첫 메시지부터
 * session_id 를 주므로 거기서 받는다.
 */
test("세션 식별자를 스트림 첫머리에서 받는다 — 중단돼도 이어붙일 수 있어야 한다", () => {
  const events = translateEvent({
    type: "system",
    subtype: "hook_started",
    session_id: "2aa9797c-7787-4946-acaf-e1db324c4b99",
  });
  const session = events.find((e) => e.type === "session");
  assert.ok(session, "첫머리에서 세션을 못 받았다 — 중단하면 대화가 사라진다");
  assert.equal(/** @type {any} */ (session).id, "2aa9797c-7787-4946-acaf-e1db324c4b99");
});

test("assistant 메시지마다 세션을 다시 내보내지는 않는다", () => {
  /* 매 메시지마다 같은 값을 흘리면 이벤트가 본문보다 많아진다. */
  const events = translateEvent({
    type: "assistant",
    session_id: "s1",
    message: { content: [{ type: "text", text: "가" }] },
  });
  assert.ok(!events.some((e) => e.type === "session"));
});

test("result 에서도 여전히 받는다 — 첫머리를 놓친 경우의 마지막 기회다", () => {
  const events = translateEvent({ type: "result", subtype: "success", session_id: "s2", usage: {} });
  assert.ok(events.some((e) => e.type === "session" && /** @type {any} */ (e).id === "s2"));
});

test("백그라운드 대기 상한을 넉넉히 준다 — 기본 10분이면 레거시 Full 분석의 analyzer 가 죽는다", () => {
  const env = delegatedEnv({ PATH: "x" }, { pluginDir: "C:/p" });
  assert.equal(env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"], BACKGROUND_WAIT_CEILING_MS);
  assert.ok(Number(BACKGROUND_WAIT_CEILING_MS) > 10 * 60 * 1000);
  assert.equal(env["CLAUDE_PLUGIN_ROOT"], "C:/p");
});

test("사용자가 정한 대기 상한은 덮어쓰지 않는다", () => {
  const env = delegatedEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "5000" }, {});
  assert.equal(env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"], "5000");
});

test("상한에 걸려 죽은 백그라운드 작업을 가려낸다 — claude 의 result 는 success 여도", () => {
  // 실측 스트림 모양(상한 5초·45초 작업): task_started → task_updated(killed) → task_notification(stopped) → result success
  const watch = createBackgroundWatch();
  watch.observe({ type: "system", subtype: "task_started", task_id: "a1", description: "B-A · analyzer", is_backgrounded: true, task_type: "local_agent" });
  watch.observe({ type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "killed" } });
  watch.observe({ type: "system", subtype: "task_notification", task_id: "a1", status: "stopped" });
  watch.observe({ type: "result", subtype: "success" });
  assert.deepEqual(watch.unfinished(), ["B-A · analyzer"]);
});

test("모델이 스스로 TaskStop 으로 멈춘 작업은 미완료로 보지 않는다", () => {
  const watch = createBackgroundWatch();
  watch.observe({ type: "system", subtype: "task_started", task_id: "a2", description: "x", task_type: "local_agent" });
  watch.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "TaskStop", input: { task_id: "a2" } }] } });
  watch.observe({ type: "system", subtype: "task_updated", task_id: "a2", patch: { status: "killed" } });
  assert.deepEqual(watch.unfinished(), []);
});

test("정상으로 끝난 백그라운드 작업은 미완료가 아니다", () => {
  const watch = createBackgroundWatch();
  watch.observe({ type: "system", subtype: "task_started", task_id: "a3", description: "y", task_type: "local_agent" });
  watch.observe({ type: "system", subtype: "task_updated", task_id: "a3", patch: { status: "completed" } });
  assert.deepEqual(watch.unfinished(), []);
});

test("지연 로딩되는 내장 AskUserQuestion 을 끈다 — 안 끄면 질문이 권한 창으로 뜬다", () => {
  const disallowed = toDisallowedTools(tools(["Read", "AskUserQuestion"]), true);
  assert.ok(disallowed.includes("AskUserQuestion"), JSON.stringify(disallowed));
  assert.ok(disallowed.includes("EnterPlanMode") && disallowed.includes("ExitPlanMode"));
});

test("질문 도구의 실제 이름을 모델에게 알린다", () => {
  const text = toolBriefing(tools(["Read", "AskUserQuestion"]), true);
  assert.match(text, /mcp__axnavi__AskUserQuestion/);
});

test("백그라운드 셸 명령이 정리된 것은 미완료가 아니다 — 서브에이전트만 본다", () => {
  const watch = createBackgroundWatch();
  watch.observe({ type: "system", subtype: "task_started", task_id: "b1", description: "find / -iname now_kst.py", task_type: "local_bash" });
  watch.observe({ type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "killed" } });
  assert.deepEqual(watch.unfinished(), []);
});

test("MCP 도구 무응답 제한을 끈다 — 승인 창이 30분 뒤 끊기면 그 명령이 실패한다", () => {
  assert.equal(delegatedEnv({}, {})["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"], "0");
  assert.equal(delegatedEnv({ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "60000" }, {})["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"], "60000", "사용자 값은 존중");
});

test("위임 실행에서는 서브에이전트를 백그라운드로 띄우지 말라고 알린다", () => {
  assert.match(toolBriefing(tools(["Read"]), true), /run_in_background 로 띄우지 마라/);
  assert.doesNotMatch(toolBriefing(tools(["Read"]), false), /run_in_background/, "위임이 없는 실행에는 필요 없다");
});

/*
 * 백그라운드 서브에이전트는 훅으로 포그라운드로 바꾼다. 안내문은 지침일 뿐이었다.
 * 실측: 훅 없이 run_in_background:true → "Async agent launched", 훅 있으면 is_backgrounded:false.
 */
test("위임 설정은 서브에이전트 호출에 포그라운드 훅을 걸고, 호스트 플러그인을 끈다", () => {
  const s = delegatedSettings(["ax-navi@x", "total-ito@y"], "node hook.mjs");
  assert.deepEqual(s.enabledPlugins, { "ax-navi@x": false, "total-ito@y": false });
  assert.equal(s.hooks.PreToolUse[0]?.matcher, "Agent");
  assert.equal(s.hooks.PreToolUse[0]?.hooks[0]?.command, "node hook.mjs");
  assert.ok(!("enabledPlugins" in delegatedSettings([], "x")), "끌 플러그인이 없는데 빈 목록을 넣었다");
});

test("포그라운드 훅은 뒤에서 돌리려는 호출만 바꾸고 나머지 인자는 보존한다", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../../provider-claude-cli/src/foreground-agent-hook.mjs", import.meta.url));
  const run = (/** @type {object} */ event) =>
    spawnSync(process.execPath, [script], { input: JSON.stringify(event), encoding: "utf8" }).stdout;

  const out = JSON.parse(run({ tool_name: "Agent", tool_input: { prompt: "p", subagent_type: "ax-navi:analyzer", run_in_background: true } }));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { prompt: "p", subagent_type: "ax-navi:analyzer", run_in_background: false });

  assert.equal(run({ tool_name: "Agent", tool_input: { prompt: "p" } }), "", "포그라운드 호출까지 건드렸다");
  assert.equal(spawnSync(process.execPath, [script], { input: "깨진 입력", encoding: "utf8" }).stdout, "", "입력이 깨지면 조용히 비켜야 한다");
});

/*
 * 실측: 이어 가는 턴마다 도구 안내·역할 지침 3KB가 다시 실려 같은 덩어리가 16번 쌓였다.
 */
test("이어 가는 턴에는 이미 전한 안내를 다시 붙이지 않는다 — 바뀐 안내는 보낸다", () => {
  const sent = new Map([["s1", "안내A"]]);
  assert.equal(delegatedPayload("안내A", "질문", undefined, sent), "안내A\n\n질문", "새 대화에는 안내가 필요하다");
  assert.equal(delegatedPayload("안내A", "질문", "s1", sent), "질문", "같은 안내를 다시 붙였다");
  assert.equal(delegatedPayload("안내B", "질문", "s1", sent), "안내B\n\n질문", "도구·역할이 바뀐 턴인데 안내를 뺐다");
  assert.equal(delegatedPayload("안내A", "질문", "모르는세션", sent), "안내A\n\n질문", "처음 보는 세션인데 안내를 뺐다");
});

/*
 * 실측(윈도우 cp949): validator_checks.py 가 node 출력을 읽다 UnicodeDecodeError,
 * 모델의 python -c "print(...)" 가 '—' 를 찍다 UnicodeEncodeError.
 */
test("위임 실행의 파이썬은 UTF-8 모드로 돈다 — 사용자가 정한 값은 따른다", () => {
  assert.equal(delegatedEnv({}, {})["PYTHONUTF8"], "1");
  assert.equal(delegatedEnv({ PYTHONUTF8: "0" }, {})["PYTHONUTF8"], "0");
});

/*
 * 실측(SDK harness-init, 비대화형): 답을 못 받은 질문이 "AskUserQuestion — 이 실행에서 허용되지 않은
 * 도구다" 로 찍혔다. 질문은 막힌 것이 아니라 답을 못 받은 것이다.
 */
test("답을 못 받은 질문은 권한 거부와 따로, 사실대로 알린다", () => {
  const events = translateEvent({
    type: "result", subtype: "success", is_error: false, usage: {},
    permission_denials: [{ tool_name: "AskUserQuestion" }, { tool_name: "Edit" }, { tool_name: "Edit" }],
  });
  const results = /** @type {any[]} */ (events.filter((e) => e.type === "tool_result"));
  const unanswered = results.find((e) => e.toolName === "답 없음");
  const denied = results.find((e) => e.toolName === "권한 거부");
  assert.match(unanswered.content, /질문 1건에 답을 받지 못했다/);
  assert.match(denied.content, /Edit ×2/);
  assert.doesNotMatch(denied.content, /AskUserQuestion/, "질문을 권한 거부에 섞었다");
  const onlyQuestion = translateEvent({ type: "result", subtype: "success", is_error: false, usage: {}, permission_denials: [{ tool_name: "AskUserQuestion" }] });
  assert.ok(!onlyQuestion.some((e) => /** @type {any} */ (e).toolName === "권한 거부"), "질문만 막혔는데 권한 거부를 찍었다");
});

/*
 * 실측(harness-init Phase 1): 안내문에 TaskUpdate 만 있어 모델이 "TaskCreate 가 없는 런타임"이라며
 * 파일 체크리스트로 대신했다. 세션에는 TaskCreate·TaskGet·TaskList·TaskUpdate 가 다 열려 있었다.
 */
test("도구 안내는 작업 목록 도구 넷을 모두 보여 준다", () => {
  const text = toolBriefing([{ name: "Read" }, { name: "TaskUpdate" }], true);
  for (const name of ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]) assert.match(text, new RegExp(name));
});
