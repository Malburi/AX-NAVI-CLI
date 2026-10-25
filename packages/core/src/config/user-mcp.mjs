/*
 * 사용자 MCP 서버 — `.axnavi/mcp.json`.
 *
 * 형식은 Claude Code 의 `.mcp.json` 과 같다. 그래야 팀이 이미 쓰는 설정을 그대로 옮길 수 있다.
 *   { "mcpServers": { "hnix": { "type": "http", "url": "http://ax:8700/mcp",
 *                               "headers": { "Authorization": "Bearer ${HNIX_AX_KEY}" } } } }
 *
 * YAML(axnavi.yaml)이 아니라 JSON 인 이유: 폐쇄망 배포본에 파서 의존성을 늘리지 않으려고.
 * 키는 파일에 적지 않고 `${환경변수}` 로 받는다 — .axnavi/ 가 저장소에 커밋되는 일이 흔하다.
 * 환경변수가 없으면 그 서버만 빼고 이유를 알린다(실행 전체를 막지 않는다).
 *
 * 이 서버들의 도구는 AX-NAVI 기본 도구가 아니라서 실행 때마다 승인 창을 거친다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 우리 브리지가 쓰는 이름 — 사용자 서버가 가로채면 질문·인덱스 도구가 사라진다 */
const RESERVED = new Set(["axnavi"]);
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * @typedef {{ type?: "stdio" | "http" | "sse", command?: string, args?: string[], env?: Record<string, string>, url?: string, headers?: Record<string, string> }} McpServerSpec
 * @typedef {{ servers: Record<string, McpServerSpec>, warnings: string[], file: string, exists: boolean }} UserMcp
 */

/**
 * `${NAME}` · `${NAME:-기본값}` 치환. 값이 없으면 null(그 서버를 뺀다).
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} env
 * @param {Set<string>} missing
 * @returns {unknown}
 */
function expand(value, env, missing) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, env, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env, missing)]));
  }
  return value;
}

/**
 * @param {{ axnaviDir: string }} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UserMcp}
 */
export function loadUserMcpServers(paths, env = process.env) {
  // .axnavi 위치를 모르는 호출(일부 시험·임시 경로)은 사용자 서버 없이 돈다
  if (!paths?.axnaviDir) return { servers: {}, warnings: [], file: "", exists: false };
  const file = join(paths.axnaviDir, "mcp.json");
  /** @type {UserMcp} */
  const out = { servers: {}, warnings: [], file, exists: existsSync(file) };
  if (!out.exists) return out;
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    out.warnings.push(`${file} 를 읽지 못했습니다(JSON 형식 오류): ${/** @type {Error} */ (error).message}`);
    return out;
  }
  for (const [name, spec] of Object.entries(raw?.mcpServers ?? {})) {
    if (!NAME.test(name)) {
      out.warnings.push(`MCP 서버 이름이 올바르지 않아 뺐습니다: ${name} (영문·숫자·_- 40자 이내)`);
      continue;
    }
    if (RESERVED.has(name)) {
      out.warnings.push(`'${name}' 은 AX-NAVI 내장 서버 이름이라 쓸 수 없습니다 — 다른 이름으로 바꾸세요.`);
      continue;
    }
    const s = /** @type {McpServerSpec} */ (spec);
    const missing = new Set();
    // 주소에 ${HNIX_AX_SERVER} 를 쓰는 경우가 있어 치환한 뒤에 검사한다
    const expanded = /** @type {McpServerSpec} */ (expand(s, env, missing));
    if (missing.size) {
      out.warnings.push(`MCP 서버 '${name}' 는 환경변수 ${[...missing].join(", ")} 가 없어 이번 실행에서 뺐습니다.`);
      continue;
    }
    const isHttp = expanded.type === "http" || expanded.type === "sse" || (!expanded.command && typeof expanded.url === "string");
    if (isHttp ? !/^https?:\/\//.test(String(expanded.url ?? "")) : !expanded.command) {
      out.warnings.push(`MCP 서버 '${name}' 설정이 불완전합니다 — http 는 url, stdio 는 command 가 필요합니다.`);
      continue;
    }
    out.servers[name] = isHttp ? { ...expanded, type: expanded.type ?? "http" } : expanded;
  }
  return out;
}
