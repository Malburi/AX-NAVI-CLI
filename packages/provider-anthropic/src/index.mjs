/*
 * LLMProvider 구현 — Anthropic Messages API.
 *
 * 이 패키지는 Core를 import하지만 Core는 이 패키지를 모른다. 방향이 한쪽인 덕분에
 * Provider를 갈아끼워도 Orchestrator·Workflow·Tool Gateway는 그대로다(브리프 §9·§17).
 *
 * 여기가 저장소에서 Anthropic SDK 타입을 보는 유일한 곳이다. 밖으로 나가는 값은
 * 전부 Core가 정의한 ProviderEvent로 정규화된다.
 *
 * 도구는 정의만 넘기고 실행하지 않는다 — 실행은 Core의 ToolGateway가 한다.
 * 그래서 capabilities.ownsAgentLoop가 false이고, 그 덕에 Gateway가 실제 통제점으로 남는다.
 */
import { AsyncQueue } from "./queue.mjs";

/*
 * SDK 는 **쓸 때** 불러온다.
 *
 * 최상위 import 로 두면 @anthropic-ai/sdk 를 못 받은 환경에서 CLI 가 통째로 안 뜬다.
 * 그런데 이 저장소의 주 경로는 claude CLI 위임(구독 인증)이라 SDK 가 아예 필요 없다 —
 * 사내망처럼 레지스트리가 막힌 곳에서 설치 자체가 실패할 이유가 없다.
 *
 * 그래서 package.json 에서 optionalDependencies 로 내리고, 여기서 늦게 부른다.
 * 없으면 "이 Provider 를 고를 때" 무엇이 없는지 말하고 멈춘다.
 */

/** SDK 의 **타입**만 참조한다. JSDoc 이라 런타임 import 를 만들지 않는다. */
/** @typedef {typeof import("@anthropic-ai/sdk").default} Sdk */

/** @type {Sdk | null} */
let Anthropic = null;

/**
 * SDK 를 적재한다. 두 번째부터는 캐시를 돌려준다.
 * @returns {Promise<Sdk>}
 */
export async function loadSdk() {
  if (Anthropic) return Anthropic;
  try {
    const mod = await import("@anthropic-ai/sdk");
    Anthropic = mod.default;
  } catch (cause) {
    throw new Error(
      [
        "anthropic Provider 를 쓰려면 @anthropic-ai/sdk 가 필요한데 없다.",
        "  설치: npm i -g @anthropic-ai/sdk",
        "  또는 claude CLI 경로를 쓴다: axnavi --provider claude-cli",
      ].join(String.fromCharCode(10)),
      { cause },
    );
  }
  return Anthropic;
}

/** @typedef {import("@ax-navi/core").ProviderEvent} ProviderEvent */
/** @typedef {import("@ax-navi/core").ContentBlock} ContentBlock */
/** @typedef {import("@ax-navi/core").SessionSpec} SessionSpec */
/** @typedef {import("@ax-navi/core").Turn} Turn */
/** @typedef {import("@ax-navi/core").LLMSession} LLMSession */
/** @typedef {import("@ax-navi/core").LLMProvider} LLMProvider */
/** @typedef {import("@ax-navi/core").ProviderCapabilities} ProviderCapabilities */

/**
 * 등급 → 실제 모델 id. Core에는 이 문자열이 없다.
 *
 * standard가 Sonnet 5인 것은 임의 선택이 아니다 — 이 저장소는 2026-09-08에
 * 초기화·수정 경로를 비용 때문에 Sonnet 5로 고정했고(docs/changelog.md),
 * agents/*.md의 frontmatter가 그 결정을 담고 있다.
 * @type {Record<import("@ax-navi/core").ModelTier, string>}
 */
const MODEL_BY_TIER = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  deep: "claude-opus-5",
};

/* 스트리밍이므로 넉넉히 잡는다 — 잘린 출력을 재시도하는 편이 더 비싸다. */
const DEFAULT_MAX_TOKENS = 32_000;

/**
 * SDK 오류를 Core의 ProviderError로 정규화한다.
 * 문자열 매칭 대신 SDK의 타입 클래스를 쓴다.
 * @param {unknown} error
 * @returns {import("@ax-navi/core").ProviderError}
 */
export function normalizeError(error) {
  /*
   * SDK 가 아직 안 올라왔으면 타입 클래스가 없다. 그때는 형태로 본다 —
   * 오류를 분류하다가 다시 오류를 내면 원래 오류가 사라진다.
   */
  if (!Anthropic) {
    const status = /** @type {any} */ (error)?.status;
    if (typeof status === "number") {
      return { kind: status >= 500 ? "overloaded" : "unknown", message: `API ${status}`, retryable: status >= 500 };
    }
    return { kind: "unknown", message: error instanceof Error ? error.message : String(error), retryable: false };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", message: "인증 실패 — ANTHROPIC_API_KEY를 확인하라.", retryable: false };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", message: error.message, retryable: true };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { kind: "invalid_request", message: error.message, retryable: false };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: "network", message: error.message, retryable: true };
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return {
      kind: status >= 500 ? "overloaded" : "unknown",
      message: `API ${status}: ${error.message}`,
      retryable: status >= 500,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "cancelled", message: "취소됨", retryable: false };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * Core의 ToolDefinition → Anthropic tool. 거의 항등 변환이다.
 * @param {readonly import("@ax-navi/core").ToolDefinition[]} defs
 */
export function toAnthropicTools(defs) {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: /** @type {any} */ (def.inputSchema),
  }));
}

