/*
 * Provider 선택.
 *
 * 두 경로가 공존한다.
 *   anthropic   Messages API. Core의 ToolGateway가 도구를 실행한다. ANTHROPIC_API_KEY 필요.
 *   claude-cli  설치된 claude CLI에 위임. 구독 인증을 그대로 쓴다. 키 불필요.
 *
 * 기본값은 "쓸 수 있는 쪽"이다. 키가 있으면 Gateway가 통제하는 경로를 택하고,
 * 없으면 claude CLI로 간다. 둘 다 없으면 무엇이 없는지 구체적으로 말하고 멈춘다.
 */
import { AnthropicProvider } from "@ax-navi/provider-anthropic";
import { ClaudeCliProvider, probeClaudeCli } from "@ax-navi/provider-claude-cli";
import { ui } from "./runtime.mjs";

/** @typedef {"anthropic" | "claude-cli" | "auto"} ProviderName */

export function hasApiKey() {
  return Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
}

/**
 * @param {{ provider?: ProviderName, cwd?: string }} opts
 * @returns {{ provider: import("@ax-navi/core").LLMProvider, note: string } | { error: string }}
 */
export function selectProvider(opts = {}) {
  const wanted = opts.provider ?? "auto";

  if (wanted === "anthropic") {
    if (!hasApiKey()) return { error: authHelp("anthropic Provider를 지정했지만 ANTHROPIC_API_KEY가 없다.") };
    return { provider: new AnthropicProvider(), note: "anthropic · Messages API · Gateway가 도구를 통제한다" };
  }

  if (wanted === "claude-cli") {
    const probe = probeClaudeCli();
    if (!probe.ok) return { error: `claude CLI를 쓸 수 없다 — ${probe.reason}` };
    return {
      provider: new ClaudeCliProvider(opts.cwd ? { cwd: opts.cwd } : {}),
      note: `claude-cli ${probe.version} · 구독 인증 · 도구 제약은 claude 권한 체계가 강제한다`,
    };
  }

  // auto — 키가 있으면 통제력이 더 큰 쪽을 먼저 택한다.
  if (hasApiKey()) {
    return { provider: new AnthropicProvider(), note: "anthropic · Messages API · Gateway가 도구를 통제한다" };
  }
  const probe = probeClaudeCli();
  if (probe.ok) {
    return {
      provider: new ClaudeCliProvider(opts.cwd ? { cwd: opts.cwd } : {}),
      note: `claude-cli ${probe.version} · 구독 인증 · 도구 제약은 claude 권한 체계가 강제한다`,
    };
  }
  return { error: authHelp("ANTHROPIC_API_KEY도 없고 claude CLI도 찾지 못했다.") };
}

/** @param {string} headline */
function authHelp(headline) {
  return [
    `${ui.red(headline)}`,
    ui.dim("  둘 중 하나가 있어야 에이전트를 실행할 수 있다."),
    ui.dim("    1) 구독 사용  — claude CLI 설치 후 `claude` 로 한 번 로그인 (키 불필요)"),
    ui.dim(`    2) API 키     — PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."`),
    ui.dim("  키 없이 쓸 수 있는 명령: axnavi index build | status | refresh, axnavi doctor"),
  ].join("\n");
}
