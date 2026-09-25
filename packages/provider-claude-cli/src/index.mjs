/*
 * LLMProvider 구현 — 설치된 `claude` CLI 위임.
 *
 * 존재 이유는 인증 하나다. Anthropic은 제3자 제품이 claude.ai 구독 로그인을 쓰는 것을
 * 허용하지 않으므로, Messages API 경로는 반드시 ANTHROPIC_API_KEY가 있어야 한다.
 * 사용자가 이미 `claude`에 로그인해 둔 환경에서는 그 프로세스를 부르는 것이
 * **구독으로 AX-NAVI를 돌릴 수 있는 유일한 길**이다.
 *
 * 브리프 §17은 `spawn("claude", [prompt])` 수준의 thin wrapper가 최종 Core가 되는 것을
 * 금지한다. 여기서는 그 금지를 이렇게 지킨다.
 * - Core는 여전히 LLMProvider 인터페이스만 안다. 이 파일을 빼도 나머지가 그대로 돈다.
 * - 이 Provider는 `ownsAgentLoop: true`로 자기 성격을 정직하게 신고하고, 그 때문에
 *   Core의 ToolGateway 경로가 아니라 runDelegated라는 **다른 경로**로만 실행된다.
 *   "Gateway가 막고 있다"는 착각이 남지 않게 하려는 것이다.
 * - 역할 제약은 버리지 않는다. frontmatter의 `tools:`를 `--disallowedTools`로 번역해
 *   같은 불변식을 claude 쪽 권한 체계로 강제한다(실측: Edit·Write가 도구 목록에서 사라진다).
 *
 * 한계는 숨기지 않는다.
 * - claude Code 자신의 시스템 프롬프트·MCP·스킬이 매 호출에 얹힌다. 실측으로 한 단어
 *   답변에 cache_read 40K 토큰이 붙었다. 같은 작업이 Messages API 경로보다 비싸다.
 * - `--bare`로 그 부담을 줄일 수 있지만 그 플래그는 OAuth를 읽지 않는다고 명시돼 있어
 *   (도움말 원문: "OAuth and keychain are never read") 구독 인증과 양립하지 않는다. 쓰지 않는다.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const NEWLINE = String.fromCharCode(10);

/** @typedef {import("@ax-navi/core").ProviderEvent} ProviderEvent */
/** @typedef {import("@ax-navi/core").SessionSpec} SessionSpec */
/** @typedef {import("@ax-navi/core").LLMProvider} LLMProvider */
/** @typedef {import("@ax-navi/core").LLMSession} LLMSession */
/** @typedef {import("@ax-navi/core").ProviderCapabilities} ProviderCapabilities */

/** 등급 → `--model` 인자. claude가 별칭을 받아 실제 id로 푼다(실측: sonnet → claude-sonnet-5). */
export const MODEL_BY_TIER = { fast: "haiku", standard: "sonnet", deep: "opus" };

/** claude Code 내장 도구 중 소스를 고치는 것들. 역할이 허용하지 않으면 전부 끈다. */
const MUTATING = ["Edit", "MultiEdit", "NotebookEdit", "Write"];

/*
 * 우리가 쓰는 도구. 이 목록에 없는 claude Code 기능은 전부 끈다.
 *
 * 처음에는 반대로 "끌 것"만 나열했는데 그러면 빠뜨린 것이 새어 나온다 —
 * 실측에서 ScheduleWakeup·ToolSearch·PowerShell 이 그렇게 튀어나왔다.
 * 허용할 것을 적고 나머지를 끄는 쪽이 빠뜨릴 여지가 없다.
 */
const KEEP = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "Task", "Agent", "TaskOutput", "TaskStop"];

/*
 * claude Code 2.1.x 가 제공하는 도구 전체(init 이벤트에서 실측).
 * 새 버전에서 도구가 늘면 여기 없는 것은 못 끄므로, 주기적으로 --verbose 로 확인해야 한다.
 */
const CLAUDE_CODE_TOOLS = [
  "Task", "Agent", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit",
  "EnterWorktree", "ExitWorktree", "Glob", "Grep", "ListAgents", "ListMcpResourcesTool",
  "Monitor", "MultiEdit", "NotebookEdit", "PowerShell", "PushNotification", "Read",
  "ReadMcpResourceDirTool", "ReadMcpResourceTool", "RemoteTrigger", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "Skill", "SlashCommand",
  "TaskOutput", "TaskStop", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write",
  /*
   * 지연 로딩 도구 — init 이벤트의 도구 목록에는 **나오지 않는데** 이름으로 부르면 불린다.
   * 내장 AskUserQuestion 이 새어 나와 axnavi 의 질문 도구 대신 쓰였고, -p 모드라 질문이 아니라
   * "AskUserQuestion 실행할까요?" 권한 창으로 떴다(2026-09-24 실측, claude 2.1.281).
   */
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
];

