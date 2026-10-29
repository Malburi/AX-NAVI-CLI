/*
 * 현대화 레시피 — 자동/수동 구분, JDK javax 는 건드리지 않음, EUC-KR 바이트 보존, git 깨끗할 때만 고침, 검증 게이트.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDraftTargets, draftPrompt, parseDraft, renderModernizeMarkdown, rewriteOracleCalls, runModernize } from "../src/index.mjs";

const NL = String.fromCharCode(10);
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync("git", a, { cwd, stdio: "ignore" });

function repo(/** @type {Record<string, string | Buffer>} */ files) {
  const root = mkdtempSync(join(tmpdir(), "axmod-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  git(root, "init", "-q");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

const JAVA = [
  "import javax.servlet.http.HttpServletRequest;",
  "import javax.persistence.Entity;",
  "import javax.transaction.Transactional;",
  "import javax.transaction.xa.XAResource;",
  "import javax.annotation.PostConstruct;",
  "import javax.annotation.processing.Processor;",
  "import javax.crypto.Cipher;",
  "import javax.sql.DataSource;",
  "class A { Integer n = new Integer(3); void f(Thread workerThread) { workerThread.stop(); timer.stop(); } }",
].join(NL);

test("jakarta — EE 패키지만 바꾸고 JDK 에 남은 javax 는 그대로", () => {
  const root = repo({ "src/A.java": JAVA });
  const r = runModernize({ root, recipe: "jakarta", apply: true });
  assert.equal(r.verdict, "GO");
  const out = readFileSync(join(root, "src/A.java"), "utf8");
  for (const s of ["jakarta.servlet.http", "jakarta.persistence.Entity", "jakarta.transaction.Transactional", "jakarta.annotation.PostConstruct"]) assert.ok(out.includes(s), s);
  for (const s of ["javax.transaction.xa.XAResource", "javax.annotation.processing.Processor", "javax.crypto.Cipher", "javax.sql.DataSource"]) assert.ok(out.includes(s), s);
});

test("java17 — 빌드 대상·박싱 생성자는 자동, Thread.stop 은 수동(다른 객체의 stop 은 무시)", () => {
  const root = repo({
    "pom.xml": "<properties><maven.compiler.source>1.8</maven.compiler.source><java.version>1.8</java.version></properties>",
    "build.gradle": "sourceCompatibility = '1.8'" + NL + "targetCompatibility = JavaVersion.VERSION_1_8",
    "src/A.java": JAVA,
  });
  const plan = runModernize({ root, recipe: "java17" });
  assert.equal(plan.verdict, "HOLD");
  assert.equal(plan.applied, 0);
  assert.deepEqual(plan.findings.filter((f) => f.kind === "manual").map((f) => f.rule), ["JV-007"]);
  const r = runModernize({ root, recipe: "java17", apply: true });
  assert.equal(r.applied, 3);
  assert.match(readFileSync(join(root, "pom.xml"), "utf8"), /<maven\.compiler\.source>17<.*<java\.version>17</);
  assert.match(readFileSync(join(root, "build.gradle"), "utf8"), /sourceCompatibility = '17'[\s\S]*VERSION_17/);
  assert.match(readFileSync(join(root, "src/A.java"), "utf8"), /Integer\.valueOf\(3\)/);
  assert.equal(r.verdict, "HOLD"); // Thread.stop 이 남았다
});

test("oracle-pg — 자바 문자열 SQL 과 매퍼만, 자동·수동 구분", () => {
  const mapper = [
    "<select id=\"a\">",
    "  SELECT NVL(A.NM, '-') NM, SYSDATE, EMP_SEQ.NEXTVAL",
    "  FROM DUAL",
    "  WHERE ROWNUM <= 10 AND A.ID = B.ID(+)",
    "</select>",
  ].join(NL);
  const java = ['String q = "SELECT NVL(X,0) FROM T";', "int NVL(int a) { return a; } // 자바 메서드 이름은 SQL 아님"].join(NL);
  const root = repo({ "mapper/a.xml": mapper, "src/Q.java": java, "ddl/t.sql": "CREATE TABLE T (NM VARCHAR2(50 BYTE), AMT NUMBER(10,2));" });
  const r = runModernize({ root, recipe: "oracle-pg", apply: true });
  const out = readFileSync(join(root, "mapper/a.xml"), "utf8");
  assert.match(out, /COALESCE\(A\.NM, '-'\) NM, LOCALTIMESTAMP, nextval\('emp_seq'\)/);
  assert.doesNotMatch(out, /DUAL/);
  assert.match(readFileSync(join(root, "src/Q.java"), "utf8"), /"SELECT COALESCE\(X,0\) FROM T";\nint NVL\(int a\)/);
  assert.match(readFileSync(join(root, "ddl/t.sql"), "utf8"), /VARCHAR\(50 BYTE\), AMT NUMERIC\(10,2\)/);
  assert.deepEqual(r.findings.filter((f) => f.kind === "manual").map((f) => f.rule).sort(), ["PG-101", "PG-103"]);
  assert.match(renderModernizeMarkdown(r), /## 수동 항목 \(2\)/);
});

test("EUC-KR 파일 — 한글 없는 줄만 고치고 바이트는 그대로", () => {
  const han = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글"(EUC-KR)
  const body = Buffer.concat([Buffer.from("<!-- "), han, Buffer.from(" -->\nSELECT NVL(A,0) FROM T\nSELECT NVL(B,0) "), han, Buffer.from(" FROM T\n")]);
  const root = repo({ "mapper/k.xml": body });
  const r = runModernize({ root, recipe: "oracle-pg", apply: true });
  const out = readFileSync(join(root, "mapper/k.xml"));
  const want = Buffer.concat([Buffer.from("<!-- "), han, Buffer.from(" -->\nSELECT COALESCE(A,0) FROM T\nSELECT NVL(B,0) "), han, Buffer.from(" FROM T\n")]);
  assert.ok(out.equals(want), out.toString("latin1"));
  assert.equal(r.nonUtf8.length, 1);
  assert.deepEqual(r.findings.map((f) => f.kind), ["auto", "manual"]);
});

test("커밋하지 않은 변경이 있으면 고치지 않고 STOP, 검증 실패도 STOP", () => {
  const root = repo({ "src/A.java": JAVA });
  writeFileSync(join(root, "src/A.java"), JAVA + NL + "// 손으로 고치는 중");
  const r = runModernize({ root, recipe: "jakarta", apply: true });
  assert.equal(r.verdict, "STOP");
  assert.deepEqual(r.blocked, ["src/A.java"]);
  assert.match(readFileSync(join(root, "src/A.java"), "utf8"), /javax\.servlet/);
  const forced = runModernize({ root, recipe: "jakarta", apply: true, force: true, verify: "node -e \"process.exit(1)\"" });
  assert.equal(forced.applied, 1);
  assert.equal(forced.verdict, "STOP");
  assert.equal(forced.exitCode, 4);
  const ok = runModernize({ root, recipe: "jakarta", apply: true, force: true, verify: "node -e \"process.exit(0)\"" });
  assert.equal(ok.verdict, "GO");
});

test("알 수 없는 레시피", () => {
  assert.throws(() => runModernize({ root: tmpdir(), recipe: "cobol" }), /알 수 없는 레시피/);
});

test("DECODE·NVL2·INSTR — 한 줄에서 닫히는 호출은 CASE·strpos 로, NULL·컬럼 비교는 뜻을 지켜서", () => {
  const conv = rewriteOracleCalls;
  assert.equal(conv("SELECT DECODE(A.GB, '1', '사용', '2', '중지', '기타') FROM T"), "SELECT CASE A.GB WHEN '1' THEN '사용' WHEN '2' THEN '중지' ELSE '기타' END FROM T");
  assert.equal(conv("DECODE(GB, NULL, 'N', 'Y')"), "CASE WHEN GB IS NULL THEN 'N' ELSE 'Y' END");
  assert.equal(conv("DECODE(GB, #{gb}, 1, 0)"), "CASE WHEN GB IS NOT DISTINCT FROM #{gb} THEN 1 ELSE 0 END");
  // 바깥 식이 복잡하면(여러 번 계산) 그대로
  assert.equal(conv("DECODE(SUBSTR(A,1,2), B.X, 1, 0)"), "DECODE(SUBSTR(A,1,2), B.X, 1, 0)");
  // 안쪽부터 — 중첩 DECODE·쉼표·괄호가 든 문자열
  assert.equal(conv("DECODE(A, 1, DECODE(B, 'x,(y)', 'p', 'q'), 'it''s')"), "CASE A WHEN 1 THEN CASE B WHEN 'x,(y)' THEN 'p' ELSE 'q' END ELSE 'it''s' END");
  assert.equal(conv("NVL2(A.END_DT, 'Y', 'N')"), "CASE WHEN A.END_DT IS NOT NULL THEN 'Y' ELSE 'N' END");
  assert.equal(conv("INSTR(A.NM, '-') > 0 AND INSTR(A.NM, '-', 1, 2) > 0"), "strpos(A.NM, '-') > 0 AND INSTR(A.NM, '-', 1, 2) > 0");
  // 줄에서 닫히지 않으면 그대로
  assert.equal(conv("SELECT DECODE(A,"), "SELECT DECODE(A,");
  // 문자열 안의 DECODE 는 함수가 아님
  assert.equal(conv("SELECT 'DECODE(A,1,2)' FROM T"), "SELECT 'DECODE(A,1,2)' FROM T");
});

test("oracle-pg — 한 줄 DECODE 는 자동, 여러 줄·남은 것은 수동, 자바 문자열 이음은 건드리지 않음", () => {
  const mapper = ["<select id=\"b\">", "  SELECT DECODE(USE_YN, 'Y', '사용', '미사용') A, DECODE(X,", "    1, 'a', 'b') B", "  FROM T", "</select>"].join(NL);
  const java = ['String q = "SELECT DECODE(GB, \'1\', \'A\', \'B\') FROM T";', 'String w = "SELECT DECODE(GB, " + v + ", 1, 0) FROM T";'].join(NL);
  const root = repo({ "mapper/b.xml": mapper, "src/W.java": java });
  const r = runModernize({ root, recipe: "oracle-pg", apply: true });
  assert.match(readFileSync(join(root, "mapper/b.xml"), "utf8"), /SELECT CASE USE_YN WHEN 'Y' THEN '사용' ELSE '미사용' END A, DECODE\(X,/);
  const j = readFileSync(join(root, "src/W.java"), "utf8");
  assert.match(j, /"SELECT CASE GB WHEN '1' THEN 'A' ELSE 'B' END FROM T"/);
  assert.match(j, /DECODE\(GB, " \+ v/);
  const manual = r.findings.filter((f) => f.kind === "manual" && f.rule === "PG-102").map((f) => `${f.file}:${f.line}`);
  assert.deepEqual(manual.sort(), ["mapper/b.xml:2", "src/W.java:2"]);
});

test("boot3 — Boot 버전·javax 좌표·설정 키·방언은 자동, 보안 설정은 수동", () => {
  const pom = [
    "<project>",
    "  <parent>",
    "    <groupId>org.springframework.boot</groupId>",
    "    <artifactId>spring-boot-starter-parent</artifactId>",
    "    <version>2.7.18</version>",
    "  </parent>",
    "  <dependencies>",
    "    <dependency>",
    "      <groupId>javax.servlet</groupId>",
    "      <artifactId>javax.servlet-api</artifactId>",
    "      <version>4.0.1</version>",
    "    </dependency>",
    "    <dependency>",
    "      <groupId>javax.cache</groupId>",
    "      <artifactId>cache-api</artifactId>",
    "    </dependency>",
    "  </dependencies>",
    "</project>",
  ].join(NL);
  const gradle = ["plugins {", "  id 'org.springframework.boot' version '2.7.18'", "  id 'io.spring.dependency-management' version '1.0.15.RELEASE'", "}", "dependencies { compileOnly 'javax.servlet:javax.servlet-api:4.0.1' }"].join(NL);
  const props = ["spring.redis.host=localhost", "server.max-http-header-size=16KB", "management.metrics.export.prometheus.enabled=true", "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.Oracle12cDialect"].join(NL);
  const sec = "class S extends WebSecurityConfigurerAdapter { void c(H h) { h.authorizeRequests().antMatchers(\"/a\").permitAll(); } }";
  const root = repo({ "pom.xml": pom, "build.gradle": gradle, "src/main/resources/application.properties": props, "src/S.java": sec });
  const r = runModernize({ root, recipe: "boot3", apply: true, boot: "3.5.0" });
  const p = readFileSync(join(root, "pom.xml"), "utf8");
  assert.match(p, /spring-boot-starter-parent<\/artifactId>\n {4}<version>3\.5\.0<\/version>/);
  assert.match(p, /<groupId>jakarta\.servlet<\/groupId>\n\s+<artifactId>jakarta\.servlet-api<\/artifactId>\n\s+<version>6\.0\.0<\/version>/);
  assert.match(p, /javax\.cache/); // 표에 없는 javax(JSR-107)는 그대로
  const g = readFileSync(join(root, "build.gradle"), "utf8");
  assert.match(g, /'org\.springframework\.boot' version '3\.5\.0'/);
  assert.match(g, /'io\.spring\.dependency-management' version '1\.1\.7'/);
  assert.match(g, /'jakarta\.servlet:jakarta\.servlet-api:6\.0\.0'/);
  const pr = readFileSync(join(root, "src/main/resources/application.properties"), "utf8");
  assert.match(pr, /^spring\.data\.redis\.host=localhost\nserver\.max-http-request-header-size=16KB\nmanagement\.prometheus\.metrics\.export\.enabled=true\n.*dialect\.OracleDialect$/);
  const manual = [...new Set(r.findings.filter((f) => f.kind === "manual").map((f) => f.rule))].sort();
  assert.deepEqual(manual, ["BT-005", "BT-006"]);
  assert.equal(r.verdict, "HOLD");
  assert.match(renderModernizeMarkdown(r), /boot3/);
});

test("AI 초안 대상 — 매퍼는 감싸는 요소째, SQL 파일은 ; 사이, 같은 문장은 하나로", () => {
  const mapper = ["<mapper>", "<select id=\"page\">", "  SELECT * FROM (", "    SELECT A.*, ROWNUM RN FROM T A WHERE ROWNUM <= #{end}", "  ) WHERE RN > #{start}", "</select>", "<select id=\"j\">", "  SELECT * FROM A, B WHERE A.ID = B.ID(+)", "</select>", "</mapper>"].join(NL);
  const sql = ["SELECT 1 FROM T;", "MERGE INTO T USING S", "  ON (T.ID = S.ID)", "  WHEN MATCHED THEN UPDATE SET T.V = S.V;", "SELECT 2 FROM T;"].join(NL);
  const root = repo({ "mapper/p.xml": mapper, "sql/m.sql": sql });
  const r = runModernize({ root, recipe: "oracle-pg" });
  const { targets } = collectDraftTargets(r);
  const byId = Object.fromEntries(targets.map((t) => [t.id ?? t.file, t]));
  assert.deepEqual([byId["page"]?.start, byId["page"]?.end], [2, 6]);
  assert.deepEqual(byId["page"]?.rules, ["PG-101"]);
  assert.deepEqual([byId["j"]?.start, byId["j"]?.end], [7, 9]);
  assert.deepEqual([byId["sql/m.sql"]?.start, byId["sql/m.sql"]?.end], [2, 4]);
  assert.match(draftPrompt(/** @type {any} */ (byId["page"])), /MyBatis 매퍼 XML `mapper\/p\.xml` 2~6행 \(id=page\)/);
  const parsed = parseDraft("```xml\n<select id=\"page\">\n  SELECT * FROM T LIMIT 10\n</select>\n```\n확인: ORDER BY 없이 자르던 쿼리\n- 확인: #{start} 는 0부터");
  assert.match(String(parsed.code), /LIMIT 10/);
  assert.deepEqual(parsed.notes, ["ORDER BY 없이 자르던 쿼리", "#{start} 는 0부터"]);
  assert.equal(collectDraftTargets(r, { limit: 1 }).skipped, 2);
});
