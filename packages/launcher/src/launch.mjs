/*
 * Claude Code 대화 화면을 axnavi 설정과 함께 띄운다.
 *
 * axnavi 가 대화 화면(질문·승인·입력·서브에이전트·이어가기)을 직접 다시 만들던 것을 그만두고,
 * 진짜 Claude Code 를 같은 터미널에 띄운다. axnavi 는 그 앞에서 다음을 붙인다.
 *   - 이 설치본의 ax-navi 플러그인(--plugin-dir) — 조직이 고정한 버전
 *   - 관리 설정(--settings) — 승인 훅(묻지 않아도 되는 명령만 허용)·작업 기록 훅,
 *     다른 플러그인 끄기, 이름이 겹치는 계정 동기화 스킬 막기
 *   - 인덱스 조회 도구(--mcp-config, QueryIndex 하나)
 * 사용자 설정·권한 목록·CLAUDE.md 는 그대로 살아 있다.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeBin } from "../../provider-claude-cli/src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const slash = (/** @type {string} */ p) => p.split("\\").join("/");

/**
 * 이 설치본의 스킬 이름. 계정에서 동기화된 같은 이름 스킬을 막는 데 쓴다.
 * @param {string} pluginRoot
 */
export function pluginSkillNames(pluginRoot) {
  const dir = join(pluginRoot, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/**
 * 끌 호스트 플러그인. 설치 목록과 사용자 설정에서 켜 둔 것을 모두 본다.
 * 실측: wmux-orchestrator 는 사용자 설정에서 켜져 있지만 installed_plugins.json 에는 없었다.
 * @param {string} [home]
 */
export function hostPlugins(home = homedir()) {
  /** @type {Set<string>} */
  const names = new Set();
  const read = (/** @type {string} */ p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  for (const name of Object.keys(read(join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins ?? {})) names.add(name);
  for (const [name, on] of Object.entries(read(join(home, ".claude", "settings.json"))?.enabledPlugins ?? {})) if (on) names.add(name);
  return [...names].sort();
}

/**
 * 띄울 claude 의 인자와 설정을 만든다. 순수 함수 — 테스트가 모양을 고정한다.
 * @param {{ pluginRoot: string, projectRoot: string, node: string, skillNames: string[], mutePlugins: string[], settingsPath: string, mcpPath: string, passthrough?: string[] }} o
 */
export function buildLaunch(o) {
  const hook = (/** @type {string} */ name) => `"${slash(o.node)}" "${slash(join(HERE, "hooks", name))}"`;
  const settings = {
    ...(o.mutePlugins.length ? { enabledPlugins: Object.fromEntries(o.mutePlugins.map((n) => [n, false])) } : {}),
    permissions: {
      // 인덱스 조회는 읽기 전용이다. 안 넣으면 부를 때마다 승인 창이 뜬다(실측).
      allow: ["mcp__axnavi__QueryIndex"],
      // 계정에서 동기화된 같은 이름 스킬(예전 판)이 끼어들지 않게 막는다.
      deny: o.skillNames.map((n) => `Skill(anthropic-skills:${n})`),
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook("approve.mjs") }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook("audit.mjs") }] }],
    },
  };
  const mcp = {
    mcpServers: {
      axnavi: {
        command: slash(o.node),
        args: [slash(join(o.pluginRoot, "packages", "cli", "src", "mcp", "server.mjs"))],
        env: { AXNAVI_MCP_TOOLS: "QueryIndex", AXNAVI_PROJECT_ROOT: slash(o.projectRoot) },
      },
    },
  };
  const args = [
    "--plugin-dir", slash(o.pluginRoot),
    "--settings", o.settingsPath,
    "--strict-mcp-config",
    "--mcp-config", o.mcpPath,
    ...(o.passthrough ?? []),
  ];
  return { args, settings, mcp };
}

/**
 * @param {{ pluginRoot: string, projectRoot: string, passthrough?: string[] }} o
 * @returns {Promise<number>}
 */
export async function launchClaude(o) {
  const bin = resolveClaudeBin();
  if (!bin) {
    process.stderr.write("claude 실행 파일을 찾지 못했습니다. Claude Code 를 설치하고 로그인해 주세요.\n");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "axnavi-launch-"));
  const settingsPath = slash(join(dir, "settings.json"));
  const mcpPath = slash(join(dir, "mcp.json"));
  const plan = buildLaunch({
    ...o,
    node: process.execPath,
    skillNames: pluginSkillNames(o.pluginRoot),
    mutePlugins: hostPlugins(),
    settingsPath,
    mcpPath,
  });
  writeFileSync(settingsPath, JSON.stringify(plan.settings, null, 2), "utf8");
  writeFileSync(mcpPath, JSON.stringify(plan.mcp, null, 2), "utf8");

  const child = spawn(bin, plan.args, {
    cwd: o.projectRoot,
    stdio: "inherit",
    // 플러그인 모드 Bash 에는 이 값이 비어 있다(실측). 참조 문서·훅이 경로를 찾게 채워 둔다.
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: slash(o.pluginRoot) },
  });
  /*
   * Ctrl+C 는 Claude Code 몫이다(도는 턴 중단, 두 번이면 종료). 같은 콘솔의 우리 프로세스도
   * 신호를 받는데, 여기서 먼저 죽으면 claude 가 고아가 되어 터미널이 꼬인다. 떠 있는 동안 무시한다.
   */
  const ignore = () => {};
  process.on("SIGINT", ignore);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      process.off("SIGINT", ignore);
      resolve(code ?? 0);
    });
    child.on("error", (error) => {
      process.stderr.write(`claude 를 띄우지 못했습니다: ${error.message}\n`);
      resolve(1);
    });
  });
}