/*
 * 서브에이전트 호출. 기본은 끈다 — 우리가 관측할 수 없는 실행이 생기기 때문이다.
 *
 * 다만 오케스트레이터 스킬(harness-init 등)은 여러 전문 에이전트를 순서대로 부르는 것이
 * 절차의 본체라, 이걸 막으면 스킬 자체가 성립하지 않는다. spec.allowDelegation이
 * 요청될 때만 연다.
 */
/*
 * claude 는 목록에는 Task 로 알리면서 실제 호출은 Agent 로 보낸다(실측).
 * 둘 다 적어 둔다 — 한 쪽만 적으면 막았다고 생각한 곳이 안 막힐 수 있다.
 */
const DELEGATION_TOOLS = ["Task", "Agent", "TaskOutput", "TaskStop"];

/** AX-NAVI MCP 서버가 노출하는 도구. claude 쪽에서는 이 이름으로 보인다. */
const MCP_TOOLS = ["mcp__axnavi__AskUserQuestion", "mcp__axnavi__QueryIndex", "mcp__axnavi__Skill"];
/** 권한 판단을 넘겨받는 도구. 모델이 부르는 도구가 아니라서 MCP_TOOLS 에 넣지 않는다. */
export const APPROVE_TOOL = "mcp__axnavi__Approve";

/**
 * 역할이 허용한 도구를 claude 쪽 `--disallowedTools` 목록으로 번역한다.
 * 켤 것을 고르는 게 아니라 끌 것을 고른다 — claude는 내장 도구를 기본 제공하므로
 * 화이트리스트만으로는 나머지가 남는다.
 * @param {readonly import("@ax-navi/core").ToolDefinition[]} tools
 * @param {boolean} [allowDelegation]  서브에이전트 호출을 허용할지
 * @returns {string[]}
 */
export function toDisallowedTools(tools, allowDelegation = false) {
  const allowed = new Set(tools.map((t) => t.name));
  /** 이 실행에서 살려 둘 도구. */
  const keep = new Set(
    KEEP.filter((name) => {
      if (DELEGATION_TOOLS.includes(name)) return allowDelegation;
      /*
       * 수정 도구는 역할이 **그 도구를 콕 집어** 허용했을 때만 연다.
       * "Write가 있으면 Edit도" 식으로 묶으면 13개 에이전트의 불변식이 깨진다 —
       * 그들은 리포트를 쓰되 소스는 고치지 않는 역할이라 Write만 갖고 Edit은 없다.
       */
      if (MUTATING.includes(name)) return allowed.has(name);
      return true;
    }),
  );
  return CLAUDE_CODE_TOOLS.filter((name) => !keep.has(name));
}

/**
 * 위임 실행의 claude 인자를 만든다.
 *
 * spawn 안에 묻어 두었더니 두 개가 조용히 틀린 채로 나갔다 — 서브에이전트 이름을
 * 안 넘겨 팬아웃이 사라졌고, 도구 안내문이 위임 도구를 빼먹어 모델이 위임을 포기했다.
 * 둘 다 화면에는 '그냥 혼자 다 한 것'처럼 보여서 오래 눈에 띄지 않았다.
 * 순수 함수로 꺼내 두면 테스트가 잡는다.
 *
 * @param {SessionSpec} spec
 * @param {{ extraArgs?: string[], mcpConfigPath?: string, pluginDir?: string }} options
 * @param {string | null} muteSettings  호스트 플러그인을 끄는 설정 파일 경로
 * @returns {string[]}
 */
