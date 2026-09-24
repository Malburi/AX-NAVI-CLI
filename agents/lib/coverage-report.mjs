// 인덱스를 읽어 커버리지 진단서(요약 객체 + 마크다운)를 만든다 — LLM을 쓰지 않는다.
/*
 * 쓰임새는 "이 시스템을 이 도구로 얼마나 다룰 수 있나"를 인수 전에 근거로 보여 주는 것이다.
 * 판정·점수를 새로 만들지 않고 인덱서가 이미 기록한 사실(adapter_coverage·excluded_sources·
 * encoding·complexity)과 인덱스 건수만 옮긴다. 추정은 문장에 추정이라고 적는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveIndexDir, scanUnindexedExtensions } from "./build-index.mjs";

/* 코드가 아닌 것 — 인덱서가 읽지 않아도 분석 누락이 아니다. 여기 없는 확장자는 누락 후보로 보여 준다. */
const NON_CODE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".hwp", ".hwpx", ".txt", ".md", ".csv", ".log", ".rtf",
  ".zip", ".jar", ".war", ".ear", ".class", ".dll", ".exe", ".so", ".gz", ".tar", ".7z", ".pdb", ".lib", ".obj",
  ".mp3", ".mp4", ".avi", ".wav", ".swf",
  ".css", ".scss", ".sass", ".less", ".map", ".lock", ".gitignore", ".gitattributes", ".editorconfig", ".ds_store",
  /* 명세·설정·서명·배포 부산물 — 로직이 아니다(실측 JSP 저장소에서 코드 후보로 잘못 보이던 것). */
  ".tld", ".xsd", ".dtd", ".mf", ".ncx", ".opf", ".sch", ".lic", ".cab", ".cur", ".ani", ".fla", ".psd", ".ai", ".eps",
  ".ocx", ".chm", ".mdb", ".ini",
]);

