/*
 * 사전 영향도 — 영향도 · 수정 요청이면 런타임이 인덱스로 먼저 계산해 프롬프트에 넣는다.
 *
 * 실측(실제 레거시 벤치 R1): axnavi 가 24곳을 다 찾기는 했지만 모델이 grep 으로 하나씩 훑느라 4분 · $0.74 가
 * 들었다. 같은 사실은 인덱스에 있다(query-index impact, 0.4초 · 0원). 모델은 그 결과를 검증 · 보완만 하면 된다.
 *
 * 요청에서 대상을 뽑는 것은 보수적이다 — 인덱스에 실제로 있는 SQL id · 메서드 이름만 쓰고, 컬럼은 그 SQL 의
 * SELECT 목록에 있는 이름만 쓴다. 아무것도 못 찾으면 아무것도 넣지 않는다(빈 블록으로 모델을 헷갈리게 하지 않는다).
 */
import { COMMANDS } from "../../indexer/index.mjs";

/** 사전 영향도를 붙이는 스킬. 영향도 · 수정 절차다. */
export const PRECOMPUTE_SKILLS = new Set(["analyze-impact", "safe-modify", "cross-repo-modify", "vibe", "scaffold-feature"]);

const MAX_ROWS = 40;

/**
 * @param {string} request
 * @returns {{ sqlLike: string[], idLike: string[], upper: string[] }}
 */
export function candidateTokens(request) {
  const text = String(request);
  const sqlLike = [...new Set(text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+){2,}\b/g) ?? [])].filter((t) => /_/.test(t));
  const idLike = [...new Set(text.match(/\b(?:[A-Z]\w*\.)?[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*){2,}\b/g) ?? [])].filter((t) => t.length >= 8);
  const upper = [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
  return { sqlLike, idLike, upper };
}

/** @param {string} effect @param {string | undefined} now @param {string | undefined} after */
const describeEffect = (effect, now, after) => {
  const short = (/** @type {string | undefined} */ s) => (s && s.length > 24 ? `${s.slice(0, 22)}…` : s ?? "?");
  if (effect === "shifted" || effect === "reads_removed") return `${short(now)}→${short(after)}`;
  return "";
};

/**
 * @param {any} result  COMMANDS.impact 결과
 * @returns {string}
 */
export function formatImpact(result) {
  const s = result.summary;
  const target = [
    result.query.sql ? `SQL ${result.query.sql}` : "",
    result.query.id ? `메서드 ${result.query.id}` : "",
    result.column ? `컬럼 ${result.column.name}${result.column.index !== null ? `(${result.column.index}번째)` : "(SELECT 목록에서 못 찾음)"}` : "",
  ].filter(Boolean).join(" · ");
  const lines = [
    `<사전 영향도 — 인덱스로 계산(모델 호출 없음)>`,
    `대상: ${target}`,
    `저장소: ${s.repos.join(", ")} · 실행 메서드 ${s.methods} · 코드 호출자 ${s.code_callers} · 화면 호출 ${s.screen_call_sites}곳(${s.screen_files}파일)` +
      (s.breaks_if_column_removed !== null ? ` · 컬럼을 빼면 깨지는 곳 ${s.breaks_if_column_removed}` : "") +
      (s.reads_by_position ? ` · 결과를 위치로 읽는 곳 ${s.reads_by_position}` : ""),
  ];
  for (const sql of result.sql ?? []) lines.push(`SQL ${sql.repo}/${sql.file}:${sql.line} SELECT [${(sql.columns ?? []).join(" | ")}]`);
  for (const m of result.methods ?? []) lines.push(`메서드 ${m.repo}/${m.file}:${m.line} ${m.id}${m.result_keys?.length ? ` → 결과 이름 ${m.result_keys.join(", ")}` : ""}`);
  for (const c of (result.code_callers?.items ?? []).slice(0, 10)) lines.push(`- [코드] ${c.repo}/${c.file}:${c.line} ${c.from}`);
  const label = { breaks: "깨짐", reads_by_position: "위치로 읽음", reads_by_name: "이름으로 읽음", unaffected: "영향 없음", no_reads_found: "읽기 못 찾음" };
  const screens = result.screen_callers?.items ?? [];
  for (const c of screens.slice(0, MAX_ROWS)) {
    const reads = [...new Map((c.reads ?? []).map((/** @type {any} */ r) => [r.text, r])).values()].slice(0, 4).map((/** @type {any} */ r) => `${r.text}${r.effect ? `(${describeEffect(r.effect, r.now, r.after)})` : ""}`).join(", ");
    lines.push(`- [${label[/** @type {keyof typeof label} */ (c.verdict)] ?? c.verdict}] ${c.repo}/${c.file}:${c.line} ${c.callback ?? ""}${reads ? ` — ${reads}` : ""}`);
  }
  if (screens.length > MAX_ROWS || (result.screen_callers?.truncated ?? 0) > 0) lines.push(`… 화면 호출 전체 ${result.screen_callers.total}곳 — QueryIndex impact 로 나머지를 본다.`);
  for (const note of result.notes ?? []) lines.push(`※ ${note}`);
  lines.push(`</사전 영향도>`);
  return lines.join("\n");
}

