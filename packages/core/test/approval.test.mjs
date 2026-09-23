/*
 * 도구 사용 승인 — 플러그인처럼 "허용할까요?" 를 묻는다.
 *
 * 실측 사고: 위임 실행(`claude -p`)에는 승인해 줄 사람이 없어서 기본 설정 PC 에서
 * Write 가 거부되고 파일이 안 생겼다. 개발 PC 는 `defaultMode: auto` 라 안 드러났다.
 *
 * 여기서 지킬 선
 * - 답이 없으면 **거부**다. 묻지도 못했는데 허용하면 이 장치가 있는 이유가 없다.
 * - "이번 세션 동안 묻지 않음" 은 **턴을 넘어** 산다. 플러그인이 그렇다.
 * - Bash 는 명령 이름 단위로 기억한다. `npm` 을 허용했다고 `rm` 이 열리면 안 된다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { approvalKey, createApprover, describeToolUse } from "../../cli/src/approval.mjs";
import { startElicitHost } from "../../cli/src/mcp/host.mjs";
import { APPROVE_TOOL, buildDelegatedArgs } from "../../provider-claude-cli/src/index.mjs";

/**
 * 정해 둔 답을 차례로 내놓는 가짜 사람. 무엇을 물었는지도 적어 둔다.
 * @param {string[][]} replies
 */
function scripted(replies) {
  /** @type {Array<{ question: string, options: string[], header?: string }>} */
  const asked = [];
  return {
    asked,
    /** @type {(q: string, o: string[], opts: { header?: string }) => Promise<string[]>} */
    ask: async (question, options, opts) => {
      asked.push({ question, options, ...(opts.header ? { header: opts.header } : {}) });
      return replies.shift() ?? [];
    },
  };
}

test("Bash 는 명령 이름 단위로 기억한다 — npm 을 허용했다고 rm 이 열리면 안 된다", () => {
  assert.equal(approvalKey("Bash", { command: "npm test" }), "Bash(npm)");
  assert.equal(approvalKey("Bash", { command: "  rm -rf dist" }), "Bash(rm)");
  assert.equal(approvalKey("Bash", {}), "Bash");
});

test("파일을 바꾸는 도구는 한 묶음이다", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(approvalKey(tool, {}), "파일 수정", tool);
  }
});

test("무엇을 하려는지 한 줄로 보여 준다 — 긴 내용에 경로가 묻히지 않게", () => {
  const line = describeToolUse("Write", { file_path: "C:\\p\\CLAUDE.md", content: "x".repeat(5000) });
  assert.equal(line, "Write  C:\\p\\CLAUDE.md");
  assert.equal(describeToolUse("Bash", { command: "node build-index.mjs\n  --root ." }), "Bash  node build-index.mjs --root .");
  assert.ok(describeToolUse("Bash", { command: "a".repeat(500) }).length <= 170, "긴 명령은 자른다");
});

test("'예' 는 이번 한 번만 허용한다", async () => {
  const person = scripted([["예"], ["예"]]);
  const approver = createApprover({ ask: person.ask });
  const input = { file_path: "a.md", content: "x" };

  assert.deepEqual(await approver.decide("Write", input), { behavior: "allow", updatedInput: input });
  await approver.decide("Write", input);
  assert.equal(person.asked.length, 2, "한 번 허용이 다음까지 이어졌다");
  assert.equal(person.asked[0]?.header, "권한");
  assert.match(person.asked[0]?.question ?? "", /Write {2}a\.md/);
});

test("'이번 세션 동안 묻지 않음' 은 턴을 넘어 산다", async () => {
  /** 호출부(execute.mjs)가 쥐고 있는 기억. 턴마다 판단기는 새로 만든다. */
  const always = new Set();
  const first = scripted([["예, 이번 세션 동안 파일 수정은(는) 묻지 않음"]]);
  await createApprover({ ask: first.ask, always }).decide("Write", { file_path: "a.md" });

  const second = scripted([]);
  const decision = await createApprover({ ask: second.ask, always }).decide("Edit", { file_path: "b.md" });
  assert.equal(decision.behavior, "allow");
  assert.equal(second.asked.length, 0, "다음 턴에 또 물었다");
});

