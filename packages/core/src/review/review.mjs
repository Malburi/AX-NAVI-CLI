/*
 * 헤드리스 변경 리뷰 — `axnavi review`.
 *
 * agents/change-safety.md 의 6개 차원·결정 로직을 LLM 없이 계산한다. CI 머지 요청 게이트에서
 * 같은 diff 에 늘 같은 판정을 내야 하므로 결정론적이어야 한다. 사람이 읽을 근거(어느 줄이 왜)를
 * 함께 남기고, 판정은 종료 코드로 돌려준다 — GO 0, HOLD 3, STOP 4.
 * (2는 bin.mjs 가 사용법 오류에 이미 쓰고 있어 피했다.)
 *
 * 패턴 일치(pattern-conformance)는 LLM 판정이라 여기서 돌리지 않는다. change-safety 의
 * "병렬 합산" 규칙처럼 0점으로 두고 리포트에 그 사실을 적는다.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectDiff, isCodePath, isSchemaPath, isTestPath, readNewContent } from "./diff.mjs";
import { applyRules, RULES, severityRank } from "./rules.mjs";

/** @typedef {import("./diff.mjs").DiffFile} DiffFile */
/** @typedef {import("./rules.mjs").Finding} Finding */

export const EXIT = { GO: 0, HOLD: 3, STOP: 4 };
const HUB_FAN_IN = 20;

/* ------------------------------------------------------------------ 인덱스 */