/**
 * 요청에서 대상을 찾아 영향도를 계산한다. 못 찾으면 null.
 * @param {string} root
 * @param {string} request
 * @param {string} [indexDir]
 * @returns {string | null}
 */
export function precomputeImpact(root, request, indexDir) {
  const { sqlLike, idLike, upper } = candidateTokens(request);
  /** @type {string[]} */
  const blocks = [];
  const tried = new Set();
  try {
    for (const sql of sqlLike) {
      const probe = /** @type {any} */ (COMMANDS.impact({ root, ...(indexDir ? { indexDir } : {}), sql, limit: 200 }));
      if (!probe.sql.length && !probe.summary.methods) continue;
      const columns = (probe.sql[0]?.columns ?? []).map((/** @type {string} */ c) => c.replace(/^\d+: /, "").toUpperCase());
      const column = upper.find((u) => u !== sql && columns.includes(u.toUpperCase()));
      const result = column ? COMMANDS.impact({ root, ...(indexDir ? { indexDir } : {}), sql, column, limit: 200 }) : probe;
      blocks.push(formatImpact(result));
      tried.add(sql);
      if (blocks.length >= 2) break;
    }
    if (!blocks.length) {
      for (const id of idLike) {
        const result = /** @type {any} */ (COMMANDS.impact({ root, ...(indexDir ? { indexDir } : {}), id: id.split(".").slice(-2).join("."), limit: 200 }));
        if (!result.summary.methods) continue;
        /* 메서드로 물었어도 컬럼을 짚었으면 그 메서드가 실행하는 SQL 의 컬럼 위치로 다시 계산한다("…결과의 X 컬럼을 빼줘"). */
        let detailed = null;
        for (const sql of result.methods.flatMap((/** @type {any} */ m) => m.runs_sql ?? [])) {
          const probe = /** @type {any} */ (COMMANDS.impact({ root, ...(indexDir ? { indexDir } : {}), sql, limit: 1 }));
          const columns = (probe.sql[0]?.columns ?? []).map((/** @type {string} */ c) => c.replace(/^\d+: /, "").toUpperCase());
          const column = upper.find((u) => columns.includes(u.toUpperCase()));
          if (column) { detailed = COMMANDS.impact({ root, ...(indexDir ? { indexDir } : {}), sql, column, limit: 200 }); break; }
        }
        blocks.push(formatImpact(detailed ?? result));
        if (blocks.length >= 2) break;
      }
    }
  } catch {
    return null; // 인덱스가 없거나 깨졌다 — 사전 계산 없이 진행한다
  }
  return blocks.length ? blocks.join("\n\n") : null;
}
