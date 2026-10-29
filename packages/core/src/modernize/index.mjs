/*
 * 현대화 레시피 실행 — `axnavi modernize <java17|java21|jakarta|oracle-pg>`.
 *
 * LLM 없이 결정론적으로: 저장소 전체(또는 지정 경로)를 레시피 규칙으로 훑어 '자동'(기계적 치환)과 '수동'(안내)을 나눈다.
 * --apply 면 자동 항목만 고친다. 고치기 전에 git 작업 트리가 깨끗해야 한다(되돌릴 수 있게, --force 로 무시).
 * UTF-8 이 아닌 파일(EUC-KR 레거시 등)은 바이트 그대로 다룬다 — 한글이 없는 순수 ASCII 줄만 고치고, 한글이 섞인 줄은 수동으로 남긴다
 * (치환은 ASCII 끼리라 인코딩이 바뀌지 않는다).
 * --verify "<명령>" 은 고친 뒤 빌드·테스트를 돌려 단계 게이트로 판정한다: 실패 STOP, 수동 남음 HOLD, 아니면 GO.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSourceFiles } from "../review/scan.mjs";
import { EXIT } from "../review/review.mjs";
import { RECIPES, RULES, looksLikeSqlLine } from "./recipes.mjs";

/**
 * @typedef {{ rule: string, title: string, file: string, line: number, kind: "auto" | "manual", before: string, after?: string, guide: string }} ModFinding
 */

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const clip = (/** @type {string} */ s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/** @param {Buffer} buf */
function decode(buf) {
  try {
    return UTF8.decode(buf);
  } catch {
    return null;
  }
}

/** 고칠 파일이 git 에서 깨끗한가 — 바뀐 채로 덮어쓰면 사람이 한 수정과 섞인다 */
function dirtyFiles(/** @type {string} */ root, /** @type {string[]} */ files) {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  } catch {
    return [];
  }
}

/**
 * @param {{ root: string, recipe: string, paths?: string[], apply?: boolean, force?: boolean, verify?: string | null }} opts
 */
