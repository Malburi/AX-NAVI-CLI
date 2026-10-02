/*
 * 고친 뒤 검증 — 모델의 "GO" 를 믿지 않고 런타임이 사실로 다시 본다.
 *
 * 실측(실제 레거시 벤치 R2): "안 쓰는 컬럼이니 빼줘" 에 v1 axnavi 는 3번 중 2번 SELECT 에서 컬럼을 빼고 끝냈다.
 * 결과를 위치(rtInfo[1][2])로 읽는 화면 23~24곳이 그대로였는데 한 번은 JSP 하나만 고치고 GO 로 보고했다.
 * 지침("재영향도를 확인하라")은 지켜지지 않을 수 있다 — 그래서 턴이 끝나면 여기서 확인한다.
 *
 *   1) 이번 턴에 바뀐 SQL 파일에서 SELECT 컬럼 순서가 바뀐 SQL 을 찾는다(턴 전 내용 ↔ 지금).
 *   2) 인덱스를 다시 만들고(바뀐 저장소만), 그 SQL 결과를 위치로 읽는 화면을 impact 로 찾는다.
 *   3) 바뀐 위치 뒤를 읽는 화면 중 이번 턴에 고치지 않은 곳이 남으면 HOLD 로 알린다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { COMMANDS, selectColumns } from "../../indexer/index.mjs";
import { decodeLegacy, legacyEncodingOf } from "../../provider-claude-cli/src/legacy-encoding.mjs";
import { ensureFreshIndexes } from "./freshness.mjs";

/** @typedef {import("./turn-audit.mjs").Change} Change */
/** @typedef {import("./turn-audit.mjs").Snapshot} Snapshot */

/** @param {Buffer} bytes @param {string} path */
function decode(bytes, path) {
  const enc = legacyEncodingOf(bytes, path);
  return enc ? decodeLegacy(bytes, enc) : bytes.toString("utf8");
}

/**
 * SQL 파일의 SELECT 문 — id → 컬럼 이름 순서.
 * MyBatis/iBatis `<select id>` 와 국내 SI 의 `<query><id>…</id><value>…</value></query>` 를 본다.
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function selectStatements(text) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const m of text.matchAll(/<select\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const cols = selectColumns(m[2] ?? "");
    if (cols.length) out.set(/** @type {string} */ (m[1]), cols.map((c) => c.name.toUpperCase()));
  }
  for (const m of text.matchAll(/<(query|statement|sql|sqlQuery|queryString)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const id = /<id>\s*([^<]+?)\s*<\/id>/i.exec(m[2] ?? "")?.[1];
    const value = /<value>([\s\S]*?)<\/value>/i.exec(m[2] ?? "")?.[1];
    if (!id || !value) continue;
    const cols = selectColumns(value);
    if (cols.length) out.set(id, cols.map((c) => c.name.toUpperCase()));
  }
  return out;
}

/**
 * @param {Snapshot} snap
 * @param {Change} change
 * @returns {Buffer | null}
 */
