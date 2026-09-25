#!/usr/bin/env node
/*
 * 인덱스 질의 도구.
 *
 * 존재 이유는 토큰이다. `_analysis_input.json`은 예전부터 `query_tool: "scripts/query-index.mjs"`를
 * 안내하고 있었는데 **그 파일이 플러그인에 없었다.** 그래서 인덱스를 봐야 하는 에이전트(qa·
 * impact-analyzer·logic-tracer·feature-finder)는 원본 JSON을 직접 열 수밖에 없었다.
 * 실측한 대형 레거시 인덱스 크기는 이렇다:
 *
 *   sql_usage.json 143MB · dead_code.json 38MB · call_graph.json 36MB · symbols.json 26MB
 *
 * "호출자 5개만 알고 싶다"에 143MB를 여는 것은 성립하지 않는다. 이 스크립트는 그 질문에
 * 필요한 줄만 돌려준다 — 응답은 기본 상한이 걸려 있고, 잘렸으면 잘렸다고 명시한다.
 *
 * 설계 원칙
 * - 항상 JSON 한 덩어리로 답한다(에이전트가 파싱해 그대로 인용할 수 있게).
 * - 응답에 상한을 걸고 `truncated`로 잘린 수를 밝힌다. 조용히 자르지 않는다.
 * - 없는 인덱스를 물으면 빈 결과가 아니라 사유를 돌려준다 — "결과 0건"과 "인덱스 없음"은 다르다.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseArgs(argv) {
  const args = { command: argv[0] || "help", root: process.cwd(), limit: DEFAULT_LIMIT };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--id") args.id = argv[++i];
    else if (argv[i] === "--name") args.name = argv[++i];
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--table") args.table = argv[++i];
    else if (argv[i] === "--path") args.path = argv[++i];
    else if (argv[i] === "--depth") args.depth = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === "--limit") args.limit = Math.min(MAX_LIMIT, Math.max(1, Number(argv[++i]) || DEFAULT_LIMIT));
    else if (argv[i] === "--json") args.json = argv[++i];
    else if (argv[i] === "--q") args.q = argv[++i];
    else if (argv[i] === "--kind") args.kind = argv[++i];
    else if (argv[i] === "--index-dir") args.indexDir = argv[++i];
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  args.root = resolve(args.root);
  return args;
}

/*
 * 인덱스 위치. 기본값은 지금까지와 같은 `_workspace/index`다.
 * `--index-dir`는 이 기본값을 바꾸기 위한 것이 아니라, 같은 인덱서를 다른 상태 디렉터리
 * (예: CLI의 `.axnavi/index`)에 겨눌 수 있게 열어 두기 위한 것이다. 넘기지 않으면 동작이 같다.
 */
function indexDirOf(root, indexDir) {
  return indexDir ? resolve(indexDir) : join(root, "_workspace", "index");
}

function indexPath(root, name, indexDir) {
  return join(indexDirOf(root, indexDir), `${name}.json`);
}

