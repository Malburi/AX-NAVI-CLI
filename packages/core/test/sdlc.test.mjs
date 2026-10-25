/*
 * SDLC 산출물·ADR·단계 게이트 — 전부 LLM 없이 판정한다.
 * 요점: 양식 그대로·자동 항목만·"확인 필요"만 있는 절은 작성된 것이 아니다. 승인은 사람이 머리말에서 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPaths } from "../src/index.mjs";
import { createAdr, createArtifact, inspectDocument, listAdrs, listArtifacts, loadTemplate, runGate } from "../src/sdlc/index.mjs";

const BIN = fileURLToPath(new URL("../../cli/src/bin.mjs", import.meta.url));
const NOW = new Date("2026-10-25T01:00:00Z");

function project({ index = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "axsdlc-"));
  const paths = resolveProjectPaths(root);
  if (index) {
    mkdirSync(paths.indexDir, { recursive: true });
    const w = (/** @type {string} */ f, /** @type {unknown} */ v) => writeFileSync(join(paths.indexDir, f), JSON.stringify(v));
    w("_meta.json", { generated_at: "2026-10-20T09:00:00+09:00", source_file_count: 42,
      adapter_coverage: { extensions: [{ extension: ".java", files: 30, level: "FULL" }, { extension: ".jsp", files: 12, level: "PARTIAL" }] } });
    w("api_contract.json", { endpoints: [{ path: "/hr/emp/save.do" }, { path: "/hr/emp/list.do" }, { path: "/pay/calc.do" }] });
    w("schema.json", { tables: [{ name: "TB_EMP", usage_count: 9 }, { name: "TB_DEPT", usage_count: 3 }] });
    w("symbols.json", { symbols: [{ file: "src/main/java/com/acme/hr/EmpService.java" }, { file: "src/main/java/com/acme/hr/EmpDao.java" }, { file: "WEB-INF/jsp/a.jsp" }] });
  }
  return paths;
}

/** 필수 절 아래에 사람이 쓴 한 줄을 넣는다 */
function fill(/** @type {string} */ file, /** @type {Record<string, string>} */ bySection) {
  let text = readFileSync(file, "utf8");
  for (const [heading, line] of Object.entries(bySection)) {
    const re = new RegExp(`(^#+\\s+(?:[\\d.]+\\s*)?${heading}\\s*$)`, "m");
    assert.match(text, re, `절 없음: ${heading}`);
    text = text.replace(re, `$1\n\n${line}`);
  }
  writeFileSync(file, text);
}

const approve = (/** @type {string} */ file) => writeFileSync(file, readFileSync(file, "utf8").replace("상태: 작성중", "상태: 승인"));

test("양식 만들기 — 인덱스 사실로 자동 항목을 채우고, 있는 파일은 덮어쓰지 않는다", () => {
  const p = project();
  const r = createArtifact(p, "sdd", { now: NOW });
  assert.equal(r.created, true);
  assert.match(r.source, /^내장: /);
  const text = readFileSync(r.file, "utf8");
  assert.match(r.file, /docs[\\/]sdlc[\\/]03_설계서\.md$/);
  assert.match(text, /java 30 · jsp 12/);
  assert.match(text, /`com\/acme\/hr` \(심볼 2\)/, "java 패키지 기준 모듈(화면 파일 제외)");
  assert.match(text, /`\/hr\/emp` 2개/);
  assert.match(text, /`TB_EMP`, `TB_DEPT`/);
  assert.match(text, /작성일: 2026-10-25 · 상태: 작성중/);
  assert.doesNotMatch(text, /\{\{\w+\}\}/);
  writeFileSync(r.file, "사람이 쓴 내용");
  assert.equal(createArtifact(p, "sdd").created, false);
  assert.equal(readFileSync(r.file, "utf8"), "사람이 쓴 내용");
  assert.equal(createArtifact(p, "sdd", { force: true }).created, true);
  assert.throws(() => createArtifact(p, "wbs"), /알 수 없는 산출물/);
});

test("조직 양식 주입 — 프로젝트 > AXNAVI_TEMPLATES_DIR > 내장", () => {
  const p = project();
  const org = mkdtempSync(join(tmpdir(), "axorg-"));
  writeFileSync(join(org, "srs.md"), "---\ntitle: HNIX 요구사항 정의서\nphase: req\nfile: HNIX-SRS.md\nrequired: 요구사항 목록\n---\n# {{project}} 요구사항 정의서\n\n## 요구사항 목록\n\n| ID | 내용 |\n|---|---|\n");
  const env = { AXNAVI_TEMPLATES_DIR: org };
  assert.equal(loadTemplate("srs", p, env).meta.title, "HNIX 요구사항 정의서");
  assert.match(createArtifact(p, "srs", { env }).file, /HNIX-SRS\.md$/);
  mkdirSync(join(p.axnaviDir, "templates"), { recursive: true });
  writeFileSync(join(p.axnaviDir, "templates", "srs.md"), "---\ntitle: 프로젝트 전용 SRS\nrequired: 범위\n---\n## 범위\n");
  assert.equal(loadTemplate("srs", p, env).meta.title, "프로젝트 전용 SRS");
  assert.match(loadTemplate("srs", p, env).source, /^프로젝트: /);
});