export function buildDelegatedArgs(spec, options, muteSettings) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", MODEL_BY_TIER[spec.tier],
    // 이어가기. 없으면 새 대화로 시작한다.
    ...(spec.resumeFrom ? ["--resume", spec.resumeFrom] : []),
    /*
     * 사용자가 개인적으로 붙여 둔 MCP 서버는 우리 도구 계약 밖이다.
     * --strict-mcp-config 로 그것들을 끊고, --mcp-config 로 우리 것만 올린다.
     */
    "--strict-mcp-config",
    ...(options.mcpConfigPath ? ["--mcp-config", options.mcpConfigPath] : []),
    // 호스트에 설치된 플러그인을 끌다 — 우리가 쓰는 것은 CLI 자기 설치 경로의 사본이다.
    ...(muteSettings ? ["--settings", muteSettings] : []),
    ...options.extraArgs ?? [],
  ];

  /*
   * 서브에이전트가 무엇을 말하는지까지 받아온다.
   * 도구 호출은 이 플래그 없이도 오지만, 서브에이전트가 내놓는 글은 이게 있어야 보인다.
   * 위임이 꿠진 경우엔 서브에이전트 자체가 없으므로 붙일 이유가 없다.
   */
  if (spec.allowDelegation === true) args.push("--forward-subagent-text");

  /*
   * 서브에이전트 이름을 알려 준다.
   *
   * 오케스트레이터 스킬은 Agent(subagent_type="ax-navi:<이름>") 로 위임한다.
   * 그런데 위임된 claude 는 우리 agents/ 를 모르고, 호스트 플러그인도 꺼 둔 상태라
   * 그 이름이 어디에도 없다. 실측으로 전부 이렇게 끝났다.
   *
   *   Agent type 'ax-navi:feature-finder' not found.
   *   Available agents: claude, Explore, general-purpose, Plan, statusline-setup
   *
   * 그래서 팬아웃이 아예 일어나지 않고 오케스트레이터가 혼자 다 했다. 화면에
   * 서브에이전트가 안 보였던 것은 렌더링 문제가 아니라 이것이었다.
   *
   * --agents JSON 으로는 못 넘긴다 — agents/ 합계 211KB, analyzer.md 46.6KB 인데
   * 윈도우 명령줄 상한이 32KB 다. 경로 하나만 주는 --plugin-dir 을 쓴다.
   * 위임이 꺼진 실행에는 붙이지 않는다. 서브에이전트를 못 띄우는 역할에게
   * 이름만 보여 주면 부르려다 한 턴을 날린다.
   */
  if (spec.allowDelegation === true && options.pluginDir) {
    args.push("--plugin-dir", options.pluginDir);
  }

  const disallowed = toDisallowedTools(spec.tools, spec.allowDelegation === true);
  if (disallowed.length) args.push("--disallowedTools", ...disallowed);

  /*
   * 우리 MCP 도구는 미리 승인해 둔다. -p 모드에는 승인해 줄 사람이 없어서
   * 승인 대기 = 거부가 되기 때문이다.
   */
  if (options.mcpConfigPath) {
    args.push("--allowedTools", ...MCP_TOOLS);
    /*
     * 승인이 필요한 도구는 사람에게 묻는다 — 플러그인에서 Claude Code 가 하던 일이다.
     * 이게 없으면 -p 모드에서 "승인 대기 = 거부" 가 되어, 기본 설정 PC 에서는
     * Write 가 막히고 파일이 안 생긴다(실측). 권한 모드는 넘기지 않는다 —
     * 사용자·조직 설정(managed-settings 포함)이 정한 모드를 그대로 따르고,
     * 그 모드가 "물어야 한다" 고 할 때만 여기로 온다.
     */
    args.push("--permission-prompt-tool", APPROVE_TOOL);
  }
  return args;
}
/*
 * 실행 파일 해석.
 *
 * 윈도우에서 `claude`는 npm이 만든 셈(.cmd/.ps1)이고, Node는 .cmd를 shell 없이 띄우지
 * 못한다. 그렇다고 shell:true로 띄우면 인자가 한 줄의 명령 문자열로 합쳐지는데,
 * 우리는 690줄짜리 에이전트 본문을 --append-system-prompt로 넘겨야 한다 —
 * 따옴표·줄바꿈·백틱이 섞인 그 문자열은 명령줄에서 반드시 깨진다
 * (실측: "option '--append-system-prompt <prompt>' argument missing").
 *
 * 그래서 셈이 가리키는 진짜 실행 파일을 찾아 shell 없이 띄운다. 인자가 배열 그대로
 * 전달되므로 길이·특수문자 문제가 사라진다.
 */
/** @type {string | null} */
let cachedBin = null;

/** @returns {string | null} */
export function resolveClaudeBin() {
  if (cachedBin) return cachedBin;

  if (process.platform !== "win32") {
    cachedBin = "claude";
    return cachedBin;
  }

  const lookup = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
  const hits = (lookup.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 셈이 있는 디렉터리 옆에 실제 .exe가 설치돼 있다.
  for (const hit of hits) {
    const exe = join(dirname(hit), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) {
      cachedBin = exe;
      return cachedBin;
    }
  }
  const directExe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (directExe) {
    cachedBin = directExe;
    return cachedBin;
  }
  return null;
}

/**
 * claude 실행 파일이 있는지 확인한다.
 * @returns {{ ok: true, version: string, bin: string } | { ok: false, reason: string }}
 */
export function probeClaudeCli() {
  const bin = resolveClaudeBin();
  if (!bin) return { ok: false, reason: "claude 실행 파일을 찾지 못했다 (npm i -g @anthropic-ai/claude-code)" };
  try {
    const out = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (out.status !== 0) {
      return { ok: false, reason: `claude --version 실패 (exit ${out.status})` };
    }
    return { ok: true, version: (out.stdout || "").trim(), bin };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 도구 결과 본문을 사람이 읽는 문자열로 편다.
 *
 * MCP 도구의 결과는 `[{type:"text", text:"..."}]` 봉투로 온다. 그대로 찍으면
 * 화면에 JSON 봉투가 보이고 정작 내용은 이스케이프된 채로 묻힌다.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function flattenToolContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : null))
      .filter((t) => t !== null);
    // 텍스트 블록만으로 이뤄져 있으면 그것만 이어 붙인다. 아니면 원형을 보여 준다.
    if (texts.length === content.length) return texts.join("\n");
  }
  return JSON.stringify(content);
}

/**
 * stream-json 한 줄을 ProviderEvent들로 옮긴다.
 * claude의 이벤트 형태는 실측으로 확인한 것만 다룬다 — 추측한 필드는 넣지 않는다.
 * @param {any} msg
 * @returns {ProviderEvent[]}
 */
