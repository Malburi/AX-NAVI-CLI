/*
 * 현대화 AI 초안 — 레시피가 자동으로 못 바꾼 Oracle 구문(ROWNUM·(+)·CONNECT BY·MERGE·여러 줄 DECODE)을
 * 문장 단위로 잘라 LLM 에게 PostgreSQL 초안을 받는다. 초안은 보고서로만 남기고 소스에는 쓰지 않는다(사람이 검토해 옮긴다).
 *
 * 문장 자르기:
 *   매퍼 XML  감싸는 <select|insert|update|delete|sql id="…"> 요소 전체
 *   SQL 파일  앞뒤 ; (또는 / 한 줄) 사이
 *   자바      큰따옴표 문자열이 이어지는 줄 묶음
 * LLM 호출은 밖(CLI)에서 ask(prompt) 로 넣는다 — 여기는 네트워크를 모른다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DRAFT_RULES = ["PG-101", "PG-102", "PG-103", "PG-104", "PG-105"];
const MAX_LINES = 160;

export const DRAFT_SYSTEM = [
  "너는 Oracle SQL 을 PostgreSQL 로 옮기는 도우미다. 도구를 쓰지 말고 주어진 문장만 바꿔 답한다.",
  "- 같은 결과를 내야 한다. MyBatis 태그(<if>·<where>·<foreach>), #{…}·${…} 바인드, 자바 문자열 따옴표·+ 연결 구조는 그대로 둔다.",
  "- ROWNUM 조건·페이징 → LIMIT/OFFSET 또는 ROW_NUMBER() OVER(). ORDER BY 전에 ROWNUM 을 자르던 쿼리는 뜻이 다르므로 확인 사항에 적는다.",
  "- (+) → LEFT/RIGHT OUTER JOIN … ON. (+) 가 붙은 쪽이 NULL 이 허용되는 쪽이다. 같은 테이블의 다른 조건도 ON 으로 옮긴다.",
  "- CONNECT BY → WITH RECURSIVE(LEVEL·경로는 열로), MERGE → INSERT … ON CONFLICT … DO UPDATE, DECODE → CASE(NULL 비교는 IS NOT DISTINCT FROM).",
  "- 답 형식: 코드 블록 하나(```sql 또는 ```xml 또는 ```java)에 바꾼 전체 문장, 그 아래 '확인:' 으로 시작하는 줄에 사람이 확인할 점을 하나씩. 다른 말은 쓰지 않는다.",
].join("\n");

/**
 * @typedef {{ file: string, start: number, end: number, id: string | null, rules: string[], lines: number[], text: string }} DraftTarget
 */

/** @param {string[]} lines @param {number} at 0부터 @param {string} file */
function statementRange(lines, at, file) {
  if (/\.xml$/i.test(file)) {
    for (let s = at; s >= Math.max(0, at - MAX_LINES); s--) {
      const m = /** @type {string} */ (lines[s]).match(/<(select|insert|update|delete|sql)\b[^>]*?\bid\s*=\s*"([^"]+)"/);
      if (!m) {
        if (s < at && /<\/(select|insert|update|delete|sql)>/.test(/** @type {string} */ (lines[s]))) break;
        continue;
      }
      const close = new RegExp(`</${m[1]}>`);
      for (let e = Math.max(s, at); e < Math.min(lines.length, s + MAX_LINES); e++) if (close.test(/** @type {string} */ (lines[e]))) return { start: s, end: e, id: /** @type {string} */ (m[2]) };
      break;
    }
    return { start: Math.max(0, at - 5), end: Math.min(lines.length - 1, at + 5), id: null };
  }
  if (/\.java$/i.test(file)) {
    const str = (/** @type {number} */ i) => i >= 0 && i < lines.length && /"/.test(/** @type {string} */ (lines[i]));
    let s = at;
    let e = at;
    while (s > 0 && at - s < 30 && str(s - 1)) s--;
    while (e < lines.length - 1 && e - at < 30 && str(e + 1)) e++;
    return { start: s, end: e, id: null };
  }
  const ends = (/** @type {number} */ i) => /;\s*(--.*)?$/.test(/** @type {string} */ (lines[i])) || /^\s*\/\s*$/.test(/** @type {string} */ (lines[i]));
  let s = at;
  while (s > 0 && at - s < MAX_LINES && !ends(s - 1)) s--;
  let e = at;
  while (e < lines.length - 1 && e - at < MAX_LINES && !ends(e)) e++;
  return { start: s, end: e, id: null };
}

