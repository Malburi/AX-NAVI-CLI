/*
 * LLMProvider 구현 — OpenAI 호환 Chat Completions (`POST {base}/chat/completions`, SSE 스트리밍).
 *
 * 대상: HNIX AX 게이트웨이(/v1), 사내 로컬 모델(vLLM·Ollama 의 OpenAI 호환 엔드포인트), watsonx 등.
 * SDK 를 쓰지 않는다 — Node 18 의 fetch 만으로 된다. 폐쇄망 설치본에 의존성을 늘리지 않으려고.
 *
 * Anthropic 경로와 같이 도구는 정의만 넘기고 실행하지 않는다(ownsAgentLoop=false).
 * 실행은 Core 의 ToolGateway 가 하므로 역할 제약·승인이 그대로 통제점으로 남는다.
 * 그 대신 서브에이전트를 띄우는 오케스트레이터 스킬(harness-init 등)은 이 경로에서 돌지 않는다.
 *
 * 설정은 환경변수로만 받는다(키를 파일에 적지 않게).
 *   AXNAVI_OPENAI_BASE_URL   예: http://ax-platform:8700/v1   (필수)
 *   AXNAVI_OPENAI_API_KEY    게이트웨이 가상 키(llm 범위)        (선택 — 키 없는 로컬 서버)
 *   AXNAVI_OPENAI_MODEL      모든 등급에 같은 모델(별칭)
 *   AXNAVI_OPENAI_MODEL_FAST · _STANDARD · _DEEP   등급별 지정(위보다 우선)
 */

/** @typedef {import("@ax-navi/core").ProviderEvent} ProviderEvent */
/** @typedef {import("@ax-navi/core").ContentBlock} ContentBlock */
/** @typedef {import("@ax-navi/core").SessionSpec} SessionSpec */
/** @typedef {import("@ax-navi/core").Turn} Turn */
/** @typedef {import("@ax-navi/core").ProviderError} ProviderError */
/** @typedef {import("@ax-navi/core").ModelTier} ModelTier */
/** @typedef {import("@ax-navi/core").LLMSession} LLMSession */
/** @typedef {import("@ax-navi/core").LLMProvider} LLMProvider */

/** HNIX AX 게이트웨이의 기본 별칭. 게이트웨이 쪽에서 실제 모델·폴백·데이터 등급 강제를 정한다 */
const DEFAULT_MODEL_BY_TIER = { fast: "hnix-local", standard: "hnix-smart", deep: "hnix-smart" };
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * @typedef {{ baseUrl: string, apiKey: string | null, models: Record<ModelTier, string> }} OpenAiConfig
 */

/**
 * 환경변수에서 설정을 읽는다. 주소가 없으면 null(이 경로를 쓸 수 없음).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {OpenAiConfig | null}
 */
export function openAiConfig(env = process.env) {
  const baseUrl = env.AXNAVI_OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return null;
  const all = env.AXNAVI_OPENAI_MODEL?.trim();
  const pick = (/** @type {ModelTier} */ tier) =>
    env[`AXNAVI_OPENAI_MODEL_${tier.toUpperCase()}`]?.trim() || all || DEFAULT_MODEL_BY_TIER[tier];
  return {
    baseUrl,
    apiKey: env.AXNAVI_OPENAI_API_KEY?.trim() || null,
    models: { fast: pick("fast"), standard: pick("standard"), deep: pick("deep") },
  };
}

/**
 * Core ToolDefinition → OpenAI function tool.
 * @param {readonly import("@ax-navi/core").ToolDefinition[]} defs
 */
export function toOpenAiTools(defs) {
  return defs.map((def) => ({
    type: "function",
    function: { name: def.name, description: def.description, parameters: /** @type {any} */ (def.inputSchema) },
  }));
}

/**
 * Core Turn[] → OpenAI messages.
 * 도구 결과는 OpenAI 규칙대로 role "tool" 메시지로 바로 앞 assistant 의 tool_calls 뒤에 둔다.
 * @param {string} system
 * @param {readonly Turn[]} turns
 */
export function toOpenAiMessages(system, turns) {
  /** @type {any[]} */
  const out = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      const text = turn.content.filter((b) => b.type === "text").map((b) => /** @type {any} */ (b).text).join("");
      const calls = turn.content.filter((b) => b.type === "tool_use").map((b) => {
        const u = /** @type {{ id: string, name: string, input: unknown }} */ (/** @type {any} */ (b));
        return { id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } };
      });
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of turn.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? `[오류] ${b.content}` : b.content });
      }
    }
    const text = turn.content.filter((b) => b.type === "text").map((b) => /** @type {any} */ (b).text).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/**
 * HTTP 실패 → Core ProviderError.
 * @param {number} status
 * @param {string} message
 * @param {string | null} [retryAfter]
 * @returns {ProviderError}
 */
export function httpError(status, message, retryAfter) {
  const msg = `게이트웨이 ${status}: ${message}`.slice(0, 500);
  if (status === 401 || status === 403) return { kind: "auth", message: `${msg} — AXNAVI_OPENAI_API_KEY 와 키의 허용 별칭을 확인하라.`, retryable: false };
  if (status === 429) {
    const sec = Number(retryAfter);
    return { kind: /예산|budget/i.test(message) ? "budget" : "rate_limit", message: msg, retryable: !/예산|budget/i.test(message),
      ...(Number.isFinite(sec) && sec > 0 ? { retryAfterMs: sec * 1000 } : {}) };
  }
  if (status === 400 && /context|token|길이|maximum/i.test(message)) return { kind: "context_overflow", message: msg, retryable: false };
  if (status >= 400 && status < 500) return { kind: "invalid_request", message: msg, retryable: false };
  return { kind: "overloaded", message: msg, retryable: true };
}

