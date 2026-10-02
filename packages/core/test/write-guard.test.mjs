/*
 * 소스 쓰기 판정 — 셸 명령까지 사실로 가린다.
 * 실측 사고(실제 레거시 벤치 C-R2-1): `python -c "open(...,'w')…"` 로 24곳을 고쳐 승인 창이 한 번도 안 떴다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTarget, shellWrites, sourceWrite, writeGuardDecision } from "../src/safety/write-guard.mjs";
import { analyzeBash, createApprover } from "../../cli/src/approval.mjs";

const base = mkdtempSync(join(tmpdir(), "axnavi-wg-"));
const backend = join(base, "xu25");
const client = join(base, "xu25-client");
const plugin = join(base, "plugin");
for (const d of [join(backend, "src"), join(client, "web"), join(backend, "_workspace"), join(plugin, "agents", "lib")]) mkdirSync(d, { recursive: true });
writeFileSync(join(backend, "_workspace", "fix.py"), "import re\nopen('src/A.java','w').write('x')\n");
writeFileSync(join(backend, "_workspace", "read.py"), "print(open('src/A.java').read())\n");
const roots = [backend, client];
const opts = { cwd: backend, roots, pluginRoot: plugin };

/** @param {string} command */
const writes = (command) => sourceWrite("Bash", { command }, opts);

test("셸로 소스를 쓰는 형태는 모두 잡는다", () => {
  const cases = [
    `python -c "open('src/A.java','w').write(s)"`,
    `python3 -c "import pathlib; pathlib.Path('src/A.java').write_text(t)"`,
    `node -e "require('fs').writeFileSync('src/a.js', s)"`,
    "sed -i 's/HGRK_CRS_CL_NO, //' src/query.xml",
    "sed 's/x/y/w src/out.txt' src/a.txt",
    "echo hi > src/A.java",
    "cat >> src/A.java <<EOF\nline\nEOF",
    "sort -o src/list.txt src/list.txt",
    "uniq src/a.txt src/b.txt",
    "tee src/A.java < tmp.txt",
    "cp /tmp/A.java src/A.java",
    "mv src/A.java src/B.java",
    "rm -f src/A.java",
    "git checkout -- src/A.java",
    "git apply patch.diff",
    "perl -pi -e 's/a/b/' src/A.java",
    `powershell -Command "Set-Content -Path src/A.java -Value x"`,
    "python _workspace/fix.py",
    "python - <<'EOF'\nopen('src/A.java','w').write('x')\nEOF",
    "cd ../xu25-client && sed -i 's/a/b/' web/a.js",
  ];
  for (const command of cases) assert.ok(writes(command), command);
});

test("읽기만 하는 명령 · 산출물 폴더 · 저장소 밖 쓰기는 소스 쓰기가 아니다", () => {
  const cases = [
    "grep -rn HGRK src",
    `python -c "print(open('src/A.java').read())"`,
    "python _workspace/read.py",
    "cat src/A.java > _workspace/copy.txt",
    `node ${join(plugin, "agents", "lib", "build-index.mjs").replace(/\\/g, "/")} --root .`,
    "echo x > /dev/null 2>&1",
    `echo x > "${join(tmpdir(), "axnavi-scratch.txt").replace(/\\/g, "/")}"`,
    "sed -n 1,20p src/A.java",
    "git status && git diff",
    "mkdir -p target/classes",
  ];
  for (const command of cases) assert.equal(writes(command), null, command);
});

test("플러그인 스크립트 예외는 경로를 정규화한 뒤 판정한다 — `..` 로 빠져나가지 못한다", () => {
  const sneaky = `python ${join(plugin, "agents", "lib").replace(/\\/g, "/")}/../../../xu25/_workspace/fix.py`;
  assert.ok(writes(sneaky));
  assert.equal(analyzeBash(sneaky, plugin).readOnly, false);
});

test("v1 이 읽기 전용으로 잘못 본 쓰기 형태를 이제 묻는다", () => {
  for (const command of ["sort -o out.txt in.txt", "uniq a.txt b.txt", "tree -o out.txt", "date -s 2020-01-01", "sed 's/a/b/w out.txt' in.txt"]) {
    assert.equal(analyzeBash(command, plugin).readOnly, false, command);
  }
  assert.equal(analyzeBash("sort in.txt", plugin).readOnly, true);
});

