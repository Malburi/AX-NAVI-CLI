/*
 * 에이전트 루프.
 *
 * 브리프 §17이 금지한 두 가지를 동시에 피하는 지점이다.
 * - thin wrapper가 아니다: 루프를 Provider에게 맡기지 않고 여기서 돈다.
 * - 모델 종속 Core가 아니다: 이 파일은 LLMProvider 인터페이스만 알고 Claude를 모른다.
 *
 * 도구를 "언제 실행할지·실행해도 되는지"를 여기가 정하기 때문에 Tool Gateway가
 * 장식이 아니라 실제 통제점이 된다. Provider가 자기 루프를 도는 경우
 * (capabilities.ownsAgentLoop === true)에는 그 통제가 성립하지 않으므로 거부한다.
 */

/** @typedef {import("../types/llm.js").LLMProvider} LLMProvider */
/** @typedef {import("../types/llm.js").Turn} Turn */
/** @typedef {import("../types/llm.js").ContentBlock} ContentBlock */
/** @typedef {import("../types/tools.js").ToolContext} ToolContext */
/** @typedef {import("./agents/loader.mjs").AgentDefinition} AgentDefinition */

/**
 * @typedef {object} LoopEvent
 * @property {"text" | "tool_call" | "tool_result" | "usage" | "turn" | "done" | "error"} type
 * @property {string} [text]
 * @property {string} [tool]
 * @property {unknown} [input]
 * @property {string} [result]
 * @property {boolean} [isError]
 * @property {number} [turn]
 * @property {import("../types/llm.js").Usage} [usage]
 * @property {string} [reason]
 */

const DEFAULT_MAX_TURNS = 12;

/**
 * 에이전트를 한 번 실행하고 진행 상황을 스트리밍한다.
 *
 * @param {object} args
 * @param {LLMProvider} args.provider
 * @param {AgentDefinition} args.agent
 * @param {import("./tools/gateway.mjs").ToolRegistry} args.registry
 * @param {import("./tools/gateway.mjs").ToolGateway} args.gateway
 * @param {ToolContext} args.ctx
 * @param {string} args.userPrompt
 * @param {number} [args.maxTurns]
 * @returns {AsyncGenerator<LoopEvent, { turns: Turn[], stopReason: string }>}
 */
export async function* runAgent({ provider, agent, registry, gateway, ctx, userPrompt, maxTurns = DEFAULT_MAX_TURNS }) {
  if (provider.capabilities.ownsAgentLoop) {
    // 이 Provider는 자기가 도구를 실행하므로 Gateway의 허용목록·경로 검사가 통하지 않는다.
    // 조용히 열어 주는 대신 사유를 밝히고 멈춘다.
    yield {
      type: "error",
      reason:
        `Provider '${provider.id}'는 자체 에이전트 루프를 돈다(ownsAgentLoop). ` +
        `그 경우 Tool Gateway가 통제점이 아니므로 역할 '${agent.name}'의 도구 제약을 보장할 수 없다.`,
    };
    return { turns: [], stopReason: "refusal" };
  }

  const tools = registry.definitionsFor(agent.role);
  const session = await provider.createSession({
    system: agent.systemPrompt,
    tools,
    tier: agent.tier,
    label: agent.name,
    cacheSystem: true,
  });

  /** @type {Turn[]} */
  const turns = [{ role: "user", content: [{ type: "text", text: userPrompt }] }];

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      yield { type: "turn", turn };

      /** @type {ContentBlock[]} */
      let assistantContent = [];
      /** @type {Array<{ id: string, name: string, input: unknown }>} */
      const pendingCalls = [];
      let stopReason = "end_turn";
      let failed = false;

      for await (const event of session.run(turns, ctx.signal)) {
        if (event.type === "text_delta") yield { type: "text", text: event.text };
        else if (event.type === "tool_use") pendingCalls.push({ id: event.id, name: event.name, input: event.input });
        else if (event.type === "usage") yield { type: "usage", usage: event.usage };
        else if (event.type === "turn_end") {
          assistantContent = [...event.content];
          stopReason = event.stopReason;
        } else if (event.type === "error") {
          yield { type: "error", reason: `${event.error.kind}: ${event.error.message}` };
          failed = true;
          break;
        }
      }
      if (failed) return { turns, stopReason: "error" };

      if (assistantContent.length) turns.push({ role: "assistant", content: assistantContent });

      if (!pendingCalls.length) {
        yield { type: "done", reason: stopReason };
        return { turns, stopReason };
      }

      /*
       * 도구 실행. 병렬로 돌리지 않는 이유는 승인·감사 순서가 결과에 영향을 주기 때문이다
       * (예: 같은 파일을 읽고 쓰는 두 호출). 필요해지면 mutates=false인 것만 묶으면 된다.
       */
      /** @type {ContentBlock[]} */
      const results = [];
      for (const call of pendingCalls) {
        yield { type: "tool_call", tool: call.name, input: call.input };
        const outcome = await gateway.execute(call, ctx);
        yield { type: "tool_result", tool: call.name, result: outcome.content, isError: outcome.isError === true };
        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: outcome.content,
          ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        });
      }
      turns.push({ role: "user", content: results });
    }

    // 상한에 걸린 것을 완료로 보고하지 않는다.
    yield { type: "error", reason: `최대 턴(${maxTurns})에 도달했다. 작업이 끝나지 않았다.` };
    return { turns, stopReason: "max_turns" };
  } finally {
    await session.close();
  }
}
