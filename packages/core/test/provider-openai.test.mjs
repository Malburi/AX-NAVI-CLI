/*
 * OpenAI 호환 Provider — HNIX AX 게이트웨이·사내 로컬 모델 경로.
 * 진짜 HTTP 서버(SSE)를 띄워 스트리밍·도구 호출 조각 맞추기·오류 분류를 보고,
 * Core 루프에 물려 "도구 실행은 Gateway 가 한다"는 계약이 이 경로에서도 지켜지는지 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/loop.mjs";
import { ToolGateway } from "../src/tools/gateway.mjs";
import { createDefaultRegistry } from "../src/tools/builtin/index.mjs";
import { makeContext } from "./fake-provider.mjs";
import { OpenAiCompatProvider, httpError, openAiConfig, toOpenAiMessages } from "../../provider-openai/src/index.mjs";
import { selectProvider } from "../../cli/src/provider.mjs";

const NL = String.fromCharCode(10);

/**
 * 받은 요청을 기록하고, 준비한 응답을 차례로 돌려주는 가짜 게이트웨이.
 * 응답: { sse: object[] } 이면 SSE 로, { status, body } 면 그대로.
 * @param {Array<{ sse?: object[], status?: number, body?: string }>} replies
 */
async function gateway(replies) {
  /** @type {{ headers: import("node:http").IncomingHttpHeaders, body: any }[]} */
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ headers: req.headers, body: JSON.parse(raw) });
    const r = replies.shift() ?? { status: 500, body: "{}" };
    if (r.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const ev of r.sse) res.write(`data: ${JSON.stringify(ev)}${NL}${NL}`);
      res.end(`data: [DONE]${NL}${NL}`);
    } else {
      res.writeHead(r.status ?? 200, { "content-type": "application/json", "retry-after": "7" });
      res.end(r.body ?? "{}");
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((ok) => server.close(() => ok(undefined))) };
}

/** @param {any} config */
const provider = (config) => new OpenAiCompatProvider({ config });
const cfg = (/** @type {string} */ url) => ({ baseUrl: url, apiKey: "hx-test", models: { fast: "hnix-local", standard: "hnix-smart", deep: "hnix-deep" } });
const spec = { system: "너는 테스터다.", tools: [], tier: /** @type {const} */ ("standard") };

/** @param {AsyncIterable<any>} it */
async function collect(it) {
  const out = [];
  for await (const e of it) out.push(e);
  return out;
}

test("설정 — 주소가 없으면 꺼짐, 등급별 모델은 개별 지정 > 공통 > 기본 별칭", () => {
  assert.equal(openAiConfig({}), null);
  assert.equal(openAiConfig({ AXNAVI_OPENAI_BASE_URL: "ax:8700/v1" }), null, "http(s) 가 아니면 꺼짐");
  const c = openAiConfig({ AXNAVI_OPENAI_BASE_URL: "http://ax:8700/v1/", AXNAVI_OPENAI_MODEL: "qwen3", AXNAVI_OPENAI_MODEL_DEEP: "hnix-smart" });
  assert.deepEqual(c, { baseUrl: "http://ax:8700/v1", apiKey: null, models: { fast: "qwen3", standard: "qwen3", deep: "hnix-smart" } });
  assert.equal(openAiConfig({ AXNAVI_OPENAI_BASE_URL: "http://x/v1" })?.models.fast, "hnix-local");
  // 작은 로컬 모델은 문맥 크기를 낮춘다(10/25 리뷰)
  assert.equal(openAiConfig({ AXNAVI_OPENAI_BASE_URL: "http://x/v1", AXNAVI_OPENAI_CONTEXT_TOKENS: "32768" })?.contextTokens, 32768);
  assert.equal(openAiConfig({ AXNAVI_OPENAI_BASE_URL: "http://x/v1", AXNAVI_OPENAI_CONTEXT_TOKENS: "abc" })?.contextTokens, undefined);
});

test("메시지 변환 — 도구 결과는 role tool 로 바로 뒤에, 오류는 표시를 붙인다", () => {
  const msgs = toOpenAiMessages("시스템", [
    { role: "user", content: [{ type: "text", text: "a.txt 읽어" }] },
    { role: "assistant", content: [{ type: "text", text: "읽겠다." }, { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "없음", isError: true }] },
  ]);
  assert.deepEqual(msgs, [
    { role: "system", content: "시스템" },
    { role: "user", content: "a.txt 읽어" },
    { role: "assistant", content: "읽겠다.", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "[오류] 없음" },
  ]);
});

