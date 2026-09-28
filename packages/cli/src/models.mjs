/*
 * 이 환경에서 쓸 수 있는 모델을 스스로 찾아 쓴다.
 *
 * 사내 게이트웨이·Bedrock 은 허용하는 모델이 조직마다 다르다. 실측으로 이런 오류가 났다.
 *
 *   API Error: 400 'claude-sonnet-5' 모델은 사용할 수 없습니다.
 *   사용 가능한 모델: claude-haiku-4-5-20251001, claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6
 *
 * axnavi 는 `sonnet` 같은 별칭을 넘기고, 실제 모델은 claude 가 ANTHROPIC_DEFAULT_*_MODEL 로 푼다.
 * 그래서 이렇게 한다.
 *
 *   1) 모델이 막히면 오류가 알려 주는 목록에서 **같은 계열의 가장 새 모델**을 고른다.
 *   2) 그 값을 이 프로세스의 환경변수에 넣고 한 번 다시 실행한다. 자식 claude 가 물려받는다.
 *   3) 환경별로 기억해 두고, 다음 실행부터는 처음부터 그 모델로 돈다.
 *
 * 조직·사용자가 정한 값이 먼저다. `~/.claude/settings.json`(또는 managed-settings)의 env 는
 * 물려받은 환경변수보다 우선하고(실측), 이미 환경변수로 정해 둔 값은 여기서 덮지 않는다.
 * 기억은 7일이 지나면 버린다 — 막혔던 모델이 나중에 열렸는데 계속 옛 모델로 돌면 안 된다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 모델을 못 쓴다는 뜻의 오류. 게이트웨이 한국어 문구와 API 영어 문구를 둘 다 본다. */
const UNAVAILABLE =
  /모델은\s*사용할\s*수\s*없|사용할\s*수\s*없는\s*모델|model[^.\n]{0,60}(?:not available|not found|not supported|does not exist|not allowed|is not enabled)|invalid model|unknown model/i;

/** 오류가 알려 주는 허용 목록. */
const OFFERED = /(?:사용\s*가능한\s*모델|available models?|allowed models?)\s*[:：]\s*([^\n]+)/i;

/** 계열 → claude 가 별칭을 풀 때 보는 환경변수. */
const FAMILIES = /** @type {const} */ ([
  ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
]);

/**
 * 그 계열이 아예 없을 때 대신할 계열. 가까운 등급부터 — opus 가 없으면 sonnet,
 * haiku 가 없으면 sonnet. 등급을 올려 비싸지는 쪽(haiku→opus)은 마지막이다.
 * @type {Record<string, string[]>}
 */
const NEAREST = { sonnet: ["opus", "haiku"], opus: ["sonnet", "haiku"], haiku: ["sonnet", "opus"] };

/** 기억을 버리는 기간. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 모델 ID 의 버전 숫자. 날짜 꼬리(20251001)는 버전이 아니라서 뺀다.
 * @param {string} id
 * @returns {number[]}
 */
