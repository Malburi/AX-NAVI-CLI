#!/usr/bin/env node
/*
 * AX-Harness deterministic indexer
 *
 * 출처: upstream AX-Harness(Malburi/harness-sm) scripts/build-index.mjs, INDEXER_VERSION 1.7.0, 2026-08-12 이식.
 * 1.8.0부터 범용 adapter registry와 .NET/Nexacro/UI flow 보강은 total_ito에서 독자 관리한다.
 * 이 저장소 계약(_meta 9필드 · KST 타임스탬프 · api_contract 단수)에 맞춘 패치가 들어가 있으므로
 * upstream과 자동 동기화되지 않는다. 갱신 시 diff로 확인할 것.
 *
 * AI에게 전체 소스와 대형 JSON 생성을 맡기지 않기 위한 zero-dependency 1차 인덱서다.
 * 언어별 구문/프레임워크에서 확실하게 추출 가능한 사실은 이 스크립트가 기록하고,
 * 하나로 결정할 수 없는 호출 관계만 _unresolved.jsonl로 넘겨 analyzer가 보강한다.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ADAPTERS,
  ADAPTER_DISCOVERY_ONLY_EXTENSIONS,
  ADAPTER_SOURCE_EXTENSIONS,
  buildAdapterCoverage,
  detectAdapters,
} from "./adapters/registry.mjs";
import { extractNexacro } from "./adapters/nexacro.mjs";

export const INDEXER_VERSION = "1.14.0"; // 업무 용어(화면 제목·머리말·설명·라벨)를 glossary 로 모아 한글 검색에 기능 후보 순위를 준다.

/* AI edge patch에서 허용하는 관계 종류. analyzer는 노드를 새로 만들 수 없고 기존 노드 사이의 관계만 보강한다. */
const AI_PATCH_EDGE_TYPES = new Set(["call", "inject", "inherit", "reflect"]);
/*
 * `_analysis_input.json`의 digest 상한.
 * analyzer는 대형 index를 직접 읽지 못하므로, 인덱서가 이미 메모리에 갖고 있는 사실을
 * 결정적으로 정렬·집계해 "해석할 재료"만 넘긴다. 전체 덤프가 아니라 상한 있는 요약이다.
 */
const DIGEST_LIMITS = {
  hubs: 30,
  entry_points: 30,
  modules: 40,
  transactions: 25,
  external_io: 25,
  env_branches: 25,
  tables: 40,
  endpoints: 40,
  sql_tables: 25,
  dead_code: 30,
  partial_coverage: 20,
};
/* 대표 파일 경로 목록 상한 — 경로 문자열뿐이라 Tier가 커질수록 넉넉하게 준다. */
const REPRESENTATIVE_FILE_LIMITS = { Standard: 150, Full: 300 };
/*
 * 대표 파일 목록에 **바이트 예산**을 함께 건다.
 *
 * 개수 상한만 두면 레거시에서 상한이 사실상 무의미하다 — 파일 크기가 균일하지 않기 때문이다.
 * 실측: Full tier 300개를 그대로 고르면 24.5MB(약 21M 토큰)였다. 3.8MB짜리 생성 XJS 파일과
 * 2KB짜리 VO 클래스가 똑같이 "1개"로 세어진 결과다. analyzer·pattern-extractor가 이 목록을
 * 열람 후보로 쓰므로, 개수가 아니라 열었을 때의 비용으로 상한을 걸어야 한다.
 *
 * 또 지나치게 큰 파일은 애초에 "대표"가 아니다 — 컨벤션을 담은 손으로 쓴 코드가 아니라
 * 생성물·번들·데이터인 경우가 대부분이다. 개별 상한으로 먼저 걸러낸다.
 */
const REPRESENTATIVE_BYTE_BUDGET = { Standard: 768 * 1024, Full: 1536 * 1024 };
const REPRESENTATIVE_PER_FILE_CAP = 128 * 1024;

/*
 * 확장자 목록은 반드시 이 상수들로만 관리한다.
 * 예전에는 같은 목록이 네 곳에 중복돼 있어 `.mjs`/`.cjs`가 어디에도 없는 채로
 * ESM Node 프로젝트의 심볼이 하나도 인덱싱되지 않는 사각지대가 생겼다.
 */
const JS_FAMILY_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".xjs", ".xfdl"];
/* 구문 기반으로 클래스·함수·호출을 추출할 수 있는 확장자. */
const STRUCTURED_SOURCE_EXTENSIONS = [".java", ".kt", ".kts", ...JS_FAMILY_EXTENSIONS, ".py", ".cs", ".go"];

const SOURCE_EXTENSIONS = new Set([
  ...ADAPTER_SOURCE_EXTENSIONS,
  ...STRUCTURED_SOURCE_EXTENSIONS,
  ".xml", ".sql", ".jsp", ".jspx", ".jspf", ".tag", ".asp", ".aspx", ".ascx", ".ashx", ".asmx",
  ".vb", ".vbs", ".xaml", ".cshtml", ".vbhtml", ".razor", ".php", ".rb",
  ".cbl", ".cob", ".cpy", ".abap", ".html", ".htm",
  ".properties", ".yml", ".yaml", ".json",
]);
const MANIFEST_FILES = new Set(["pom.xml", "go.mod", "package.json", "build.gradle", "build.gradle.kts", "Cargo.toml", "Gemfile", "composer.json"]);
const DISCOVERY_ONLY_EXTENSIONS = ADAPTER_DISCOVERY_ONLY_EXTENSIONS;
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "target", "out", ".next", ".nuxt",
  "coverage", "_workspace", "_workspace_prev", ".claude", ".axnavi", ".idea", ".vscode", "bin", "obj",
  ".venv", "venv", "env", ".tox", "site-packages", "__pycache__", ".pytest_cache", ".mypy_cache",
]);
/* generate-wiki 산출물(wiki/, wiki_prev/)은 2026-08-14부터 _workspace/ 아래로 옮겨져
 * "_workspace" 제외만으로 이미 커버된다 — 더 이상 "wiki"/"wiki_prev"를 여기 따로 둘 필요가 없다
 * (남겨두면 대상 프로젝트가 우연히 자기 소스에 "wiki"라는 이름의 폴더를 쓸 때 잘못 제외될 수 있었다). */
/*
 * 벤더·미니파이 소스 제외.
 * EXCLUDED_DIRS는 디렉터리 *이름*만 보므로 `node_modules` 관행을 쓰지 않는 레거시 저장소를 못 잡는다.
 * 실측(2026-08-16 xu25-client)에서 ckeditor·fck_editor·jquery-ui·smarteditor2를 전부 인덱싱해
 * 노드 34,674개 중 80%가 고아가 되고 dead_code 31,572건이 거짓양성으로 나왔다.
 * 이름 목록만 믿으면 놓치므로, 파일 내용(줄당 평균 길이)을 주 신호로 쓰고 경로·파일명은 보조로 쓴다.
 */
/*
 * 디렉터리 이름으로 잡는 벤더. 라이브러리를 통째로 떨어뜨려 놓은 디렉터리는 안전하게 제외할 수 있다.
 * **파일명 앞부분으로는 잡지 않는다** — `jquery.add.js`가 실제로는 배너 슬라이더 업무 코드였다
 * (2026-08-16 실측). 라이브러리 이름을 접두사로 쓴 프로젝트 파일이 흔해서 파일명 매칭은 오탐을 낸다.
 */
const VENDOR_DIR = /(?:^|\/)(?:ckeditor|fckeditor|fck_editor|smarteditor\d*|tinymce|summernote|jquery|jquery[-_.][\w.-]*|bootstrap|fullcalendar|datatables|highcharts|chartjs|swiper|slick|owlcarousel|select2|moment|lodash|underscore|backbone|prototype|scriptaculous|modernizr|codemirror|ace-builds|webuploader|jszip|xlsx|nivo-slider|dynatree|jplayer|videojs|booklet|vkeyboard|jscalendar|jqgrid)(?:[-_.][\w.-]*)?\//i;
/* 버전이 박힌 파일명은 배포본이다 — jquery-1.5.2.js, jquery-ui-1.10.0.custom.css */
const VENDOR_VERSIONED = /(?:^|\/)[a-z][\w.]*?-\d+\.\d+[\w.]*\.(?:js|css)$/i;
/* 미니파이·번들 산출물임이 파일명에 드러난 경우. 이건 이름만으로 확실하다. */
const VENDOR_FILE = /(?:\.min\.(?:js|css)|[-.]min\.[a-z0-9]+|\.bundle\.js|\.pack\.js)$/i;
const MINIFIED_EXTENSIONS = new Set([".js", ".css", ".mjs", ".cjs"]);
/*
 * 테스트 파일도 벤더와 같은 이유로 노이즈다 — 업무 코드와 동일하게 전량 노드/엣지가 되어
 * call_graph.json을 부풀리지만 실제 호출 그래프 분석에는 의미가 없다.
 * 디렉터리는 세그먼트 완전 일치만 잡는다(VENDOR_DIR과 같은 원칙) — "abtest/"처럼 이름이
 * 다르면 걸리지 않는다. 파일명은 빌드 도구가 강제하는 규약만 써서 오탐 여지를 없앤다.
 */
const TEST_DIR = /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/i;
const TEST_FILE = /(?:(?:Test|Tests|TestCase|IT)\.(?:java|kt|cs)$|_test\.go$|(?:^|\/)test_[^/]+\.py$|_test\.py$|\.(?:test|spec)\.[jt]sx?$)/;
/* 줄당 평균 이 길이를 넘으면 사람이 쓴 소스가 아니다. 손으로 쓴 JS는 보통 30~60자다. */
const MINIFIED_AVG_LINE = 250;
/* 이보다 작은 파일은 굳이 열어보지 않는다 — 미니파이 번들은 사실상 전부 이보다 크다. */
const MINIFIED_MIN_BYTES = 20 * 1024;
const MINIFIED_PROBE_BYTES = 64 * 1024;

/* 파일 앞부분만 읽어 미니파이 여부를 판정한다. 줄 길이만 보므로 인코딩과 무관하다. */
function minifiedReason(full, size) {
  if (size < MINIFIED_MIN_BYTES) return null;
  let fd;
  try {
    fd = openSync(full, "r");
    const buffer = Buffer.alloc(Math.min(size, MINIFIED_PROBE_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString("latin1");
    const lines = head.split("\n");
    const nonEmpty = lines.filter((line) => line.trim()).length;
    if (nonEmpty <= 1) return `single-line(${read}B)`;
    const average = Math.round(read / nonEmpty);
    return average >= MINIFIED_AVG_LINE ? `avg-line(${average})` : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 닫기 실패는 무시 */ }
  }
}

/* 제외 사유를 반환한다(제외 대상이 아니면 null). 사유는 그대로 _meta에 기록된다. */
function vendorReason(rel, full, size, ext, config) {
  if (config?.vendor_exclude === false) return null;
  if (VENDOR_FILE.test(rel)) return "vendor-filename";
  if (VENDOR_VERSIONED.test(rel)) return "vendor-versioned";
  if (VENDOR_DIR.test(rel)) return "vendor-path";
  if (MINIFIED_EXTENSIONS.has(ext)) {
    const minified = minifiedReason(full, size);
    if (minified) return `minified:${minified}`;
  }
  return null;
}

/* 파일 전체를 제외하므로 그 파일에서 나온 노드/엣지가 통째로 안 생겨 dangling edge 위험이 없다. */
function testReason(rel, config) {
  if (config?.test_exclude === false) return null;
  if (TEST_DIR.test(rel)) return "test-path";
  if (TEST_FILE.test(rel)) return "test-filename";
  return null;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
/* 한 미해결 항목에 후보를 무한정 적지 않는다. 후보가 수백 개면 그 자체가 "판정 불가"라는 뜻이고,
 * 실측 레거시 프로젝트에서 이 목록이 _unresolved.jsonl을 169MB까지 부풀렸다. */
const MAX_UNRESOLVED_CANDIDATES = 20;
/* 이 수를 넘으면 analyzer가 전부 처리한다는 계약 자체가 성립하지 않는다 (analyzer_contract 참고). */
const UNRESOLVED_FULL_PROCESSING_LIMIT = 2000;
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this", "typeof",
  "sizeof", "await", "yield", "require", "import", "function", "class", "def", "func", "when",
  /* try-with-resources `try (AutoCloseable x = ...) {`가 메서드로 잡혀 있었다 — 자바 레거시에 흔한 형태다. */
  "try", "synchronized", "do", "else", "finally", "using", "foreach", "unless", "elif", "lock",
]);

function parseArgs(argv) {
  const result = { root: process.cwd(), mode: "init", tier: "Auto", config: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") result.root = argv[++i];
    else if (arg === "--mode") result.mode = argv[++i];
    else if (arg === "--tier") result.tier = argv[++i];
    else if (arg === "--config") result.config = argv[++i];
    else if (arg === "--index-dir") result.indexDir = argv[++i];
    else if (arg === "--apply-ai-patch") result.applyAiPatch = argv[++i];
    else if (arg === "--quiet") result.quiet = true;
    else if (arg === "--check-stale") result.checkStale = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!result.applyAiPatch && !new Set(["init", "incremental", "feature-scoped"]).has(result.mode)) {
    throw new Error(`지원하지 않는 mode: ${result.mode}`);
  }
  if (!new Set(["Auto", "Standard", "Full"]).has(result.tier)) {
    throw new Error(`지원하지 않는 tier: ${result.tier}`);
  }
  return result;
}

function recommendedTier(score) {
  if (score <= 120) return "Standard";
  return "Full";
}

function calculateComplexity(facts, config, sourceFileCount) {
  const rels = facts.map((item) => item.rel);
  const sourceScore = sourceFileCount;
  const db = facts.some((item) => item.sqls.length || item.tables.length || item.boundaries.length)
    || config.workspaces.some((item) => /sql|jpa|hibernate|mybatis|ibatis|prisma|sequelize|typeorm/i.test(item.stack));
  const legacy = rels.some((rel) => /(^|\/)WEB-INF\/web\.xml$/i.test(rel))
    || rels.filter((rel) => /\.jsp$/i.test(rel)).length >= 50
    || config.workspaces.some((item) => /struts|ibatis|jsp|egov/i.test(item.stack));
  const manifestCount = rels.filter((rel) => /(^|\/)(pom\.xml|build\.gradle|package\.json)$/i.test(rel)).length;
  const multiModule = config.workspace_mode || manifestCount >= 2;
  const external = facts.some((item) => item.communications.length || item.consumers.length);
  const signals = {
    source_files: sourceScore,
    db_or_orm: db ? 30 : 0,
    legacy_stack: legacy ? 40 : 0,
    multi_module: multiModule ? 20 : 0,
    external_system: external ? 20 : 0,
  };
  const score = Object.values(signals).reduce((sum, value) => sum + value, 0);
  return { score, signals, recommended_tier: recommendedTier(score) };
}

function slash(path) {
  return path.split(sep).join("/");
}

function readJson(path, fallback = null) {
  try {
    /* PowerShell로 만든 JSON에는 BOM이 붙는다. 이 저장소의 Python 쪽은 전부 utf-8-sig로 읽으므로 여기서도 벗긴다. */
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

/*
 * 인덱스 JSON을 항상 2칸 들여쓰기로 직렬화하면 대형 저장소에서 쓰기 비용이 크게 늘어난다
 * (실측: call_graph.json이 들여쓰기 47.9MB vs 레코드당 한 줄 34.6MB — 28% 차이가 그대로 I/O로 간다).
 *
 * 그렇다고 통째로 압축하면 파일이 **한 줄**이 되는데, `impact-analyzer`·`logic-tracer`·`qa`가
 * `call_graph.json`을 Read로 직접 열게 되어 있어서 긴 줄이 잘려 나간다. 조용한 손실이라 더 나쁘다.
 *
 * 그래서 큰 배열만 **레코드당 한 줄**로 쓴다 — 크기는 압축본과 같고(34.6MB), 줄 길이는 레코드 하나로
 * 묶여 있어 Read로도 안전하며, 직렬화 비용도 들여쓰기보다 싸다(238ms vs 253ms).
 * `_meta` 같은 작은 값은 그대로 들여쓰기를 유지해 사람이 읽을 수 있게 둔다. JSON 값 자체는 동일하다.
 */
/* 레코드가 이만큼 쌓인 배열이 하나라도 있으면 "큰 인덱스"로 보고 레코드당 한 줄로 쓴다.
 * 판정에 시험 직렬화를 쓰지 않는 이유는 그 자체가 비싸기 때문이다 — 길이만 세면 공짜다. */
const RECORD_PER_LINE_MIN_ITEMS = 200;

function serializeJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value, null, 2);
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  const large = entries.some(([, item]) => Array.isArray(item) && item.length >= RECORD_PER_LINE_MIN_ITEMS);
  if (!large) return JSON.stringify(value, null, 2);
  const parts = entries.map(([key, item]) => (
    Array.isArray(item) && item.length >= RECORD_PER_LINE_MIN_ITEMS
      ? `${JSON.stringify(key)}: [\n${item.map((record) => JSON.stringify(record)).join(",\n")}\n]`
      : `${JSON.stringify(key)}: ${JSON.stringify(item, null, 2)}`
  ));
  return `{\n${parts.join(",\n")}\n}`;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${serializeJson(value)}\n`, "utf8");
  try {
    renameSync(temp, path);
  } catch (error) {
    if (!existsSync(path) || !["EEXIST", "EPERM"].includes(error.code)) {
      rmSync(temp, { force: true });
      throw error;
    }
    try {
      rmSync(path, { force: true });
      renameSync(temp, path);
    } catch (replaceError) {
      rmSync(temp, { force: true });
      throw replaceError;
    }
  }
}

/*
 * 정렬은 반드시 로케일과 무관해야 한다. `localeCompare`는 OS 로케일에서 collator를 가져오므로
 * 한국어 윈도우(ko-KR)와 리눅스/CI(en-US)가 **다른 순서**를 낸다 — 실측에서 한글 파일명이
 * ko-KR에서는 맨 앞, en-US에서는 뒤로 갔다. 한글 파일명이 흔한 레거시 저장소에서 이러면
 * 소스가 같은데도 인덱스 전체가 재정렬돼 팀이 공유할 수 없는 diff가 된다.
 */
function byCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isIncluded(rel, includePaths) {
  return includePaths.some((scope) => !scope || rel === scope || rel.startsWith(`${scope}/`));
}

function listFiles(root, includePaths = [""], config = null) {
  const output = [];
  const excluded = [];
  function walk(dir, relDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (relDir === "plugins" && entry.name === "AX-Harness") continue;
        walk(join(dir, entry.name), join(relDir, entry.name));
        continue;
      }
      const full = join(dir, entry.name);
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) && !MANIFEST_FILES.has(entry.name)) continue;
      const rel = slash(relative(root, full));
      if (!isIncluded(rel, includePaths)) continue;
      const stats = statSync(full);
      if (stats.size > MAX_FILE_BYTES) continue;
      const reason = vendorReason(rel, full, stats.size, ext, config) || testReason(rel, config);
      if (reason) { excluded.push({ file: rel, reason, bytes: stats.size }); continue; }
      output.push({ full, rel, stats });
    }
  }
  walk(root);
  return { files: output.sort((a, b) => byCodeUnit(a.rel, b.rel)), excluded };
}

/* 무엇을 왜 뺐는지 _meta에 남긴다. 조용히 빠지면 "왜 이 파일이 인덱스에 없지"를 추적할 수 없다. */
function buildExclusionSummary(excluded) {
  const byReason = {};
  for (const item of excluded) {
    const key = item.reason.split(":")[0];
    byReason[key] = (byReason[key] || 0) + 1;
  }
  return {
    count: excluded.length,
    by_reason: byReason,
    bytes: excluded.reduce((sum, item) => sum + item.bytes, 0),
    files: excluded.slice(0, 100).map((item) => `${item.file} (${item.reason})`),
  };
}

function discoverUnsupportedFiles(root, includePaths = [""]) {
  const output = [];
  function walk(dir, relDir = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (relDir === "plugins" && entry.name === "AX-Harness") continue;
        walk(join(dir, entry.name), join(relDir, entry.name));
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!DISCOVERY_ONLY_EXTENSIONS.has(ext)) continue;
      const rel = slash(relative(root, join(dir, entry.name)));
      if (isIncluded(rel, includePaths)) output.push(rel);
    }
  }
  walk(root);
  return output.sort();
}

/*
 * 인덱서가 아예 읽지 않는 확장자(소스도, discovery-only도, 매니페스트도 아닌 것)를 센다.
 * 인덱스에는 이런 파일이 흔적도 남지 않아 "이 도구가 못 보는 코드가 얼마나 되나"를 알 수 없었다.
 * 커버리지 진단(coverage-report.mjs)에서만 부른다 — stat 없이 readdir만 하므로 가볍다.
 */
export function scanUnindexedExtensions(rootArg) {
  const root = resolve(rootArg);
  const config = loadConfig(root, null);
  const counts = new Map();
  function walk(dir, relDir = "") {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        /* `.settings`(Eclipse) 같은 점 폴더는 IDE·도구 메타데이터다. */
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (relDir === "plugins" && entry.name === "AX-Harness") continue;
        walk(join(dir, entry.name), join(relDir, entry.name));
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext) || MANIFEST_FILES.has(entry.name) || DISCOVERY_ONLY_EXTENSIONS.has(ext)) continue;
      /* `.classpath`·`.gitignore` 같은 점 파일, `x.mrd.bak100506`·`x.mrd_100702` 같은 백업은 코드가 아니다. */
      if (entry.name.startsWith(".") || /\.(?:bak\w*|old|orig|tmp)$|~$|\.\w+_\d{6,8}$/i.test(entry.name)) continue;
      const rel = slash(relative(root, join(dir, entry.name)));
      if (!isIncluded(rel, config.include_paths)) continue;
      /* 인덱서가 벤더로 빼는 폴더(fck_editor·jquery-*)의 .cfm·.pl·.as는 우리 코드 누락이 아니다. */
      if (VENDOR_DIR.test(rel)) continue;
      const key = ext || "(확장자 없음)";
      const current = counts.get(key) || { extension: key, files: 0, sample: rel };
      current.files += 1;
      counts.set(key, current);
    }
  }
  walk(root);
  return [...counts.values()].sort((left, right) => right.files - left.files || byCodeUnit(left.extension, right.extension));
}

function loadConfig(root, configArg) {
  const configPath = configArg ? (isAbsolute(configArg) ? configArg : join(root, configArg)) : join(root, "_workspace", "indexer-config.json");
  const config = readJson(configPath, {}) || {};
  const includePaths = Array.isArray(config.include_paths) && config.include_paths.length
    ? config.include_paths
      .map((item) => slash(String(item).trim().replace(/^\.\//, "").replace(/\/$/, "")))
      .map((item) => item === "." ? "" : item)
      .filter((item) => item !== ".." && !item.startsWith("../"))
    : [""];
  const workspaces = Array.isArray(config.workspaces) && config.workspaces.length
    ? config.workspaces.map((item) => ({
        id: item.id || "root",
        path: slash((item.path || "").replace(/^\.\//, "").replace(/\/$/, "")),
        kind: item.kind || "unknown",
        stack: item.stack || "unknown",
        calls_backend_api: Boolean(item.calls_backend_api),
      }))
    : [{ id: "root", path: "", kind: config.kind || "unknown", stack: config.stack || "unknown", calls_backend_api: false }];
  const allowedLayouts = new Set(["single-root", "monorepo", "paired-roots", "selected-paths"]);
  const initLayout = allowedLayouts.has(config.init_layout)
    ? config.init_layout
    : (config.workspace_mode ? "monorepo" : (includePaths.some(Boolean) ? "selected-paths" : "single-root"));
  return {
    init_layout: initLayout, workspace_mode: Boolean(config.workspace_mode), workspaces,
    include_paths: includePaths.length ? includePaths : [""],
    /*
     * vendor_exclude/test_exclude 이스케이프 해치가 이 반환 객체에서 빠져 있어 indexer-config.json에
     * "vendor_exclude": false를 둬도 조용히 무시되던 버그(2026 발견) — vendorReason/testReason이
     * 받는 config가 바로 이 객체라 여기 없으면 두 함수 모두 항상 undefined만 본다.
     */
    vendor_exclude: config.vendor_exclude, test_exclude: config.test_exclude,
  };
}

function workspaceFor(rel, config) {
  const matches = config.workspaces
    .filter((item) => !item.path || rel === item.path || rel.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0] || config.workspaces[0];
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
}

/*
 * lineIndex()는 본문 전체를 문자 단위로 훑어 줄 시작 오프셋 배열을 만든다 — 파일 크기에 정비례한다.
 * 그런데 한 파일을 처리하는 동안 extractSymbols·extractBindings·extractApi·extractSql·
 * extractTransactions·extractExternalIo·extractEnv가 각자 이걸 다시 만들어서 같은 스캔이
 * 파일당 7회 반복됐다. analyzeFile은 한 번에 파일 하나만 처리하고 모든 추출기에 같은
 * text/clean 문자열 *레퍼런스*를 넘기므로 직전 2건만 캐시하면 전부 적중한다.
 * (문자열을 붙들고 있게 되지만 최대 2개 = 파일 1개분이라 메모리 영향은 없다.)
 */
const LINE_INDEX_CACHE = [];
function lineIndex(text) {
  for (let i = 0; i < LINE_INDEX_CACHE.length; i += 1) {
    if (LINE_INDEX_CACHE[i].text === text) return LINE_INDEX_CACHE[i].at;
  }
  const at = buildLineIndex(text);
  LINE_INDEX_CACHE.unshift({ text, at });
  if (LINE_INDEX_CACHE.length > 2) LINE_INDEX_CACHE.length = 2;
  return at;
}

/*
 * "offset을 감싸는 것 중 start가 가장 큰 항목" 조회(ownerAt·트랜잭션 진입 메서드)와
 * "line 이후 첫 메서드" 조회(nextMethod)는 원래 매 호출마다 배열 전체를 filter+sort 했다.
 * 항목 m개·매치 k개면 O(k·m log m)이라 심볼이 많은 레거시 파일 하나가 수십 초를 먹었다
 * (실측: 3.8MB JS 파일 12.5초 중 8.0초가 ownerAt).
 * 배열당 한 번만 정렬해 두고 이분 탐색으로 O(log m)에 찾는다. 정렬 결과는 배열
 * 레퍼런스에 캐시하고, 배열이 자란 경우(길이 변화)에만 다시 만든다.
 */
const RANGE_FINDER_CACHE = new WeakMap();
function rangeFinder(items) {
  const cached = RANGE_FINDER_CACHE.get(items);
  if (cached && cached.size === items.length) return cached;
  /*
   * 원래 코드는 `sort((a, b) => b.start - a.start)[0]`이었고 Array.sort가 안정 정렬이므로
   * start가 같은 항목이 여럿이면 **배열에서 먼저 나온 것**이 선택됐다.
   * 그래서 오름차순 정렬본에도 원래 순서(order)를 실어 두고, 동률 구간에서는 order가 가장 작은
   * 것을 고른다 — 그러지 않으면 동률일 때 마지막 항목이 뽑혀 결과가 달라진다.
   */
  const sorted = items.map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.start - b.item.start || a.order - b.order);
  /* maxEnd[i] = sorted[0..i]의 end 최댓값 — 감싸는 항목이 없을 때 즉시 빠져나오기 위한 것. */
  const maxEnd = new Array(sorted.length);
  let running = -Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    running = Math.max(running, sorted[i].item.end);
    maxEnd[i] = running;
  }
  const finder = {
    size: items.length,
    at(offset) {
      let low = -1;
      let high = sorted.length;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid].item.start <= offset) low = mid;
        else high = mid;
      }
      for (let i = low; i >= 0; i -= 1) {
        if (maxEnd[i] <= offset) return undefined;
        if (offset >= sorted[i].item.end) continue;
        /* start가 같은 구간 전체에서 원래 순서가 가장 앞선 것을 고른다. */
        let best = sorted[i];
        for (let j = i - 1; j >= 0 && sorted[j].item.start === sorted[i].item.start; j -= 1) {
          if (offset < sorted[j].item.end && sorted[j].order < best.order) best = sorted[j];
        }
        return best.item;
      }
      return undefined;
    },
  };
  RANGE_FINDER_CACHE.set(items, finder);
  return finder;
}

const LINE_ORDER_CACHE = new WeakMap();
function lineOrdered(methods) {
  const cached = LINE_ORDER_CACHE.get(methods);
  if (cached && cached.length === methods.length) return cached;
  /* Array.prototype.sort는 안정 정렬이라 같은 line끼리는 원래 순서가 보존된다 —
   * filter+sort로 첫 항목을 고르던 기존 동작과 결과가 동일하다. */
  const sorted = [...methods].sort((a, b) => a.line - b.line);
  LINE_ORDER_CACHE.set(methods, sorted);
  return sorted;
}

// 문자열과 줄바꿈은 보존하고 주석 문자만 공백으로 바꿔 line/offset을 안정적으로 유지한다.
/*
 * SQL 계열은 주석이 `--`이고 문자열 안의 `\`가 이스케이프가 아니다(`'C:\'`가 정상 리터럴).
 * C 계열 규칙으로 지우면 `-- 옛 로직 UPDATE ...` 같은 주석 처리된 SQL이 살아남고,
 * `//`를 주석으로 오인해 뒤따르는 코드를 지운다.
 */
const PLSQL_EXTENSIONS = new Set(ADAPTERS.find((item) => item.id === "plsql").extensions);
const SQL_COMMENT_EXTENSIONS = new Set([".sql", ...PLSQL_EXTENSIONS]);

/* PowerScript는 `//` 주석을 쓰지만 문자열 이스케이프가 `~`다(`"~"따옴표~""`). `\`는 경로 문자다. */
const PB_EXTENSIONS = new Set(ADAPTERS.find((item) => item.id === "powerbuilder").extensions);

function stripComments(text, ext) {
  const sql = SQL_COMMENT_EXTENSIONS.has(ext);
  const pb = PB_EXTENSIONS.has(ext);
  let output = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; output += c; } else output += " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") { output += "  "; i += 1; state = "code"; }
      else output += c === "\n" ? "\n" : " ";
    } else if (state === "string") {
      output += c;
      if ((pb ? c === "~" : c === "\\" && !sql)) { output += n || ""; i += 1; }
      else if (c === quote) state = "code";
    } else if (sql && c === "-" && n === "-") {
      output += "  "; i += 1; state = "line";
    } else if (!sql && c === "/" && n === "/") {
      output += "  "; i += 1; state = "line";
    } else if (c === "/" && n === "*") {
      output += "  "; i += 1; state = "block";
    } else if (c === "#" && ext === ".py") {
      output += " "; state = "line";
    } else if (c === "\"" || c === "'" || c === "`") {
      output += c; quote = c; state = "string";
    } else output += c;
  }
  return output;
}

/*
 * 문자열 리터럴을 문자 단위로 정확히 토큰화한다(정규식 전역 매칭 대신). extractSql의 rawSql
 * 폴백이 예전에 정규식(`"..."{8,1000}`)으로 짝을 지었는데, 8자 미만 짧은 문자열(`""`,
 * `Session["ID"]`의 `"ID"` 등)을 건너뛰다가 서로 다른 문자열의 여는/닫는 따옴표를 잘못
 * 짝지어 그 사이의 실제 코드를 "문자열"로 오인하고 정작 그 안에 있는 진짜 SQL 리터럴은
 * 통째로 삼켜버렸다(2026-08-27 발견 — MyBatis/JPA 매퍼 없이 인라인 SQL 문자열만 쓰는
 * .NET ADO.NET류 프로젝트에서 sql_usage.json이 항상 0건으로 남는 원인이었다). 주석이 섞이면
 * 안에 있는 따옴표가 또 같은 오정렬을 일으키므로, 호출부는 stripComments()로 주석을 먼저
 * 비운 텍스트(clean)를 넘겨야 한다 — 원본 text를 그대로 넘기면 이 함수도 같은 문제를 겪는다.
 */
function extractStringLiterals(text) {
  const literals = [];
  let state = "code";
  let quote = "";
  let start = -1;
  let buf = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "string") {
      if (c === "\\") { buf += c + (n || ""); i += 1; continue; }
      if (c === quote) { literals.push({ content: buf, start, end: i + 1 }); state = "code"; continue; }
      buf += c;
    } else if (c === "\"" || c === "'" || c === "`") {
      quote = c; state = "string"; start = i; buf = "";
    }
  }
  return literals;
}

