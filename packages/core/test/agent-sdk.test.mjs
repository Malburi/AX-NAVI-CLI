/*
 * Agent SDK 연결부 검증.
 *
 * 실제 claude 로 확인한 사실(가짜 손잡이 시험, SDK 0.3.282):
 *   - 내장 AskUserQuestion 이 canUseTool 로 와서 우리 질문 함수가 답했고, 모델이 그 답을 썼다.
 *   - Write 승인과 서브에이전트 안의 Bash 승인이 모두 우리 판단기로 왔다.
 *   - 역할 지침(append 시스템 프롬프트)이 먹혔고, resume 한 다음 턴이 같은 세션에서 앞 답을 기억했다.
 *   - run_in_background:true 를 명시해도 훅이 포그라운드로 바꿔 결과가 그 자리에 돌아왔다.
 * 여기서는 그 연결을 만드는 순수 부품을 고정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerQuestions, foregroundAgents, sdkMcpServers } from "../../provider-agent-sdk/src/index.mjs";
import { toolBriefing } from "../../provider-claude-cli/src/index.mjs";

test("내장 질문을 우리 질문 화면으로 묻고, 답에는 레이블만 넣는다", async () => {
  /** @type {any[]} */
  const asked = [];
  const answers = await answerQuestions(
    { questions: [{ question: "구성?", header: "초기화 구성", options: [{ label: "단일", description: "한 저장소" }, { label: "페어" }], multiSelect: false }] },
    async (q, options, opts) => { asked.push({ q, options, opts }); return [options[0] ?? ""]; },
  );
  assert.deepEqual(asked[0].options, ["단일 — 한 저장소", "페어"], "설명을 화면에 함께 보여 주지 않았다");
  assert.equal(asked[0].opts.header, "초기화 구성");
  assert.deepEqual(answers, { "구성?": "단일" }, "화면용 글자를 답에 그대로 넣었다");
});

test("여러 개 고른 답은 쉼표로 잇고, 목록 밖 직접 입력은 그대로 둔다", async () => {
  const multi = await answerQuestions(
    { questions: [{ question: "무엇?", options: [{ label: "A" }, { label: "B" }], multiSelect: true }] },
    async (_q, options) => [options[0] ?? "", "직접 쓴 답"],
  );
  assert.deepEqual(multi, { "무엇?": "A, 직접 쓴 답" });
});

test("답이 비면 null — 기본값으로 넘어가지 않게 호출부가 거부로 돌린다", async () => {
  const none = await answerQuestions({ questions: [{ question: "?", options: [{ label: "A" }] }] }, async () => []);
  assert.equal(none, null);
});

test("뒤에서 돌리려는 서브에이전트만 포그라운드로 바꾼다", async () => {
  const changed = await foregroundAgents({ tool_input: { prompt: "p", subagent_type: "ax-navi:analyzer", run_in_background: true } });
  assert.deepEqual(/** @type {any} */ (changed).hookSpecificOutput.updatedInput, { prompt: "p", subagent_type: "ax-navi:analyzer", run_in_background: false });
  assert.deepEqual(await foregroundAgents({ tool_input: { prompt: "p" } }), {}, "포그라운드 호출을 건드렸다");
});

test("MCP 는 인덱스 조회와 스킬 요청만 내놓는다 — 질문·승인은 콜백이 받는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ax-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { axnavi: { command: "node", args: ["s.mjs"], env: { AXNAVI_ELICIT_ADDR: "x" } } } }));
    const servers = /** @type {any} */ (sdkMcpServers(path));
    assert.equal(servers.axnavi.env.AXNAVI_MCP_TOOLS, "QueryIndex,Skill");
    assert.equal(servers.axnavi.env.AXNAVI_ELICIT_ADDR, "x", "스킬 요청 통로를 지웠다");
    assert.deepEqual(sdkMcpServers(join(dir, "없음.json")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SDK 경로의 도구 안내는 내장 질문 도구를 없다고 말하지 않는다", () => {
  const tools = [{ name: "Read" }, { name: "AskUserQuestion" }];
  assert.match(toolBriefing(tools, false), /mcp__axnavi__AskUserQuestion/, "기존 경로는 그대로다");
  assert.doesNotMatch(toolBriefing(tools, false, { nativeAsk: true }), /AskUserQuestion 은 이 실행에 없다/);
});