test("스트리밍 — 글자 조각, 여러 조각으로 온 도구 인자 맞추기, 사용량, 요청 헤더·모델", async () => {
  const gw = await gateway([{ sse: [
    { choices: [{ index: 0, delta: { role: "assistant", content: "확인" } }] },
    { choices: [{ index: 0, delta: { content: "하겠다." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Grep", arguments: '{"pat' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"TB_EMP"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 40 } } },
  ] }]);
  try {
    const p = provider(cfg(gw.url));
    const s = await p.createSession({ ...spec, tier: "deep", tools: [{ name: "Grep", description: "검색", inputSchema: { type: "object" }, mutates: false }] });
    const events = await collect(s.run([{ role: "user", content: [{ type: "text", text: "TB_EMP 찾아" }] }]));
    assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => e.text), ["확인", "하겠다."]);
    assert.deepEqual(events.find((e) => e.type === "tool_use"), { type: "tool_use", id: "call_9", name: "Grep", input: { pattern: "TB_EMP" } });
    assert.deepEqual(events.find((e) => e.type === "usage")?.usage, { inputTokens: 120, outputTokens: 15, cacheReadTokens: 40, cacheWriteTokens: 0 });
    const end = events.find((e) => e.type === "turn_end");
    assert.equal(end.stopReason, "tool_use");
    assert.equal(end.content.length, 2);
    assert.equal(events.at(-1).type, "done");
    const req = gw.seen[0];
    assert.equal(req?.headers.authorization, "Bearer hx-test");
    assert.equal(req?.headers["x-hnix-client"], "axnavi");
    assert.equal(req?.body.model, "hnix-deep");
    assert.equal(req?.body.stream, true);
    assert.deepEqual(req?.body.stream_options, { include_usage: true });
    assert.deepEqual(req?.body.tools[0], { type: "function", function: { name: "Grep", description: "검색", parameters: { type: "object" } } });
  } finally {
    await gw.close();
  }
});

test("오류 — 인증·예산·문맥 초과·5xx 분류, 연결 실패, 깨진 도구 인자", async () => {
  assert.equal(httpError(401, "키").kind, "auth");
  assert.deepEqual(httpError(429, "예산 초과", "7"), { kind: "budget", message: "게이트웨이 429: 예산 초과", retryable: false, retryAfterMs: 7000 });
  assert.equal(httpError(429, "rpm").kind, "rate_limit");
  assert.equal(httpError(400, "maximum context length exceeded").kind, "context_overflow");
  assert.equal(httpError(502, "upstream").retryable, true);

  const gw = await gateway([
    { status: 403, body: JSON.stringify({ error: { message: "이 키로 쓸 수 없는 별칭" } }) },
    { sse: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "Read", arguments: '{"file_' } }] }, finish_reason: "length" }] }] },
  ]);
  try {
    const p = provider(cfg(gw.url));
    const denied = await collect((await p.createSession(spec)).run([{ role: "user", content: [{ type: "text", text: "x" }] }]));
    assert.equal(denied.at(-1).type, "error");
    assert.equal(denied.at(-1).error.kind, "auth");
    assert.match(denied.at(-1).error.message, /이 키로 쓸 수 없는 별칭/);
    const broken = await collect((await p.createSession(spec)).run([{ role: "user", content: [{ type: "text", text: "x" }] }]));
    assert.match(broken.at(-1).error.message, /도구 인자가 JSON 이 아니다\(Read\)/);
  } finally {
    await gw.close();
  }
  const down = await collect((await provider(cfg("http://127.0.0.1:9/v1")).createSession(spec)).run([{ role: "user", content: [{ type: "text", text: "x" }] }]));
  assert.equal(down.at(-1).error.kind, "network");
  assert.match(down.at(-1).error.message, /127\.0\.0\.1:9/);
});

test("Core 루프에 물리면 도구는 Gateway 가 실행하고 결과가 role tool 로 되돌아간다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axoai-"));
  await writeFile(join(dir, "a.txt"), "첫째 줄" + NL, "utf8");
  const gw = await gateway([
    { sse: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] }, finish_reason: "tool_calls" }] }] },
    { sse: [{ choices: [{ index: 0, delta: { content: "한 줄이다." }, finish_reason: "stop" }] }] },
  ]);
  try {
    const agent = { name: "tester", description: "", tier: /** @type {const} */ ("fast"), systemPrompt: "너는 테스터다.", sourcePath: "(test)", warnings: [],
      role: { name: "tester", allowedTools: ["Read"], allowMutations: false } };
    const registry = createDefaultRegistry();
    const { ctx } = makeContext(dir, agent.role);
    const events = [];
    const gen = runAgent({ provider: provider(cfg(gw.url)), agent, registry, gateway: new ToolGateway(registry), ctx, userPrompt: "a.txt 읽어" });
    let r = await gen.next();
    while (!r.done) { events.push(r.value); r = await gen.next(); }
    assert.equal(r.value.stopReason, "end_turn");
    assert.match(events.find((e) => e.type === "tool_result")?.result ?? "", /첫째 줄/);
    const second = gw.seen[1]?.body;
    assert.equal(second.model, "hnix-local", "fast 등급");
    const toolMsg = second.messages.find((/** @type {any} */ m) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "r1");
    assert.match(toolMsg.content, /첫째 줄/);
    assert.deepEqual(second.tools.map((/** @type {any} */ t) => t.function.name), ["Read"], "역할이 허용한 도구만 넘긴다");
  } finally {
    await gw.close();
  }
});

test("선택 — --provider openai 또는 AXNAVI_PROVIDER, 주소가 없으면 무엇이 없는지 말한다", () => {
  const keep = { p: process.env.AXNAVI_PROVIDER, u: process.env.AXNAVI_OPENAI_BASE_URL };
  try {
    delete process.env.AXNAVI_OPENAI_BASE_URL;
    const none = selectProvider({ provider: "openai" });
    assert.ok("error" in none && /AXNAVI_OPENAI_BASE_URL/.test(none.error));
    process.env.AXNAVI_OPENAI_BASE_URL = "http://ax.local:8700/v1";
    process.env.AXNAVI_PROVIDER = "openai";
    const picked = selectProvider({});
    assert.ok(!("error" in picked));
    assert.equal(picked.provider.id, "openai");
    assert.match(picked.short, /^openai · hnix-smart$/);
    assert.equal(picked.provider.capabilities.ownsAgentLoop, false);
  } finally {
    if (keep.p === undefined) delete process.env.AXNAVI_PROVIDER; else process.env.AXNAVI_PROVIDER = keep.p;
    if (keep.u === undefined) delete process.env.AXNAVI_OPENAI_BASE_URL; else process.env.AXNAVI_OPENAI_BASE_URL = keep.u;
  }
});