test(".claude 의 settings · hooks 는 소스로 보고, skills · agents 는 산출물로 본다", () => {
  assert.equal(classifyTarget(join(backend, ".claude", "settings.local.json"), roots).kind, "source");
  assert.equal(classifyTarget(join(backend, ".claude", "hooks", "x.sh"), roots).kind, "source");
  assert.equal(classifyTarget(join(backend, ".claude", "skills", "trace", "SKILL.md"), roots).kind, "exempt");
  assert.equal(classifyTarget(join(backend, "CLAUDE.md"), roots).kind, "exempt");
  assert.equal(classifyTarget(join(client, "web", "a.js"), roots).root, client);
  assert.equal(classifyTarget(join(base, "elsewhere.txt"), roots).kind, "temp", "테스트 폴더는 임시 폴더 아래다");
  assert.equal(classifyTarget(process.platform === "win32" ? "C:\\Windows\\x.ini" : "/etc/x.conf", roots).kind, "foreign");
});

test("PowerShell 도구의 쓰기도 잡는다", () => {
  assert.ok(sourceWrite("PowerShell", { command: "Set-Content src/A.java 'x'" }, opts));
  assert.ok(sourceWrite("PowerShell", { command: "[IO.File]::WriteAllText('src/A.java', $t)" }, opts));
  assert.equal(sourceWrite("PowerShell", { command: "Get-Content src/A.java | Select-String HGRK" }, opts), null);
});

test("훅 결정 — 자동 모드는 묻고, 계획 모드는 거부한다", () => {
  const input = { command: `python -c "open('src/A.java','w').write(s)"` };
  assert.equal(writeGuardDecision("Bash", input, opts).hookSpecificOutput?.permissionDecision, "ask");
  assert.equal(writeGuardDecision("Bash", input, { ...opts, mode: "plan" }).hookSpecificOutput?.permissionDecision, "deny");
  assert.deepEqual(writeGuardDecision("Bash", { command: "ls src" }, opts), {});
  assert.equal(writeGuardDecision("Edit", { file_path: join(backend, "src", "A.java") }, opts).hookSpecificOutput?.permissionDecision, "ask");
  assert.deepEqual(writeGuardDecision("Write", { file_path: join(backend, "_workspace", "r.md") }, opts), {});
});

test("cd 를 따라가 대상 경로를 푼다", () => {
  const w = shellWrites("cd ../xu25-client && echo x > web/a.js", { cwd: backend });
  assert.deepEqual(w.targets, [join(client, "web", "a.js")]);
});

test("승인기 — Bash(python) 세션 허용만으로 셸 소스 수정이 지나가지 않는다", async () => {
  const always = new Set(["Bash(python)"]);
  /** @type {string[]} */
  const asked = [];
  const approver = createApprover({ ask: async (q) => { asked.push(q); return ["아니오"]; }, always, roots, cwd: backend, pluginRoot: plugin });
  const decision = await approver.decide("Bash", { command: `python -c "open('src/A.java','w').write(s)"` });
  assert.equal(decision.behavior, "deny");
  assert.match(asked[0] ?? "", /셸 명령으로 소스를 바꿉니다/);
});

test("승인기 — 파일 수정 허용은 저장소마다 따로 기억하고, 허용한 파일을 기록한다", async () => {
  const always = new Set();
  const answers = [["예, 이번 세션 동안 파일 수정 · xu25은(는) 묻지 않음"], ["아니오"]];
  const approver = createApprover({ ask: async () => answers.shift() ?? [], always, roots, cwd: backend });
  assert.equal((await approver.decide("Edit", { file_path: join(backend, "src", "A.java") })).behavior, "allow");
  assert.equal((await approver.decide("Edit", { file_path: join(backend, "src", "B.java") })).behavior, "allow", "같은 저장소는 다시 묻지 않는다");
  assert.equal((await approver.decide("Edit", { file_path: join(client, "web", "a.js") })).behavior, "deny", "다른 저장소는 다시 묻는다");
  assert.equal(approver.approvedWrites().files.size, 2);
});

