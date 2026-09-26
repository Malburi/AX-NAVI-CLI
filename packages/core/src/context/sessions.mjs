/*
 * 세션 저장.
 *
 * 터미널을 닫으면 대화가 사라지는 문제를 없앤다. 한 턴이 끝날 때마다 저장하므로
 * 중간에 죽어도 거기까지는 남는다 — 마지막에 한 번 저장하는 방식은 죽는 순간
 * 전부 잃는다.
 *
 * 저장 위치는 `.axnavi/sessions/` 다. `_workspace/` 가 아닌 이유는 그쪽이
 * 플러그인과 공유하는 분석 산출물 영역이고, 세션은 CLI 개인 상태이기 때문이다.
 * (`.axnavi/.gitignore` 가 sessions/ 를 제외한다 — 전사에 커밋될 것이 아니다.)
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** @typedef {import("../../types/paths.js").ProjectPaths} ProjectPaths */
/** @typedef {import("../loop.mjs").Conversation} Conversation */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} root
 * @property {string} agent
 * @property {number} turns
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} title           목록에서 알아볼 수 있는 첫 요청 앞부분
 * @property {Conversation} conversation
 * @property {SessionMessage[]} [messages]  이어서 열 때 보여 줄 대화 기록
 */

/**
 * 주고받은 말 한 마디.
 * @typedef {object} SessionMessage
 * @property {"user" | "assistant"} role
 * @property {string} text
 * @property {string} at
 */

/** 목록·복원이 무거워지지 않도록 상한을 둔다. */
const TITLE_LIMIT = 70;

/*
 * 대화 기록 상한.
 *
 * 위임 경로(claude CLI)는 대화를 그쪽이 들고 있어 conversation.turns 가 비어 있다
 * (실측). 그래서 이어서 열 때 보여 줄 내용을 **우리가 따로** 쌓아 둔다.
 * 무한정 쌓으면 세션 파일이 커지므로 마지막 것들만 남긴다.
 */
const MESSAGE_LIMIT = 40;
const MESSAGE_CHARS = 8000;

/**
 * @param {ProjectPaths} paths
 * @returns {Promise<string>}
 */
async function ensureDir(paths) {
  await mkdir(paths.sessionsDir, { recursive: true });
  ensureAxnaviIgnore(dirname(paths.sessionsDir));
  return paths.sessionsDir;
}

/*
 * `.axnavi/` 에는 세션·감사 기록·레거시 인코딩 백업이 쌓인다. 예전에는 `axnavi init` 만 .gitignore 를
 * 만들어, init 없이 쓰면 고객 저장소에 대화 기록이 커밋될 수 있었다(리뷰 지적). 처음 쓸 때 만든다.
 * 인코딩 보존 훅(provider-claude-cli/src/legacy-encoding.mjs)도 같은 목록을 쓴다.
 * @param {string} axnaviDir
 */
export function ensureAxnaviIgnore(axnaviDir) {
  const path = join(axnaviDir, ".gitignore");
  const want = ["sessions/", "logs/", "encoding/", "*.tmp-*"];
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      const lines = text.split(/\r?\n/);
      const missing = want.filter((line) => !lines.includes(line));
      if (missing.length) writeFileSync(path, `${text.replace(/\s*$/, "\n")}${missing.join("\n")}\n`, "utf8");
      return;
    }
    mkdirSync(axnaviDir, { recursive: true });
    writeFileSync(path, `${want.join("\n")}\n`, "utf8");
  } catch { /* 못 쓰면 넘어간다 — 저장 자체를 막지는 않는다 */ }
}

/* 세션 id 는 우리가 만든 모양만 받는다. `/resume ../../x` 가 sessions 밖 파일을 열었다(리뷰 실측). */
const SESSION_ID = /^[\w-]{1,80}$/;

/**
 * 읽은 JSON 이 세션 레코드 모양인가. 모양이 틀린 파일 하나가 `/sessions` 전체를 죽였다(리뷰 실측).
 * @param {any} r
 */
function isSessionRecord(r) {
  return Boolean(r) && typeof r === "object" && typeof r.id === "string" && typeof r.conversation === "object" && r.conversation !== null && Array.isArray(r.conversation.turns ?? []);
}

/** @returns {string} */
export function newSessionId() {
  // 시각 접두사 — 파일 이름만으로 최신순 정렬이 된다.
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function toTitle(text) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > TITLE_LIMIT ? `${one.slice(0, TITLE_LIMIT)}…` : one;
}

/**
 * 세션 한 건을 저장한다(덮어쓰기).
 * @param {ProjectPaths} paths
 * @param {SessionRecord} record
 * @returns {Promise<void>}
 */
export async function saveSession(paths, record) {
  const dir = await ensureDir(paths);
  // 임시 파일에 쓰고 바꿔 끼운다 — 쓰는 도중에 죽어도 이전 세션이 남는다.
  const path = join(dir, `${record.id}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await rename(tmp, path);
}

/**
 * @param {ProjectPaths} paths
 * @param {string} id
 * @returns {Promise<SessionRecord | null>}
 */
export async function loadSession(paths, id) {
  if (!SESSION_ID.test(id)) return null;
  const path = join(paths.sessionsDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    // 깨진 세션 파일 하나가 CLI 전체를 못 쓰게 만들면 안 된다.
    return isSessionRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * 파일은 있는데 못 읽는 세션인가. "그런 세션이 없다" 와 "손상됐다" 는 다른 안내가 필요하다.
 * @param {ProjectPaths} paths
 * @param {string} id
 */
export function sessionIsCorrupt(paths, id) {
  return SESSION_ID.test(id) && existsSync(join(paths.sessionsDir, `${id}.json`));
}

/**
 * 최신순 목록.
 * @param {ProjectPaths} paths
 * @param {number} [limit]
 * @returns {Promise<SessionRecord[]>}
 */
export async function listSessions(paths, limit = 20) {
  if (!existsSync(paths.sessionsDir)) return [];
  /*
   * 마지막으로 쓴 순서다. 파일 이름(만든 시각)으로 정렬하면 옛 세션을 이어 쓰고 나가도 `--continue` 가
   * 다른 세션을 열었다(리뷰 지적).
   */
  const names = (await readdir(paths.sessionsDir)).filter((n) => n.endsWith(".json"));
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(paths.sessionsDir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  /** @type {SessionRecord[]} */
  const out = [];
  for (const { n } of dated) {
    if (out.length >= limit) break;
    const record = await loadSession(paths, n.replace(/\.json$/, ""));
    if (record) out.push(record);
  }
  return out;
}

/**
 * 가장 최근 세션. `--continue` 가 쓴다.
 * @param {ProjectPaths} paths
 * @returns {Promise<SessionRecord | null>}
 */
export async function latestSession(paths) {
  const [first] = await listSessions(paths, 1);
  return first ?? null;
}

/**
 * 대화 한 마디를 기록에 붙인다. 상한을 넘으면 오래된 것부터 떨어난다.
 *
 * @param {SessionMessage[]} messages
 * @param {"user" | "assistant"} role
 * @param {string} text
 * @returns {SessionMessage[]}
 */
export function appendMessage(messages, role, text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return messages;
  const one = trimmed.length > MESSAGE_CHARS
    ? `${trimmed.slice(0, MESSAGE_CHARS)}\n…(이하 생략)`
    : trimmed;
  const next = [...messages, { role, text: one, at: new Date().toISOString() }];
  return next.length > MESSAGE_LIMIT ? next.slice(next.length - MESSAGE_LIMIT) : next;
}