/* 인덱스는 파일당 한 번만 읽어 재사용한다 — 한 실행에서 같은 파일을 두 번 파싱하지 않기 위함. */
const cache = new Map();
function loadIndex(root, name, indexDir) {
  const dir = indexDirOf(root, indexDir);
  const key = `${dir}::${name}`;
  if (cache.has(key)) return cache.get(key);
  const path = indexPath(root, name, indexDir);
  if (!existsSync(path)) {
    const error = new Error(`인덱스가 없습니다: ${path} — build-index.mjs를 먼저 실행하세요.`);
    error.missingIndex = name;
    throw error;
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  cache.set(key, value);
  return value;
}

/*
 * 상한을 적용하되 잘린 개수를 함께 돌려준다.
 *
 * 수를 items 보다 앞에 둔 것은 일부러다. 이 결과는 중간에서 잘려 전달되는 일이
 * 있고(위임 경로가 도구 결과를 2000자로 자른다), 뒤에 두면 잘릴 때마다 몇 건이었는지를
 * 먼저 잃는다. 몇 건인지는 목록 자체보다 먼저 알아야 하는 것이다.
 */
function cap(items, limit) {
  return { total: items.length, returned: Math.min(items.length, limit), truncated: Math.max(0, items.length - limit), items: items.slice(0, limit) };
}

const matches = (haystack, needle) => String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
/* `--id`는 전체 id와 마지막 segment 둘 다로 맞춘다 — 에이전트가 짧은 이름으로 물어도 통하게. */
const idMatches = (id, query) => id === query || String(id).split(".").at(-1) === query || matches(id, query);

/*
 * 자유 텍스트로 훑을 대상.
 *
 * 한글이 실제로 들어 있는 곳을 실측해서 골랐다 — sql_usage 16,708조각,
 * call_graph 14,799조각, dead_code 22,765조각, api_contract 11,135조각.
 * symbols·schema 에는 한글이 없지만 영문 키워드로도 찾게 같이 넣는다.
 */
const SEARCHABLE = [
  { index: "symbols", key: "symbols", kind: "symbol" },
  { index: "call_graph", key: "nodes", kind: "node" },
  { index: "call_graph", key: "edges", kind: "edge" },
  { index: "sql_usage", key: "sqls", kind: "sql" },
  { index: "sql_usage", key: "usages", kind: "sql_use" },
  { index: "schema", key: "tables", kind: "table" },
  { index: "api_contract", key: "endpoints", kind: "endpoint" },
  { index: "data_flow", key: "chains", kind: "flow" },
  { index: "external_io", key: "communications", kind: "io" },
  { index: "dead_code", key: "unused_methods", kind: "dead" },
];

/*
 * 레코드 한 건에서 찾는 말이 든 필드를 하나 집어 온다.
 *
 * 필드 이름을 일일이 나열하지 않는 이유 — AI 보강이 붙이는 설명 필드는 인덱서 버전마다
 * 늘어난다. 나열해 두면 새 필드가 생겨도 검색이 못 따라간다.
 * 중첩은 한 겹까지만 본다. 더 파고들면 call_graph 8,701 엣지에서 느려진다.
 */
function findText(record, lower, depth = 0) {
  if (!record || typeof record !== "object") return null;
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === "string") {
      if (value.toLowerCase().includes(lower)) return { field, value };
    } else if (Array.isArray(value) && depth < 1) {
      for (const item of value) {
        if (typeof item === "string" && item.toLowerCase().includes(lower)) return { field, value: item };
        const deeper = findText(item, lower, depth + 1);
        if (deeper) return { field: `${field}.${deeper.field}`, value: deeper.value };
      }
    } else if (depth < 1) {
      const deeper = findText(value, lower, depth + 1);
      if (deeper) return { field: `${field}.${deeper.field}`, value: deeper.value };
    }
  }
  return null;
}

/* 찾은 말 주변만 잘라 준다. SQL 본문은 수천 자라 통째로 주면 화면이 덮인다. */
function excerpt(value, needle) {
  const text = String(value).replace(/\s+/g, " ").trim();
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1 || text.length <= 120) return text.slice(0, 120);
  const from = Math.max(0, at - 40);
  return `${from > 0 ? "…" : ""}${text.slice(from, from + 120)}${from + 120 < text.length ? "…" : ""}`;
}

/*
 * 업무 용어로 기능 후보에 순위를 매긴다(glossary.json).
 *
 * 단어가 나온 횟수가 아니라 **어디에 어떤 모양으로** 나왔는지로 매긴다. 실측(eduLms "수강신청"):
 * 단어가 든 JSP 112개 중 화면 제목에 든 것은 9개였고, 학습자 수강신청 화면 4개가 전부 그 안에 있었다.
 * 나머지 대부분은 다른 기능의 컬럼 이름("수강신청일")이었다.
 */
const TERM_WEIGHT = { title: 10, heading: 8, header: 8, class_doc: 6, desc: 4, method_doc: 3, label: 1 };
const TERM_KIND_LABEL = { title: "화면 제목", heading: "화면 제목", header: "파일 머리말", class_doc: "클래스 설명", desc: "쿼리·컬럼 설명", method_doc: "메서드 설명", label: "표 머리·라벨" };
/* 같은 파일에서 약한 신호가 수십 번 나와도 제목 하나를 넘지 못하게 종류별로 센다. */
const TERM_KIND_CAP = { label: 3, method_doc: 3, desc: 5 };

