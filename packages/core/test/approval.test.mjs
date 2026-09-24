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
import { analyzeBash, approvalKey, createApprover, describeToolUse } from "../../cli/src/approval.mjs";
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

/*
 * 실측. `.claude/skills` 쓰기가 거부되자 모델이 복사 스크립트를 써서 `python3` 로 돌렸고,
 * 앞서 받은 Bash(python3) 세션 허용으로 묻지 않고 지나갔다.
 */
test("거부 뒤에는 셸 명령의 세션 허용을 다시 쓰지 않는다 — 우회 경로를 사람이 본다", async () => {
  const always = new Set();
  const person = scripted([["예, 이번 세션 동안 Bash(python3)은(는) 묻지 않음"], ["아니오"]]);
  const approver = createApprover({ ask: person.ask, always });
  assert.equal((await approver.decide("Bash", { command: "python3 a.py" })).behavior, "allow");
  assert.equal((await approver.decide("Bash", { command: "python3 b.py" })).behavior, "allow", "거부 전에는 세션 허용이 그대로다");
  assert.equal(person.asked.length, 1);

  assert.equal((await approver.decide("Write", { file_path: ".claude/skills/x.md" })).behavior, "deny");
  const bypass = await approver.decide("Bash", { command: "python3 _workspace/_deploy.py" });
  assert.equal(bypass.behavior, "deny", "거부 뒤 세션 허용으로 우회가 지나갔다");
  assert.equal(person.asked.length, 3, "거부 뒤 명령을 다시 묻지 않았다");
  assert.match(person.asked[2]?.question ?? "", /다시 묻습니다/);
  assert.equal((await approver.decide("Bash", { command: "ls .claude" })).behavior, "allow", "읽기 전용까지 막으면 조사도 못 한다");
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

/* ---------- 묻지 않아도 되는 것 ---------- */

test("읽기만 하는 셸 명령은 묻지 않는다 — 승인이 형식이 되지 않게", async () => {
  const person = scripted([]);
  const log = /** @type {string[]} */ ([]);
  const approver = createApprover({ ask: person.ask, onDecision: ({ how }) => log.push(how) });
  for (const command of [
    "ls -la .axnavi 2>/dev/null; echo \"---\"; ls -la ..",
    "cd /c/work && git status --short | head -50",
    "grep -rn \"TODO\" src | wc -l",
    "find . -name \"*.java\" -not -path \"*/target/*\"",
    "sed -n '1,40p' pom.xml",
    "git log --oneline -5 && git diff --stat",
  ]) {
    assert.equal((await approver.decide("Bash", { command })).behavior, "allow", command);
  }
  assert.equal(person.asked.length, 0, "읽기 전용인데 물었다");
  assert.ok(log.every((how) => /자동 허용/.test(how)), "감사 기록에 자동 허용으로 남겨야 한다");
});

test("바꾸는 형태가 섞이면 읽기 전용으로 보지 않는다", () => {
  for (const command of [
    "ls > files.txt",
    "echo x >> a.log",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "sed -i 's/a/b/' x.java",
    "git push origin main",
    "git branch -D old",
    "git config user.name x",
    "cat a | xargs rm",
    "echo $(rm -rf x)",
    "rm -rf dist",
    "node -e \"require('fs').rmSync('x')\"",
  ]) {
    assert.equal(analyzeBash(command, "C:/axnavi").readOnly, false, command);
  }
  assert.equal(analyzeBash("ls 2>&1 | grep x").readOnly, true, "2>&1 은 파일을 쓰지 않는다");
  assert.equal(analyzeBash("awk '$3 > 10 {print $1}' data.txt").readOnly, true, "따옴표 안의 > 는 리다이렉트가 아니다");
});

test("axnavi 자신의 스크립트는 묻지 않는다 — 인덱서·검증기는 제품의 일부다", () => {
  const root = "C:\\Users\\me\\AX-NAVI-CLI";
  assert.equal(analyzeBash(`node "C:/Users/me/AX-NAVI-CLI/agents/lib/build-index.mjs" --root "C:\\work"`, root).readOnly, true);
  assert.equal(analyzeBash(`node "C:\\Users\\me\\AX-NAVI-CLI\\agents\\lib\\build-index.mjs" --root .`, root).readOnly, true, "Windows 역슬래시 경로");
  assert.equal(analyzeBash(`python3 "$CLAUDE_PLUGIN_ROOT/agents/lib/validator_checks.py" --root .`, root).readOnly, true);
  assert.equal(analyzeBash(`node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs" summary`, root).readOnly, true);
  assert.equal(analyzeBash(`node "C:/other/tool.mjs"`, root).readOnly, false, "다른 스크립트는 묻는다");
  assert.equal(analyzeBash(`python3 _workspace/_deploy_staged_skills.py`, root).readOnly, false, "작업 폴더에 새로 쓴 스크립트는 묻는다");
});

test("복합 명령은 첫 단어만 보지 않는다 — ls 허용으로 뒤의 git push 가 지나가면 안 된다", async () => {
  const always = new Set(["Bash(ls)"]);
  const person = scripted([["아니오"]]);
  const decision = await createApprover({ ask: person.ask, always }).decide("Bash", { command: "ls; git push origin main" });
  assert.equal(decision.behavior, "deny");
  assert.equal(person.asked.length, 1);
  assert.match(person.asked[0]?.options[1] ?? "", /Bash\(git push\)/, "묻는 대상이 읽기 전용이 아닌 조각이어야 한다");
});

test("'이번 세션 동안 모두 묻지 않음' 은 이후 전부 연다", async () => {
  const always = new Set();
  const person = scripted([["예, 이번 세션 동안 모두 묻지 않음"]]);
  await createApprover({ ask: person.ask, always }).decide("Write", { file_path: "a.md" });
  const next = scripted([]);
  const approver = createApprover({ ask: next.ask, always });
  assert.equal((await approver.decide("Bash", { command: "npm install" })).behavior, "allow");
  assert.equal((await approver.decide("Edit", { file_path: "b.md" })).behavior, "allow");
  assert.equal(next.asked.length, 0);
});

test("전부 승인 모드면 묻지 않고, 그 사실을 기록에 남긴다", async () => {
  const person = scripted([]);
  const log = /** @type {string[]} */ ([]);
  const decision = await createApprover({ ask: person.ask, trustAll: () => true, onDecision: ({ how }) => log.push(how) }).decide("Bash", { command: "rm -rf dist" });
  assert.equal(decision.behavior, "allow");
  assert.equal(person.asked.length, 0);
  assert.deepEqual(log, ["모드: 전부 승인"]);
});

test("실제 명령 모양: 반복문·git -C·xargs grep·heredoc·Git Bash 경로", () => {
  const root = "C:/Users/me/AX-NAVI-CLI";
  assert.equal(analyzeBash("for d in a b; do ls $d; done", root).readOnly, true, "반복문 안이 읽기 전용이면 읽기 전용");
  assert.equal(analyzeBash("for f in *.tmp; do rm $f; done", root).readOnly, false, "반복문 안에 rm 이 있으면 묻는다");
  assert.equal(analyzeBash("git -C /c/work/repo status --short", root).readOnly, true, "-C 값은 하위 명령이 아니다");
  assert.equal(analyzeBash("git -C /c/work/repo push", root).readOnly, false);
  assert.equal(analyzeBash("grep -rl x src | xargs grep -n y", root).readOnly, true, "xargs 로 넘기는 명령이 읽기 전용");
  assert.equal(analyzeBash("find . -name '*.log' | xargs rm", root).readOnly, false);
  assert.equal(analyzeBash("node /c/Users/me/AX-NAVI-CLI/agents/lib/ai-budget.mjs init --root x", root).readOnly, true, "Git Bash 경로 형식");
  const heredoc = analyzeBash("python3 - <<'EOF'\nimport json\nwith open('a') as f:\n    print(f.read())\nEOF", root);
  assert.equal(heredoc.readOnly, false, "heredoc 으로 넘긴 코드는 묻는다");
  assert.deepEqual(heredoc.names, ["python3"], "heredoc 본문 줄을 명령 이름으로 늘어놓지 않는다");
  assert.equal(analyzeBash("cat <<EOF\nhello\nEOF", root).readOnly, true, "cat 으로 보여 주기만 하면 읽기 전용");
});