/**
 * Core의 Turn[] → Anthropic messages.
 * @param {readonly Turn[]} turns
 */
export function toAnthropicMessages(turns) {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") {
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    }),
  }));
}

/** @implements {LLMSession} */
class AnthropicSession {
  /**
   * @param {InstanceType<Sdk>} client
   * @param {SessionSpec} spec
   * @param {string} id
   */
  constructor(client, spec, id) {
    this.id = id;
    this.client = client;
    this.spec = spec;
    /** @type {AbortController | null} */
    this.controller = null;
  }

  /**
   * 한 어시스턴트 턴을 스트리밍한다.
   * @param {readonly Turn[]} turns
   * @param {AbortSignal} [signal]
   * @returns {AsyncIterable<ProviderEvent>}
   */
  run(turns, signal) {
    const controller = new AbortController();
    this.controller = controller;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    /** @type {AsyncQueue<ProviderEvent>} */
    const queue = new AsyncQueue();
    queue.push({ type: "turn_start", turnId: `turn_${Date.now().toString(36)}` });

    const stream = this.client.messages.stream(
      {
        model: MODEL_BY_TIER[this.spec.tier],
        max_tokens: this.spec.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        /*
         * 시스템 프롬프트는 에이전트마다 고정이고 길다 — analyzer.md는 690줄이다.
         * 캐시 분기점을 여기 두면 같은 에이전트를 반복 호출할 때 입력 비용이 크게 준다.
         * 캐시는 접두 일치라, 변하는 값(사용자 질문)은 messages 쪽에만 둔다.
         */
        system: this.spec.cacheSystem
          ? [{ type: "text", text: this.spec.system, cache_control: { type: "ephemeral" } }]
          : this.spec.system,
        messages: /** @type {any} */ (toAnthropicMessages(turns)),
        ...(this.spec.tools.length
          ? { tools: /** @type {any} */ (toAnthropicTools(this.spec.tools)) }
          : {}),
        // 적응형 사고. 이 모델들에서 budget_tokens는 제거됐다(보내면 400).
        thinking: { type: "adaptive" },
      },
      { signal: controller.signal },
    );

    stream.on("text", (delta) => queue.push({ type: "text_delta", text: delta }));

    stream
      .finalMessage()
      .then((message) => {
        /** @type {ContentBlock[]} */
        const content = [];
        for (const block of message.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
            queue.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
          }
        }

        const usage = message.usage;
        queue.push({
          type: "usage",
          usage: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          },
        });

        // 안전 거절을 조용히 빈 응답으로 넘기지 않는다.
        if (message.stop_reason === "refusal") {
          const detail = message.stop_details ? ` (${JSON.stringify(message.stop_details)})` : "";
          queue.push({
            type: "error",
            error: { kind: "invalid_request", message: `모델이 요청을 거절했다${detail}.`, retryable: false },
          });
          queue.close();
          return;
        }

        queue.push({
          type: "turn_end",
          stopReason: /** @type {any} */ (message.stop_reason ?? "end_turn"),
          content,
        });
        queue.push({ type: "done" });
        queue.close();
      })
      .catch((error) => {
        queue.push({ type: "error", error: normalizeError(error) });
        queue.close();
      })
      .finally(() => {
        this.controller = null;
      });

    return queue;
  }

  cancel() {
    this.controller?.abort();
  }

  /** @returns {Promise<void>} */
  async close() {
    this.cancel();
  }
}

/** @implements {LLMProvider} */
export class AnthropicProvider {
  /** @param {{ apiKey?: string }} [options] */
  constructor(options = {}) {
    this.id = "anthropic";
    /** @type {ProviderCapabilities} */
    this.capabilities = {
      // 도구 실행은 Core가 한다 — 그래서 Tool Gateway가 실제 통제점으로 남는다.
      ownsAgentLoop: false,
      streaming: true,
      promptCaching: true,
      // 비용은 API가 달러로 주지 않는다. 추정치를 지어내지 않고 토큰만 보고한다.
      reportsCost: false,
      resumable: false,
      maxContextTokens: 1_000_000,
    };
    /*
     * 클라이언트는 첫 세션에서 만든다. 생성자에서 만들면 SDK 적재가 동기여야 하고,
     * 그러면 SDK 를 선택적 의존으로 둘 수 없다.
     */
    this.apiKey = options.apiKey;
    /** @type {InstanceType<Sdk> | null} */
    this.client = null;
    this.counter = 0;
  }

  /**
   * @param {SessionSpec} spec
   * @returns {Promise<LLMSession>}
   */
  async createSession(spec) {
    if (!this.client) {
      const Sdk = await loadSdk();
      // 키를 명시하지 않으면 SDK가 환경(ANTHROPIC_API_KEY 등)에서 찾는다.
      this.client = this.apiKey ? new Sdk({ apiKey: this.apiKey }) : new Sdk();
    }
    this.counter += 1;
    return new AnthropicSession(this.client, spec, `${spec.label ?? "session"}_${this.counter}`);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<LLMSession>}
   */
  async resume(sessionId) {
    // 세션 재개는 아직 구현이 없다. 있는 척하지 않는다.
    throw new Error(`이 Provider는 세션 재개를 지원하지 않는다 (${sessionId}).`);
  }

  /**
   * @param {string} _sessionId
   * @returns {Promise<void>}
   */
  async cancel(_sessionId) {
    // 취소는 세션 객체의 cancel()로 한다. Provider 수준 레지스트리는 아직 두지 않는다.
  }
}
