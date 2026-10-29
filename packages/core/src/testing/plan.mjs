/*
 * SR 테스트 계획 — `axnavi test plan|scaffold|status`.
 *
 * PMS-X 구현 명세(pmsx.spec/v1, `pmsx__spec` 도구나 PMS-X 화면에서 내려받은 JSON)에는 테스트 케이스(단계·기대 결과·근거)와
 * 관련 서버 소스가 들어 있다. 여기서 AI 없이:
 *   plan     명세 → 계획 파일(_workspace/tests/<SR>.plan.json)
 *   scaffold 계획 → 테스트 골격(JUnit 5 / Vitest). 케이스마다 @Disabled("작성 필요") 로 시작 — 빌드는 깨지지 않고 '남은 일'로 보인다.
 *            이미 있는 파일에는 없는 케이스만 덧붙인다(사람이 쓴 본문은 건드리지 않는다).
 *   status   테스트 결과(JUnit XML)로 케이스마다 작성 필요·실패·통과를 매기고 계획 파일을 갱신 — 중단한 곳에서 다시 시작한다.
 * 본문 작성은 사람 또는 AX-NAVI 에이전트("SR-0012 테스트 채워줘")가 한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT } from "../review/review.mjs";

/**
 * @typedef {{ id: string, title: string, steps: string[], expected: string[], basis: string | null, status: "planned" | "skipped" | "failing" | "passing", message?: string | null }} PlanCase
 * @typedef {{ schema: "axnavi.testplan/v1", sr: string, title: string, framework: "junit5" | "vitest", className: string, packageName: string | null, testFile: string | null, sources: string[], cases: PlanCase[], updatedAt: string }} TestPlan
 */