test("완성도 — 양식 그대로·자동 항목만·'확인 필요'만 있는 절은 미작성", () => {
  const p = project();
  const tpl = loadTemplate("sdd", p);
  const { file } = createArtifact(p, "sdd", { now: NOW });
  const doc = readFileSync(file, "utf8");
  assert.deepEqual(inspectDocument(doc, tpl).incomplete.sort(), ["데이터 설계", "변경 설계", "설계 개요", "아키텍처 결정"].sort());
  // 자동 항목("(아직 ADR 없음)")만 있는 '아키텍처 결정' 절도 미작성이다
  const filled = doc
    .replace("<!-- 작성: 요구사항(02)을 어떻게 구현하는지 구조 수준에서 쓴다. -->", "- 확인 필요: 고객에게 범위 확인")
    .replace("| 요구사항 ID | 대상(클래스·화면·SQL) | 변경 내용 | 영향 |\n|---|---|---|---|", "| 요구사항 ID | 대상(클래스·화면·SQL) | 변경 내용 | 영향 |\n|---|---|---|---|\n| FR-01 | EmpService | 검증 추가 | TB_EMP |");
  const r = inspectDocument(filled, tpl);
  assert.ok(!r.incomplete.includes("변경 설계"), "표에 행을 넣으면 작성됨");
  assert.ok(r.incomplete.includes("설계 개요"), "'확인 필요' 한 줄만 있으면 미작성");
  assert.equal(r.status, "작성중");
  assert.deepEqual(inspectDocument("# 제목\n\n## 설계 개요\n\n내용", tpl).missingSections.sort(), ["데이터 설계", "변경 설계", "아키텍처 결정"].sort());
});

