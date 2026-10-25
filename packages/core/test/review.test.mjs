/*
 * axnavi review · scan security — 결정론적 게이트 검증.
 *
 * 임시 git 저장소에 실제 커밋을 만들고 diff 를 돌린다. 정규식 단위 검사만으로는
 * "줄 번호가 맞는가·어느 메서드 안인가·종료 코드가 맞는가"를 보장하지 못한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRules, parseUnifiedDiff, runReview, runSecurityScan, EXIT, renderMarkdown } from "../src/review/index.mjs";

const NL = String.fromCharCode(10);
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const SERVICE = [
  "package com.hd.order;",
  "",
  "public class OrderService {",
  "  public Order find(String id) {",
  "    return dao.select(id);",
  "  }",
  "",
  "  @PreAuthorize(\"hasRole('ADMIN')\")",
  "  public void cancel(String id) {",
  "    dao.update(id);",
  "  }",
  "}",
].join(NL);

/** 저장소 + 최소 인덱스(심볼·호출 그래프·SQL) */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "axrev-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  mkdirSync(join(root, "src/com/hd/order"), { recursive: true });
  mkdirSync(join(root, "sql"), { recursive: true });
  writeFileSync(join(root, "src/com/hd/order/OrderService.java"), SERVICE);
  writeFileSync(join(root, "README.md"), "# 주문" + NL);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");

  const idx = join(root, "_workspace/index");
  mkdirSync(idx, { recursive: true });
  const file = "src/com/hd/order/OrderService.java";
  writeFileSync(join(idx, "symbols.json"), JSON.stringify({ symbols: [
    { id: "com.hd.order.OrderService", type: "class", file, line: 3 },
    { id: "com.hd.order.OrderService.find", type: "method", file, line: 4 },
    { id: "com.hd.order.OrderService.cancel", type: "method", file, line: 9 },
  ] }));
  const callers = Array.from({ length: 25 }, (_, i) => ({ from: `com.hd.web.C${i}.run`, to: "com.hd.order.OrderService.find", type: "call", file: "x", line: 1 }));
  callers.push({ from: "trigger:order.jsp#btnSearch", to: "com.hd.web.C0.run", type: "markup_event", file: "order.jsp", line: 3 });
  writeFileSync(join(idx, "call_graph.json"), JSON.stringify({ edges: callers }));
  writeFileSync(join(idx, "sql_usage.json"), JSON.stringify({
    sqls: [{ id: "ORDER_S01", type: "select", tables: ["TB_ORDER"], file: "sql/order.xml", line: 1 }],
    usages: [{ sql_id: "ORDER_S01", file, line: 5, method: "com.hd.order.OrderService.find" }],
  }));
  return { root, indexDir: idx, file: join(root, file) };
}

test("unified diff 파싱 — 추가·삭제 줄 번호와 이름 변경", () => {
  const raw = [
    "diff --git a/a.java b/a.java",
    "--- a/a.java",
    "+++ b/a.java",
    "@@ -3,2 +3,3 @@ class A",
    "-old1",
    "-old2",
    "+new1",
    "+new2",
    "+new3",
    "diff --git a/x.sql b/y.sql",
    "similarity index 90%",
    "rename from x.sql",
    "rename to y.sql",
  ].join(NL);
  const files = parseUnifiedDiff(raw);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0]?.added.map((l) => l.line), [3, 4, 5]);
  assert.deepEqual(files[0]?.removed.map((l) => l.line), [3, 4]);
  assert.equal(files[1]?.status, "renamed");
  assert.equal(files[1]?.oldPath, "x.sql");
});

test("규칙 — SQL 결합·MyBatis ${}·시크릿은 즉시 STOP, 시크릿 원문은 가린다", () => {
  const f = applyRules("A.java", [
    { line: 1, text: "String q = \"SELECT * FROM TB_USER WHERE ID = '\" + userId + \"'\";" },
    { line: 2, text: "String password = \"Hd@2026secret!\";" },
    { line: 3, text: "log.info(\"select done\" + count);" },
    { line: 4, text: "getLogger().debug(\"delete from \" + file.getPath());" },
  ], { side: "added" });
  const ids = f.map((x) => x.rule);
  assert.ok(ids.includes("SEC-SQLI-CONCAT"));
  assert.ok(ids.includes("SEC-SECRET"));
  assert.equal(f.filter((x) => x.line >= 3).length, 0, "로그 문자열은 SQL 결합으로 보지 않는다");
  const prose = applyRules("A.java", [{ line: 1, text: "String msg = \"request is \" + request + \" and response is \" + response;" }], { side: "added" });
  assert.equal(prose.length, 0, "영어 문장의 and 는 SQL 이 아니다");
  assert.equal(applyRules("build.xml", [{ line: 1, text: "<delete dir=\"${application.target}\" />" }], { side: "added" }).length, 0, "Ant 프로퍼티는 MyBatis 치환이 아니다");
  const del = applyRules("mapper/a-sql.xml", [{ line: 1, text: "DELETE FROM TB_A" }, { line: 2, text: "WHERE ID = #{id}" }], { side: "current" });
  assert.equal(del.length, 0, "다음 줄의 WHERE 를 본다");
  const delAll = applyRules("mapper/a-sql.xml", [{ line: 1, text: "DELETE FROM TB_A" }, { line: 2, text: "</delete>" }], { side: "current" });
  assert.equal(delAll[0]?.rule, "SEC-DELETE-ALL");
  const secret = f.find((x) => x.rule === "SEC-SECRET");
  assert.ok(secret && !secret.snippet.includes("secret!"), `원문 노출: ${secret?.snippet}`);
  const xml = applyRules("order-sql.xml", [{ line: 7, text: "ORDER BY ${sortColumn}" }], { side: "added" });
  assert.equal(xml[0]?.rule, "SEC-SQLI-MYBATIS");
  assert.equal(xml[0]?.stop, true);
});