/** 그 말 자체인가(1), 여러 낱말 중 하나인가(0.8), 더 긴 말의 일부인가("수강신청기간" — 0.35) */
function termMatch(term, q) {
  if (term === q) return 1;
  const tokens = term.split(/[\s|·,/()[\]<>:~\-_.]+/).filter(Boolean);
  if (tokens.includes(q)) return 0.8;
  return term.includes(q) ? 0.35 : 0;
}

export function rankFeatures(entries, q, { groups: groupLimit = 8, files: fileLimit = 5 } = {}) {
  /** @type {Map<string, { score: number, reasons: Array<{ w: number, text: string }>, counts: Record<string, number> }>} */
  const byFile = new Map();
  let hitCount = 0;
  for (const entry of entries) {
    const match = termMatch(entry.term, q);
    if (!match) continue;
    hitCount += 1;
    const file = byFile.get(entry.file) || { score: 0, reasons: [], counts: {} };
    const seen = (file.counts[entry.kind] = (file.counts[entry.kind] || 0) + 1);
    if (!TERM_KIND_CAP[entry.kind] || seen <= TERM_KIND_CAP[entry.kind]) {
      const w = (TERM_WEIGHT[entry.kind] || 1) * match;
      file.score += w;
      file.reasons.push({ w, text: `${TERM_KIND_LABEL[entry.kind] || entry.kind} '${entry.term}' L${entry.line}${entry.symbol ? ` (${entry.symbol})` : ""}` });
    }
    byFile.set(entry.file, file);
  }
  /* 기능은 대개 폴더 하나에 모인다(front/course/apply/cosApply*.jsp). 폴더 단위로 묶어 순위를 매긴다. */
  /** @type {Map<string, Array<{ file: string, score: number, reasons: string[] }>>} */
  const byDir = new Map();
  for (const [file, info] of byFile) {
    /*
     * 쿼리·SQL·메시지 파일은 한 폴더(WEB-INF/config/query)에 모든 업무가 모여 있어 폴더로 묶으면
     * 서로 다른 업무가 한 덩어리가 된다(실측: "수료" 1위가 query 폴더 전체). 파일 이름에 업무가
     * 드러나므로(query-lms-front-course-ora.xml) 파일 하나를 한 묶음으로 본다.
     */
    const dir = /\.(xml|sql|properties)$/i.test(file) || !file.includes("/") ? file : file.slice(0, file.lastIndexOf("/"));
    const list = byDir.get(dir) || [];
    list.push({ file, score: info.score, reasons: info.reasons.sort((a, b) => b.w - a.w).slice(0, 3).map((r) => r.text) });
    byDir.set(dir, list);
  }
  const groups = [...byDir].map(([dir, files]) => {
    files.sort((a, b) => b.score - a.score);
    // 폴더 점수는 상위 파일 몇 개만 더한다 — 약한 언급이 수십 개인 폴더가 제목 하나 있는 폴더를 이기지 않게.
    const score = files.slice(0, 5).reduce((sum, f) => sum + f.score, 0);
    return { dir, score: Math.round(score * 10) / 10, file_count: files.length, files: files.slice(0, fileLimit).map((f) => ({ ...f, score: Math.round(f.score * 10) / 10 })) };
  }).sort((a, b) => b.score - a.score);
  return { term_hits: hitCount, file_count: byFile.size, group_count: groups.length, groups: groups.slice(0, groupLimit), truncated_groups: Math.max(0, groups.length - groupLimit) };
}