test("ADR — 번호는 최대+1, 한글 제목 파일명, 상태 검증, 목록", () => {
  const p = project({ index: false });
  const a = createAdr(p, "대기열은 DB 순번으로 관리", { now: NOW, status: "채택", decision: "WAIT_SEQ 컬럼으로 순번을 둔다." });
  assert.equal(a.no, "0001");
  assert.match(a.file, /0001-대기열은-DB-순번으로-관리\.md$/);
  const text = readFileSync(a.file, "utf8");
  assert.match(text, /^# ADR-0001: 대기열은 DB 순번으로 관리/);
  assert.match(text, /상태: 채택/);
  assert.match(text, /WAIT_SEQ 컬럼으로 순번을 둔다\./);
  assert.match(text, /<!-- 작성: 결정이 필요했던 상황/);
  writeFileSync(join(p.root, "docs", "adr", "0007-수동.md"), "# ADR-0007: 수동\n\n- 상태: 폐기\n");
  assert.equal(createAdr(p, "다음: 경로/이름?").no, "0008");
  assert.deepEqual(listAdrs(p).map((x) => `${x.no} ${x.status}`), ["0001 채택", "0007 폐기", "0008 제안"]);
  assert.match(listAdrs(p)[2]?.fileName ?? "", /^0008-다음-경로이름\.md$/);
  assert.throws(() => createAdr(p, "x", { status: "승인" }), /상태가 올바르지 않습니다/);
  assert.throws(() => createAdr(p, "  "), /비었습니다/);
});

test("게이트 — 없음·미작성은 STOP, 미승인·ADR 없음은 HOLD, 다 채우고 승인하면 GO", () => {
  const p = project();
  const req0 = runGate(p, "req", { now: NOW });
  assert.equal(req0.verdict, "STOP");
  assert.equal(req0.exitCode, 4);
  assert.ok(req0.checks.some((c) => c.id === "doc:project" && !c.ok && /doc new project/.test(c.detail)));

  const proj = createArtifact(p, "project", { now: NOW }).file;
  const srs = createArtifact(p, "srs", { now: NOW }).file;
  fill(proj, { 목적: "인사 업무 처리 시간 단축.", 범위: "| 포함 | 사원관리 |", 이해관계자: "| PM | HNIX | 홍길동 | 총괄 |", "일정과 마일스톤": "| 설계 | 11/1 | 11/15 | 설계서 |" });
  fill(srs, { "기능 요구사항": "| FR-01 | 입사일 검증 | HR0101 | 상 | SR-0001 |", "비기능 요구사항": "| NFR-01 | 성능 | 저장 1초 이내 | p95 |", "인수 기준": "미래 입사일 입력 → 저장 거부" });
  const held = runGate(p, "req", { now: NOW });
  assert.equal(held.verdict, "HOLD", "필수 절은 다 썼지만 승인 전");
  assert.equal(held.exitCode, 3);
  approve(proj);
  approve(srs);
  assert.equal(runGate(p, "req", { now: NOW }).verdict, "GO");

  // 설계: 앞 단계 검사 + ADR 권고
  const sdd = createArtifact(p, "sdd", { now: NOW }).file;
  const std = createArtifact(p, "standards", { now: NOW }).file;
  fill(sdd, { "설계 개요": "검증 로직을 서비스에 둔다.", "변경 설계": "| FR-01 | EmpService | 검증 | TB_EMP |", "데이터 설계": "변경 없음", "아키텍처 결정": "ADR-0001 입사일 검증 위치" });
  fill(std, { "적용 패턴": "- service-validation 을 따른다.", "코딩 규칙": "예외는 BizException 으로 던진다.", "형상 관리": "feature/SR-번호 브랜치" });
  approve(sdd);
  approve(std);
  const noAdr = runGate(p, "design", { now: NOW });
  assert.equal(noAdr.verdict, "HOLD");
  assert.deepEqual(noAdr.checks.filter((c) => !c.ok).map((c) => c.id), ["adr:exists"]);
  const adr = createAdr(p, "입사일 검증 위치", { now: NOW });
  const proposed = runGate(p, "design", { now: NOW });
  assert.deepEqual(proposed.checks.filter((c) => !c.ok).map((c) => c.id), ["adr:decided", "adr:written"]);
  writeFileSync(adr.file, readFileSync(adr.file, "utf8").replace("상태: 제안", "상태: 채택")
    .replace(/<!-- 작성: 결정이 필요했던[^>]*-->/, "화면마다 검증이 달랐다.")
    .replace(/<!-- 작성: 무엇을 하기로[^>]*-->/, "서비스 계층에서 검증한다.")
    .replace(/<!-- 작성: 좋아지는 점[^>]*-->/, "화면 검증은 보조로 남는다."));
  assert.equal(runGate(p, "design", { now: NOW }).verdict, "GO");
});

test("게이트 dev·test — 리뷰 STOP 은 STOP, 치명 보안 결함은 STOP, --record 는 진행 기록서에 한 줄", () => {
  const p = project();
  /** @type {any} */
  const review = (/** @type {any} */ v) => () => ({ verdict: v, composite: 50, target: "HEAD 대비 작업 트리", files: [{}, {}] });
  const dev = runGate(p, "dev", { now: NOW, review: review("STOP") });
  const r = dev.checks.find((c) => c.id === "review");
  assert.equal(r?.level, "required");
  assert.match(r?.detail ?? "", /STOP — 종합 50 · 대상 HEAD 대비 작업 트리 · 변경 파일 2개/);
  assert.equal(runGate(p, "dev", { now: NOW, review: review("HOLD") }).checks.find((c) => c.id === "review")?.level, "recommended");
  const broken = runGate(p, "dev", { now: NOW, review: () => { throw new Error("git 저장소가 아닙니다\n상세"); } });
  assert.match(broken.checks.find((c) => c.id === "review")?.detail ?? "", /리뷰를 돌리지 못함: git 저장소가 아닙니다$/);

  /** @type {any} */
  const scan = () => ({ bySeverity: { critical: 1, high: 2, medium: 0, low: 0 } });
  const t = runGate(p, "test", { now: NOW, skipReview: true, scan, record: true });
  assert.equal(t.checks.find((c) => c.id === "security:critical")?.ok, false);
  assert.match(t.checks.find((c) => c.id === "security:high")?.detail ?? "", /2건 \(이번 실행\)/);
  assert.ok(t.recorded);
  const log = readFileSync(/** @type {string} */ (t.recorded), "utf8");
  assert.match(log, /\| 2026-10-25 10:00 \| 테스트 \| STOP \| 필수 0\/\d+ · 권고 0\/\d+ · /);
  // 저장된 점검 리포트가 있으면 그것을 쓴다
  mkdirSync(p.reportsDir, { recursive: true });
  writeFileSync(join(p.reportsDir, "security_scan.json"), JSON.stringify({ bySeverity: { critical: 0, high: 0 } }));
  const again = runGate(p, "test", { now: NOW, skipReview: true, scan: () => { throw new Error("부르면 안 됨"); } });
  assert.match(again.checks.find((c) => c.id === "security:critical")?.detail ?? "", /0건 \(기존 리포트\)/);
  assert.equal(listArtifacts(p).find((a) => a.kind === "progress")?.exists, true);
  assert.throws(() => runGate(p, "deploy"), /알 수 없는 단계/);
});

test("CLI — doc new·adr new·gate 종료 코드(STOP 4)", () => {
  const p = project();
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [BIN, "--root", p.root, ...args], { encoding: "utf8" });
  assert.equal(run(["doc", "new", "all"]).status, 0);
  assert.match(run(["doc", "list"]).stdout, /req\s+project\s+프로젝트 정의서\s+미작성 4절/);
  const adr = run(["adr", "new", "검증", "위치", "--status", "채택"]);
  assert.equal(adr.status, 0);
  assert.match(adr.stdout, /ADR-0001/);
  assert.equal(run(["adr", "new", "x", "--status", "승인"]).status, 2);
  const gate = run(["gate", "design", "--format", "json"]);
  assert.equal(gate.status, 4);
  assert.equal(JSON.parse(gate.stdout).verdict, "STOP");
  assert.equal(run(["gate"]).status, 2);
  assert.equal(run(["gate", "deploy"]).status, 2);
});