/**
 * SSE 본문 → data 줄들. `data: [DONE]` 에서 끝낸다.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<string>}
 */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (body))) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }
}

const STOP = /** @type {Record<string, import("@ax-navi/core").StopReason>} */ ({
  tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", stop: "end_turn", content_filter: "refusal",
});

/** @implements {LLMSession} */
class OpenAiSession {
  /**
   * @param {OpenAiConfig} config
   * @param {SessionSpec} spec
   * @param {string} id
   * @param {typeof fetch} fetchImpl
   */
  constructor(config, spec, id, fetchImpl) {
    this.id = id;
    this.config = config;
    this.spec = spec;
    this.fetchImpl = fetchImpl;
    /** @type {AbortController | null} */
    this.controller = null;
  }

  /**
   * @param {readonly Turn[]} turns
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<ProviderEvent>}
   */
  async *run(turns, signal) {
    const controller = new AbortController();
    this.controller = controller;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    yield { type: "turn_start", turnId: `turn_${Date.now().toString(36)}` };

    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json", "x-hnix-client": "axnavi" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const body = {
      model: this.config.models[this.spec.tier],
      messages: toOpenAiMessages(this.spec.system, turns),
      ...(this.spec.tools.length ? { tools: toOpenAiTools(this.spec.tools) } : {}),
      max_tokens: this.spec.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
    };

    let text = "";
    /** @type {{ id: string, name: string, args: string }[]} */
    const calls = [];
    let finish = "stop";
    /** @type {any} */
    let usage = null;
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => "");
        let message = raw.slice(0, 300);
        try { message = JSON.parse(raw)?.error?.message ?? message; } catch { /* 본문이 JSON 이 아니면 원문 일부 */ }
        yield { type: "error", error: httpError(res.status, message || res.statusText, res.headers.get("retry-after")) };
        return;
      }
      for await (const data of sseData(res.body)) {
        /** @type {any} */
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) {
          yield { type: "error", error: { kind: "unknown", message: String(chunk.error.message ?? chunk.error), retryable: false } };
          return;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : calls.length;
          calls[i] ??= { id: "", name: "", args: "" };
          const c = /** @type {{ id: string, name: string, args: string }} */ (calls[i]);
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      const e = /** @type {any} */ (error);
      yield { type: "error", error: e?.name === "AbortError"
        ? { kind: "cancelled", message: "취소됨", retryable: false }
        : { kind: "network", message: `게이트웨이에 연결하지 못했다 — ${this.config.baseUrl} (${e?.cause?.code ?? e?.message ?? e})`, retryable: true } };
      return;
    } finally {
      this.controller = null;
    }

    /** @type {ContentBlock[]} */
    const content = [];
    if (text) content.push({ type: "text", text });
    for (const [i, c] of calls.entries()) {
      if (!c?.name) continue;
      let input;
      try {
        input = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        // 잘린 인자를 고쳐 쓰지 않는다 — 추측한 인자로 도구를 돌리는 편이 더 위험하다
        yield { type: "error", error: { kind: "invalid_request", message: `모델이 낸 도구 인자가 JSON 이 아니다(${c.name}): ${c.args.slice(0, 120)}`, retryable: true } };
        return;
      }
      const id = c.id || `call_${i}_${Date.now().toString(36)}`;
      content.push({ type: "tool_use", id, name: c.name, input });
      yield { type: "tool_use", id, name: c.name, input };
    }
    yield {
      type: "usage",
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
    const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : STOP[finish] ?? "end_turn";
    if (stopReason === "refusal") {
      yield { type: "error", error: { kind: "invalid_request", message: "게이트웨이·모델이 응답을 걸러냈다(content_filter).", retryable: false } };
      return;
    }
    yield { type: "turn_end", stopReason, content };
    yield { type: "done" };
  }

  cancel() {
    this.controller?.abort();
  }

  async close() {
    this.cancel();
  }
}

/** @implements {LLMProvider} */
export class OpenAiCompatProvider {
  /** @param {{ config?: OpenAiConfig, fetchImpl?: typeof fetch }} [options] */
  constructor(options = {}) {
    const config = options.config ?? openAiConfig();
    if (!config) throw new Error("AXNAVI_OPENAI_BASE_URL 이 없습니다 — 예: http://ax-platform:8700/v1");
    this.id = "openai";
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    /** @type {import("@ax-navi/core").ProviderCapabilities} */
    this.capabilities = {
      ownsAgentLoop: false,
      streaming: true,
      promptCaching: false,
      // 비용은 게이트웨이가 계량·집계한다. 여기서 추정치를 지어내지 않는다.
      reportsCost: false,
      resumable: false,
      maxContextTokens: 128_000,
    };
    this.counter = 0;
  }

  /**
   * @param {SessionSpec} spec
   * @returns {Promise<LLMSession>}
   */
  async createSession(spec) {
    this.counter += 1;
    return new OpenAiSession(this.config, spec, `${spec.label ?? "session"}_${this.counter}`, this.fetchImpl);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<LLMSession>}
   */
  async resume(sessionId) {
    throw new Error(`이 Provider는 세션 재개를 지원하지 않는다 (${sessionId}).`);
  }

  /** @param {string} _sessionId */
  async cancel(_sessionId) {}
}