const COMMANDS = {
  /* 심볼 위치 조회 — "이 클래스·메서드 어디 있나" */
  symbol({ root, indexDir, name, file, limit }) {
    const symbols = loadIndex(root, "symbols", indexDir).symbols || [];
    const hits = symbols.filter((item) => (name ? idMatches(item.id, name) : true) && (file ? matches(item.file, file) : true));
    return { query: { name, file }, ...cap(hits.map(({ id, type, file: f, line, package: pkg }) => ({ id, type, file: f, line, package: pkg })), limit) };
  },

  /* 이 심볼을 누가 부르는가 — 영향도 분석의 출발점 */
  callers({ root, indexDir, id, limit }) {
    if (!id) throw new Error("callers에는 --id가 필요합니다.");
    const graph = loadIndex(root, "call_graph", indexDir);
    const hits = (graph.edges || []).filter((edge) => idMatches(edge.to, id));
    return { query: { id }, ...cap(hits.map(({ from, to, type, file, line }) => ({ from, to, type, file, line })), limit) };
  },

  /* 이 심볼이 무엇을 부르는가 */
  callees({ root, indexDir, id, limit }) {
    if (!id) throw new Error("callees에는 --id가 필요합니다.");
    const graph = loadIndex(root, "call_graph", indexDir);
    const hits = (graph.edges || []).filter((edge) => idMatches(edge.from, id));
    return { query: { id }, ...cap(hits.map(({ from, to, type, file, line }) => ({ from, to, type, file, line })), limit) };
  },

  /* 진입점에서 출발하는 호출 경로 — "이 화면 누르면 뭐가 도나" */
  trace({ root, indexDir, id, depth = 3, limit }) {
    if (!id) throw new Error("trace에는 --id가 필요합니다.");
    const edges = loadIndex(root, "call_graph", indexDir).edges || [];
    const byFrom = new Map();
    for (const edge of edges) {
      const bucket = byFrom.get(edge.from);
      if (bucket) bucket.push(edge);
      else byFrom.set(edge.from, [edge]);
    }
    const start = [...byFrom.keys()].find((key) => key === id) || [...byFrom.keys()].find((key) => idMatches(key, id));
    const paths = [];
    const seen = new Set();
    const walk = (node, trail, level) => {
      if (paths.length >= limit || level > depth || seen.has(node)) return;
      seen.add(node);
      for (const edge of byFrom.get(node) || []) {
        const next = [...trail, { to: edge.to, type: edge.type, file: edge.file, line: edge.line }];
        /* 경로에 출발점을 포함해 그대로 읽을 수 있게 한다("A → B → C"). */
        paths.push({ depth: level, path: [start, ...next.map((step) => step.to)], leaf: next.at(-1) });
        walk(edge.to, next, level + 1);
      }
    };
    if (start) walk(start, [], 1);
    return { query: { id, depth }, resolved_start: start || null, ...cap(paths, limit) };
  },

  /* SQL id·테이블로 조회 — sql_usage.json은 실측 143MB라 직접 열면 안 된다 */
  sql({ root, indexDir, id, table, file, limit }) {
    const usage = loadIndex(root, "sql_usage", indexDir);
    const sqls = (usage.sqls || []).filter((item) => (id ? idMatches(item.id, id) : true)
      && (table ? (item.tables || []).some((name) => matches(name, table)) : true)
      && (file ? matches(item.file, file) : true));
    const ids = new Set(sqls.map((item) => item.id));
    const usages = (usage.usages || []).filter((item) => ids.has(item.sql_id));
    return {
      query: { id, table, file },
      statements: cap(sqls.map(({ id: sid, type, tables, file: f, line }) => ({ id: sid, type, tables, file: f, line })), limit),
      used_by: cap(usages.map(({ sql_id, file: f, line, method }) => ({ sql_id, file: f, line, method })), limit),
    };
  },

  /* 테이블을 건드리는 곳 전부 — 스키마 변경 영향도 */
  table({ root, indexDir, table, limit }) {
    if (!table) throw new Error("table에는 --table이 필요합니다.");
    const usage = loadIndex(root, "sql_usage", indexDir);
    const sqls = (usage.sqls || []).filter((item) => (item.tables || []).some((name) => String(name).toLowerCase() === table.toLowerCase()));
    const ids = new Set(sqls.map((item) => item.id));
    const usages = (usage.usages || []).filter((item) => ids.has(item.sql_id));
    const byType = {};
    for (const item of sqls) byType[item.type] = (byType[item.type] || 0) + 1;
    return {
      query: { table },
      statement_count_by_type: byType,
      statements: cap(sqls.map(({ id, type, file, line }) => ({ id, type, file, line })), limit),
      call_sites: cap(usages.map(({ sql_id, file, line, method }) => ({ sql_id, file, line, method })), limit),
    };
  },

  /* HTTP 엔드포인트 조회 */
  endpoint({ root, indexDir, path: pathQuery, limit }) {
    const contract = loadIndex(root, "api_contract", indexDir);
    const hits = (contract.endpoints || []).filter((item) => (pathQuery ? matches(item.path_pattern || item.path, pathQuery) : true));
    return { query: { path: pathQuery }, ...cap(hits.map(({ method, path, path_pattern, handler, file, line }) => ({ method, path, path_pattern, handler, file, line })), limit) };
  },

  /* 트랜잭션 경계 조회 */
  transaction({ root, indexDir, id, file, limit }) {
    const boundaries = loadIndex(root, "transactions", indexDir).boundaries || [];
    const hits = boundaries.filter((item) => (id ? idMatches(item.entry_method, id) : true) && (file ? matches(item.file, file) : true));
    return { query: { id, file }, ...cap(hits.map(({ entry_method, file: f, line, marker, propagation, isolation }) => ({ entry_method, file: f, line, marker, propagation, isolation })), limit) };
  },

  /* 테이블 정의 — 컬럼·PK·FK. "이 테이블이 무엇과 엮여 있나"는 온보딩 1번 질문이다. */
  schema({ root, indexDir, table, limit }) {
    const tables = loadIndex(root, "schema", indexDir).tables || [];
    const hits = table ? tables.filter((item) => matches(item.name, table)) : tables;
    /* 테이블을 지목했으면 정의 전체를, 목록 조회면 이름·컬럼 수만 준다(수백 개면 그것만으로도 크다). */
    const shaped = table
      ? hits.map(({ name, columns, primary_key, foreign_keys, indexes, source_file }) => ({ name, columns, primary_key, foreign_keys, indexes, source_file }))
      : hits.map(({ name, columns, primary_key }) => ({ name, column_count: (columns || []).length, primary_key }));
    /* 이 테이블을 참조하는 다른 테이블의 FK도 함께 — 한쪽 방향만 보면 영향도를 놓친다. */
    const referencedBy = table
      ? tables.filter((item) => (item.foreign_keys || []).some((fk) => matches(fk.references_table, table)))
        .map((item) => ({ table: item.name, foreign_keys: (item.foreign_keys || []).filter((fk) => matches(fk.references_table, table)) }))
      : [];
    return { query: { table }, ...cap(shaped, limit), referenced_by: referencedBy };
  },

  /* 데드 코드 후보 (실측 38MB — 페이지 단위로만 준다) */
  dead({ root, indexDir, file, limit }) {
    const dead = loadIndex(root, "dead_code", indexDir).unused_methods || [];
    const hits = dead.filter((item) => (file ? matches(item.file, file) : true));
    return { query: { file }, ...cap(hits.map(({ id, file: f, line, reason }) => ({ id, file: f, line, reason })), limit) };
  },

  /*
   * 자유 텍스트 검색 — "로그인", "중복체크" 같은 업무 용어로 찾는다.
   *
   * 다른 명령은 전부 코드 식별자·파일 경로·테이블명으로만 건다. 그래서 한국어 업무
   * 용어로는 아무것도 안 나왔다(실측: symbol "로그인" 0건, "login" 32건).
   *
   * 그런데 한글은 이미 인덱스 안에 있다 — SQL 본문·별칭, AI 보강 설명, 흐름 이름에
   * 들어 있는데 꺼낼 길이 없었을 뿐이다. 여기서 그 필드들을 훑는다.
   * 인덱스를 다시 만들 필요는 없다.
   */
  search({ root, indexDir, q, kind, limit }) {
    const needle = String(q || "").trim();
    if (!needle) throw new Error("search에는 --q가 필요합니다.");
    const lower = needle.toLowerCase();

    /** @type {Array<{kind: string, id: string, file: string, line: number, field: string, snippet: string}>} */
    const hits = [];
    /** 인덱스가 없어도 나머지는 계속 본다 — 하나 없다고 검색 전체를 막을 이유는 없다. */
    const missing = [];

    for (const source of SEARCHABLE) {
      if (kind && source.kind !== kind) continue;
      let index;
      try {
        index = loadIndex(root, source.index, indexDir);
      } catch (error) {
        if (error.missingIndex) missing.push(source.index);
        continue;
      }
      for (const record of index[source.key] || []) {
        const found = findText(record, lower);
        if (!found) continue;
        hits.push({
          kind: source.kind,
          id: String(record.id ?? record.from ?? record.name ?? record.path ?? record.sql_id ?? ""),
          file: String(record.file ?? ""),
          line: Number(record.line ?? 0),
          field: found.field,
          snippet: excerpt(found.value, needle),
        });
      }
    }

    /*
     * 한글 업무 용어면 기능 후보 순위를 **맨 앞에** 둔다. 결과는 중간에서 잘려 전달되기도 해서
     * 뒤에 두면 가장 쓸모 있는 부분을 먼저 잃는다. 인덱스가 옛 판이라 glossary 가 없으면 건너뛴다.
     */
    let features = null;
    if (/[가-힣]/.test(needle) && !kind) {
      try {
        features = rankFeatures(loadIndex(root, "glossary", indexDir).entries || [], needle);
      } catch (error) {
        if (error.missingIndex) missing.push("glossary");
      }
    }

    return {
      query: { q: needle, kind: kind || null },
      ...(features ? { features, features_note: "업무 용어가 제목·머리말·설명에 나온 위치로 매긴 기능 후보다. 상위 폴더부터 읽어 확인한다." } : {}),
      ...cap(hits, limit),
      ...(missing.length ? { missing_indexes: missing } : {}),
      note: "코드 식별자로 좁히려면 symbol·callers·sql 명령을 쓴다.",
    };
  },

  /* 규모만 먼저 확인 — 무엇을 열지 정하기 전에 보는 화면 */
  summary({ root, indexDir }) {
    const meta = loadIndex(root, "_meta", indexDir);
    const sizes = {};
    for (const name of meta.indexes || []) {
      const path = indexPath(root, name);
      if (existsSync(path)) sizes[name] = `${(statSync(path).size / 1048576).toFixed(1)}MB`;
    }
    return {
      tier: meta.tier,
      source_file_count: meta.source_file_count,
      unresolved_count: meta.unresolved_count,
      source_fingerprint: meta.source_fingerprint,
      index_sizes: sizes,
      note: "MB 단위 인덱스는 Read로 열지 말고 이 스크립트의 질의 명령을 쓴다.",
    };
  },
};

