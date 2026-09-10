import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pythonBin } from "../python-bin.mjs";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(plugin, "agents/lib/guard_hook.py");

function write(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "ax-guard-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function deploy(root) {
  const result = spawnSync(pythonBin(), [script, "--root", root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
function hook(root, payload) {
  const hookPath = join(root, ".claude/hooks/ax-navi-guard.py");
  return spawnSync(pythonBin(), [hookPath], {
    encoding: "utf8", input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}

export async function test(register, assert) {
  register("가드 훅은 운영 설정·자격 정보 파일을 인덱스와 파일명 규칙으로 골라 settings.json에 멱등 병합한다", () => fixture(root => {
    write(root, ".env", "DB_PASSWORD=secret\n");
    write(root, ".env.example", "DB_PASSWORD=\n");
    write(root, "src/main/resources/application-prod.yml", "spring:\n  datasource:\n    url: jdbc:oracle\n");
    write(root, "src/main/resources/application-dev.yml", "spring: {}\n");
    write(root, "config/context-datasource.xml", "<beans/>");
    write(root, "certs/server.jks", "binary");
    write(root, "src/main/java/App.java", "class App {}");
    write(root, "_workspace/index/env_branches.json", {
      _meta: {}, profiles: ["real", "dev"],
      branches: [{ file: "conf/app-real.properties", type: "config_file", marker: "real" }],
    });
    write(root, ".claude/settings.json", { permissions: { allow: ["Read"] }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }] } });

    const out = deploy(root);
    assert.ok(out.includes("보호 파일 5개"), out);
    const list = JSON.parse(readFileSync(join(root, ".claude/hooks/ax-navi-guard.json"), "utf8")).protected.map(p => p.path);
    assert.equal(JSON.stringify(list), JSON.stringify([".env", "certs/server.jks", "conf/app-real.properties", "config/context-datasource.xml", "src/main/resources/application-prod.yml"]));
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    assert.equal(settings.permissions.allow[0], "Read", "기존 설정 보존");
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "echo done", "기존 훅 보존");
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes("ax-navi-guard.py"));

    deploy(root);
    const again = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    assert.equal(again.hooks.PreToolUse.length, 1, "재배포 시 중복 항목 없음");
  }));

  register("가드 훅은 보호 파일 편집과 Bash 쓰기를 exit 2로 막고 나머지는 통과시킨다", () => fixture(root => {
    write(root, "src/main/resources/application-prod.yml", "x: 1\n");
    write(root, "src/main/java/App.java", "class App {}");
    deploy(root);
    const blocked = hook(root, { tool_name: "Edit", tool_input: { file_path: join(root, "src/main/resources/application-prod.yml") } });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.ok(blocked.stderr.includes("보호 파일 수정 차단"));
    const relBlocked = hook(root, { tool_name: "Write", tool_input: { file_path: "src\\main\\resources\\application-prod.yml" } });
    assert.equal(relBlocked.status, 2, "상대 경로·역슬래시도 차단");
    const allowed = hook(root, { tool_name: "Edit", tool_input: { file_path: join(root, "src/main/java/App.java") } });
    assert.equal(allowed.status, 0, allowed.stderr);
    const bashWrite = hook(root, { tool_name: "Bash", tool_input: { command: "sed -i 's/x/y/' src/main/resources/application-prod.yml" } });
    assert.equal(bashWrite.status, 2, "Bash 쓰기 연산 차단");
    const bashRead = hook(root, { tool_name: "Bash", tool_input: { command: "cat src/main/resources/application-prod.yml 2>&1" } });
    assert.equal(bashRead.status, 0, "읽기만 하는 Bash는 통과");
    const broken = hook(root, { tool_name: "Edit" });
    assert.equal(broken.status, 0, "입력 결손은 차단하지 않음");
  }));

  register("보호 대상이 없으면 가드 훅을 배포하지 않고 이전 항목을 제거한다", () => fixture(root => {
    write(root, "src/main/java/App.java", "class App {}");
    write(root, ".claude/hooks/ax-navi-guard.py", "stale");
    write(root, ".claude/hooks/ax-navi-guard.json", { protected: [{ path: "x", reason: "r" }] });
    write(root, ".claude/settings.json", { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "python ax-navi-guard.py" }] }] } });
    const out = deploy(root);
    assert.ok(out.includes("이전 가드 훅 제거"), out);
    assert.ok(!existsSync(join(root, ".claude/hooks/ax-navi-guard.py")));
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    assert.equal(settings.hooks, undefined, "빈 hooks 키는 남기지 않음");
  }));
}