const safeId = (/** @type {string} */ s) => s.replace(/[^A-Za-z0-9]/g, "_").replace(/^_+|_+$/g, "") || "SR";
const esc = (/** @type {string} */ s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");

export function planPath(/** @type {string} */ workspaceDir, /** @type {string} */ sr) {
  return join(workspaceDir, "tests", `${safeId(sr)}.plan.json`);
}

/** 서버 소스에서 패키지 이름 — src/main/java/com/x/A.java → com.x */
function javaPackageOf(/** @type {string} */ file) {
  const m = /src\/main\/java\/(.+)\/[^/]+\.java$/.exec(file.replace(/\\/g, "/"));
  return m?.[1] ? m[1].replace(/\//g, ".") : null;
}

/**
 * 명세 → 계획
 * @param {any} spec @param {{ framework?: "junit5" | "vitest" }} [opts]
 * @returns {TestPlan}
 */
export function planFromSpec(spec, opts = {}) {
  if (!spec || spec.schema !== "pmsx.spec/v1") throw new Error("PMS-X 구현 명세(schema pmsx.spec/v1) JSON 이 아닙니다.");
  const sr = String(spec.no || spec.id || "SR");
  /** @type {string[]} */
  const sources = (spec.sources ?? []).filter((/** @type {any} */ s) => s.file).map((/** @type {any} */ s) => String(s.file));
  const server = sources.find((f) => /\.java$/i.test(f) && /src\/main\/java\//.test(f.replace(/\\/g, "/")));
  const framework = opts.framework ?? (server || !sources.some((f) => /\.(m?[jt]sx?|vue)$/i.test(f)) ? "junit5" : "vitest");
  const cases = (spec.tests ?? []).map((/** @type {any} */ t) => ({ id: String(t.id), title: String(t.title ?? ""), steps: (t.steps ?? []).map(String), expected: (t.expected ?? []).map(String), basis: t.basis ?? null, status: /** @type {const} */ ("planned") }));
  if (!cases.length) throw new Error("명세에 테스트 케이스가 없습니다.");
  return { schema: "axnavi.testplan/v1", sr, title: String(spec.title ?? ""), framework, className: `${safeId(sr)}Test`, packageName: server ? javaPackageOf(server) : null, testFile: null, sources, cases, updatedAt: new Date().toISOString() };
}

/** 계획을 저장할 때 지난 상태를 이어받는다(같은 케이스 ID) */
export function savePlan(/** @type {string} */ file, /** @type {TestPlan} */ plan) {
  if (existsSync(file)) {
    const prev = /** @type {TestPlan} */ (JSON.parse(readFileSync(file, "utf8")));
    for (const c of plan.cases) {
      const p = prev.cases.find((x) => x.id === c.id);
      // 명세에서 새로 만든 케이스(planned)만 지난 상태를 이어받는다 — status 로 갱신한 값은 그대로 저장
      if (p && c.status === "planned") Object.assign(c, { status: p.status, ...(p.message ? { message: p.message } : {}) });
    }
    plan.testFile = plan.testFile ?? prev.testFile;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...plan, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

/** @param {PlanCase} c */
function javaMethod(c) {
  const comment = [
    ...(c.basis ? [`근거: ${c.basis}`] : []),
    ...c.steps.map((s, i) => `${i === 0 ? "given/when" : "      "} ${i + 1}. ${s}`),
    ...c.expected.map((e) => `then  - ${e}`),
  ];
  return [
    "",
    "    @Test",
    `    @DisplayName("${esc(`${c.id} ${c.title}`)}")`,
    `    @Disabled("작성 필요 — ${esc(c.id)}")`,
    `    void ${c.id.toLowerCase().replace(/[^a-z0-9]/g, "")}() {`,
    ...comment.map((l) => `        // ${l}`),
    "    }",
  ].join("\n");
}

/** @param {PlanCase} c */
function vitestCase(c) {
  return [`  // ${c.basis ?? ""}`.trimEnd(), ...c.steps.map((s, i) => `  // ${i + 1}. ${s}`), ...c.expected.map((e) => `  // → ${e}`), `  it.todo("${esc(`${c.id} ${c.title}`)}");`].filter((l) => l.trim() !== "//").join("\n");
}

/**
 * 계획 → 테스트 파일. 있으면 없는 케이스만 덧붙인다.
 * @param {string} root @param {TestPlan} plan @param {{ out?: string }} [opts]
 * @returns {{ file: string, created: boolean, added: string[] }}
 */
export function scaffold(root, plan, opts = {}) {
  const rel =
    opts.out ??
    plan.testFile ??
    (plan.framework === "junit5" ? `src/test/java/${(plan.packageName ?? "sr").replace(/\./g, "/")}/${plan.className}.java` : `test/${safeId(plan.sr)}.test.ts`);
  const file = join(root, rel);
  plan.testFile = rel.replace(/\\/g, "/");
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const has = (/** @type {string} */ id) => new RegExp(`["\\s]${id.replace(/[^A-Za-z0-9]/g, ".")}\\s`).test(text);
  const missing = plan.cases.filter((c) => !has(c.id));
  if (plan.framework === "junit5") {
    const body = missing.map(javaMethod).join("\n");
    if (!exists) {
      const src = [
        ...(plan.packageName ? [`package ${plan.packageName};`, ""] : []),
        "import org.junit.jupiter.api.Disabled;",
        "import org.junit.jupiter.api.DisplayName;",
        "import org.junit.jupiter.api.Test;",
        "",
        "/**",
        ` * ${plan.sr} ${plan.title}`,
        " * PMS-X 구현 명세의 테스트 케이스로 만든 골격 — 케이스마다 @Disabled 를 지우고 본문을 채운다.",
        ...(plan.sources.length ? [` * 관련 소스: ${plan.sources.slice(0, 5).join(", ")}`] : []),
        " */",
        `@DisplayName("${esc(`${plan.sr} ${plan.title}`)}")`,
        `class ${plan.className} {`,
        body,
        "}",
        "",
      ].join("\n");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, src, "utf8");
    } else if (missing.length) {
      const at = text.lastIndexOf("}");
      writeFileSync(file, `${text.slice(0, at).replace(/\s*$/, "")}\n${body}\n}\n`, "utf8");
    }
  } else {
    const body = missing.map(vitestCase).join("\n\n");
    if (!exists) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, [`import { describe, it } from "vitest";`, "", `// ${plan.sr} ${plan.title} — PMS-X 구현 명세로 만든 골격. it.todo 를 it 으로 바꾸고 본문을 채운다.`, `describe("${esc(`${plan.sr} ${plan.title}`)}", () => {`, body, "});", ""].join("\n"), "utf8");
    } else if (missing.length) {
      const at = text.lastIndexOf("});");
      writeFileSync(file, `${text.slice(0, at).replace(/\s*$/, "")}\n\n${body}\n});\n`, "utf8");
    }
  }
  return { file: plan.testFile, created: !exists, added: missing.map((c) => c.id) };
}

/** JUnit XML(surefire·Gradle·Vitest junit 리포터) — testcase 이름에 케이스 ID 가 있으면 잇는다 */
export function readJunit(/** @type {string[]} */ dirs) {
  /** @type {{ name: string, classname: string, state: "passed" | "failed" | "skipped", message: string | null }[]} */
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".xml"))) {
      const xml = readFileSync(join(dir, f), "utf8");
      for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const attrs = m[1] ?? "";
        const inner = m[3] ?? "";
        const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? "";
        const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "";
        const state = /<(failure|error)\b/.test(inner) ? "failed" : /<skipped\b/.test(inner) ? "skipped" : "passed";
        const message = /<(?:failure|error)\b[^>]*message="([^"]*)"/.exec(inner)?.[1] ?? null;
        out.push({ name, classname, state, message });
      }
    }
  }
  return out;
}