export function runModernize(opts) {
  const recipe = RECIPES[/** @type {keyof typeof RECIPES} */ (opts.recipe)];
  if (!recipe) throw new Error(`알 수 없는 레시피: ${opts.recipe} (${Object.keys(RECIPES).join(" | ")})`);
  const rules = RULES.filter((r) => recipe.rules.includes(r.recipe));
  const files = opts.paths?.length
    ? opts.paths.flatMap((p) => {
        try {
          if (statSync(join(opts.root, p)).isDirectory()) return listSourceFiles(join(opts.root, p)).map((r) => `${p.replace(/[\\/]+$/, "")}/${r}`);
        } catch {
          return [];
        }
        return [p];
      })
    : listSourceFiles(opts.root);

  /** @type {ModFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const nonUtf8 = [];
  /** @type {Map<string, { text: string, encoding: "utf8" | "latin1" }>} */
  const edits = new Map();
  let scanned = 0;
  for (const file of files) {
    const targets = rules.filter((r) => r.files.test(file));
    if (!targets.length) continue;
    let buf;
    try {
      buf = readFileSync(join(opts.root, file));
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024) continue;
    scanned++;
    const text = decode(buf);
    // 비 UTF-8 은 latin1 로 바이트 1:1 — 쓸 때도 latin1 로 돌려 바이트를 보존한다
    const raw = text ?? buf.toString("latin1");
    const lines = raw.split("\n");
    let changed = false;
    lines.forEach((orig, i) => {
      let line = orig;
      for (const r of targets) {
        if (!r.pattern.test(line)) continue;
        if (r.sqlOnly && !looksLikeSqlLine(file, line)) continue;
        const fixable = text !== null || !/[\x80-\xff]/.test(line);
        const after = r.fix && fixable ? r.fix(line, { target: recipe.target }) : undefined;
        const auto = after !== undefined && after !== line;
        findings.push({ rule: r.id, title: r.title, file, line: i + 1, kind: auto ? "auto" : "manual", before: clip(line.trim()), ...(auto ? { after: clip(after.trim()) } : {}), guide: r.fix && !fixable ? `${r.guide} (UTF-8 이 아닌 파일의 한글 섞인 줄이라 자동 수정에서 뺐다)` : r.guide });
        if (auto) {
          line = after;
          changed = true;
        }
      }
      lines[i] = line;
    });
    if (text === null && findings.some((f) => f.file === file)) nonUtf8.push(file);
    if (changed) edits.set(file, { text: lines.join("\n"), encoding: text === null ? "latin1" : "utf8" });
  }

  let applied = 0;
  /** @type {string[]} */
  let blocked = [];
  if (opts.apply && edits.size) {
    blocked = opts.force ? [] : dirtyFiles(opts.root, [...edits.keys()]);
    if (!blocked.length) {
      for (const [file, e] of edits) {
        writeFileSync(join(opts.root, file), Buffer.from(e.text, e.encoding));
        applied++;
      }
    }
  }

  /** @type {{ command: string, ok: boolean, output: string } | null} */
  let verification = null;
  if (opts.verify && opts.apply && !blocked.length) {
    const r = spawnSync(opts.verify, { cwd: opts.root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    verification = { command: opts.verify, ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000) };
  }

  const auto = findings.filter((f) => f.kind === "auto").length;
  const manual = findings.length - auto;
  /** @type {"GO" | "HOLD" | "STOP"} */
  let verdict;
  if (blocked.length || (verification && !verification.ok)) verdict = "STOP";
  else if (manual > 0 || (!opts.apply && auto > 0)) verdict = "HOLD";
  else verdict = "GO";
  const byRule = /** @type {Record<string, { title: string, kind: string, count: number, auto: number, guide: string }>} */ ({});
  for (const f of findings) {
    const rule = RULES.find((x) => x.id === f.rule);
    const b = (byRule[f.rule] ??= { title: f.title, kind: "manual", count: 0, auto: 0, guide: rule?.guide ?? f.guide });
    b.count++;
    if (f.kind === "auto") b.auto++;
    b.kind = b.auto === 0 ? "manual" : b.auto === b.count ? "auto" : "mixed";
  }
  return { recipe: opts.recipe, title: recipe.title, root: opts.root, scanned, auto, manual, applied, filesToChange: edits.size, blocked, nonUtf8, verification, verdict, exitCode: EXIT[verdict], byRule, findings };
}

/** @param {ReturnType<typeof runModernize>} r */
export function renderModernizeMarkdown(r, { limit = 400 } = {}) {
  const icon = { GO: "🟢 GO", HOLD: "🟡 HOLD", STOP: "🔴 STOP" }[r.verdict];
  const lines = [
    `# 현대화 레시피 — ${r.title}`,
    "",
    `판정: **${icon}** · 파일 ${r.scanned}개 훑음 · 자동 ${r.auto}건(파일 ${r.filesToChange}개) · 수동 ${r.manual}건${r.applied ? ` · **${r.applied}개 파일 고침**` : ""}`,
    "",
  ];
  if (r.blocked.length) lines.push(`> ⛔ 고칠 파일 중 커밋하지 않은 변경이 있어 고치지 않았습니다 — 먼저 커밋하거나 --force: ${r.blocked.slice(0, 20).join(", ")}`, "");
  if (r.verification) lines.push(`검증 \`${r.verification.command}\`: ${r.verification.ok ? "통과" : "**실패**"}`, "", ...(r.verification.ok ? [] : ["```", r.verification.output.slice(-1500), "```", ""]));
  if (r.nonUtf8.length) lines.push(`> UTF-8 이 아닌 파일(EUC-KR 등) ${r.nonUtf8.length}개는 바이트를 보존한 채 한글 없는 줄만 고칩니다 — 한글 섞인 줄은 수동 항목에 남습니다.`, "");
  lines.push("## 규칙별", "", "| 규칙 | 내용 | 구분 | 건수 | 안내 |", "|---|---|---|---|---|");
  for (const [id, b] of Object.entries(r.byRule)) lines.push(`| ${id} | ${b.title} | ${b.kind === "auto" ? "자동" : b.kind === "manual" ? "수동" : `자동 ${b.auto}·수동 ${b.count - b.auto}`} | ${b.count} | ${b.guide.replace(/\|/g, "\\|")} |`);
  const manual = r.findings.filter((f) => f.kind === "manual");
  if (manual.length) {
    lines.push("", `## 수동 항목 (${manual.length})`, "");
    for (const f of manual.slice(0, limit)) lines.push(`- \`${f.file}:${f.line}\` ${f.rule} ${f.title} — \`${f.before.replace(/`/g, "'")}\``);
    if (manual.length > limit) lines.push(`- … 외 ${manual.length - limit}건`);
  }
  const auto = r.findings.filter((f) => f.kind === "auto");
  if (auto.length) {
    lines.push("", `## 자동 항목 (${auto.length})${r.applied ? " — 고침" : " — --apply 로 고침"}`, "");
    for (const f of auto.slice(0, limit)) lines.push(`- \`${f.file}:${f.line}\` ${f.rule}: \`${f.before.replace(/`/g, "'")}\` → \`${(f.after ?? "").replace(/`/g, "'")}\``);
    if (auto.length > limit) lines.push(`- … 외 ${auto.length - limit}건`);
  }
  lines.push("", "## 권장 순서", "", "1. `java17`(또는 `java21`) — 빌드 대상과 JDK 제거 API", "2. `jakarta` — Spring Boot 3·Tomcat 10.1+ 로 올릴 때 함께", "3. `oracle-pg` — DB 전환. 매퍼 XML·SQL 파일·자바 문자열 SQL", "", "단계마다 `--apply --verify \"<빌드·테스트 명령>\"` 으로 고치고, `axnavi review` 로 변경을 다시 판정한 뒤 다음 단계로 간다.", "");
  return lines.join("\n");
}

export { RECIPES, RULES };
