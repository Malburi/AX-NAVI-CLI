/*
 * axnavi 런처 — 인덱스를 확인하고 AX Navi 플러그인을 실어 Claude Code 를 띄운다.
 * 인자 조립 · 실행 파일 고르기 · 훅 매니페스트를 고정한다(실제 실행은 수동 확인).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLaunchArgs, conflictingPlugins, pickClaudeBin, splitLauncherArgs, withPairPartners, launchEnv } from "../../cli/src/launcher.mjs";

test("플러그인 루트 · 짝 저장소 · 끌 플러그인 설정 · 사용자 인자 순서로 넘긴다", () => {
  const args = buildLaunchArgs({ pluginDir: "/opt/axnavi", partnerRoots: ["/w/client"], settingsFile: "/tmp/s.json", userArgs: ["-c", "--model", "sonnet"] });
  assert.deepEqual(args, ["--plugin-dir", "/opt/axnavi", "--add-dir", "/w/client", "--settings", "/tmp/s.json", "-c", "--model", "sonnet"]);
  assert.deepEqual(buildLaunchArgs({ pluginDir: "/p", partnerRoots: [], settingsFile: null, userArgs: [] }), ["--plugin-dir", "/p"]);
});

test("마켓플레이스판 ax-navi 만 끈다 — 다른 플러그인은 그대로", () => {
  assert.deepEqual(conflictingPlugins(["ax-navi@ax-navi", "github@claude-plugins", "ax-navi@old", "my-ax-navi@x"]), ["ax-navi@ax-navi", "ax-navi@old"]);
});

test("axnavi 자체 옵션만 빼고 나머지는 Claude Code 에 넘긴다", () => {
  const out = splitLauncherArgs(["--root", "C:/w", "-c", "--tier", "Full", "--permission-mode", "default", "질문"]);
  assert.equal(out.root, "C:/w");
  assert.equal(out.tier, "Full");
  assert.deepEqual(out.claudeArgs, ["-c", "--permission-mode", "default", "질문"]);
});

test("실행 파일은 설치된 claude 가 먼저, 없으면 axnavi 내장, 둘 다 없으면 null", () => {
  assert.deepEqual(pickClaudeBin({ installed: () => "C:/claude.exe", bundled: () => "C:/sdk/claude.exe" }), { bin: "C:/claude.exe", source: "installed" });
  assert.deepEqual(pickClaudeBin({ installed: () => null, bundled: () => "C:/sdk/claude.exe" }), { bin: "C:/sdk/claude.exe", source: "bundled" });
  assert.equal(pickClaudeBin({ installed: () => null, bundled: () => null }), null);
});

test("런처가 싣는 설치 루트의 훅이 플러그인 훅 전체를 담는다", () => {
  const hooks = JSON.parse(readFileSync(fileURLToPath(new URL("../../../hooks/hooks.json", import.meta.url)), "utf8")).hooks;
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]) assert.ok(JSON.stringify(hooks[ev] ?? "").includes("packages/plugin/src/hooks.mjs"), ev);
  assert.ok(JSON.stringify(hooks.PreToolUse).includes("legacy-encoding-hook.mjs"), "EUC-KR 보존 훅");
});

test("하위 명령이 아니면 런처로 간다 — classic 은 자체 화면", () => {
  const src = readFileSync(fileURLToPath(new URL("../../cli/src/bin.mjs", import.meta.url)), "utf8");
  assert.match(src, /return launch\(argv, VERSION\)/);
  assert.match(src, /"classic"/);
});

test("바깥 Claude Code 세션 표식은 넘기지 않는다 — 대화 저장 · -c 가 살고, 플러그인 훅이 비키지 않는다", () => {
  const env = launchEnv({ PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "s", AXNAVI_ENCODING_HOOK: "1", ANTHROPIC_MODEL: "m", CLAUDE_EFFORT: "high" });
  assert.deepEqual(env, { PATH: "x", ANTHROPIC_MODEL: "m", CLAUDE_EFFORT: "high" });
});

test("선 자리에 인덱스가 있어도 pair_config 의 짝 저장소를 함께 연다 — 중복 없이", () => {
  const roots = withPairPartners([{ root: "C:/w/server" }, { root: "C:/w/client" }].map((p) => /** @type {any} */ (p)), (dir) => (dir.endsWith("server") ? ["C:/w/client", "C:/w/batch"] : ["C:/w/server"]));
  assert.deepEqual(roots.map((p) => p.root.replace(/\\/g, "/").replace(/^[a-z]:/i, (d) => d.toUpperCase())), ["C:/w/server", "C:/w/client", "C:/w/batch"]);
});
