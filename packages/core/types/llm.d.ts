/*
 * LLM Provider 경계.
 *
 * 이 파일에는 공급자 이름도, 모델 id 문자열도 없다. Core와 Workflow가 특정 SDK 타입에
 * 결합되면 Provider 교체가 불가능해지기 때문이다(브리프 §17).
 *
 * 추상화 수준은 "에이전트"가 아니라 "메시지"다. 즉 Provider에게 맡기는 것은
 * `턴 목록 + 도구 정의를 받아 어시스턴트 턴 하나를 스트리밍하라`뿐이고,
 * **도구를 언제 실행할지·실행해도 되는지·결과가 무엇인지는 Core가 정한다.**
 * 이렇게 해야 Tool Gateway가 장식이 아니라 실제 통제점이 된다(브리프 §6).
 */

/** 모델 등급. 구체 모델 id로의 변환은 각 Provider가 한다. */
export type ModelTier = "fast" | "standard" | "deep";

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  /** Claude Code 내장 도구와 같은 이름을 쓴다(Read/Grep/Glob/Bash/Write).
   *  기존 agents/*.md 19종이 이 이름으로 쓰여 있어, 이름을 맞추면 본문 수정이 0건이 된다. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** 부수효과 여부. 읽기 전용 역할에는 true인 도구를 주지 않는다. */
  readonly mutates: boolean;
}

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly toolUseId: string; readonly content: string; readonly isError?: boolean };

export interface Turn {
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
}

export interface SessionSpec {
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  readonly tier: ModelTier;
  readonly maxOutputTokens?: number;
  /** 시스템 프롬프트 캐싱 힌트. Provider가 무시해도 된다. */
  readonly cacheSystem?: boolean;
  /** 로그·세션 기록용 라벨 (예: "feature-finder"). */
  readonly label?: string;
  /*
   * 이 실행이 서브에이전트를 띄워도 되는가.
   *
   * 오케스트레이터 스킬(harness-init 등)은 여러 전문 에이전트를 순서대로 부르는 것이
   * 절차의 본체라 이게 없으면 성립하지 않는다. 반대로 일반 작업에는 열어 줄 이유가
   * 없다 — 우리가 관측할 수 없는 실행이 생기기 때문이다. 그래서 기본은 꺼져 있다.
   *
   * ownsAgentLoop Provider만 이 요청을 실제로 들어줄 수 있다.
   */
  readonly allowDelegation?: boolean;
  /*
   * 이어갈 이전 대화의 Provider 쪽 식별자.
   *
   * ownsAgentLoop Provider는 대화를 자기가 들고 있어서 우리가 turns를 다시 보낼 수 없다.
   * 대신 이 id를 주면 그쪽이 이어 준다(실측: claude --resume 으로 앞 턴 내용이 유지됨).
   * 부수 효과로 그쪽의 컨텍스트 관리(자동 압축)도 함께 물려받는다.
   */
  readonly resumeFrom?: string;
}

export interface ProviderCapabilities {
  /** true면 Provider가 자체 에이전트 루프를 돈다(claude CLI 래핑 등).
   *  이 경우 Core의 Tool Gateway는 통제점이 아니므로 관측 전용으로 격하된다. */
  readonly ownsAgentLoop: boolean;
  readonly streaming: boolean;
  readonly promptCaching: boolean;
  readonly reportsCost: boolean;
  readonly resumable: boolean;
  readonly maxContextTokens: number;
}

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "cancelled";

export type ProviderErrorKind =
  | "auth" | "rate_limit" | "overloaded" | "context_overflow"
  | "invalid_request" | "network" | "budget" | "cancelled" | "unknown";

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** capabilities.reportsCost가 false면 undefined. 추정치를 지어내지 않는다. */
  readonly costUsd?: number;
}

/*
 * tool_result는 "실행해 달라"는 요청이 아니라 "이미 실행됐다"는 관측이다.
 * ownsAgentLoop=false인 Provider는 이 이벤트를 내보내지 않는다 — Core가 실행하고
 * 다음 Turn으로 되먹인다. ownsAgentLoop=true인 Provider만 자기가 돌린 결과를
 * 같은 기록에 실어 보내기 위해 쓴다.
 */
export type ProviderEvent =
  | { readonly type: "turn_start"; readonly turnId: string }
  /* Provider가 대화를 자기 쪽에 들고 있을 때, 다음 턴에 이어 붙일 식별자. */
  | { readonly type: "session"; readonly id: string }
  | { readonly type: "text_delta"; readonly text: string; readonly parentId?: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  /*
   * parentId — 서브에이전트 안에서 일어난 일이면 그를 띄운 Task 호출의 id.
   * 이게 없으면 서브에이전트 다섯이 동시에 돌 때 누가 무엇을 했는지 구분되지 않는다.
   */
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown; readonly parentId?: string }
  /* toolName — 짝을 지을 호출이 없는 결과에 이름을 달아 준다(예: 권한 거부). */
  | { readonly type: "tool_result"; readonly toolUseId: string; readonly content: string; readonly isError: boolean; readonly parentId?: string; readonly toolName?: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "turn_end"; readonly stopReason: StopReason; readonly content: readonly ContentBlock[] }
  | { readonly type: "error"; readonly error: ProviderError }
  | { readonly type: "done" };

export interface LLMSession {
  readonly id: string;
  run(turns: readonly Turn[], signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  cancel(): void;
  close(): Promise<void>;
}

export interface LLMProvider {
  /** "anthropic" | "claude-cli" | ... */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  createSession(spec: SessionSpec): Promise<LLMSession>;
  resume(sessionId: string): Promise<LLMSession>;
  cancel(sessionId: string): Promise<void>;

  /*
   * ownsAgentLoop=true인 Provider의 실행 경로.
   *
   * 이런 Provider(예: claude CLI 래핑)는 턴 단위로 부를 수 없다 — 프롬프트 하나를 받아
   * 자기가 루프를 돌고 도구까지 스스로 실행한다. 그래서 Core의 ToolGateway는 통제점이
   * 아니며, 역할 제약은 Provider가 자기 런타임의 수단으로 강제해야 한다.
   *
   * 이 메서드를 별도로 둔 이유는 그 사실을 타입에 드러내기 위해서다. run()으로 몰래
   * 흉내 내면 "Gateway가 막고 있다"는 착각이 남는다.
   */
  runDelegated?(spec: SessionSpec, prompt: string, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}
