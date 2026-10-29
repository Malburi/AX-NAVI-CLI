/*
 * 인증 경로 · 조직 정책 · 과금 표시.
 *
 * 개발자마다 가진 것이 다르다(개인 구독, Team·Enterprise 좌석, API 키, Bedrock·Vertex, 아무것도 없음).
 * axnavi 는 요금제를 알 필요가 없다 — "누구의 자격으로 어디서 부르는가"만 세 경로로 나눈다.
 *   subscription  본인이 로그인한 claude CLI 에 위임. 구독·좌석 모두 같고, Claude Code 에 Bedrock·Vertex 를
 *                 설정해 둔 경우도 여기로 간다(자격은 Claude Code 가 고른다).
 *   key           ANTHROPIC_API_KEY·ANTHROPIC_AUTH_TOKEN 으로 직접(Messages API, 없으면 Agent SDK).
 *   gateway       사내 OpenAI 호환 게이트웨이(조직 API 키·사내 로컬 모델). 조직에 과금된다.
 *
 * 조직 정책은 두 곳에서 읽는다.
 *   PC 공용 정책  관리자가 배포하는 파일(개발자 권한으로 못 고치는 위치). AXNAVI_POLICY_FILE 로 바꿀 수 있다.
 *   저장소 정책   .axnavi/policy.json — 허용 경로를 더 좁히기만 한다(넓히지 못한다).
 * 정책 파일이 있는데 읽지 못하면 실행하지 않는다 — 정책을 조용히 건너뛰면 기밀 저장소가 외부로 나갈 수 있다.
 */
import { orgPolicyPath } from "../../core/src/config/org.mjs";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @typedef {"subscription" | "key" | "gateway"} AuthRoute */
export const AUTH_ROUTES = /** @type {const} */ (["subscription", "key", "gateway"]);
export const ROUTE_LABEL = { subscription: "구독 로그인", key: "API 키", gateway: "사내 게이트웨이" };

/**
 * @typedef {{
 *   allowedRoutes: AuthRoute[],
 *   preferred: AuthRoute | null,
 *   gateway: { baseUrl?: string, model?: string } | null,
 *   message: string | null,
 *   sources: string[],
 * }} AuthPolicy
 */

/** PC 공용 정책 파일의 기본 위치 */
export function machinePolicyPath(env = process.env, platform = process.platform) {
  if (env["AXNAVI_POLICY_FILE"]) return env["AXNAVI_POLICY_FILE"];
  if (platform === "win32") return join(env["ProgramData"] || "C:\\ProgramData", "axnavi", "policy.json");
  if (platform === "darwin") return "/Library/Application Support/axnavi/policy.json";
  return "/etc/axnavi/policy.json";
}

/**
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {{ policy: AuthPolicy } | { error: string }}
 */
