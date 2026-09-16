/*
 * 손으로 쓴 타입 선언.
 *
 * 확장자가 .d.mts 인 이유 — 이웃 index.mjs 를 **상대경로로** 불러도 tsc 가 이 선언을
 * 집게 하기 위해서다. .d.ts 였을 때는 패키지 이름(@ax-navi/indexer)으로 불러야만 잡혔고,
 * 그러지 않으면 194KB 짜리 agents/lib 원본을 그대로 타입 검사해 에러가 쌏아졌다. 원본 `agents/lib/*.mjs`는 순수 JS이고 무수정으로 둔다.
 * 여기 적힌 형태는 build-index.mjs / query-index.mjs의 실제 반환값에서 확인한 것이다.
 */

export declare const INDEXER_VERSION: string;

export type Tier = "Auto" | "Standard" | "Full";
export type IndexMode = "init" | "incremental" | "feature-scoped";

/** 인덱스 파일 이름. docs/index-schema/*.schema.json과 1:1 대응한다. */
export type IndexName =
  | "symbols" | "call_graph" | "sql_usage" | "transactions" | "external_io"
  | "env_branches" | "schema" | "api_contract" | "dead_code" | "ui_flow"
  | "client_index" | "data_flow" | "_meta";

export interface BuildIndexOptions {
  root: string;
  mode?: IndexMode;
  tier?: Tier;
  config?: string | null;
  /** 인덱스 출력 위치. 생략하면 `<root>/_workspace/index`. */
  indexDir?: string;
}

export interface AdapterCoverage {
  [ext: string]: unknown;
}

export interface BuildIndexResult {
  root: string;
  files: number;
  analyzed: number;
  reused: number;
  tier: Exclude<Tier, "Auto">;
  complexity: { recommended_tier: Exclude<Tier, "Auto">; [k: string]: unknown };
  adapter_coverage: AdapterCoverage;
  indexes: string[];
  unresolved: number;
}

/** 전수 인덱싱. LLM을 쓰지 않는다. */
export declare function buildIndex(options: BuildIndexOptions): BuildIndexResult;

export interface StalenessResult {
  stale: boolean;
  /** 사람이 읽는 판정 사유. exit code로 뭉개지 않는 것이 이 함수의 존재 이유다. */
  reason: string;
  fingerprint?: string;
  indexed_fingerprint?: string;
}

/** 재인덱싱 필요 여부를 LLM 없이 판정한다. */
export declare function indexStaleness(root: string, indexDir?: string): StalenessResult;

export interface ApplyAiPatchResult {
  applied: number;
  rejected: number;
  rejected_reasons: unknown;
  [k: string]: unknown;
}

/** AI 보강 패치를 허용된 op만 골라 병합한다. */
export declare function applyAiPatch(root: string, patchPath: string, indexDir?: string): ApplyAiPatchResult;

export declare function mergeAiPatchEdges(graph: unknown, patch: unknown): unknown;

/** 인덱스 디렉터리 경로 결정. indexDir 생략 시 `<root>/_workspace/index`. */
export declare function resolveIndexDir(root: string, indexDir?: string): string;

/* ---------- query-index ---------- */

export interface QueryArgs {
  root: string;
  indexDir?: string;
  id?: string;
  name?: string;
  file?: string;
  table?: string;
  path?: string;
  depth?: number;
  limit?: number;
}

/** 상한이 걸린 응답. 잘렸으면 truncated로 밝힌다 — 조용히 자르지 않는다. */
export interface CappedResult<T = unknown> {
  items: T[];
  returned: number;
  total: number;
  truncated: number;
  query?: Record<string, unknown>;
}

export type QueryCommand =
  | "symbol" | "callers" | "callees" | "trace" | "sql" | "table"
  | "endpoint" | "transaction" | "schema" | "dead" | "summary";

export declare const COMMANDS: Record<QueryCommand, (args: QueryArgs) => unknown>;

/** 인덱스가 없으면 빈 결과가 아니라 `missingIndex`를 실은 오류를 던진다. */
export declare function loadIndex(root: string, name: IndexName, indexDir?: string): unknown;
