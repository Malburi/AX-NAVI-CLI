/*
 * 테스트용 Provider.
 *
 * 이게 성립한다는 사실 자체가 계약을 증명한다 — Core가 Anthropic SDK를 전혀 모르기 때문에
 * 스크립트 몇 줄로 대체할 수 있고, 그래서 API 키 없이 루프·Gateway·로더를 전부 검증할 수 있다.
 * 브리프 §9의 "Core와 Workflow가 Claude SDK 타입에 결합되지 않게 한다"를 실행으로 확인하는 지점이다.
 */

/** @typedef {import("../types/llm.js").ProviderEvent} ProviderEvent */
/** @typedef {import("../types/llm.js").Turn} Turn */

/**
 * @typedef {object} ScriptedTurn
 * @property {string} [text]                                   내보낼 텍스트
 * @property {Array<{ id: string, name: string, input: unknown }>} [toolCalls]  요청할 도구 호출
 * @property {import("../types/llm.js").ProviderError} [error]  대신 낼 오류
 */

export class FakeProvider {
  /**
   * @param {ScriptedTurn[]} script  턴마다 무엇을 낼지 미리 적어 둔다
   * @param {{ ownsAgentLoop?: boolean }} [opts]
   */
  constructor(script, opts = {}) {
    this.id = "fake";
    this.script = script;
    /** @type {Turn[][]} 각 턴에서 Core가 보낸 대화 — 어서션용으로 남긴다 */
    this.received = [];
    /** @type {import("../types/llm.js").SessionSpec | null} */
    this.lastSpec = null;
    this.turnIndex = 0;
    /** @type {import("../types/llm.js").ProviderCapabilities} */
    this.capabilities = {
      ownsAgentLoop: opts.ownsAgentLoop ?? false,
      streaming: true,
      promptCaching: false,
      reportsCost: false,
      resumable: false,
      maxContextTokens: 200_000,
    };
  }

  /** @param {import("../types/llm.js").SessionSpec} spec */
  async createSession(spec) {
    this.lastSpec = spec;
    const provider = this;
    return {
      id: "fake-session",
      /**
       * @param {readonly Turn[]} turns
       * @returns {AsyncIterable<ProviderEvent>}
       */
      run(turns) {
        provider.received.push([...turns]);
        const step = provider.script[provider.turnIndex];
        provider.turnIndex += 1;
        return (async function* () {
          yield { type: "turn_start", turnId: `t${provider.turnIndex}` };
          if (!step) {
            yield { type: "turn_end", stopReason: "end_turn", content: [] };
            yield { type: "done" };
            return;
          }
          if (step.error) {
            yield { type: "error", error: step.error };
            return;
          }
          /** @type {import("../types/llm.js").ContentBlock[]} */
          const content = [];
          if (step.text) {
            yield { type: "text_delta", text: step.text };
            content.push({ type: "text", text: step.text });
          }
          for (const call of step.toolCalls ?? []) {
            content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
            yield { type: "tool_use", id: call.id, name: call.name, input: call.input };
          }
          yield {
            type: "usage",
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
          yield {
            type: "turn_end",
            stopReason: step.toolCalls?.length ? "tool_use" : "end_turn",
            content,
          };
          yield { type: "done" };
        })();
      },
      cancel() {},
      async close() {},
    };
  }

  /**
   * ownsAgentLoop인 Provider 자리. 기본은 미구현이고 테스트에서 필요할 때만 채운다 —
   * 비워 둔 상태가 곧 "루프를 위임할 수도, Gateway로 통제할 수도 없는" 경우의 검증이다.
   * @type {((spec: import("../types/llm.js").SessionSpec, prompt: string, signal?: AbortSignal) => AsyncIterable<ProviderEvent>) | undefined}
   */
  runDelegated = undefined;

  /**
   * @param {string} id
   * @returns {Promise<import("../types/llm.js").LLMSession>}
   */
  async resume(id) {
    throw new Error(`재개 미지원 (${id})`);
  }

  async cancel() {}
}

/**
 * 테스트용 ToolContext. 실제 파일시스템 루트를 받아 경로 검사를 진짜로 돌린다.
 * @param {string} root
 * @param {import("../types/tools.js").RolePolicy} role
 * @param {{ answers?: string[] }} [opts]
 */
export function makeContext(root, role, opts = {}) {
  /** @type {import("../types/tools.js").AuditRecord[]} */
  const records = [];
  /** @type {Array<[string, string]>} */
  const progress = [];
  return {
    ctx: /** @type {import("../types/tools.js").ToolContext} */ ({
      paths: {
        root,
        workspaceDir: `${root}/_workspace`,
        indexDir: `${root}/_workspace/index`,
        reportsDir: `${root}/_workspace/reports`,
        pairConfigPath: `${root}/_workspace/pair_config.md`,
        axnaviDir: `${root}/.axnavi`,
        configPath: `${root}/.axnavi/axnavi.yaml`,
        sessionsDir: `${root}/.axnavi/sessions`,
        logsDir: `${root}/.axnavi/logs`,
      },
      allowedRoots: [root],
      role,
      audit: { record: (entry) => records.push(entry) },
      elicitor: { ask: async () => opts.answers ?? [] },
      progress: { update: (id, status) => progress.push([id, status]) },
      signal: new AbortController().signal,
    }),
    records,
    progress,
  };
}