/** 인덱스 파일 하나 — 없으면 null(없는 것과 0건은 다르다) */
function readIndex(/** @type {string} */ indexDir, /** @type {string} */ name) {
  const path = join(indexDir, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @typedef {{ available: boolean, reason: string, symbols: Array<{ id: string, file: string, type: string, lines: number[], fanIn: number }>,
 *   hubs: Array<{ id: string, fanIn: number }>, fanInTotal: number, entryPoints: string[],
 *   sqls: Array<{ id: string, type: string, tables: string[], file: string, line: number, via: string }>, tables: string[], writeSqls: number,
 *   endpoints: Array<{ method: string, path: string, file: string, line: number }>, missing: string[] }} Impact
 */
/** @type {Omit<Impact, "available" | "reason">} */
const EMPTY_IMPACT = { symbols: [], hubs: [], fanInTotal: 0, entryPoints: [], sqls: [], tables: [], writeSqls: 0, endpoints: [], missing: [] };

const norm = (/** @type {string} */ p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * 바뀐 줄 → 그 줄을 품은 심볼 → 호출자·SQL·테이블·엔드포인트·진입 화면.
 * @param {string} indexDir
 * @param {DiffFile[]} files
 * @returns {Impact}
 */
export function analyzeImpact(indexDir, files) {
  const symbolsIdx = readIndex(indexDir, "symbols");
  if (!symbolsIdx) {
    return { ...EMPTY_IMPACT, available: false, reason: `인덱스 없음(${indexDir}) — axnavi index build 로 만들면 영향 범위가 함께 나온다.` };
  }
  const graph = readIndex(indexDir, "call_graph");
  const sqlIdx = readIndex(indexDir, "sql_usage");
  const api = readIndex(indexDir, "api_contract");

  /** @type {Map<string, Array<{ id: string, line: number, type: string }>>} */
  const symByFile = new Map();
  for (const s of symbolsIdx.symbols ?? []) {
    const f = norm(s.file);
    const arr = symByFile.get(f) ?? [];
    arr.push({ id: s.id, line: Number(s.line ?? 0), type: s.type });
    symByFile.set(f, arr);
  }
  for (const arr of symByFile.values()) arr.sort((a, b) => a.line - b.line);

  /** 줄을 품은 심볼 — 인덱스에는 시작 줄만 있으므로 "그 줄 이전의 마지막 심볼"로 본다 */
  const enclosing = (/** @type {string} */ file, /** @type {number} */ line) => {
    const arr = symByFile.get(file);
    if (!arr) return null;
    let hit = null;
    for (const s of arr) {
      if (s.line <= line) hit = s;
      else break;
    }
    return hit;
  };

  /** @type {Map<string, { id: string, file: string, type: string, lines: number[] }>} */
  const changed = new Map();
  for (const f of files) {
    const path = norm(f.status === "deleted" ? (f.oldPath ?? f.path) : f.path);
    if (f.status === "deleted") {
      for (const s of symByFile.get(path) ?? []) changed.set(s.id, { id: s.id, file: path, type: s.type, lines: [s.line] });
      continue;
    }
    for (const l of [...f.added, ...f.removed]) {
      const s = enclosing(path, l.line);
      if (!s) continue;
      const c = changed.get(s.id) ?? { id: s.id, file: path, type: s.type, lines: [] };
      c.lines.push(l.line);
      changed.set(s.id, c);
    }
  }

  /** @type {Map<string, Set<string>>} */
  const callersOf = new Map();
  for (const e of graph?.edges ?? []) {
    const set = callersOf.get(e.to) ?? new Set();
    set.add(e.from);
    callersOf.set(e.to, set);
  }

  const symbols = [...changed.values()].map((c) => ({ ...c, fanIn: callersOf.get(c.id)?.size ?? 0 }));
  symbols.sort((a, b) => b.fanIn - a.fanIn);

  /* 호출자를 거슬러 올라가 진입점(화면 이벤트·엔드포인트)을 찾는다 — 사람이 테스트할 화면 목록 */
  const entryPoints = new Set();
  const visited = new Set();
  let frontier = symbols.map((s) => s.id);
  for (let depth = 0; depth < 5 && frontier.length && visited.size < 5000; depth += 1) {
    const next = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      for (const from of callersOf.get(id) ?? []) {
        if (/^(trigger|screen|ui|event):/.test(from)) entryPoints.add(from);
        else next.push(from);
      }
    }
    frontier = next;
  }

  /* SQL·테이블 — 바뀐 매퍼 XML 의 문장, 그리고 바뀐 메서드가 부르는 문장 */
  const changedFiles = new Set(files.map((f) => norm(f.path)));
  const changedIds = new Set(symbols.map((s) => s.id));
  const sqlById = new Map((sqlIdx?.sqls ?? []).map((/** @type {any} */ s) => [s.id, s]));
  const sqlHits = new Map();
  for (const f of files) {
    const path = norm(f.path);
    const stmts = (sqlIdx?.sqls ?? []).filter((/** @type {any} */ s) => norm(s.file) === path).sort((/** @type {any} */ a, /** @type {any} */ b) => a.line - b.line);
    if (!stmts.length) continue;
    for (const l of f.added) {
      let hit = null;
      for (const s of stmts) {
        if (s.line <= l.line) hit = s;
        else break;
      }
      if (hit) sqlHits.set(hit.id, { ...hit, via: "변경된 SQL" });
    }
  }
  /*
   * 메서드 심볼이 없는 인덱스도 있다(실측: Struts 레거시는 클래스·JSP 함수 단위만 있었다).
   * 그때는 바뀐 줄과 같은 파일에서 가까운(±30줄) SQL 호출을 영향으로 본다 — 근접 판정임을 표시한다.
   */
  const changedLinesByFile = new Map(files.map((f) => [norm(f.path), [...f.added, ...f.removed].map((l) => l.line)]));
  for (const u of sqlIdx?.usages ?? []) {
    const near = (changedLinesByFile.get(norm(u.file)) ?? []).some((l) => Math.abs(l - Number(u.line)) <= 30);
    if (!changedIds.has(u.method) && !near) continue;
    const s = sqlById.get(u.sql_id);
    if (s && !sqlHits.has(s.id)) sqlHits.set(s.id, { ...s, via: changedIds.has(u.method) ? `호출: ${u.method}` : `근접 호출: ${u.file}:${u.line}` });
  }
  const sqls = [...sqlHits.values()].map((s) => ({ id: s.id, type: s.type, tables: s.tables ?? [], file: s.file, line: s.line, via: s.via }));
  const tables = [...new Set(sqls.flatMap((s) => s.tables))].sort();
  const writes = sqls.filter((s) => /insert|update|delete|merge/i.test(String(s.type)));

  /* 엔드포인트 — 바뀐 파일에 선언됐거나, 바뀐 클래스로 디스패치되는 것 */
  const changedClasses = new Set(symbols.map((s) => s.id.replace(/\.[^.]+$/, "")));
  const endpoints = (api?.endpoints ?? [])
    .filter((/** @type {any} */ e) => changedFiles.has(norm(e.file)) || changedClasses.has(e.dispatch_class) || changedClasses.has(e.handler))
    .map((/** @type {any} */ e) => ({ method: e.method, path: e.path, file: e.file, line: e.line }));

  return {
    available: true,
    reason: "",
    symbols,
    hubs: symbols.filter((s) => s.fanIn >= HUB_FAN_IN),
    fanInTotal: symbols.reduce((a, s) => a + s.fanIn, 0),
    entryPoints: [...entryPoints].sort(),
    sqls,
    tables,
    writeSqls: writes.length,
    endpoints,
    missing: /** @type {string[]} */ ([!graph && "call_graph", !sqlIdx && "sql_usage", !api && "api_contract"].filter(Boolean)),
  };
}

/* ------------------------------------------------------------------ 규칙 */

/**
 * @param {DiffFile[]} files
 * @param {(path: string) => string[] | null} [contentOf]  새 쪽 파일 전체(뒤 줄을 보는 규칙용). 없으면 diff 줄만 본다.
 */
export function findChanges(files, contentOf) {
  /** @type {Finding[]} */
  const all = [];
  for (const f of files) {
    if (f.binary) continue;
    const fileLines = f.added.length && contentOf ? contentOf(f.path) : null;
    const added = applyRules(f.path, f.added, { side: "added", fileLines });
    const removed = applyRules(f.oldPath ?? f.path, f.removed, { side: "removed" });
    // 인가 검사를 지운 줄과 같은 검사를 같은 파일에 다시 넣었으면 옮긴 것이다 — 제거로 보지 않는다
    const addedText = f.added.map((l) => l.text).join("\n");
    const moved = removed.filter((x) => {
      const token = /@\w+|\b\w+\s*\(/.exec(x.snippet)?.[0]?.replace(/\s*\($/, "");
      return !(token && addedText.includes(token));
    });
    all.push(...added, ...moved);
  }
  return all;
}

/* ------------------------------------------------------------------ 점수 */

/**
 * @param {{ files: DiffFile[], findings: Finding[], impact: Impact, verification: { status: "passed" | "failed" | "unverified" | "none", detail: string } }} input
 */
export function score({ files, findings, impact, verification }) {
  const active = findings.filter((f) => !f.suppressed);
  const linesChanged = files.reduce((a, f) => a + f.added.length + f.removed.length, 0);
  const codeFiles = files.filter((f) => isCodePath(f.path) && !isTestPath(f.path));
  const testFiles = files.filter((f) => isTestPath(f.path));
  const fanIn = impact.available ? impact.fanInTotal : 0;

  /* 1. 회귀 위험 — 변경 규모 + 호출자 수 */
  let regression = linesChanged <= 20 ? 1 : linesChanged <= 100 ? 3 : linesChanged <= 300 ? 5 : linesChanged <= 1000 ? 7 : 9;
  if (files.length > 10) regression += 1;
  if (fanIn > HUB_FAN_IN) regression += 2;
  else if (fanIn > 5) regression += 1;
  regression = Math.min(10, regression);

  /* 2. 컨벤션 — 헤드리스에서는 판정하지 않는다(병렬 합산 규칙) */
  const convention = 0;

  /* 3. 사이드 이펙트 — 도입된 항목별 가중치 합 */
  const weightOf = (/** @type {string} */ id) => RULES.find((r) => r.id === id)?.weight ?? 0;
  const sideIds = [...new Set(active.filter((f) => f.dimension === "side_effect").map((f) => f.rule))];
  const sideEffect = Math.min(10, sideIds.reduce((a, id) => a + weightOf(id), 0));

  /* 4. 롤백 — 스키마 변경 6, 데이터 손실 10 */
  const rb = active.filter((f) => f.dimension === "rollback");
  const rollback = rb.some((f) => f.stop) ? 10 : rb.length ? Math.max(...rb.map((f) => weightOf(f.rule) || 4)) : 0;

  /* 5. 보안 — 가장 심각한 것 + 여러 건이면 1점 */
  const sec = active.filter((f) => f.dimension === "security");
  const top = Math.max(0, ...sec.map((f) => severityRank(f.severity)));
  let security = [0, 2, 5, 7, 10][top] ?? 0;
  if (sec.filter((f) => severityRank(f.severity) >= 2).length >= 3) security = Math.min(10, security + 1);

  /* 6. 테스트 적정성 — 코드를 바꿨는데 테스트를 안 바꿨으면 높다 */
  let test = 0;
  if (codeFiles.length) test = testFiles.length ? 2 : fanIn > 0 ? 7 : 6;

  const composite = Math.round(((regression + convention + sideEffect + rollback + security * 2 + test) / 7) * 10) / 10;

  /* 결정 — change-safety.md 결정 로직 + 하드 게이트 */
  /** @type {string[]} */
  const reasons = [];
  const stops = active.filter((f) => f.stop);
  let verdict = "GO";
  if (stops.length) reasons.push(`즉시 STOP 트리거 ${stops.length}건: ${[...new Set(stops.map((f) => f.title))].join(", ")}`);
  if (verification.status === "failed") reasons.push(`필수 검증 실패 — ${verification.detail}`);
  if (composite > 6) reasons.push(`종합 위험도 ${composite} > 6`);
  if (security >= 8 && !stops.length) reasons.push(`보안 점수 ${security} ≥ 8`);
  if (reasons.length) verdict = "STOP";
  else {
    if (composite >= 3) reasons.push(`종합 위험도 ${composite} (3~6)`);
    if (security >= 5) reasons.push(`보안 점수 ${security} (5~7)`);
    const sensitive = [
      rollback > 0 && "DB 스키마",
      sideIds.includes("SE-TX") && "트랜잭션",
      sec.some((f) => f.owasp === "A01:2021") && "인증·인가",
      impact.available && impact.hubs.length > 0 && `공통 모듈(호출자 ${HUB_FAN_IN}곳 이상)`,
    ].filter(Boolean);
    if (verification.status === "unverified" && codeFiles.length) {
      reasons.push("실행 검증 증거 없음(UNVERIFIED) — 테스트·빌드 결과를 --verify 또는 --tests-passed 로 넘긴다");
    }
    if (sensitive.length && verification.status !== "passed") reasons.push(`민감 변경(${sensitive.join("·")})인데 검증 통과 근거 없음`);
    if (reasons.length) verdict = "HOLD";
  }
  if (verdict === "GO") reasons.push(`종합 위험도 ${composite} < 3, 보안 점수 ${security} < 5${verification.status === "passed" ? ", 검증 통과" : ""}`);

  return {
    verdict: /** @type {"GO" | "HOLD" | "STOP"} */ (verdict),
    exitCode: EXIT[/** @type {"GO" | "HOLD" | "STOP"} */ (verdict)],
    composite,
    scores: { regression, convention, sideEffect, rollback, security, test },
    reasons,
    stats: { files: files.length, linesAdded: files.reduce((a, f) => a + f.added.length, 0), linesRemoved: files.reduce((a, f) => a + f.removed.length, 0), codeFiles: codeFiles.length, testFiles: testFiles.length, schemaFiles: files.filter((f) => isSchemaPath(f.path)).length },
    sideEffects: sideIds,
  };
}

/* ------------------------------------------------------------------ 실행 */

/**
 * @param {{ root: string, indexDir: string, range?: string, staged?: boolean, verify?: string, testsPassed?: boolean, files?: DiffFile[] }} opts
 */
export function runReview(opts) {
  const files = opts.files ?? collectDiff(opts.root, { ...(opts.range ? { range: opts.range } : {}), ...(opts.staged ? { staged: true } : {}) });
  const target = { ...(opts.range ? { range: opts.range } : {}), ...(opts.staged ? { staged: true } : {}) };
  const findings = findChanges(files, opts.files ? undefined : (path) => readNewContent(opts.root, target, path));
  const impact = analyzeImpact(opts.indexDir, files);

  /** @type {{ status: "passed" | "failed" | "unverified" | "none", detail: string, output?: string }} */
  let verification = { status: "unverified", detail: "실행한 검증 명령 없음" };
  if (!files.some((f) => isCodePath(f.path))) verification = { status: "none", detail: "동작에 영향을 주는 파일 변경 없음" };
  if (opts.testsPassed) verification = { status: "passed", detail: "CI 테스트 단계 통과(--tests-passed)" };
  if (opts.verify) {
    try {
      const out = execSync(opts.verify, { cwd: opts.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      verification = { status: "passed", detail: `\`${opts.verify}\` exit 0`, output: tail(out) };
    } catch (error) {
      const e = /** @type {any} */ (error);
      verification = { status: "failed", detail: `\`${opts.verify}\` exit ${e.status ?? "?"}`, output: tail(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
    }
  }

  const result = score({ files, findings, impact, verification });
  return {
    target: opts.range ?? (opts.staged ? "staged" : "HEAD 대비 작업 트리"),
    generatedAt: new Date().toISOString(),
    ...result,
    verification,
    findings: findings.filter((f) => !f.suppressed).sort((a, b) => Number(b.stop) - Number(a.stop) || severityRank(b.severity) - severityRank(a.severity)),
    suppressed: findings.filter((f) => f.suppressed),
    impact,
    files: files.map((f) => ({ path: f.path, status: f.status, added: f.added.length, removed: f.removed.length, test: isTestPath(f.path) })),
  };
}

const tail = (/** @type {string} */ s) => s.trim().split(/\r?\n/).slice(-20).join("\n");

/* ------------------------------------------------------------------ 리포트 */

const SEV_KO = { critical: "치명", high: "높음", medium: "중간", low: "낮음" };
const VERDICT_KO = { GO: "GO — 진행 가능", HOLD: "HOLD — 보완 후 재평가", STOP: "STOP — 철회·재설계" };
const cell = (/** @type {unknown} */ v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** @param {ReturnType<typeof runReview>} r */
export function renderMarkdown(r) {
  const s = r.scores;
  const L = [];
  L.push("=== AX-NAVI CHANGE REVIEW ===", "");
  L.push(`평가 시각: ${r.generatedAt.replace("T", " ").slice(0, 16)} (UTC)`);
  L.push(`변경 대상: ${r.target}`);
  L.push(`변경 라인 수: +${r.stats.linesAdded} / -${r.stats.linesRemoved} · 변경 파일 수: ${r.stats.files} (코드 ${r.stats.codeFiles}, 테스트 ${r.stats.testFiles}, 스키마 ${r.stats.schemaFiles})`);
  L.push(`입력 패턴 판정: 헤드리스 미평가 — 병렬 합산(PR 전 pattern-conformance 로 보완)`);
  L.push(`실행 검증: ${r.verification.detail}${r.verification.status === "unverified" ? " (UNVERIFIED)" : ""}`);
  L.push(`영향 범위: ${r.impact.available ? `인덱스 기준 — 심볼 ${r.impact.symbols.length}개, 호출자 합 ${r.impact.fanInTotal}` : r.impact.reason}`);
  L.push("", "## 결정: " + VERDICT_KO[r.verdict], "");
  for (const reason of r.reasons) L.push(`- ${reason}`);
  L.push("", "## 차원별 점수", "", "| 차원 | 점수 (0~10) | 근거 |", "|------|------|------|");
  L.push(`| 회귀 위험 | ${s.regression} | 변경 ${r.stats.linesAdded + r.stats.linesRemoved}줄 · 파일 ${r.stats.files}개 · 호출자 ${r.impact.available ? r.impact.fanInTotal : "?"} |`);
  L.push(`| 컨벤션 일치 | ${s.convention} | 헤드리스 미평가(병렬 합산) |`);
  L.push(`| 사이드 이펙트 | ${s.sideEffect} | ${r.sideEffects.length ? r.sideEffects.join(", ") : "없음"} |`);
  L.push(`| 롤백 가능성 | ${s.rollback} | ${s.rollback >= 10 ? "데이터 손실 가능" : s.rollback > 0 ? "DB 스키마 변경 포함" : "코드만 변경"} |`);
  L.push(`| 보안 영향 | ${s.security} | ${r.findings.filter((f) => f.dimension === "security").length}건 |`);
  L.push(`| 테스트 적정성 | ${s.test} | 테스트 파일 변경 ${r.stats.testFiles}개 |`);
  L.push("", `종합 위험도: ${r.composite} / 10  (= (회귀 + 컨벤션 + 사이드이펙트 + 롤백 + 보안×2 + 테스트) / 7)`);

  const stops = r.findings.filter((f) => f.stop);
  L.push("", "## 즉시 STOP 트리거", "");
  if (!stops.length) L.push("- 없음");
  for (const f of stops) L.push(`- **${f.title}** — \`${f.file}:${f.line}\` ${f.side === "removed" ? "(삭제된 줄)" : ""}`);

  L.push("", "## Findings", "");
  if (!r.findings.length) L.push("- 없음");
  else {
    L.push("| 심각도 | 규칙 | 위치 | 내용 | 영향 | 조치 |", "|---|---|---|---|---|---|");
    for (const f of r.findings) {
      L.push(`| ${SEV_KO[f.severity]}${f.stop ? " ⛔" : ""} | ${f.rule}${f.owasp ? `<br>${f.owasp}` : ""}${f.cwe ? ` ${f.cwe}` : ""} | \`${cell(f.file)}:${f.line}\`${f.side === "removed" ? " (삭제)" : ""} | ${cell(f.title)}: \`${cell(f.snippet)}\` | ${cell(f.impact)} | ${cell(f.fix)} |`);
    }
  }

  if (r.impact.available) {
    const im = r.impact;
    L.push("", "## 영향 범위(인덱스)", "");
    L.push(`- 바뀐 심볼 ${im.symbols.length}개${im.hubs.length ? ` — 공통 모듈 ${im.hubs.length}개: ${im.hubs.slice(0, 5).map((h) => `\`${h.id}\`(호출자 ${h.fanIn})`).join(", ")}` : ""}`);
    for (const sym of im.symbols.slice(0, 10)) L.push(`  - \`${sym.id}\` — 호출자 ${sym.fanIn}`);
    if (im.symbols.length > 10) L.push(`  - … 외 ${im.symbols.length - 10}개`);
    L.push(`- 관련 테이블 ${im.tables.length}개${im.tables.length ? `: ${im.tables.slice(0, 15).join(", ")}${im.tables.length > 15 ? " …" : ""}` : ""} (쓰기 SQL ${im.writeSqls}건)`);
    L.push(`- 엔드포인트 ${im.endpoints.length}개${im.endpoints.length ? `: ${im.endpoints.slice(0, 8).map((e) => `${e.method} ${e.path}`).join(", ")}` : ""}`);
    L.push(`- 거슬러 올라간 진입점(화면 이벤트) ${im.entryPoints.length}개${im.entryPoints.length ? ` — 회귀 확인 대상: ${im.entryPoints.slice(0, 8).join(", ")}${im.entryPoints.length > 8 ? " …" : ""}` : ""}`);
    if (im.missing.length) L.push(`- 없는 인덱스: ${im.missing.join(", ")}`);
  }

  if (r.suppressed.length) {
    L.push("", "## 억제된 항목(axnavi:allow)", "");
    for (const f of r.suppressed) L.push(`- ${f.rule} \`${f.file}:${f.line}\` — 사유: ${f.suppressed}`);
  }

  const after = [];
  if (r.sideEffects.includes("SE-EXTERNAL")) after.push("외부 연동 응답 시간·오류율");
  if (r.sideEffects.includes("SE-ASYNC")) after.push("배치·비동기 작업 실행 로그");
  if (r.sideEffects.includes("SE-ENV-BRANCH")) after.push("운영 환경 분기 동작");
  if (after.length) L.push("", `배포 후 확인 권장(GO 조건 아님): ${after.join(", ")}`);
  if (r.verification.output) L.push("", "<details><summary>검증 명령 출력(끝 20줄)</summary>", "", "```", r.verification.output, "```", "</details>");
  return L.join("\n") + "\n";
}
