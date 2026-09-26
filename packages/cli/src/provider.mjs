/*
 * Provider 선택.
 *
 * 세 경로가 공존한다.
 *   anthropic   Messages API. Core의 ToolGateway가 도구를 실행한다. ANTHROPIC_API_KEY 필요.
 *   agent-sdk   Claude Agent SDK. 질문·승인을 콜백으로 직접 받는다. 구독 인증. 키 불필요. (기본)
 *   claude-cli  설치된 claude CLI 에 -p 로 위임. SDK 가 없을 때(폐쇄망 설치 등) 쓴다.
 *
 * 기본값은 "쓸 수 있는 쪽"이다. 키가 있으면 Gateway가 통제하는 경로, 없으면 SDK, SDK 가 설치돼
 * 있지 않으면 claude CLI 로 간다. 다 없으면 무엇이 없는지 구체적으로 말하고 멈춘다.
 */
import { AnthropicProvider } from "../../provider-anthropic/src/index.mjs";
import { ClaudeCliProvider, probeClaudeCli } from "../../provider-claude-cli/src/index.mjs";
import { AgentSdkProvider } from "../../provider-agent-sdk/src/index.mjs";
import { hostPlugins, pluginSkillNames } from "../../provider-agent-sdk/src/host-settings.mjs";
import { ui, REPO_ROOT } from "./runtime.mjs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Agent SDK 가 설치돼 있는가. 선택 의존성이라 폐쇄망에서 설치 파일 하나로 옮기면 없을 수 있다.
 * 개발 폴더(npm link)·전역 설치는 이 설치본의 node_modules 에, 다른 패키지의 의존성으로 깔렸으면
 * 한 단계 위(끌어올려진 node_modules)에 있다.
 * @param {string} [root]
 */
export function sdkInstalled(root = REPO_ROOT) {
  return packageInstalled("claude-agent-sdk", root);
}

/*
 * Messages API 경로가 쓰는 `@anthropic-ai/sdk` 도 선택 의존성이다. 키만 보고 이 경로를 고르면, 폐쇄망 설치
 * (`--omit=optional`)에 게이트웨이 토큰이 있는 흔한 조합에서 doctor 는 ✓ 인데 실행은 스택 트레이스로 죽었다
 * (리뷰 실측). 설치돼 있을 때만 고른다.
 * @param {string} [root]
 */
export function anthropicSdkInstalled(root = REPO_ROOT) {
  return packageInstalled("sdk", root);
}

/** @param {string} name  `@anthropic-ai/` 아래 이름 @param {string} root */
function packageInstalled(name, root) {
  const rel = join("@anthropic-ai", name, "package.json");
  return [join(root, "node_modules", rel), join(dirname(root), rel)].some((p) => existsSync(p));
}

/** @typedef {"anthropic" | "claude-cli" | "agent-sdk" | "auto"} ProviderName */

export function hasApiKey() {
  return Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
}

/**
 * @param {{ provider?: ProviderName, cwd?: string, mcp?: { configPath: string, env: Record<string, string> }, host?: import("../../provider-agent-sdk/src/index.mjs").Host }} opts
 * @returns {{ provider: import("@ax-navi/core").LLMProvider, note: string, short: string } | { error: string }}
 */
export function selectProvider(opts = {}) {
  const wanted = opts.provider ?? "auto";

  if (wanted === "anthropic") {
    if (!hasApiKey()) return { error: authHelp("anthropic Provider를 지정했지만 ANTHROPIC_API_KEY가 없습니다.") };
    if (!anthropicSdkInstalled()) return { error: "anthropic 연결에 필요한 @anthropic-ai/sdk 가 설치되어 있지 않습니다(선택 의존성을 빼고 설치한 경우). 인터넷이 되는 곳에서 선택 의존성을 포함해 axnavi 를 다시 설치하거나 --provider claude-cli 로 실행하세요." };
    return ANTHROPIC();
  }

  if (wanted === "agent-sdk") {
    if (!sdkInstalled()) return { error: "Claude Agent SDK 가 설치되어 있지 않습니다 — 인터넷이 되는 곳에서 axnavi 를 다시 설치하거나 --provider claude-cli 로 실행하세요." };
    return AGENT_SDK(opts.host ?? NO_HOST, opts.cwd, opts.mcp);
  }

  if (wanted === "claude-cli") {
    const probe = probeClaudeCli();
    if (!probe.ok) return { error: `claude CLI를 쓸 수 없습니다 — ${probe.reason}` };
    return CLAUDE_CLI(probe.version, opts.cwd, opts.mcp);
  }

  // auto — 키가 있으면 통제력이 더 큰 쪽을 먼저 택한다.
  if (hasApiKey() && anthropicSdkInstalled()) return ANTHROPIC();
  // 키가 없으면 SDK 연결이 기본이다. 시작 화면·doctor 처럼 이름만 보는 호출도 같은 답을 받아야 한다.
  if (sdkInstalled()) return AGENT_SDK(opts.host ?? NO_HOST, opts.cwd, opts.mcp);
  // SDK 가 없으면(폐쇄망 설치 등) 설치된 claude CLI 로 간다.
  const probe = probeClaudeCli();
  if (probe.ok) return CLAUDE_CLI(probe.version, opts.cwd, opts.mcp);
  return { error: authHelp("ANTHROPIC_API_KEY도 없고, Claude Agent SDK 도 claude CLI 도 찾지 못했습니다.") };
}

