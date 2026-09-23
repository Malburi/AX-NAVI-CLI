/*
 * Tool Gateway 타입.
 *
 * 오늘 이 저장소는 "어떤 에이전트가 무엇을 할 수 있는가"를 frontmatter 문자열로만 표현하고,
 * agents/lib/tests/role-contract.test.mjs가 그것을 린트로 고정하고 있다 — 13개 에이전트가
 * `tools: Read, Grep, Glob, Bash, Write`를 선언하고 Edit 계열을 의도적으로 뺀 것이 그 예다.
 * 그러나 린트는 선언을 검사할 뿐 실행을 막지 못한다.
 *
 * Gateway는 그 계약을 런타임 통제로 바꾼다. 도구 실행 경로는 여기 하나뿐이다.
 */
import type { JsonSchema, ToolDefinition } from "./llm.js";
import type { ProjectPaths } from "./paths.js";

export interface RolePolicy {
  /** 에이전트 이름 (frontmatter의 name). */
  readonly name: string;
  /** frontmatter `tools:`에서 온 허용 목록. 비어 있으면 전체 허용을 뜻한다(기존 규약). */
  readonly allowedTools: readonly string[] | null;
  /** 파일·셸 등 부수효과 허용 여부. 읽기 전용 에이전트는 false. */
  readonly allowMutations: boolean;
}

export interface AuditRecord {
  readonly at: string;
  readonly role: string;
  readonly tool: string;
  readonly input: unknown;
  readonly outcome: "ok" | "denied" | "error";
  readonly reason?: string;
  readonly durationMs: number;
}

export interface AuditSink {
  record(entry: AuditRecord): void;
}

/** 사용자에게 묻는 경로. CLI는 터미널 프롬프트로, 비대화형은 기본값/실패로 구현한다. */
export interface Elicitor {
  /**
   * Claude Code의 AskUserQuestion을 대체한다.
   * 그쪽은 한 질문에 옵션 4개라는 상한이 있었고, 그 상한 때문에 5번째 선택지가
   * 조용히 잘려나간 사고가 실제로 있었다(skills/harness-init/SKILL.md:38, 2026-07-30).
   * CLI에는 그 제약이 없으므로 옵션 수를 제한하지 않는다.
   */
  ask(
    question: string,
    options: readonly string[],
    opts?: { multiSelect?: boolean; header?: string; preview?: readonly PreviewLine[] },
  ): Promise<string[]>;
}

/**
 * 질문 위에 보여 줄 미리보기 한 줄 — 승인 창의 diff.
 * 대화형 터미널만 그린다. 줄 입력 경로는 무시한다.
 */
export interface PreviewLine {
  /** add 넣은 줄 · del 지운 줄 · ctx 문맥 · gap 생략 표시 · note 설명 */
  readonly kind: "add" | "del" | "ctx" | "gap" | "note";
  readonly text: string;
  /** 그 줄의 번호. del 은 원래 파일 기준, 나머지는 바뀐 파일 기준 */
  readonly no?: number;
}

/** 진행 상태 보고. Claude Code의 TaskCreate/TaskUpdate 자리를 대신한다. */
export interface ProgressSink {
  update(taskId: string, status: "pending" | "in_progress" | "completed" | "failed", title?: string): void;
}

export interface ToolContext {
  readonly paths: ProjectPaths;
  /** 접근이 허용된 루트들. 프로젝트 루트 + (있다면) 파트너 저장소 루트. */
  readonly allowedRoots: readonly string[];
  readonly role: RolePolicy;
  readonly audit: AuditSink;
  readonly elicitor: Elicitor;
  readonly progress: ProgressSink;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolHandler<I = any> {
  readonly definition: ToolDefinition;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export type { JsonSchema, ToolDefinition };