function readIndex(indexDir, name) {
  const path = join(indexDir, `${name}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "-");

export function buildCoverageReport(rootArg, indexDirArg) {
  const root = resolve(rootArg);
  const indexDir = resolveIndexDir(root, indexDirArg);
  const meta = readIndex(indexDir, "_meta");
  if (!meta) throw new Error(`인덱스가 없습니다 — ${indexDir} (axnavi index build 먼저)`);
  const coverage = meta.adapter_coverage || {};
  const extensions = coverage.extensions || [];
  const indexedFiles = extensions.reduce((sum, item) => sum + item.files, 0);
  const discoveryOnly = coverage.unsupported_files || [];
  const unindexed = scanUnindexedExtensions(root);
  const missing = unindexed.filter((item) => !NON_CODE_EXTENSIONS.has(item.extension));

  const graph = readIndex(indexDir, "call_graph") || { nodes: [], edges: [] };
  const sqlUsage = readIndex(indexDir, "sql_usage") || { sqls: [], usages: [] };
  const callEdges = graph.edges.filter((item) => item.type === "call").length;
  /*
   * 미해결은 성격이 둘이다. 후보가 2개 이상이면 AI가 고를 수 있고(같은 패턴은 한 그룹으로 한 번 판정),
   * 후보가 0개면 대상이 이 저장소에 없다(짝 저장소의 .js·외부 jar 추정) — 판정 대상이 아니다.
   */
  const unresolvedPath = join(indexDir, "_unresolved.jsonl");
  const unresolvedItems = existsSync(unresolvedPath)
    ? readFileSync(unresolvedPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    : [];
  /* 판정 대상이 상한(2,000)을 넘으면 인덱서가 후보 목록을 빼고 `candidate_count`만 남긴다 — 목록 길이로 세면 0개로 오인한다. */
  const widthOf = (item) => item.candidate_count ?? (item.candidates || []).length;
  const decidable = unresolvedItems.filter((item) => widthOf(item) >= 2);
  const notFound = unresolvedItems.filter((item) => widthOf(item) < 2).length;
  const decidableCalls = decidable.filter((item) => item.kind === "ambiguous_call").length;
  const groups = (() => { try { return JSON.parse(readFileSync(join(indexDir, "_unresolved_groups.json"), "utf8")).groups?.length ?? null; } catch { return null; } })();
  const unresolved = meta.unresolved_count || 0;
  const codeUsage = new Set(sqlUsage.usages.filter((item) => item.method && item.method !== "unknown" && item.method !== item.sql_id).map((item) => item.sql_id));
  const linkedSqls = sqlUsage.sqls.filter((item) => codeUsage.has(item.id)).length;

  const summary = {
    root,
    generated_at: meta.generated_at,
    indexer_version: meta.version,
    source_fingerprint: meta.source_fingerprint,
    files: {
      indexed: indexedFiles,
      full: coverage.full_files || 0,
      partial: coverage.partial_files || 0,
      discovery_only: discoveryOnly.length,
      excluded: meta.excluded_sources?.count || 0,
      unindexed_code_candidates: missing.reduce((sum, item) => sum + item.files, 0),
    },
    extracted: {
      symbols: readIndex(indexDir, "symbols")?.symbols?.length || 0,
      methods: graph.nodes.filter((item) => item.type === "method").length,
      call_edges: callEdges,
      unresolved_calls: unresolved,
      ai_decidable: decidable.length,
      ai_groups: groups ?? decidable.length,
      target_not_found: notFound,
      endpoints: readIndex(indexDir, "api_contract")?.endpoints?.length || 0,
      sql_statements: sqlUsage.sqls.length,
      tables: readIndex(indexDir, "schema")?.tables?.length || 0,
      external_io: readIndex(indexDir, "external_io")?.communications?.length || 0,
      transactions: readIndex(indexDir, "transactions")?.boundaries?.length || 0,
    },
    quality: {
      /* 분모에는 판정할 수 있는 모호한 호출만 넣는다 — 대상이 저장소 밖인 호출은 이 저장소가 풀 문제가 아니다. */
      call_resolution: callEdges + decidableCalls ? callEdges / (callEdges + decidableCalls) : null,
      sql_linked: sqlUsage.sqls.length ? linkedSqls / sqlUsage.sqls.length : null,
    },
    extensions,
    partial_targets: coverage.partial_targets || [],
    discovery_only: discoveryOnly,
    unindexed_code_candidates: missing,
    excluded_by_reason: meta.excluded_sources?.by_reason || {},
    encoding: meta.encoding?.by_encoding || {},
    encoding_guessed: meta.encoding?.guessed_count || 0,
    complexity: meta.complexity || {},
  };
  return { summary, markdown: renderMarkdown(summary) };
}

function renderMarkdown(s) {
  const f = s.files;
  const e = s.extracted;
  const lines = [];
  const table = (head, rows) => {
    lines.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`);
    for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
    lines.push("");
  };
  lines.push(`# 커버리지 진단 — ${basename(s.root)}`, "");
  lines.push(`인덱스 생성 ${s.generated_at} · 인덱서 v${s.indexer_version} · 지문 \`${s.source_fingerprint || "-"}\``, "");
  lines.push("AI를 쓰지 않고 결정론적 인덱스에서 뽑은 사실이다. 소스는 외부로 전송되지 않았다.", "");

  lines.push("## 요약", "");
  table(["항목", "파일", "비율"], [
    ["인덱싱한 파일", String(f.indexed), "100%"],
    ["자동 변경 가능 (FULL → GO)", String(f.full), percent(f.full, f.indexed)],
    ["수동 검증 후 변경 (PARTIAL → HOLD)", String(f.partial), percent(f.partial, f.indexed)],
    ["분석 불가, 존재만 확인 (discovery-only)", String(f.discovery_only), "-"],
    ["인덱서가 읽지 않는 코드 후보", String(f.unindexed_code_candidates), "-"],
    ["제외 (벤더·미니파이·테스트)", String(f.excluded), "-"],
  ]);
  const tier = s.complexity.recommended_tier;
  if (tier) lines.push(`추천 분석 깊이는 ${tier}다(복잡도 점수 ${s.complexity.score}).`, "");

  lines.push("## 확장자별 지원 수준", "");
  table(["확장자", "파일", "수준", "어댑터"], s.extensions.map((item) => [item.extension, String(item.files), item.level, item.adapter]));
  if (s.partial_targets.length) {
    lines.push("확장자와 별개로 파일 단위 PARTIAL로 판정된 파일이 있다.", "");
    table(["파일", "사유"], s.partial_targets.slice(0, 30).map((item) => [item.path, item.reason]));
  }

  lines.push("## 추출 결과", "");
  table(["항목", "건수"], [
    ["심볼", e.symbols], ["메서드", e.methods], ["확정된 호출 관계", e.call_edges],
    ["AI 판정 대상 (후보 2개 이상)", `${e.ai_decidable} (판정 그룹 ${e.ai_groups})`],
    ["대상 미발견 (짝 저장소·외부 라이브러리 추정)", e.target_not_found],
    ["API 엔드포인트", e.endpoints], ["SQL 문장", e.sql_statements], ["테이블 (DDL·SQL 유도)", e.tables],
    ["외부 통신", e.external_io], ["트랜잭션 경계", e.transactions],
  ].map(([label, value]) => [label, String(value)]));

  lines.push("## 연결 품질", "");
  const q = s.quality;
  table(["지표", "값", "뜻"], [
    ["호출 확정률", q.call_resolution === null ? "-" : percent(q.call_resolution, 1), "후보가 2개 이상이라 결정론으로 못 정한 호출은 harness-init의 AI 판정으로 넘어간다(대상 미발견은 분모에서 뺌)"],
    ["SQL 연결률", q.sql_linked === null ? "-" : percent(q.sql_linked, 1), "코드에서 실행 위치를 찾은 SQL 비율이다. 낮으면 동적 id·프레임워크 래퍼를 의심한다"],
  ]);

  if (s.discovery_only.length || s.unindexed_code_candidates.length) {
    lines.push("## 분석되지 않는 파일", "");
    if (s.discovery_only.length) {
      const byExt = new Map();
      for (const file of s.discovery_only) { const ext = file.slice(file.lastIndexOf(".")).toLowerCase(); byExt.set(ext, (byExt.get(ext) || 0) + 1); }
      lines.push("존재만 확인하고 내용은 분석하지 않는 형식이다. legacy-decoder나 수동 분석이 필요하다.", "");
      table(["확장자", "파일"], [...byExt].sort((a, b) => b[1] - a[1]).map(([ext, count]) => [ext, String(count)]));
    }
    if (s.unindexed_code_candidates.length) {
      lines.push("인덱서가 읽지 않는 확장자다. 이미지·문서·바이너리·스타일은 뺐으므로 남은 것은 코드일 가능성이 있다(추정).", "");
      table(["확장자", "파일", "예"], s.unindexed_code_candidates.slice(0, 20).map((item) => [item.extension, String(item.files), item.sample]));
    }
  }

  const encodings = Object.entries(s.encoding);
  if (encodings.length) {
    lines.push("## 인코딩", "");
    table(["인코딩", "파일"], encodings.sort((a, b) => b[1] - a[1]).map(([label, count]) => [label, String(count)]));
    if (s.encoding_guessed) lines.push(`선언도 없고 UTF-8도 아니어서 레거시 인코딩으로 추정해 읽은 파일이 ${s.encoding_guessed}개다.`, "");
  }
  const excluded = Object.entries(s.excluded_by_reason);
  if (excluded.length) {
    lines.push("## 제외된 파일", "");
    table(["사유", "파일"], excluded.map(([reason, count]) => [reason, String(count)]));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
