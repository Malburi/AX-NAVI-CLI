/*
 * QueryIndex — 결정론적 인덱스 질의.
 *
 * 이 도구가 있는 이유는 토큰이다. 실측 대형 레거시 인덱스는 sql_usage.json 143MB,
 * call_graph.json 36MB다. "호출자 5개만 알고 싶다"에 143MB를 여는 것은 성립하지 않는다.
 * COMMANDS는 상한이 걸린 순수 함수 테이블이라 그대로 in-process로 부른다.
 */
import { COMMANDS } from "@ax-navi/indexer";

/** @typedef {import("../../../types/tools.js").ToolHandler} ToolHandler */

const COMMAND_NAMES = /** @type {const} */ ([
  "summary", "symbol", "callers", "callees", "trace", "sql",
  "table", "endpoint", "transaction", "schema", "dead",
]);

/** @type {ToolHandler} */
export const queryIndexTool = {
  definition: {
    name: "QueryIndex",
    description:
      "결정론적 인덱스에 질의한다. 원본 JSON을 직접 열지 말고 항상 이 도구를 쓴다. " +
      `명령: ${COMMAND_NAMES.join(", ")}. 응답에 total·truncated가 함께 온다.`,
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", enum: [...COMMAND_NAMES] },
        id: { type: "string", description: "심볼 id (callers/callees/trace/transaction)" },
        name: { type: "string", description: "심볼 이름 (symbol)" },
        file: { type: "string" },
        table: { type: "string", description: "테이블명 (table/schema)" },
        path: { type: "string", description: "엔드포인트 경로 (endpoint)" },
        depth: { type: "integer", description: "추적 깊이 (trace, 기본 3)" },
        limit: { type: "integer", description: "결과 상한 (기본 50, 최대 500)" },
      },
    },
  },
  async run(input, ctx) {
    const handler = /** @type {Record<string, (a: any) => unknown>} */ (COMMANDS)[input.command];
    if (!handler) {
      return { content: `지원하지 않는 명령: ${input.command}. 사용 가능: ${COMMAND_NAMES.join(", ")}`, isError: true };
    }
    /** @type {Record<string, unknown>} */
    const args = { root: ctx.paths.root, indexDir: ctx.paths.indexDir };
    for (const key of ["id", "name", "file", "table", "path", "depth", "limit"]) {
      if (input[key] !== undefined) args[key] = input[key];
    }
    try {
      return { content: JSON.stringify(handler(args), null, 2) };
    } catch (error) {
      const missing = /** @type {{ missingIndex?: string }} */ (error).missingIndex;
      // "결과 0건"과 "인덱스 없음"은 다르다 — 구분해서 알린다.
      if (missing) {
        return { content: `인덱스가 없다 (${missing}). \`axnavi index build\`를 먼저 실행하라.`, isError: true };
      }
      throw error;
    }
  },
};