test("claude -p 연결도 소스 쓰기 가드 훅을 걸고, 실행마다 환경변수로 켜고 끈다", async () => {
  const { delegatedSettings, guardEnv, WRITE_GUARD_TOOLS } = await import("../../provider-claude-cli/src/index.mjs");
  const settings = /** @type {any} */ (delegatedSettings([], "node fg.mjs", undefined, undefined, "node wg.mjs"));
  assert.ok(settings.hooks.PreToolUse.some((/** @type {any} */ m) => m.matcher === WRITE_GUARD_TOOLS && m.hooks[0].command === "node wg.mjs"));
  assert.match(WRITE_GUARD_TOOLS, /Bash/);
  assert.deepEqual(guardEnv({}), { AXNAVI_WRITE_GUARD: "0" });
  const on = guardEnv({ guardSource: "deny", sourceRoots: [backend] }, plugin);
  assert.equal(on["AXNAVI_WRITE_GUARD"], "1");
  assert.equal(on["AXNAVI_MODE"], "plan");
  assert.deepEqual(JSON.parse(on["AXNAVI_SOURCE_ROOTS"] ?? "[]"), [backend]);
});

test("API 키 연결의 Gateway 도 셸 소스 쓰기를 묻고, 계획 모드면 막는다", async () => {
  const { ToolGateway, ToolRegistry } = await import("../src/tools/gateway.mjs");
  const registry = new ToolRegistry();
  let ran = 0;
  registry.register({
    definition: { name: "Bash", description: "", mutates: true, inputSchema: { type: "object", required: ["command"] } },
    async run() { ran += 1; return { content: "ok" }; },
  });
  const gateway = new ToolGateway(registry);
  /** @type {string[]} */
  const asked = [];
  /** @param {"ask" | "deny"} mode @param {"allow" | "deny"} answer */
  const ctx = (mode, answer) => /** @type {any} */ ({
    paths: { root: backend }, allowedRoots: [backend], role: { name: "t", allowedTools: null, allowMutations: true },
    audit: { record() {} }, elicitor: {}, progress: {}, signal: new AbortController().signal,
    guard: { mode, roots, approve: async (/** @type {string} */ tool) => { asked.push(tool); return answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "사용자가 거부" }; } },
  });
  const edit = { id: "1", name: "Bash", input: { command: "sed -i 's/a/b/' src/A.java" } };
  assert.equal((await gateway.execute(edit, ctx("ask", "deny"))).isError, true);
  assert.equal(ran, 0);
  assert.equal((await gateway.execute(edit, ctx("ask", "allow"))).content, "ok");
  assert.match((await gateway.execute(edit, ctx("deny", "allow"))).content, /계획 모드/);
  assert.equal((await gateway.execute({ id: "2", name: "Bash", input: { command: "ls src" } }, ctx("ask", "deny"))).content, "ok", "읽기는 묻지 않는다");
  assert.deepEqual(asked, ["Bash", "Bash"]);
});

test("평가 서브에이전트는 한도까지만 — 작업 서브에이전트는 세지 않는다", async () => {
  const { reviewBudgetDecision } = await import("../src/safety/review-budget.mjs");
  const state = { limit: 1, used: 0 };
  assert.deepEqual(reviewBudgetDecision({ subagent_type: "ax-navi:change-safety" }, state), {});
  assert.deepEqual(reviewBudgetDecision({ subagent_type: "general-purpose" }, state), {}, "작업 서브에이전트는 막지 않는다");
  const second = /** @type {any} */ (reviewBudgetDecision({ subagent_type: "ax-navi:pattern-conformance" }, state));
  assert.equal(second.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(second.hookSpecificOutput?.permissionDecisionReason ?? "", /직접 확인한 근거로 결정/);
  const { loadSkill } = await import("../src/skills/loader.mjs");
  const { fileURLToPath } = await import("node:url");
  const skill = await loadSkill(fileURLToPath(new URL("../../../skills", import.meta.url)), "safe-modify");
  assert.equal(skill.reviewLimit, 1, "safe-modify 의 review_limit 을 읽지 못했다");
});