test("세션 허용은 그 묶음만 연다", async () => {
  const always = new Set();
  const person = scripted([["예, 이번 세션 동안 Bash(npm)은(는) 묻지 않음"], ["아니오"]]);
  const approver = createApprover({ ask: person.ask, always });
  await approver.decide("Bash", { command: "npm test" });

  const rm = await approver.decide("Bash", { command: "rm -rf dist" });
  assert.equal(rm.behavior, "deny", "npm 허용이 rm 까지 열었다");
  assert.equal(person.asked.length, 2);
});

test("'아니오' 는 거부하고, 우회하지 말라고 알린다", async () => {
  const decision = await createApprover({ ask: scripted([["아니오"]]).ask }).decide("Bash", { command: "rm -rf /" });
  assert.equal(decision.behavior, "deny");
  assert.match(/** @type {{ message: string }} */ (decision).message, /우회하지 말고/);
});

test("답이 없으면 거부다 — 묻지도 못했는데 허용하면 안 된다", async () => {
  const silent = await createApprover({ ask: scripted([]).ask }).decide("Write", { file_path: "a" });
  assert.equal(silent.behavior, "deny");

  const broken = await createApprover({ ask: async () => { throw new Error("TTY 없음"); } }).decide("Write", {});
  assert.equal(broken.behavior, "deny");
});

test("허용·거부를 기록에 남긴다 — 누가 이 파일을 쓰게 했는지는 나중에 반드시 묻는다", async () => {
  /** @type {Array<{ tool: string, allowed: boolean, how: string }>} */
  const log = [];
  const approver = createApprover({
    ask: scripted([["예"], ["아니오"], []]).ask,
    onDecision: ({ tool, allowed, how }) => log.push({ tool, allowed, how }),
  });
  await approver.decide("Write", {});
  await approver.decide("Bash", { command: "rm x" });
  await approver.decide("Edit", {});
  assert.deepEqual(log, [
    { tool: "Write", allowed: true, how: "허용" },
    { tool: "Bash", allowed: false, how: "거부" },
    { tool: "Edit", allowed: false, how: "응답 없음" },
  ]);
});

/**
 * MCP 서버 쪽이 하는 일을 흉내 낸다 — 소켓에 한 줄 보내고 한 줄 받는다.
 * @param {string} address
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ id: string, answers: string[] }>}
 */
function roundTrip(address, payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(address);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
    sock.write(`${JSON.stringify({ id: "t1", ...payload })}\n`);
  });
}

test("승인 요청이 소켓을 타고 터미널 쪽 판단기까지 간다", async () => {
  /** @type {Array<[string, unknown]>} */
  const seen = [];
  const host = await startElicitHost({
    elicitor: { ask: async () => [] },
    onApprove: async (tool, input) => {
      seen.push([tool, input]);
      return { behavior: "allow", updatedInput: input };
    },
  });
  try {
    const res = await roundTrip(host.address, { kind: "approve", tool: "Write", input: { file_path: "a.md" } });
    assert.deepEqual(seen, [["Write", { file_path: "a.md" }]]);
    assert.deepEqual(JSON.parse(res.answers[0] ?? ""), { behavior: "allow", updatedInput: { file_path: "a.md" } });
    assert.equal(host.asked, 0, "승인은 질문 횟수에 세지 않는다");
  } finally {
    await host.close();
  }
});

test("판단기가 없는 호스트는 거부로 답한다", async () => {
  const host = await startElicitHost({ elicitor: { ask: async () => [] } });
  try {
    const res = await roundTrip(host.address, { kind: "approve", tool: "Write", input: {} });
    assert.equal(JSON.parse(res.answers[0] ?? "").behavior, "deny");
  } finally {
    await host.close();
  }
});

test("위임 실행에 승인 도구를 붙인다 — 권한 모드는 넘기지 않는다", () => {
  const spec = /** @type {any} */ ({ tier: "standard", tools: [], allowDelegation: false });
  const args = buildDelegatedArgs(spec, { mcpConfigPath: "mcp.json" }, null);
  const at = args.indexOf("--permission-prompt-tool");
  assert.ok(at !== -1, "승인 도구가 안 붙었다");
  assert.equal(args[at + 1], APPROVE_TOOL);
  assert.ok(!args.includes("--permission-mode"), "사용자·조직 설정의 권한 모드를 덮어썼다");
  assert.ok(!args.includes("--dangerously-skip-permissions"));

  // MCP 가 없으면 받을 곳이 없으므로 붙이지 않는다.
  assert.ok(!buildDelegatedArgs(spec, {}, null).includes("--permission-prompt-tool"));
});
