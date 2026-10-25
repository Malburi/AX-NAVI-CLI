/*
 * SDLC 산출물 만들기·목록. 자동으로 채우는 값은 인덱스·리포트에서 읽은 사실뿐이다(LLM 없음).
 * 서술은 사람이 쓰거나 sdlc-docs 스킬이 근거를 붙여 채운다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listAdrs } from "./adr.mjs";
import { SDLC_KINDS, inspectDocument, loadTemplate, render } from "./templates.mjs";

/** 산출물 폴더 — 저장소에 커밋되는 문서라 _workspace/ 가 아니라 docs/ 아래에 둔다 */
export const SDLC_DIR = join("docs", "sdlc");

/** @param {Date} d */
export function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);
}

/** @param {Date} d */
export function kstDateTime(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(d);
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const bullet = (/** @type {string[]} */ items, empty = "(인덱스 없음 — `axnavi index build` 후 다시 만들면 채워진다)") =>
  items.length ? items.map((x) => `- ${x}`).join("\n") : empty;

/**
 * 인덱스·리포트에서 양식에 넣을 사실을 모은다. 없는 것은 빈 값이 아니라 "없음" 안내로 채운다.
 * @param {{ root: string, indexDir: string, reportsDir: string, workspaceDir: string }} paths
 * @param {{ now?: Date }} [opts]
 * @returns {Record<string, string | number>}
 */
export function collectFacts(paths, opts = {}) {
  const now = opts.now ?? new Date();
  const meta = readJson(join(paths.indexDir, "_meta.json"));
  const api = readJson(join(paths.indexDir, "api_contract.json"));
  const schema = readJson(join(paths.indexDir, "schema.json"));
  const pkg = readJson(join(paths.root, "package.json"));

  const exts = /** @type {{ extension: string, files: number, level: string }[]} */ (meta?.adapter_coverage?.extensions ?? []);
  const stack = exts.length
    ? [...exts].sort((a, b) => b.files - a.files).slice(0, 6).map((e) => `${e.extension.replace(/^\./, "")} ${e.files}`).join(" · ")
    : "(인덱스 없음)";

  const endpoints = /** @type {{ path?: string, method?: string }[]} */ (api?.endpoints ?? []);
  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const e of endpoints) {
    const seg = (e.path ?? "").split("/").filter(Boolean).slice(0, 2).join("/");
    if (seg) groups.set(`/${seg}`, (groups.get(`/${seg}`) ?? 0) + 1);
  }
  const apiGroups = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `\`${p}\` ${n}개`);

  const tables = /** @type {{ name: string, usage_count?: number }[]} */ (Array.isArray(schema?.tables) ? schema.tables : []);
  const topTables = [...tables].sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0)).slice(0, 8).map((t) => `\`${t.name}\``);

  // 모듈 = 코드 파일의 패키지 앞 3단계(java·kotlin 은 src/main/java 다음부터). 화면·설정 파일은 세지 않는다
  /** @type {Map<string, number>} */
  const modules = new Map();
  const symbols = readJson(join(paths.indexDir, "symbols.json"));
  const symList = /** @type {{ file?: string }[]} */ (Array.isArray(symbols) ? symbols : symbols?.symbols ?? []);
  for (const s of symList) {
    if (!/\.(java|kt|cs|py|ts|tsx|js|vue)$/i.test(s.file ?? "")) continue;
    const parts = (s.file ?? "").replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1);
    // 가장 안쪽 표지 다음부터 — src/main/java/com/... 에서 src 가 아니라 java 뒤를 잡는다
    let at = -1;
    parts.forEach((p, i) => { if (p === "java" || p === "kotlin" || p === "src" || p === "app") at = i; });
    const mod = parts.slice(at >= 0 ? at + 1 : 0).slice(0, 3).join("/");
    if (mod) modules.set(mod, (modules.get(mod) ?? 0) + 1);
  }
  const moduleList = [...modules].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, n]) => `\`${m}\` (심볼 ${n})`);

  const patternsDir = join(paths.root, ".claude", "patterns");
  const patterns = existsSync(patternsDir)
    ? readdirSync(patternsDir).filter((f) => f.endsWith(".md")).sort().map((f) => `\`${f.replace(/\.md$/, "")}\``)
    : [];

  const scan = readJson(join(paths.reportsDir, "security_scan.json"));
  const sev = scan?.bySeverity;
  const security = sev
    ? `\`axnavi scan security\` 결과: 치명 ${sev.critical} · 높음 ${sev.high} · 중간 ${sev.medium} · 낮음 ${sev.low} (파일 ${scan.scanned}개${scan.generatedAt ? `, ${kstDate(new Date(scan.generatedAt))}` : ""}).`
    : "보안 점검 결과 없음 — `axnavi scan security` 를 실행한 뒤 다시 만들면 채워진다.";

  const specFile = join(paths.workspaceDir, "00_spec_report.md");
  const spec = existsSync(specFile)
    ? `명세 명확화 리포트: \`_workspace/00_spec_report.md\` (spec-gate) — 목표·범위·제약을 이 문서에 옮겨 적는다.`
    : "명세 명확화 결과 없음 — 범위가 모호하면 spec-gate(\"명세 명확화\")를 먼저 실행한다.";

  const adrs = listAdrs(paths);
  return {
    project: pkg?.name ?? basename(paths.root),
    date: kstDate(now),
    docNo: `${basename(paths.root).toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${kstDate(now).replace(/-/g, "")}`,
    files: meta?.source_file_count ?? "-",
    indexedAt: meta?.generated_at ? kstDate(new Date(meta.generated_at)) : "인덱스 없음",
    stack,
    apiCount: endpoints.length,
    tableCount: tables.length,
    apiGroups: bullet(apiGroups),
    topTables: topTables.length ? topTables.join(", ") : "(인덱스 없음)",
    modules: bullet(moduleList),
    patterns: bullet(patterns, "(패턴 없음 — harness-init 으로 `.claude/patterns/` 를 만든 뒤 다시 만들면 채워진다)"),
    security,
    spec,
    adrs: adrs.length ? adrs.map((a) => `- [ADR-${a.no}](../adr/${a.fileName}) ${a.title} — ${a.status}`).join("\n") : "(아직 ADR 없음)",
  };
}

