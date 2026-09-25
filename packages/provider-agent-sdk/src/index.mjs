/*
 * Agent SDK Provider — 화면은 axnavi 것 그대로 두고, 화면 뒤의 claude 연결만 SDK 로 바꾼다.
 *
 * claude-cli Provider 는 턴마다 `claude -p` 를 새로 띄우고, 질문·승인을 MCP 서버를 거쳐
 * 우회시켰다. 그 우회로에서 결함이 계속 났다 — 30분 끊김, 가려진 선택 창, 턴마다 다시
 * 실리는 역할 지침, 백그라운드 서브에이전트가 승인을 못 받는 문제. SDK 는 이것을 직접 준다.
 *   - 질문·승인 → canUseTool 콜백. 내장 AskUserQuestion 도 여기로 와서 우리 질문 화면이 그린다.
 *   - 역할 지침 → 시스템 프롬프트(append). 사용자 메시지에 실리지 않는다.
 *   - 중단 → AbortController.
 * 이벤트 형식은 stream-json 과 같아서 claude-cli 의 translateEvent 를 그대로 쓴다.
 * 스킬 본문과 플러그인은 플러그인 모드와 같은 경로(plugins 옵션)로 실린다.
 */
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MODEL_BY_TIER,
  createBackgroundWatch,
  delegatedEnv,
  toDisallowedTools,
  toolBriefing,
  translateEvent,
} from "../../provider-claude-cli/src/index.mjs";
import { noAnswerText } from "../../cli/src/mcp/answers.mjs";

/**
 * @typedef {object} Host  화면 쪽이 넘겨주는 손잡이
 * @property {(question: string, options: string[], opts: { header?: string, multiSelect?: boolean }) => Promise<string[]>} ask
 * @property {() => boolean} [canAsk]
 * @property {(tool: string, input: Record<string, unknown>) => Promise<{ behavior: "allow", updatedInput?: Record<string, unknown> } | { behavior: "deny", message: string }>} approve
 */

/**
 * 내장 AskUserQuestion 의 질문들을 우리 질문 화면으로 묻고, SDK 가 받는 답 형식으로 돌려준다.
 * 선택지 설명은 화면에 함께 보여 주되, 답에는 레이블만 넣는다.
 * @param {Record<string, unknown>} input
 * @param {Host["ask"]} ask
 * @returns {Promise<Record<string, string> | null>}  답이 하나라도 비면 null
 */
export async function answerQuestions(input, ask) {
  const questions = Array.isArray(input["questions"]) ? /** @type {any[]} */ (input["questions"]) : [];
  /** @type {Record<string, string>} */
  const answers = {};
  for (const q of questions) {
    const options = Array.isArray(q?.options) ? q.options : [];
    const shown = options.map((/** @type {any} */ o) => (o?.description ? `${o.label} — ${o.description}` : String(o?.label ?? "")));
    const picked = await ask(String(q?.question ?? ""), shown, {
      ...(q?.header ? { header: String(q.header) } : {}),
      multiSelect: q?.multiSelect === true,
    });
    if (!picked.length) return null;
    answers[String(q?.question ?? "")] = picked
      .map((p) => {
        const i = shown.indexOf(p);
        return i >= 0 ? String(options[i]?.label ?? p) : p; // 목록 밖 답(직접 입력)은 그대로
      })
      .join(", ");
  }
  return answers;
}

/**
 * 서브에이전트를 뒤에서 돌리려는 호출을 포그라운드로 바꾼다. 턴이 끝나면 SDK 실행도 끝나므로
 * 뒤에서 돌던 서브에이전트는 결과를 잃는다(claude-cli 경로에서 실측한 것과 같다).
 * @param {any} input
 */
export async function foregroundAgents(input) {
  const ti = input?.tool_input;
  if (!ti || ti.run_in_background !== true) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "axnavi: 이 실행에서는 서브에이전트를 포그라운드로 돌린다",
      updatedInput: { ...ti, run_in_background: false },
    },
  };
}

/**
 * MCP 브리지 설정에서 우리 서버를 꺼내, 이 경로에 필요한 도구만 내놓게 좁힌다.
 * 질문·승인은 canUseTool 이 받으므로 브리지의 AskUserQuestion·Approve 는 쓰지 않는다.
 * @param {string | undefined} configPath
 */