function versionOf(id) {
  return id
    .split("-")
    .slice(2)
    .filter((part) => /^\d{1,3}$/.test(part))
    .map(Number);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * @param {readonly string[]} offered
 * @param {string} family
 */
function newestOf(offered, family) {
  let best = "";
  for (const id of offered) {
    if (!id.startsWith(`claude-${family}-`)) continue;
    if (!best || newer(versionOf(id), versionOf(best))) best = id;
  }
  return best;
}

/**
 * 오류가 알려 준 목록에서 계열별로 쓸 모델을 고른다. 그 계열이 없으면 가까운 계열로 채운다.
 * @param {readonly string[]} offered
 * @returns {Array<{ env: string, model: string }>}
 */
export function suggestMapping(offered) {
  /** @type {Array<{ env: string, model: string }>} */
  const out = [];
  for (const [family, env] of FAMILIES) {
    let model = newestOf(offered, family);
    for (const alt of NEAREST[family] ?? []) {
      if (model) break;
      model = newestOf(offered, alt);
    }
    if (model) out.push({ env, model });
  }
  return out;
}

/**
 * 모델을 못 쓴다는 오류를 읽는다. 아니면 null.
 * @param {string} reason
 * @returns {{ rejected: string, offered: string[] } | null}
 */
export function parseModelError(reason) {
  const text = String(reason ?? "");
  if (!UNAVAILABLE.test(text)) return null;
  const rejected = /['"`](claude-[\w.-]+)['"`]/.exec(text)?.[1] ?? "";
  const listed = OFFERED.exec(text)?.[1] ?? "";
  const offered = [...new Set(listed.match(/claude-[\w.-]+/g) ?? [])].map((id) => id.replace(/[.,]+$/, ""));
  return { rejected, offered };
}

/**
 * 환경마다 허용 모델이 다르다. 같은 PC 에서도 연결 대상을 바꾸면 다시 배워야 한다.
 * @param {NodeJS.ProcessEnv} env
 */
export function environmentKey(env) {
  const parts = [
    env["CLAUDE_CODE_USE_BEDROCK"] ? `bedrock:${env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? ""}:${env["ANTHROPIC_BEDROCK_BASE_URL"] ?? ""}` : "",
    env["CLAUDE_CODE_USE_VERTEX"] ? `vertex:${env["CLOUD_ML_REGION"] ?? ""}` : "",
    env["ANTHROPIC_BASE_URL"] ? `url:${env["ANTHROPIC_BASE_URL"]}` : "",
  ].filter(Boolean);
  return parts.join("|") || "default";
}

/** @returns {string} */
const defaultStorePath = () => join(homedir(), ".axnavi", "models.json");

/**
 * @param {string} path
 * @returns {Record<string, { mapping: Record<string, string>, rejected: string, learnedAt: number }>}
 */
function readStore(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * 기억해 둔 모델을 이 프로세스 환경변수에 얹는다. 이미 정해진 값은 덮지 않는다.
 * @param {{ env?: NodeJS.ProcessEnv, storePath?: string, now?: number }} [opts]
 * @returns {Record<string, string>}  실제로 얹은 것
 */
export function applyLearnedModels({ env = process.env, storePath = defaultStorePath(), now = Date.now() } = {}) {
  const entry = readStore(storePath)[environmentKey(env)];
  if (!entry || now - entry.learnedAt > TTL_MS) return {};
  /** @type {Record<string, string>} */
  const applied = {};
  for (const [name, model] of Object.entries(entry.mapping ?? {})) {
    if (env[name]) continue;
    env[name] = model;
    applied[name] = model;
  }
  return applied;
}

/**
 * 모델 오류에서 쓸 모델을 배워 환경변수에 얹고 기억한다.
 *
 * 사용자가 환경변수로 직접 정한 값은 덮지 않는다 — 그 값 자체가 막혔다면 사람이 고칠 일이다.
 * 이번에 **새로 바뀐 것이 없으면** null 이다. 호출부는 그때 다시 실행하지 않는다
 * (같은 설정으로 돌리면 같은 오류가 난다).
 *
 * @param {string} reason
 * @param {{ env?: NodeJS.ProcessEnv, storePath?: string, now?: number, ours?: Set<string> }} [opts]
 *   ours  이 프로세스가 얹은 변수 이름 — 이것들은 새로 배운 값으로 바꿔도 된다
 * @returns {{ rejected: string, mapping: Record<string, string> } | null}
 */
export function learnFromError(reason, { env = process.env, storePath = defaultStorePath(), now = Date.now(), ours = LEARNED } = {}) {
  const parsed = parseModelError(reason);
  if (!parsed || !parsed.offered.length) return null;
  const suggested = suggestMapping(parsed.offered);
  if (!suggested.length) return null;

  /** @type {Record<string, string>} */
  const mapping = {};
  let changed = false;
  for (const { env: name, model } of suggested) {
    mapping[name] = model;
    if (env[name] === model) continue;
    if (env[name] && !ours.has(name)) continue; // 사용자가 정한 값
    env[name] = model;
    ours.add(name);
    changed = true;
  }
  if (!changed) return null;

  const store = readStore(storePath);
  store[environmentKey(env)] = { mapping, rejected: parsed.rejected, learnedAt: now };
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {
    // 기억을 못 남겨도 이번 실행은 돈다. 다음에 한 번 더 배우면 된다.
  }
  return { rejected: parsed.rejected, mapping };
}

/** 이 프로세스가 얹은 변수 이름. */
const LEARNED = new Set();

/**
 * 시작할 때 기억해 둔 모델을 얹는다. 얹은 변수는 "우리 것" 으로 적어 둬야 나중에 다시 배울 때 바꿀 수 있다.
 * @returns {Record<string, string>}
 */
export function startWithLearnedModels() {
  const applied = applyLearnedModels();
  for (const name of Object.keys(applied)) LEARNED.add(name);
  return applied;
}

/**
 * 스스로 풀 수 없을 때(목록이 없거나 사용자가 정한 값이 막힘) 보여 줄 안내. 모델 오류가 아니면 null.
 * @param {string} reason
 * @returns {string[] | null}
 */
export function modelUnavailableHint(reason) {
  const parsed = parseModelError(reason);
  if (!parsed) return null;
  const { rejected } = parsed;
  const mapping = suggestMapping(parsed.offered);

  const lines = [
    `  이 환경은 ${rejected ? `${rejected} 를` : "요청한 모델을"} 허용하지 않습니다. 등급마다 쓸 모델을 설정으로 정하면 됩니다.`,
  ];
  if (mapping.length) {
    lines.push("  ~/.claude/settings.json 의 env 에 아래를 넣으세요 (관리자라면 managed-settings.json 의 env).");
    lines.push("    \"env\": {");
    mapping.forEach(({ env, model }, i) => {
      lines.push(`      "${env}": "${model}"${i < mapping.length - 1 ? "," : ""}`);
    });
    lines.push("    }");
  } else {
    lines.push("  ~/.claude/settings.json 의 env 에 ANTHROPIC_DEFAULT_SONNET_MODEL · _OPUS_ · _HAIKU_ 를 허용된 모델로 지정하세요.");
  }
  return lines;
}
