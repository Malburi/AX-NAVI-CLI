/*
 * 커버리지 — `axnavi coverage`.
 *
 * 빌드가 이미 만든 보고서를 읽는다(측정 도구를 새로 붙이지 않는다): JaCoCo XML(Maven·Gradle), lcov(JS/TS·기타).
 * 전체 줄 커버리지와 함께, --diff 를 주면 '이번에 바뀐 줄'의 커버리지를 따로 잰다 — 레거시 전체 수치는 낮아도
 * 새로 고친 줄은 테스트로 덮였는지가 유지보수 품질의 기준이다. 기준(--min) 미달이면 HOLD.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { collectDiff, isCodePath, isTestPath } from "../review/diff.mjs";
import { EXIT } from "../review/review.mjs";

/** @typedef {Map<string, Map<number, boolean>>} LineMap 파일(저장소 기준 상대 경로 끝부분) → 줄 → 덮였나 */

/** JaCoCo XML — <package name="a/b"><sourcefile name="X.java"><line nr="1" mi="0" ci="3" …/> */
export function parseJacoco(/** @type {string} */ xml) {
  /** @type {LineMap} */
  const out = new Map();
  const pkgRe = /<package\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  for (const pm of xml.matchAll(pkgRe)) {
    const pkg = pm[1] ?? "";
    for (const sm of (pm[2] ?? "").matchAll(/<sourcefile\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g)) {
      const lines = new Map();
      for (const lm of (sm[2] ?? "").matchAll(/<line\s+nr="(\d+)"\s+mi="(\d+)"\s+ci="(\d+)"/g)) lines.set(Number(lm[1]), Number(lm[3]) > 0);
      out.set(`${pkg ? `${pkg}/` : ""}${sm[1]}`, lines);
    }
  }
  return out;
}

/** lcov — SF:경로 / DA:줄,횟수 / end_of_record */
export function parseLcov(/** @type {string} */ text, /** @type {string} */ root = "") {
  /** @type {LineMap} */
  const out = new Map();
  /** @type {Map<number, boolean> | null} */
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      let p = line.slice(3).trim().replace(/\\/g, "/");
      if (root && p.toLowerCase().startsWith(root.replace(/\\/g, "/").toLowerCase())) p = p.slice(root.length).replace(/^\/+/, "");
      cur = new Map();
      out.set(p, cur);
    } else if (line.startsWith("DA:") && cur) {
      const [n, hits] = line.slice(3).split(",");
      cur.set(Number(n), Number(hits) > 0);
    } else if (line === "end_of_record") cur = null;
  }
  return out;
}

/** 흔한 위치에서 보고서 찾기 */
export function findCoverageReports(/** @type {string} */ root) {
  /** @type {{ kind: "jacoco" | "lcov", path: string }[]} */
  const found = [];
  const candidates = [
    ["jacoco", "target/site/jacoco/jacoco.xml"],
    ["jacoco", "build/reports/jacoco/test/jacocoTestReport.xml"],
    ["lcov", "coverage/lcov.info"],
  ];
  for (const [kind, p] of candidates) if (existsSync(join(root, /** @type {string} */ (p)))) found.push({ kind: /** @type {"jacoco" | "lcov"} */ (kind), path: join(root, /** @type {string} */ (p)) });
  // 다중 모듈 — 한 단계 아래 모듈의 같은 위치
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "node_modules") continue;
      for (const [kind, p] of candidates) {
        const f = join(root, d.name, /** @type {string} */ (p));
        if (existsSync(f)) found.push({ kind: /** @type {"jacoco" | "lcov"} */ (kind), path: f });
      }
    }
  } catch {
    /* 읽을 수 없는 폴더는 건너뜀 */
  }
  return found;
}

/** 저장소 경로 ↔ 보고서 키 — JaCoCo 는 패키지 경로(com/x/A.java)만 있어 '끝부분 일치'로 잇는다 */
function lookup(/** @type {LineMap} */ map, /** @type {string} */ repoPath) {
  const p = repoPath.replace(/\\/g, "/");
  if (map.has(p)) return map.get(p);
  for (const [k, v] of map) if (p.endsWith(`/${k}`) || k.endsWith(`/${p}`)) return v;
  return undefined;
}

/**
 * @param {{ root: string, reports?: { kind: "jacoco" | "lcov", path: string }[], diff?: { range?: string, staged?: boolean } | null, min?: number }} opts
 */