export function loadAuthPolicy(opts = {}) {
  const env = opts.env ?? process.env;
  /** @type {AuthPolicy} */
  const policy = { allowedRoutes: [...AUTH_ROUTES], preferred: null, gateway: null, message: null, sources: [] };
  /** @type {{ path: string, machine: boolean, org?: boolean }[]} */
  const files = [{ path: machinePolicyPath(env, opts.platform), machine: true }];
  // 조직 배포본(플랫폼) — PC 공용 정책 다음, 저장소 정책 앞
  const org = orgPolicyPath(env);
  if (org) files.push({ path: org, machine: false, org: true });
  if (opts.root) files.push({ path: join(opts.root, ".axnavi", "policy.json"), machine: false });
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    /** @type {any} */
    let raw;
    try {
      raw = JSON.parse(readFileSync(f.path, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      return { error: `정책 파일을 읽지 못해 실행하지 않습니다 — ${f.path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const bad = validate(raw);
    if (bad) return { error: `정책 파일이 올바르지 않아 실행하지 않습니다 — ${f.path}: ${bad}` };
    if (raw.allowedRoutes) policy.allowedRoutes = policy.allowedRoutes.filter((r) => raw.allowedRoutes.includes(r));
    // 선호·게이트웨이 주소는 PC 공용 정책만 정한다. 저장소 파일은 좁히기만 한다.
    if ((f.machine || (f.org && !policy.preferred)) && raw.preferred) policy.preferred = raw.preferred;
    if ((f.machine || (f.org && !policy.gateway)) && raw.gateway) policy.gateway = { ...(raw.gateway.baseUrl ? { baseUrl: raw.gateway.baseUrl } : {}), ...(raw.gateway.model ? { model: raw.gateway.model } : {}) };
    if (raw.message) policy.message = policy.message ? `${policy.message} / ${raw.message}` : raw.message;
    policy.sources.push(f.path);
  }
  if (policy.preferred && !policy.allowedRoutes.includes(policy.preferred)) policy.preferred = null;
  return { policy };
}

/** @param {any} raw @returns {string | null} */
function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "JSON 객체가 아닙니다";
  if (raw.allowedRoutes !== undefined) {
    if (!Array.isArray(raw.allowedRoutes) || raw.allowedRoutes.some((/** @type {unknown} */ r) => !AUTH_ROUTES.includes(/** @type {any} */ (r)))) return `allowedRoutes 는 ${AUTH_ROUTES.join(" | ")} 의 배열이어야 합니다`;
  }
  if (raw.preferred !== undefined && raw.preferred !== null && !AUTH_ROUTES.includes(raw.preferred)) return `preferred 는 ${AUTH_ROUTES.join(" | ")} 중 하나여야 합니다`;
  if (raw.gateway !== undefined && raw.gateway !== null) {
    if (typeof raw.gateway !== "object") return "gateway 는 { baseUrl, model } 객체여야 합니다";
    if (raw.gateway.baseUrl !== undefined && !/^https?:\/\//.test(String(raw.gateway.baseUrl))) return "gateway.baseUrl 은 http(s):// 주소여야 합니다";
  }
  if (raw.message !== undefined && typeof raw.message !== "string") return "message 는 문자열이어야 합니다";
  return null;
}

/**
 * 개발자 선호(AXNAVI_AUTH). auto·빈 값은 null. 모르는 값은 오류.
 * @returns {{ preferred: AuthRoute | null } | { error: string }}
 */
export function preferredFromEnv(env = process.env) {
  const v = env["AXNAVI_AUTH"]?.trim().toLowerCase();
  if (!v || v === "auto") return { preferred: null };
  if (!AUTH_ROUTES.includes(/** @type {any} */ (v))) return { error: `AXNAVI_AUTH 값이 올바르지 않습니다: ${v} (auto | ${AUTH_ROUTES.join(" | ")})` };
  return { preferred: /** @type {AuthRoute} */ (v) };
}

/**
 * 구독 경로가 실제로 돌 수 있는가 — 설치만 보고 고르면 첫 요청에서 "Not logged in" 으로 죽는다.
 * macOS 는 키체인에 두므로 파일로 알 수 없다 — 그때는 된다고 본다.
 */
export function claudeLoginAvailable(env = process.env, platform = process.platform) {
  if (env["CLAUDE_CODE_OAUTH_TOKEN"]) return true;
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1" || env["CLAUDE_CODE_USE_VERTEX"] === "1" || env["CLAUDE_CODE_USE_FOUNDRY"] === "1") return true;
  if (platform === "darwin") return true;
  const dir = env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  return existsSync(join(dir, ".credentials.json"));
}

/**
 * 정책의 게이트웨이 기본값을 환경변수 밑에 깐다 — 개발자는 키(AXNAVI_OPENAI_API_KEY)만 넣으면 된다.
 * @param {NodeJS.ProcessEnv} env @param {AuthPolicy | null} policy
 * @returns {NodeJS.ProcessEnv}
 */
export function gatewayEnv(env, policy) {
  const g = policy?.gateway;
  if (!g) return env;
  return {
    ...env,
    ...(env["AXNAVI_OPENAI_BASE_URL"] ? {} : g.baseUrl ? { AXNAVI_OPENAI_BASE_URL: g.baseUrl } : {}),
    ...(env["AXNAVI_OPENAI_MODEL"] ? {} : g.model ? { AXNAVI_OPENAI_MODEL: g.model } : {}),
  };
}

/**
 * 누구에게 과금되는지 한 줄로 — doctor·실행 로그용
 * @param {AuthRoute} route @param {NodeJS.ProcessEnv} [env] @param {string} [extra]
 */
export function billingLabel(route, env = process.env, extra = "") {
  if (route === "gateway") return `사내 게이트웨이 — 조직 과금${extra ? ` (${extra})` : ""}`;
  if (route === "key") {
    if (env["ANTHROPIC_API_KEY"]) return "API 키(ANTHROPIC_API_KEY) — 키 주인에게 과금";
    return `토큰(ANTHROPIC_AUTH_TOKEN${env["ANTHROPIC_BASE_URL"] ? ` · ${env["ANTHROPIC_BASE_URL"]}` : ""}) — 토큰 발급처에 과금`;
  }
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1") return "Claude Code → Amazon Bedrock — 클라우드 계약에 과금";
  if (env["CLAUDE_CODE_USE_VERTEX"] === "1") return "Claude Code → Google Vertex AI — 클라우드 계약에 과금";
  if (env["CLAUDE_CODE_USE_FOUNDRY"] === "1") return "Claude Code → Microsoft Foundry — 클라우드 계약에 과금";
  if (env["CLAUDE_CODE_OAUTH_TOKEN"]) return "본인 구독 토큰(claude setup-token) — 본인 구독·좌석 한도";
  return "본인 Claude 로그인(Pro·Max·Team·Enterprise) — 본인 구독·좌석 한도";
}