function beforeBytes(snap, change) {
  const repo = snap.repos.get(change.root);
  const before = repo?.dirty.get(change.rel);
  if (before) return before.bytes;
  try {
    return execFileSync("git", ["-C", change.root, "show", `HEAD:${change.rel.replace(/\\/g, "/")}`], { encoding: "buffer", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * @typedef {object} ColumnChange
 * @property {string} id
 * @property {string[]} before
 * @property {string[]} after
 * @property {number} from   처음 달라진 위치(0부터)
 * @property {string} file
 */

/**
 * 이번 턴에 SELECT 컬럼 순서가 바뀐 SQL.
 * @param {Snapshot} snap
 * @param {Change[]} changes
 * @returns {ColumnChange[]}
 */
export function changedSelects(snap, changes) {
  /** @type {ColumnChange[]} */
  const out = [];
  for (const change of changes) {
    if (change.kind !== "modified" || extname(change.path).toLowerCase() !== ".xml") continue;
    const old = beforeBytes(snap, change);
    if (!old) continue;
    let now;
    try { now = readFileSync(change.path); } catch { continue; }
    const before = selectStatements(decode(old, change.path));
    const after = selectStatements(decode(now, change.path));
    for (const [id, cols] of before) {
      const next = after.get(id);
      if (!next) continue;
      let from = 0;
      while (from < cols.length && from < next.length && cols[from] === next[from]) from += 1;
      if (from === cols.length && from === next.length) continue;
      out.push({ id, before: cols, after: next, from, file: change.path });
    }
  }
  return out;
}

/**
 * @typedef {object} Consumer
 * @property {string} repo
 * @property {string} file
 * @property {number} line
 * @property {string[]} reads
 */

/**
 * @typedef {object} PostVerify
 * @property {ColumnChange[]} columnChanges
 * @property {Array<{ id: string, affected: Consumer[], unhandled: Consumer[] }>} results
 * @property {"ok" | "hold" | "none"} verdict
 */

/**
 * @param {Snapshot} snap
 * @param {Change[]} changes   이번 턴에 바뀐 소스 파일 전부(승인 여부와 무관)
 * @param {Array<{ root: string, indexDir?: string, primary?: boolean }>} roots
 * @returns {PostVerify}
 */
export function postVerify(snap, changes, roots) {
  const columnChanges = changedSelects(snap, changes);
  if (!columnChanges.length) return { columnChanges, results: [], verdict: "none" };
  ensureFreshIndexes(roots);
  const primary = roots.find((r) => r.primary) ?? roots[0];
  if (!primary) return { columnChanges, results: [], verdict: "none" };
  const changed = new Set(changes.map((c) => `${basename(c.root)}/${relative(c.root, c.path).replace(/\\/g, "/")}`.toLowerCase()));
  const results = columnChanges.map((cc) => {
    const impact = /** @type {any} */ (COMMANDS.impact({ root: primary.root, ...(primary.indexDir ? { indexDir: primary.indexDir } : {}), sql: cc.id, limit: 500 }));
    /** @type {Consumer[]} */
    const affected = [];
    for (const caller of impact.screen_callers?.items ?? []) {
      const hits = (caller.reads ?? []).filter((/** @type {any} */ r) => typeof r.col === "number" && r.col >= cc.from);
      if (hits.length) affected.push({ repo: caller.repo, file: caller.file, line: caller.line, reads: hits.map((/** @type {any} */ r) => r.text) });
    }
    const unhandled = affected.filter((c) => !changed.has(`${c.repo}/${c.file}`.toLowerCase()));
    return { id: cc.id, affected, unhandled };
  });
  return { columnChanges, results, verdict: results.some((r) => r.unhandled.length) ? "hold" : "ok" };
}

/**
 * @param {PostVerify} pv
 * @param {string} cwd
 * @returns {string[]}
 */
export function describePostVerify(pv, cwd) {
  if (pv.verdict === "none") return [];
  /** @type {string[]} */
  const lines = [];
  for (const cc of pv.columnChanges) {
    const r = pv.results.find((x) => x.id === cc.id);
    lines.push(`SQL ${cc.id} 의 SELECT 순서가 바뀌었습니다 (${relative(cwd, cc.file) || cc.file}): [${cc.before.join(", ")}] → [${cc.after.join(", ")}]`);
    if (!r) continue;
    if (!r.affected.length) { lines.push("  결과를 위치로 읽는 화면을 인덱스에서 찾지 못했습니다 — 컬럼 이름으로 한 번 더 확인하세요."); continue; }
    lines.push(`  위치로 읽는 화면 ${r.affected.length}곳 중 이번에 고치지 않은 곳 ${r.unhandled.length}곳`);
    for (const c of r.unhandled.slice(0, 12)) lines.push(`  - ${c.repo}/${c.file}:${c.line} ${c.reads.slice(0, 2).join(", ")}`);
    if (r.unhandled.length > 12) lines.push(`  … 외 ${r.unhandled.length - 12}곳`);
  }
  lines.push(pv.verdict === "hold"
    ? "런타임 판정: HOLD — 고치지 않은 화면이 남아 있습니다. 그대로 배포하면 그 화면들이 다른 값을 읽습니다."
    : "런타임 판정: 위치로 읽는 화면을 모두 함께 고쳤습니다.");
  return lines;
}