export const JUNIT_DIRS = ["target/surefire-reports", "build/test-results/test", "test-results", "reports/junit"];

/**
 * 결과 → 계획 상태
 * @param {string} root @param {TestPlan} plan @param {{ junitDirs?: string[] }} [opts]
 */
export function updateStatus(root, plan, opts = {}) {
  const dirs = (opts.junitDirs?.length ? opts.junitDirs : JUNIT_DIRS).map((d) => join(root, d));
  const results = readJunit(dirs).filter((r) => r.classname.endsWith(plan.className) || r.classname.includes(safeId(plan.sr)) || r.name.includes(plan.sr));
  for (const c of plan.cases) {
    const key = c.id.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = results.find((r) => r.name.startsWith(`${c.id} `) || r.name.toLowerCase().replace(/\(\)$/, "") === key || r.name.includes(`${c.id} `));
    if (!hit) continue;
    c.status = hit.state === "passed" ? "passing" : hit.state === "failed" ? "failing" : "skipped";
    c.message = hit.message;
  }
  const count = (/** @type {PlanCase["status"]} */ s) => plan.cases.filter((c) => c.status === s).length;
  const summary = { total: plan.cases.length, passing: count("passing"), failing: count("failing"), todo: count("planned") + count("skipped"), matched: results.length };
  /** @type {"GO" | "HOLD" | "STOP"} */
  const verdict = summary.failing ? "STOP" : summary.todo ? "HOLD" : "GO";
  return { plan, summary, verdict, exitCode: EXIT[verdict] };
}

/** @param {ReturnType<typeof updateStatus>} r */
export function renderPlanMarkdown(r) {
  const p = r.plan;
  const mark = { planned: "⬜ 작성 필요", skipped: "⬜ 작성 필요", failing: "🔴 실패", passing: "🟢 통과" };
  return [
    `# 테스트 계획 — ${p.sr} ${p.title}`,
    "",
    `판정: **${r.verdict}** · 통과 ${r.summary.passing}/${r.summary.total} · 실패 ${r.summary.failing} · 남음 ${r.summary.todo}`,
    "",
    `테스트 파일: \`${p.testFile ?? "(아직 없음 — axnavi test scaffold)"}\``,
    "",
    "| 케이스 | 내용 | 상태 |",
    "|---|---|---|",
    ...p.cases.map((c) => `| ${c.id} | ${c.title.replace(/\|/g, "\\|")} | ${mark[c.status]}${c.message ? ` — ${c.message.slice(0, 80)}` : ""} |`),
    "",
  ].join("\n");
}
