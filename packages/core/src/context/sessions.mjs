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
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
 */

/** 목록·복원이 무거워지지 않도록 상한을 둔다. */
const TITLE_LIMIT = 70;

/**
 * @param {ProjectPaths} paths
 * @returns {Promise<string>}
 */
async function ensureDir(paths) {
  await mkdir(paths.sessionsDir, { recursive: true });
  return paths.sessionsDir;
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
  await writeFile(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
}

/**
 * @param {ProjectPaths} paths
 * @param {string} id
 * @returns {Promise<SessionRecord | null>}
 */
export async function loadSession(paths, id) {
  const path = join(paths.sessionsDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // 깨진 세션 파일 하나가 CLI 전체를 못 쓰게 만들면 안 된다.
    return null;
  }
}

/**
 * 최신순 목록.
 * @param {ProjectPaths} paths
 * @param {number} [limit]
 * @returns {Promise<SessionRecord[]>}
 */
export async function listSessions(paths, limit = 20) {
  if (!existsSync(paths.sessionsDir)) return [];
  const names = (await readdir(paths.sessionsDir))
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);
  /** @type {SessionRecord[]} */
  const out = [];
  for (const name of names) {
    const record = await loadSession(paths, name.replace(/\.json$/, ""));
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
