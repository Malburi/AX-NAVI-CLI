/*
 * 에이전트 루프.
 *
 * 브리프 §17이 금지한 두 가지를 동시에 피하는 지점이다.
 * - thin wrapper가 아니다: 루프를 Provider에게 맡기지 않고 여기서 돈다.
 * - 모델 종속 Core가 아니다: 이 파일은 LLMProvider 인터페이스만 알고 Claude를 모른다.
 *
 * 도구를 "언제 실행할지·실행해도 되는지"를 여기가 정하기 때문에 Tool Gateway가
 * 장식이 아니라 실제 통제점이 된다.
 *
 * 예외가 하나 있다. capabilities.ownsAgentLoop === true인 Provider(설치된 claude CLI를
 * 위임 실행하는 경우 등)는 프롬프트 하나를 받아 자기가 루프를 돌고 도구까지 스스로
 * 실행하므로 Gateway가 끼어들 자리가 없다. 그 경로는 runDelegated로 분리해 두었다 —
 * 제약이 사라지는 게 아니라 강제하는 주체가 옮겨간다는 사실을 타입과 이벤트로 드러낸다.
 */

/** @typedef {import("../types/llm.js").LLMProvider} LLMProvider */
/** @typedef {import("../types/llm.js").Turn} Turn */
/** @typedef {import("../types/llm.js").ContentBlock} ContentBlock */
/** @typedef {import("../types/tools.js").ToolContext} ToolContext */
/** @typedef {import("./agents/loader.mjs").AgentDefinition} AgentDefinition */

/**
 * 대화 상태.
 *
 * REPL이 턴마다 새 대화를 만들면 "그거 수정하면 어디 영향가?" 에서 "그거"를 잃는다.
 * 그래서 호출부가 이 객체를 들고 다니며 같은 것을 계속 넘긴다.
 *
 * 두 경로가 대화를 다르게 보관한다.
 *   anthropic   우리가 turns를 들고 매번 전부 다시 보낸다
 *   claude-cli  그쪽이 대화를 들고 있고 우리는 providerSessionId만 기억한다
 *
 * @typedef {object} Conversation
 * @property {Turn[]} turns
 * @property {string} [providerSessionId]
 */

/**
 * @typedef {object} LoopEvent
 * @property {"text" | "tool_call" | "tool_result" | "usage" | "turn" | "done" | "error" | "delegated" | "compacted"} type
 * @property {string} [text]
 * @property {string} [tool]
 * @property {string} [id]        호출과 결과를 짝짓는다. 병렬로 돌면 순서가 섞여 이게 없으면 못 맞춘다.
 * @property {string} [parentId]  서브에이전트 안에서 난 일이면 그를 띄운 Task 호출의 id
 * @property {unknown} [input]
 * @property {string} [result]
 * @property {boolean} [isError]
 * @property {number} [turn]
 * @property {import("../types/llm.js").Usage} [usage]
 * @property {string} [reason]
 */

import { compactTurns } from "./context/compaction.mjs";

const DEFAULT_MAX_TURNS = 12;

/* 이 값을 넘으면 오래된 도구 결과부터 들어낸다. 1M 컨텍스트라도 비용이 선형으로 늘어난다. */
const COMPACT_AT_TOKENS = 120_000;

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
 * @param {Conversation} [args.conversation]  주면 이어간다. 없으면 새 대화.
 * @param {number} [args.maxTurns]
 * @returns {AsyncGenerator<LoopEvent, { turns: Turn[], stopReason: string }>}
 */