test("규칙 — 자리표시자 값은 시크릿으로 보지 않고, axnavi:allow 는 사유와 함께 억제", () => {
  assert.equal(applyRules("a.yml", [{ line: 1, text: "password: \"${DB_PASSWORD}\"" }], { side: "current" }).length, 0);
  const lines = [
    { line: 10, text: "<!-- axnavi:allow SEC-SQLI-MYBATIS 정렬 컬럼은 SortWhitelist 에서 검증 -->" },
    { line: 11, text: "ORDER BY ${sort}" },
  ];
  const [hit] = applyRules("src/main/resources/mapper/OrderMapper.xml", lines, { side: "added" });
  assert.equal(hit?.suppressed, "정렬 컬럼은 SortWhitelist 에서 검증");
});

test("review — 문서만 바꾸면 GO(종료 코드 0)", () => {
  const fx = fixture();
  writeFileSync(join(fx.root, "README.md"), "# 주문 시스템" + NL + "설명 추가" + NL);
  const r = runReview({ root: fx.root, indexDir: fx.indexDir });
  assert.equal(r.verdict, "GO");
  assert.equal(r.exitCode, EXIT.GO);
});

test("review — 공통 모듈(호출자 25곳)을 검증 없이 고치면 HOLD, 영향 화면을 찾아 준다", () => {
  const fx = fixture();
  writeFileSync(fx.file, SERVICE.replace("return dao.select(id);", "if (id == null) return null;" + NL + "    return dao.select(id.trim());"));
  const r = runReview({ root: fx.root, indexDir: fx.indexDir });
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.exitCode, EXIT.HOLD);
  assert.equal(r.impact.symbols[0]?.id, "com.hd.order.OrderService.find");
  assert.equal(r.impact.hubs.length, 1);
  assert.deepEqual(r.impact.tables, ["TB_ORDER"]);
  assert.deepEqual(r.impact.entryPoints, ["trigger:order.jsp#btnSearch"]);
  assert.ok(r.reasons.some((x) => x.includes("UNVERIFIED")));
});

test("review — 같은 변경이라도 검증 명령이 통과하고 테스트를 함께 바꾸면 GO", () => {
  const fx = fixture();
  writeFileSync(fx.file, SERVICE.replace("return dao.select(id);", "return dao.select(id.trim());"));
  mkdirSync(join(fx.root, "src/test"), { recursive: true });
  writeFileSync(join(fx.root, "src/test/OrderServiceTest.java"), "class OrderServiceTest {}" + NL);
  git(fx.root, "add", "-A");
  const r = runReview({ root: fx.root, indexDir: fx.indexDir, staged: true, verify: "node -e \"process.exit(0)\"" });
  assert.equal(r.verification.status, "passed");
  assert.equal(r.verdict, "GO", r.reasons.join(" / "));
});

test("review — 같은 변경에서 넣은 axnavi:allow 는 STOP 을 GO 로 바꾸지 못하고 HOLD(리뷰어 확인)가 된다", () => {
  const fx = fixture();
  const sql = '    String q = "SELECT * FROM TB_ORDER WHERE ID = \'" + id + "\'"; // axnavi:allow SEC-SQLI-CONCAT 내부 값만 들어옴';
  writeFileSync(fx.file, SERVICE.replace("return dao.select(id);", `${sql}${NL}    return dao.select(id);`));
  mkdirSync(join(fx.root, "src/test"), { recursive: true });
  writeFileSync(join(fx.root, "src/test/OrderServiceTest.java"), "class OrderServiceTest {}" + NL);
  git(fx.root, "add", "-A");
  const r = runReview({ root: fx.root, indexDir: fx.indexDir, staged: true, verify: "node -e \"process.exit(0)\"" });
  assert.notEqual(r.verdict, "GO", r.reasons.join(" / "));
  assert.ok(r.reasons.some((x) => /이번 변경에서 추가한 억제 주석 1건/.test(x)), r.reasons.join(" / "));
  // 이미 커밋돼 있던 억제는 그대로 억제로 본다
  git(fx.root, "commit", "-qm", "allow");
  writeFileSync(join(fx.root, "README.md"), "# 주문 변경" + NL);
  const later = runReview({ root: fx.root, indexDir: fx.indexDir, verify: "node -e \"process.exit(0)\"" });
  assert.equal(later.verdict, "GO", later.reasons.join(" / "));
});

