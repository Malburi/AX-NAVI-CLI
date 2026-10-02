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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { positionalEffect } from "./index/dispatch.mjs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseArgs(argv) {
  const args = { command: argv[0] || "help", root: process.cwd(), limit: DEFAULT_LIMIT, roots: [] };
  let rootSeen = false;
  for (let i = 1; i < argv.length; i += 1) {
    /* --root 를 여러 번 주면 첫째가 기준 저장소, 나머지는 함께 볼 저장소다(impact). */
    if (argv[i] === "--root") { const value = argv[++i]; if (rootSeen) args.roots.push(resolve(value)); else { args.root = value; rootSeen = true; } }
    else if (argv[i] === "--sql") args.sql = argv[++i];
    else if (argv[i] === "--column") args.column = argv[++i];
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
  /*
   * 여러 낱말("샘플 등록")은 붙은 말 그대로만 찾으면 거의 늘 0건이다 — 화면 제목은 "등록", 코드는 "Sample"
   * 이라 소스 어디에도 "샘플 등록"이 없다(egovframe-web-sample 실측). 붙은 말이 안 맞으면 낱말마다 맞춰
   * 맞은 낱말 비율만큼 점수를 준다. 한 번도 안 나온 낱말은 따로 알려 영문 식별자로 다시 찾게 한다.
   */
  const words = [...new Set(q.split(/\s+/).filter(Boolean))];
  const matchedWords = new Set();
  /** @type {Map<string, { score: number, reasons: Array<{ w: number, text: string }>, counts: Record<string, number> }>} */
  const byFile = new Map();
  let hitCount = 0;
  for (const entry of entries) {
    let match = termMatch(entry.term, q);
    if (match) for (const word of words) matchedWords.add(word);
    else if (words.length > 1) {
      const hit = words.filter((word) => termMatch(entry.term, word));
      if (hit.length) {
        match = Math.max(...hit.map((word) => termMatch(entry.term, word))) * (hit.length / words.length);
        for (const word of hit) matchedWords.add(word);
      }
    }
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
  const unmatched = words.length > 1 ? words.filter((word) => !matchedWords.has(word)) : [];
  return {
    term_hits: hitCount, file_count: byFile.size, group_count: groups.length, groups: groups.slice(0, groupLimit), truncated_groups: Math.max(0, groups.length - groupLimit),
    ...(unmatched.length ? { unmatched_words: unmatched, unmatched_note: "이 낱말은 업무 용어 어디에도 없다 — 코드에는 영문 식별자로 있을 수 있으니 symbol 로 찾아 본다." } : {}),
  };
}

/*
 * 함께 볼 저장소. 명시한 --root 들 + 기준 저장소의 pair_config.md 가 가리키는 짝 저장소.
 * 인덱스가 없는 저장소는 빼고, 뺀 사실을 돌려준다.
 */
function relatedRoots(root, extra = []) {
  const found = [resolve(root), ...extra.map((item) => resolve(item))];
  try {
    const text = readFileSync(join(root, "_workspace", "pair_config.md"), "utf8");
    for (const m of text.matchAll(/^partner_root(?:\[\d+\])?:\s*(.+)$/gm)) {
      const value = (m[1] || "").trim();
      if (value && value !== "unknown") found.push(resolve(value));
    }
  } catch { /* 짝 설정이 없다 */ }
  const unique = [...new Set(found)];
  return {
    roots: unique.filter((item) => existsSync(join(item, "_workspace", "index", "_meta.json"))),
    missing: unique.filter((item) => !existsSync(join(item, "_workspace", "index", "_meta.json"))),
  };
}

/** 없으면 null — 여러 저장소를 볼 때 한쪽 인덱스가 빠져도 나머지는 본다. */
function tryIndex(root, name, indexDir) {
  try { return loadIndex(root, name, indexDir); } catch (error) { if (error.missingIndex) return null; throw error; }
}

const COMMANDS = {
  /*
   * 영향도 — SQL(·컬럼) 또는 메서드를 바꾸면 어디가 영향받나. 저장소를 넘어 화면까지 따라간다.
   *
   * 실측(실제 레거시 xu25): 백엔드만 연 평범한 Claude Code 는 6번 모두 "한 곳뿐" 이라 답했다. 실제로는 화면
   * 24곳이 문자열 디스패치(`TransData.do?worker=…&action=…`)로 부르고 결과를 위치(`rtInfo[1][2]`)로 읽었다.
   * 이 명령은 인덱스의 사실만으로 그 24곳과, 컬럼을 빼면 각 자리가 무엇을 읽게 되는지를 돌려준다.
   */
  impact({ root, indexDir, roots: extraRoots = [], sql: sqlId, id, column, limit }) {
    if (!sqlId && !id) throw new Error("impact에는 --sql <SQL id> 또는 --id <메서드>가 필요합니다.");
    const { roots, missing } = relatedRoots(root, extraRoots);
    const label = (item) => basename(item);
    const dirFor = (item) => (item === resolve(root) ? indexDir : undefined);

    /* 1) SQL 과 그 SQL 을 실행하는 메서드 */
    const statements = [];
    const methodIds = new Set();
    for (const r of roots) {
      const usage = tryIndex(r, "sql_usage", dirFor(r));
      if (!usage) continue;
      if (sqlId) {
        for (const item of usage.sqls || []) if (item.id === sqlId || item.statement_id === sqlId) statements.push({ repo: label(r), id: item.id, type: item.type, file: item.file, line: item.line, columns: item.columns || [] });
        for (const item of usage.usages || []) if ((item.sql_id === sqlId || String(item.sql_id).endsWith(`.${sqlId}`)) && item.method && item.method !== "unknown") methodIds.add(item.method);
      }
    }
    if (id) {
      for (const r of roots) {
        const graph = tryIndex(r, "call_graph", dirFor(r));
        for (const node of graph?.nodes || []) /* 영향도는 정확히 맞는 메서드만 — 부분 문자열로 맞추면 "list" 가 수천 개를 끌고 온다. */ if (node.type === "method" && (node.id === id || node.id.endsWith(`.${id}`)) && node.source !== "external") methodIds.add(node.id);
      }
    }
    const columns = statements[0]?.columns || [];
    let columnHit = null;
    if (column) {
      const upper = column.toUpperCase();
      const found = columns.find((item) => item.name.toUpperCase() === upper) || columns.find((item) => item.expr.toUpperCase().includes(upper));
      columnHit = found ? { name: found.name, index: found.index } : { name: column, index: null };
    }

    /* 2) 메서드마다: 코드 호출자 · 결과 이름 · 화면(디스패치) 호출자 */
    const methods = [];
    const codeCallers = [];
    const screenCalls = [];
    for (const methodId of methodIds) {
      let home = null;
      for (const r of roots) {
        const graph = tryIndex(r, "call_graph", dirFor(r));
        const node = (graph?.nodes || []).find((item) => item.id === methodId && item.source !== "external");
        if (!node) continue;
        home = r;
        for (const edge of graph.edges || []) {
          if (edge.to !== methodId || edge.type === "dispatch") continue;
          codeCallers.push({ repo: label(r), from: edge.from, type: edge.type, file: edge.file, line: edge.line });
        }
        const runs = [...new Set((tryIndex(r, "sql_usage", dirFor(r))?.usages || []).filter((item) => item.method === methodId).map((item) => item.sql_id))];
        methods.push({ repo: label(r), id: methodId, file: node.file, line: node.line, runs_sql: runs });
        break;
      }
      if (!home) continue;
      const homeDispatch = tryIndex(home, "dispatch", dirFor(home));
      const keys = (homeDispatch?.result_keys || []).filter((item) => item.method === methodId && (!sqlId || item.sql_id === sqlId || String(item.sql_id).endsWith(`.${sqlId}`))).map((item) => item.key);
      const last = methods.at(-1);
      if (last) last.result_keys = [...new Set(keys)];
      /* 기준 저장소 안의 호출(해석 결과가 붙어 있다) */
      for (const call of homeDispatch?.calls || []) if (call.resolved?.method_id === methodId) screenCalls.push({ repo: label(home), call, keys });
      /* 짝 저장소의 호출 — 기준 저장소 인덱스가 이어 둔 partner_links 로 찾고, 읽기는 그쪽 인덱스에서 가져온다 */
      const links = (homeDispatch?.partner_links || []).filter((item) => item.method_id === methodId);
      for (const r of roots) {
        if (r === home) continue;
        const partner = tryIndex(r, "dispatch", dirFor(r));
        if (!partner) continue;
        const byPlace = new Map((partner.calls || []).map((call) => [`${call.file}:${call.line}`, call]));
        for (const link of links) {
          if (link.repo !== label(r)) continue;
          const call = byPlace.get(`${link.file}:${link.line}`);
          if (call) screenCalls.push({ repo: label(r), call, keys });
        }
      }
    }

    /* 3) 화면 호출자마다 결과 읽기와 컬럼 변경 영향 */
    const shaped = screenCalls.map(({ repo, call, keys }) => {
      const relevant = (call.reads || []).filter((read) => !keys.length || read.key === null || keys.includes(read.key));
      const reads = relevant.map((read) => {
        const effect = columnHit && columnHit.index !== null ? positionalEffect(read, columnHit.index, columns) : null;
        return { line: read.line, text: read.text, ...(read.via ? { via: read.via } : {}), ...(read.col !== null ? { col: read.col } : {}), ...(read.name ? { name: read.name } : {}), ...(effect ? effect : {}) };
      });
      const effects = new Set(reads.map((read) => read.effect).filter(Boolean));
      const verdict = !columnHit || columnHit.index === null ? (reads.some((read) => read.col !== undefined) ? "reads_by_position" : reads.length ? "reads_by_name" : "no_reads_found")
        : effects.has("reads_removed") || effects.has("shifted") ? "breaks" : reads.length ? "unaffected" : "no_reads_found";
      return { verdict, repo, file: call.file, line: call.line, function: call.function, callback: call.callback, reads };
    });
    const order = { breaks: 0, reads_by_position: 1, no_reads_found: 2, reads_by_name: 3, unaffected: 4 };
    shaped.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) || a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file));

    const files = new Set(shaped.map((item) => `${item.repo}/${item.file}`));
    const notes = [];
    if (!methodIds.size) notes.push(sqlId ? "이 SQL 을 실행하는 메서드를 인덱스에서 찾지 못했다 — sql 명령으로 사용처를 확인하라." : "메서드를 찾지 못했다 — symbol 명령으로 id 를 확인하라.");
    if (missing.length) notes.push(`인덱스가 없어 보지 못한 저장소: ${missing.join(", ")} — axnavi index build 를 그 저장소에서 먼저 실행하라.`);
    if (roots.length < 2) notes.push("저장소 하나만 봤다. 화면이 다른 저장소에 있으면 pair_config 나 --root 를 더 주어야 화면 호출자가 나온다.");
    if (columnHit && columnHit.index === null) notes.push(`SELECT 목록에서 ${column} 의 위치를 찾지 못했다 — 위치 영향은 계산하지 않았다.`);
    notes.push("화면 호출자는 문자열 디스패치(worker·action 류 파라미터)와 콜백의 결과 읽기에서 뽑았다. 동적으로 만든 파라미터·다른 파일의 콜백은 빠질 수 있으니, 결론 전에 컬럼 이름으로 한 번 더 grep 하라.");

    return {
      query: { sql: sqlId || null, id: id || null, column: column || null },
      summary: {
        repos: roots.map(label),
        methods: methods.length,
        code_callers: codeCallers.length,
        screen_call_sites: shaped.length,
        screen_files: files.size,
        breaks_if_column_removed: columnHit && columnHit.index !== null ? shaped.filter((item) => item.verdict === "breaks").length : null,
        reads_by_position: shaped.filter((item) => item.reads.some((read) => read.col !== undefined)).length,
      },
      ...(columnHit ? { column: columnHit } : {}),
      sql: statements.map(({ repo, id: sid, type, file, line, columns: cols }) => ({ repo, id: sid, type, file, line, columns: cols.map((item) => `${item.index}: ${item.name}`) })),
      methods,
      code_callers: cap(codeCallers, limit),
      screen_callers: cap(shaped, limit),
      notes,
    };
  },

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
    /*
     * 엔드포인트 id(`root::POST /addSample.do::…addSample`)나 `POST /addSample.do`로 물어도 그 핸들러에서 시작한다.
     * 실측: search 결과의 엔드포인트 id를 그대로 넘긴 trace 가 0건이라 모델이 callees 를 손으로 이어 붙였다.
     */
    let endpoints = [];
    try { endpoints = loadIndex(root, "api_contract", indexDir).endpoints || []; } catch { /* API 가 없는 저장소 */ }
    const endpoint = byFrom.has(id) ? null : endpoints.find((item) => item.handler && (item.id === id || `${item.method} ${item.path_pattern}` === id || `${item.method} ${item.path}` === id));
    const target = endpoint?.handler || id;
    const start = [...byFrom.keys()].find((key) => key === target) || [...byFrom.keys()].find((key) => idMatches(key, target));
    const paths = [];
    const seen = new Set();
    const walk = (node, trail, level) => {
      if (paths.length >= limit || level > depth || seen.has(node)) return;
      seen.add(node);
      for (const edge of byFrom.get(node) || []) {
        const next = [...trail, { to: edge.to, type: edge.type, file: edge.file, line: edge.line, ...(edge.member ? { member: edge.member } : {}), ...(edge.property ? { property: edge.property } : {}) }];
        /* 경로에 출발점을 포함해 그대로 읽을 수 있게 한다("A → B → C"). */
        paths.push({ depth: level, path: [start, ...next.map((step) => step.to)], leaf: next.at(-1) });
        walk(edge.to, next, level + 1);
      }
    };
    if (start) walk(start, [], 1);
    /* 경로에 XML 빈이 나오면 그 정의를 함께 준다 — 프레임워크 클래스의 동작은 설정(property)에만 있다. */
    const beanIds = new Set(paths.flatMap((item) => item.path).filter((node) => String(node).startsWith("bean:")));
    const beans = beanIds.size
      ? (loadIndex(root, "call_graph", indexDir).nodes || []).filter((node) => beanIds.has(node.id)).map(({ id: beanId, class: className, file, line, properties }) => ({ id: beanId, class: className, file, line, properties }))
      : [];
    return { query: { id, depth }, resolved_start: start || null, ...cap(paths, limit), ...(beans.length ? { beans } : {}) };
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

  /*
   * DB 컬럼을 보여 주는 화면(그리드 열)과, 그 컬럼이 앞부분에 보이는 SQL — 컬럼 변경의 화면 영향.
   * 화면 필드는 camelCase(applDt)로 적히기도 해서 밑줄·대소문자를 빼고도 맞춘다(normalized).
   */
  column({ root, indexDir, name, limit }) {
    if (!name) throw new Error("column에는 --name(컬럼명)이 필요합니다.");
    const flat = (value) => String(value).replace(/_/g, "").toUpperCase();
    let columns = [];
    const missing = [];
    try {
      columns = loadIndex(root, "ui_columns", indexDir).columns || [];
    } catch (error) {
      if (!error.missingIndex) throw error;
      missing.push("ui_columns");
    }
    const screens = columns
      .filter((item) => item.field.toUpperCase() === name.toUpperCase() || flat(item.field) === flat(name))
      .map(({ field, header, lib, file, line }) => ({ field, header, lib, file, line, match: field.toUpperCase() === name.toUpperCase() ? "exact" : "normalized" }));
    const word = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}($|[^\\w$])`, "i");
    let sqls = [];
    try {
      sqls = (loadIndex(root, "sql_usage", indexDir).sqls || []).filter((item) => word.test(item.text_preview || ""));
    } catch (error) {
      if (!error.missingIndex) throw error;
      missing.push("sql_usage");
    }
    return {
      query: { name },
      screens: cap(screens, limit),
      sql_mentions: cap(sqls.map(({ id, type, tables, file, line }) => ({ id, type, tables, file, line })), limit),
      ...(missing.length ? { missing_indexes: missing } : {}),
      note: "sql_mentions 는 SQL 앞부분(240자)에서만 찾는다 — 여기 없다고 안 쓰는 것은 아니다. 테이블 단위는 table 명령으로 본다.",
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
    /* XML 선언형 트랜잭션은 코드에 표식이 없다 — 어느 설정이 걸었는지(config_file:line · pointcut)를 함께 준다. */
    return { query: { id, file }, ...cap(hits.map(({ entry_method, file: f, line, marker, propagation, isolation, read_only, rollback_for, pointcut, config_file, config_line }) => ({ entry_method, file: f, line, marker, propagation, isolation, read_only, rollback_for, pointcut, config_file, config_line })), limit) };
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

  /*
   * 문자열 디스패치 — `TransData.do?worker=빈&action=메서드` 처럼 화면이 문자열로 서버 메서드를 부르는 구조.
   * 규칙(어느 파라미터가 빈 · 메서드인지)과, 찾는 값이 든 호출 · 그 호출이 이어지는 메서드를 돌려준다.
   * 디스패처 클래스가 jar 안이라 소스가 없어도 이걸로 "화면에서 X 를 부르면 서버에서 뭐가 도나"를 바로 안다.
   */
  dispatch({ root, indexDir, q, limit }) {
    const index = loadIndex(root, "dispatch", indexDir);
    const needle = String(q || "").toLowerCase();
    const calls = (index.calls || []).filter((call) => !needle
      || Object.values(call.params || {}).some((value) => String(value).toLowerCase() === needle)
      || String(call.resolved?.method_id || "").toLowerCase().endsWith(`.${needle}`));
    const methods = [...new Set(calls.map((call) => call.resolved?.method_id).filter(Boolean))];
    return {
      query: { q: q || null },
      rules: index.rules || [],
      resolved_methods: methods,
      ...cap(calls.map(({ file, line, function: fn, endpoint, params, callback, resolved }) => ({ file, line, function: fn, endpoint, params, callback, ...(resolved ? { resolved } : {}) })), limit),
      note: "짝 저장소의 호출은 그 저장소 인덱스의 dispatch 에 있다. 어느 화면이 이 메서드를 부르는지 저장소를 넘어 보려면 impact --id 를 쓴다.",
    };
  },

  /* 데드 코드 후보 (실측 38MB — 페이지 단위로만 준다) */
  dead({ root, indexDir, file, limit }) {
    const index = loadIndex(root, "dead_code", indexDir);
    const dead = index.unused_methods || [];
    const hits = dead.filter((item) => (file ? matches(item.file, file) : true));
    const viaDispatch = (index.dispatch_unlinked || []).filter((item) => (file ? matches(item.file, file) : true));
    return {
      query: { file }, ...cap(hits.map(({ id, file: f, line, reason }) => ({ id, file: f, line, reason })), limit),
      ...(viaDispatch.length ? { dispatch_unlinked: cap(viaDispatch.map(({ id, file: f, line }) => ({ id, file: f, line })), limit) } : {}),
      note: "후보일 뿐이다. 문자열 디스패치(dispatch_unlinked)·리플렉션·외부 호출로 불릴 수 있다 — 지우기 전에 impact --id 와 grep 으로 확인하라.",
    };
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

    /* 붙은 말로 하나도 없으면 모든 낱말이 들어 있는 레코드로 한 번 더 찾는다("결제 승인" → "승인 … 결제"). */
    const words = [...new Set(lower.split(/\s+/).filter(Boolean))];
    let matchedBy = "phrase";
    if (!hits.length && words.length > 1) {
      matchedBy = "all_words";
      for (const source of SEARCHABLE) {
        if (kind && source.kind !== kind) continue;
        let index;
        try { index = loadIndex(root, source.index, indexDir); } catch { continue; }
        for (const record of index[source.key] || []) {
          const found = words.map((word) => findText(record, word));
          if (found.some((item) => !item)) continue;
          hits.push({
            kind: source.kind,
            id: String(record.id ?? record.from ?? record.name ?? record.path ?? record.sql_id ?? ""),
            file: String(record.file ?? ""),
            line: Number(record.line ?? 0),
            field: found[0].field,
            snippet: excerpt(found[0].value, words[0]),
          });
        }
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
      ...(words.length > 1 && hits.length ? { matched_by: matchedBy } : {}),
      ...(missing.length ? { missing_indexes: missing } : {}),
      note: "코드 식별자로 좁히려면 symbol·callers·sql 명령을 쓴다.",
    };
  },

  /* 규모만 먼저 확인 — 무엇을 열지 정하기 전에 보는 화면 */
  summary({ root, indexDir }) {
    const meta = loadIndex(root, "_meta", indexDir);
    const sizes = {};
    for (const name of meta.indexes || []) {
      const path = indexPath(root, name, indexDir);
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
  impact      --sql <SQL id> [--column C] | --id <메서드>
                                            바꾸면 영향받는 곳 — 코드 호출자 + 다른 저장소 화면까지
                                            (pair_config 의 짝 저장소를 함께 본다. --root 를 여러 번 줘도 된다)
  search      --q <말> [--kind <종류>]        업무 용어로 전체 검색 (SQL 본문·설명까지)
  column      --name <컬럼명>                 그 DB 컬럼을 보여 주는 화면(그리드 열)과 SQL
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
  dispatch    [--q <빈·action 값>]          문자열 디스패치 규칙 · 호출 · 이어지는 메서드

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

/** 다시 만든 인덱스를 같은 프로세스가 읽게 — REPL 은 한 프로세스로 여러 턴을 돈다. */
function clearIndexCache() { cache.clear(); }

export { COMMANDS, loadIndex, clearIndexCache };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
