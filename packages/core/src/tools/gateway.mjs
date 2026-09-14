/*
 * 도구 실행의 단일 통제점.
 *
 * 오늘 이 저장소는 "어떤 에이전트가 무엇을 할 수 있는가"를 frontmatter 문자열로만 표현하고,
 * agents/lib/tests/role-contract.test.mjs가 그것을 린트로 고정하고 있다 — 13개 에이전트가
 * `tools: Read, Grep, Glob, Bash, Write`를 선언하고 Edit 계열을 뺀 것이 그 예다.
 * 그러나 린트는 선언을 검사할 뿐 실행을 막지 못한다. Gateway는 그 계약을 런타임 통제로 바꾼다.
 *
 * 검사 순서는 고정이다. 순서를 바꾸면 통제가 새므로 주석으로 못 박는다.
 *   1) 등록된 도구인가
 *   2) 이 역할에 허용된 도구인가        ← frontmatter `tools:`
 *   3) 부수효과 도구를 읽기 전용 역할이 부르는가
 *   4) 입력이 스키마에 맞는가
 *   5) 취소 신호
 *   6) 실행 (경로·예산 검사는 각 도구가 ctx.allowedRoots로 수행)
 *   7) 감사 기록
 *
 * 실패를 예외로 던지지 않고 isError 결과로 돌려주는 이유는, 모델이 그 사유를 읽고
 * 스스로 고칠 수 있어야 하기 때문이다. 조용히 넘어가는 경로는 만들지 않는다.
 */

/** @typedef {import("../../types/tools.js").ToolHandler} ToolHandler */
/** @typedef {import("../../types/tools.js").ToolContext} ToolContext */
/** @typedef {import("../../types/tools.js").ToolResult} ToolResult */
/** @typedef {import("../../types/llm.js").ToolDefinition} ToolDefinition */
/** @typedef {{ allowedTools: readonly string[] | null, allowMutations: boolean }} RoleShape */
/** @typedef {ToolResult & { denied?: boolean }} GatewayOutcome */

export class ToolRegistry {
  /** @type {Map<string, ToolHandler>} */
  #handlers = new Map();

  /**
   * @param {ToolHandler} handler
   * @returns {this}
   */
  register(handler) {
    if (this.#handlers.has(handler.definition.name)) {
      throw new Error(`도구 이름이 중복됐다: ${handler.definition.name}`);
    }
    this.#handlers.set(handler.definition.name, handler);
    return this;
  }

  /**
   * @param {string} name
   * @returns {ToolHandler | undefined}
   */
  get(name) {
    return this.#handlers.get(name);
  }

  /**
   * 역할이 실제로 쓸 수 있는 도구 정의만 추린다 — 모델에게 보여줄 목록이기도 하다.
   * @param {RoleShape} role
   * @returns {ToolDefinition[]}
   */
  definitionsFor(role) {
    /** @type {ToolDefinition[]} */
    const out = [];
    for (const handler of this.#handlers.values()) {
      const def = handler.definition;
      if (role.allowedTools && !role.allowedTools.includes(def.name)) continue;
      if (def.mutates && !role.allowMutations) continue;
      out.push(def);
    }
    return out;
  }

  /** @returns {string[]} */
  names() {
    return [...this.#handlers.keys()];
  }
}

/**
 * 최소 스키마 검증. 전체 JSON Schema를 구현하지 않는 이유는 의존성을 늘리지 않기 위해서다.
 * 여기서 잡는 것은 "모델이 필수 필드를 빠뜨렸다" 수준이고, 나머지는 각 도구가 검사한다.
 * @param {unknown} input
 * @param {Record<string, unknown>} schema
 * @returns {string | null}
 */
function validateAgainstSchema(input, schema) {
  if (schema["type"] === "object") {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return "객체가 아니다";
    const required = /** @type {string[] | undefined} */ (schema["required"]) ?? [];
    const missing = required.filter((key) => !(key in /** @type {Record<string, unknown>} */ (input)));
    if (missing.length) return `필수 필드 누락: ${missing.join(", ")}`;
  }
  return null;
}

export class ToolGateway {
  /** @param {ToolRegistry} registry */
  constructor(registry) {
    /** @type {ToolRegistry} */
    this.registry = registry;
  }

  /**
   * @param {{ id: string, name: string, input: unknown }} call
   * @param {ToolContext} ctx
   * @returns {Promise<GatewayOutcome>}
   */
  async execute(call, ctx) {
    const started = Date.now();
    /** @param {string} reason @returns {GatewayOutcome} */
    const deny = (reason) => {
      ctx.audit.record({
        at: new Date().toISOString(), role: ctx.role.name, tool: call.name,
        input: call.input, outcome: "denied", reason, durationMs: Date.now() - started,
      });
      return { content: `도구 거부됨 (${call.name}): ${reason}`, isError: true, denied: true };
    };

    // 1) 등록 여부
    const handler = this.registry.get(call.name);
    if (!handler) return deny(`등록되지 않은 도구다. 사용 가능: ${this.registry.names().join(", ")}`);

    // 2) 역할 허용 목록 — frontmatter `tools:`가 곧 이 검사다
    if (ctx.role.allowedTools && !ctx.role.allowedTools.includes(call.name)) {
      return deny(`역할 '${ctx.role.name}'에 허용되지 않은 도구다.`);
    }

    // 3) 읽기 전용 역할의 부수효과 차단
    if (handler.definition.mutates && !ctx.role.allowMutations) {
      return deny(`역할 '${ctx.role.name}'은 읽기 전용이라 부수효과 도구를 쓸 수 없다.`);
    }

    // 4) 입력 스키마
    const schemaError = validateAgainstSchema(call.input, handler.definition.inputSchema);
    if (schemaError) return deny(`입력이 스키마에 맞지 않는다 — ${schemaError}`);

    // 5) 취소
    if (ctx.signal.aborted) return deny("취소됨");

    // 6) 실행
    try {
      const result = await handler.run(call.input, ctx);
      ctx.audit.record({
        at: new Date().toISOString(), role: ctx.role.name, tool: call.name, input: call.input,
        outcome: result.isError ? "error" : "ok", durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.audit.record({
        at: new Date().toISOString(), role: ctx.role.name, tool: call.name, input: call.input,
        outcome: "error", reason: message, durationMs: Date.now() - started,
      });
      // 실패를 성공으로 보고하지 않는다.
      return { content: `도구 실행 실패 (${call.name}): ${message}`, isError: true };
    }
  }
}