/**
 * @param {{ root: string, axnaviDir: string }} paths
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
export function artifactPath(paths, kind, env = process.env) {
  return join(paths.root, SDLC_DIR, loadTemplate(kind, paths, env).meta.file);
}

/**
 * 산출물 파일을 양식에서 만든다. 이미 있으면 덮어쓰지 않는다(force 제외) — 사람이 쓴 내용을 지키려고.
 * @param {any} paths
 * @param {string} kind
 * @param {{ force?: boolean, now?: Date, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ file: string, created: boolean, source: string }}
 */
export function createArtifact(paths, kind, opts = {}) {
  if (!(/** @type {readonly string[]} */ (SDLC_KINDS)).includes(kind)) {
    throw new Error(`알 수 없는 산출물: ${kind} (${SDLC_KINDS.join(" | ")})`);
  }
  const env = opts.env ?? process.env;
  const tpl = loadTemplate(kind, paths, env);
  const file = join(paths.root, SDLC_DIR, tpl.meta.file);
  if (existsSync(file) && !opts.force) return { file, created: false, source: tpl.source };
  mkdirSync(join(paths.root, SDLC_DIR), { recursive: true });
  writeFileSync(file, render(tpl.body, collectFacts(paths, opts.now ? { now: opts.now } : {})), "utf8");
  return { file, created: true, source: tpl.source };
}

/**
 * @param {any} paths
 * @param {NodeJS.ProcessEnv} [env]
 */
export function listArtifacts(paths, env = process.env) {
  /** @type {Record<string, string | number> | null} */
  let facts = null;
  return SDLC_KINDS.map((kind) => {
    const tpl = loadTemplate(kind, paths, env);
    const file = join(paths.root, SDLC_DIR, tpl.meta.file);
    if (!existsSync(file)) {
      return { kind, title: tpl.meta.title, phase: tpl.meta.phase, file, exists: false, status: null, incomplete: [], missingSections: [], unresolved: [], required: tpl.meta.required };
    }
    facts ??= collectFacts(paths);
    return { kind, title: tpl.meta.title, phase: tpl.meta.phase, file, exists: true, required: tpl.meta.required,
      ...inspectDocument(readFileSync(file, "utf8"), tpl, render(tpl.body, facts)) };
  });
}