export function translateEvent(msg) {
  /** @type {ProviderEvent[]} */
  const out = [];

  /*
   * 서브에이전트 안에서 난 일은 그를 띄운 Task 호출의 id 를 달고 온다.
   * 이걸 버리면 서브에이전트의 도구 호출이 최상위 호출처럼 평평하게 쌏아져, 누가
   * 무엇을 하고 있는지 화면에서 구분되지 않는다(실측).
   */
  const parent = typeof msg.parent_tool_use_id === "string" ? { parentId: msg.parent_tool_use_id } : {};

  /*
   * 세션 식별자를 **첫머리에서** 받는다.
   *
   * 예전에는 result 이벤트에서만 받았다. 그런데 사용자가 턴을 중단하면 result 가
   * 오지 않는다 — 그러면 그 대화는 이어 붙일 id 가 없어서 통째로 사라진다.
   * 실측으로 그랬다: /find 를 59초에 끊고 "계속 해줘" 라고 하니 앞 맥락이 없다고 답했다.
   *
   * claude 는 맨 첫 메시지(system/hook_started)부터 session_id 를 준다. 그래서 여기서
   * 받는다. system 과 result 로만 한정하는 것은 assistant 메시지마다 같은 값을 다시
   * 내보내지 않기 위해서다.
   */
  if ((msg.type === "system" || msg.type === "result") && typeof msg.session_id === "string") {
    out.push({ type: "session", id: msg.session_id });
  }
  if (msg.type === "system") return out;

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) out.push({ type: "text_delta", text: block.text, ...parent });
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input, ...parent });
      }
    }
    return out;
  }

  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        out.push({
          type: "tool_result",
          toolUseId: block.tool_use_id,
          content: flattenToolContent(block.content).slice(0, 2000),
          isError: block.is_error === true,
          ...parent,
        });
      }
    }
    return out;
  }

  if (msg.type === "result") {
    const u = msg.usage ?? {};
    out.push({
      type: "usage",
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        // 이 경로는 비용을 실제로 돌려준다. 추정치가 아니다.
        ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
      },
    });

    // 권한 거부를 조용히 넘기지 않는다 — 역할 제약이 실제로 걸렸다는 증거이자,
    // 에이전트가 필요한 도구를 못 써서 결과가 부실해졌을 수 있다는 신호다.
    if (Array.isArray(msg.permission_denials) && msg.permission_denials.length) {
      /*
       * 같은 도구가 여러 번 거부되는 일이 흔하다 — 모델은 다시 부르며 버틴다.
       * 이름을 나열하면 같은 것이 줄지어 서니 몇 종류가 막혔는지가 안 보인다.
       */
      /** @type {Map<string, number>} */
      const tally = new Map();
      for (const d of msg.permission_denials) {
        const name = String(d.tool_name ?? d.tool ?? "?").replace(/^mcp__axnavi__/, "");
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
      const names = [...tally].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
      out.push({
        type: "tool_result",
        toolUseId: "(권한)",
        // 도구 이름 자리에 무엇이 막혔는지를 넣는다 — "(위임)" 은 읽는 사람에게 아무 뜻도 없다.
        toolName: "권한 거부",
        content: `${names.join(", ")} — 이 실행에서 허용되지 않은 도구다. 그만큼 결과가 부실할 수 있다.`,
        isError: true,
      });
    }

    if (msg.is_error || msg.subtype !== "success") {
      out.push({
        type: "error",
        error: {
          kind: msg.api_error_status ? "unknown" : "invalid_request",
          message: msg.result || msg.subtype || "claude 실행이 실패로 끝났다",
          retryable: false,
        },
      });
      return out;
    }

    out.push({ type: "turn_end", stopReason: msg.stop_reason === "max_tokens" ? "max_tokens" : "end_turn", content: [] });
    out.push({ type: "done" });
    return out;
  }

  return out;
}

/** @implements {LLMProvider} */
export class ClaudeCliProvider {
/**
   * @param {object} [options]
   * @param {string[]} [options.extraArgs]
   * @param {string} [options.cwd]
   * @param {string} [options.mcpConfigPath]  AX-NAVI MCP 서버 설정 파일
   * @param {Record<string, string>} [options.env]  MCP 서버에 넘길 환경변수
   * @param {string} [options.pluginDir]  세션 한정으로 물릴 우리 설치본 경로. 서브에이전트 이름이 여기서 나온다.
   */
  constructor(options = {}) {
    this.id = "claude-cli";
    this.options = options;
    /** @type {ProviderCapabilities} */
    this.capabilities = {
      // 정직하게 신고한다. 이 한 줄이 Core를 다른 실행 경로로 보낸다.
      ownsAgentLoop: true,
      streaming: true,
      promptCaching: true,
      // result 이벤트가 total_cost_usd를 실제로 준다.
      reportsCost: true,
      resumable: false,
      maxContextTokens: 1_000_000,
    };
  }