function printHelp() {
  process.stdout.write(`인덱스 질의 도구 — 대형 인덱스를 Read로 여는 대신 필요한 줄만 얻는다.

  node query-index.mjs <명령> --root <프로젝트> [옵션]

  summary                                   규모와 인덱스별 크기 먼저 확인
  search      --q <말> [--kind <종류>]        업무 용어로 전체 검색 (SQL 본문·설명까지)
  symbol      --name <이름> [--file <경로>]  심볼 위치
  callers     --id <심볼>                    이 심볼을 부르는 곳
  callees     --id <심볼>                    이 심볼이 부르는 곳
  trace       --id <심볼> [--depth 3]        진입점부터의 호출 경로
  sql         [--id <SQL id>] [--table T]    SQL 문과 사용처
  table       --table <테이블>               이 테이블을 건드리는 곳 전부
  schema      [--table <테이블>]            테이블 정의·PK·FK (참조하는 쪽도 함께)
  endpoint    [--path <경로>]                HTTP 엔드포인트
  transaction [--id <심볼>] [--file <경로>]  트랜잭션 경계
  dead        [--file <경로>]                데드 코드 후보

  공통: --limit N (기본 ${DEFAULT_LIMIT}, 최대 ${MAX_LIMIT}). 응답에 total·truncated가 함께 온다.
        --index-dir <dir>  인덱스 위치 (기본 <root>/_workspace/index).

  search 의 --kind: symbol node edge sql sql_use table endpoint flow io dead
`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "help" || args.command === "--help" || args.command === "-h") { printHelp(); return 0; }
    const handler = COMMANDS[args.command];
    if (!handler) { process.stderr.write(`지원하지 않는 명령: ${args.command}\n`); printHelp(); return 1; }
    process.stdout.write(`${JSON.stringify(handler(args), null, 2)}\n`);
    return 0;
  } catch (error) {
    /* 조용한 실패 금지 — 인덱스가 없어서인지 질의가 틀려서인지 구분해 알린다. */
    process.stderr.write(`${JSON.stringify({ error: error.message, missing_index: error.missingIndex || null }, null, 2)}\n`);
    return 1;
  }
}

export { COMMANDS, loadIndex };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
