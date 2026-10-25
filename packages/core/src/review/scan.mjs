/*
 * 저장소 전수 보안 점검 — `axnavi scan security`.
 *
 * review 가 "이번에 바뀐 줄"을 본다면, 여기서는 지금 있는 코드 전체를 같은 규칙으로 훑는다.
 * 인수인계·정기 점검 때 "현재 보안 부채가 얼마나 있나"를 숫자로 보이기 위한 것이다.
 * 결과 형식은 security-scan 스킬과 /review 가 그대로 받아 쓰도록 정규화한다:
 * 심각도 · 위치 · 원인(규칙) · 영향 · 조치 + OWASP/CWE.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { applyRules, severityRank } from "./rules.mjs";

/** @typedef {import("./rules.mjs").Finding} Finding */

const SKIP_DIRS = new Set([".git", "node_modules", "_workspace", ".axnavi", ".claude", "target", "build", "dist", "out", "bin", "obj", ".gradle", ".idea", ".vscode", "vendor", "__pycache__", ".venv", "venv", "coverage"]);
const MAX_FILE = 1024 * 1024;
const TEXT_EXT = /\.(java|kt|kts|scala|groovy|cs|vb|py|go|rb|php|[cm]?[jt]sx?|vue|jsp|jspf|xml|sql|ddl|properties|ya?ml|json|env|conf|config|ini|xfdl|xjs|pc|pkb|pks|prc|fnc|trg|html?)$/i;
/** 압축된 번들·외부 라이브러리 — 우리 코드가 아니라 점검 대상이 아니다 */
const VENDOR_FILE = /\.min\.(js|css)$|(^|\/)(jquery|bootstrap|lodash|vis-network|moment)[^/]*\.js$/i;

/** git 이 추적하는 파일만 — .gitignore 를 존중한다. git 이 아니면 디렉터리를 걷는다. */
export function listSourceFiles(/** @type {string} */ root) {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter((p) => p && TEXT_EXT.test(p) && !VENDOR_FILE.test(p) && !p.split("/").some((seg) => SKIP_DIRS.has(seg)));
  } catch {
    /** @type {string[]} */
    const files = [];
    const walk = (/** @type {string} */ dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name));
        } else if (TEXT_EXT.test(ent.name)) {
          const rel = relative(root, join(dir, ent.name)).replace(/\\/g, "/");
          if (!VENDOR_FILE.test(rel)) files.push(rel);
        }
      }
    };
    walk(root);
    return files;
  }
}

/**
 * @param {{ root: string, paths?: string[] }} opts
 */
export function runSecurityScan(opts) {
  // 폴더를 주면 그 아래 소스 파일로 펼친다 — 예전에는 EISDIR 로 '건너뜀' 처리되어 0건으로 보고됐다(10/25 리뷰)
  const files = opts.paths?.length
    ? opts.paths.flatMap((p) => {
        const abs = join(opts.root, p);
        try {
          if (statSync(abs).isDirectory()) return listSourceFiles(abs).map((r) => `${p.replace(/[\\/]+$/, "")}/${r}`);
        } catch {
          /* 없는 경로는 아래에서 건너뜀으로 센다 */
        }
        return [p];
      })
    : listSourceFiles(opts.root);
  /** @type {Finding[]} */
  const findings = [];
  let scanned = 0;
  let skipped = 0;
  for (const rel of files) {
    const abs = join(opts.root, rel);
    let text;
    try {
      if (statSync(abs).size > MAX_FILE) {
        skipped += 1;
        continue;
      }
      text = readFileSync(abs, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const lines = text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t }));
    // 전수 점검은 보안 규칙만 본다 — 부작용·롤백은 "이번 변경"에서만 의미가 있다
    findings.push(...applyRules(rel, lines, { side: "current" }).filter((f) => f.dimension === "security" || f.rule === "SEC-DATA-LOSS" || f.rule === "SEC-DELETE-ALL"));
  }
  const active = findings.filter((f) => !f.suppressed).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  /** @type {Record<string, number>} */
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of active) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  /** @type {Record<string, { count: number, rules: Set<string> }>} */
  const byOwasp = {};
  for (const f of active) {
    const k = f.owasp ?? "기타";
    byOwasp[k] ??= { count: 0, rules: new Set() };
    byOwasp[k].count += 1;
    byOwasp[k].rules.add(f.rule);
  }
  return {
    generatedAt: new Date().toISOString(),
    root: opts.root,
    scanned,
    skipped,
    bySeverity,
    byOwasp: Object.fromEntries(Object.entries(byOwasp).sort().map(([k, v]) => [k, { count: v.count, rules: [...v.rules] }])),
    findings: active,
    suppressed: findings.filter((f) => f.suppressed),
  };
}

