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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/** @typedef {import("@ax-navi/core").ProviderEvent} ProviderEvent */
/** @typedef {import("@ax-navi/core").SessionSpec} SessionSpec */
/** @typedef {import("@ax-navi/core").LLMProvider} LLMProvider */
/** @typedef {import("@ax-navi/core").LLMSession} LLMSession */
/** @typedef {import("@ax-navi/core").ProviderCapabilities} ProviderCapabilities */

/** 등급 → `--model` 인자. claude가 별칭을 받아 실제 id로 푼다(실측: sonnet → claude-sonnet-5). */
const MODEL_BY_TIER = { fast: "haiku", standard: "sonnet", deep: "opus" };

/** claude Code 내장 도구 중 소스를 고치는 것들. 역할이 허용하지 않으면 전부 끈다. */
const MUTATING = ["Edit", "MultiEdit", "NotebookEdit", "Write"];

/*
 * 우리가 쓰는 도구. 이 목록에 없는 claude Code 기능은 전부 끈다.
 *
 * 처음에는 반대로 "끌 것"만 나열했는데 그러면 빠뜨린 것이 새어 나온다 —
 * 실측에서 ScheduleWakeup·ToolSearch·PowerShell 이 그렇게 튀어나왔다.
 * 허용할 것을 적고 나머지를 끄는 쪽이 빠뜨릴 여지가 없다.
 */
const KEEP = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "Task", "TaskOutput", "TaskStop"];

/*
 * claude Code 2.1.x 가 제공하는 도구 전체(init 이벤트에서 실측).
 * 새 버전에서 도구가 늘면 여기 없는 것은 못 끄므로, 주기적으로 --verbose 로 확인해야 한다.
 */
const CLAUDE_CODE_TOOLS = [
  "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit",
  "EnterWorktree", "ExitWorktree", "Glob", "Grep", "ListAgents", "ListMcpResourcesTool",
  "Monitor", "MultiEdit", "NotebookEdit", "PowerShell", "PushNotification", "Read",
  "ReadMcpResourceDirTool", "ReadMcpResourceTool", "RemoteTrigger", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "Skill", "SlashCommand",
  "TaskOutput", "TaskStop", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write",
];

/*
 * 서브에이전트 호출. 기본은 끈다 — 우리가 관측할 수 없는 실행이 생기기 때문이다.
 *
 * 다만 오케스트레이터 스킬(harness-init 등)은 여러 전문 에이전트를 순서대로 부르는 것이
 * 절차의 본체라, 이걸 막으면 스킬 자체가 성립하지 않는다. spec.allowDelegation이
 * 요청될 때만 연다.
 */
const DELEGATION_TOOLS = ["Task", "TaskOutput", "TaskStop"];

/** AX-NAVI MCP 서버가 노출하는 도구. claude 쪽에서는 이 이름으로 보인다. */
const MCP_TOOLS = ["mcp__axnavi__AskUserQuestion", "mcp__axnavi__QueryIndex"];

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

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) out.push({ type: "text_delta", text: block.text });
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
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
        });
      }
    }
    return out;
  }

  if (msg.type === "result") {
    // 다음 턴에 --resume 으로 이어 붙일 식별자. 이게 있어야 REPL이 대화를 기억한다.
    if (msg.session_id) out.push({ type: "session", id: msg.session_id });
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
      const names = msg.permission_denials.map((/** @type {any} */ d) => d.tool_name ?? d.tool ?? "?");
      out.push({
        type: "tool_result",
        toolUseId: "(권한)",
        content: `권한으로 거부된 도구 ${msg.permission_denials.length}건: ${names.join(", ")}`,
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
    const payload = spec.system
      ? `<역할 지침>\n${spec.system}\n</역할 지침>\n\n${prompt}`
      : prompt;

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
      ...(this.options.mcpConfigPath ? ["--mcp-config", this.options.mcpConfigPath] : []),
      ...this.options.extraArgs ?? [],
    ];

    const disallowed = toDisallowedTools(spec.tools, spec.allowDelegation === true);
    if (disallowed.length) args.push("--disallowedTools", ...disallowed);

    /*
     * 우리 MCP 도구는 미리 승인해 둔다. -p 모드에는 승인해 줄 사람이 없어서
     * 승인 대기 = 거부가 되기 때문이다.
     */
    if (this.options.mcpConfigPath) {
      args.push("--allowedTools", ...MCP_TOOLS);
    }

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
      env: { ...process.env, ...this.options.env },
    });
    child.stdin.end(payload, "utf8");

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
        pending.push(...translateEvent(JSON.parse(text)));
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