  /**
   * @param {SessionSpec} spec
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   * @returns {AsyncIterable<ProviderEvent>}
   */
  async *runDelegated(spec, prompt, signal) {
    /*
     * 역할 지침과 요청을 모두 stdin으로 보낸다. 명령줄 인자로 넘기지 않는 이유가 둘 있다.
     *
     * 1) 길이 — 윈도우 명령줄 상한은 32KB인데 agents/analyzer.md 하나가 47KB고
     *    skills/harness-init/SKILL.md 는 50KB다. 인자로 넘기면 spawn ENAMETOOLONG 으로 죽는다(실측).
     * 2) `--append-system-prompt-file` 은 이 버전(2.1.259)에서 인자로 받아들여지지만
     *    실제로는 아무 효과가 없다(실측: 지정한 지침과 무관한 응답, 대조군과 출력 동일).
     *    조용히 무시되는 경로라 쓰지 않는다.
     *
     * 대신 stdin은 길이 제한이 없다. 시스템 프롬프트로서의 분리는 잃지만,
     * 지침이 조용히 사라지는 것보다 낫다.
     */
    /*
     * 쓸 수 있는 도구를 먼저 알린다.
     *
     * 안 알려 주면 모델이 없는 도구를 부르고 한 턴을 날린다 — 실측으로 analyzer 가
     * Edit 를 불렀다가 "No such tool available: Edit" 를 받고 되돌아갔다.
     * 없다는 사실뿐 아니라 대신 무엇을 할지까지 적어 준다.
     */
    const preamble = [
      toolBriefing(spec.tools, spec.allowDelegation === true),
      spec.system ? `<역할 지침>\n${spec.system}\n</역할 지침>` : "",
    ].filter(Boolean).join("\n\n");
    const payload = delegatedPayload(preamble, prompt, spec.resumeFrom);
    let compacted = false;

    const args = buildDelegatedArgs(spec, this.options, pluginMuteSettings());

    const bin = resolveClaudeBin();
    if (!bin) {
      yield {
        type: "error",
        error: { kind: "invalid_request", message: "claude 실행 파일을 찾지 못했다", retryable: false },
      };
      return;
    }

    // shell:false — 인자를 배열 그대로 넘긴다. 프롬프트는 stdin으로 들어간다.
    const child = spawn(bin, args, {
      cwd: this.options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      // MCP 서버는 claude 의 자식으로 뜨므로 환경변수가 거기까지 상속된다.
      /*
       * CLAUDE_PLUGIN_ROOT 를 채워 둔다 — 두 번째 방어선이다.
       *
       * 스킬·에이전트 본문의 참조는 우리가 미리 절대경로로 바꿔 넣는다. 그래도 놓친
       * 표기나 모델이 스스로 적어 넣는 경우가 남는다. 그때 이 변수가 비어 있으면
       * node "/agents/lib/build-index.mjs" 처럼 루트에서 찾다가 실패한다(실측:
       * scaffold-feature 가 "인덱싱 스크립트 경로를 확보하지 못해 갱신 못함"이라 보고).
       * 값은 우리 설치 경로다 — 스크립트가 실제로 거기 있다.
       */
      env: delegatedEnv(process.env, this.options),
    });
    child.stdin.end(payload, "utf8");
    const background = createBackgroundWatch();

    const onAbort = () => terminateTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    /** @type {ProviderEvent[]} */
    const pending = [];
    /** @type {Array<() => void>} */
    const wakeups = [];
    let finished = false;
    /** @type {number | null} */
    let exitCode = null;

    const wake = () => { for (const w of wakeups.splice(0)) w(); };
    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const text = line.trim();
      if (!text.startsWith("{")) return;
      try {
        const msg = JSON.parse(text);
        background.observe(msg);
        if (msg.type === "system" && msg.subtype === "compact_boundary") compacted = true;
        if (msg.type === "result" && typeof msg.session_id === "string") {
          if (msg.is_error || compacted) sentPreamble.delete(msg.session_id);
          else sentPreamble.set(msg.session_id, preamble);
        }
        pending.push(...translateEvent(msg));
        wake();
      } catch {
        // 파싱 실패한 줄은 버리되 조용히 넘어가지 않도록 stderr에 남긴다.
        stderr += `\n[파싱 실패] ${text.slice(0, 200)}`;
      }
    });

    child.on("close", (code) => { finished = true; exitCode = code; wake(); });
    child.on("error", (error) => {
      finished = true;
      stderr += `\n${error.message}`;
      wake();
    });

    try {
      for (;;) {
        if (pending.length) {
          yield /** @type {ProviderEvent} */ (pending.shift());
          continue;
        }
        if (finished) break;
        await new Promise((resolve) => wakeups.push(/** @type {() => void} */ (resolve)));
      }

      /*
       * 정상 종료가 아닌데 result 이벤트도 없었다면 실패를 성공으로 보고하지 않는다.
       * 단, 사용자가 끊은 경우는 제외한다 — 우리가 죽여 놓고 "claude 종료 코드 1"을
       * 오류라고 알리는 것은 사실이 아니다(실측: 중단할 때마다 불필요한 오류가 찍혔다).
       */
      /* 상한에 걸려 죽은 백그라운드 작업이 있으면 claude 가 success 라고 해도 완료가 아니다. */
      const unfinished = signal?.aborted ? [] : background.unfinished();
      if (unfinished.length) {
        yield {
          type: "error",
          error: {
            kind: "unknown",
            message: `백그라운드 작업 ${unfinished.length}개가 끝나기 전에 중단됐습니다(claude -p 대기 상한 CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS). 결과가 버려져 이 실행은 완료되지 않았습니다: ${unfinished.join(", ")}`,
            retryable: false,
          },
        };
      }
      if (exitCode !== 0 && exitCode !== null && !signal?.aborted) {
        yield {
          type: "error",
          error: {
            kind: /not (logged in|authenticated)|login/i.test(stderr) ? "auth" : "unknown",
            message: `claude 종료 코드 ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
            retryable: false,
          },
        };
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      if (!finished) terminateTree(child);
    }
  }

  /**
   * @param {SessionSpec} _spec
   * @returns {Promise<LLMSession>}
   */
  async createSession(_spec) {
    // 이 Provider는 턴 단위로 부를 수 없다. 할 수 있는 척하지 않는다.
    throw new Error(
      "claude-cli Provider는 턴 단위 세션을 제공하지 않는다 — runDelegated 경로로만 실행된다.",
    );
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<LLMSession>}
   */
  async resume(sessionId) {
    throw new Error(`세션 재개는 아직 구현하지 않았다 (${sessionId}).`);
  }

  /** @returns {Promise<void>} */
  async cancel() {}
}

/*
 * `claude -p` 의 백그라운드 대기 상한.
 *
 * 헤드리스 claude 는 메인 턴이 끝난 뒤에도 백그라운드 서브에이전트를 기다리지만, 기다리며 쉬는
 * 시간이 기본 10분(CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=600000)을 넘으면 **돌던 작업을 죽이고
 * 부분 결과를 버린 채 success 로 끝난다.** 페어 harness-init 에서 오케스트레이터가 analyzer 둘을
 * 백그라운드로 띄우고 턴을 마치자 정확히 10분 뒤 둘 다 죽고 axnavi 는 종료 코드 0 으로 끝났다
 * (실측 2회: 10m 13s·10m 9s / 17:19→17:29). 레거시 Full 분석은 10분을 쉽게 넘으므로 넉넉히 준다.
 * 사용자가 값을 정해 뒀으면 그것을 따른다.
 */
export const BACKGROUND_WAIT_CEILING_MS = String(6 * 60 * 60 * 1000);

/**
 * 위임 실행의 환경 변수.
 * @param {NodeJS.ProcessEnv} base
 * @param {{ pluginDir?: string, env?: Record<string, string> }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function delegatedEnv(base, options) {
  return {
    ...base,
    ...(base["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"] ? {} : { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: BACKGROUND_WAIT_CEILING_MS }),
    /*
     * MCP 도구 호출의 무응답 제한(기본 30분)을 끈다. 우리 MCP 도구는 승인 창·질문이라 사람이 답할
     * 때까지 블록되는 것이 정상이다 — 자리를 비운 사이 "Approve sent no response or progress for
     * 1800s; aborting" 으로 끊겨 그 명령이 실패하고 오케스트레이터가 30분을 잃었다(2026-09-24 실측).
     * 값은 claude 가 오류에서 직접 안내한 것이다(0 = 끔). 사용자가 정했으면 따른다.
     */
    ...(base["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] ? {} : { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" }),
    ...(options.pluginDir ? { CLAUDE_PLUGIN_ROOT: options.pluginDir } : {}),
    ...options.env,
  };
}

/**
 * 끝나기 전에 죽은 백그라운드 작업을 가려낸다.
 *
 * 상한에 걸려 죽어도 claude 의 result 는 success 다. 스트림의 `system/task_updated`
 * (`patch.status: "killed"`)만이 그 사실을 알려 준다. 모델이 스스로 TaskStop 으로 멈춘 것은
 * 의도한 중단이라 뺀다. 남는 것이 있으면 이 실행은 완료되지 않은 것이다.
 */
export function createBackgroundWatch() {
  /** @type {Map<string, string>} */
  const described = new Map();
  /** @type {Set<string>} */
  const killed = new Set();
  /** @type {Set<string>} */
  const stoppedByModel = new Set();
  return {
    /** @param {any} msg */
    observe(msg) {
      /*
       * 서브에이전트(`local_agent`)만 본다. 백그라운드 셸 명령(`local_bash`)은 메인 턴이 끝나면
       * 몇 초 뒤 정리되는 것이 claude -p 의 정상 동작이라 결과 유실이 아니다 — 그것까지 세어
       * 1h 38m 을 다 돌고 끝난 harness-init 을 "완료되지 않았다"고 알렸다(2026-09-24 실측).
       */
      if (msg?.type === "system" && msg.subtype === "task_started" && msg.task_id && msg.task_type === "local_agent") described.set(msg.task_id, String(msg.description || msg.task_id));
      if (msg?.type === "system" && msg.subtype === "task_updated" && msg.patch?.status === "killed" && described.has(msg.task_id)) killed.add(msg.task_id);
      if (msg?.type === "assistant") {
        for (const block of msg.message?.content || []) {
          if (block?.type === "tool_use" && block.name === "TaskStop") {
            const id = block.input?.task_id ?? block.input?.shell_id;
            if (id) stoppedByModel.add(String(id));
          }
        }
      }
    },
    /** @returns {string[]} 의도치 않게 중단된 작업 설명 */
    unfinished() {
      return [...killed].filter((id) => !stoppedByModel.has(id)).map((id) => described.get(id) ?? id);
    },
  };
}

/**
 * 자식 프로세스를 트리째 끝낸다.
 *
 * child.kill() 은 claude 하나만 죽인다. 그 밑에는 우리가 붙여 준 MCP 서버가
 * 손자로 떠 있고, Windows 에서는 부모가 죽어도 그게 살아남는다 — 그러면
 * 파이프가 닫히지 않아 중단이 체감되지 않는다. taskkill /T 로 트리를 끝는다.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function terminateTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // taskkill 이 없거나 이미 죽은 경우 — 아래 기본 경로로 내려간다.
    }
  }
  child.kill();
}

/*
 * 호스트에 설치된 플러그인을 끌다.
 *
 * axnavi 는 자기 설치 경로의 agents/ · skills/ 를 쓴다. 그런데 위임된 claude 는
 * 그것과 별개로, 작업 폴더에 설치된 플러그인을 그대로 본다(실측: ax-navi 0.2.0
 * 캐시본의 스킬 17종이 목록에 뗴다). 그러면 지금 고치고 있는 본이 아니라 예전
 * 설치본이 쓰일 수 있고, 어느 \履쪽이 돌았는지 화면에서 구분되지도 않는다.
 *
 * --safe-mode 는 안 된다 — 플러그인과 함께 --mcp-config 까지 끊어서 질문·인덱스
 * 도구가 사라진다(실측). --setting-sources 로 local 을 빼는 방법도 플러그인은
 * 가려지지만 그 프로젝트의 권한 허용 목록까지 같이 잎어버린다. 그래서 플러그인
 * 여부만 덮어쓰는 설정 파일을 따로 준다. 나머지 설정은 그대로 살아 있다.
 *
 * 끌 대상을 ax-navi 로 한정하지 않는 이유는 --strict-mcp-config 와 같다 — 우리가
 * 알지 못하는 도구·스킬이 끌어들면 도구 게이트웨이 계약이 그만큼 느슨해진다.
 *
 * 같은 파일에 백그라운드 서브에이전트를 포그라운드로 바꾸는 훅도 싣는다(delegatedSettings 참조).
 *
 * @returns {string | null} 설정 파일 경로. 만들지 못하면 null.
 */
function pluginMuteSettings() {
  if (mutePath !== undefined) return mutePath;
  mutePath = null;
  /** @type {string[]} */
  let names = [];
  try {
    const registry = join(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (existsSync(registry)) names = Object.keys(JSON.parse(readFileSync(registry, "utf8"))?.plugins ?? {});
  } catch {
    // 레지스트리를 못 읽어도 실행을 멈출 일은 아니다. 그냥 끌 것이 없다고 본다.
  }
  try {
    const file = join(mkdtempSync(join(tmpdir(), "axnavi-settings-")), "settings.json");
    writeFileSync(file, JSON.stringify(delegatedSettings(names, FOREGROUND_HOOK_COMMAND), null, 2), "utf8");
    mutePath = file;
  } catch {
    // 임시 폴더에 못 쓰면 설정 없이 돈다. 안내문의 "뒤에서 돌리지 마라" 가 남은 방어선이다.
  }
  return mutePath;
}

/*
 * 백그라운드 서브에이전트를 포그라운드로 바꾸는 훅.
 *
 * claude -p 는 뒤에서 도는 서브에이전트를 대기 상한이 지나면 죽이고, 그 서브에이전트는
 * 승인 창에도 닿지 못한다. 안내문으로 막았지만 지침일 뿐이었다. 실측: 이 훅이 있으면
 * run_in_background:true 호출이 is_backgrounded:false 로 돌아 결과가 그 자리에 돌아오고,
 * 없으면 "Async agent launched" 로 떠나 버린다. 거부하지 않고 바꿔 주므로 모델이
 * 다시 시도하느라 턴을 쓰지 않는다. 여러 개를 한 번에 부르면 여전히 동시에 돈다.
 */
const FOREGROUND_HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "foreground-agent-hook.mjs");
const FOREGROUND_HOOK_COMMAND = `"${process.execPath.replace(/\\/g, "/")}" "${FOREGROUND_HOOK_SCRIPT.replace(/\\/g, "/")}"`;

/*
 * 이어 가는 턴에는 이미 보낸 도구 안내·역할 지침을 다시 붙이지 않는다.
 *
 * 실측: 한 세션에서 턴마다 3KB가 다시 실려 대화 기록에 같은 덩어리가 16번 쌓였고,
 * 기록을 연 화면에도 매 턴 그대로 찍혔다. 도구나 역할이 바뀐 턴(스킬 실행 등)은
 * 안내가 달라지므로 다시 보낸다. 대화가 압축됐거나 턴이 실패했으면 기록을 지워
 * 다음 턴에 다시 보낸다 — 압축 요약에서 안내가 사라질 수 있기 때문이다.
 */
/** @type {Map<string, string>} 세션 id → 마지막으로 전한 안내 */
const sentPreamble = new Map();

/**
 * @param {string} preamble
 * @param {string} prompt
 * @param {string | undefined} resumeFrom
 * @param {Map<string, string>} [sent]
 */
export function delegatedPayload(preamble, prompt, resumeFrom, sent = sentPreamble) {
  const known = Boolean(resumeFrom) && sent.get(/** @type {string} */ (resumeFrom)) === preamble;
  return [known ? "" : preamble, prompt].filter(Boolean).join("\n\n");
}

/**
 * 위임 실행에 얹는 설정. 순수 함수로 꺼내 테스트가 모양을 고정한다.
 * @param {string[]} pluginNames  끌 호스트 플러그인
 * @param {string} hookCommand
 */
export function delegatedSettings(pluginNames, hookCommand) {
  return {
    ...(pluginNames.length ? { enabledPlugins: Object.fromEntries(pluginNames.map((n) => [n, false])) } : {}),
    hooks: {
      PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: hookCommand }] }],
    },
  };
}

/** @type {string | null | undefined} 한 프로세스에 한 번만 만든다. */
let mutePath;

/**
 * 이 실행에서 쓸 수 있는 도구를 한 덩어리로 알린다.
 *
 * 특히 Edit 계열은 막혀 있는 데다 위임된 서브에이전트에도 같이 걸린다 — 도구 제약이
 * 세션 단위로 걸리는 경로이기 때문이다. 그게 맞다(13개 에이전트가 Edit 없이 도는 계약).
 * 다만 그 사실을 모르면 모델이 매번 한 번씩 부딛혀 보고 되돌아간다.
 *
 * @param {readonly { name: string }[]} tools
 * @param {boolean} [allowDelegation]  서브에이전트를 띄울 수 있는 실행인가
 * @param {{ nativeAsk?: boolean }} [opts]  nativeAsk — 내장 AskUserQuestion 을 호스트가 직접 받는 실행(Agent SDK)
 * @returns {string}
 */
export function toolBriefing(tools, allowDelegation = false, opts = {}) {
  const names = tools.map((t) => t.name);
  if (!names.length) return "";
  const lines = [`<쓸 수 있는 도구>`, names.join(", ")];
  /*
   * 위임 도구는 우리 Gateway 의 목록에 없다. Gateway 가 실행하는 도구가 아니라
   * claude 자신이 가진 것이기 때문이다. 그런데 이 안내문을 Gateway 목록만으로
   * 만들었더니 모델이 **위임을 포기했다**(실측):
   *   "서브에이전트 호출(Task/Agent) 도구가 이 실행 환경에 없어서 …
   *    대신 각 에이전트 정의 파일을 직접 읽어 역할을 확인하겠다"
   * 도구는 열려 있는데 없다고 알린 셈이라, 오케스트레이터가 혼자 다 했다.
   */
  if (allowDelegation) {
    lines.push("Task(=Agent) 로 서브에이전트에 위임할 수 있다. subagent_type 은 ax-navi:<에이전트이름> 형식이다.");
    /*
     * 백그라운드 서브에이전트는 이 실행에서 승인 창에 닿지 못해 쓰기·명령이 자동 거부된다(실측:
     * 인덱싱·analyzer 5개가 거부로 실패, 같은 일을 포그라운드로 하자 됐다). 병렬은 한 메시지에
     * 여러 호출을 함께 보내면 포그라운드로도 된다 — 그러면 결과를 받을 때까지 턴도 기다린다.
     */
    lines.push("서브에이전트를 run_in_background 로 띄우지 마라 — 이 실행에서 백그라운드 서브에이전트는 승인 창을 받을 수 없어 쓰기·명령이 거부된다. 병렬이 필요하면 한 메시지에 Agent 호출 여러 개를 함께 보내라.");
  }
  if (!names.includes("Edit")) {
    lines.push("Edit·MultiEdit 은 이 실행에 없다(서브에이전트도 마찬가지). 파일을 고치려면 Read 로 읽고 Write 로 전체를 다시 써라.");
  }
  /* 스킬 본문은 "AskUserQuestion 으로 묻는다"고 적혀 있다. 그 이름의 내장 도구는 꺼 두었으니 실제 이름을 알려 준다. */
  if (names.includes("AskUserQuestion") && !opts.nativeAsk) {
    lines.push("사용자에게 묻는 것은 mcp__axnavi__AskUserQuestion 이다. 내장 AskUserQuestion 은 이 실행에 없다.");
  }
  lines.push(`</쓸 수 있는 도구>`);
  return lines.join(NEWLINE);
}
