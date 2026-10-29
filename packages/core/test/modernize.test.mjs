/*
 * 현대화 레시피 — 자동/수동 구분, JDK javax 는 건드리지 않음, EUC-KR 바이트 보존, git 깨끗할 때만 고침, 검증 게이트.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderModernizeMarkdown, runModernize } from "../src/index.mjs";

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
