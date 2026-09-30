/*
 * 디스크 전체 검색 차단 — 검색 명령에 디스크 루트가 붙은 모양만 막고, 경로를 좁힌 검색은 그대로 둔다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diskScanDecision, diskWideScan } from "../../provider-claude-cli/src/disk-scan-guard.mjs";
import { delegatedSettings } from "../../provider-claude-cli/src/index.mjs";

const SCRIPT = fileURLToPath(new URL("../../provider-claude-cli/src/disk-scan-guard.mjs", import.meta.url));

test("디스크 루트부터 뒤지는 검색은 막는다 — 실측 명령 포함", () => {
  const blocked = [
    'find / -iname "*.jar" 2>/dev/null | xargs -I{} sh -c \'unzip -l "{}" 2>/dev/null | grep -qi EgovLengthCheck && echo {}\'',
    "find /c -name x",
    "find C:\\ -name x",
    "find C: -name x",
    "grep -r EgovLength /",
    "rg foo /",
    "dir C:\\ /s /b",
    "Get-ChildItem C:\\ -Recurse -Filter *.jar",
    "gci -Path C:\\ -Rec",
    "where /r C:\\ java.exe",
    "cd x && find / -name y",
    "ls -R /",
    "/usr/bin/find / -name a",
  ];
  for (const command of blocked) assert.ok(diskWideScan(command), command);
});

test("경로를 좁힌 검색과 검색이 아닌 명령은 막지 않는다", () => {
  const allowed = [
    "find . -name x",
    'find src -name "*.jsp"',
    "find /c/demo/egov-sample -name x",
    "grep -rn foo src",
    "ls -la /",
    "dir C:\\demo",
    "find ~/.m2 -name '*.jar'",
    "echo /",
    "git -C / status",
    "Get-ChildItem C:\\demo -Recurse",
    "grep foo /etc/hosts",
  ];
  for (const command of allowed) assert.equal(diskWideScan(command), null, command);
});

test("막을 때는 거부와 함께 좁혀서 다시 하라는 안내를 준다", () => {
  const decision = /** @type {any} */ (diskScanDecision({ command: "find / -name x.jar" }));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /경로를 좁혀서/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /확인하지 못함/);
  assert.deepEqual(diskScanDecision({ command: "find . -name x" }), {});
  assert.deepEqual(diskScanDecision(undefined), {});
});

test("claude -p 연결은 같은 판정기를 훅 명령으로 돌린다", () => {
  const out = execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_input: { command: "find / -name x" } }) }).toString();
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  const pass = execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_input: { command: "find . -name x" } }) }).toString();
  assert.equal(pass, "", "허용할 때는 아무것도 쓰지 않는다(그대로 진행)");
  const settings = /** @type {any} */ (delegatedSettings([], "node hook.mjs", undefined, "node disk.mjs"));
  assert.ok(settings.hooks.PreToolUse.some((/** @type {any} */ m) => m.matcher === "Bash|PowerShell" && m.hooks[0].command === "node disk.mjs"));
  assert.ok(!(/** @type {any} */ (delegatedSettings([], "x")).hooks.PreToolUse.some((/** @type {any} */ m) => m.matcher === "Bash|PowerShell")), "명령을 안 주면 넣지 않는다");
});