export function runCoverage(opts) {
  const reports = opts.reports?.length ? opts.reports : findCoverageReports(opts.root);
  if (!reports.length) throw new Error("커버리지 보고서를 찾지 못했습니다 — JaCoCo(target/site/jacoco/jacoco.xml) 또는 lcov(coverage/lcov.info)를 먼저 만들거나 --jacoco·--lcov 로 알려 주세요.");
  /** @type {LineMap} */
  const all = new Map();
  for (const r of reports) {
    const text = readFileSync(r.path, "utf8");
    const m = r.kind === "jacoco" ? parseJacoco(text) : parseLcov(text, opts.root);
    for (const [k, v] of m) {
      const prev = all.get(k);
      if (!prev) all.set(k, v);
      else for (const [n, c] of v) prev.set(n, Boolean(prev.get(n)) || c);
    }
  }
  let total = 0;
  let covered = 0;
  const files = [];
  for (const [k, v] of all) {
    const c = [...v.values()].filter(Boolean).length;
    total += v.size;
    covered += c;
    files.push({ file: k, lines: v.size, covered: c, rate: v.size ? c / v.size : 1 });
  }
  files.sort((a, b) => a.rate - b.rate || b.lines - a.lines);

  /** @type {null | { target: string, lines: number, covered: number, rate: number | null, files: { file: string, lines: number, covered: number, uncovered: number[] }[], unmeasured: string[] }} */
  let diff = null;
  if (opts.diff) {
    const changed = collectDiff(opts.root, opts.diff).filter((f) => f.status !== "deleted" && isCodePath(f.path) && !isTestPath(f.path));
    /** @type {{ file: string, lines: number, covered: number, uncovered: number[] }[]} */
    const dfiles = [];
    /** @type {string[]} */
    const unmeasured = [];
    let dl = 0;
    let dc = 0;
    for (const f of changed) {
      const lines = lookup(all, f.path);
      if (!lines) {
        unmeasured.push(f.path);
        continue;
      }
      // 실행 가능한 줄(보고서에 있는 줄)만 센다 — 빈 줄·주석·선언은 빠진다
      const exec = f.added.map((a) => a.line).filter((n) => lines.has(n));
      if (!exec.length) continue;
      const cov = exec.filter((n) => lines.get(n));
      dl += exec.length;
      dc += cov.length;
      dfiles.push({ file: f.path, lines: exec.length, covered: cov.length, uncovered: exec.filter((n) => !lines.get(n)) });
    }
    diff = { target: opts.diff.range ?? (opts.diff.staged ? "staged" : "HEAD 대비 작업 트리"), lines: dl, covered: dc, rate: dl ? dc / dl : null, files: dfiles, unmeasured };
  }
  const min = opts.min ?? null;
  const judged = diff ? diff.rate : total ? covered / total : null;
  /** @type {"GO" | "HOLD"} */
  const verdict = min !== null && judged !== null && judged * 100 < min ? "HOLD" : "GO";
  return { root: relative(process.cwd(), opts.root) || ".", reports: reports.map((r) => ({ kind: r.kind, path: r.path, mtime: statSync(r.path).mtime.toISOString() })), total: { lines: total, covered, rate: total ? covered / total : null }, files, diff, min, verdict, exitCode: EXIT[verdict] };
}

/** @param {ReturnType<typeof runCoverage>} r */
export function renderCoverageMarkdown(r, { limit = 50 } = {}) {
  const pct = (/** @type {number | null} */ v) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
  const lines = [
    "# 커버리지",
    "",
    `판정: **${r.verdict === "GO" ? "🟢 GO" : "🟡 HOLD"}**${r.min !== null ? ` (기준 ${r.min}% — ${r.diff ? "바뀐 줄" : "전체"})` : ""}`,
    "",
    `- 전체 줄: ${pct(r.total.rate)} (${r.total.covered}/${r.total.lines})`,
  ];
  if (r.diff) {
    lines.push(`- 바뀐 줄(${r.diff.target}): **${pct(r.diff.rate)}** (${r.diff.covered}/${r.diff.lines})`);
    if (r.diff.unmeasured.length) lines.push(`- 보고서에 없는 바뀐 파일 ${r.diff.unmeasured.length}개 — 테스트가 한 번도 실행하지 않았거나 측정 범위 밖: ${r.diff.unmeasured.slice(0, 10).join(", ")}`);
    const holes = r.diff.files.filter((f) => f.uncovered.length);
    if (holes.length) {
      lines.push("", "## 테스트가 닿지 않은 바뀐 줄", "");
      for (const f of holes) lines.push(`- \`${f.file}\` ${f.covered}/${f.lines} — 줄 ${f.uncovered.slice(0, 30).join(", ")}${f.uncovered.length > 30 ? " …" : ""}`);
    }
  }
  lines.push("", `## 커버리지 낮은 파일 (상위 ${Math.min(limit, r.files.length)})`, "", "| 파일 | 줄 | 덮임 | 비율 |", "|---|---|---|---|");
  for (const f of r.files.slice(0, limit)) lines.push(`| ${f.file} | ${f.lines} | ${f.covered} | ${pct(f.rate)} |`);
  lines.push("", `보고서: ${r.reports.map((x) => `${x.kind} ${x.path} (${x.mtime.slice(0, 16)})`).join(" · ")}`, "");
  return lines.join("\n");
}