export function sdkMcpServers(configPath) {
  if (!configPath) return {};
  try {
    const servers = JSON.parse(readFileSync(configPath, "utf8"))?.mcpServers ?? {};
    return Object.fromEntries(Object.entries(servers).map(([name, s]) => [
      name,
      { ...s, env: { ...(s.env ?? {}), AXNAVI_MCP_TOOLS: "QueryIndex,Skill" } },
    ]));
  } catch {
    return {};
  }
}

export class AgentSdkProvider {
  /**
   * @param {{ cwd?: string, pluginDir?: string, mcpConfigPath?: string, settings?: string, host: Host }} options
   */
  constructor(options) {
    this.id = "agent-sdk";
    this.options = options;
    this.capabilities = {
      ownsAgentLoop: true,
      streaming: true,
      promptCaching: true,
      reportsCost: true,
      resumable: false,
      maxContextTokens: 1_000_000,
    };
  }

  /**
   * @param {any} spec
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   */
  async *runDelegated(spec, prompt, signal) {
    const { host } = this.options;
    const allowDelegation = spec.allowDelegation === true;
    const preamble = [
      toolBriefing(spec.tools, allowDelegation, { nativeAsk: true }),
      spec.system ? `<역할 지침>\n${spec.system}\n</역할 지침>` : "",
    ].filter(Boolean).join("\n\n");

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const background = createBackgroundWatch();

    /** @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool} */
    const canUseTool = async (toolName, input) => {
      // 우리 도구(인덱스 조회·스킬 요청)는 읽기·접수뿐이라 묻지 않는다. allowedTools 로 열면 SDK 가 경고한다.
      if (toolName.startsWith("mcp__axnavi__")) return { behavior: "allow", updatedInput: input };
      if (toolName === "AskUserQuestion") {
        const answers = await answerQuestions(input, host.ask);
        if (!answers) return { behavior: "deny", message: noAnswerText(host.canAsk?.() === false ? "no_one" : "skipped") };
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      const decision = await host.approve(toolName, input);
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
        : { behavior: "deny", message: decision.message };
    };

    const stream = query({
      prompt,
      options: {
        model: /** @type {Record<string, string>} */ (MODEL_BY_TIER)[spec.tier] ?? "sonnet",
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(spec.resumeFrom ? { resume: spec.resumeFrom } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: preamble },
        permissionMode: spec.permissionMode === "auto" ? "auto" : "default",
        // 내장 AskUserQuestion 은 살린다 — canUseTool 이 받아 우리 화면에 그린다.
        disallowedTools: toDisallowedTools(spec.tools, allowDelegation).filter((n) => n !== "AskUserQuestion"),
        ...(allowDelegation && this.options.pluginDir ? { plugins: [{ type: "local", path: this.options.pluginDir }] } : {}),
        mcpServers: sdkMcpServers(this.options.mcpConfigPath),
        strictMcpConfig: true,
        canUseTool,
        hooks: { PreToolUse: [{ matcher: "Agent", hooks: [foregroundAgents] }] },
        env: delegatedEnv(process.env, this.options.pluginDir ? { pluginDir: this.options.pluginDir } : {}),
        abortController: abort,
        extraArgs: {
          ...(allowDelegation ? { "forward-subagent-text": null } : {}),
          ...(this.options.settings ? { settings: this.options.settings } : {}),
        },
      },
    });

    try {
      for await (const msg of stream) {
        background.observe(msg);
        for (const event of translateEvent(msg)) yield event;
      }
      const unfinished = signal?.aborted ? [] : background.unfinished();
      if (unfinished.length) {
        yield { type: "error", error: { kind: "unknown", message: `백그라운드 작업 ${unfinished.length}개가 끝나기 전에 중단됐습니다: ${unfinished.join(", ")}`, retryable: false } };
      }
    } catch (error) {
      if (signal?.aborted) return; // 사용자가 끊은 것은 오류가 아니다
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", error: { kind: /auth|login|credential/i.test(message) ? "auth" : "unknown", message, retryable: false } };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async createSession() {
    throw new Error("agent-sdk Provider 는 runDelegated 경로로만 실행된다.");
  }
}