export async function* runAgent({ provider, agent, registry, gateway, ctx, userPrompt, conversation, maxTurns = DEFAULT_MAX_TURNS }) {
  const tools = registry.definitionsFor(agent.role);

  if (provider.capabilities.ownsAgentLoop) {
    /*
     * 자체 루프를 도는 Provider(claude CLI 래핑 등)로 위임한다.
     *
     * 이 경로에서는 ToolGateway가 통제점이 아니다. 역할 제약이 사라지는 것은 아니고
     * 강제하는 주체가 옮겨간다 — Provider가 자기 런타임의 수단으로(예: --disallowedTools)
     * 같은 불변식을 걸어야 한다. 사용자가 이 사실을 모르고 지나가지 않도록 이벤트로 알린다.
     */
    if (!provider.runDelegated) {
      yield {
        type: "error",
        reason:
          `Provider '${provider.id}'는 ownsAgentLoop인데 runDelegated를 구현하지 않았다. ` +
          `이 상태로는 역할 '${agent.name}'의 도구 제약을 누구도 강제하지 않는다.`,
      };
      return { turns: [], stopReason: "refusal" };
    }

    yield {
      type: "delegated",
      reason:
        `Provider '${provider.id}'가 루프를 직접 돈다 — 도구 제약은 Gateway가 아니라 ` +
        `그쪽 런타임이 강제한다.`,
    };

    let stopReason = "end_turn";
    for await (const event of provider.runDelegated(
      {
        system: agent.systemPrompt,
        tools,
        tier: agent.tier,
        label: agent.name,
        ...(agent.allowDelegation ? { allowDelegation: true } : {}),
        ...(conversation?.providerSessionId ? { resumeFrom: conversation.providerSessionId } : {}),
      },
      userPrompt,
      ctx.signal,
    )) {
      if (event.type === "text_delta") {
        yield { type: "text", text: event.text, ...(event.parentId ? { parentId: event.parentId } : {}) };
      }
      else if (event.type === "session") {
        // 다음 턴이 이어 붙일 수 있게 기억한다.
        if (conversation) conversation.providerSessionId = event.id;
      } else if (event.type === "tool_use") {
        yield { type: "tool_call", id: event.id, tool: event.name, input: event.input, ...(event.parentId ? { parentId: event.parentId } : {}) };
      }
      else if (event.type === "tool_result") {
        yield { type: "tool_result", id: event.toolUseId, tool: event.toolName ?? "(위임)", result: event.content, isError: event.isError, ...(event.parentId ? { parentId: event.parentId } : {}) };
      } else if (event.type === "usage") yield { type: "usage", usage: event.usage };
      else if (event.type === "error") {
        yield { type: "error", reason: `${event.error.kind}: ${event.error.message}` };
        return { turns: [], stopReason: "error" };
      } else if (event.type === "turn_end") stopReason = event.stopReason;
    }
    yield { type: "done", reason: stopReason };
    return { turns: [], stopReason };
  }
  const session = await provider.createSession({
    system: agent.systemPrompt,
    tools,
    tier: agent.tier,
    label: agent.name,
    cacheSystem: true,
  });

  /*
   * 이어가는 대화면 기존 turns 뒤에 붙인다. 없으면 새로 시작한다.
   * conversation 객체를 그대로 쓰므로 호출부가 결과를 따로 받아 저장할 필요가 없다.
   */
  /** @type {Turn[]} */
  let turns = conversation?.turns ?? [];
  turns.push({ role: "user", content: [{ type: "text", text: userPrompt }] });

  /*
   * 압축은 새 요청을 붙인 뒤에 한다 — 지금 막 들어온 요청까지 포함한 크기로 판단해야
   * 이번 턴에 실제로 보낼 양을 맞출 수 있다.
   */
  const compacted = compactTurns(turns, { maxTokens: COMPACT_AT_TOKENS });
  if (compacted.changed) {
    turns = compacted.turns;
    if (conversation) conversation.turns = turns;
    yield {
      type: "compacted",
      reason: `컨텍스트 압축 — ${compacted.note} (약 ${compacted.before} → ${compacted.after} 토큰)`,
    };
  }

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
        yield { type: "tool_call", id: call.id, tool: call.name, input: call.input };
        const outcome = await gateway.execute(call, ctx);
        yield { type: "tool_result", id: call.id, tool: call.name, result: outcome.content, isError: outcome.isError === true };
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