function matchingBrace(text, open) {
  if (open < 0 || text[open] !== "{") return text.length;
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/* 파라미터 목록의 끝 괄호 위치. `def f(x = Depends(g)):`처럼 기본값에 괄호가 들어가면
 * `\([^)]*\)` 같은 정규식은 첫 `)`에서 끊겨 함수 자체를 놓친다. */
function matchingParen(text, open) {
  if (open < 0 || text[open] !== "(") return -1;
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function packageName(text, ext, rel) {
  if (ext === ".java" || ext === ".kt" || ext === ".kts") return text.match(/\bpackage\s+([\w.]+)/)?.[1] || "";
  if (ext === ".cs") return text.match(/\bnamespace\s+([\w.]+)/)?.[1] || "";
  if (ext === ".py") return rel.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
  if (ext === ".go") return text.match(/\bpackage\s+(\w+)/)?.[1] || dirname(rel).replaceAll("/", ".");
  return rel.replace(/\.(?:jsx?|tsx?|vue)$/, "").replaceAll("/", ".");
}

function symbolId(pkg, owner, name) {
  return [pkg, owner, name].filter(Boolean).join(".");
}

function extractLegacySymbols(text, clean, rel, workspace) {
  const ext = extname(rel).toLowerCase(); const atLine = lineIndex(text);
  const pkg = rel.replace(/\.[^.]+$/, "").replaceAll("/", ".");
  const methods = []; const seenIds = new Set(); const add = (name, offset, type = "function") => {
    const id = symbolId(pkg, "", name);
    /* methods.some() 선형 재스캔 → Set 조회 (레거시 대형 파일에서 O(m²)였다) */
    if (seenIds.has(id)) return;
    seenIds.add(id);
    methods.push({ id, name, owner: "", package: pkg, file: rel, line: atLine(offset), start: offset, end: clean.length, visibility: "unknown", workspace: workspace.id, type });
  };
  const patterns = [];
  if ([".vb", ".vbs", ".asp"].includes(ext)) patterns.push(/^(?:\s*(?:Public|Private|Protected|Friend|Static)\s+)?(?:Sub|Function)\s+(\w+)/gim);
  if (ext === ".php") patterns.push(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g);
  if (ext === ".rb") patterns.push(/^[ \t]*def\s+([A-Za-z_]\w*[!?=]?)/gm);
  if ([".cbl", ".cob", ".cpy"].includes(ext)) patterns.push(/^\s{0,12}([A-Z0-9][A-Z0-9-]+)\.\s*(?:$|\*>)/gm);
  if (ext === ".abap") patterns.push(/^[ \t]*(?:FORM|METHOD|FUNCTION|MODULE)\s+([A-Za-z_]\w*)/gim);
  for (const regex of patterns) for (const match of clean.matchAll(regex)) {
    if (/^(?:IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE|WORKING-STORAGE|LINKAGE|END-IF|END-PERFORM)$/i.test(match[1])) continue;
    add(match[1], match.index);
  }
  const markup = new Set([".jsp", ".jspx", ".jspf", ".tag", ".aspx", ".ascx", ".ashx", ".asmx", ".xaml", ".cshtml", ".vbhtml", ".razor", ".html", ".htm"]);
  /*
   * 화면 안 인라인 `<script>`의 자바스크립트 함수. 예전에는 마크업 파일에서 view 심볼만 만들어
   * `onclick="fnSave()"`의 대상이 같은 JSP 안에 있어도 찾지 못했다 — 실측(레거시 JSP 1,815개)에서
   * 미해결 트리거 2,385건이 JSP였다. JSP 스크립틀릿(`<% if (a) { %>`)의 중괄호가 함수 범위를
   * 망치지 않도록 먼저 같은 길이의 공백으로 지운다. `src=` 외부 스크립트는 그 .js 파일이 따로 인덱싱된다.
   */
  const callSites = [];
  if (markup.has(ext) || ext === ".asp") {
    const scriptCode = clean.replace(/<%[\s\S]*?%>/g, (block) => block.replace(/[^\n]/g, " "));
    const scriptMethods = [];
    for (const block of scriptCode.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const offset = block.index + block[0].indexOf(">") + 1;
      const body = block[1];
      const declaration = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\([^)]*\)\s*\{|\b(?:this|window)\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\([^)]*\)\s*\{/g;
      for (const match of body.matchAll(declaration)) {
        const name = match[1] || match[2] || match[3];
        const start = offset + match.index;
        const end = matchingBrace(scriptCode, scriptCode.indexOf("{", start + match[0].length - 1));
        const id = symbolId(pkg, "", name);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const method = { id, name, owner: "", package: pkg, file: rel, line: atLine(start), start, end, visibility: "unknown", workspace: workspace.id, type: "function" };
        methods.push(method);
        scriptMethods.push(method);
      }
    }
    for (const method of scriptMethods) {
      const body = scriptCode.slice(method.start, method.end);
      for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g)) {
        const name = match[2] || match[1];
        if (CALL_KEYWORDS.has(name) || (!match[2] && name === method.name && match.index < 120)) continue;
        if (!match[2] && body.slice(0, match.index).replace(/\s+$/, "").endsWith(".")) continue;
        callSites.push({ caller: method.id, name, qualifier: match[2] ? match[1] : "", file: rel, line: atLine(method.start + match.index), workspace: workspace.id });
      }
    }
  }
  /* 이 화면에 함께 실리는 파일(`<%@ include file>`·`<jsp:include page>`). 화면 스크립트의 호출 범위를 정하는 데 쓴다. */
  const includes = markup.has(ext)
    ? [...text.matchAll(/<%@\s*include\s+file\s*=\s*["']([^"']+)["']|<jsp:include\s+page\s*=\s*["']([^"'<]+)["']/gi)].map((match) => (match[1] || match[2]).split("?")[0])
    : [];
  /*
   * 이 화면이 불러오는 외부 스크립트(`<script src="<%= JS_PATH %>back/x.js">`). 동적 앞부분은 알 수 없으니
   * 떼고 뒷부분 경로(`back/x.js`)만 남긴다 — 같은 함수가 html/·mobile/ 사본에 다 있을 때 실제로 실린 쪽을 고른다.
   */
  const scripts = markup.has(ext) || ext === ".asp"
    ? [...text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1].split(/[?#]/)[0]).filter((value) => /\.\w+$/.test(value))
    : [];
  /*
   * 스크립틀릿 경로 변수(`String JS_PATH = CONTEXT_PATH + conf.getString("BACK_JS_PATH");`).
   * `<%= JS_PATH %>forms.js`의 앞부분을 설정값(`/html/script/js/`)으로 되살려 html/·mobile/ 사본 중 실린 쪽을 가린다.
   * 조각: 문자열 리터럴, 설정 키 조회(getString/getProperty), 그 밖의 식(실행해야 아는 값 — 해석 때 버린다).
   */
  const pathVars = markup.has(ext)
    ? [...text.matchAll(/\bString\s+(\w+)\s*=\s*([^;%]+);/g)].map((match) => ({
      name: match[1],
      parts: match[2].split("+").map((token) => {
        const literal = token.trim().match(/^"([^"]*)"$/)?.[1];
        if (literal !== undefined) return { literal };
        const key = token.match(/\.get(?:String|Property)\s*\(\s*"([^"]+)"/)?.[1];
        return key ? { key } : { unknown: true };
      }),
    }))
    : [];
  const symbols = methods.map((method) => ({ id: method.id, type: method.type, file: rel, line: method.line, package: pkg, workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" }));
  if (markup.has(ext)) symbols.push({ id: `view:${rel}`, type: "view", file: rel, line: 1, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  /* 경로형 설정값(`KEY=/html/script/js/`). 값에 `/`가 없는 설정은 스크립트 경로 해석에 쓸 일이 없어 담지 않는다. */
  const properties = ext === ".properties"
    ? [...text.matchAll(/^[ \t]*([\w.-]+)[ \t]*[=:][ \t]*(\S*\/\S*)[ \t]*$/gm)].map((match) => [match[1], match[2]])
    : [];
  return { symbols, nodes: symbols.map((item) => ({ ...item })), methods, callSites, injects: [], classes: [], includes, scripts, pathVars, properties };
}

/*
 * Oracle PL/SQL — 패키지 스펙·바디, 독립 프로시저·함수, 트리거.
 * PL/SQL은 대소문자를 가리지 않으므로 이름을 대문자로 정규화한다. Java의 `{call pkg_order.save}`와
 * 바디의 `PROCEDURE Save`가 같은 노드로 이어져야 하기 때문이다. 스키마 접두사(`APP.PKG_ORDER`)는
 * 스펙에는 붙고 바디에는 안 붙는 식으로 파일마다 달라 id에서 빼고 `package` 필드에만 남긴다.
 * 바디 안의 멤버 범위는 "다음 멤버 선언 직전까지"로 근사한다 — 중첩 로컬 프로시저는 별도 멤버로 잘린다.
 */
const PLSQL_UNIT_DETECT = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:package|procedure|function|trigger)\b/i;
const PLSQL_IDENT = String.raw`"?[A-Za-z][\w$#]*"?`;
const PLSQL_NAME = String.raw`${PLSQL_IDENT}(?:\s*\.\s*${PLSQL_IDENT})?`;
const PLSQL_UNIT_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(package\s+body|package|procedure|function|trigger)\s+(${PLSQL_NAME})`
  + String.raw`|(?:^|\n)[ \t]*(package\s+body|package)\s+(${PLSQL_NAME})\s+(?:authid\s+\w+\s+)?(?:is|as)\b`,
  "gi",
);
const PLSQL_MEMBER_RE = new RegExp(String.raw`\b(procedure|function)\s+(${PLSQL_IDENT})`, "gi");
const PLSQL_CALL_PART = String.raw`([A-Za-z][\w$#]*)`;
const PLSQL_CALL_TAIL = String.raw`(?:\s*\.\s*${PLSQL_CALL_PART})?(?:\s*\.\s*${PLSQL_CALL_PART})?`;
const PLSQL_CALL_PAREN = new RegExp(String.raw`\b${PLSQL_CALL_PART}${PLSQL_CALL_TAIL}\s*\(`, "g");
/* 괄호 없는 호출(`log_step;`)은 문장 첫머리에서만 인정한다 — `x := y;`의 `y`를 호출로 보지 않는다. */
const PLSQL_CALL_BARE = new RegExp(String.raw`(?<=(?:^|;|\b(?:begin|then|else|loop))\s*)\b${PLSQL_CALL_PART}${PLSQL_CALL_TAIL}\s*;`, "gim");
const PLSQL_CALL_SKIP = new Set(["IF", "ELSIF", "WHILE", "FOR", "IN", "AND", "OR", "NOT", "VALUES", "INTO", "RETURN", "WHEN", "END", "NULL", "COMMIT", "ROLLBACK", "RAISE", "EXIT", "CONTINUE", "BEGIN", "EXCEPTION", "EXISTS", "PROCEDURE", "FUNCTION"]);

function isPlsqlSource(ext, clean) {
  return PLSQL_EXTENSIONS.has(ext) || (ext === ".sql" && PLSQL_UNIT_DETECT.test(clean));
}

function plsqlName(raw) {
  const parts = String(raw).replace(/"/g, "").split(".").map((part) => part.trim().toUpperCase()).filter(Boolean);
  return { schema: parts.length > 1 ? parts.at(-2) : "", name: parts.at(-1) || "" };
}

/* 문자열 내용을 공백으로 지운다(길이·줄 보존). 동적 SQL 문자열 속 `SELECT`·`pkg.proc(`를 코드로 읽지 않기 위함. */
function blankSqlStrings(clean) {
  return clean.replace(/'(?:[^']|'')*'/g, (match) => `'${match.slice(1, -1).replace(/[^\n]/g, " ")}'`);
}

/* `PROCEDURE x (...) [RETURN t ...] IS|AS` 면 구현, `;`로 끝나면 선언(스펙·전방 선언)이다. */
function plsqlIsImplementation(code, afterName) {
  let i = afterName;
  while (/\s/.test(code[i] || "")) i += 1;
  if (code[i] === "(") {
    const close = matchingParen(code, i);
    if (close < 0) return false;
    i = close + 1;
  }
  const next = code.slice(i, i + 4000).match(/;|\b(?:is|as)\b/i);
  return Boolean(next && next[0] !== ";");
}

function extractPlsqlSymbols(text, clean, rel, workspace) {
  const atLine = lineIndex(text);
  const code = blankSqlStrings(clean);
  const base = { file: rel, workspace: workspace.id, origin: "deterministic-indexer" };
  const units = [...code.matchAll(PLSQL_UNIT_RE)].map((match) => ({
    kind: (match[1] || match[3]).toLowerCase().replace(/\s+/g, " "),
    ...plsqlName(match[2] || match[4]),
    start: match.index + match[0].search(/\S/),
    headerEnd: match.index + match[0].length,
  }));
  units.forEach((unit, i) => { unit.end = units[i + 1]?.start ?? code.length; });

  const symbols = [];
  const nodes = [];
  const methods = [];
  const addMethod = (name, owner, schema, start, end, type = "method") => {
    const id = symbolId("", owner, name);
    methods.push({ id, name, owner, package: schema, file: rel, line: atLine(start), start, end, visibility: "unknown", workspace: workspace.id, type });
  };
  for (const unit of units) {
    const line = atLine(unit.start);
    const pkgFields = unit.schema ? { package: unit.schema } : {};
    if (unit.kind === "package" || unit.kind === "package body") {
      const members = [];
      for (const match of code.slice(unit.headerEnd, unit.end).matchAll(PLSQL_MEMBER_RE)) {
        const offset = unit.headerEnd + match.index;
        members.push({ name: plsqlName(match[2]).name, offset, implemented: plsqlIsImplementation(code, offset + match[0].length) });
      }
      const listed = unit.kind === "package" ? members : members.filter((item) => item.implemented);
      if (unit.kind === "package body") {
        listed.forEach((member, i) => addMethod(member.name, unit.name, unit.schema, member.offset, listed[i + 1]?.offset ?? unit.end));
      }
      symbols.push({
        id: unit.name, type: "package", line, ...pkgFields, ...base, confidence: "MEDIUM",
        methods: unique(listed, (item) => item.name).map((item) => ({ name: item.name, id: symbolId("", unit.name, item.name), line: atLine(item.offset), visibility: unit.kind === "package" ? "public" : "unknown" })),
      });
      nodes.push({ id: unit.name, type: "package", line, ...base, confidence: "MEDIUM" });
    } else if (unit.kind === "trigger") {
      const header = code.slice(unit.headerEnd, Math.min(unit.end, unit.headerEnd + 2000));
      const timing = header.match(new RegExp(String.raw`\b(?:before|after|instead\s+of|for)\b([\s\S]*?)\bon\s+(${PLSQL_NAME})`, "i"));
      const events = timing ? [...new Set([...timing[1].matchAll(/\b(insert|update|delete)\b/gi)].map((item) => item[1].toUpperCase()))] : [];
      addMethod(unit.name, "", unit.schema, unit.start, unit.end, "db_trigger");
      symbols.push({ id: unit.name, type: "db_trigger", line, ...pkgFields, ...(timing ? { trigger_table: plsqlName(timing[2]).name } : {}), ...(events.length ? { trigger_events: events } : {}), ...base, confidence: "MEDIUM" });
      nodes.push({ id: unit.name, type: "db_trigger", line, ...base, confidence: "MEDIUM" });
    } else {
      addMethod(unit.name, "", unit.schema, unit.start, unit.end);
      symbols.push({ id: unit.name, type: unit.kind, line, ...pkgFields, ...base, confidence: "MEDIUM" });
    }
  }
  /* 오버로드는 같은 id로 여러 범위를 갖는다 — 범위는 모두 남기고 노드는 하나만 만든다. */
  for (const method of unique(methods.filter((item) => item.type === "method"), (item) => item.id)) {
    nodes.push({ id: method.id, type: "method", line: method.line, visibility: method.visibility, ...base, confidence: "MEDIUM" });
  }

  const callSites = [];
  for (const method of methods) {
    const body = code.slice(method.start, method.end);
    for (const regex of [PLSQL_CALL_PAREN, PLSQL_CALL_BARE]) {
      for (const match of body.matchAll(regex)) {
        const parts = [match[1], match[2], match[3]].filter(Boolean).map((part) => part.toUpperCase());
        const name = parts.at(-1);
        if (PLSQL_CALL_SKIP.has(parts[0]) || PLSQL_CALL_SKIP.has(name)) continue;
        if (name === method.name && match.index < 200) continue;
        callSites.push({ caller: method.id, name, qualifier: parts.length > 1 ? parts.at(-2) : "", file: rel, line: atLine(method.start + match.index), workspace: workspace.id });
      }
    }
  }
  return { symbols, nodes, methods, callSites, injects: [], fields: [], classes: [] };
}

/*
 * PL/SQL 본문의 정적 SQL. 문자열이 아니라 맨 문장이라 extractSql의 리터럴 스캔이 못 잡는다.
 * 멤버 본문 안의 문장만 인정한다 — 같은 .sql에 섞인 시드 데이터 INSERT 수천 줄은 사용처가 아니다.
 * `SELECT a INTO v_a FROM t`의 INTO 절, `RETURNING id INTO v_id`는 테이블이 아니므로 떼고 센다.
 */
function extractPlsqlSql(text, clean, rel, methods) {
  const atLine = lineIndex(text);
  const code = blankSqlStrings(clean);
  const sqls = [];
  const usages = [];
  const relations = [];
  let consumed = 0;
  for (const match of code.matchAll(/\b(select|insert|update|delete|merge)\b/gi)) {
    if (match.index < consumed) continue;
    const owner = enclosingMethod(methods, match.index);
    if (!owner) continue;
    let back = match.index - 1;
    while (back >= 0 && /\s/.test(code[back])) back -= 1;
    const open = code[back] === "(" ? back : -1;
    const close = open >= 0 ? matchingParen(code, open) : -1;
    const semicolon = code.indexOf(";", match.index);
    const end = close >= 0 ? close : semicolon >= 0 ? semicolon : owner.end;
    let statement = code.slice(match.index, end);
    /* 오라클은 `DELETE tbl WHERE ...`처럼 FROM을 생략할 수 있다. 트리거 머리의 `DELETE ON`·`DELETE OR`는 제외. */
    if (/^delete\s+(?!from\b|on\b|or\b)[\w.$"]+/i.test(statement)) statement = statement.replace(/^delete\s+/i, "DELETE FROM ");
    const type = sqlStatementType(statement);
    if (!type) continue;
    consumed = end;
    const forTables = type === "select"
      ? statement.replace(/\b(?:bulk\s+collect\s+)?into\b[\s\S]*?(?=\bfrom\b)/i, " ")
      : statement.replace(/\breturning\b[\s\S]*$/i, " ");
    const using = type === "merge" ? [...forTables.matchAll(/\busing\s+([\w.$"]+)/gi)].map((item) => item[1].replace(/"/g, "")) : [];
    const line = atLine(match.index);
    const id = `${rel}:${line}:plsql`;
    sqls.push({ id, file: rel, line, type, tables: [...new Set([...sqlTables(forTables), ...using])], text_preview: clean.slice(match.index, end).replace(/\s+/g, " ").trim().slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(forTables, { sql_id: id, file: rel, line }));
    usages.push({ sql_id: id, file: rel, line, method: owner.id, evidence: "PL/SQL 본문 내 정적 SQL", origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return { sqls, usages, relations };
}

/*
 * Oracle Pro*C — C 배치 프로그램에 `EXEC SQL`을 섞은 형식. 제조·정산 야간 배치에 흔하다.
 * 함수 id는 파일 경로를 접두사로 쓴다(`batch.order_close.main`) — `main`·`db_connect`·`err_exit`가
 * 배치 파일마다 있어 이름만으로는 전부 충돌한다. EXEC SQL 블록은 함수·호출을 찾기 전에 지워
 * `NVL(`·`TO_CHAR(`를 C 호출로 읽지 않는다.
 */
const PROC_EXTENSIONS = new Set(ADAPTERS.find((item) => item.id === "proc").extensions);
const C_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "else", "do", "case", "defined", "typedef"]);
const C_FUNCTION_RE = /^[ \t]*(?:[A-Za-z_][\w \t*]*[\s*])?([A-Za-z_]\w*)[ \t]*\(([^;{}]*)\)\s*\{/gm;

/* `EXEC SQL ... ;` 블록. `EXEC SQL EXECUTE ... END-EXEC;`는 안에 `;`가 있으므로 END-EXEC까지 본다. */
function execSqlBlocks(clean) {
  const blocks = [];
  const re = /\bEXEC\s+SQL\b/gi;
  let match;
  while ((match = re.exec(clean))) {
    const after = match.index + match[0].length;
    const executeBlock = /^\s*(?:AT\s+:?[\w$]+\s+)?EXECUTE\b(?!\s+IMMEDIATE)/i.test(clean.slice(after, after + 80));
    const endExec = executeBlock ? clean.slice(after).search(/\bEND-EXEC\b/i) : -1;
    const stop = endExec >= 0 ? after + endExec : clean.indexOf(";", after);
    const end = stop < 0 ? clean.length : clean.indexOf(";", stop) + 1 || clean.length;
    blocks.push({ start: match.index, end, body: clean.slice(after, endExec >= 0 ? after + endExec : stop < 0 ? clean.length : stop).trim(), execute: executeBlock });
    re.lastIndex = end;
  }
  return blocks;
}

function extractProcSymbols(text, clean, rel, workspace) {
  const atLine = lineIndex(text);
  const blocks = execSqlBlocks(clean);
  let code = clean;
  for (const block of blocks) code = code.slice(0, block.start) + code.slice(block.start, block.end).replace(/[^\n]/g, " ") + code.slice(block.end);
  const pkg = rel.replace(/\.[^.]+$/, "").replaceAll("/", ".");
  const methods = [];
  let consumed = 0;
  for (const match of code.matchAll(C_FUNCTION_RE)) {
    if (match.index < consumed || C_KEYWORDS.has(match[1])) continue;
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const end = matchingBrace(code, open);
    consumed = end;
    const start = match.index + match[0].search(/\S/);
    methods.push({ id: symbolId(pkg, "", match[1]), name: match[1], owner: "", package: pkg, file: rel, line: atLine(start), start, end, visibility: /\bstatic\b/.test(match[0].slice(0, match[0].indexOf(match[1]))) ? "private" : "public", workspace: workspace.id });
  }
  const base = { file: rel, workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" };
  const symbols = methods.map((method) => ({ id: method.id, type: "function", line: method.line, package: pkg, ...base }));
  const nodes = methods.map((method) => ({ id: method.id, type: "method", line: method.line, visibility: method.visibility, ...base }));
  const callSites = [];
  for (const method of methods) {
    const body = code.slice(method.start, method.end);
    for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      if (C_KEYWORDS.has(match[1]) || (match[1] === method.name && match.index < 200)) continue;
      /* `ctx->fn(`·`s.fn(`은 함수 포인터·구조체 멤버라 대상을 모른다. */
      if (/(?:->|\.)\s*$/.test(body.slice(Math.max(0, match.index - 3), match.index))) continue;
      callSites.push({ caller: method.id, name: match[1], qualifier: "", file: rel, line: atLine(method.start + match.index), workspace: workspace.id });
    }
  }
  /* `EXEC SQL EXECUTE BEGIN pkg.proc(:a); END; END-EXEC;`·`EXEC SQL CALL pkg.proc(:a);` → PL/SQL 프로시저 호출 */
  for (const block of blocks) {
    const caller = enclosingMethod(methods, block.start);
    if (!caller) continue;
    const inner = block.body.replace(/^(?:AT\s+:?[\w$]+\s+)?(?:EXECUTE\b|CALL\b)/i, (keyword) => (/call/i.test(keyword) ? "{call " : ""));
    if (!block.execute && !/^\{call /i.test(inner)) continue;
    const target = inner.match(PROCEDURE_CALL_TEXT)?.[1];
    if (target) callSites.push({ caller: caller.id, ...procedureTarget(target), file: rel, line: atLine(block.start), workspace: workspace.id });
  }
  return { symbols, nodes, methods, callSites, injects: [], fields: [], classes: [] };
}

/* EXEC SQL의 정적 SQL. 호스트 변수(`:v_id`)는 테이블 판정에 영향이 없고, `INTO :a, :b`는 떼고 센다. */
function extractProcSql(text, clean, rel, methods) {
  const atLine = lineIndex(text);
  const sqls = [];
  const usages = [];
  const relations = [];
  for (const block of execSqlBlocks(clean)) {
    if (block.execute) continue;
    const owner = enclosingMethod(methods, block.start);
    if (!owner) continue;
    let statement = block.body.replace(/^(?:AT\s+:?[\w$]+\s+)?(?:FOR\s+:?[\w$]+\s+)?/i, "").replace(/^DECLARE\s+[\w$]+\s+CURSOR\s+FOR\s+/i, "");
    if (/^delete\s+(?!from\b)[\w.$"]+/i.test(statement)) statement = statement.replace(/^delete\s+/i, "DELETE FROM ");
    const type = sqlStatementType(statement);
    if (!type) continue;
    const forTables = type === "select"
      ? statement.replace(/\b(?:bulk\s+collect\s+)?into\b[\s\S]*?(?=\bfrom\b)/i, " ")
      : statement.replace(/\breturning\b[\s\S]*$/i, " ");
    const line = atLine(block.start);
    const id = `${rel}:${line}:proc`;
    sqls.push({ id, file: rel, line, type, tables: [...new Set(sqlTables(forTables))], text_preview: statement.replace(/\s+/g, " ").slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(forTables, { sql_id: id, file: rel, line }));
    usages.push({ sql_id: id, file: rel, line, method: owner.id, evidence: "Pro*C EXEC SQL", origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return { sqls, usages, relations };
}

/*
 * PowerBuilder 텍스트 내보내기(.srw·.sru·.srf·.srm·.sra·.srd).
 * PowerScript는 대소문자를 가리지 않아 이름을 소문자로 정규화한다. id는 `전역객체.컨트롤.이벤트`
 * (`w_order.cb_save.clicked`)·`전역객체.함수`(`w_order.wf_save`)다 — PowerBuilder 객체 이름은
 * 라이브러리 목록 안에서 유일해서 파일 경로 접두사가 필요 없다. 스크립트 소유자는 "그 앞의 마지막
 * `type X from Y within Z` 선언"이다(내보내기 형식이 컨트롤 선언 뒤에 그 컨트롤 이벤트를 둔다).
 * DataWindow(.srd)는 retrieve SQL·update 테이블을 SQL로 등록하고, 윈도의 `dw_1.Retrieve()`를
 * dataobject로 되짚어 그 SQL의 사용처로 잇는다.
 */
const PB_TYPE_RE = /^[ \t]*(global\s+)?type\s+(\w+)\s+from\s+([\w`.]+)(?:\s+within\s+(\w+))?/gim;
const PB_SCRIPT_RES = [
  /^[ \t]*(?:(?:public|private|protected|global)\s+)?function\s+[\w.]+(?:\s*\[\s*\])?\s+(\w+)\s*\([^)\n]*\)[^;\n]*;/gim,
  /^[ \t]*(?:(?:public|private|protected|global)\s+)?subroutine\s+(\w+)\s*\([^)\n]*\)[^;\n]*;/gim,
  /^[ \t]*event\s+(?:type\s+[\w.]+\s+)?(\w+)\s*(?:\([^)\n]*\))?[^;\n]*;/gim,
];
const PB_KEYWORDS = new Set(["if", "elseif", "choose", "case", "for", "while", "until", "return", "create", "destroy", "and", "or", "not", "halt", "call", "event", "function"]);

function blankPbStrings(clean) {
  return clean.replace(/"(?:~.|[^"~\n])*"|'(?:~.|[^'~\n])*'/g, (match) => `${match[0]}${match.slice(1, -1).replace(/[^\n]/g, " ")}${match.at(-1)}`);
}

function extractPbDataWindow(text, rel) {
  const name = basename(rel).replace(/\.[^.]+$/, "").toLowerCase();
  const atLine = lineIndex(text);
  const sqls = [];
  const retrieve = text.match(/\bretrieve\s*=\s*"((?:~.|[^"~])*)"/i);
  const unescape = (value) => value.replace(/~"/g, "\"").replace(/~[rnt]/gi, " ").replace(/~~/g, "~");
  if (retrieve) {
    const value = unescape(retrieve[1]);
    const pbselect = /^\s*PBSELECT\s*\(/i.test(value);
    const tables = pbselect
      ? [...value.matchAll(/TABLE\s*\(\s*NAME\s*=\s*"([^"]+)"/gi)].map((item) => item[1])
      : sqlTables(value);
    if (pbselect || sqlStatementType(value) === "select") {
      sqls.push({ id: name, file: rel, line: atLine(retrieve.index), type: "select", tables: [...new Set(tables)], text_preview: value.replace(/\s+/g, " ").trim().slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    }
  }
  /* DataWindow.Update()가 쓰는 테이블. retrieve 값 안의 `update` 단어와 섞이지 않게 값을 지우고 찾는다. */
  const updateTable = (retrieve ? text.replace(retrieve[0], "") : text).match(/\bupdate\s*=\s*"([\w.$#]+)"/i)?.[1];
  if (updateTable) sqls.push({ id: `${name}:update`, file: rel, line: 1, type: "update", tables: [updateTable], text_preview: `DataWindow ${name} Update() → ${updateTable}`, origin: "deterministic-indexer", confidence: "MEDIUM" });
  const symbols = [{ id: name, type: "datawindow", file: rel, line: 1, origin: "deterministic-indexer", confidence: "MEDIUM" }];
  return { symbols, nodes: [], methods: [], callSites: [], injects: [], fields: [], classes: [], sqlFacts: { sqls, usages: [], relations: [] } };
}

function extractPbSymbols(text, clean, rel, workspace) {
  if (extname(rel).toLowerCase() === ".srd") return extractPbDataWindow(text, rel);
  const atLine = lineIndex(text);
  const code = blankPbStrings(clean);
  const types = [...code.matchAll(PB_TYPE_RE)].map((match) => ({ name: match[2].toLowerCase(), base: match[3].toLowerCase(), global: Boolean(match[1]), start: match.index }));
  const globalName = types.find((item) => item.global)?.name || basename(rel).replace(/\.[^.]+$/, "").toLowerCase();
  const ownerAt = (offset) => {
    let last = null;
    for (const item of types) if (item.start < offset) last = item; else break;
    return !last || last.name === globalName ? globalName : `${globalName}.${last.name}`;
  };
  const ends = [...code.matchAll(/^[ \t]*end\s+(?:function|subroutine|event)\b/gim)].map((match) => match.index);
  const methods = [];
  for (const [index, regex] of PB_SCRIPT_RES.entries()) {
    /* 이벤트 스크립트(clicked·open 등)는 런타임이 부른다 — 호출처가 없어도 dead code가 아니므로 노드 종류를 나눈다. */
    const type = index === 2 ? "pb_event" : "method";
    for (const match of code.matchAll(regex)) {
      const start = match.index + match[0].search(/\S/);
      const end = ends.find((offset) => offset > start) ?? code.length;
      const name = match[1].toLowerCase();
      const owner = ownerAt(start);
      methods.push({ id: symbolId("", owner, name), name, owner, package: "", file: rel, line: atLine(start), start, bodyStart: match.index + match[0].length, end, visibility: /^\s*private\b/i.test(match[0]) ? "private" : "public", workspace: workspace.id, type });
    }
  }
  methods.sort((left, right) => left.start - right.start);

  /* 컨트롤 → dataobject. 선언 블록의 `string dataobject = "d_x"`와 실행 중 `dw_1.dataobject = "d_x"` 둘 다. */
  const dataobjectOf = new Map();
  for (const item of types) {
    const blockEnd = code.slice(item.start).search(/^[ \t]*end\s+type\b/im);
    const block = clean.slice(item.start, blockEnd < 0 ? clean.length : item.start + blockEnd);
    const value = block.match(/\bdataobject\s*=\s*"(\w+)"/i)?.[1];
    if (value) dataobjectOf.set(item.name, value.toLowerCase());
  }
  for (const match of clean.matchAll(/\b(\w+)\s*\.\s*dataobject\s*=\s*"(\w+)"/gi)) dataobjectOf.set(match[1].toLowerCase(), match[2].toLowerCase());

  const callSites = [];
  const usages = [];
  const sqls = [];
  const relations = [];
  const push = (method, offset, name, qualifier) => {
    if (!name || PB_KEYWORDS.has(name)) return;
    callSites.push({ caller: method.id, name, qualifier, file: rel, line: atLine(offset), workspace: workspace.id });
  };
  for (const method of methods) {
    const control = method.owner.includes(".") ? method.owner.split(".").at(-1) : "";
    /* `this.`는 스크립트 소유자, `parent.`는 컨트롤이 속한 전역 객체다. */
    const qualifierOf = (raw) => {
      const value = (raw || "").toLowerCase();
      if (value === "this") return method.owner;
      if (value === "parent") return globalName;
      return value === "super" ? "" : value;
    };
    const body = code.slice(method.bodyStart, method.end);
    const bodyClean = clean.slice(method.bodyStart, method.end);
    for (const match of body.matchAll(/\b(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g)) {
      if (/\bevent\s*$/i.test(body.slice(Math.max(0, match.index - 12), match.index))) continue;
      push(method, method.bodyStart + match.index, match[2].toLowerCase(), qualifierOf(match[1]));
    }
    for (const match of body.matchAll(/\b(?:(\w+)\s*\.\s*)?event\s+(?:trigger\s+|post\s+)?(\w+)\s*\(/gi)) push(method, method.bodyStart + match.index, match[2].toLowerCase(), qualifierOf(match[1]));
    for (const match of bodyClean.matchAll(/\b(?:(\w+)\s*\.\s*)?(?:triggerevent|postevent)\s*\(\s*"(\w+)"/gi)) push(method, method.bodyStart + match.index, match[2].toLowerCase(), qualifierOf(match[1]));
    for (const match of body.matchAll(/\b(\w+)\s*\.\s*(retrieve|update)\s*\(/gi)) {
      const target = match[1].toLowerCase() === "this" ? control : match[1].toLowerCase();
      const dataobject = dataobjectOf.get(target);
      if (!dataobject) continue;
      usages.push({ sql_id: /update/i.test(match[2]) ? `${dataobject}:update` : dataobject, file: rel, line: atLine(method.bodyStart + match.index), method: method.id, evidence: `DataWindow ${target}.${match[2]}()`, origin: "deterministic-indexer", confidence: "MEDIUM" });
    }
    /* 임베디드 SQL은 줄 첫머리에서 시작해 `;`로 끝난다. `DECLARE p PROCEDURE FOR pkg.proc(:a)`는 프로시저 호출이다. */
    let consumed = 0;
    for (const match of body.matchAll(/^[ \t]*(select|insert|update|delete|declare)\b/gim)) {
      const offset = method.bodyStart + match.index + match[0].length - match[1].length;
      /* `DECLARE c CURSOR FOR` 다음 줄의 `SELECT`·INSERT … SELECT를 두 번 세지 않는다. */
      if (offset < consumed) continue;
      const semicolon = code.indexOf(";", offset);
      consumed = semicolon < 0 || semicolon > method.end ? method.end : semicolon;
      let statement = code.slice(offset, consumed).replace(/\busing\s+\w+\s*$/i, "").trim();
      const procedure = statement.match(/^declare\s+\w+\s+procedure\s+for\s+([\w$#.]+)/i)?.[1];
      if (procedure) { callSites.push({ caller: method.id, ...procedureTarget(procedure), file: rel, line: atLine(offset), workspace: workspace.id }); continue; }
      statement = statement.replace(/^declare\s+\w+\s+cursor\s+for\s+/i, "");
      if (/^delete\s+(?!from\b)[\w.$"]+/i.test(statement)) statement = statement.replace(/^delete\s+/i, "DELETE FROM ");
      const type = sqlStatementType(statement);
      if (!type) continue;
      const forTables = type === "select" ? statement.replace(/\binto\b[\s\S]*?(?=\bfrom\b)/i, " ") : statement;
      const line = atLine(offset);
      const id = `${rel}:${line}:pb`;
      sqls.push({ id, file: rel, line, type, tables: [...new Set(sqlTables(forTables))], text_preview: clean.slice(offset, offset + statement.length).replace(/\s+/g, " ").slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
      relations.push(...extractSqlRelations(forTables, { sql_id: id, file: rel, line }));
      usages.push({ sql_id: id, file: rel, line, method: method.id, evidence: "PowerScript 임베디드 SQL", origin: "deterministic-indexer", confidence: "HIGH" });
    }
  }
  const base = { file: rel, workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" };
  const symbols = [{
    id: globalName, type: "pb_object", line: types.find((item) => item.global) ? atLine(types.find((item) => item.global).start) : 1, ...base,
    methods: unique(methods, (item) => item.id).map((item) => ({ name: item.name, id: item.id, line: item.line, visibility: item.visibility })),
  }];
  /* 전역 함수(.srf `from function_object`)는 함수 자체가 객체다 — 객체 노드를 두면 `f_log(...)` 호출 후보가 둘이 된다. */
  const functionObject = types.find((item) => item.global)?.base === "function_object";
  const nodes = [
    ...(functionObject ? [] : [{ id: globalName, type: "pb_object", line: symbols[0].line, ...base }]),
    ...unique(methods, (item) => item.id).map((item) => ({ id: item.id, type: item.type, line: item.line, visibility: item.visibility, ...base })),
  ];
  return { symbols, nodes, methods, callSites, injects: [], fields: [], classes: [], sqlFacts: { sqls, usages, relations } };
}

/* `{call PKG.PROC(?)}`·`{? = call F(?)}`·`BEGIN PKG.PROC(?); END;` — JDBC·MyBatis·ADO.NET이 프로시저를 부르는 모양. */
const PROCEDURE_CALL_TEXT = new RegExp(String.raw`^\s*(?:\{\s*(?:\?\s*=\s*)?call\s+|begin\s+)((?:${PLSQL_IDENT}\s*\.\s*){0,2}${PLSQL_IDENT})\s*[(;}]`, "i");

function procedureTarget(raw) {
  const parts = String(raw).replace(/"/g, "").split(".").map((part) => part.trim().toUpperCase()).filter(Boolean);
  return { name: parts.at(-1), qualifier: parts.length > 1 ? parts.at(-2) : "", procedure: true };
}

/*
 * multiline 정규식에서 `^\s*`를 쓰면 안 된다 — `\s`는 개행을 포함하므로 `^`가 **앞쪽 빈 줄**에서
 * 매치된 뒤 `\s*`가 그 개행을 삼켜, `match.index`가 실제 정의보다 위쪽 빈 줄을 가리킨다.
 * 파이썬처럼 정의 사이에 빈 줄을 두는 것이 표준인 언어에서는 사실상 모든 심볼의 줄 번호가
 * 한 줄씩 밀렸다(실측: `class Svc`가 3행인데 2행으로, `def other`가 7행인데 6행으로 기록됨).
 * 들여쓰기만 뜻하는 자리에는 개행을 포함하지 않는 `[ \t]*`를 쓴다.
 */
function extractSymbols(text, clean, rel, workspace) {
  const ext = extname(rel).toLowerCase();
  if (isPlsqlSource(ext, clean)) return extractPlsqlSymbols(text, clean, rel, workspace);
  if (PROC_EXTENSIONS.has(ext)) return extractProcSymbols(text, clean, rel, workspace);
  if (PB_EXTENSIONS.has(ext)) return extractPbSymbols(text, clean, rel, workspace);
  if (!STRUCTURED_SOURCE_EXTENSIONS.includes(ext)) {
    return extractLegacySymbols(text, clean, rel, workspace);
  }
  const atLine = lineIndex(text);
  const pkg = packageName(clean, ext, rel);
  const classes = [];
  const classRegex = /(?:^|\s)(?:export\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+|data\s+|internal\s+)*(class|interface|enum|record|object)\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+(?:implements|:)\s*([^\n{]+))?\s*\{/gm;
  for (const match of clean.matchAll(classRegex)) {
    const open = clean.indexOf("{", match.index);
    classes.push({
      name: match[2], type: match[1], start: match.index, end: matchingBrace(clean, open), line: atLine(match.index),
      extends: match[3] || null,
      implements: (match[4] || "").split(",").map((v) => v.trim().replace(/\(.*/, "")).filter(Boolean),
    });
  }
  if (ext === ".py") {
    const pyClasses = [...clean.matchAll(/^([ \t]*)class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm)];
    const lines = clean.split(/(?<=\n)/);
    const offsets = [];
    let cursor = 0;
    for (const line of lines) { offsets.push(cursor); cursor += line.length; }
    for (const match of pyClasses) {
      const indent = match[1].length;
      const startLine = atLine(match.index) - 1;
      let end = clean.length;
      for (let i = startLine + 1; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        const currentIndent = lines[i].match(/^\s*/)[0].replace(/\t/g, "    ").length;
        if (currentIndent <= indent) { end = offsets[i]; break; }
      }
      classes.push({ name: match[2], type: "class", start: match.index, end, line: atLine(match.index), extends: match[3]?.split(",")[0]?.trim() || null, implements: [] });
    }
  }
  const ownerAt = (offset) => rangeFinder(classes).at(offset)?.name || "";
  /*
   * 클래스 선언 직전의 애너테이션 블록을 되짚는다. `classes[i-1].end`~`classes[i].start` 범위로
   * 제한해 앞선 클래스의 애너테이션이 이 클래스 것으로 잘못 붙는 것을 막는다(2026-08-19 추가,
   * Lombok @RequiredArgsConstructor/@AllArgsConstructor + 스프링 스테레오타입 감지용).
   */
  const classAnnotationsBefore = new Map();
  for (let i = 0; i < classes.length; i += 1) {
    const item = classes[i];
    const rangeStart = i > 0 ? classes[i - 1].end : 0;
    classAnnotationsBefore.set(item.name, clean.slice(rangeStart, item.start));
  }
  const methods = [];
  /* 중복 판정을 methods.some() 선형 재스캔에서 Set 조회로 바꾼다 — 메서드가 많은 파일에서 O(m²)였다. */
  const seenMethods = new Set();
  const pushMethod = (name, index, open, visibility = "unknown") => {
    if (!name || CALL_KEYWORDS.has(name)) return;
    const owner = ownerAt(index);
    const id = symbolId(pkg, owner, name);
    const line = atLine(index);
    const key = `${id}@${line}`;
    if (seenMethods.has(key)) return;
    seenMethods.add(key);
    methods.push({ id, name, owner, package: pkg, file: rel, line, start: index, end: matchingBrace(clean, open), visibility, workspace: workspace.id });
  };

  if ([".java", ".cs", ".kt", ".kts"].includes(ext)) {
    /*
     * 이름 캡처 앞의 `(?<!@)`가 핵심이다. 이게 없으면 **애너테이션이 메서드로 잡히고 진짜 메서드는 사라진다.**
     *
     *   @GetMapping("/list")
     *   public String list(SearchVO vo, Model model) {
     *
     * 파라미터 부분 `[^;{}]*`가 개행과 괄호를 가리지 않으므로 `("/list")⏎ public String list(SearchVO vo, Model model)`
     * 전체를 하나의 인자 목록으로 삼켜 `GetMapping`이 메서드 이름이 되고 `list`는 인덱스에서 통째로 빠졌다.
     * Spring MVC 컨트롤러가 전부 이 형태라 요청 진입점이 사라졌다 — 신입이 "이 화면이 어디로 들어가나"를
     * 인덱스에서 찾을 수 없다는 뜻이다(2026-08-16 가상 프로젝트 실행 중 발견).
     *
     * `[^;{}()]*`로 괄호를 막는 방법은 쓸 수 없다 — `@RequestParam("x") String x` 같은 파라미터 애너테이션이
     * 정당하게 괄호를 포함하기 때문이다. 이름 바로 앞이 `@`인 경우만 배제하는 편이 정확하고 부작용이 없다.
     */
    const methodRegex = /\b(public|protected|private|internal)?\s*(?:static\s+|final\s+|abstract\s+|synchronized\s+|override\s+|open\s+|suspend\s+|async\s+)*(?:fun\s+)?(?:[\w<>,.?\[\]]+\s+)?(?<!@)\b(\w+)\s*\([^;{}]*\)\s*(?:throws\s+[^\n{]+)?\s*\{/gm;
    for (const match of clean.matchAll(methodRegex)) pushMethod(match[2], match.index, clean.indexOf("{", match.index), match[1] || "package");
  } else if (JS_FAMILY_EXTENSIONS.includes(ext)) {
    /*
     * TypeScript 반환 타입 주석(`): Promise<Order> {`)을 허용한다.
     * 이 부분이 없으면 `function f(): T {` 형태가 전부 심볼에서 빠져
     * 반환 타입을 쓰는 TypeScript 프로젝트의 함수가 인덱싱되지 않는다.
     * Python 분기는 이미 `-> type`을 허용하고 있었다.
     */
    const returnType = "(?::\\s*[^{;=]+)?";
    const functionRegex = new RegExp(
      `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(\\w+)\\s*\\([^)]*\\)\\s*${returnType}\\s*\\{`
      + `|\\b(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*${returnType}\\s*=>\\s*\\{`,
      "gm",
    );
    for (const match of clean.matchAll(functionRegex)) pushMethod(match[1] || match[2], match.index, clean.indexOf("{", match.index), "module");
    /* Nexacro XFDL/XJS와 레거시 JS의 대표 선언: this.fnName = function(...) { ... } */
    const assignedFunctionRegex = /\b(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\([^)]*\)\s*\{/gm;
    for (const match of clean.matchAll(assignedFunctionRegex)) pushMethod(match[1], match.index, clean.indexOf("{", match.index), "module");
    const classMethodRegex = new RegExp(`^[ \\t]*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*(\\w+)\\s*\\([^)]*\\)\\s*${returnType}\\s*\\{`, "gm");
    for (const match of clean.matchAll(classMethodRegex)) if (ownerAt(match.index)) pushMethod(match[1], match.index, clean.indexOf("{", match.index), "unknown");
  } else if (ext === ".py") {
    /*
     * 파라미터는 정규식으로 세지 않고 괄호 깊이로 닫는다.
     * `def list_users(current_user = Depends(get_current_user)):`처럼 기본값에 괄호가 있으면
     * 한 줄 정규식이 첫 `)`에서 끊겨 함수가 통째로 누락됐다 — FastAPI 라우트 핸들러가
     * 전부 이 형태라 호출 그래프에서 엔드포인트가 사라지는 원인이었다.
     */
    const pyDefRegex = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm;
    const all = [];
    for (const match of clean.matchAll(pyDefRegex)) {
      const close = matchingParen(clean, match.index + match[0].length - 1);
      if (close < 0) continue;
      const tail = clean.slice(close + 1, clean.indexOf("\n", close) + 1 || undefined);
      if (!/^\s*(?:->[^:]+)?:/.test(tail)) continue;
      all.push(match);
    }
    /*
     * `all.slice(i + 1).find(...)`는 매 def마다 뒤쪽 배열을 통째로 복사해 O(n²)였다.
     * 들여쓰기 스택을 뒤에서 앞으로 한 번만 훑으면 각 def의 "다음 형제/상위" def를 O(n)에 구한다.
     */
    const nextSibling = new Array(all.length);
    const indentStack = [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const indent = all[i][1].length;
      while (indentStack.length && all[indentStack[indentStack.length - 1]][1].length > indent) indentStack.pop();
      nextSibling[i] = indentStack.length ? all[indentStack[indentStack.length - 1]] : undefined;
      indentStack.push(i);
    }
    for (let i = 0; i < all.length; i += 1) {
      const match = all[i];
      const next = nextSibling[i];
      const owner = ownerAt(match.index);
      const id = symbolId(pkg, owner, match[2]);
      methods.push({ id, name: match[2], owner, package: pkg, file: rel, line: atLine(match.index), start: match.index, end: next?.index || clean.length, visibility: match[2].startsWith("_") ? "private" : "public", workspace: workspace.id });
    }
  } else if (ext === ".go") {
    const goRegex = /\bfunc\s*(?:\([^)]*\)\s*)?(\w+)\s*\([^)]*\)[^{]*\{/gm;
    for (const match of clean.matchAll(goRegex)) pushMethod(match[1], match.index, clean.indexOf("{", match.index), /^[A-Z]/.test(match[1]) ? "public" : "private");
  }

  /* classes × methods 전수 비교(O(C·M))를 owner 기준 1회 그룹핑으로 바꾼다. */
  const methodsByOwner = new Map();
  for (const method of methods) {
    if (!method.owner) continue;
    const bucket = methodsByOwner.get(method.owner);
    if (bucket) bucket.push(method);
    else methodsByOwner.set(method.owner, [method]);
  }
  const symbols = classes.map((item) => ({
    id: symbolId(pkg, "", item.name), type: item.type, file: rel, line: item.line, package: pkg,
    ...(item.extends ? { extends: item.extends } : {}), ...(item.implements.length ? { implements: item.implements } : {}),
    methods: (methodsByOwner.get(item.name) || []).map((method) => ({ name: method.name, id: method.id, line: method.line, visibility: method.visibility })),
    workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH",
  }));
  for (const method of methods.filter((item) => !item.owner)) {
    symbols.push({ id: method.id, type: "function", file: rel, line: method.line, package: pkg, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  const nodes = [
    ...classes.map((item) => ({ id: symbolId(pkg, "", item.name), type: item.type, file: rel, line: item.line, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" })),
    ...methods.map((item) => ({ id: item.id, type: "method", file: rel, line: item.line, visibility: item.visibility, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" })),
  ];
  const callSites = [];
  const callRegex = /\b([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;
  for (const method of methods) {
    const body = clean.slice(method.start, method.end);
    for (const match of body.matchAll(callRegex)) {
      const name = match[2] || match[1];
      if (CALL_KEYWORDS.has(name) || (!match[2] && name === method.name && match.index < 120)) continue;
      /*
       * 캐스팅·체이닝 뒤의 호출(`((HashMap)(x)).get(...)`, `foo().bar()`)은 콜레직스가
       * 리시버를 못 캡처해 한정자 없는 "맨 호출"로 오인된다 — 실제로는 리시버가 있는데
       * 정규식이 식별자 하나짜리 한정자만 보기 때문이다. 이름 직전이 `.`인데 캡처된
       * 한정자가 없으면 이 경우다 — 리시버를 모르니 같은 클래스로도 억지로 몰지 않고
       * 스킵한다(2026-08-19 추가. 실측: 백엔드 "get()" 미해결 1,582건 중 다수가 이 패턴
       * — `Map.get`/`List.get` 같은 JDK 호출을 프로젝트 내부 동명 메서드로 오판할 뻔했다).
       */
      if (!match[2] && body.slice(0, match.index).replace(/\s+$/, "").endsWith(".")) continue;
      callSites.push({ caller: method.id, name, qualifier: match[2] ? match[1] : "", file: rel, line: atLine(method.start + match.index), workspace: workspace.id });
    }
  }
  const injects = [];
  const injectRegex = /(?:@Autowired|@Inject|@Resource(?:\([^)]*\))?)\s*(?:private|protected|public|lateinit\s+var|val|var)?\s*([A-Z][\w.]*)\s+(\w+)/gm;
  for (const match of clean.matchAll(injectRegex)) {
    const owner = ownerAt(match.index);
    /* 필드 *이름*(match[2])도 함께 남긴다 — `sqlSession.insert(...)`처럼 한정자로 호출할 때
     * 그 한정자가 어떤 타입인지 되짚는 유일한 근거다. 예전에는 타입만 쓰고 이름을 버렸다. */
    if (owner) injects.push({ owner: symbolId(pkg, "", owner), targetName: match[1].split(".").at(-1), fieldName: match[2], file: rel, line: atLine(match.index), workspace: workspace.id });
  }
  /*
   * 주입 애너테이션이 없는 평범한 필드 선언도 한정자 해석에 쓴다(레거시는 애너테이션 없이
   * `private SqlSessionTemplate sqlSession;`으로 두는 코드가 많다). 엣지를 만들지는 않고
   * "이 이름은 이 타입"이라는 사전으로만 쓴다.
   */
  const fields = [];
  const fieldRegex = /(?:^|\n)\s*(?:private|protected|public)\s+(?:final\s+|static\s+|volatile\s+|transient\s+)*([A-Z][\w.]*)(?:<[^>;=]*>)?\s+(\w+)\s*[;=]/gm;
  for (const match of clean.matchAll(fieldRegex)) {
    const owner = ownerAt(match.index);
    if (owner) fields.push({ owner: symbolId(pkg, "", owner), typeName: match[1].split(".").at(-1), fieldName: match[2] });
  }
  for (const item of injects) fields.push({ owner: item.owner, typeName: item.targetName, fieldName: item.fieldName });
  /* ASP.NET Core의 주입은 대부분 어노테이션이 아니라 컨트롤러 생성자 파라미터다. */
  if (ext === ".cs") for (const owner of classes) {
    const body = clean.slice(owner.start, owner.end);
    const constructor = new RegExp(`\\b${owner.name}\\s*\\(([^)]*)\\)`, "g");
    for (const match of body.matchAll(constructor)) {
      for (const parameter of match[1].split(",")) {
        const parsed = parameter.trim().match(/^(?:\[[^\]]+\]\s*)?(?:in\s+|ref\s+|out\s+)?([A-Z][\w.<>,?\[\]]*)\s+\w+/);
        if (!parsed) continue;
        const targetName = parsed[1].replace(/[<,?\[].*/, "").split(".").at(-1);
        injects.push({ owner: symbolId(pkg, "", owner.name), targetName, file: rel, line: atLine(owner.start + match.index), workspace: workspace.id });
      }
    }
  }
  /*
   * Java 생성자 주입 — Lombok 특수케이스 + 명시적 단일 생성자.
   * @RequiredArgsConstructor/@AllArgsConstructor는 컴파일 타임에 생성자를 만들어 소스에
   * @Autowired 같은 토큰이 없다 — injectRegex(위)로는 절대 못 잡는다(2026-08-19 실측:
   * Lombok DI 클래스 1,613개가 전량 누락되어 analyzer가 LLM으로 직접 찾아야 했다).
   * 명시적 생성자는 스프링 관례상(애너테이션 없이도) 정확히 1개일 때만 주입 대상으로 본다 —
   * 오버로드된 생성자가 여럿이면 어느 게 스프링이 쓰는 것인지 정규식으로 확정할 수 없어 스킵한다.
   * 스프링 빈이 아닌 평범한 POJO의 생성자까지 주입으로 오인하지 않도록, 스테레오타입 애너테이션
   * (@Service 등) 또는 Lombok DI 애너테이션이 있는 클래스만 대상으로 한다.
   */
  if (ext === ".java") {
    const SPRING_STEREOTYPE = /@(?:Service|Component|Repository|Controller|RestController|Configuration)\b/;
    const LOMBOK_CTOR = /@(RequiredArgsConstructor|AllArgsConstructor)\b/;
    for (const item of classes) {
      const annotations = classAnnotationsBefore.get(item.name) || "";
      const lombok = annotations.match(LOMBOK_CTOR);
      if (!lombok && !SPRING_STEREOTYPE.test(annotations)) continue;
      const body = clean.slice(item.start, item.end);
      if (lombok) {
        const fieldInBody = /(?:^|\n)\s*(?:private|protected|public)?\s*((?:final\s+|static\s+|volatile\s+|transient\s+)*)([A-Z][\w.]*)(?:<[^>;=]*>)?\s+(\w+)\s*[;=]/gm;
        for (const fm of body.matchAll(fieldInBody)) {
          if (/\bstatic\b/.test(fm[1])) continue;
          const isFinal = /\bfinal\b/.test(fm[1]);
          if (lombok[1] === "RequiredArgsConstructor" && !isFinal) continue;
          const targetName = fm[2].split(".").at(-1);
          injects.push({ owner: symbolId(pkg, "", item.name), targetName, fieldName: fm[3], file: rel, line: atLine(item.start + fm.index), workspace: workspace.id });
        }
        continue;
      }
      const ctorRegex = new RegExp(`\\b${item.name}\\s*\\(([^)]*)\\)\\s*(?:throws\\s+[^\\n{]+)?\\s*\\{`, "g");
      const ctorMatches = [...body.matchAll(ctorRegex)];
      if (ctorMatches.length !== 1) continue;
      for (const parameter of ctorMatches[0][1].split(",")) {
        const parsed = parameter.trim().match(/^(?:final\s+)?(?:@[\w.]+(?:\([^)]*\))?\s+)*([A-Z][\w.<>,?\[\]]*)\s+\w+/);
        if (!parsed) continue;
        const targetName = parsed[1].replace(/[<,?\[].*/, "").split(".").at(-1);
        injects.push({ owner: symbolId(pkg, "", item.name), targetName, file: rel, line: atLine(item.start + ctorMatches[0].index), workspace: workspace.id });
      }
    }
  }
  /*
   * 메서드 안의 지역 변수·파라미터 선언 타입(`UserSession user = ...`, `(Map param)`).
   * fieldTypes는 필드만 추적해서 `user.getUserNo()`처럼 지역 변수를 한정자로 쓰는 호출이 전부
   * 부분 문자열 근사로 갔다 — 실측(레거시 Java 600파일)에서 미해결 1,074건이 이 한 패턴이었다.
   * 같은 이름을 if/else 블록마다 다른 타입으로 선언하는 코드가 흔해서(`ExcelReader excel` / `ExcelRead excel`)
   * 선언 줄을 함께 남기고, 해석 때 호출 줄 바로 앞의 가장 가까운 선언을 쓴다.
   */
  const locals = [];
  if ([".java", ".cs"].includes(ext)) {
    for (const method of methods) {
      /* 문자열 안의 `"User name = "`를 선언으로 읽지 않게 리터럴 내용을 먼저 지운다(길이는 보존). */
      const body = clean.slice(method.start, method.end).replace(/"(?:\\.|[^"\\\n])*"/g, (literal) => `"${" ".repeat(literal.length - 2)}"`);
      for (const match of body.matchAll(/\b([A-Z]\w*)(?:<[^;=(){}]*?>)?(?:\[\])?\s+([a-z_$][\w$]*)\s*(?=[=;,):])/g)) {
        locals.push({ method: method.id, name: match[2], typeName: match[1], line: atLine(method.start + match.index) });
      }
    }
  }
  return { symbols, nodes, methods, callSites, injects, fields, classes, locals };
}

function extractBindings(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text); const bindings = [];
  const add = (trigger, handler, type, offset) => {
    if (!handler) return;
    bindings.push({ trigger: `${rel}#${trigger}`, handler_name: handler, type, file: rel, line: atLine(offset), workspace: workspace.id });
  };
  const dotnetEvent = /(?:this\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\+=\s*(?:new\s+[\w.]+(?:<[^>]+>)?\s*\(\s*)?(?:this\.)?([A-Za-z_]\w*)/g;
  for (const match of clean.matchAll(dotnetEvent)) add(`${match[1]}.${match[2]}`, match[3], "ui_event", match.index);
  /*
   * `onclick="javascript:fnSave();"`·`onclick="return fnCheck()"`의 `javascript`·`return`을 핸들러로
   * 읽고 있었다 — 실측(레거시 JSP 1,815개)에서 미해결 트리거 937건이 `javascript` 하나였다.
   * 접두어를 건너뛰고, `self.close()`·`window.open()`처럼 이름 뒤에 `.`이 오는 브라우저 객체 호출은
   * 이벤트 핸들러 바인딩이 아니므로 뺀다.
   */
  const markupEvent = /<([A-Za-z_:][\w:.-]*)\b[^>]*\b(?:OnClick|Click|OnCommand|Command)\s*=\s*["'](?:\{Binding\s+)?\s*(?:javascript\s*:\s*)?(?:return\s+)?([A-Za-z_]\w*)(\s*\.)?[^"']*["']/gi;
  for (const match of text.matchAll(markupEvent)) if (!match[3]) add(`${match[1]}.${match[2]}`, match[2], "markup_event", match.index);
  const jsxEvent = /\b(on[A-Z][A-Za-z0-9_]*)\s*=\s*\{\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*\}/g;
  for (const match of text.matchAll(jsxEvent)) add(`jsx.${match[1]}`, match[2], "ui_event", match.index);
  /*
   * Vue 템플릿 이벤트 바인딩(`@click="save"`, `v-on:click="save"`). 인덱서는 `<script>` 블록만
   * 읽고 `<template>`은 안 읽어서(index_extractor_vue.py 설계상 의도적 스킵) 이 바인딩이 완전히
   * 안 잡혔다(2026-08-19 실측, 프론트엔드 195건이 analyzer가 직접 판정). `text`(원문, 마크업 포함)
   * 기준이라 `<template>` 안까지 정규식이 닿는다 — 다른 마크업 이벤트(markupEvent)와 같은 방식.
   */
  if (extname(rel).toLowerCase() === ".vue") {
    const vueEvent = /(?:@|\bv-on:)([\w-]+)(?:\.\w+)*\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*(?:\([^"']*\))?\s*["']/g;
    for (const match of text.matchAll(vueEvent)) add(`vue.${match[1]}`, match[2], "ui_event", match.index);
  }
  const scheduled = /@Scheduled\s*\(([^)]*)\)/g;
  for (const match of clean.matchAll(scheduled)) add(`scheduled:${match[1].replace(/\s+/g, " ").slice(0, 80)}`, nextMethod(methods, atLine(match.index))?.name, "scheduler", match.index);
  const main = methods.find((method) => /^(?:main|Main)$/i.test(method.name));
  if (main) add("process-entry", main.name, "process_entry", Math.max(0, main.start));
  return bindings;
}

function quotedValue(value = "") {
  return value.match(/["'`]([^"'`]*)["'`]/)?.[1] || "";
}

function normalizePath(path) {
  const value = (`/${path || ""}`).replace(/\/+/g, "/").replace(/\/\/+/, "/");
  return value.replace(/\$\{[^}]+\}|\{[^}]+\}|:\w+|\[[^\]]+\]/g, "{param}").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function pythonModule(rel) {
  return slash(rel).replace(/\.py$/i, "").replace(/\/__init__$/i, "").replaceAll("/", ".");
}

function resolvePythonImport(ownerModule, source) {
  if (!source.startsWith(".")) return source;
  const dots = source.match(/^\.+/)?.[0].length || 0;
  const suffix = source.slice(dots);
  const parts = ownerModule.split(".").slice(0, -1);
  for (let i = 1; i < dots; i += 1) parts.pop();
  return [...parts, suffix].filter(Boolean).join(".");
}

function extractFastApiMeta(text, clean, rel) {
  if (!rel.toLowerCase().endsWith(".py")) return null;
  const module = pythonModule(rel);
  const constants = [];
  for (const match of clean.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*[rubfRUBF]*(["'])([^\n]*?)\2\s*$/gm)) {
    constants.push({ name: match[1], value: match[3], module });
  }
  const imports = {};
  for (const match of clean.matchAll(/^[ \t]*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm)) {
    const source = resolvePythonImport(module, match[1]);
    for (const entry of match[2].replace(/[()]/g, "").split(",")) {
      const item = entry.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (item) imports[item[2] || item[1]] = `${source}.${item[1]}`;
    }
  }
  for (const match of clean.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
    imports[match[2] || match[1].split(".").at(-1)] = match[1];
  }
  const routerPrefixes = {};
  for (const match of clean.matchAll(/^[ \t]*(\w+)\s*=\s*APIRouter\s*\(([^)]*)\)/gm)) {
    const prefix = match[2].match(/\bprefix\s*=\s*([furbFURB]*["'][^"']*["']|[^,\n)]+)/)?.[1]?.trim();
    if (prefix) routerPrefixes[match[1]] = prefix;
  }
  const mounts = [];
  const includeRouter = /\binclude_router\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*,([\s\S]*?)\)\s*(?:\n|$)/g;
  for (const match of clean.matchAll(includeRouter)) {
    const reference = match[1]; const head = reference.split(".")[0];
    const imported = imports[head] ? `${imports[head]}${reference.slice(head.length)}` : reference;
    const targetModule = imported.replace(/\.router$/, "");
    const prefixExpression = match[2].match(/\bprefix\s*=\s*([furbFURB]*["'][^"']*["']|[^,\n)]+)/)?.[1]?.trim() || "\"\"";
    mounts.push({ ownerModule: module, targetModule, prefixExpression });
  }
  return { module, constants, imports, routerPrefixes, mounts, appRoot: /\bFastAPI\s*\(/.test(clean) };
}

function resolveStaticPythonString(expression, constants) {
  const value = String(expression || "").trim();
  const literal = value.match(/^[furbFURB]*(["'])([\s\S]*)\1$/);
  if (literal) {
    let resolved = literal[2]; let complete = true;
    resolved = resolved.replace(/\{([^}]+)\}/g, (_, reference) => {
      const name = reference.trim().split(".").at(-1);
      if (!constants.has(name)) { complete = false; return ""; }
      return constants.get(name);
    });
    return complete ? resolved : null;
  }
  const name = value.split(".").at(-1);
  return constants.get(name) ?? null;
}

function joinApiPath(...parts) {
  return normalizePath(parts.filter(Boolean).join("/"));
}

function composeFastApiEndpoints(facts, endpoints) {
  const metas = facts.map((item) => item.fastApi).filter(Boolean);
  if (!metas.length) return endpoints;
  const constants = new Map(); const conflicts = new Set();
  for (const item of metas.flatMap((meta) => meta.constants || [])) {
    if (constants.has(item.name) && constants.get(item.name) !== item.value) conflicts.add(item.name);
    else constants.set(item.name, item.value);
  }
  for (const name of conflicts) constants.delete(name);
  const prefixes = new Map(); const queue = [];
  for (const meta of metas.filter((item) => item.appRoot)) {
    prefixes.set(meta.module, new Set([""])); queue.push(meta.module);
  }
  const resolvedMounts = metas.flatMap((meta) => meta.mounts || []).map((mount) => ({
    ...mount, prefix: resolveStaticPythonString(mount.prefixExpression, constants),
  }));
  const unresolvedTargets = new Set(resolvedMounts.filter((mount) => mount.prefix === null).map((mount) => mount.targetModule));
  const mounts = resolvedMounts.filter((mount) => mount.prefix !== null);
  if (!queue.length) for (const owner of new Set(mounts.map((mount) => mount.ownerModule))) {
    if (mounts.some((mount) => mount.targetModule === owner)) continue;
    prefixes.set(owner, new Set([""])); queue.push(owner);
  }
  while (queue.length) {
    const owner = queue.shift();
    for (const mount of mounts.filter((item) => item.ownerModule === owner)) {
      const target = prefixes.get(mount.targetModule) || new Set(); const before = target.size;
      for (const base of prefixes.get(owner) || [""]) target.add(joinApiPath(base, mount.prefix));
      prefixes.set(mount.targetModule, target);
      if (target.size > before) queue.push(mount.targetModule);
    }
  }
  const metaByModule = new Map(metas.map((meta) => [meta.module, meta]));
  return endpoints.flatMap((endpoint) => {
    if (endpoint.framework !== "fastapi") return [endpoint];
    const module = pythonModule(endpoint.file); const meta = metaByModule.get(module);
    const mounted = [...(prefixes.get(module) || new Set([""]))];
    const localExpression = meta?.routerPrefixes?.[endpoint.router];
    const localPrefix = localExpression ? resolveStaticPythonString(localExpression, constants) : "";
    if ((localExpression && localPrefix === null) || (unresolvedTargets.has(module) && !prefixes.has(module))) {
      return [{ ...endpoint, prefix_resolved: false, confidence: "LOW" }];
    }
    return mounted.map((base) => {
      const path = joinApiPath(base, localPrefix || "", endpoint.path);
      return { ...endpoint, path, path_pattern: normalizePath(path), prefix_resolved: true, id: `${endpoint.workspace}::${endpoint.method} ${normalizePath(path)}::${endpoint.handler}` };
    });
  });
}

function nextMethod(methods, line) {
  /* line 이상인 것 중 line이 가장 작은(동률이면 원래 순서가 앞선) 메서드 = 정렬 배열의 lower bound. */
  const sorted = lineOrdered(methods);
  let low = -1;
  let high = sorted.length;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid].line >= line) high = mid;
    else low = mid;
  }
  return sorted[high];
}

/*
 * offset을 포함하는(start <= offset < end) 메서드 중 가장 안쪽(start가 가장 큰) 것을 찾는다.
 * nextMethod가 "offset 이후 첫 메서드"라면 이건 "offset을 감싸는 메서드"다 — 방향이 반대다.
 * 인라인 SQL 문자열은 메서드 본문 안에 있으므로, 그 SQL을 실제로 실행하는 메서드를 이걸로
 * 찾아야 data_flow가 endpoint→method→SQL 체인을 연결할 수 있다(2026-08-27 추가). 애노테이션
 * (@Query 등)은 메서드 선언 위에 붙어 본문 밖이라 여기 해당하지 않고 nextMethod를 쓴다.
 */
function enclosingMethod(methods, offset) {
  let best = null;
  for (const m of methods) {
    if (m.start <= offset && offset < m.end && (!best || m.start > best.start)) best = m;
  }
  return best;
}

function extractApi(text, clean, rel, workspace, methods, classes = []) {
  const atLine = lineIndex(text);
  const endpoints = [];
  const consumers = [];
  const addEndpoint = (method, path, handler, offset, extra = {}) => endpoints.push({
    id: `${workspace.id}::${method.toUpperCase()} ${normalizePath(path)}::${handler || basename(rel)}`,
    workspace: workspace.id, source: "local", method: method.toUpperCase(), path: path || "/", path_pattern: normalizePath(path),
    handler: handler || basename(rel), file: rel, line: atLine(offset), origin: "deterministic-indexer", confidence: "HIGH", ...extra,
  });
  const addConsumer = (callType, method, path, offset, fn = "") => consumers.push({
    id: `${workspace.id}::${rel}:${atLine(offset)}::${method.toUpperCase()} ${normalizePath(path)}`,
    workspace: workspace.id, source: "local", call_type: callType, method: method.toUpperCase(), path_literal: path,
    path_pattern: normalizePath(path), file: rel, line: atLine(offset), ...(fn ? { function: fn } : {}),
    consumer_kind: workspace.kind, origin: "deterministic-indexer", confidence: path.includes("+") ? "MEDIUM" : "HIGH",
  });
  const classBaseAt = (offset) => {
    const owner = classes.filter((item) => item.start <= offset && offset < item.end).sort((a, b) => b.start - a.start)[0];
    if (!owner) return "";
    const prefix = clean.slice(Math.max(0, owner.start - 600), owner.start);
    const java = [...prefix.matchAll(/@RequestMapping\s*(?:\(([^)]*)\))?/g)].at(-1);
    /* [Route("api/[controller]")]의 내부 ]를 속성 종료로 오인하지 않는다. */
    const csharpRoute = [...prefix.matchAll(/\[Route\s*\(\s*(["'])([\s\S]*?)\1\s*\)\]/g)].at(-1);
    let value = quotedValue(java?.[1] || csharpRoute?.[0]);
    if (csharpRoute && owner) value = value.replace(/\[controller\]/gi, owner.name.replace(/Controller$/i, ""));
    return value;
  };

  const javaRoute = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(([^)]*)\))?/gm;
  for (const match of clean.matchAll(javaRoute)) {
    const after = clean.slice(match.index + match[0].length, match.index + match[0].length + 500);
    if (/^\s*(?:public\s+)?(?:class|interface)\b/.test(after)) continue;
    const routeMethod = match[1] === "RequestMapping"
      ? (match[2]?.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/)?.[1] || "ANY")
      : match[1].replace("Mapping", "").toUpperCase();
    const path = joinApiPath(classBaseAt(match.index), quotedValue(match[2]) || "/");
    const handler = nextMethod(methods, atLine(match.index))?.id || basename(rel);
    addEndpoint(routeMethod, path, handler, match.index);
  }
  const fastApi = /@(\w+)\.(get|post|put|delete|patch)\s*\(([^)]*)\)/g;
  for (const match of clean.matchAll(fastApi)) addEndpoint(match[2], quotedValue(match[3]), nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "fastapi", router: match[1] });
  const flask = /@(\w+)\.route\s*\(\s*(["'])([^"']+)\2([^)]*)\)/g;
  for (const match of clean.matchAll(flask)) {
    const declared = [...match[4].matchAll(/["'](GET|POST|PUT|DELETE|PATCH)["']/gi)].map((item) => item[1]);
    for (const method of declared.length ? declared : ["GET"]) addEndpoint(method, match[3], nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "flask", router: match[1] });
  }
  const django = /\b(?:path|re_path)\s*\(\s*(["'])([^"']+)\1\s*,\s*([\w.]+)/g;
  for (const match of clean.matchAll(django)) addEndpoint("ANY", `/${match[2]}`, match[3], match.index, { framework: "django" });
  const express = /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|use)\s*\(\s*(["'`])([^"'`]+)\2\s*,\s*([\w.]+)/g;
  for (const match of clean.matchAll(express)) if (clean[match.index - 1] !== "@") addEndpoint(match[1], match[3], match[4], match.index, { framework: "express" });
  const csharp = /\[Http(Get|Post|Put|Delete|Patch)(?:\(([^\]]*)\))?\]/g;
  for (const match of clean.matchAll(csharp)) addEndpoint(match[1], joinApiPath(classBaseAt(match.index), quotedValue(match[2]) || "/"), nextMethod(methods, atLine(match.index))?.id, match.index, { framework: "aspnet" });
  /*
   * Struts <action>과 servlet-mapping.
   * 예전 정규식은 한 태그 안에서 path 뒤에 type이 오는 형태만 잡아, 속성 순서가 다르거나
   * forward/include만 있는 action을 통째로 놓쳤다(2026-08-15 실사고 — 수동 병합 스크립트로 메웠던 건).
   * 주석 처리된 설정을 살아 있는 매핑으로 세지 않도록 XML 주석은 길이를 보존하며 지운다 —
   * atLine(match.index)이 원본 줄 번호를 그대로 가리켜야 하기 때문이다.
   */
  const xmlLive = /<action\b|<servlet-mapping\b/i.test(text)
    ? text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, " "))
    : text;
  const struts = /<action\b([^>]*)>/gi;
  for (const match of xmlLive.matchAll(struts)) {
    const attrs = xmlAttrs(match[1]);
    if (!attrs.path) continue;
    /*
     * command 속성(Spring bean id)이 있으면 실제 비즈니스 로직을 쥔 서비스를 가리킨다 — `type`은
     * 흔히 커맨드 패턴 공용 디스패처(예: WorkerAction) 하나로 전체 액션이 몰려 있어 그것만으로는
     * data_flow 체인 추적이 불가능하다(2026-08-17 xu25-server 실측: 443개 중 434개가 같은 type).
     * `handler`는 기존 동작(데드 코드 화이트리스트 등) 보존을 위해 그대로 두고, dispatch_bean만 얹는다.
     */
    addEndpoint("ANY", attrs.path, attrs.type || attrs.forward || attrs.include || attrs.name, match.index, { framework: "struts", ...(attrs.command ? { dispatch_bean: attrs.command } : {}) });
  }
  const servletPattern = /<servlet-mapping>[\s\S]*?<servlet-name>\s*([^<]+)\s*<\/servlet-name>[\s\S]*?<url-pattern>\s*([^<]+)\s*<\/url-pattern>[\s\S]*?<\/servlet-mapping>/gi;
  for (const match of xmlLive.matchAll(servletPattern)) addEndpoint("ANY", match[2], match[1].trim(), match.index, { framework: "servlet" });
  if (/\.(?:asp|aspx|ashx|asmx)$/i.test(rel)) addEndpoint("ANY", `/${rel}`, basename(rel), 0, { framework: rel.toLowerCase().endsWith(".asp") ? "classic-asp" : "aspnet-webforms" });

  const axios = /\baxios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of clean.matchAll(axios)) addConsumer("axios", match[1], match[3], match.index);
  const fetchCall = /\b(fetch|useFetch|\$fetch)\s*\(\s*(["'`])([^"'`]+)\2\s*(?:,\s*\{([\s\S]{0,300}?)\})?/g;
  for (const match of clean.matchAll(fetchCall)) {
    const method = match[4]?.match(/method\s*:\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer(match[1], method, match[3], match.index);
  }
  const httpClient = /\b(?:GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync)\s*\(\s*\$?(["'])([^"']+)\1/g;
  for (const match of clean.matchAll(httpClient)) addConsumer("HttpClient", match[0].match(/(Get|Post|Put|Delete|Patch)Async/)?.[1] || "GET", match[2], match.index);
  const restSharp = /new\s+RestRequest\s*\(\s*(["'])([^"']+)\1\s*,\s*Method\.(Get|Post|Put|Delete|Patch)/g;
  for (const match of clean.matchAll(restSharp)) addConsumer("RestSharp", match[3], match[2], match.index);
  const refit = /\[(Get|Post|Put|Delete|Patch)\s*\(\s*(["'])([^"']+)\2\s*\)\]/g;
  for (const match of clean.matchAll(refit)) addConsumer("Refit", match[1], match[3], match.index, nextMethod(methods, atLine(match.index))?.id);
  const retrofit = /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of clean.matchAll(retrofit)) addConsumer("Retrofit", match[1], match[2], match.index, nextMethod(methods, atLine(match.index))?.id);
  const form = /<form\b([^>]*)>/gi;
  for (const match of text.matchAll(form)) {
    const path = match[1].match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1]; if (!path) continue;
    const method = match[1].match(/\bmethod\s*=\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer("html-form", method, path, match.index);
  }
  const jqueryAjax = /\$\.ajax\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
  for (const match of text.matchAll(jqueryAjax)) {
    const path = match[1].match(/\burl\s*:\s*["']([^"']+)["']/i)?.[1]; if (!path) continue;
    const method = match[1].match(/\b(?:type|method)\s*:\s*["'](\w+)["']/i)?.[1] || "GET";
    addConsumer("jquery-ajax", method, path, match.index);
  }
  return { endpoints, consumers };
}

/*
 * FROM/JOIN 절에서 나오지만 테이블이 아닌 것들. 걸러내지 않으면 ROWNUM이 사용 빈도 467회짜리
 * "테이블"로 잡힌다(2026-08-16 실측).
 */
const SQL_PSEUDO_TABLES = new Set([
  "dual", "rownum", "rowid", "sysdate", "systimestamp", "level", "nextval", "currval",
  "user", "sysdba", "values", "lateral", "unnest", "table", "select",
]);

/*
 * FROM 절의 콤마 구분 테이블 목록을 괄호 깊이를 세어 나눈다.
 * 예전의 부정 전방탐색 근사("콤마 뒤에 닫는 괄호가 있으면 함수 인자다")는 Oracle 페이징 관용구
 * (`FROM( SELECT ... FROM A a, B b ) X ) Y`)처럼 바깥 서브쿼리의 닫는 괄호가 뒤에 붙으면
 * 최상위 콤마까지 안 나뉘어 두 번째 테이블부터 통째로 누락됐다(2026-08-16 실측).
 * depth 0에서 닫는 괄호를 만나면 그 자리가 FROM 절의 끝이다.
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

function sqlTables(sql) {
  const tables = [...sql.matchAll(/\b(?:from|join|update|into|table)\s+([\w.$"`]+)/gi)].map((match) => match[1].replace(/["`]/g, ""));
  for (const from of sql.matchAll(/\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\bunion\b|$)/gi)) {
    for (const part of splitTopLevelCommas(from[1]).slice(1)) {
      const table = part.trim().match(/^([\w.$"`]+)(?:\s+(?:as\s+)?[\w$]+)?/i)?.[1];
      if (table && !/^(?:select|join|left|right|inner|outer|full|cross)$/i.test(table)) tables.push(table.replace(/["`]/g, ""));
    }
  }
  return tables.filter((name) => !SQL_PSEUDO_TABLES.has(name.split(".").at(-1).toLowerCase()));
}

const SQL_ALIAS_STOP = new Set(["where", "left", "right", "inner", "outer", "full", "cross", "join", "on", "group", "order", "having", "union", "limit", "offset", "connect", "start"]);

function extractSqlRelations(sql, context) {
  const aliases = new Map();
  const addAlias = (tableValue, aliasValue = "") => {
    const table = String(tableValue || "").replace(/["`]/g, "");
    if (!table || table.startsWith("(")) return;
    const simple = table.split(".").at(-1);
    const alias = SQL_ALIAS_STOP.has(String(aliasValue).toLowerCase()) ? "" : String(aliasValue || "");
    aliases.set(simple.toLowerCase(), table);
    aliases.set(table.toLowerCase(), table);
    if (alias) aliases.set(alias.toLowerCase(), table);
  };
  for (const match of sql.matchAll(/\b(?:from|join)\s+([\w.$"`]+)(?:\s+(?:as\s+)?([\w$]+))?/gi)) addAlias(match[1], match[2]);
  for (const from of sql.matchAll(/\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\bunion\b|$)/gi)) {
    for (const part of splitTopLevelCommas(from[1])) {
      const match = part.trim().match(/^([\w.$"`]+)(?:\s+(?:as\s+)?([\w$]+))?/i);
      if (match) addAlias(match[1], match[2]);
    }
  }
  const relations = [];
  /*
   * 조인 조건마다 `sql.slice(0, index).split(/\r?\n/)`로 줄 번호를 세면 문자열 복사 + 분할이
   * 매치 수 × SQL 길이만큼 반복된다. 매치는 오프셋 오름차순으로 오므로 직전 위치부터
   * 증분으로 개행만 세면 SQL 전체를 한 번 훑는 비용으로 끝난다.
   */
  let scanned = 0;
  let newlines = 0;
  const lineAtOffset = (offset) => {
    for (; scanned < offset; scanned += 1) if (sql.charCodeAt(scanned) === 10) newlines += 1;
    return context.line + newlines;
  };
  for (const match of sql.matchAll(/\b([\w$]+)\.([\w$]+)\s*=\s*([\w$]+)\.([\w$]+)\b/gi)) {
    const fromTable = aliases.get(match[1].toLowerCase());
    const toTable = aliases.get(match[3].toLowerCase());
    if (!fromTable || !toTable) continue;
    const line = lineAtOffset(match.index);
    relations.push({
      type: "query_join", from_table: fromTable, from_columns: [match[2]],
      to_table: toTable, to_columns: [match[4]], sql_id: context.sql_id,
      file: context.file, line, evidence: match[0].replace(/\s+/g, " ").trim(),
      origin: "deterministic-indexer", confidence: "MEDIUM",
    });
  }
  return relations;
}

/* 키워드만 보지 않고 문장 모양까지 확인한다 — UI 문자열·번역 문구가 SQL로 잡히는 것을 막기 위함. */
function sqlStatementType(statement) {
  const normalized = statement.replace(/\\(?:r|n|t)/g, " ").replace(/\s+/g, " ").trim();
  if (/^select\s+[\s\S]+?\s+from\s+[\w$`"[\].(]+/i.test(normalized)) return "select";
  if (/^insert\s+into\s+[\w$`"[\].]+(?:\s|\()/i.test(normalized)) return "insert";
  if (/^update\s+[\w$`"[\].]+\s+set\s+/i.test(normalized)) return "update";
  if (/^delete\s+from\s+[\w$`"[\].]+(?:\s|$)/i.test(normalized)) return "delete";
  if (/^merge\s+into\s+[\w$`"[\].]+/i.test(normalized)) return "merge";
  if (/^(create|alter|drop)\s+/i.test(normalized)) return "ddl";
  return null;
}

/*
 * 쿼리 ID 상수 참조. 위 usage 정규식은 `selectList("ID")`처럼 호출 안에 리터럴이 있는 형태만 잡는데,
 * 레거시는 `String queryId = "DEMAND_..._S00";`처럼 변수에 담아 쓰는 경우가 더 많다.
 * 여기서는 모양이 맞는 리터럴을 후보로만 모으고, 실제 SQL id와 일치하는 것만 aggregate에서 남긴다.
 */
const SQL_ID_LITERAL_RE = /["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,})["']/g;

function extractSql(text, clean, rel, methods) {
  const atLine = lineIndex(text);
  const sqls = [];
  const usages = [];
  const relations = [];
  const mapper = /<(select|insert|update|delete)\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const namespace = text.match(/<mapper\b[^>]*namespace\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  /*
   * iBatis 2 `<sqlMap namespace="Order">`. Java는 보통 `queryForList("Order.list")`로 부르므로
   * id에 namespace를 붙이고 `statement_id`에 짧은 id를 남긴다 — useStatementNamespaces=false로
   * `"list"`만 쓰는 프로젝트는 aggregate가 짧은 id로 되짚는다.
   */
  const sqlMapNamespace = namespace ? "" : text.match(/<sqlMap\b[^>]*namespace\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  const statementId = (raw) => (namespace ? `${namespace}.${raw}` : sqlMapNamespace ? `${sqlMapNamespace}.${raw}` : raw);
  const shortId = (raw) => (sqlMapNamespace ? { statement_id: raw } : {});
  const callableTarget = (body) => body.replace(/<!\[CDATA\[/g, "").match(PROCEDURE_CALL_TEXT)?.[1]?.replace(/"/g, "").replace(/\s+/g, "").toUpperCase();
  /* 프로시저 호출 문장은 SQL이 아니라 호출 관계다 — sql_usage가 아니라 call_graph 엣지가 된다(aggregate). */
  const callables = [];
  for (const match of text.matchAll(/<procedure\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/procedure>/gi)) {
    const procedure = callableTarget(match[2]);
    if (procedure) callables.push({ id: statementId(match[1]), ...shortId(match[1]), procedure, file: rel, line: atLine(match.index) });
  }
  for (const match of text.matchAll(mapper)) {
    /*
     * HTML/JSP/ASP의 <select id="cmbLanguages"> 드롭다운도 이 정규식에 걸린다.
     * 레거시 화면이 많은 프로젝트에서 실제로 수백 건이 SQL로 잘못 등록됐다 —
     * MyBatis 매퍼 파일이 아니면 본문이 SQL 모양일 때만 인정한다.
     */
    /* statementType="CALLABLE"의 `{call PKG.PROC(...)}` — 이 SQL id를 쓰는 메서드가 프로시저를 부른다(aggregate가 잇는다). */
    const callable = callableTarget(match[3]);
    if (sqlMapNamespace && callable) {
      callables.push({ id: statementId(match[2]), ...shortId(match[2]), procedure: callable, file: rel, line: atLine(match.index) });
      continue;
    }
    if (!namespace && !sqlStatementType(match[3])) continue;
    const id = statementId(match[2]);
    sqls.push({ id, ...shortId(match[2]), file: rel, line: atLine(match.index), type: match[1].toLowerCase(), tables: [...new Set(sqlTables(match[3]))], text_preview: match[3].replace(/\s+/g, " ").trim().slice(0, 240), ...(callable ? { procedure: callable } : {}), origin: "deterministic-indexer", confidence: "HIGH" });
    relations.push(...extractSqlRelations(match[3], { sql_id: id, file: rel, line: atLine(match.index) }));
    if (namespace) usages.push({ sql_id: id, file: rel, line: atLine(match.index), method: id, evidence: "MyBatis mapper namespace + statement id", origin: "deterministic-indexer", confidence: "HIGH" });
  }
  /*
   * 국내 SI에서 흔한 자체 쿼리 컨테이너: <query><id>X</id><value><![CDATA[ SELECT ... ]]></value></query>.
   * MyBatis도 JPA도 아니라 위 어댑터가 전부 놓친다 — 실측(레거시 Java 4,883파일)에서 이 형식이
   * 전체 SQL의 90%였는데 519건만 잡히고 있었다. 태그명은 프레임워크마다 달라 알려진 이름만 받고,
   * 본문이 실제 SQL 모양일 때만 인정한다.
   */
  const container = /<(query|statement|sql|sqlQuery|queryString)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const block of text.matchAll(container)) {
    const id = block[2].match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
    const rawValue = block[2].match(/<value>([\s\S]*?)<\/value>/i)?.[1];
    if (!id || !rawValue) continue;
    const statement = rawValue.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
    /*
     * 저장 프로시저 호출 `{CALL PR_X(?, ?)}`. 문장 모양 검사에 안 걸려 통째로 빠졌다 — 실측(eduLms)
     * CALL 70건이 전부 누락돼 수강신청 등록(PR_LS_APPLY_FRONT_PROC)이 sql·call_graph 어디에도 없었다.
     * MyBatis 매퍼처럼 sql_usage 에 procedure 를 달아 남기면, 이 id 를 쓰는 메서드 → 프로시저 엣지는
     * aggregate 가 이어 준다.
     */
    const procedure = callableTarget(statement);
    const type = sqlStatementType(statement) || (procedure ? "call" : null);
    if (!type) continue;
    const line = atLine(block.index);
    sqls.push({ id, file: rel, line, type, tables: [...new Set(sqlTables(statement))], text_preview: statement.replace(/\s+/g, " ").trim().slice(0, 240), ...(procedure ? { procedure } : {}), origin: "deterministic-indexer", confidence: "HIGH" });
    relations.push(...extractSqlRelations(statement, { sql_id: id, file: rel, line }));
  }
  const annotation = /@(Query|Select|Insert|Update|Delete)\s*\(\s*(["'])([\s\S]*?)\2\s*\)/gi;
  for (const match of text.matchAll(annotation)) {
    const keyword = match[3].trim().match(/^(select|insert|update|delete|create|alter|drop)/i)?.[1]?.toLowerCase();
    const type = ["create", "alter", "drop"].includes(keyword) ? "ddl" : keyword || match[1].toLowerCase().replace("query", "select");
    const id = `${rel}:${atLine(match.index)}`;
    sqls.push({ id, file: rel, line: atLine(match.index), type, tables: [...new Set(sqlTables(match[3]))], text_preview: match[3].replace(/\s+/g, " ").slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(match[3], { sql_id: id, file: rel, line: atLine(match.index) }));
    /* @Query는 메서드 선언 위에 붙으므로 그 메서드(nextMethod)를 SQL 실행 주체로 잇는다. */
    const decorated = nextMethod(methods, atLine(match.index));
    if (decorated) usages.push({ sql_id: id, file: rel, line: atLine(match.index), method: decorated.id, evidence: "SQL 애노테이션이 데코레이트한 메서드", origin: "deterministic-indexer", confidence: "MEDIUM" });
  }
  const procedureCalls = [];
  for (const lit of extractStringLiterals(clean)) {
    const callable = lit.content.match(PROCEDURE_CALL_TEXT)?.[1];
    const caller = callable && enclosingMethod(methods, lit.start);
    if (caller) procedureCalls.push({ caller: caller.id, ...procedureTarget(callable), file: rel, line: atLine(lit.start) });
    if (lit.content.length < 8 || lit.content.length > 1000) continue;
    const normalized = lit.content.replace(/\\(?:r|n|t)/g, " ").replace(/\s+/g, " ").trim();
    const type = normalized.match(/^select\s+[\s\S]+?\s+from\s+[\w$`"[\].]+(?:\s|$)/i) ? "select"
      : normalized.match(/^insert\s+into\s+[\w$`"[\].]+(?:\s|\()/i) ? "insert"
      : normalized.match(/^update\s+[\w$`"[\].]+\s+set\s+/i) ? "update"
      : normalized.match(/^delete\s+from\s+[\w$`"[\].]+(?:\s|$)/i) ? "delete"
      : null;
    if (!type) continue;
    const id = `${rel}:${atLine(lit.start)}:raw`;
    sqls.push({ id, file: rel, line: atLine(lit.start), type, tables: [...new Set(sqlTables(lit.content))], text_preview: normalized.slice(0, 240), origin: "deterministic-indexer", confidence: "MEDIUM" });
    relations.push(...extractSqlRelations(lit.content, { sql_id: id, file: rel, line: atLine(lit.start) }));
    /* 인라인 raw SQL은 메서드 본문 안에 있으므로 그 SQL을 실행하는 메서드(enclosingMethod)를
     * usage로 잇는다 — MyBatis/JPA 없이 ADO.NET/JDBC로 SQL을 직접 쓰는 프로젝트에서 data_flow가
     * endpoint→method→테이블 체인을 만들 수 있게 하는 연결고리다(2026-08-27 추가). */
    const owner = enclosingMethod(methods, lit.start);
    if (owner) usages.push({ sql_id: id, file: rel, line: atLine(lit.start), method: owner.id, evidence: "메서드 본문 내 인라인 SQL 리터럴", origin: "deterministic-indexer", confidence: "MEDIUM" });
  }
  const usage = /\b(?:selectOne|selectList|insert|update|delete|queryForObject|queryForList)\s*\(\s*["']([^"']+)["']/g;
  /*
   * `sqlSession.selectList("id")`·쿼리 ID 상수는 메서드 본문 안에 있다 — 감싸는 메서드가 실행 주체다.
   * nextMethod("이 줄 이후 첫 메서드")만 쓰면 여러 줄짜리 메서드에서 사용처가 **다음 메서드**로 잡혀
   * data_flow·영향도가 엉뚱한 메서드를 가리켰다. 본문 밖(필드 초기화 등)일 때만 예전처럼 다음 메서드로 둔다.
   */
  const executingMethod = (offset) => enclosingMethod(methods, offset) || nextMethod(methods, atLine(offset));
  for (const match of text.matchAll(usage)) usages.push({ sql_id: match[1], file: rel, line: atLine(match.index), method: executingMethod(match.index)?.id || "unknown", origin: "deterministic-indexer", confidence: "HIGH" });
  for (const match of text.matchAll(SQL_ID_LITERAL_RE)) {
    const line = atLine(match.index);
    usages.push({ sql_id: match[1], file: rel, line, method: executingMethod(match.index)?.id || "unknown", evidence: "쿼리 ID 상수 참조", candidate: true, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return { sqls, usages, relations, procedureCalls, callables };
}

function extractTransactions(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text);
  const boundaries = [];
  const marker = /@Transactional(?:\(([^)]*)\))?|\b(?:session\.begin|\$transaction|(?:\w+\.)?BeginTransaction(?:Async)?|new\s+TransactionScope)\s*\(/g;
  for (const match of clean.matchAll(marker)) {
    const entry = rangeFinder(methods).at(match.index)
      || nextMethod(methods, atLine(match.index));
    if (!entry) continue;
    const args = match[1] || "";
    boundaries.push({
      id: `${entry.id}@${entry.line}`, entry_method: entry.id, file: rel, line: atLine(match.index), marker: match[0].split("(")[0],
      ...(args.match(/propagation\s*=\s*(?:Propagation\.)?(\w+)/)?.[1] ? { propagation: args.match(/propagation\s*=\s*(?:Propagation\.)?(\w+)/)[1] } : {}),
      ...(args.match(/isolation\s*=\s*(?:Isolation\.)?(\w+)/)?.[1] ? { isolation: args.match(/isolation\s*=\s*(?:Isolation\.)?(\w+)/)[1] } : {}),
      methods_in_scope: [entry.id], external_io_calls: [], workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH",
    });
  }
  return boundaries;
}

const IO_CLIENT_TYPES = new Map([
  ["RestTemplate", "http"], ["WebClient", "http"], ["HttpClient", "http"],
  ["KafkaTemplate", "kafka_producer"], ["KafkaProducer", "kafka_producer"],
  ["RedisTemplate", "redis"], ["StringRedisTemplate", "redis"],
  ["JavaMailSender", "mail"],
]);
/* `RestTemplate rest;`·`KafkaTemplate<String, Map<String, Object>> kafka =`·생성자 파라미터 `(HttpClient http,` */
const IO_CLIENT_DECLARATION = new RegExp(String.raw`\b(${[...IO_CLIENT_TYPES.keys()].join("|")})(?:<[^;=(){}]*>)?\s+([A-Za-z_$][\w$]*)\s*[;=),]`, "g");

function extractExternalIo(text, clean, rel, workspace, methods) {
  const atLine = lineIndex(text);
  const communications = [];
  const patterns = [
    ["http", /\b(RestTemplate|WebClient|HttpClient|RestSharp|axios|fetch|httpx|requests)\b/g],
    ["kafka_producer", /\b(KafkaTemplate|KafkaProducer)\b/g],
    ["kafka_consumer", /@KafkaListener\s*\(([^)]*)\)/g],
    ["rabbit_consumer", /@RabbitListener\s*\(([^)]*)\)/g],
    ["file_io", /\b(FileInputStream|FileOutputStream|Files\.(?:read|write)|readFile|writeFile|open)\s*\(/g],
    ["redis", /\b(RedisTemplate|StringRedisTemplate|ioredis|redis\.createClient)\b/g],
    ["mail", /\b(JavaMailSender|smtplib|nodemailer)\b/g],
  ];
  /*
   * 주입·필드로 받은 클라이언트의 호출. `private final RestTemplate restTemplate;` 뒤의
   * `restTemplate.postForObject("http://erp/api", ...)`는 호출 줄에 타입 이름이 없어 위 패턴이 못 잡고,
   * 대신 필드 선언 줄이 통신으로 남아 엉뚱한 메서드에 붙었다. 선언에서 변수 → 통신 종류를 모으고
   * 메서드 본문 안의 `변수.메서드(` 호출을 기록한다. 첫 인자가 문자열이면 그것(URL·토픽)이 대상이다.
   */
  const clientTypeOf = new Map();
  for (const match of clean.matchAll(IO_CLIENT_DECLARATION)) clientTypeOf.set(match[2], match[1]);
  const callTypes = new Set();
  if (clientTypeOf.size) {
    const names = [...clientTypeOf.keys()].map((name) => name.replace(/\$/g, "\\$")).join("|");
    for (const match of clean.matchAll(new RegExp(String.raw`\b(${names})\s*\.\s*(\w+)\s*\(`, "g"))) {
      const owner = enclosingMethod(methods, match.index);
      if (!owner) continue;
      const clientType = clientTypeOf.get(match[1]);
      const type = IO_CLIENT_TYPES.get(clientType);
      const literal = clean.slice(match.index + match[0].length, match.index + match[0].length + 300).match(/^\s*(["'`])([^"'`\n]{1,200})\1/)?.[2];
      callTypes.add(type);
      communications.push({ id: `${rel}:${atLine(match.index)}:${type}`, type, file: rel, line: atLine(match.index), method: owner.id, target: literal || clientType, workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" });
    }
  }
  for (const [type, regex] of patterns) {
    for (const match of clean.matchAll(regex)) {
      /* 본문 안 호출(RestTemplate 등)은 감싸는 메서드, 메서드 위 애너테이션(@KafkaListener)은 다음 메서드다. */
      const enclosing = enclosingMethod(methods, match.index);
      /* 호출을 이미 잡았으면 본문 밖 타입 이름(import·필드 선언)은 통신이 아니다. 못 잡았으면 탐지를 잃지 않게 남긴다. */
      if (!enclosing && callTypes.has(type)) continue;
      const owner = enclosing || nextMethod(methods, atLine(match.index));
      communications.push({ id: `${rel}:${atLine(match.index)}:${type}`, type, file: rel, line: atLine(match.index), method: owner?.id || "", target: quotedValue(match[1]) || match[1] || "unknown", workspace: workspace.id, origin: "deterministic-indexer", confidence: "MEDIUM" });
    }
  }
  return communications;
}

function extractEnv(text, clean, rel, workspace) {
  const atLine = lineIndex(text);
  const profiles = [];
  const branches = [];
  const configName = basename(rel).match(/application-([^.]+)\.(?:yml|yaml|properties)$/)?.[1];
  if (configName) {
    profiles.push(configName);
    branches.push({ file: rel, line: 1, type: "config_file", marker: configName, workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  const patterns = [
    ["annotation", /@Profile\s*\(([^)]*)\)|@ConditionalOnProperty\s*\(([^)]*)\)/g],
    ["code_if", /\b(?:process\.env|os\.environ|getenv|Environment\.GetEnvironmentVariable|System\.getenv|import\.meta\.env)\b[^\n;]*/g],
  ];
  for (const [type, regex] of patterns) {
    for (const match of clean.matchAll(regex)) branches.push({ file: rel, line: atLine(match.index), type, marker: match[0].slice(0, 240), workspace: workspace.id, origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return { profiles, branches };
}

function extractSchema(text, rel) {
  const tables = [];
  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of text.matchAll(create)) {
    const columns = [];
    const primaryKey = [];
    const foreignKeys = [];
    for (const raw of match[2].split(/,(?![^()]*\))/)) {
      const line = raw.trim();
      /*
       * `CONSTRAINT PK_TB_ORDER PRIMARY KEY (ID)` 형태를 놓치고 있었다 — 이름 붙은 제약이
       * 오라클 레거시 DDL의 표준인데, `^primary key`만 보다가 아래 `^(constraint|...)` 스킵 규칙에
       * 걸려 **PK가 통째로 버려졌다.** 실제로 가상 프로젝트 5개 테이블 전부 `primary_key: []`였다.
       */
      const pk = line.match(/^(?:constraint\s+["`]?[\w$]+["`]?\s+)?primary\s+key\s*\(([^)]+)\)/i);
      if (pk) { primaryKey.push(...pk[1].split(",").map((v) => v.trim().replace(/["`]/g, ""))); continue; }
      const fk = line.match(/^(?:constraint\s+["`]?([\w$]+)["`]?\s+)?foreign\s+key\s*\(([^)]+)\)\s+references\s+([\w."`$]+)\s*\(([^)]+)\)/i);
      if (fk) {
        foreignKeys.push({
          name: fk[1] || "", columns: fk[2].split(",").map((value) => value.trim().replace(/["`]/g, "")),
          references_table: fk[3].replace(/["`]/g, ""), references_columns: fk[4].split(",").map((value) => value.trim().replace(/["`]/g, "")),
          origin: "deterministic-indexer", confidence: "HIGH",
        });
        continue;
      }
      if (/^(constraint|foreign|unique|check)\b/i.test(line)) continue;
      const column = line.match(/^["`]?([\w$]+)["`]?\s+([\w]+(?:\s*\([^)]*\))?)([\s\S]*)$/);
      if (!column) continue;
      const inlinePk = /primary\s+key/i.test(column[3]);
      if (inlinePk) primaryKey.push(column[1]);
      const inlineFk = column[3].match(/\breferences\s+([\w."`$]+)\s*\(([^)]+)\)/i);
      if (inlineFk) foreignKeys.push({
        name: "", columns: [column[1]], references_table: inlineFk[1].replace(/["`]/g, ""),
        references_columns: inlineFk[2].split(",").map((value) => value.trim().replace(/["`]/g, "")),
        origin: "deterministic-indexer", confidence: "HIGH",
      });
      columns.push({ name: column[1], type: column[2], nullable: !/not\s+null/i.test(column[3]), primary_key: inlinePk });
    }
    tables.push({ name: match[1].replace(/["`]/g, ""), columns, primary_key: [...new Set(primaryKey)], foreign_keys: foreignKeys, indexes: [], source_file: rel, origin: "deterministic-indexer", confidence: "MEDIUM" });
  }
  /*
   * `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY/FOREIGN KEY ...`를 전혀 읽지 않았다.
   * 레거시 DDL은 테이블을 먼저 만들고 제약을 뒤에 몰아서 거는 형태가 매우 흔한데, 그 경우
   * 스키마에 관계가 하나도 남지 않아 위키의 ERD·"이 테이블은 무엇과 엮여 있나"가 비어 버렸다.
   */
  const tableByName = (name) => {
    const bare = name.replace(/["`]/g, "");
    return tables.find((item) => item.name.toLowerCase() === bare.toLowerCase()
      || item.name.split(".").at(-1).toLowerCase() === bare.split(".").at(-1).toLowerCase());
  };
  for (const match of text.matchAll(/alter\s+table\s+([\w."`$]+)\s+add\s+(?:constraint\s+["`]?([\w$]+)["`]?\s+)?(primary\s+key|foreign\s+key)\s*\(([^)]+)\)(?:\s*references\s+([\w."`$]+)\s*\(([^)]+)\))?/gi)) {
    const table = tableByName(match[1]);
    if (!table) continue;
    const columns = match[4].split(",").map((value) => value.trim().replace(/["`]/g, ""));
    if (/primary/i.test(match[3])) {
      table.primary_key = [...new Set([...table.primary_key, ...columns])];
      for (const column of table.columns) if (columns.includes(column.name)) column.primary_key = true;
    } else if (match[5]) {
      table.foreign_keys.push({
        name: match[2] || "", columns,
        references_table: match[5].replace(/["`]/g, ""),
        references_columns: match[6].split(",").map((value) => value.trim().replace(/["`]/g, "")),
        origin: "deterministic-indexer", confidence: "HIGH",
      });
    }
  }
  for (const match of text.matchAll(/create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?["`]?([\w$]+)["`]?\s+on\s+([\w."`$]+)\s*\(([^)]+)\)/gi)) {
    const tableName = match[3].replace(/["`]/g, "");
    const table = tables.find((item) => item.name.toLowerCase() === tableName.toLowerCase() || item.name.split(".").at(-1).toLowerCase() === tableName.split(".").at(-1).toLowerCase());
    if (!table) continue;
    table.indexes.push({ name: match[2], columns: match[4].split(",").map((value) => value.trim().replace(/["`]/g, "").split(/\s+/)[0]), unique: Boolean(match[1]), origin: "deterministic-indexer", confidence: "HIGH" });
  }
  return tables;
}

/*
 * 소스 파일 디코딩.
 * 레거시 ITO 저장소는 Struts actconf XML·JSP를 EUC-KR로 저장한 경우가 흔한데, 전부 UTF-8로
 * 읽으면 한글이 U+FFFD로 깨진 채 api_contract.json과 wiki까지 그대로 전파된다(2026-08-15 실사고).
 * 판정 사다리는 BOM → 파일이 스스로 선언한 인코딩 → 유효한 UTF-8 → 레거시 폴백 순이다.
 */
const ENCODING_ALIASES = new Map([
  ["cp949", "euc-kr"], ["ms949", "euc-kr"], ["ksc5601", "euc-kr"], ["ks_c_5601", "euc-kr"],
  ["cp932", "shift_jis"], ["ms932", "shift_jis"], ["sjis", "shift_jis"],
  ["cp936", "gb18030"], ["ms936", "gb18030"],
  ["cp950", "big5"], ["ms950", "big5"],
  ["cp1252", "windows-1252"], ["ansi", "windows-1252"],
]);
/* 선언도 없고 UTF-8도 아닌 파일의 마지막 수단. 이 하네스의 대상이 한국 ITO/SI 레거시라 EUC-KR을 쓴다. */
const LEGACY_FALLBACK_ENCODING = "euc-kr";
const CHARSET_DECLARATION = /\b(?:encoding|pageEncoding|charset)\s*=\s*["']?([\w][\w.:-]*)/i;

function decoderFor(label) {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  for (const candidate of [normalized, ENCODING_ALIASES.get(normalized)]) {
    if (!candidate) continue;
    try {
      const decoder = new TextDecoder(candidate);
      return { decoder, label: decoder.encoding };
    } catch { /* 다음 후보를 시도한다 */ }
  }
  return null;
}

/* 정규식 이스케이프 없이 비-ASCII 문자 포함 여부만 본다. */
function hasNonAscii(text) {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 127) return true;
  return false;
}

function strictUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/*
 * 줄바꿈을 LF로 정규화한다.
 *
 * 이게 없으면 CRLF 파일에서 **줄 번호가 어긋난다.** JS의 multiline 정규식에서 `^`는 바깥의 `\r`
 * 뒤에서도 매치되고, 뒤따르는 `(\s*)`가 `\n`을 삼켜버린다(예: `pyDefRegex`). 실측하면 같은 파일이
 * LF일 때 `src/app.py:3`, CRLF일 때 `src/app.py:2`로 인덱싱된다 — 인덱스가 가리키는 줄이 한 줄 밀린다.
 * 파이썬 들여쓰기 판정(`match[1]`)도 `""` 대신 `"\n"`을 받아 중첩 계산이 깨지고,
 * `\r`이 `env_branches`의 `marker` 같은 산출 문자열에도 그대로 섞여 들어간다.
 *
 * 윈도우가 기본인 ITO 현장에서는 이게 예외가 아니라 기본값이고, 팀이 인덱스를 공유하면
 * OS에 따라 같은 커밋이 서로 다른 줄 번호를 만들어 낸다. 오프셋은 어차피 내부 계산용이라
 * 여기서 한 번 정규화해도 잃는 정보가 없다.
 */
function normalizeNewlines(text) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function decodeSource(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { text: normalizeNewlines(new TextDecoder("utf-16le").decode(buffer)), encoding: "utf-16le", detected_by: "bom" };
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { text: normalizeNewlines(new TextDecoder("utf-16be").decode(buffer)), encoding: "utf-16be", detected_by: "bom" };
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { text: normalizeNewlines(new TextDecoder("utf-8").decode(buffer)), encoding: "utf-8", detected_by: "bom" };
  const declared = decoderFor(CHARSET_DECLARATION.exec(buffer.subarray(0, 2048).toString("latin1"))?.[1]);
  const utf8 = strictUtf8(buffer);
  if (declared && declared.label !== "utf-8") {
    /*
     * 선언은 레거시인데 바이트가 유효한 UTF-8 멀티바이트면 실제 저장은 UTF-8이다 — 선언을 뒤집는다.
     * EUC-KR 한글 바이트열이 우연히 유효한 UTF-8 멀티바이트가 되는 경우는 사실상 없다.
     */
    if (utf8 !== null && hasNonAscii(utf8)) return { text: normalizeNewlines(utf8), encoding: "utf-8", detected_by: "declared-overridden" };
    return { text: normalizeNewlines(declared.decoder.decode(buffer)), encoding: declared.label, detected_by: "declared" };
  }
  if (utf8 !== null) return { text: normalizeNewlines(utf8), encoding: "utf-8", detected_by: declared ? "declared" : "valid-utf8" };
  return { text: normalizeNewlines(new TextDecoder(LEGACY_FALLBACK_ENCODING).decode(buffer)), encoding: LEGACY_FALLBACK_ENCODING, detected_by: "fallback" };
}

/* 어느 인코딩으로 읽혔는지 _meta에 남긴다. 추측(fallback)으로 읽은 파일이 조용히 묻히면 안 된다. */
function buildEncodingSummary(facts) {
  const byEncoding = {};
  const declaredNonUtf8 = [];
  const guessed = [];
  for (const fact of facts) {
    const info = fact.encoding || { label: "utf-8", detected_by: "valid-utf8" };
    byEncoding[info.label] = (byEncoding[info.label] || 0) + 1;
    if (info.detected_by === "fallback") guessed.push(fact.rel);
    else if (info.label !== "utf-8") declaredNonUtf8.push(fact.rel);
  }
  return {
    default_encoding: "utf-8",
    legacy_fallback: LEGACY_FALLBACK_ENCODING,
    by_encoding: byEncoding,
    declared_non_utf8_count: declaredNonUtf8.length,
    declared_non_utf8: declaredNonUtf8.slice(0, 50),
    guessed_count: guessed.length,
    guessed: guessed.slice(0, 50),
  };
}

/* XML 속성을 순서·따옴표 종류와 무관하게 읽는다. */
function xmlAttrs(source) {
  return Object.fromEntries([...source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)]
    .map((match) => [(match[1] || match[3]).toLowerCase(), match[2] ?? match[4]]));
}

/*
 * JSP/HTML의 <script src="..."> 참조 — Legacy Static JS의 JS↔JSP 매핑(client_index.json)에 쓰인다.
 * analyzer.md Step 5가 수작업 grep으로 6~10쌍만 샘플링하던 것을 전수·결정론적으로 대체한다.
 */
const SCRIPT_SRC_REGEX = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const TEMPLATE_EXTENSIONS = new Set([".jsp", ".jspx", ".jspf", ".tag", ".html", ".htm"]);
function extractClientRefs(text, rel) {
  if (!TEMPLATE_EXTENSIONS.has(extname(rel).toLowerCase())) return [];
  return [...text.matchAll(SCRIPT_SRC_REGEX)].map((match) => match[1]);
}

/* CDN/번들 파일명에서 라이브러리 버전을 읽는다. `jquery-1.11.1.min.js`, `jquery@3.6.0` 둘 다 잡는다. */
const LIBRARY_VERSION_REGEX = /(jquery|bootstrap)[@.\-]v?(\d+(?:\.\d+){1,2})/i;
function detectLibraryVersions(scriptRefs) {
  const found = new Set();
  for (const src of scriptRefs) {
    const match = LIBRARY_VERSION_REGEX.exec(src);
    if (match) found.add(`${match[1].toLowerCase()}@${match[2]}`);
  }
  return [...found].sort(byCodeUnit);
}

/*
 * Spring XML 빈 정의(id→class) — Struts action의 `command` 속성(빈 id)이 가리키는 실제 서비스
 * 클래스를 찾는 데 쓰인다. `<bean id="X" class="Y"/>`, 속성 순서는 무관하게 잡는다.
 */
const SPRING_BEAN_REGEX = /<bean\b([^>]*)>/gi;
function extractSpringBeans(text, rel) {
  if (extname(rel).toLowerCase() !== ".xml") return [];
  const atLine = lineIndex(text);
  const beans = [];
  for (const match of text.matchAll(SPRING_BEAN_REGEX)) {
    const attrs = xmlAttrs(match[1]);
    if (attrs.id && attrs.class) beans.push({ id: attrs.id, className: attrs.class, file: rel, line: atLine(match.index) });
  }
  return beans;
}

/*
 * 업무 용어 — 코드명(MA00001)·영문 식별자로 된 레거시를 업무명으로 찾게 한다.
 *
 * 인덱스는 코드 이름만 담아 "수강신청"으로 찾으면 SQL 미리보기 4건만 걸렸고, 모델은 "Apply 겠지"
 * 하고 영문을 추측했다(실측, eduLms). 코드명 체계에서는 그 추측이 통하지 않는다. 업무명은 소스에
 * 글자로 남아 있다 — eduLms 에서 "수강신청"이 든 JSP 112·Java 27·XML 9개.
 *
 * 다만 모아서 다 보여 주면 정확도가 떨어진다. 112개 중 대부분은 다른 기능의 컬럼 이름("수강신청일")
 * 이나 줄 끝 주석이다. 화면 제목에 든 것은 9개였고 학습자 수강신청 화면 4개가 전부 그 안에 있었다.
 * 그래서 **어디에 나왔는지**를 함께 남긴다 — 정의하는 자리(제목·머리말·클래스 설명)와 언급하는
 * 자리(표 머리·라벨)를 나누고, 줄 끝 주석은 양만 많아 모으지 않는다. 순위는 query-index search 가 매긴다.
 */
const HANGUL = /[가-힣]/;
const MARKUP_TERM_EXT = new Set([".jsp", ".jspf", ".html", ".htm", ".xhtml", ".vue", ".asp", ".aspx", ".cshtml"]);
const CODE_DOC_EXT = new Set([".java", ".kt", ".kts", ".cs", ".js", ".ts", ".jsx", ".tsx", ".groovy", ".scala"]);
const TERMS_PER_FILE = 40;

/** 태그·스크립틀릿·엔티티를 걷고 제목 조각으로 쪼갠다. "수강신청 | 교육시스템" → ["수강신청", "교육시스템"] */
function termPieces(raw) {
  const text = String(raw)
    .replace(/<%[\s\S]*?%>/g, " ").replace(/\$\{[^}]*\}/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  return text.split(/\s[|›>·-]\s|\s\|\s|\|/).map((part) => part.trim()).filter((part) => HANGUL.test(part) && part.length >= 2 && part.length <= 40);
}

/** 주석 블록에서 업무 설명 줄만 꺼낸다. `@param` 같은 태그 줄과 코드 조각은 버린다. */
function docLines(block) {
  return block.replace(/^\/\*+|\*+\/$/g, "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@") && HANGUL.test(line))
    // "프로그램명 : 수강신청 관리" 같은 머리말 표지를 걷는다.
    .map((line) => line.replace(/^(?:프로그램\s*명|프로그램\s*ID|화면\s*명|화면\s*ID|업무\s*명|기능\s*명?|설\s*명|개\s*요|내\s*용|제\s*목|Program\s*(?:Name|ID)|Screen\s*(?:Name|ID)|Description|Title|Summary|Desc)\s*[:：]\s*/i, ""))
    .filter((line) => line.length >= 2 && line.length <= 60 && HANGUL.test(line))
    .slice(0, 3);
}

/**
 * @param {string} text  인코딩을 판정한 원문(주석 포함)
 * @param {string} rel
 * @param {Array<{ id: string, line: number }>} methods
 * @param {Array<{ id: string, line: number }>} [classes]
 */
export function extractTerms(text, rel, methods, classes = []) {
  const ext = extname(rel).toLowerCase();
  if (!HANGUL.test(text)) return [];
  const atLine = lineIndex(text);
  /** @type {Array<{ term: string, kind: string, file: string, line: number, symbol?: string }>} */
  const terms = [];
  const push = (term, kind, offset, symbol) => terms.push({ term, kind, file: rel, line: atLine(offset), ...(symbol ? { symbol } : {}) });

  if (MARKUP_TERM_EXT.has(ext)) {
    for (const m of text.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)) for (const t of termPieces(m[1])) push(t, "title", m.index);
    for (const m of text.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) for (const t of termPieces(m[2])) push(t, "heading", m.index);
    // JSP 머리말은 <%-- --%> 다. 파일 안의 /* */ 는 대개 화면 스크립트 주석이라 머리말로 올리지 않는다(아래).
    // 맨 위의 첫 블록만 본다. 중간의 <%-- --%> 는 대개 주석 처리한 화면 조각이다(실측: '<legend>로그인</legend>').
    // 화면 태그가 나오기 전(지시문 <%@ … %> 은 예외)의 주석만 머리말로 본다 — 줄 수로 자르면 짧은 파일에서 틀린다.
    const head = text.match(/<%--([\s\S]*?)--%>/);
    if (head && !/<(?![%!])/.test(text.slice(0, head.index))) {
      for (const t of docLines(head[1].replace(/<[^>]+>/g, " "))) push(t, "header", head.index);
    }
    for (const m of text.matchAll(/<(th|label|legend|caption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) for (const t of termPieces(m[2])) push(t, "label", m.index);
  }

  if (CODE_DOC_EXT.has(ext) || MARKUP_TERM_EXT.has(ext)) {
    const firstDecl = [...classes].sort((a, b) => a.line - b.line)[0];
    for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
      const lines = docLines(m[0]);
      if (!lines.length) continue;
      const endLine = atLine(m.index + m[0].length);
      // 주석 바로 아래(3줄 안)에서 시작하는 메서드·클래스가 그 설명의 주인이다.
      const owner = methods.find((item) => item.line > endLine - 1 && item.line <= endLine + 3);
      const ownerClass = classes.find((item) => item.line > endLine - 1 && item.line <= endLine + 3);
      const markup = MARKUP_TERM_EXT.has(ext);
      const kind = ownerClass ? "class_doc" : owner ? "method_doc" : (!markup && (!firstDecl || endLine <= firstDecl.line)) ? "header" : null;
      if (!kind) continue;
      for (const t of lines) push(t, kind, m.index, (ownerClass || owner)?.id);
    }
  }

  if (ext === ".xml") {
    // 자체 쿼리 컨테이너의 설명 — <query><id>X</id>…<description>수강신청 등록</description></query>
    for (const m of text.matchAll(/<(query|statement|sql)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const id = m[2].match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
      const desc = m[2].match(/<description>([\s\S]*?)<\/description>/i)?.[1];
      if (desc) for (const t of termPieces(desc.replace(/<!\[CDATA\[|\]\]>/g, ""))) push(t, "desc", m.index, id);
    }
    // MyBatis·iBatis 문장 바로 위의 <!-- 설명 -->
    for (const m of text.matchAll(/<!--([\s\S]*?)-->\s*<(select|insert|update|delete|procedure|statement)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) {
      for (const t of termPieces(m[1])) push(t, "desc", m.index, m[3]);
    }
  }

  if (ext === ".sql") {
    for (const m of text.matchAll(/comment\s+on\s+(table|column)\s+([\w$."]+)\s+is\s+'((?:[^']|'')*)'/gi)) {
      for (const t of termPieces(m[3].replace(/''/g, "'"))) push(t, m[1].toLowerCase() === "table" ? "desc" : "label", m.index, m[2].replace(/"/g, "").toUpperCase());
    }
  }

  if (ext === ".properties" && /_ko|message|label|resource/i.test(rel)) {
    for (const m of text.matchAll(/^[ \t]*([\w.\-]+)[ \t]*[=:][ \t]*(.+)$/gm)) {
      const value = m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      for (const t of termPieces(value)) push(t, "label", m.index, m[1]);
    }
  }

  const seen = new Set();
  return terms.filter((item) => {
    const key = `${item.kind}\u0000${item.term}\u0000${item.symbol || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TERMS_PER_FILE);
}

function analyzeFile(file, root, config) {
  const buffer = readFileSync(file.full);
  const decoded = decodeSource(buffer);
  const text = decoded.text;
  const ext = extname(file.rel).toLowerCase();
  const clean = stripComments(text, ext);
  const workspace = workspaceFor(file.rel, config);
  const symbolFacts = extractSymbols(text, clean, file.rel, workspace);
  const nexacro = extractNexacro(text, file.rel, workspace);
  const api = extractApi(text, clean, file.rel, workspace, symbolFacts.methods, symbolFacts.classes);
  const sql = extractSql(text, clean, file.rel, symbolFacts.methods);
  const embedded = symbolFacts.sqlFacts || (isPlsqlSource(ext, clean) ? extractPlsqlSql(text, clean, file.rel, symbolFacts.methods)
    : PROC_EXTENSIONS.has(ext) ? extractProcSql(text, clean, file.rel, symbolFacts.methods) : null);
  if (embedded) { sql.sqls.push(...embedded.sqls); sql.usages.push(...embedded.usages); sql.relations.push(...embedded.relations); }
  return {
    rel: file.rel,
    /* 소스 지문이 같은 파일을 다시 열지 않도록 여기서 읽은 바이트의 해시를 넘긴다(Windows에서 open이 파일당 ~0.5ms). */
    contentSha1: createHash("sha1").update(buffer).digest("hex"),
    encoding: { label: decoded.encoding, detected_by: decoded.detected_by },
    mtime: file.stats.mtime.toISOString(),
    size: file.stats.size,
    symbols: symbolFacts.symbols,
    nodes: symbolFacts.nodes,
    callSites: symbolFacts.callSites,
    injects: symbolFacts.injects,
    fields: symbolFacts.fields || [],
    locals: symbolFacts.locals || [],
    includes: symbolFacts.includes || [],
    scripts: symbolFacts.scripts || [],
    pathVars: symbolFacts.pathVars || [],
    properties: symbolFacts.properties || [],
    adapters: detectAdapters(file.rel, text),
    bindings: [...extractBindings(text, clean, file.rel, workspace, symbolFacts.methods), ...nexacro.bindings],
    fastApi: extractFastApiMeta(text, clean, file.rel),
    endpoints: api.endpoints,
    consumers: [...api.consumers, ...nexacro.consumers],
    uiFlow: nexacro.uiFlow,
    ...sql,
    boundaries: extractTransactions(text, clean, file.rel, workspace, symbolFacts.methods),
    communications: extractExternalIo(text, clean, file.rel, workspace, symbolFacts.methods),
    env: extractEnv(text, clean, file.rel, workspace),
    tables: ext === ".sql" ? extractSchema(text, file.rel) : [],
    clientRefs: extractClientRefs(text, file.rel),
    springBeans: extractSpringBeans(text, file.rel),
    terms: extractTerms(text, file.rel, symbolFacts.methods, symbolFacts.symbols.filter((item) => ["class", "interface", "enum", "record", "object"].includes(item.type))),
  };
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/*
 * 인덱스 _meta의 시각은 KST(+09:00)로 기록한다 — agents/lib/now_kst.py와 같은 규약.
 * validator_checks._meta_field_issues가 UTC 'Z' 표기를 "지어낸 값 의심"으로 WARN하기 때문이다.
 */
function kstIso(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "+09:00");
}

function gitCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "log", "-1", "--format=%H"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/*
 * 소스 지문 — "이 인덱스가 지금 작업 트리와 맞는가"를 싸게 판정하기 위한 값이다.
 *
 * 기존에는 `_meta.latest_source_mtime`(파일 mtime)과 `git_commit`으로 판단했는데 둘 다 팀 공유에서 깨진다.
 * git은 mtime을 보존하지 않으므로 새로 clone하면 모든 파일이 "방금 수정됨"이 되어 인덱스가 항상
 * 낡은 것으로 판정된다(실측 확인). `git_commit`은 인덱스를 커밋하는 순간 HEAD가 앞서가 버려서
 * 영원히 한 커밋 뒤처진 값이 된다.
 *
 * 대신 **내용 지문**을 쓴다. git 저장소면 `git ls-files -s`(모드+blob 해시+경로)를 해싱하는데,
 * clone·OS·로케일과 무관하게 같은 내용이면 같은 값이고 실측 2ms다. git이 아니거나 실패하면
 * 파일 목록과 크기로 대체한다(같은 보장은 아니지만 없는 것보다 낫다).
 */
function sourceFingerprint(root, includePaths, files, knownHashes = null) {
  /*
   * 지문은 **인덱싱 대상 파일만** 덮는다. git이 보고하는 전체 변경을 그대로 쓰면
   * `_workspace/`나 README 같은 비대상 파일 때문에 항상 "변경됨"이 되어 쓸모가 없다
   * (실제로 첫 구현이 자기가 만든 `_workspace/`를 보고 매번 낡았다고 답했다).
   *
   * git이 있으면 커밋된 파일은 blob 해시를 그대로 쓰고(읽지 않아 빠르다), 작업 트리에서
   * 변경된 파일만 내용을 해싱한다. git이 없으면 전체 내용 해시로 대체한다.
   * 어느 경로든 결과는 clone·OS·로케일과 무관하게 같은 내용이면 같은 값이다.
   */
  const digest = (label, payload) => `${label}:${createHash("sha1").update(payload).digest("hex").slice(0, 16)}`;
  const indexed = files.map((file) => file.rel).sort(byCodeUnit);
  const contentHash = (rel) => {
    const known = knownHashes?.get(rel);
    if (known) return known;
    const full = join(root, rel);
    try {
      return createHash("sha1").update(readFileSync(full)).digest("hex");
    } catch {
      return "unreadable";
    }
  };
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024,
  });
  try {
    const blobByPath = new Map();
    for (const line of git(["ls-files", "-s"]).split("\n")) {
      /* `<mode> <blob> <stage>\t<path>` */
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      blobByPath.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[1]);
    }
    if (blobByPath.size) {
      const dirty = new Set(
        git(["status", "--porcelain", "-uall"]).split("\n")
          .map((line) => line.slice(3).trim()).filter(Boolean)
          .map((rel) => (rel.includes(" -> ") ? rel.split(" -> ")[1] : rel)),
      );
      const payload = indexed
        .map((rel) => `${rel}:${!dirty.has(rel) && blobByPath.has(rel) ? blobByPath.get(rel) : contentHash(rel)}`)
        .join("\n");
      return digest("git", payload);
    }
  } catch {
    /* git이 없거나 저장소가 아니다 — 아래 폴백. */
  }
  return digest("content", indexed.map((rel) => `${rel}:${contentHash(rel)}`).join("\n"));
}

/*
 * 인덱스 출력 위치. 기본값은 지금까지와 같은 `<root>/_workspace/index`다.
 * `--index-dir`(또는 options.indexDir)는 기본값을 바꾸려는 것이 아니라, 같은 인덱서를 다른 상태
 * 디렉터리(예: CLI의 `.axnavi/index`)에 겨눌 수 있게 열어 두기 위한 것이다. 넘기지 않으면 동작이 같다.
 */
export function resolveIndexDir(root, indexDir) {
  return indexDir ? (isAbsolute(indexDir) ? indexDir : join(resolve(root), indexDir)) : join(resolve(root), "_workspace", "index");
}

/* 커밋된 인덱스를 받은 팀원이 "다시 인덱싱해야 하나"를 LLM 없이 판정한다. */
export function indexStaleness(root, indexDir) {
  const metaPath = join(resolveIndexDir(root, indexDir), "_meta.json");
  if (!existsSync(metaPath)) return { stale: true, reason: "인덱스 없음" };
  const meta = readJson(metaPath, {});
  if (meta.version !== INDEXER_VERSION) return { stale: true, reason: `인덱서 버전 변경 (${meta.version} → ${INDEXER_VERSION})` };
  if (!meta.source_fingerprint) return { stale: true, reason: "지문 없는 구버전 인덱스" };
  const config = loadConfig(resolve(root), null);
  const { files } = listFiles(resolve(root), config.include_paths, config);
  const current = sourceFingerprint(resolve(root), config.include_paths, files);
  return current === meta.source_fingerprint
    ? { stale: false, reason: "소스 지문 일치 — 재인덱싱 불필요", fingerprint: current }
    : { stale: true, reason: "소스가 변경됨", fingerprint: current, indexed_fingerprint: meta.source_fingerprint };
}

/*
 * pair 설정.
 * 허브 1개에 파트너 N개를 붙일 수 있다. 구형 설정은 파트너가 하나뿐인 특수 경우이므로
 * `partner_root`/`partner_api_contract` 단일 키를 계속 읽어 기존 프로젝트를 깨지 않는다.
 * 신형은 같은 키를 여러 줄 반복하거나 `partner_root[n]` 형태를 쓴다.
 */
function pairConfig(root) {
  const path = join(root, "_workspace", "pair_config.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const all = (name) => [...text.matchAll(new RegExp(`^${name}(?:\\[\\d+\\])?:\\s*(.+)$`, "gm"))].map((m) => m[1].trim()).filter(Boolean);
  const roots = all("partner_root");
  const contracts = all("partner_api_contract");
  const partners = roots.map((partnerRoot, index) => ({
    partner_root: partnerRoot,
    partner_api_contract: contracts[index] || join(partnerRoot, "_workspace", "index", "api_contract.json"),
  }));
  return {
    /* 하위호환: 기존 소비자는 단일 필드를 그대로 읽는다. */
    partner_root: partners[0]?.partner_root,
    partner_api_contract: partners[0]?.partner_api_contract,
    partners,
  };
}

/* sql_usage의 tables를 테이블 목록으로 뒤집는다. DDL이 없을 때만 쓰는 폴백이다. */
function deriveTablesFromSql(sqls) {
  const usage = new Map();
  for (const item of sqls) {
    for (const name of item.tables || []) {
      const key = name.toLowerCase();
      if (!usage.has(key)) usage.set(key, { name, usage_count: 0, source_sqls: [] });
      const entry = usage.get(key);
      entry.usage_count += 1;
      if (entry.source_sqls.length < 10) entry.source_sqls.push(item.id);
    }
  }
  return [...usage.values()]
    .sort((a, b) => b.usage_count - a.usage_count || byCodeUnit(a.name, b.name))
    .map((item) => ({
      name: item.name, columns: [], primary_key: [], foreign_keys: [], indexes: [],
      usage_count: item.usage_count, source_sqls: item.source_sqls,
      origin: "derived-from-sql", confidence: "MEDIUM",
    }));
}

function aggregate(facts, options, config, generatedAt, sourceFileCount, latestMtime, complexity, coverage, excludedSources = [], sourceFiles = []) {
  const symbols = unique(facts.flatMap((item) => item.symbols), (item) => item.id);
  const bindings = facts.flatMap((item) => item.bindings || []);
  const nodes = unique([...facts.flatMap((item) => item.nodes), ...bindings.map((item) => ({ id: `trigger:${item.trigger}`, type: "trigger", file: item.file, line: item.line, workspace: item.workspace, origin: "deterministic-indexer", confidence: "HIGH" }))], (item) => item.id);
  const callSites = facts.flatMap((item) => item.callSites);
  /*
   * Java·C# → 저장 프로시저. 문자열의 `{call PKG.PROC}`은 extractSql이 호출 위치까지 남기고,
   * MyBatis CALLABLE 매퍼는 그 SQL id를 쓰는 메서드에서 부른 것으로 본다. 이름 해석은 일반 호출과 같다.
   */
  const allSqls = facts.flatMap((item) => item.sqls);
  const callables = facts.flatMap((item) => item.callables || []);
  /*
   * 쿼리 id 되짚기. iBatis sqlMap의 id는 `Order.list`인데 useStatementNamespaces=false 프로젝트의
   * Java는 `"list"`만 쓴다. 짧은 id가 전체에서 하나일 때만 바꾸고, 둘 이상이면 모호하므로 그대로 둔다.
   */
  const knownStatementIds = new Set([...allSqls, ...callables].map((item) => item.id));
  const byShortId = new Map();
  for (const item of [...allSqls, ...callables]) {
    if (!item.statement_id) continue;
    const seen = byShortId.has(item.statement_id);
    byShortId.set(item.statement_id, seen && byShortId.get(item.statement_id) !== item.id ? null : item.id);
  }
  const resolveStatementId = (id) => (knownStatementIds.has(id) ? id : byShortId.get(id) || id);
  const callableSqls = new Map([...allSqls.filter((item) => item.procedure), ...callables].map((item) => [item.id, item.procedure]));
  const seenCallableUsage = new Set();
  for (const fact of facts) {
    for (const call of fact.procedureCalls || []) callSites.push({ ...call, workspace: workspaceFor(call.file, config).id });
    for (const usage of fact.usages) {
      const sqlId = resolveStatementId(usage.sql_id);
      const target = callableSqls.get(sqlId);
      const key = `${sqlId}:${usage.file}:${usage.line}`;
      if (!target || usage.method === "unknown" || usage.method === sqlId || seenCallableUsage.has(key)) continue;
      seenCallableUsage.add(key);
      callSites.push({ caller: usage.method, ...procedureTarget(target), file: usage.file, line: usage.line, workspace: workspaceFor(usage.file, config).id });
    }
  }
  const injects = facts.flatMap((item) => item.injects);
  /*
   * 한정자 → 타입 사전. `owner클래스::필드명` → 타입명.
   * 이게 없으면 `sqlSession.insert(...)` 같은 프레임워크 호출에서 한정자가 아무 후보와도
   * 겹치지 않아 **후보 전체(오답뿐)를 그대로 LLM 판정 대기열에 넣었다.** 가상 프로젝트에서
   * 판정 대상 30건이 전부 이 형태였다 — analyzer가 파일을 열어봐도 목록에 정답이 없으니
   * 판정이 성립하지 않는데 비싼 모델이 30번 소스를 열어보게 된다.
   */
  const fieldTypes = new Map();
  for (const field of facts.flatMap((item) => item.fields || [])) {
    fieldTypes.set(`${field.owner}::${field.fieldName}`, field.typeName);
  }
  /* `호출 메서드::변수명` → [{ line, typeName }] 선언 순. 지역 변수·파라미터는 같은 이름의 필드를 가린다. */
  const localDeclarations = new Map();
  for (const local of facts.flatMap((item) => item.locals || [])) {
    const key = `${local.method}::${local.name}`;
    const list = localDeclarations.get(key);
    if (list) list.push(local); else localDeclarations.set(key, [local]);
  }
  /* 호출 줄 이전의 가장 가까운 선언. 없으면 undefined(필드로 넘어간다). */
  const localTypeAt = (caller, name, line) => {
    let found;
    for (const local of localDeclarations.get(`${caller}::${name}`) || []) if (local.line <= line) found = local.typeName;
    return found;
  };
  const indexedSimpleNames = new Set(nodes.map((item) => item.id.split(".").at(-1)));
  /*
   * 상속 체인. 한정자 없는 호출은 같은 클래스에 없으면 부모 클래스 멤버다(`getLogger()`를 부모
   * `DataAccesser`에서 물려받는 식 — 실측 미해결 195건). 부모 이름이 인덱스에서 클래스 하나로
   * 정해질 때만 따라간다.
   */
  const symbolById = new Map(symbols.map((item) => [item.id, item]));
  /* 타입 단순 이름 → 그것을 implements·extends하는 클래스 id(외부 jar 타입 포함) */
  const implementorsOf = new Map();
  for (const symbol of symbols) {
    for (const base of [symbol.extends, ...(symbol.implements || [])].filter(Boolean)) {
      const simple = String(base).split(".").at(-1).replace(/<.*/, "").trim();
      const list = implementorsOf.get(simple);
      if (list) list.push(symbol.id); else implementorsOf.set(simple, [symbol.id]);
    }
  }
  const superClassOf = (classId) => {
    const base = symbolById.get(classId)?.extends;
    if (!base) return null;
    const simple = String(base).split(".").at(-1).replace(/<.*/, "").trim();
    const classes = (nodeBySimple.get(simple) || []).filter((item) => item.type === "class");
    return classes.length === 1 ? classes[0].id : null;
  };
  /* `pkg.Owner.method` → `pkg.Owner` (필드 사전의 키와 맞추기 위한 소유 클래스 id) */
  const ownerIdOf = (callerId) => String(callerId || "").split(".").slice(0, -1).join(".");
  const nodeBySimple = new Map();
  /*
   * 후보 좁히기용 색인. 호출마다 동명 후보 전체를 `filter`하면 `selectList`·`save`처럼 DAO마다 있는
   * 이름에서 호출 수 × 후보 수가 되어, 2,500파일 합성 저장소에서 호출 해석만 2.4초였다(2026-09-24 실측).
   * 소유 클래스 단순 이름(`OrderDao`)·소유 id(`com.acme.OrderDao`)와 메서드 이름을 키로 미리 묶는다.
   */
  const nodeByOwnerSimple = new Map();
  const nodeByOwnerId = new Map();
  const pushTo = (map, key, node) => { const list = map.get(key); if (list) list.push(node); else map.set(key, [node]); };
  for (const node of nodes) {
    /* 트리거 노드(`trigger:list.jsp#a.fnSave`)는 호출 대상이 아니다 — 점으로 자르면 끝이 `fnSave`라
     * 같은 화면의 `fnSave()` 호출 후보로 끼어들어 호출이 모호해졌다. 바인딩 해석도 원래 트리거를 뺐다. */
    if (node.type === "trigger") continue;
    const parts = node.id.split(".");
    const simple = parts.at(-1);
    pushTo(nodeBySimple, simple, node);
    if (parts.length > 1) pushTo(nodeByOwnerSimple, `${parts.at(-2)}\u0000${simple}`, node);
    pushTo(nodeByOwnerId, `${parts.slice(0, -1).join(".")}\u0000${simple}`, node);
  }
  const qualifierMemo = new Map();
  const sameOwnerSafeExt = new Set([".java", ".kt", ".kts", ".cs", ".vue", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ...SQL_COMMENT_EXTENSIONS, ...PROC_EXTENSIONS, ...PB_EXTENSIONS,
    /* 화면 인라인 스크립트의 한정자 없는 호출은 같은 화면 함수가 먼저다(JS 스코프와 같다). */
    ".jsp", ".jspx", ".jspf", ".tag", ".asp", ".aspx", ".ascx", ".html", ".htm"]);
  /*
   * 이름이 겹치는 후보가 둘 이상일 때 스코프(같은 파일 → 같은 패키지 → 같은 워크스페이스)로 좁혀
   * 하나로 줄면 결정론적으로 확정하는 방안을 구현했다가 **되돌렸다**(2026-08-16).
   * `same_file` 규칙이 호출 한정자(qualifier)를 보지 않아 `cache.save()`처럼 *다른 객체*를 통한
   * 호출을 같은 파일 안의 동명 메서드로 이어버렸다 — 없는 엣지를 지어내지 않는다는 이 인덱서의
   * 계약을 정면으로 위반하고, 게다가 미해결 목록에서도 사라져 analyzer가 바로잡을 기회조차 없앴다.
   * `same_package` 규칙은 노드에 `package` 필드가 없어 애초에 한 번도 발동하지 않았고,
   * 실측에서 미해결 감소량도 0이었다. 위험만 있고 이득이 없어 넣지 않는다.
   * 미해결 항목의 실제 비용 문제는 아래 우선순위 정렬(판정 가능한 것부터)에서 해결한다.
   */

  /*
   * 화면 스크립트의 호출 범위. 다른 JSP 화면의 함수는 이 화면에 실리지 않으므로 후보가 아니다 —
   * `function alert()`를 재정의한 화면 몇 개 때문에 모든 화면의 `alert()`가 모호해졌다(실측 438건).
   * 같은 화면, (중첩) 인클루드한 파일, 마크업이 아닌 외부 스크립트(.js 등)만 남긴다.
   */
  const MARKUP_PAGE = /\.(?:jsp|jspx|jspf|tag|asp|aspx|ascx|html?)$/i;
  const filesByBase = new Map();
  for (const fact of facts) {
    const base = fact.rel.split("/").at(-1);
    const list = filesByBase.get(base);
    if (list) list.push(fact.rel); else filesByBase.set(base, [fact.rel]);
  }
  const directIncludes = new Map();
  for (const fact of facts) {
    if (!fact.includes?.length) continue;
    const resolved = [];
    for (const raw of fact.includes) {
      const target = raw.startsWith("/") ? raw.replace(/^\/+/, "") : slash(join(dirname(fact.rel), raw));
      const hit = (filesByBase.get(target.split("/").at(-1)) || []).find((file) => file === target || file.endsWith(`/${target}`));
      if (hit) resolved.push(hit);
    }
    directIncludes.set(fact.rel, resolved);
  }
  const pageScopeMemo = new Map();
  const pageScope = (file) => {
    if (pageScopeMemo.has(file)) return pageScopeMemo.get(file);
    const scope = new Set([file]);
    const stack = [file];
    while (stack.length) for (const next of directIncludes.get(stack.pop()) || []) if (!scope.has(next)) { scope.add(next); stack.push(next); }
    pageScopeMemo.set(file, scope);
    return scope;
  };
  const inPageScope = (file, candidate) => !MARKUP_PAGE.test(candidate.file || "") || pageScope(file).has(candidate.file);
  /* 화면(과 인클루드)이 `<script src>`로 싣는 파일. 후보가 여럿이면 실린 스크립트·같은 화면 쪽만 남긴다. */
  const scriptsByFile = new Map(facts.filter((item) => item.scripts?.length).map((item) => [item.rel, item.scripts]));
  const pathVarsByFile = new Map(facts.filter((item) => item.pathVars?.length).map((item) => [item.rel, item.pathVars]));
  const propertyValues = new Map();
  for (const [key, value] of facts.flatMap((item) => item.properties || [])) {
    const list = propertyValues.get(key);
    if (list) list.push(value); else propertyValues.set(key, [value]);
  }
  /*
   * 경로 변수 값. 실행해야 아는 조각(`CONTEXT_PATH`·`strPath`) 뒤에 이어지는 확정 부분만 쓴다 —
   * 앞부분을 모르는 채 이어 붙이면 틀린 경로가 되지만, 뒷부분은 그대로 파일 경로의 꼬리다.
   */
  const pathVarValues = (vars) => {
    const values = new Map();
    for (const variable of vars) {
      const lastUnknown = variable.parts.map((part) => Boolean(part.unknown)).lastIndexOf(true);
      let options = [""];
      for (const part of variable.parts.slice(lastUnknown + 1)) {
        const choices = part.literal !== undefined ? [part.literal] : propertyValues.get(part.key) || [""];
        options = options.flatMap((prefix) => choices.map((choice) => prefix + choice));
      }
      values.set(variable.name, [...new Set([...(values.get(variable.name) || []), ...options])]);
    }
    return values;
  };
  /* `<%= JS_PATH %>forms.js` → `html/script/js/forms.js`. 모르는 식은 버리고 앞의 `/`·`./`를 떼어 경로 꼬리로 쓴다. */
  const expandScript = (raw, vars) => {
    let expansions = [raw];
    for (const match of raw.matchAll(/<%=\s*(\w+)\s*%>/g)) {
      const values = vars.get(match[1]) || [""];
      expansions = expansions.flatMap((item) => values.map((value) => item.replace(match[0], value)));
    }
    return expansions.map((item) => item.replace(/<%[\s\S]*?%>|\$\{[^}]*\}/g, "").replace(/\/{2,}/g, "/").replace(/^(?:\.{0,2}\/)+/, "")).filter(Boolean);
  };
  const loadedMemo = new Map();
  const loadedScripts = (file) => {
    if (!loadedMemo.has(file)) {
      const scope = [...pageScope(file)];
      const vars = pathVarValues(scope.flatMap((item) => pathVarsByFile.get(item) || []));
      loadedMemo.set(file, [...new Set(scope.flatMap((item) => (scriptsByFile.get(item) || []).flatMap((raw) => expandScript(raw, vars))))]);
    }
    return loadedMemo.get(file);
  };
  const preferLoaded = (file, candidates) => {
    if (candidates.length < 2) return candidates;
    const suffixes = loadedScripts(file);
    if (!suffixes.length) return candidates;
    const kept = candidates.filter((item) => MARKUP_PAGE.test(item.file || "")
      || suffixes.some((suffix) => item.file === suffix || String(item.file).endsWith(`/${suffix}`)));
    return kept.length ? kept : candidates;
  };
  /*
   * 짝 저장소(pair_config.md)의 JS 함수. 서버 JSP가 `<script src>`로 별도 저장소(정적 자원·클라이언트)의 .js를
   * 불러와 그 함수를 부르는 구조가 흔한데, 인덱스가 저장소마다 따로라 화면 이벤트가 전부 "대상 없음"이었다
   * (실측 2,417건). API 계약만 합치던 것을 넘어, 짝 인덱스의 JS 함수를 화면 스크립트의 후보로 쓴다.
   * 실제로 이어진 것만 `source: "external"` 노드로 남긴다 — 짝 저장소 인덱스가 먼저 만들어져 있어야 한다.
   */
  const externalBySimple = new Map();
  for (const link of pairConfig(options.root)?.partners || []) {
    const graph = readJson(join(link.partner_root, "_workspace", "index", "call_graph.json"), null);
    if (!graph?.nodes) continue;
    const label = basename(String(link.partner_root).replace(/[\\/]+$/, ""));
    for (const node of graph.nodes) {
      if (node.source === "external" || !["method", "function"].includes(node.type)) continue;
      if (!JS_FAMILY_EXTENSIONS.includes(extname(node.file || "").toLowerCase())) continue;
      const simple = node.id.split(".").at(-1);
      const external = { id: `ext:${label}:${node.id}`, type: "external_function", file: node.file, line: node.line, source: "external", external_repo_path: link.partner_root, workspace: `partner:${label}`, origin: "deterministic-indexer", confidence: "MEDIUM" };
      const list = externalBySimple.get(simple);
      if (list) list.push(external); else externalBySimple.set(simple, [external]);
    }
  }
  const pageCandidates = (file, name, own) => preferLoaded(file, [...own, ...(externalBySimple.get(name) || [])].filter((item) => inPageScope(file, item)));

  const edges = [];
  const unresolved = [];
  for (const binding of bindings) {
    let candidates = (nodeBySimple.get(binding.handler_name) || []).filter((item) => item.type !== "trigger");
    if (MARKUP_PAGE.test(binding.file || "")) candidates = pageCandidates(binding.file, binding.handler_name, candidates);
    /*
     * 템플릿 이벤트 핸들러(@click 등)·markup 이벤트는 반드시 같은 파일의 스크립트 블록에
     * 정의된 메서드다 — qualifier 기반 호출(obj.method())과 달리 "다른 객체를 통한 동명
     * 메서드"일 가능성이 구조적으로 없다(템플릿 바인딩은 항상 로컬 컴포넌트 메서드를 가리킨다).
     * 그래서 same_file 좁히기가 안전하다(2026-08-19 추가) — 위에서 call qualifier에 썼다가
     * 되돌린 same_file 휴리스틱과는 위험 성격이 다르다: 그건 "다른 객체일 수 있음"이 문제였고
     * (실제로 `cache.save()`를 오연결), 여기는 애초에 다른 파일을 가리킬 수가 없다.
     * 1,100개 근사-반복 화면에서 handler 이름(save/search 등)이 겹치는 경우가 흔해(2026-08-19
     * 실측, Vue 템플릿 이벤트 바인딩 추출 추가 직후 미해결 5,300건 급증 확인) 이 좁히기 없이는
     * 템플릿 이벤트 추출 자체가 손해가 된다.
     * process_entry(`main`)·scheduler(`@Scheduled` 바로 아래 메서드)도 같은 파일의 메서드에서
     * 만들어진 바인딩이라 다른 파일을 가리킬 수 없다 — 배치 프로그램마다 `main`이 있는 Pro*C·Java
     * 배치에서 진입점이 전부 모호하다고 AI 판정 대기열에 올라가던 것을 막는다(2026-09-24).
     */
    if (candidates.length > 1 && ["ui_event", "markup_event", "process_entry", "scheduler"].includes(binding.type)) {
      const sameFile = candidates.filter((item) => item.file === binding.file);
      if (sameFile.length === 1) candidates = sameFile;
    }
    if (candidates.length === 1) edges.push({ from: `trigger:${binding.trigger}`, to: candidates[0].id, type: binding.type, file: binding.file, line: binding.line, workspace: binding.workspace, origin: "deterministic-indexer", confidence: "HIGH" });
    else unresolved.push({ kind: "unresolved_trigger", trigger: binding.trigger, handler_name: binding.handler_name, candidates: candidates.map((item) => item.id), file: binding.file, line: binding.line, workspace: binding.workspace });
  }
  /** 본체 소스가 없는 저장 프로시저. 호출 엣지의 대상으로만 쓰인다. @type {Map<string, any>} */
  const dbProcedures = new Map();
  for (const call of callSites) {
    let candidates = nodeBySimple.get(call.name) || [];
    /* 한정자 없는 화면 스크립트 호출만 좁힌다 — `opener.fnX()`·`parent.fnX()`는 정당하게 다른 화면을 가리킨다. */
    if (!call.qualifier && MARKUP_PAGE.test(call.file || "")) candidates = pageCandidates(call.file, call.name, candidates);
    if (call.qualifier) {
      /*
       * 한정자를 **선언 타입**으로 먼저 해석한다. `sqlSession.insert(...)`의 `sqlSession`은
       * `SqlSessionTemplate` 필드이므로 후보인 `*Dao.insert`들과는 아무 관계가 없다.
       * 예전에는 이름이 겹치지 않으면 후보를 그대로 두어(아래 폴백) 오답뿐인 목록이
       * LLM 판정 대기열로 갔다. 타입을 알면 셋 중 하나로 정확히 갈린다.
       */
      const localType = localTypeAt(call.caller, call.qualifier, call.line);
      const declaredType = localType !== undefined ? localType : fieldTypes.get(`${ownerIdOf(call.caller)}::${call.qualifier}`);
      /* 클래스 이름 그대로인 한정자(`Pager.calBetweenRow`)는 정적 호출이다 — 부분 문자열(`FrontPager`)이 아니라 정확히 그 클래스. */
      const staticOwner = !declaredType && /^[A-Z]/.test(call.qualifier) ? nodeByOwnerSimple.get(`${call.qualifier}\u0000${call.name}`) : null;
      if (staticOwner?.length) {
        candidates = staticOwner;
      } else if (declaredType) {
        candidates = indexedSimpleNames.has(declaredType) ? nodeByOwnerSimple.get(`${declaredType}\u0000${call.name}`) || [] : [];
        /*
         * 선언 타입에 그 메서드 본문이 없으면(외부 jar 인터페이스 `User`, 본문 없는 인터페이스 선언)
         * 그 타입을 implements·extends한 우리 클래스의 메서드로 간다 — `User user; user.getLoginId()`는
         * 런타임에 `UserSession implements User`로 디스패치된다. 구현이 없으면 외부 호출이라 버린다.
         */
        if (!candidates.length) {
          candidates = (implementorsOf.get(declaredType) || []).flatMap((classId) => nodeByOwnerId.get(`${classId}\u0000${call.name}`) || []);
          if (!candidates.length) continue;
        }
      } else {
        /*
         * 선언 타입을 못 찾은 한정자(대부분 지역변수 — fieldTypes는 필드만 추적한다)는
         * id 부분 문자열로 근사 매칭한다. **매칭이 0건이면 후보를 그대로 두지 않고 비운다**
         * (2026-08-19 수정) — 이전엔 `if (qualified.length) candidates = qualified`라 매칭
         * 0건일 때 "필터링 정보 없음"으로 취급해 원래의 전체 후보(동명 메서드 전부)를 그대로
         * 썼다. 그런데 한정자가 있는데 그 후보들 중 단 하나도 이름이 비슷하지 않다는 건
         * "필터링 정보 없음"이 아니라 "이 후보들은 전부 아니다"라는 더 강한 신호다(예:
         * `jobBuilderFactory.get(...)`의 15개 "get" 후보 전부가 무관한 `*Job.get`/
         * `DataSourceContextHolder.get` — 전부 프레임워크/무관 클래스). 매칭 0건을 무후보로
         * 처리해야 이런 케이스가 미해결 목록에 쌓이지 않는다(실측: 백엔드 미해결 9,691건이
         * 전부 이 한 가지 패턴이었다).
         */
        const memoKey = `${call.name}\u0000${call.qualifier.toLowerCase()}`;
        if (!qualifierMemo.has(memoKey)) qualifierMemo.set(memoKey, candidates.filter((item) => item.id.toLowerCase().includes(call.qualifier.toLowerCase())));
        candidates = qualifierMemo.get(memoKey);
      }
    }
    /*
     * 한정자 없는 호출(`method(...)`, 앞에 `obj.`가 없음)은 자바/코틀린/C# 스코프 규칙상
     * 같은 클래스(또는 상위 클래스) 멤버를 가리킨다 — qualifier가 있는 호출과 달리 "다른
     * 객체를 통한 동일 이름 메서드"일 가능성이 문법적으로 없다(2026-08-19 추가). 되돌린
     * same_file 휴리스티과 위험 성격이 다르다: 그건 qualifier 호출에 적용해 "다른 객체일
     * 수 있음"이 문제였고, 여기는 한정자가 없는 호출에만 적용해 애초에 다른 클래스를
     * 가리킬 문법적 경로가 없다(정적 임포트한 동명 메서드가 있는 극히 드문 경우도, 같은
     * 클래스에 동명 메서드가 있으면 스코프 규칙상 그 쪽이 항상 우선한다).
     *
     * **Python·Go는 이 규칙에서 제외한다.** Python은 클래스 메서드 호출에도 `self.foo()`가
     * 필수라 한정자 없는 `foo()`는 클래스 멤버가 아닌 별개 함수를 가리키고, Go는 메서드에
     * 리시버가 항상 명시적이며 패키지가 파일 하나가 아니라 디렉터리 전체에 걸친다 —
     * "같은 owner"가 "같은 파일"과 대응되지 않아 좁히기가 오답을 낼 수 있다.
     *
     * JS/TS/Vue는 포함한다 — 클래스 메서드는 `this.foo()`가 필수라 이미 qualifier로 잡히므로
     * 이 분기(한정자 없음)에 오지 않고, 한정자 없는 `foo()`는 클로저/모듈 스코프 함수 참조라
     * JS 문법상 정확히 "같은 파일(Vue는 파일당 owner가 고유)"로 좁히는 게 맞다(2026-08-19,
     * 다른 스택 적용 가능성을 검토하며 실제 소스로 재검증 — `LoginE2ms.vue`의 `loginClick`이
     * `setup()` 안에서 지역 함수 `setPassword`를 바로 호출하는 경우가 정확히 이 패턴이었고,
     * 실제로 같은 파일의 그 함수를 가리키는 게 맞았다).
     */
    /* `new QueryUpdateException(...)`는 클래스 노드와 생성자 노드(`X.X`)가 함께 후보가 된다 — 생성자다. */
    if (candidates.length > 1) {
      const constructors = (nodeByOwnerSimple.get(`${call.name}\u0000${call.name}`) || []).filter((item) => item.type === "method" && candidates.includes(item));
      if (constructors.length === 1) candidates = constructors;
    }
    const callExt = extname(call.file).toLowerCase();
    if (!call.qualifier && candidates.length > 1 && sameOwnerSafeExt.has(callExt)) {
      const sameClass = nodeByOwnerId.get(`${ownerIdOf(call.caller)}\u0000${call.name}`) || [];
      if (sameClass.length === 1) candidates = sameClass;
      else if (!sameClass.length && [".java", ".kt", ".kts", ".cs"].includes(callExt)) {
        for (let ancestor = superClassOf(ownerIdOf(call.caller)), depth = 0; ancestor && depth < 10; ancestor = superClassOf(ancestor), depth += 1) {
          const inherited = nodeByOwnerId.get(`${ancestor}\u0000${call.name}`) || [];
          if (inherited.length === 1) { candidates = inherited; break; }
          if (inherited.length > 1) break;
        }
      }
    }
    /*
     * 저장 프로시저 본체가 이 저장소에 없으면(DB 에만 있음) 후보가 0개라 연결이 조용히 버려졌다.
     * 실측(eduLms): 수강신청 등록 PR_LS_APPLY_FRONT_PROC 를 부르는 메서드 10곳이 call_graph 에 없어
     * 영향도 분석이 프로시저를 거치는 변경을 볼 수 없었다. 외부 DB 프로시저 노드로 남겨 잇는다.
     */
    if (!candidates.length && call.procedure) {
      const id = `db:${call.qualifier ? `${call.qualifier}.` : ""}${call.name}`;
      if (!dbProcedures.has(id)) dbProcedures.set(id, { id, type: "db_procedure", name: call.name, file: call.file, line: call.line, source: "external", workspace: call.workspace, origin: "deterministic-indexer", confidence: "MEDIUM" });
      edges.push({ from: call.caller, to: id, type: "call", file: call.file, line: call.line, workspace: call.workspace, origin: "deterministic-indexer", confidence: "MEDIUM" });
      continue;
    }
    if (candidates.length === 1 && candidates[0].id !== call.caller) {
      edges.push({ from: call.caller, to: candidates[0].id, type: "call", file: call.file, line: call.line, workspace: call.workspace, origin: "deterministic-indexer", confidence: call.qualifier ? "HIGH" : "MEDIUM" });
    } else if (candidates.length > 1) {
      unresolved.push({ kind: "ambiguous_call", caller: call.caller, expression: `${call.qualifier ? `${call.qualifier}.` : ""}${call.name}(...)`, candidates: candidates.map((item) => item.id), file: call.file, line: call.line, workspace: call.workspace });
    }
  }
  nodes.push(...dbProcedures.values());
  for (const injection of injects) {
    const candidates = nodeBySimple.get(injection.targetName) || [];
    if (candidates.length === 1) edges.push({ from: injection.owner, to: candidates[0].id, type: "inject", file: injection.file, line: injection.line, workspace: injection.workspace, origin: "deterministic-indexer", confidence: "HIGH" });
    else if (candidates.length > 1) unresolved.push({ kind: "ambiguous_injection", from: injection.owner, target_name: injection.targetName, candidates: candidates.map((item) => item.id), file: injection.file, line: injection.line, workspace: injection.workspace });
  }
  /*
   * 상속 관계는 심볼의 extends/implements에만 기록돼 있고 엣지로는 해석되지 않았다.
   * 그래서 클래스가 있는 프로젝트에서 validator_checks가 "class 노드 N개 존재하나 inherit edge 0개"를
   * 항상 WARN했다. 호출·주입과 같은 규칙(후보 정확히 1개일 때만 엣지)으로 해석한다.
   *
   * extends/implements는 문법상 대상 종류가 갈린다 — `implements`는 반드시 interface만,
   * `extends`는 (interface의 interface 상속을 빼면) class/enum/record/object만 대상이 될 수 있다.
   * 이건 추측이 아니라 언어 규칙이므로(2026-08-16에 되돌린 same_file/same_package 근접 추론과는
   * 성격이 다르다 — 그건 관련 없는 객체를 같은 이름이라는 이유만으로 이어버릴 위험이 있었다),
   * 동명이인 후보 중 타입이 안 맞는 쪽을 걸러내면 순수하게 unresolved 큐만 줄어든다.
   */
  const inheritTargets = (baseName, symbol) => {
    const simple = String(baseName).split(".").at(-1).replace(/<.*/, "").trim();
    if (!simple) return null;
    return { simple, candidates: (nodeBySimple.get(simple) || []).filter((item) => item.type !== "method" && item.type !== "trigger" && item.id !== symbol.id) };
  };
  const resolveInherit = (symbol, simple, candidates) => {
    if (candidates.length === 1) {
      edges.push({ from: symbol.id, to: candidates[0].id, type: "inherit", file: symbol.file, line: symbol.line, workspace: symbol.workspace, origin: "deterministic-indexer", confidence: "HIGH" });
    } else if (candidates.length > 1) {
      unresolved.push({ kind: "ambiguous_inherit", from: symbol.id, target_name: simple, candidates: candidates.map((item) => item.id), file: symbol.file, line: symbol.line, workspace: symbol.workspace });
    }
  };
  for (const symbol of symbols) {
    if (symbol.extends) {
      const target = inheritTargets(symbol.extends, symbol);
      if (target) resolveInherit(symbol, target.simple, target.candidates.filter((item) => item.type !== "interface"));
    }
    for (const baseName of symbol.implements || []) {
      const target = inheritTargets(baseName, symbol);
      if (target) resolveInherit(symbol, target.simple, target.candidates.filter((item) => item.type === "interface"));
    }
  }

  let endpoints = unique(composeFastApiEndpoints(facts, facts.flatMap((item) => item.endpoints)), (item) => item.id);
  let consumers = unique(facts.flatMap((item) => item.consumers), (item) => item.id);
  const pair = pairConfig(options.root);
  /* 파트너 N개의 계약을 모두 병합한다. 구형 단일 파트너는 길이 1인 목록으로 처리된다. */
  for (const link of pair?.partners || []) {
    if (!link.partner_api_contract || !existsSync(link.partner_api_contract)) continue;
    const partner = readJson(link.partner_api_contract, {});
    const externalize = (item) => ({ ...item, source: "external", external_repo_path: link.partner_root, origin: item.origin || "deterministic-indexer" });
    endpoints = unique([...endpoints, ...(partner.endpoints || []).filter((item) => item.source !== "external").map(externalize)], (item) => item.id);
    consumers = unique([...consumers, ...(partner.consumers || []).filter((item) => item.source !== "external").map(externalize)], (item) => item.id);
  }
  const matches = [];
  const matchedEndpoints = new Set();
  const matchedConsumers = new Set();
  /*
   * 엔드포인트 × 컨슈머 전수 비교는 O(E·C)다 — 엔드포인트 1만 · 컨슈머 10만이면 10억 회로
   * 이 루프만 수십 초가 걸린다. 매칭 조건이 결국 path_pattern 완전 일치이므로
   * 컨슈머를 path_pattern으로 한 번 그룹핑해 두고 엔드포인트마다 해당 버킷만 본다.
   */
  const consumersByPath = new Map();
  for (const consumer of consumers) {
    const bucket = consumersByPath.get(consumer.path_pattern);
    if (bucket) bucket.push(consumer);
    else consumersByPath.set(consumer.path_pattern, [consumer]);
  }
  for (const endpoint of endpoints) {
    if (endpoint.prefix_resolved === false) continue;
    for (const consumer of consumersByPath.get(endpoint.path_pattern) || []) {
      if (endpoint.method !== "ANY" && consumer.method !== endpoint.method) continue;
      matches.push({ endpoint_id: endpoint.id, consumer_id: consumer.id, match_type: "path_pattern", confidence: "HIGH", shape_match: "UNKNOWN", origin: "deterministic-indexer" });
      matchedEndpoints.add(endpoint.id); matchedConsumers.add(consumer.id);
    }
  }
  const sqls = unique(allSqls, (item) => item.id);
  /* 후보(쿼리 ID 상수 참조)는 실제로 존재하는 SQL id일 때만 사용처로 인정한다 — 그냥 대문자 상수와 구분. */
  const sqlIds = new Set(sqls.map((item) => item.id));
  /* 프로시저 호출 문장을 쓰는 곳은 위에서 call_graph 엣지가 됐다 — SQL 사용처로 두 번 세지 않는다. */
  const callableIds = new Set(callables.map((item) => item.id));
  const usages = unique(
    facts.flatMap((item) => item.usages)
      .map((item) => ({ ...item, sql_id: resolveStatementId(item.sql_id) }))
      .filter((item) => !callableIds.has(item.sql_id) && (!item.candidate || sqlIds.has(item.sql_id))),
    (item) => `${item.sql_id}:${item.file}:${item.line}`,
  ).map(({ candidate, ...rest }) => rest);
  const sqlRelations = unique(facts.flatMap((item) => item.relations || []), (item) => `${item.from_table}:${item.from_columns?.join(",")}:${item.to_table}:${item.to_columns?.join(",")}:${item.file}:${item.line}`);
  const boundaries = unique(facts.flatMap((item) => item.boundaries), (item) => item.id);
  const communications = unique(facts.flatMap((item) => item.communications), (item) => item.id);
  const profiles = [...new Set(facts.flatMap((item) => item.env.profiles))];
  const branches = unique(facts.flatMap((item) => item.env.branches), (item) => `${item.file}:${item.line}:${item.marker}`);
  const tables = unique(facts.flatMap((item) => item.tables), (item) => item.name.toLowerCase());
  const uiFlow = {
    screens: unique(facts.flatMap((item) => item.uiFlow?.screens || []), (item) => `${item.file}:${item.id}`),
    events: unique(facts.flatMap((item) => item.uiFlow?.events || []), (item) => `${item.file}:${item.component}:${item.event}:${item.handler}`),
    datasets: unique(facts.flatMap((item) => item.uiFlow?.datasets || []), (item) => `${item.file}:${item.id}`),
    transactions: unique(facts.flatMap((item) => item.uiFlow?.transactions || []), (item) => `${item.file}:${item.line}:${item.service_id}`),
  };
  const foreignKeyRelations = tables.flatMap((table) => (table.foreign_keys || []).map((foreignKey) => ({
    type: "foreign_key", name: foreignKey.name || "", from_table: table.name, from_columns: foreignKey.columns || [],
    to_table: foreignKey.references_table, to_columns: foreignKey.references_columns || [],
    file: table.source_file, line: null, evidence: foreignKey.name || "DDL FOREIGN KEY",
    origin: foreignKey.origin || "deterministic-indexer", confidence: foreignKey.confidence || "HIGH",
  })));
  const schemaRelations = unique([...foreignKeyRelations, ...sqlRelations], (item) => `${item.type}:${item.from_table}:${item.from_columns?.join(",")}:${item.to_table}:${item.to_columns?.join(",")}:${item.file}:${item.line}`);
  /*
   * 중복 제거를 in-degree 계산보다 먼저 한다.
   * 예전에는 _meta.edge_count만 중복 포함 배열 길이로 기록돼 실제 edges 배열과 어긋났고
   * (validator_checks가 count 불일치로 FAIL), in-degree도 같은 관계를 여러 번 세고 있었다.
   */
  const uniqueEdges = unique(edges, (item) => `${item.from}:${item.to}:${item.type}`);
  /* 짝 저장소 함수는 실제로 이어진 것만 노드로 남긴다(전부 넣으면 짝 저장소 함수 수천 개가 여기 그래프를 채운다). */
  if (externalBySimple.size) {
    const referenced = new Set(uniqueEdges.map((item) => item.to).filter((id) => id.startsWith("ext:")));
    for (const list of externalBySimple.values()) for (const node of list) if (referenced.has(node.id)) { nodes.push(node); referenced.delete(node.id); }
  }
  const { inDegree } = degreeMaps(nodes, uniqueEdges);
  /* 데드 코드 후보는 전 Tier에서 계산한다. Full 전용이면 Standard 분석이 유지보수 위험을 볼 근거를 잃는다. */
  const unusedMethods = deadCodeCandidates(nodes, inDegree, uniqueEdges, endpoints);
  /*
   * _meta 9필드는 이 저장소의 계약이다(docs/index-spec.md, validator_checks._meta_field_issues).
   * files_scanned/files_total은 analyzer_index_summary가 "분석 커버리지 N/M" 줄로 렌더한다.
   * 인덱서는 발견한 소스를 전수 파싱하므로 둘이 같고 sampled는 항상 false다.
   */
  const commit = gitCommit(options.root);
  const common = {
    generated_at: generatedAt, generator: "deterministic-indexer", version: INDEXER_VERSION,
    /*
     * `source_root`에 절대경로를 박으면 인덱스가 그 사람 PC 전용이 된다 — 팀원마다
     * `E:\\AI\\proj`와 `/home/kim/proj`로 달라져 공유도 diff 검토도 안 된다.
     * 인덱스 안의 다른 모든 경로는 이미 루트 기준 상대경로라 루트는 `.`이면 충분하다
     * (절대경로를 실제로 쓰는 소비자는 없다 — validator_checks는 필드 존재만 확인한다).
     */
    source_root: ".", mode: options.mode,
    git_commit: commit, sampled: false, files_scanned: sourceFileCount, files_total: sourceFileCount,
  };
  const globalMeta = {
    ...common, source_file_count: sourceFileCount, latest_source_commit: commit, latest_source_mtime: latestMtime,
    /* 팀원이 재인덱싱 필요 여부를 판정하는 값 — `--check-stale` 참조. */
    source_fingerprint: sourceFingerprint(options.root, config.include_paths, sourceFiles, new Map(facts.map((item) => [item.rel, item.contentSha1]))),
    tier: options.tier, indexes: [], init_layout: config.init_layout, include_paths: config.include_paths.map((item) => item || "."), workspace_mode: config.workspace_mode, workspaces: config.workspaces,
    unresolved_count: unresolved.length,
    encoding: buildEncodingSummary(facts),
    excluded_sources: buildExclusionSummary(excludedSources),
    complexity: {
      ...complexity,
      selected_tier: options.tier,
      selection: options.requestedTier === "Auto" ? "deterministic-auto" : "user-override",
    },
    adapter_coverage: coverage,
    analysis_budget: {
      initial_ai_calls_per_target: 2,
      targeted_retries_per_target: 1,
      unresolved_batch_size: 200,
      large_index_direct_read: false,
    },
  };
  const output = {
    symbols: { _meta: { ...common, node_count: symbols.length }, symbols },
    call_graph: { _meta: { ...common, node_count: nodes.length, edge_count: uniqueEdges.length }, nodes, edges: uniqueEdges },
  };
  if (sqls.length || usages.length) output.sql_usage = { _meta: common, sqls, usages };
  const glossary = facts.flatMap((item) => item.terms || []);
  if (glossary.length) output.glossary = { _meta: common, entries: glossary };
  if (boundaries.length) output.transactions = { _meta: common, boundaries };
  if (communications.length) output.external_io = { _meta: common, communications };
  if (branches.length) output.env_branches = { _meta: common, profiles, branches };
  /*
   * DDL(.sql)도 라이브 DB 접속도 없는 프로젝트가 흔하다 — 쿼리를 전부 MyBatis/iBatis XML에 두는
   * 레거시가 그렇다. 그 경우에도 sql_usage에는 이미 테이블명이 들어 있으므로(FROM/JOIN 파싱 결과)
   * 그것을 집계해 스키마를 유도한다. 컬럼은 알 수 없으므로 빈 배열이고 confidence는 MEDIUM이다.
   * 실측(2026-08-16 xu25-server): .sql 0개 / SQL 5,348건 → 고유 테이블 2,773개.
   */
  const derivedTables = tables.length ? [] : deriveTablesFromSql(sqls);
  const schemaTables = tables.length ? tables : derivedTables;
  if (schemaTables.length || schemaRelations.length) output.schema = {
    _meta: {
      ...common, relation_count: schemaRelations.length,
      source: tables.length ? "ddl" : (derivedTables.length ? "derived-from-sql" : "none"),
    },
    tables: schemaTables, relations: schemaRelations, views: [], procedures: [], functions: [], triggers: [],
  };
  if (Object.values(uiFlow).some((items) => items.length)) output.ui_flow = { _meta: common, ...uiFlow };
  /*
   * 단일 저장소에서도 자기 엔드포인트·소비처를 기록한다.
   * 이전에는 workspace_mode/pair일 때만 emit해서 모놀리스는 API 인덱스를 아예 갖지 못했다.
   * matches는 producer와 consumer가 함께 존재할 때만 채워지므로 단일 저장소에서 빈 배열이 정상이다.
   */
  /* 파일명은 단수 api_contract.json이다 — 이미 배포된 pair_config.md들이 이 경로를 절대경로로 박고 있다. */
  if (endpoints.length || consumers.length) output.api_contract = {
    _meta: common, endpoints, consumers, matches,
    unmatched_endpoints: endpoints.filter((item) => !matchedEndpoints.has(item.id)).map((item) => item.id),
    unmatched_consumers: consumers.filter((item) => !matchedConsumers.has(item.id)).map((item) => item.id),
  };
  if (unusedMethods.length) output.dead_code = { _meta: common, unused_methods: unusedMethods, unused_sql_ids: [], unused_jsps: [] };
  const clientIndex = deriveClientIndex(facts, nodes, options.root);
  if (clientIndex) output.client_index = { _meta: common, ...clientIndex };
  const beanClassById = new Map(facts.flatMap((item) => item.springBeans || []).map((item) => [item.id, item.className]));
  for (const endpoint of endpoints) {
    if (beanClassById.has(endpoint.dispatch_bean)) endpoint.dispatch_class = beanClassById.get(endpoint.dispatch_bean);
  }
  const dataFlow = deriveDataFlow(endpoints, uniqueEdges, sqls, usages, nodes, beanClassById);
  if (dataFlow) output.data_flow = { _meta: common, ...dataFlow };
  globalMeta.indexes = Object.keys(output);
  return { output, globalMeta, unresolved };
}

/*
 * Legacy Static JS(번들러 없는 JSP+JS 혼합) 탐지와 JS↔JSP 매핑을 기계화한다.
 * 예전에는 analyzer(opus)가 이 전부를 처음부터 grep으로 6~10쌍만 샘플링해 작성했다 —
 * 여기서는 전수·결정론적으로 만들고, 판단이 필요한 ajax_contract/naming_convention/anti_patterns만
 * 비워 둔다(analyzer.md Step 5 참조). analyzer는 _ai_patch.json의 set_client_index_narrative로 그 세 필드만 채운다.
 */
const BUNDLER_MARKERS = ["webpack", "vite", "parcel", "rollup", "cli-service", "next", "nuxt", "esbuild", "rspack", "turbopack"];
function hasBundlerManifest(root, candidateDirs) {
  for (const dir of candidateDirs) {
    const path = join(root, dir, "package.json");
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      const scripts = pkg.scripts || {};
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      if (scripts.build || scripts.dev || deps.some((name) => BUNDLER_MARKERS.some((marker) => name.includes(marker)))) return true;
    } catch {
      /* 손상된 package.json은 번들러 없음으로 간주 — 레거시 판정을 막지 않는다. */
    }
  }
  return false;
}

function deriveClientIndex(facts, nodes, root) {
  /* analyzer.md Step 5의 탐지 기준: JS 100개 이상이 특정 경로에 집중 + 번들러 매니페스트 없음. */
  const jsFacts = facts.filter((item) => extname(item.rel).toLowerCase() === ".js");
  if (jsFacts.length < 100) return null;
  const candidateDirs = new Set(["."]);
  for (const fact of jsFacts) {
    const top = dirname(fact.rel).split("/")[0];
    if (top && top !== ".") candidateDirs.add(top);
  }
  if (hasBundlerManifest(root, [...candidateDirs])) return null;

  const templateFacts = facts.filter((item) => (item.clientRefs || []).length);
  const jspsByJsBasename = new Map();
  for (const fact of templateFacts) {
    for (const src of fact.clientRefs) {
      const base = basename(src).toLowerCase();
      if (!jspsByJsBasename.has(base)) jspsByJsBasename.set(base, []);
      jspsByJsBasename.get(base).push(fact.rel);
    }
  }
  const functionsByFile = new Map();
  for (const node of nodes) {
    if (extname(node.file || "").toLowerCase() !== ".js") continue;
    if (node.type !== "function" && node.type !== "method") continue;
    const list = functionsByFile.get(node.file) || [];
    list.push(node.id.split(".").at(-1));
    functionsByFile.set(node.file, list);
  }
  const sampleMappings = [];
  for (const fact of jsFacts) {
    const jsps = jspsByJsBasename.get(basename(fact.rel).toLowerCase());
    if (!jsps || !jsps.length) continue;
    sampleMappings.push({
      js: fact.rel,
      jsps: [...new Set(jsps)].sort(byCodeUnit),
      functions: [...new Set(functionsByFile.get(fact.rel) || [])].sort(byCodeUnit),
    });
  }
  sampleMappings.sort((left, right) => byCodeUnit(left.js, right.js));

  /* 도메인 구조 — 1단계 디렉터리(back/front 등) → 그 아래 상위 2단계 경로 목록. */
  const domainStructure = new Map();
  for (const fact of jsFacts) {
    const segments = dirname(fact.rel).split("/");
    const top = segments[0] && segments[0] !== "." ? segments[0] : "(root)";
    const domain = segments.slice(1, 3).join("/") || "(root)";
    if (!domainStructure.has(top)) domainStructure.set(top, new Set());
    domainStructure.get(top).add(domain);
  }
  const domainStructureOut = Object.fromEntries(
    [...domainStructure.entries()].sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, set]) => [key, [...set].sort(byCodeUnit).slice(0, 40)]),
  );

  return {
    type: "LegacyStaticJS",
    build_tool: null,
    js_count: jsFacts.length,
    domain_structure: domainStructureOut,
    sample_mappings: sampleMappings,
    jquery_versions: detectLibraryVersions(templateFacts.flatMap((item) => item.clientRefs)),
  };
}

/*
 * data_flow.json 체인 골격 — endpoint에서 call_graph(엣지 타입 call)를 순회해 도달하는
 * 메서드들이 sql_usage로 어떤 SQL/테이블을 건드리는지 조인한다. call_graph·sql_usage는 이미
 * aggregate()가 메모리에 들고 있으므로 추가 파싱 없는 순수 그래프 순회다.
 * DTO/컬럼 의미 매핑처럼 판단이 필요한 부분은 만들지 않는다 — analyzer가
 * _ai_patch.json의 set_flow_note로 각 체인에 note를 붙인다(analyzer.md Step 9 참조).
 *
 * 시작점(seed)은 두 갈래다.
 * 1. `endpoint.handler`가 call_graph 노드 id와 그대로 일치 — Spring MVC/FastAPI/Flask 등
 *    핸들러가 곧 메서드 id인 프레임워크. 단일 시드, MEDIUM.
 * 2. `endpoint.dispatch_bean`(Struts command 속성 = Spring bean id) — WorkerAction류 공용
 *    디스패처를 쓰는 커맨드 패턴은 `handler`가 항상 같은 디스패처 클래스라 1번이 통하지 않는다
 *    (2026-08-17 xu25-server 실측: 액션 443개 중 434개가 동일 type). bean id를 `<bean id="X"
 *    class="Y"/>` 정의로 실제 서비스 클래스까지 역추적한 뒤, 그 클래스의 메서드 전부를 시드로
 *    삼는다 — 어느 메서드가 호출될지는 런타임 파라미터(`parameter="method"`)로 정해져 정적으로
 *    하나로 못 좁히므로, "이 서비스가 건드릴 수 있는 전체 테이블"로 과대추정한다. 여러 시드의
 *    합집합이라 신뢰도는 LOW.
 */
const DATA_FLOW_MAX_DEPTH = 6;
function deriveDataFlow(endpoints, edges, sqls, usages, nodes, beanClassById) {
  if (!endpoints.length) return null;
  const sqlById = new Map(sqls.map((item) => [item.id, item]));
  const sqlIdsByMethod = new Map();
  for (const usage of usages) {
    const list = sqlIdsByMethod.get(usage.method) || [];
    list.push(usage.sql_id);
    sqlIdsByMethod.set(usage.method, list);
  }
  const calleesOf = new Map();
  for (const edge of edges) {
    if (edge.type !== "call") continue;
    const list = calleesOf.get(edge.from) || [];
    list.push(edge.to);
    calleesOf.set(edge.from, list);
  }
  const methodIds = new Set(nodes.filter((item) => item.type === "method").map((item) => item.id));
  const methodsByClass = new Map();
  const methodsByFile = new Map();
  for (const node of nodes) {
    if (node.type !== "method") continue;
    const classId = node.id.split(".").slice(0, -1).join(".");
    const list = methodsByClass.get(classId) || [];
    list.push(node.id);
    methodsByClass.set(classId, list);
    if (node.file) {
      const flist = methodsByFile.get(node.file) || [];
      flist.push(node.id);
      methodsByFile.set(node.file, flist);
    }
  }
  const seedsFor = (endpoint) => {
    const dispatchClass = endpoint.dispatch_class || beanClassById.get(endpoint.dispatch_bean);
    if (dispatchClass) {
      const methods = methodsByClass.get(dispatchClass);
      if (methods?.length) return { ids: methods, confidence: "LOW" };
    }
    if (endpoint.handler && methodIds.has(endpoint.handler)) return { ids: [endpoint.handler], confidence: "MEDIUM" };
    /*
     * 페이지 기반 프레임워크(ASP.NET WebForms .aspx, Classic ASP, JSP)는 handler가 메서드가
     * 아니라 페이지 파일이라 위 두 경로가 모두 빗나간다. 실제 로직은 코드비하인드
     * (X.aspx.cs/.vb)나 페이지 자체 스크립트에 있으므로, 엔드포인트 파일과 그 코드비하인드
     * 파일에 정의된 메서드 전부를 시드로 삼는다 — 어떤 메서드가 실제 실행될지는 요청
     * 파라미터로 갈리므로 "이 페이지가 건드릴 수 있는 전체 테이블"로 과대추정한다(LOW).
     */
    if (endpoint.file) {
      const codeBehind = [endpoint.file, `${endpoint.file}.cs`, `${endpoint.file}.vb`];
      const ids = [...new Set(codeBehind.flatMap((f) => methodsByFile.get(f) || []))];
      if (ids.length) return { ids, confidence: "LOW" };
    }
    return null;
  };
  const chains = [];
  for (const endpoint of endpoints) {
    const seed = seedsFor(endpoint);
    if (!seed) continue;
    const visited = new Set(seed.ids);
    const queue = seed.ids.map((id) => ({ id, depth: 0 }));
    const methodChain = [...seed.ids];
    const sqlIds = new Set();
    const callEdges = [];
    let truncated = false;
    while (queue.length) {
      const { id, depth } = queue.shift();
      for (const sqlId of sqlIdsByMethod.get(id) || []) sqlIds.add(sqlId);
      if (depth >= DATA_FLOW_MAX_DEPTH) {
        if ((calleesOf.get(id) || []).some((callee) => !visited.has(callee))) truncated = true;
        continue;
      }
      for (const callee of calleesOf.get(id) || []) {
        callEdges.push({ from: id, to: callee });
        if (visited.has(callee)) continue;
        visited.add(callee);
        methodChain.push(callee);
        queue.push({ id: callee, depth: depth + 1 });
      }
    }
    const touchedSqls = [...sqlIds].map((id) => sqlById.get(id)).filter(Boolean);
    const tablesRead = [...new Set(touchedSqls.filter((item) => item.type === "select").flatMap((item) => item.tables || []))].sort(byCodeUnit);
    const tablesWritten = [...new Set(touchedSqls.filter((item) => item.type !== "select").flatMap((item) => item.tables || []))].sort(byCodeUnit);
    chains.push({
      id: `dataflow:${endpoint.id}`, endpoint_id: endpoint.id, method_chain: methodChain,
      root_methods: seed.ids, call_edges: callEdges, traversal: "reachable_calls",
      max_depth: DATA_FLOW_MAX_DEPTH, truncated,
      sql_ids: [...sqlIds].sort(byCodeUnit), tables_read: tablesRead, tables_written: tablesWritten,
      confidence: seed.confidence,
    });
  }
  if (!chains.length) return null;
  chains.sort((left, right) => byCodeUnit(left.id, right.id));
  return { chains };
}

function degreeMaps(nodes, edges) {
  const inDegree = new Map(nodes.map((item) => [item.id, 0]));
  const outDegree = new Map(nodes.map((item) => [item.id, 0]));
  for (const edge of edges) {
    if (inDegree.has(edge.to)) inDegree.set(edge.to, inDegree.get(edge.to) + 1);
    if (outDegree.has(edge.from)) outDegree.set(edge.from, outDegree.get(edge.from) + 1);
  }
  return { inDegree, outDegree };
}

/* 트리거에서 시작되는 관계. 이 엣지의 도착점은 아무도 "호출"하지 않아도 진입점이다. */
const TRIGGER_EDGE_TYPES = new Set(["ui_event", "markup_event", "scheduler", "process_entry"]);

/*
 * in-degree 0만으로 데드 코드를 고르면 진입점이 전부 후보로 잡힌다
 * (실측: Vue 프로젝트 61노드 중 51개). agents/analyzer.md Step 15가 요구하는 진입점
 * 화이트리스트를 여기서 적용한다 — 확실한 진입점은 제외하고, 파일만 겹쳐 애매한 것은
 * 버리지 않고 entrypoint_suspect로 표시해 판단을 사람/LLM에게 남긴다.
 */
function deadCodeCandidates(nodes, inDegree, edges, endpoints) {
  const triggerTargets = new Set(edges.filter((item) => TRIGGER_EDGE_TYPES.has(item.type)).map((item) => item.to));
  const handlerKeys = new Set();
  const handlerFiles = new Set();
  /*
   * `endpoint.handler`는 전체 심볼 id(`kr.co...OrderController.list`)인데 아래 조회는 마지막
   * segment(`list`)로 했다 — 키가 절대 맞지 않아 **엔드포인트 핸들러 제외가 한 번도 동작하지 않았다.**
   * 가상 프로젝트에서 데드 코드 후보 23건 중 15건이 정상 동작 중인 컨트롤러 메서드였다.
   * "지워도 되나"를 판단하려고 보는 목록이 오탐 65%면 목록 자체를 못 쓴다.
   * 양쪽을 전체 id와 마지막 segment 모두로 등록해 어느 형태로 와도 걸리게 한다.
   */
  for (const endpoint of endpoints || []) {
    if (endpoint.file && endpoint.handler) {
      handlerKeys.add(`${endpoint.file}::${endpoint.handler}`);
      handlerKeys.add(`${endpoint.file}::${String(endpoint.handler).split(".").at(-1)}`);
    }
    if (endpoint.file) handlerFiles.add(endpoint.file);
  }
  return nodes
    .filter((item) => item.type === "method" && item.visibility !== "private" && (inDegree.get(item.id) || 0) === 0)
    .filter((item) => {
      const name = item.id.split(".").at(-1);
      if (triggerTargets.has(item.id)) return false;
      if (name === "main" || name === "Main") return false;
      return !handlerKeys.has(`${item.file}::${name}`) && !handlerKeys.has(`${item.file}::${item.id}`);
    })
    .map((item) => {
      const suspect = handlerFiles.has(item.file);
      return {
        id: item.id, file: item.file, line: item.line,
        reason: suspect
          ? "call graph in-degree=0; 다만 같은 파일에 API 핸들러가 있어 진입점일 수 있음"
          : "call graph in-degree=0; 동적·외부 호출 검토 필요",
        entrypoint_suspect: suspect, confidence: "LOW", origin: "deterministic-indexer",
      };
    });
}

/* 상한을 적용하고 잘린 개수를 함께 돌려준다. digest는 전체 덤프가 아니라 정직하게 잘린 요약이다. */
function capped(items, limit) {
  return { items: items.slice(0, limit), truncated: Math.max(0, items.length - limit) };
}

function groupCount(items, keyOf, limit) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item) || "unknown";
    if (!groups.has(key)) groups.set(key, { key, count: 0, sample: null });
    const group = groups.get(key);
    group.count += 1;
    if (!group.sample && item.file) group.sample = item.line ? `${item.file}:${item.line}` : item.file;
  }
  const sorted = [...groups.values()].sort((left, right) => right.count - left.count || byCodeUnit(String(left.key), String(right.key)));
  return capped(sorted, limit);
}

/*
 * 호출 그래프 해석 재료.
 * 허브(in-degree 상위)와 진입점(trigger·endpoint 핸들러·in-degree 0 공개 심볼)은
 * 인덱서가 이미 계산할 수 있는데도 지금까지 버려져서, analyzer가 구조를 해석할 근거가 없었다.
 */
function graphDigest(nodes, edges, limits = DIGEST_LIMITS) {
  const { inDegree, outDegree } = degreeMaps(nodes, edges);
  const describe = (node) => ({
    id: node.id, type: node.type, file: node.file, line: node.line,
    in_degree: inDegree.get(node.id) || 0, out_degree: outDegree.get(node.id) || 0,
  });
  const byDegree = (left, right) =>
    (inDegree.get(right.id) || 0) - (inDegree.get(left.id) || 0)
    || (outDegree.get(right.id) || 0) - (outDegree.get(left.id) || 0)
    || byCodeUnit(left.id, right.id);
  const hubs = capped(nodes.filter((item) => (inDegree.get(item.id) || 0) > 0).sort(byDegree).map(describe), limits.hubs);
  const triggerTargets = new Set(edges.filter((edge) => String(edge.from).startsWith("trigger:")).map((edge) => edge.to));
  const entryCandidates = nodes.filter((item) =>
    item.type === "trigger"
    || triggerTargets.has(item.id)
    || (item.type !== "trigger" && (inDegree.get(item.id) || 0) === 0 && (outDegree.get(item.id) || 0) > 0));
  const entryPoints = capped(
    entryCandidates
      .sort((left, right) => (outDegree.get(right.id) || 0) - (outDegree.get(left.id) || 0) || byCodeUnit(left.id, right.id))
      .map((item) => ({ ...describe(item), reached_by_trigger: item.type === "trigger" || triggerTargets.has(item.id) })),
    limits.entry_points,
  );
  return {
    hubs: hubs.items, hubs_truncated: hubs.truncated,
    entry_points: entryPoints.items, entry_points_truncated: entryPoints.truncated,
  };
}

/* 디렉터리 depth 2 단위 모듈 윤곽. validator가 이 목록으로 "주요 모듈 미언급"을 잡는다. */
function moduleDigest(output, limits = DIGEST_LIMITS) {
  const modules = new Map();
  const bucketOf = (file) => {
    const parts = slash(file).split("/").filter(Boolean);
    if (parts.length <= 1) return ".";
    return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  };
  const touch = (file, key) => {
    if (!file) return;
    const bucket = bucketOf(file);
    if (!modules.has(bucket)) modules.set(bucket, { path: bucket, files: new Set(), symbols: 0, sqls: 0, endpoints: 0 });
    const entry = modules.get(bucket);
    entry.files.add(file);
    if (key) entry[key] += 1;
  };
  for (const item of output.symbols?.symbols || []) touch(item.file, "symbols");
  for (const item of output.sql_usage?.sqls || []) touch(item.file, "sqls");
  for (const item of output.api_contract?.endpoints || []) touch(item.file, "endpoints");
  for (const item of output.call_graph?.nodes || []) touch(item.file, null);
  const sorted = [...modules.values()]
    .map((item) => ({ path: item.path, files: item.files.size, symbols: item.symbols, sqls: item.sqls, endpoints: item.endpoints }))
    .sort((left, right) => right.files - left.files || byCodeUnit(left.path, right.path));
  const result = capped(sorted, limits.modules);
  return { modules: result.items, modules_truncated: result.truncated };
}

/*
 * analyzer가 해석해야 할 결정적 사실 요약 전체.
 * 인덱서가 이미 추출한 데이터의 정렬·집계이므로 추가 파싱과 AI 호출이 없다.
 */
function buildDigest(output, globalMeta, limits = DIGEST_LIMITS) {
  const nodes = output.call_graph?.nodes || [];
  const edges = output.call_graph?.edges || [];
  const boundaries = output.transactions?.boundaries || [];
  const communications = output.external_io?.communications || [];
  const externalIoFiles = new Set(communications.map((item) => `${item.file}:${item.line}`));
  const transactions = capped(
    boundaries.map((item) => ({
      id: item.id, file: item.file, line: item.line, marker: item.marker,
      propagation: item.propagation, isolation: item.isolation,
      external_io_in_scope: (item.external_io_calls || []).length,
      /* 경계 내부에서 외부 호출이 일어나면 롤백 불가 구간이므로 위험 신호로 표시한다. */
      risk: (item.external_io_calls || []).length > 0 ? "external-io-in-transaction" : null,
    })),
    limits.transactions,
  );
  const externalIo = groupCount(communications, (item) => item.type, limits.external_io);
  const envBranches = groupCount(output.env_branches?.branches || [], (item) => item.marker, limits.env_branches);
  const tables = capped(
    (output.schema?.tables || []).map((item) => ({
      name: item.name, columns: (item.columns || []).length,
      foreign_keys: (item.foreign_keys || []).length, file: item.source_file || null,
    })),
    limits.tables,
  );
  const endpoints = capped(
    (output.api_contract?.endpoints || []).map((item) => ({
      id: item.id, method: item.method, path: item.path_pattern, file: item.file, line: item.line,
      prefix_resolved: item.prefix_resolved !== false,
    })),
    limits.endpoints,
  );
  const sqls = output.sql_usage?.sqls || [];
  const sqlTableCounts = new Map();
  for (const sql of sqls) for (const table of sql.tables || []) {
    const key = String(table).toLowerCase();
    sqlTableCounts.set(key, (sqlTableCounts.get(key) || 0) + 1);
  }
  const sqlTables = capped(
    [...sqlTableCounts.entries()].map(([name, count]) => ({ name, statements: count }))
      .sort((left, right) => right.statements - left.statements || byCodeUnit(left.name, right.name)),
    limits.sql_tables,
  );
  const deadCode = capped(output.dead_code?.unused_methods || [], limits.dead_code);
  /*
   * PARTIAL/WARN 파일을 확장자별로 노출한다.
   * analyzer는 전체 재순회 대신 이 목록이 지목한 좌표만 선택 열람해 커버리지 구멍을 메운다.
   */
  const coverage = globalMeta.adapter_coverage || {};
  const partialExtensions = capped(
    (coverage.extensions || []).filter((item) => item.level !== "FULL")
      .sort((left, right) => right.files - left.files || byCodeUnit(left.extension, right.extension)),
    limits.partial_coverage,
  );
  const unsupported = capped(coverage.unsupported_files || [], limits.partial_coverage);
  return {
    ...graphDigest(nodes, edges, limits),
    ...moduleDigest(output, limits),
    transactions: transactions.items, transactions_truncated: transactions.truncated,
    external_io_by_type: externalIo.items, external_io_by_type_truncated: externalIo.truncated,
    env_profiles: output.env_branches?.profiles || [],
    env_branches_by_marker: envBranches.items, env_branches_by_marker_truncated: envBranches.truncated,
    tables: tables.items, tables_truncated: tables.truncated,
    endpoints: endpoints.items, endpoints_truncated: endpoints.truncated,
    sql_statement_count: sqls.length,
    sql_top_tables: sqlTables.items, sql_top_tables_truncated: sqlTables.truncated,
    dead_code_candidates: deadCode.items, dead_code_candidates_truncated: deadCode.truncated,
    transaction_external_io_sites: externalIoFiles.size,
    partial_coverage_extensions: partialExtensions.items, partial_coverage_extensions_truncated: partialExtensions.truncated,
    unsupported_files: unsupported.items, unsupported_files_truncated: unsupported.truncated,
  };
}

/*
 * 미해결 관계 중 상당수는 서로 다른 위치에서 "같은 애매함"이 반복된다 — 예를 들어
 * `user.getUserNo()`가 두 후보(StudySession/UserSession) 사이에서 애매하면, 그 표현식이
 * 나오는 861곳 전부가 사실 동일한 판정 문제다(실측: 레거시 Java 프로젝트에서 판정 대상
 * 2,356건이 실제로는 고유 패턴 188개뿐 — 12.5배 중복, JS 프로젝트에서는 4,860건이 483개).
 * 지금까지는 analyzer가 발생 위치마다 파일을 열어 같은 판정을 반복했다. groupUnresolvedDecidable()은
 * (kind, 식별 필드, candidates) 조합으로 묶어 analyzer가 그룹당 대표 사례 1곳만 판정하고,
 * 나머지 발생 위치는 같은 판정을 기계적으로 재적용하게 한다 — _ai_patch.json에는 여전히
 * 발생 위치 수만큼 add_edge가 나오므로 그래프 정확도·감사 가능성은 그대로고, LLM 판정
 * 횟수만 준다. 문맥에 따라 판정이 갈릴 수 있는 패턴(같은 표현식이 클래스마다 다른 타입으로
 * 선언된 경우 등)은 analyzer가 대표 사례 외 표본을 더 확인하거나 개별 판정으로 되돌릴 수
 * 있게 analyzer.md Step 8에 예외 절차를 둔다 — 이 함수는 그룹 후보만 만들고 강제하지 않는다.
 */
function unresolvedGroupKeyField(item) {
  return item.expression ?? item.target_name ?? item.handler_name ?? "";
}
function unresolvedFromId(item) {
  if (item.kind === "unresolved_trigger") return `trigger:${item.trigger}`;
  return item.from ?? item.caller ?? null;
}
function unresolvedGroupKey(item) {
  return JSON.stringify([item.kind, unresolvedGroupKeyField(item), item.candidates || []]);
}
function groupUnresolvedDecidable(decidableItems) {
  const groups = new Map();
  for (const item of decidableItems) {
    const key = unresolvedGroupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = { kind: item.kind, key_field: unresolvedGroupKeyField(item), candidates: item.candidates || [], occurrences: [] };
      groups.set(key, group);
    }
    group.occurrences.push({ from: unresolvedFromId(item), file: item.file, line: item.line, workspace: item.workspace });
  }
  return [...groups.values()]
    .sort((a, b) => (a.candidates.length - b.candidates.length) || (b.occurrences.length - a.occurrences.length))
    .map((group) => ({ group_id: `g-${createHash("sha256").update(JSON.stringify([group.kind, group.key_field, group.candidates])).digest("hex").slice(0, 24)}`, ...group, occurrence_count: group.occurrences.length }));
}

/*
 * 테스트·배포 모델 인벤토리 — analyzer가 "테스트 프레임워크가 무엇이고, 어디에 테스트가 있고,
 * 어떻게 빌드·배포되는가"를 소스 재순회 없이 알 수 있게 파일명·매니페스트만 보고 만든다.
 * test-generator는 기존 테스트 관행을 따라야 하고 plan-migration은 배포 모델(컨테이너·CI·앱서버)을
 * 회귀 기준선으로 삼아야 하는데, 지금까지 그 인벤토리를 만드는 단계가 없었다.
 * 내용 판단은 하지 않는다 — 매니페스트에서 의존성 이름을 정규식으로 찾고 배포 파일은 이름으로만 잡는다.
 */
const TEST_FRAMEWORK_SIGNATURES = [
  ["JUnit", /\bjunit\b/i], ["TestNG", /\btestng\b/i], ["Mockito", /\bmockito\b/i], ["Spock", /spock-core/i],
  ["pytest", /\bpytest\b/i], ["Jest", /"jest"|\bjest\b/i], ["Mocha", /"mocha"/i], ["Vitest", /\bvitest\b/i],
  ["Jasmine", /\bjasmine\b/i], ["Karma", /"karma"/i], ["Cypress", /\bcypress\b/i], ["Playwright", /@playwright\/test|\bplaywright\b/i],
  ["xUnit", /\bxunit\b/i], ["NUnit", /\bnunit\b/i], ["MSTest", /MSTest|Microsoft\.NET\.Test\.Sdk/i], ["RSpec", /\brspec\b/i],
];
const COVERAGE_TOOL_SIGNATURES = [
  ["JaCoCo", /\bjacoco\b/i], ["Istanbul/nyc", /"nyc"|\bistanbul\b|@vitest\/coverage|coverage-v8|coverage-istanbul/i],
  ["coverage.py", /\bpytest-cov\b/i], ["coverlet", /\bcoverlet\b/i], ["SimpleCov", /\bsimplecov\b/i],
];
const TEST_MANIFEST_FILE = /^(?:pom\.xml|build\.gradle(?:\.kts)?|package\.json|requirements(?:[-_.][\w.-]+)?\.txt|pyproject\.toml|setup\.(?:py|cfg)|tox\.ini|Gemfile|go\.mod|.*\.csproj|packages\.config|Directory\.Packages\.props)$/i;
const DEPLOY_SIGNATURES = [
  ["containers", /(?:^|\/)(?:Dockerfile(?:\.[\w.-]+)?|docker-compose(?:[.-][\w.-]+)?\.ya?ml|compose\.ya?ml|\.dockerignore)$/i],
  ["ci", /(?:^|\/)(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile(?:\.[\w.-]+)?|azure-pipelines(?:[.-][\w.-]+)?\.ya?ml|bitbucket-pipelines\.ya?ml|\.circleci\/config\.ya?ml|\.travis\.ya?ml|appveyor\.ya?ml|buildspec(?:[.-][\w.-]+)?\.ya?ml)$/i],
  ["iac", /(?:^|\/)(?:[^/]+\.tf|Chart\.ya?ml|kustomization\.ya?ml|serverless\.ya?ml|cloudformation[^/]*\.(?:ya?ml|json)|Vagrantfile|ansible\.cfg|playbook[^/]*\.ya?ml)$|(?:^|\/)(?:k8s|kubernetes|manifests|helm|charts|terraform)\/[^/]+\.(?:ya?ml|tf)$/i],
  ["app_servers", /(?:^|\/)(?:WEB-INF\/web\.xml|server\.xml|context\.xml|jboss-web\.xml|weblogic\.xml|standalone[^/]*\.xml|Web\.config|appsettings(?:\.[\w-]+)?\.json|Procfile|appspec\.ya?ml)$/i],
  ["build_scripts", /(?:^|\/)(?:build\.xml|Makefile|makefile|build\.(?:sh|bat|cmd|ps1)|deploy[^/]*\.(?:sh|bat|cmd|ps1)|release[^/]*\.(?:sh|bat|cmd|ps1)|gradlew|mvnw)$/i],
];
const INVENTORY_LIST_CAP = 20;
const INVENTORY_MANIFEST_MAX_BYTES = 512 * 1024;
const INVENTORY_FILE_LIMIT = 200000;

function detectTestDeployInventory(root, includePaths, excludedSources) {
  const frameworks = new Map();
  const coverageTools = new Map();
  const deploy = {};
  for (const [group] of DEPLOY_SIGNATURES) deploy[group] = [];
  const manifests = [];
  let fileCount = 0;
  function walk(dir, relDir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        /* .github 등 CI 디렉터리는 소스 인덱싱 제외 대상과 무관하게 배포 모델 근거이므로 걷는다. */
        if (EXCLUDED_DIRS.has(entry.name) && entry.name !== "build") continue;
        if (fileCount > INVENTORY_FILE_LIMIT) return;
        walk(join(dir, entry.name), rel);
        continue;
      }
      fileCount += 1;
      if (relDir && !isIncluded(rel, includePaths) && !/^\.(?:github|gitlab|circleci)\//.test(rel)) continue;
      for (const [group, regex] of DEPLOY_SIGNATURES) {
        if (regex.test(rel)) { deploy[group].push(rel); break; }
      }
      if (TEST_MANIFEST_FILE.test(entry.name)) manifests.push({ rel, full: join(dir, entry.name) });
    }
  }
  walk(root, "");
  for (const manifest of manifests.sort((a, b) => byCodeUnit(a.rel, b.rel))) {
    let text;
    try {
      if (statSync(manifest.full).size > INVENTORY_MANIFEST_MAX_BYTES) continue;
      text = readFileSync(manifest.full, "utf8");
    } catch { continue; }
    for (const [name, regex] of TEST_FRAMEWORK_SIGNATURES) {
      if (regex.test(text) && !frameworks.has(name)) frameworks.set(name, manifest.rel);
    }
    for (const [name, regex] of COVERAGE_TOOL_SIGNATURES) {
      if (regex.test(text) && !coverageTools.has(name)) coverageTools.set(name, manifest.rel);
    }
  }
  let testFileCount = 0;
  const testDirs = new Set();
  for (const item of excludedSources || []) {
    if (!/^test-/.test(item.reason)) continue;
    testFileCount += 1;
    const segments = item.file.split("/");
    const idx = segments.findIndex((segment) => /^(?:test|tests|__tests__|spec|specs)$/i.test(segment));
    if (idx >= 0) testDirs.add(segments.slice(0, idx + 1).join("/"));
    else if (segments.length > 1) testDirs.add(segments.slice(0, -1).join("/"));
  }
  const cap = (list) => ({ items: list.sort(byCodeUnit).slice(0, INVENTORY_LIST_CAP), truncated: Math.max(0, list.length - INVENTORY_LIST_CAP) });
  const deployOut = {};
  let deployTotal = 0;
  for (const [group, list] of Object.entries(deploy)) { deployOut[group] = cap(list); deployTotal += list.length; }
  return {
    test_frameworks: [...frameworks].map(([name, evidence_file]) => ({ name, evidence_file })),
    coverage_tools: [...coverageTools].map(([name, evidence_file]) => ({ name, evidence_file })),
    test_file_count: testFileCount,
    test_dirs: cap([...testDirs]),
    deploy: deployOut,
    deploy_file_count: deployTotal,
    manifests_scanned: manifests.length,
    note: "파일명·매니페스트 의존성 이름만 본 인벤토리다. 테스트 실행 여부·CI 통과 여부·배포 경로의 실제 동작은 판정하지 않는다.",
  };
}

function buildAnalysisInput(output, globalMeta, unresolved, decidableCount, decidableGroupCount, fileSizes = new Map(), testDeployInventory = null) {
  const count = (name, key) => Array.isArray(output[name]?.[key]) ? output[name][key].length : 0;
  const evidenceFiles = new Set();
  const collectFiles = (name, key) => {
    for (const item of output[name]?.[key] || []) if (item?.file) evidenceFiles.add(item.file);
  };
  for (const [name, key] of [
    ["symbols", "symbols"], ["call_graph", "edges"], ["sql_usage", "sqls"],
    ["transactions", "boundaries"], ["external_io", "communications"],
    ["env_branches", "branches"], ["api_contract", "endpoints"], ["api_contract", "consumers"],
    ["ui_flow", "events"], ["ui_flow", "transactions"],
  ]) collectFiles(name, key);
  const representativeLimit = REPRESENTATIVE_FILE_LIMITS[globalMeta.tier] || REPRESENTATIVE_FILE_LIMITS.Standard;
  const byteBudget = REPRESENTATIVE_BYTE_BUDGET[globalMeta.tier] || REPRESENTATIVE_BYTE_BUDGET.Standard;
  /* 개수·바이트 예산을 동시에 만족하는 만큼만 고른다. 순서는 인덱스 수집 순서를 유지해
   * 특정 레이어에 쏠리지 않게 하고, 개별 상한을 넘는 파일은 대표에서 제외한다. */
  const representative = [];
  let representativeBytes = 0;
  let oversizedSkipped = 0;
  let budgetSkipped = 0;
  for (const file of evidenceFiles) {
    const size = fileSizes.get(file) ?? 0;
    if (size > REPRESENTATIVE_PER_FILE_CAP) { oversizedSkipped += 1; continue; }
    if (representative.length >= representativeLimit || representativeBytes + size > byteBudget) { budgetSkipped += 1; continue; }
    representative.push(file);
    representativeBytes += size;
  }
  return {
    version: 1,
    generated_at: globalMeta.generated_at,
    source_root: globalMeta.source_root,
    tier: globalMeta.tier,
    complexity: globalMeta.complexity,
    adapter_coverage: globalMeta.adapter_coverage,
    coverage: {
      source_file_count: globalMeta.source_file_count,
      indexed_files: globalMeta.indexes,
      unresolved_count: unresolved.length,
      /* 판정 대상(후보 2개 이상)의 발생 위치 수 — 감사용 원본 카운트. 비용 추정은 아래
       * unresolved_decidable_group_count를 쓴다(같은 패턴이 반복 발생하는 경우가 많아
       * 이 값만으로 예산을 잡으면 과대추정된다). */
      unresolved_decidable_count: decidableCount,
      /* (kind+식별필드+candidates) 조합 기준 고유 패턴 수 — analyzer가 실제로 판정을
       * 내려야 하는 횟수다. ai-budget.mjs estimate()가 이 값을 기준으로 예산을 잡는다. */
      unresolved_decidable_group_count: decidableGroupCount,
      evidence_file_count: evidenceFiles.size,
    },
    counts: {
      symbols: count("symbols", "symbols"),
      graph_nodes: count("call_graph", "nodes"),
      graph_edges: count("call_graph", "edges"),
      sqls: count("sql_usage", "sqls"),
      sql_usages: count("sql_usage", "usages"),
      db_relations: count("schema", "relations"),
      transactions: count("transactions", "boundaries"),
      external_io: count("external_io", "communications"),
      environment_branches: count("env_branches", "branches"),
      endpoints: count("api_contract", "endpoints"),
      consumers: count("api_contract", "consumers"),
      api_matches: count("api_contract", "matches"),
      ui_screens: count("ui_flow", "screens"),
      ui_events: count("ui_flow", "events"),
      ui_transactions: count("ui_flow", "transactions"),
      dead_code_candidates: count("dead_code", "unused_methods"),
    },
    workspaces: globalMeta.workspaces,
    digest: buildDigest(output, globalMeta),
    evidence: {
      representative_files: representative,
      representative_files_truncated: Math.max(0, evidenceFiles.size - representative.length),
      /* 이 목록을 전부 읽었을 때의 실제 비용. 계획 없이 열다가 컨텍스트를 태우지 않도록 미리 알려준다. */
      representative_files_bytes: representativeBytes,
      representative_files_skipped: { oversized: oversizedSkipped, over_budget: budgetSkipped, per_file_cap_bytes: REPRESENTATIVE_PER_FILE_CAP },
      indexes: globalMeta.indexes.map((name) => `_workspace/index/${name}.json`),
      unresolved: "_workspace/index/_unresolved.jsonl",
      /* 판정 대상을 고유 패턴 단위로 묶은 파일 — analyzer는 원칙적으로 _unresolved.jsonl을
       * 줄 단위로 순회하지 않고 이 파일의 groups[]를 기준으로 판정한다 (analyzer_contract 참고). */
      unresolved_groups: "_workspace/index/_unresolved_groups.json",
      /* 대형 인덱스를 Read로 여는 대신 필요한 줄만 얻는 질의 도구. 플러그인 루트 기준 경로다.
       * 예전에는 존재하지 않는 `scripts/query-index.mjs`를 가리키고 있어 에이전트가 원본 JSON(최대 143MB)을
       * 직접 열 수밖에 없었다. */
      query_tool: "agents/lib/query-index.mjs",
      query_tool_hint: "node $CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs summary --root <프로젝트>",
      /* 테스트 프레임워크·테스트 위치·배포 모델(컨테이너·CI·IaC·앱서버·빌드 스크립트). 파일명·매니페스트만 본다. */
      test_deploy_inventory: testDeployInventory,
    },
    analyzer_contract: {
      full_source_rescan: false,
      /*
       * 대표 파일을 전부 열지 말고 이 예산 안에서 digest가 지목한 것만 골라 읽는다.
       * 예전에는 상한이 개수뿐이라 목록을 그대로 열면 20M 토큰이 넘는 경우가 있었다.
       */
      representative_read_budget_bytes: byteBudget,
      /*
       * 미해결 관계를 "전부 처리"하는 계약은 규모가 커지면 성립하지 않는다.
       * 실측(레거시 Java 4,883파일)에서 185,912건이 나왔고, 배치 200건 기준 930회로
       * analyzer가 완주할 수 없다. 이 경우 계약을 우선순위 부분 처리로 바꾸고
       * 무엇을 우선하는지 명시한다 — 조용히 잘라내는 대신 계약에 드러낸다.
       */
      /*
       * 판정 대상은 "후보 2개 이상"인 레코드뿐이다. 후보 0~1개(`no_candidates: true`)는
       * 고를 것이 없어 소스를 열어도 판정할 수 없으므로 계약에서 명시적으로 제외한다 —
       * 예전에는 이것들이 우선순위 맨 앞에 와서 판정 예산을 전부 소진했다.
       */
      skip_no_candidate_records: true,
      /*
       * 2026-09-01 그룹핑 도입: "전부 처리" 여부는 발생 위치 수(decidableCount)가 아니라
       * 고유 패턴 수(decidableGroupCount)로 판단한다. 같은 패턴이 수백 곳에서 반복되는
       * 레거시 코드베이스에서 발생 위치 기준으로 판단하면 실제로는 처리 가능한 규모인데도
       * "부분 처리"로 잘못 떨어진다.
       */
      process_all_unresolved: decidableGroupCount <= UNRESOLVED_FULL_PROCESSING_LIMIT,
      unresolved_priority: decidableGroupCount > UNRESOLVED_FULL_PROCESSING_LIMIT
        ? { limit: UNRESOLVED_FULL_PROCESSING_LIMIT, order: "candidates_asc", note: "후보 수가 적은 그룹부터 — 판정 가능성이 높은 순서" }
        : null,
      /* 그룹 단위 배치 크기 — 발생 위치 단위가 아니다. 그룹당 대표 사례 1곳만 읽으므로
       * 같은 200이라는 숫자가 예전보다 훨씬 넓은 실제 커버리지를 갖는다. */
      unresolved_batch_size: 200,
      /*
       * 판정 대상은 _unresolved_groups.json의 groups[]다 — _unresolved.jsonl을 줄 단위로
       * 순회하지 않는다. 그룹마다 대표 발생 위치(occurrences[0]) 하나만 읽어 판정하고,
       * resolve_group 한 건을 제출하면 인덱서가 occurrences[] 전체의 엣지를
       * 확장한다(나머지 위치는 다시 열거나 출력하지 않는다). 같은 표현식이라도 클래스/모듈에 따라 다르게
       * 해석될 수 있다고 판단되면(예: 변수 선언 타입이 호출부마다 다름) 그 그룹은
       * 대표 사례 외 2~3곳을 더 확인하거나, 정말 문맥 의존적이면 occurrences를 나눠
       * 개별 판정으로 되돌린다 — 이 계약은 병합을 "강제"하지 않고 기본 전략만 제시한다.
       */
      dedup_by_pattern: true,
      require_file_line_evidence: true,
      require_module_coverage: true,
      /* digest가 지목한 좌표는 선택 열람이 허용된다. 무제한 재순회와 구분하기 위해 계약에 명시한다. */
      digest_guided_selective_read: true,
    },
  };
}

/* AI 보강 엣지가 in-degree를 채웠다면 그 심볼은 더 이상 데드 코드 후보가 아니다. */
function reconcileDeadCode(output) {
  if (!output.dead_code) return;
  const { inDegree } = degreeMaps(output.call_graph?.nodes || [], output.call_graph?.edges || []);
  const remaining = output.dead_code.unused_methods.filter((item) => (inDegree.get(item.id) || 0) === 0);
  if (!remaining.length) { delete output.dead_code; return; }
  output.dead_code.unused_methods = remaining;
}

/* ── 파일 분석 병렬화를 시도했다가 되돌린 기록 ──────────────────────────────
 *
 * analyzeFile()은 순수 함수이고 파일 간 의존이 없어서 worker_threads로 샤딩하면
 * 코어 수만큼 빨라질 것처럼 보인다. 실제로 구현해 실측했더니 **오히려 느려졌다**.
 *
 *   구조화 복제로 facts 객체 그래프 전달: 19.2초 → 18.4초 (2코어, 4% — 전달 비용이 이득을 상쇄)
 *   JSON 버퍼를 transferList로 무복사 전달:  29.4초 → 35.2초 (stringify/parse가 더 비쌌다)
 *   깨끗한 픽스처(2000파일/13MB)에서도:      2.96초 → 3.49초
 *
 * 원인은 이 인덱서가 CPU 바운드가 아니라 **중간 데이터 양**에 눌려 있다는 것이다.
 * 소스 96MB 트리가 facts 459MB, 최종 인덱스 250MB를 만든다 — 워커 경계를 넘기는 비용이
 * 추출 비용과 같은 자릿수라 병렬화로 회수할 여지가 없다.
 * 그래서 병렬화 코드를 넣지 않는다. 여기를 더 빠르게 하려면 스레드가 아니라
 * 산출물 양을 줄여야 한다(예: sql_usage의 text_preview처럼 항목마다 붙는 큰 필드).
 * 같은 이유로 파일별 facts 캐시도 두지 않는다(2026-08-14 폐지 결정 유지) —
 * 캐시 직렬화·파싱이 재추출보다 비쌌다(cold 32초 → 46초).
 */

function validateOutput(name, value) {
  const required = {
    symbols: ["_meta", "symbols"], call_graph: ["_meta", "nodes", "edges"], sql_usage: ["_meta", "sqls", "usages"],
    transactions: ["_meta", "boundaries"], external_io: ["_meta", "communications"], env_branches: ["_meta", "branches"],
    schema: ["_meta", "tables"], api_contract: ["_meta", "endpoints", "consumers", "matches", "unmatched_endpoints", "unmatched_consumers"],
    dead_code: ["_meta", "unused_methods", "unused_sql_ids", "unused_jsps"],
    ui_flow: ["_meta", "screens", "events", "datasets", "transactions"],
    client_index: ["_meta", "type", "js_count", "domain_structure", "sample_mappings", "jquery_versions"],
    data_flow: ["_meta", "chains"],
  }[name] || [];
  const missing = required.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${name}.json 필수 필드 누락: ${missing.join(", ")}`);
}

export function buildIndex(options) {
  const root = resolve(options.root);
  /*
   * 갱신(incremental)은 사용자가 고른 Tier 를 바꾸지 않는다. 실측: "인덱스갱신해줘" 뒤에 Standard 로 만든
   * 하네스의 인덱스가 Auto 재산정으로 Full 이 됐다. 지정이 없으면 기존 _meta 의 Tier 를 쓴다.
   */
  const unspecified = !options.tier || options.tier === "Auto"; // 명령행 기본값이 "Auto" 다
  const keptTier = unspecified && options.mode === "incremental"
    ? readJson(join(resolveIndexDir(root, options.indexDir), "_meta.json"), {})?.tier
    : null;
  const normalized = { ...options, root, requestedTier: (unspecified ? keptTier : options.tier) || "Auto" };
  const existingPatchPath = join(resolveIndexDir(root, options.indexDir), "_ai_patch.json");
  const preservePatch = options.mode === "incremental" && existsSync(existingPatchPath);
  const config = loadConfig(root, options.config);
  const { files, excluded: excludedSources } = listFiles(root, config.include_paths, config);
  const unsupportedFiles = discoverUnsupportedFiles(root, config.include_paths);
  /*
   * 파일별 해시 캐시(_workspace/.index-cache/)는 두지 않는다(2026-08-14 폐지, 2026-08-16 재검토로 유지 확정).
   * "인덱스만 갱신해줘"도 매번 전체 재분석한다. 되살려 실측해 보면 오히려 느려지는데,
   * 추출 결과(facts)가 원본 소스보다 훨씬 커서 캐시 직렬화·파싱이 재추출보다 비싸기 때문이다
   * (소스 96MB 트리 → facts 459MB, cold 32초 → 46초). 근거는 위 "파일 분석 병렬화를 시도했다가
   * 되돌린 기록" 주석에 함께 정리돼 있다. mode(init/incremental)는 preservePatch(위) 판단에만 쓴다.
   */
  const facts = files.map((file) => analyzeFile(file, root, config));
  const analyzed = files.length;
  const reused = 0;
  const generatedAt = kstIso();
  const latestMtime = files.length ? kstIso(new Date(Math.max(...files.map((item) => item.stats.mtimeMs)))) : generatedAt;
  const complexity = calculateComplexity(facts, config, files.length);
  const coverage = buildAdapterCoverage(facts, unsupportedFiles);
  normalized.tier = normalized.requestedTier === "Auto" ? complexity.recommended_tier : normalized.requestedTier;
  const { output, globalMeta, unresolved } = aggregate(facts, normalized, config, generatedAt, files.length, latestMtime, complexity, coverage, excludedSources, files);
  const indexDir = resolveIndexDir(root, options.indexDir);
  mkdirSync(indexDir, { recursive: true });
  const stalePatch = join(indexDir, "_ai_patch.json");
  /*
   * 보존된 AI patch는 파일을 쓰기 전에 메모리 그래프에 병합한다.
   * 나중에 call_graph.json만 수정하면 digest·dead_code가 보강 이전 상태로 남아 서로 어긋난다.
   */
  if (preservePatch) {
    try {
      const groups = groupUnresolvedDecidable(unresolved.filter((item) => (item.candidates || []).length >= 2));
      const merged = mergeAiPatchOutput(output, readJson(stalePatch), groups, generatedAt);
      globalMeta.indexes = Object.keys(output);
      globalMeta.ai_enrichment = { applied_at: generatedAt, ...merged, patch: slash(relative(root, stalePatch)) };
      if (!merged.applied && merged.rejected) {
        process.stderr.write(`경고: 보존된 AI patch가 전부 거부되었습니다 (${JSON.stringify(merged.rejected_reasons)})\n`);
      }
    } catch (error) {
      process.stderr.write(`경고: 보존된 AI patch를 병합할 수 없어 무시합니다: ${error.message}\n`);
      globalMeta.ai_enrichment = { applied_at: generatedAt, applied: 0, rejected: 0, error: error.message, patch: slash(relative(root, stalePatch)) };
    }
  }
  const managed = new Set(["symbols", "call_graph", "sql_usage", "transactions", "external_io", "env_branches", "schema", "api_contract", "dead_code", "ui_flow", "client_index", "data_flow", "glossary"]);
  for (const name of managed) {
    const path = join(indexDir, `${name}.json`);
    /*
     * 이번 회차에 만들지 못한 인덱스라도, 그 파일을 analyzer(LLM)가 썼다면 지우지 않는다.
     * 프레임워크를 인식하지 못한 프로젝트의 api_contract.json이나 라이브 DB에서 뜬 schema.json이
     * 재인덱싱 한 번에 조용히 사라지기 때문이다. 인덱서가 쓴 것만 인덱서가 회수한다.
     */
    if (!output[name]) {
      if (existsSync(path) && readJson(path, {})?._meta?.generator === "deterministic-indexer") rmSync(path);
      continue;
    }
    validateOutput(name, output[name]);
    atomicJson(path, output[name]);
  }
  /*
   * 미해결 항목은 한 건도 빠뜨리지 않고 기록한다(어디가 모호했는지는 전수가 감사 기록이다).
   * 다만 후보 목록까지 전부 적으면 레거시 규모에서 파일이 139MB까지 커지는데, 그 대부분은
   * analyzer_contract가 "처리 대상 아님"이라고 명시한 구간이다. 판정 대상(후보가 적은 순
   * 상위 N건)만 후보를 싣고, 나머지는 위치와 후보 수만 남긴다.
   */
  /*
   * 우선순위 정렬 기준을 "후보 수 오름차순"에서 **판정 가능성**으로 바꾼다(2026-08-16).
   *
   * 기존 정렬은 후보가 적은 순이라 **후보가 0개인 레코드가 항상 맨 앞**에 왔다.
   * 그런데 후보 0개는 모호한 게 아니라 "핸들러가 인덱스에 아예 없다"는 뜻이라 후보 중에서
   * 고를 것이 없다 — analyzer가 소스를 열어봐야 판정할 수 없는 종류다.
   * 반대로 진짜 판정 대상(후보 2개 이상)은 뒤로 밀려 `candidates_omitted`로 잘려나갔다.
   * 즉 LLM 판정 예산 2000건이 통째로 판정 불가능한 항목에 쓰이고, 판정 가능한 항목은
   * 처리되지 않는 상태였다. 실측 픽스처에서 처리 대상 2000건이 전부 후보 0개였다.
   *
   * 그래서 후보가 2개 이상인 것을 먼저(좁은 것부터) 놓고, 후보 0개는 뒤로 보낸다.
   * 후보 0개 레코드는 감사 기록으로는 남기되 `no_candidates: true`로 표시해
   * analyzer 계약이 판정 대상에서 제외할 수 있게 한다.
   */
  const prioritized = [...unresolved]
    .map((item, order) => ({ item, order, width: (item.candidates || []).length }))
    .sort((a, b) => {
      const decidable = (width) => (width >= 2 ? 0 : 1);
      return decidable(a.width) - decidable(b.width) || a.width - b.width || a.order - b.order;
    });
  const decidableCount = prioritized.filter(({ width }) => width >= 2).length;
  /*
   * 판정 대상(후보 2개 이상)을 (kind+식별필드+candidates) 패턴으로 묶는다 — groupUnresolvedDecidable
   * 주석 참조. 그룹 수(decidableGroupCount)가 analyzer의 실제 판정 횟수이자 비용 추정 기준이다.
   */
  const decidableItems = prioritized.filter(({ width }) => width >= 2).map(({ item }) => item);
  const groups = groupUnresolvedDecidable(decidableItems);
  const decidableGroupCount = groups.length;
  const groupIdByKey = new Map(groups.map((group) => [JSON.stringify([group.kind, group.key_field, group.candidates]), group.group_id]));
  const cappedGroups = groups.map((group, index) => {
    if (index < UNRESOLVED_FULL_PROCESSING_LIMIT) return group;
    /* 그룹 자체가 상한을 넘는 극단적인 경우에만 occurrences를 생략한다(실측상 거의 발생하지 않음 —
     * 189/483개 수준이던 실제 프로젝트 대비 이 상한은 훨씬 넉넉하다). */
    const { occurrences: _drop, ...rest } = group;
    return { ...rest, occurrences_omitted: true };
  });
  const cappedUnresolved = prioritized.map(({ item, width }, rank) => {
    const candidates = item.candidates || [];
    if (width < 2) {
      /* 후보 0~1개: 고를 것이 없다. 위치만 남기고 판정 대상에서 뺀다. */
      const { candidates: _drop, ...rest } = item;
      return { ...rest, candidate_count: candidates.length, no_candidates: true };
    }
    const group_id = groupIdByKey.get(unresolvedGroupKey(item));
    if (rank >= UNRESOLVED_FULL_PROCESSING_LIMIT) {
      const { candidates: _drop, ...rest } = item;
      return { ...rest, candidate_count: candidates.length, candidates_omitted: true, group_id };
    }
    if (candidates.length <= MAX_UNRESOLVED_CANDIDATES) return { ...item, group_id };
    return { ...item, candidates: candidates.slice(0, MAX_UNRESOLVED_CANDIDATES), candidates_truncated: candidates.length - MAX_UNRESOLVED_CANDIDATES, group_id };
  });
  atomicJson(join(indexDir, "_meta.json"), globalMeta);
  atomicJson(join(indexDir, "_analysis_input.json"), buildAnalysisInput(output, globalMeta, unresolved, decidableCount, decidableGroupCount, new Map(files.map((item) => [item.rel, item.stats.size])), detectTestDeployInventory(root, config.include_paths, excludedSources)));
  writeFileSync(join(indexDir, "_unresolved.jsonl"), cappedUnresolved.map((item) => JSON.stringify(item)).join("\n") + (unresolved.length ? "\n" : ""), "utf8");
  atomicJson(join(indexDir, "_unresolved_groups.json"), {
    _meta: { generated_at: generatedAt, generator: "deterministic-indexer", group_count: groups.length, decidable_raw_count: decidableCount, total_occurrences: decidableItems.length },
    groups: cappedGroups,
  });
  if (!preservePatch && existsSync(stalePatch)) rmSync(stalePatch);
  return { root, files: files.length, analyzed, reused, tier: normalized.tier, complexity, adapter_coverage: coverage, indexes: Object.keys(output), unresolved: unresolved.length };
}

/*
 * AI edge patch operation 정규화.
 * `agents/analyzer.md`는 평면 형태(`{op, from, to, type, ...}`)를 지시하고
 * 초기 구현은 중첩 형태(`{op, edge: {...}}`)만 받아서 모든 operation이 조용히 거부됐다.
 * 두 형태를 모두 수용하되, 어떤 이유로 거부됐는지는 반드시 드러낸다.
 */
function normalizeAiPatchOperation(operation) {
  if (!operation || typeof operation !== "object") return { reason: "not_an_object" };
  if (operation.op !== "add_edge") return { reason: "unsupported_op" };
  const source = operation.edge && typeof operation.edge === "object" ? operation.edge : operation;
  if (!source.from || !source.to || !source.type) return { reason: "missing_edge_fields" };
  return {
    edge: {
      from: source.from, to: source.to, type: source.type,
      file: source.file, line: source.line, workspace: source.workspace,
      confidence: source.confidence,
      /* 평면 형태의 `reason`은 중첩 형태의 `evidence`와 같은 역할이므로 근거로 보존한다. */
      evidence: source.evidence || source.reason,
    },
  };
}

export function mergeAiPatchEdges(graph, patch) {
  if (!patch || patch.version !== 1 || !Array.isArray(patch.operations)) throw new Error("AI patch는 version: 1과 operations[]가 필요합니다.");
  if (!graph?.nodes || !Array.isArray(graph.edges)) throw new Error("call_graph.json이 없어 AI patch를 적용할 수 없습니다.");
  const nodeIds = new Set(graph.nodes.map((item) => item.id));
  const edgeKeys = new Set(graph.edges.map((item) => `${item.from}:${item.to}:${item.type}`));
  const reasons = new Map();
  const samples = [];
  let applied = 0;
  let rejected = 0;
  let duplicates = 0;
  const reject = (reason, detail) => {
    rejected += 1;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (samples.length < 20) samples.push({ reason, ...detail });
  };
  for (const operation of patch.operations) {
    const normalized = normalizeAiPatchOperation(operation);
    if (!normalized.edge) { reject(normalized.reason, { op: operation?.op ?? null }); continue; }
    const edge = normalized.edge;
    if (!nodeIds.has(edge.from)) { reject("unknown_from_node", { from: edge.from, to: edge.to }); continue; }
    if (!nodeIds.has(edge.to)) { reject("unknown_to_node", { from: edge.from, to: edge.to }); continue; }
    if (!AI_PATCH_EDGE_TYPES.has(edge.type)) { reject("invalid_edge_type", { from: edge.from, to: edge.to, type: edge.type }); continue; }
    const key = `${edge.from}:${edge.to}:${edge.type}`;
    if (edgeKeys.has(key)) { duplicates += 1; continue; }
    graph.edges.push({
      from: edge.from, to: edge.to, type: edge.type,
      ...(edge.file ? { file: edge.file } : {}),
      ...(Number.isInteger(edge.line) ? { line: edge.line } : {}),
      ...(edge.workspace ? { workspace: edge.workspace } : {}),
      origin: "ai-enrichment", confidence: edge.confidence || "MEDIUM",
      ...(edge.evidence ? { evidence: edge.evidence } : {}),
    });
    edgeKeys.add(key); applied += 1;
  }
  return { applied, rejected, duplicates, rejected_reasons: Object.fromEntries(reasons), rejected_samples: samples };
}

/*
 * api_contract.json(endpoints/consumers)·external_io.json(communications)에 analyzer가
 * "이게 무엇을 하는지" 1줄 설명을 얹는 오퍼레이션. call_graph의 add_edge와 같은 이유로
 * 원본 파일을 analyzer가 직접 재작성하지 않는다 — incremental 재인덱싱이 두 파일을 캐시에서
 * 다시 만들기 때문에 직접 덧붙인 내용은 다음 갱신에서 조용히 사라진다.
 */
function mergeDescriptionPatch(items, ops, field = "description") {
  const byId = new Map((items || []).map((item) => [item.id, item]));
  const reasons = new Map();
  const samples = [];
  let applied = 0;
  let rejected = 0;
  const reject = (reason, detail) => {
    rejected += 1;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (samples.length < 20) samples.push({ reason, ...detail });
  };
  for (const op of ops.flatMap((op) => Array.isArray(op?.ids) ? op.ids.map((id) => ({ ...op, id })) : [op])) {
    const id = op && typeof op === "object" ? op.id : undefined;
    const text = op && typeof op === "object" ? op[field] : undefined;
    if (!id) { reject("missing_id", { op: op?.op ?? null }); continue; }
    if (typeof text !== "string" || !text.trim()) { reject(`missing_${field}`, { id }); continue; }
    const item = byId.get(id);
    if (!item) { reject("unknown_id", { id }); continue; }
    item[field] = text.trim();
    applied += 1;
  }
  return { applied, rejected, rejected_reasons: Object.fromEntries(reasons), rejected_samples: samples };
}

/*
 * call_graph.json 엣지는 (from, to, type) 조합이 자연 키다(mergeAiPatchEdges의 edgeKeys와 동일
 * 구성) — 노드처럼 단일 id가 없어 별도 매칭 함수가 필요하다. "이 호출이 왜 존재하는지"를
 * analyzer가 이 오퍼레이션으로만 얹는다(엣지 자체는 add_edge로만 새로 만들 수 있음, 여기선
 * 이미 있는 엣지에 note만 붙인다).
 */
function mergeEdgeNotes(edges, ops) {
  const byKey = new Map((edges || []).map((item) => [`${item.from}:${item.to}:${item.type}`, item]));
  const reasons = new Map();
  const samples = [];
  let applied = 0;
  let rejected = 0;
  const reject = (reason, detail) => {
    rejected += 1;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (samples.length < 20) samples.push({ reason, ...detail });
  };
  for (const op of ops) {
    const from = op && typeof op === "object" ? op.from : undefined;
    const to = op && typeof op === "object" ? op.to : undefined;
    const type = op && typeof op === "object" ? op.type : undefined;
    const note = op && typeof op === "object" ? op.note : undefined;
    if (!from || !to || !type) { reject("missing_edge_fields", { from, to, type }); continue; }
    if (typeof note !== "string" || !note.trim()) { reject("missing_note", { from, to, type }); continue; }
    const item = byKey.get(`${from}:${to}:${type}`);
    if (!item) { reject("unknown_edge", { from, to, type }); continue; }
    item.note = note.trim();
    applied += 1;
  }
  return { applied, rejected, rejected_reasons: Object.fromEntries(reasons), rejected_samples: samples };
}

/*
 * client_index.json은 목록이 아니라 문서 자체에 판단 필드(ajax_contract/naming_convention/anti_patterns)를
 * 얹는다 — id로 찾는 목록 항목이 아니라 문서 최상위 필드라 mergeDescriptionPatch를 그대로 못 쓴다.
 * 구조 필드(type/js_count/domain_structure/sample_mappings/jquery_versions)는 인덱서 소유라 이 오퍼레이션으로
 * 건드릴 수 없다 — 세 서술 필드만 받는다.
 */
function mergeClientIndexNarrative(clientIndex, ops) {
  const reasons = new Map();
  const samples = [];
  let applied = 0;
  let rejected = 0;
  const reject = (reason, detail) => {
    rejected += 1;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (samples.length < 20) samples.push({ reason, ...detail });
  };
  for (const op of ops) {
    const ajaxContract = op && typeof op === "object" ? op.ajax_contract : undefined;
    const namingConvention = op && typeof op === "object" ? op.naming_convention : undefined;
    const antiPatterns = op && typeof op === "object" ? op.anti_patterns : undefined;
    const hasAjax = typeof ajaxContract === "string" && ajaxContract.trim();
    const hasNaming = namingConvention && typeof namingConvention === "object";
    const hasAnti = Array.isArray(antiPatterns);
    if (!hasAjax && !hasNaming && !hasAnti) { reject("empty_narrative", {}); continue; }
    if (hasAjax) clientIndex.ajax_contract = ajaxContract.trim();
    if (hasNaming) clientIndex.naming_convention = namingConvention;
    if (hasAnti) clientIndex.anti_patterns = antiPatterns;
    applied += 1;
  }
  return { applied, rejected, rejected_reasons: Object.fromEntries(reasons), rejected_samples: samples };
}

function mergeCombinedResults(parts) {
  const rejected_reasons = {};
  const rejected_samples = [];
  let applied = 0;
  let rejected = 0;
  let duplicates = 0;
  for (const part of parts) {
    applied += part.applied || 0;
    rejected += part.rejected || 0;
    duplicates += part.duplicates || 0;
    for (const [reason, count] of Object.entries(part.rejected_reasons || {})) {
      rejected_reasons[reason] = (rejected_reasons[reason] || 0) + count;
    }
    rejected_samples.push(...(part.rejected_samples || []));
  }
  return { applied, rejected, duplicates, rejected_reasons, rejected_samples: rejected_samples.slice(0, 20) };
}

/* 그룹 판정만 AI가 작성하고, 근거 좌표 복제와 파생 인덱스 갱신은 기계가 처리한다. */
function mergeAiPatchOutput(output, patch, groups, appliedAt, changed = new Set()) {
  if (!patch || patch.version !== 1 || !Array.isArray(patch.operations)) throw new Error("AI patch는 version: 1과 operations[]가 필요합니다.");
  const parts = [];
  const reject = (reason, op) => parts.push({ rejected: 1, rejected_reasons: { [reason]: 1 }, rejected_samples: [{ reason, op: op?.op, group_id: op?.group_id }] });
  const byGroup = new Map(groups.map((g) => [g.group_id, g]));
  const operations = [];
  for (const op of patch.operations) {
    if (op?.op !== "resolve_group") { operations.push(op); continue; }
    const group = byGroup.get(op.group_id);
    if (!group || !group.occurrences?.length || group.occurrences_omitted) { reject("unknown_or_incomplete_group", op); continue; }
    if (!group.candidates.includes(op.to)) { reject("not_a_group_candidate", op); continue; }
    if (!AI_PATCH_EDGE_TYPES.has(op.type)) { reject("invalid_edge_type", op); continue; }
    if (typeof op.evidence !== "string" || !op.evidence.trim()) { reject("missing_evidence", op); continue; }
    if (group.occurrences.some((o) => !o.from || !o.file || !Number.isInteger(o.line))) { reject("missing_group_evidence", op); continue; }
    for (const occurrence of group.occurrences) operations.push({
      op: "add_edge", ...occurrence, to: op.to, type: op.type, evidence: op.evidence, confidence: op.confidence,
    });
  }
  const known = ["add_edge", "set_node_note", "set_edge_note", "set_endpoint_description", "set_communication_description", "set_client_index_narrative", "set_flow_note"];
  const buckets = Object.fromEntries(known.map((name) => [name, []]));
  for (const op of operations) {
    if (known.includes(op?.op)) buckets[op.op].push(op);
    else reject("unsupported_op", op);
  }
  const graph = output.call_graph;
  if (buckets.add_edge.length) {
    const edges = mergeAiPatchEdges(graph, { version: 1, operations: buckets.add_edge });
    parts.push(edges);
    if (edges.applied) {
      changed.add("call_graph");
      if (output.api_contract) {
        const previous = new Map((output.data_flow?.chains || []).map((c) => [c.id, c.note]));
        const derived = deriveDataFlow(output.api_contract.endpoints || [], graph.edges,
          output.sql_usage?.sqls || [], output.sql_usage?.usages || [], graph.nodes, new Map());
        if (derived) {
          for (const chain of derived.chains) if (previous.has(chain.id)) chain.note = previous.get(chain.id);
          output.data_flow = { _meta: { ...graph._meta, generated_at: appliedAt }, ...derived };
          changed.add("data_flow");
        }
      }
      if (output.dead_code) { reconcileDeadCode(output); changed.add("dead_code"); }
    }
  }
  const targets = [
    ["set_node_note", "call_graph", () => graph?.nodes, "note"],
    ["set_endpoint_description", "api_contract", () => [...(output.api_contract?.endpoints || []), ...(output.api_contract?.consumers || [])], "description"],
    ["set_communication_description", "external_io", () => output.external_io?.communications, "description"],
    ["set_flow_note", "data_flow", () => output.data_flow?.chains, "note"],
  ];
  for (const [kind, name, items, field] of targets) {
    const ops = buckets[kind];
    if (!ops.length) continue;
    if (!output[name]) { for (const op of ops) reject(`no_${name}`, op); continue; }
    const result = mergeDescriptionPatch(items(), ops, field);
    parts.push(result);
    if (result.applied) changed.add(name);
  }
  if (buckets.set_edge_note.length) {
    const result = mergeEdgeNotes(graph?.edges, buckets.set_edge_note);
    parts.push(result);
    if (result.applied) changed.add("call_graph");
  }
  if (buckets.set_client_index_narrative.length) {
    if (!output.client_index) {
      for (const op of buckets.set_client_index_narrative) reject("no_client_index", op);
    } else {
      const result = mergeClientIndexNarrative(output.client_index, buckets.set_client_index_narrative);
      parts.push(result);
      if (result.applied) changed.add("client_index");
    }
  }
  const result = mergeCombinedResults(parts);
  if (changed.has("call_graph")) {
    graph._meta.edge_count = graph.edges.length;
    graph._meta.ai_enriched_at = appliedAt;
  }
  return result;
}

export function applyAiPatch(rootArg, patchArg, indexDirArg) {
  const root = resolve(rootArg);
  const patchPath = isAbsolute(patchArg) ? patchArg : join(root, patchArg);
  const indexDir = resolveIndexDir(root, indexDirArg);
  const patch = readJson(patchPath);
  const names = ["call_graph", "api_contract", "sql_usage", "external_io", "client_index", "data_flow", "dead_code"];
  const output = {};
  for (const name of names) {
    const value = readJson(join(indexDir, `${name}.json`));
    if (value) output[name] = value;
  }
  const groups = readJson(join(indexDir, "_unresolved_groups.json"), {})?.groups || [];
  const changed = new Set();
  const appliedAt = kstIso();
  const result = mergeAiPatchOutput(output, patch, groups, appliedAt, changed);
  for (const name of changed) {
    const path = join(indexDir, `${name}.json`);
    if (output[name]) atomicJson(path, output[name]);
    else if (existsSync(path)) rmSync(path);
  }
  const analysisInputPath = join(indexDir, "_analysis_input.json");
  const analysisInput = readJson(analysisInputPath);
  if (changed.has("call_graph") && analysisInput?.digest) {
    Object.assign(analysisInput.digest, graphDigest(output.call_graph.nodes, output.call_graph.edges));
    if (analysisInput.counts) analysisInput.counts.graph_edges = output.call_graph.edges.length;
    atomicJson(analysisInputPath, analysisInput);
  }
  const metaPath = join(indexDir, "_meta.json");
  const meta = readJson(metaPath, {});
  const indexes = new Set(meta.indexes || []);
  for (const name of changed) {
    if (output[name]) indexes.add(name); else indexes.delete(name);
  }
  meta.indexes = [...indexes];
  meta.ai_enrichment = { applied_at: appliedAt, ...result, patch: slash(relative(root, patchPath)) };
  atomicJson(metaPath, meta);
  return output.call_graph ? { ...result, edges: output.call_graph.edges.length } : result;
}

function printHelp() {
  process.stdout.write(`AX-Harness deterministic indexer\n\n` +
    `node scripts/build-index.mjs --root <project> --check-stale   # 재인덱싱 필요 여부만 판정(exit 0=최신, 1=필요)\n` +
    `node scripts/build-index.mjs --root <project> [--mode init|incremental|feature-scoped] [--tier Standard|Full] [--config <json>]\n` +
    `node scripts/build-index.mjs --root <project> --apply-ai-patch _workspace/index/_ai_patch.json\n` +
    `\n  --index-dir <dir>   인덱스 출력/조회 위치 (기본 <root>/_workspace/index)\n`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { printHelp(); return 0; }
    if (options.checkStale) {
      /* 팀원이 공유 하네스를 받은 뒤 "인덱싱을 다시 해야 하나"를 LLM 없이 묻는 경로.
       * exit 0 = 그대로 써도 됨, exit 1 = 재인덱싱 필요. */
      const state = indexStaleness(options.root, options.indexDir);
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      return state.stale ? 1 : 0;
    }
    const result = options.applyAiPatch ? applyAiPatch(options.root, options.applyAiPatch, options.indexDir) : buildIndex(options);
    if (!options.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    /*
     * 조용한 실패 금지.
     * patch가 하나도 적용되지 않았는데 거부만 쌓였다면 AI 보강 경로가 끊긴 것이므로
     * 성공으로 보고하지 않고 거부 사유와 함께 non-zero로 끝낸다.
     */
    if (options.applyAiPatch && result.applied === 0 && result.rejected > 0) {
      process.stderr.write(`AI patch가 하나도 적용되지 않았습니다: ${JSON.stringify(result.rejected_reasons)}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`인덱스 생성 실패: ${error.stack || error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
