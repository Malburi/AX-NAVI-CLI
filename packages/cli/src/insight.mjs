/*
 * HNIX AX Insight 로 실행 요약을 보낸다 — 조직 단위 AI 사용 현황(IBM Bob 의 사용량 관리에 대응).
 *
 * 켜는 법: 환경변수 HNIX_AX_SERVER(예: http://ax.hd.local:8700)와 HNIX_AX_KEY(ingest 권한 hx- 키).
 * 없으면 아무것도 보내지 않는다(기본 꺼짐 — 폐쇄망·개인 사용에서 외부 호출 0건).
 *
 * 토큰·비용은 직접 API 경로(anthropic)일 때만 싣는다. 구독·위임 경로(claude CLI·Agent SDK)는
 * Claude Code 가 세션 로그(~/.claude/projects)에 같은 호출을 남기고, 플랫폼 수집기(hnix-ax collect)가
 * 그것을 이미 집계한다 — 여기서 또 보내면 두 번 센다. 그 경우엔 실행 메타데이터와 세션 ID 만 보낸다.
 *
 * 실패해도 실행을 막지 않는다. 보내지 못한 이벤트는 .axnavi/logs/insight-queue.jsonl 에 쌓았다가
 * 다음 실행 때 함께 보낸다(서버 쪽은 dedupe_key 로 중복을 걸러 낸다).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const QUEUE_LIMIT = 1000;
const TIMEOUT_MS = 3000;
const WORK_ITEM = /\b((?:SR|CHG|INC|CR|REQ)[-_]?\d{2,4}(?:[-_]?\d+)?)\b/i;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ server: string, key: string } | null}
 */
export function insightTarget(env = process.env) {
  const server = env["HNIX_AX_SERVER"]?.trim();
  const key = env["HNIX_AX_KEY"]?.trim();
  if (!server || !key || !/^https?:\/\//.test(server)) return null;
  return { server: server.replace(/\/+$/, ""), key };
}

/** 현재 브랜치 — 작업번호(SR-2026-0142 등)를 뽑는 데 쓴다. git 이 없으면 null */
export function currentBranch(/** @type {string} */ root) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 실행 한 번 → AI Activity Event(플랫폼 `aiActivityEventSchema` 와 같은 모양).
 * @param {{
 *   root: string, agent: string, tier: string, provider: string, version: string,
 *   startedAt: number, endedAt: number, outcome: "ok" | "error" | "aborted",
 *   usage: { input: number, output: number, cacheRead: number, cacheWrite?: number, costUsd: number | null },
 *   toolErrors: number, questions: number, sessionId?: string | null, branch?: string | null, skill?: string | null,
 * }} r
 */
export function buildRunEvent(r) {
  const direct = r.provider === "anthropic";
  const workItem = r.branch ? WORK_ITEM.exec(r.branch)?.[1]?.toUpperCase().replace("_", "-") : undefined;
  /** @type {Record<string, unknown>} */
  const attributes = {
    "gen_ai.operation.name": "agent",
    "gen_ai.agent.name": r.agent,
    "gen_ai.system": r.provider,
    "gen_ai.request.model": r.tier,
    "hnix.project": basename(r.root),
    "hnix.repo": basename(r.root),
    "hnix.client": `axnavi/${r.version}`,
    "hnix.outcome": r.outcome === "ok" ? "ok" : "error",
    "hnix.tool_errors": r.toolErrors,
    "hnix.questions": r.questions,
    ...(r.outcome === "aborted" ? { "hnix.aborted": true } : {}),
    ...(r.branch ? { "hnix.branch": r.branch } : {}),
    ...(workItem ? { "hnix.work_item": workItem } : {}),
    ...(r.skill ? { "hnix.skill": r.skill } : {}),
    ...(r.sessionId ? { "gen_ai.conversation.id": r.sessionId } : {}),
    // 위임 경로의 토큰은 Claude Code 세션 로그 쪽에서 센다 — 어디서 세는지 밝혀 둔다
    // 게이트웨이 경유(openai)는 게이트웨이가 요청마다 계량하므로 여기서는 토큰을 싣지 않는다
    "hnix.usage_source": direct ? "axnavi" : r.provider === "openai" ? "gateway" : "claude-code-jsonl",
  };
  if (direct) {
    Object.assign(attributes, {
      "gen_ai.usage.input_tokens": r.usage.input,
      "gen_ai.usage.output_tokens": r.usage.output,
      "gen_ai.usage.cache_read.input_tokens": r.usage.cacheRead,
      ...(r.usage.cacheWrite ? { "hnix.usage.cache_write_5m_tokens": r.usage.cacheWrite } : {}),
      ...(typeof r.usage.costUsd === "number" ? { "hnix.cost_usd": r.usage.costUsd } : {}),
    });
  }
  return {
    dedupe_key: `axr:${randomUUID()}`,
    event_type: "agent.run",
    source: "axnavi",
    time_start: new Date(r.startedAt).toISOString(),
    time_end: new Date(r.endedAt).toISOString(),
    duration_ms: Math.max(0, r.endedAt - r.startedAt),
    attributes,
  };
}

/**
 * 보내고, 실패하면 대기열에 쌓는다. 성공하면 대기열도 비운다. 절대 throw 하지 않는다.
 * @param {{ logsDir: string }} paths
 * @param {object} event
 * @param {{ target?: { server: string, key: string } | null, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<"sent" | "queued" | "off">}
 */
export async function sendRunEvent(paths, event, opts = {}) {
  const target = opts.target === undefined ? insightTarget() : opts.target;
  if (!target) return "off";
  const queueFile = join(paths.logsDir, "insight-queue.jsonl");
  /** @type {object[]} */
  let queued = [];
  try {
    if (existsSync(queueFile)) queued = readFileSync(queueFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    queued = [];
  }
  const batch = [...queued.slice(-QUEUE_LIMIT + 1), event];
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${target.server}/api/v1/insight/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.key}` },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (queued.length) writeFileSync(queueFile, "", "utf8");
    return "sent";
  } catch {
    try {
      mkdirSync(paths.logsDir, { recursive: true });
      // 대기열은 마지막 QUEUE_LIMIT 건만 — 서버가 오래 꺼져 있어도 디스크를 채우지 않게
      if (queued.length >= QUEUE_LIMIT) writeFileSync(queueFile, batch.slice(-QUEUE_LIMIT).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      else appendFileSync(queueFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      /* 로그 폴더를 못 쓰면 버린다 — 실행 결과에는 영향 없음 */
    }
    return "queued";
  }
}