test("review — 작업 트리 리뷰는 git add 하지 않은 새 파일도 본다", () => {
  const fx = fixture();
  writeFileSync(join(fx.root, "src/com/hd/order/Secret.java"), 'class Secret { String password = "Hnix!20261234"; }' + NL);
  const r = runReview({ root: fx.root, indexDir: fx.indexDir });
  assert.equal(r.verdict, "STOP", r.reasons.join(" / "));
});

test("scan security — 폴더를 주면 그 아래 파일을 점검한다(예전에는 0건)", () => {
  const fx = fixture();
  writeFileSync(join(fx.root, "src/com/hd/order/Dao.java"), 'class Dao { String q(String id){ return "SELECT * FROM T WHERE A=\'" + id + "\'"; } }' + NL);
  git(fx.root, "add", "-A");
  const r = runSecurityScan({ root: fx.root, paths: ["src/"] });
  assert.ok(r.findings.length >= 1, `점검 ${r.scanned}개 · 건너뜀 ${r.skipped}개`);
});

test("review — 검증 명령이 실패하면 STOP", () => {
  const fx = fixture();
  writeFileSync(fx.file, SERVICE.replace("dao.update(id);", "dao.update(id, true);"));
  const r = runReview({ root: fx.root, indexDir: fx.indexDir, verify: "node -e \"process.exit(1)\"" });
  assert.equal(r.verdict, "STOP");
  assert.equal(r.exitCode, EXIT.STOP);
});

test("review — 인가 어노테이션 삭제는 STOP, 같은 파일 안에서 옮긴 것은 아니다", () => {
  const fx = fixture();
  writeFileSync(fx.file, SERVICE.replace("  @PreAuthorize(\"hasRole('ADMIN')\")" + NL, ""));
  const removed = runReview({ root: fx.root, indexDir: fx.indexDir, testsPassed: true });
  assert.equal(removed.verdict, "STOP");
  assert.ok(removed.findings.some((f) => f.rule === "SEC-AUTH-REMOVED" && f.side === "removed"));

  const fx2 = fixture();
  const moved = SERVICE.replace("  @PreAuthorize(\"hasRole('ADMIN')\")" + NL, "").replace("  public Order find", "  @PreAuthorize(\"hasRole('ADMIN')\")" + NL + "  public Order find");
  writeFileSync(fx2.file, moved);
  const r2 = runReview({ root: fx2.root, indexDir: fx2.indexDir, testsPassed: true });
  assert.ok(!r2.findings.some((f) => f.rule === "SEC-AUTH-REMOVED"));
});

test("review — DB 스키마 DROP 은 데이터 손실로 STOP, 리포트에 롤백 10점", () => {
  const fx = fixture();
  writeFileSync(join(fx.root, "sql/V2__drop.sql"), "ALTER TABLE TB_ORDER DROP COLUMN OLD_FLAG;" + NL);
  git(fx.root, "add", "-A");
  const r = runReview({ root: fx.root, indexDir: fx.indexDir, staged: true, testsPassed: true });
  assert.equal(r.verdict, "STOP");
  assert.equal(r.scores.rollback, 10);
  const md = renderMarkdown(r);
  assert.ok(md.includes("## 결정: STOP"));
  assert.ok(md.includes("데이터 손실"));
});

test("review — 인덱스가 없어도 동작하고 그 사실을 밝힌다", () => {
  const fx = fixture();
  writeFileSync(fx.file, SERVICE.replace("dao.update(id);", "dao.update(id.trim());"));
  const r = runReview({ root: fx.root, indexDir: join(fx.root, "no-index"), testsPassed: true });
  assert.equal(r.impact.available, false);
  assert.ok(r.impact.reason.includes("인덱스 없음"));
});

test("scan security — 저장소 전체를 OWASP 별로 묶고 node_modules 는 건너뛴다", () => {
  const fx = fixture();
  writeFileSync(join(fx.root, "src/com/hd/order/Crypto.java"), "class C { void h() { MessageDigest.getInstance(\"MD5\"); } }" + NL);
  mkdirSync(join(fx.root, "node_modules/x"), { recursive: true });
  writeFileSync(join(fx.root, "node_modules/x/a.js"), "el.innerHTML = v;" + NL);
  git(fx.root, "add", "-A");
  const r = runSecurityScan({ root: fx.root });
  assert.equal(r.bySeverity.medium, 1);
  assert.ok(r.byOwasp["A02:2021"]);
  assert.ok(!r.findings.some((f) => f.file.includes("node_modules")));
});
