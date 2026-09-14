/*
 * 에이전트 루프 — Provider 없이도 돈다.
 *
 * 여기가 브리프 §17의 "모델 종속 Core 금지"를 실행으로 확인하는 자리다.
 * FakeProvider로 전 구간이 돌아간다는 것은 Core에 Claude가 스며들지 않았다는 뜻이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/loop.mjs";
import { ToolGateway } from "../src/tools/gateway.mjs";
import { createDefaultRegistry } from "../src/tools/builtin/index.mjs";
import { FakeProvider, makeContext } from "./fake-provider.mjs";

const AGENT = {
  name: "tester",
  description: "테스트용",
  tier: /** @type {const} */ ("standard"),
  systemPrompt: "너는 테스터다.",
  sourcePath: "(test)",
  warnings: [],
  role: { name: "tester", allowedTools: ["Read", "Grep", "Glob"], allowMutations: false },
};

/** @param {AsyncGenerator<any, any>} gen */
async function drain(gen) {
  /** @type {any[]} */
  const events = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

test("도구 없이 한 턴에 끝난다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([{ text: "안녕" }]);
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "안녕?" }),
  );

  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((e) => e.type === "text" && e.text === "안녕"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("도구 호출 → Gateway 실행 → 결과 되먹임 → 종료", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  await writeFile(join(dir, "a.txt"), "첫째 줄\n둘째 줄\n", "utf8");
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([
    { toolCalls: [{ id: "c1", name: "Read", input: { file_path: "a.txt" } }] },
    { text: "파일에 두 줄이 있다." },
  ]);
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "a.txt 읽어" }),
  );

  assert.equal(result.stopReason, "end_turn");
  const toolResult = events.find((e) => e.type === "tool_result");
  assert.ok(toolResult, "도구 결과 이벤트가 없다");
  assert.match(toolResult.result, /첫째 줄/);

  // Core가 결과를 다음 턴 대화에 실어 보냈는지 — 루프의 핵심 계약
  const secondTurn = provider.received[1];
  assert.ok(secondTurn, "두 번째 턴이 없다");
  const last = secondTurn.at(-1);
  assert.ok(last, "마지막 턴이 없다");
  assert.equal(last.role, "user");
  const block = last.content[0];
  assert.ok(block && block.type === "tool_result", "tool_result 블록이 아니다");
  assert.equal(block.toolUseId, "c1");
});

test("거부된 도구도 결과로 되먹여 모델이 스스로 고치게 한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([
    { toolCalls: [{ id: "c1", name: "Write", input: { file_path: "x", content: "y" } }] },
    { text: "쓰기 권한이 없어 읽기로 대신했다." },
  ]);
  const registry = createDefaultRegistry();

  const { events } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "파일 써줘" }),
  );

  const toolResult = events.find((e) => e.type === "tool_result");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.result, /허용되지 않은 도구/);
  // 예외로 죽지 않고 다음 턴이 돌아야 한다
  assert.equal(provider.received.length, 2);
});

test("Provider가 자체 루프를 돌면 거부한다 — Gateway가 통제점이 아니게 되므로", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([{ text: "무시됨" }], { ownsAgentLoop: true });
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "x" }),
  );

  assert.equal(result.stopReason, "refusal");
  const error = events.find((e) => e.type === "error");
  assert.match(error.reason, /ownsAgentLoop/);
  assert.equal(provider.received.length, 0, "호출조차 하지 말았어야 한다");
});

test("최대 턴에 걸리면 완료로 보고하지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  await writeFile(join(dir, "a.txt"), "x", "utf8");
  const { ctx } = makeContext(dir, AGENT.role);
  // 매 턴 도구를 부르기만 하고 끝내지 않는 Provider
  const provider = new FakeProvider(
    Array.from({ length: 5 }, () => ({ toolCalls: [{ id: "c", name: "Read", input: { file_path: "a.txt" } }] })),
  );
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({
      provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx,
      userPrompt: "무한", maxTurns: 3,
    }),
  );

  assert.equal(result.stopReason, "max_turns");
  assert.ok(events.some((e) => e.type === "error" && /최대 턴/.test(e.reason)));
});

test("Provider 오류가 조용히 성공으로 바뀌지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([
    { error: { kind: "rate_limit", message: "너무 잦다", retryable: true } },
  ]);
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "x" }),
  );

  assert.equal(result.stopReason, "error");
  assert.ok(events.some((e) => e.type === "error" && /rate_limit/.test(e.reason)));
});

test("역할 도구 목록이 SessionSpec으로 전달된다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([{ text: "ok" }]);
  const registry = createDefaultRegistry();

  await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "x" }),
  );

  const names = (provider.lastSpec?.tools ?? []).map((t) => t.name);
  assert.deepEqual(names.sort(), ["Glob", "Grep", "Read"]);
  assert.equal(provider.lastSpec?.system, AGENT.systemPrompt);
  assert.equal(provider.lastSpec?.tier, "standard");
});

test("runDelegated가 있으면 위임 실행되고 통제 이전을 알린다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, AGENT.role);
  const provider = new FakeProvider([], { ownsAgentLoop: true });
  /** 위임 Provider 흉내 — claude CLI 자리를 대신한다. */
  provider.runDelegated = async function* (/** @type {any} */ spec) {
    yield { type: "text_delta", text: `도구 ${spec.tools.length}종을 받았다` };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.05 } };
    yield { type: "turn_end", stopReason: "end_turn", content: [] };
  };
  const registry = createDefaultRegistry();

  const { events, result } = await drain(
    runAgent({ provider, agent: AGENT, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "x" }),
  );

  assert.equal(result.stopReason, "end_turn");
  // 통제 주체가 옮겨간 사실이 이벤트로 드러나야 한다 — 조용히 넘어가면 안 된다.
  const notice = events.find((e) => e.type === "delegated");
  assert.ok(notice, "delegated 이벤트가 없다");
  assert.match(notice.reason, /Gateway가 아니라/);
  // 역할이 허용한 도구 목록은 그대로 전달된다.
  assert.ok(events.some((e) => e.type === "text" && /3종/.test(e.text)));
  // 비용도 정규화돼 올라온다.
  const usage = events.find((e) => e.type === "usage");
  assert.equal(usage.usage.costUsd, 0.05);
});