/*
 * 손잡이 없이 고른 경우(시작 화면·doctor·기능 확인). 실제 실행은 execute.mjs 가 손잡이를 준다.
 * 이 손잡이로 실행되면 묻지도 허용하지도 않는다 — 묻지 못했는데 허용하면 안 된다.
 */
/** @type {import("../../provider-agent-sdk/src/index.mjs").Host} */
const NO_HOST = {
  ask: async () => [],
  canAsk: () => false,
  approve: async () => ({ behavior: "deny", message: "이 실행에는 승인 창이 없습니다." }),
};

/* 짧은 라벨(시작 화면용)과 긴 설명(실행 로그용)을 나눠 둔다. */
function ANTHROPIC() {
  return {
    provider: new AnthropicProvider(),
    short: "anthropic · Messages API",
    note: "anthropic · Messages API · Gateway가 도구를 통제합니다",
  };
}

/**
 * @param {string} version
 * @param {string} [cwd]
 * @param {{ configPath: string, env: Record<string, string> }} [mcp]
 */
function CLAUDE_CLI(version, cwd, mcp) {
  const v = version.replace(/\s*\(Claude Code\)\s*$/, "");
  return {
    provider: new ClaudeCliProvider({
      ...(cwd ? { cwd } : {}),
      ...(mcp ? { mcpConfigPath: mcp.configPath, env: mcp.env } : {}),
      /*
       * 위임된 claude 에게 **우리 설치본을 세션 한정 플러그인으로** 물린다.
       *
       * 이게 없으면 오케스트레이터 스킬의 Agent(subagent_type="ax-navi:analyzer") 가
       * 전부 실패한다(실측):
       *   Agent type 'ax-navi:feature-finder' not found.
       *   Available agents: claude, Explore, general-purpose, Plan, statusline-setup
       * 서브에이전트가 안 보이는 게 아니라 아예 뜨지 않았다.
       *
       * --agents JSON 으로는 안 된다 — agents/ 합계가 211KB 고 analyzer.md 하나가
       * 46.6KB 인데 윈도우 명령줄 상한은 32KB 다. 경로 하나만 넘기는 쪽이 맞다.
       *
       * 호스트에 설치된 플러그인을 끄는 설정과 함께 써도 이쪽은 살아 있다(실측).
       * 그래서 "예전 설치본이 끼어들지 않는다"는 성질을 잃지 않는다.
       */
      pluginDir: REPO_ROOT,
    }),
    short: `claude-cli ${v} · 구독 인증`,
    note: `claude-cli ${v} · 구독 인증 · 도구 제약은 claude 권한 체계가 강제합니다`,
  };
}

/**
 * @param {import("../../provider-agent-sdk/src/index.mjs").Host} host
 * @param {string} [cwd]
 * @param {{ configPath: string, env: Record<string, string> }} [mcp]
 */
function AGENT_SDK(host, cwd, mcp) {
  /*
   * 호스트 플러그인 끄기와 이름이 겹치는 계정 동기화 스킬 막기(실측: claude.ai 에서 동기화된
   * generate-wiki·publish-wiki·wiki-hub 가 ax-navi 스킬과 이름이 같다).
   */
  const mute = hostPlugins();
  const settings = JSON.stringify({
    ...(mute.length ? { enabledPlugins: Object.fromEntries(mute.map((n) => [n, false])) } : {}),
    permissions: { deny: pluginSkillNames(REPO_ROOT).map((n) => `Skill(anthropic-skills:${n})`) },
  });
  return {
    provider: new AgentSdkProvider({
      host,
      pluginDir: REPO_ROOT,
      settings,
      ...(cwd ? { cwd } : {}),
      ...(mcp ? { mcpConfigPath: mcp.configPath, mcpEnv: mcp.env } : {}),
    }),
    short: "agent-sdk · 구독 인증",
    note: "agent-sdk · 구독 인증 · 질문·승인은 axnavi 화면이 직접 받습니다",
  };
}

/** @param {string} headline */
function authHelp(headline) {
  return [
    `${ui.red(headline)}`,
    ui.dim("  둘 중 하나가 있어야 에이전트를 실행할 수 있습니다."),
    ui.dim("    1) 구독 사용  — claude CLI 설치 후 `claude` 로 한 번 로그인 (키 불필요)"),
    ui.dim(`    2) API 키     — PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."`),
    ui.dim("  키 없이 쓸 수 있는 명령: axnavi index build | status | refresh, axnavi doctor"),
  ].join("\n");
}