/**
 * 수동 항목 중 AI 초안을 받을 문장들 — 같은 문장은 하나로 묶는다.
 * @param {{ root: string, findings: { rule: string, file: string, line: number, kind: string }[] }} result
 * @param {{ limit?: number, read?: (file: string) => string }} [opts]
 * @returns {{ targets: DraftTarget[], skipped: number }}
 */
export function collectDraftTargets(result, opts = {}) {
  const read = opts.read ?? ((/** @type {string} */ f) => readFileSync(join(result.root, f), "utf8"));
  const limit = opts.limit ?? 20;
  /** @type {Map<string, DraftTarget>} */
  const byKey = new Map();
  /** @type {Map<string, string[]>} */
  const cache = new Map();
  let skipped = 0;
  for (const f of result.findings) {
    if (f.kind !== "manual" || !DRAFT_RULES.includes(f.rule)) continue;
    let lines = cache.get(f.file);
    if (!lines) {
      try {
        lines = read(f.file).split("\n");
      } catch {
        continue;
      }
      cache.set(f.file, lines);
    }
    const r = statementRange(lines, f.line - 1, f.file);
    const key = `${f.file}:${r.start}`;
    const t = byKey.get(key);
    if (t) {
      if (!t.rules.includes(f.rule)) t.rules.push(f.rule);
      if (!t.lines.includes(f.line)) t.lines.push(f.line);
      continue;
    }
    if (byKey.size >= limit) {
      skipped++;
      continue;
    }
    byKey.set(key, { file: f.file, start: r.start + 1, end: r.end + 1, id: r.id, rules: [f.rule], lines: [f.line], text: lines.slice(r.start, r.end + 1).join("\n").replace(/\r/g, "") });
  }
  return { targets: [...byKey.values()], skipped };
}

/** @param {DraftTarget} t */
export function draftPrompt(t) {
  const kind = /\.xml$/i.test(t.file) ? "MyBatis 매퍼 XML" : /\.java$/i.test(t.file) ? "자바 문자열 SQL" : "SQL 파일";
  return [`${kind} \`${t.file}\` ${t.start}~${t.end}행${t.id ? ` (id=${t.id})` : ""} — 걸린 규칙: ${t.rules.join(", ")}`, "", "```", t.text, "```"].join("\n");
}

/** LLM 답에서 코드 블록과 확인 사항을 꺼낸다 @param {string} answer */
export function parseDraft(answer) {
  const m = answer.match(/```[\w-]*\n([\s\S]*?)```/);
  const notes = answer
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(확인|- 확인|\* 확인)\s*[:：]/.test(l))
    .map((l) => l.replace(/^[-*]?\s*확인\s*[:：]\s*/, ""));
  return { code: m ? /** @type {string} */ (m[1]).replace(/\s+$/, "") : null, notes };
}

/**
 * @param {{ title: string }} r
 * @param {{ target: DraftTarget, code: string | null, notes: string[], error?: string }[]} drafts
 * @param {{ via: string, skipped: number }} meta
 */
export function renderDraftsMarkdown(r, drafts, meta) {
  const ok = drafts.filter((d) => d.code).length;
  const out = [
    `# 현대화 AI 초안 — ${r.title}`,
    "",
    `초안 ${ok}/${drafts.length}건 · ${meta.via}${meta.skipped ? ` · 한도를 넘어 뺀 문장 ${meta.skipped}건(--draft-limit)` : ""}`,
    "",
    "> 초안은 소스에 쓰지 않았습니다. 원문과 비교해 옮기고, 확인 사항을 테스트로 확인한 뒤 `axnavi review` 로 판정하세요.",
    "",
  ];
  for (const d of drafts) {
    const t = d.target;
    const lang = /\.xml$/i.test(t.file) ? "xml" : /\.java$/i.test(t.file) ? "java" : "sql";
    out.push(`## \`${t.file}:${t.start}-${t.end}\`${t.id ? ` · ${t.id}` : ""} — ${t.rules.join(", ")}`, "", "원문", "", "```" + lang, t.text, "```", "");
    if (d.error) out.push(`초안 실패: ${d.error}`, "");
    else if (!d.code) out.push("초안 형식이 맞지 않아 건너뜀 — 수동으로 옮기세요.", "");
    else out.push("초안", "", "```" + lang, d.code, "```", "", ...(d.notes.length ? ["확인할 점", "", ...d.notes.map((n) => `- [ ] ${n}`), ""] : []));
  }
  return out.join("\n");
}