const OWASP_NAME = {
  "A01:2021": "Broken Access Control",
  "A02:2021": "Cryptographic Failures",
  "A03:2021": "Injection",
  "A05:2021": "Security Misconfiguration",
  "A08:2021": "Software and Data Integrity Failures",
  "A09:2021": "Security Logging and Monitoring Failures",
};
const SEV_KO = { critical: "치명", high: "높음", medium: "중간", low: "낮음" };
const cell = (/** @type {unknown} */ v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** @param {ReturnType<typeof runSecurityScan>} r */
export function renderScanMarkdown(r, { limit = 300 } = {}) {
  const L = ["=== AX-NAVI SECURITY SCAN ===", ""];
  L.push(`점검 시각: ${r.generatedAt.replace("T", " ").slice(0, 16)} (UTC)`);
  L.push(`대상: ${r.root} — 파일 ${r.scanned}개 점검${r.skipped ? `, ${r.skipped}개 건너뜀(1MB 초과·읽기 실패)` : ""}`);
  L.push(`결과: 치명 ${r.bySeverity.critical} · 높음 ${r.bySeverity.high} · 중간 ${r.bySeverity.medium} · 낮음 ${r.bySeverity.low}${r.suppressed.length ? ` (억제 ${r.suppressed.length}건 별도)` : ""}`);
  L.push("", "> 결정론적 규칙(정규식) 결과다. 의심 지점이며 확정 취약점이 아니다 — 미탐지 ≠ 취약점 없음.", "> 의존성 취약점(A06)은 다루지 않는다. npm audit · OWASP Dependency-Check 로 따로 확인한다.");
  L.push("", "## OWASP Top 10 분포", "", "| 카테고리 | 건수 | 규칙 |", "|---|---|---|");
  for (const [k, v] of Object.entries(r.byOwasp)) L.push(`| ${k} ${OWASP_NAME[/** @type {keyof typeof OWASP_NAME} */ (k)] ?? ""} | ${v.count} | ${v.rules.join(", ")} |`);
  L.push("", "## Findings", "");
  if (!r.findings.length) L.push("- 없음");
  else {
    L.push("| 심각도 | 규칙 | 위치 | 내용 | 영향 | 조치 |", "|---|---|---|---|---|---|");
    for (const f of r.findings.slice(0, limit)) {
      L.push(`| ${SEV_KO[f.severity]} | ${f.rule}${f.cwe ? `<br>${f.cwe}` : ""} | \`${cell(f.file)}:${f.line}\` | ${cell(f.title)}: \`${cell(f.snippet)}\` | ${cell(f.impact)} | ${cell(f.fix)} |`);
    }
    if (r.findings.length > limit) L.push("", `… 외 ${r.findings.length - limit}건 — 전체는 --format json 으로 받는다.`);
  }
  if (r.suppressed.length) {
    L.push("", "## 억제된 항목(axnavi:allow)", "");
    for (const f of r.suppressed.slice(0, 100)) L.push(`- ${f.rule} \`${f.file}:${f.line}\` — 사유: ${f.suppressed}`);
  }
  return L.join("\n") + "\n";
}
