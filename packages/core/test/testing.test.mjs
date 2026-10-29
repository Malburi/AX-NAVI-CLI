/*
 * 테스트 계획(PMS-X 명세 → 계획 → 골격 → 진행 상태)과 커버리지(JaCoCo·lcov, 바뀐 줄).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJacoco, parseLcov, planFromSpec, planPath, readJunit, renderCoverageMarkdown, renderPlanMarkdown, runCoverage, savePlan, scaffold, updateStatus } from "../src/index.mjs";

const NL = String.fromCharCode(10);
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "ignore" });

const SPEC = {
  schema: "pmsx.spec/v1",
  kind: "SR",
  no: "SR-0012",
  title: "입사일 검증",
  sources: [{ file: "src/main/java/kr/hr/emp/EmpService.java", lane: "SERVER" }],
  tests: [
    { id: "TC01", title: "접수 내용 재현 후 수정 확인", steps: ["입사일에 내일 날짜 입력", "저장"], expected: ["저장되지 않고 안내 문구"], basis: "요구사항" },
    { id: "TC02", title: "`TB_EMP` 기존 데이터 영향", steps: ["기존 사원 조회"], expected: ["값이 바뀌지 않음"], basis: "영향 테이블" },
  ],
};

test("명세 → 계획 → 골격(JUnit 5) — 다시 만들면 없는 케이스만 덧붙인다", () => {
  const root = mkdtempSync(join(tmpdir(), "axtest-"));
  const plan = planFromSpec(SPEC);
  assert.equal(plan.framework, "junit5");
  assert.equal(plan.packageName, "kr.hr.emp");
  assert.equal(plan.className, "SR_0012Test");
  const f = planPath(join(root, "_workspace"), plan.sr);
  savePlan(f, plan);
  const r = scaffold(root, plan);
  assert.equal(r.file, "src/test/java/kr/hr/emp/SR_0012Test.java");
  assert.deepEqual(r.added, ["TC01", "TC02"]);
  const src = readFileSync(join(root, r.file), "utf8");
  assert.match(src, /^package kr\.hr\.emp;/);
  assert.match(src, /@DisplayName\("TC01 접수 내용 재현 후 수정 확인"\)\n    @Disabled\("작성 필요 — TC01"\)\n    void tc01\(\)/);
  assert.match(src, /then  - 저장되지 않고 안내 문구/);
  // 사람이 TC01 을 채운 뒤 명세에 TC03 이 생김 → TC03 만 덧붙고 TC01 본문은 그대로
  writeFileSync(join(root, r.file), src.replace('    @Disabled("작성 필요 — TC01")\n', "").replace("// then  - 저장되지 않고 안내 문구", "assertThrows(IllegalArgumentException.class, () -> svc.save(emp));"));
  const plan2 = planFromSpec({ ...SPEC, tests: [...SPEC.tests, { id: "TC03", title: "회귀: SR-0007", steps: [], expected: [], basis: "유사 SR" }] });
  savePlan(f, plan2);
  const again = scaffold(root, plan2);
  assert.deepEqual(again.added, ["TC03"]);
  const src2 = readFileSync(join(root, r.file), "utf8");
  assert.match(src2, /assertThrows\(IllegalArgumentException/);
  assert.equal((src2.match(/void tc01\(\)/g) ?? []).length, 1);
  assert.match(src2, /void tc03\(\)[\s\S]*\}\n\}\n$/);
});

test("진행 상태 — JUnit XML(surefire)로 통과·실패·작성 필요, 계획에 이어 기록", () => {
  const root = mkdtempSync(join(tmpdir(), "axtest-"));
  const plan = planFromSpec(SPEC);
  const f = planPath(join(root, "_workspace"), plan.sr);
  savePlan(f, plan);
  mkdirSync(join(root, "target/surefire-reports"), { recursive: true });
  writeFileSync(
    join(root, "target/surefire-reports/TEST-kr.hr.emp.SR_0012Test.xml"),
    `<testsuite><testcase name="TC01 접수 내용 재현 후 수정 확인" classname="kr.hr.emp.SR_0012Test"/><testcase name="TC02 \`TB_EMP\` 기존 데이터 영향" classname="kr.hr.emp.SR_0012Test"><skipped message="작성 필요 — TC02"/></testcase></testsuite>`,
  );
  const r = updateStatus(root, plan);
  assert.deepEqual(r.plan.cases.map((c) => c.status), ["passing", "skipped"]);
  assert.equal(r.verdict, "HOLD");
  savePlan(f, r.plan);
  // 다음에 TC02 가 실패로 바뀌면 STOP
  writeFileSync(join(root, "target/surefire-reports/TEST-kr.hr.emp.SR_0012Test.xml"), `<testsuite><testcase name="TC01 x" classname="kr.hr.emp.SR_0012Test"/><testcase name="TC02 y" classname="kr.hr.emp.SR_0012Test"><failure message="expected 1 but was 2"/></testcase></testsuite>`);
  const saved = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(saved.cases[1].status, "skipped");
  const r2 = updateStatus(root, saved);
  assert.equal(r2.verdict, "STOP");
  assert.match(renderPlanMarkdown(r2), /TC02 .*🔴 실패 — expected 1 but was 2/);
  assert.equal(readJunit([join(root, "target/surefire-reports")]).length, 2);
});

test("Vitest 골격 — 프런트 소스만 있으면 it.todo", () => {
  const root = mkdtempSync(join(tmpdir(), "axtest-"));
  const plan = planFromSpec({ ...SPEC, sources: [{ file: "web/src/pages/Emp.vue" }] });
  assert.equal(plan.framework, "vitest");
  const r = scaffold(root, plan);
  assert.match(readFileSync(join(root, r.file), "utf8"), /it\.todo\("TC01 접수 내용 재현 후 수정 확인"\);/);
  assert.throws(() => planFromSpec({ schema: "x" }), /pmsx\.spec\/v1/);
});

test("커버리지 — JaCoCo·lcov 해석", () => {
  const j = parseJacoco(`<report><package name="kr/hr"><sourcefile name="A.java"><line nr="3" mi="0" ci="2" mb="0" cb="0"/><line nr="4" mi="3" ci="0" mb="0" cb="0"/></sourcefile></package></report>`);
  assert.deepEqual([...j.get("kr/hr/A.java").entries()], [[3, true], [4, false]]);
  const l = parseLcov(`SF:/repo/web/a.ts${NL}DA:1,1${NL}DA:2,0${NL}end_of_record`, "/repo");
  assert.deepEqual([...l.get("web/a.ts").entries()], [[1, true], [2, false]]);
});

test("커버리지 — 바뀐 줄만 따로 재고 기준 미달이면 HOLD", () => {
  const root = mkdtempSync(join(tmpdir(), "axcov-"));
  mkdirSync(join(root, "src/main/java/kr/hr"), { recursive: true });
  const base = ["package kr.hr;", "class A {", "  int a() { return 1; }", "}"].join(NL);
  writeFileSync(join(root, "src/main/java/kr/hr/A.java"), base);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "src/main/java/kr/hr/A.java"), ["package kr.hr;", "class A {", "  int a() { return 1; }", "  int b(int x) {", "    if (x > 0) return 1;", "    return 2;", "  }", "}"].join(NL));
  mkdirSync(join(root, "target/site/jacoco"), { recursive: true });
  // 3 줄(기존)은 덮임, 새 줄 5 덮임·6 안 덮임
  writeFileSync(join(root, "target/site/jacoco/jacoco.xml"), `<report><package name="kr/hr"><sourcefile name="A.java"><line nr="3" mi="0" ci="2"/><line nr="5" mi="0" ci="3"/><line nr="6" mi="2" ci="0"/></sourcefile></package></report>`);
  const r = runCoverage({ root, diff: {}, min: 80 });
  assert.equal(r.total.lines, 3);
  assert.deepEqual({ lines: r.diff?.lines, covered: r.diff?.covered }, { lines: 2, covered: 1 });
  assert.deepEqual(r.diff?.files[0]?.uncovered, [6]);
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.exitCode, 3);
  assert.match(renderCoverageMarkdown(r), /바뀐 줄\(HEAD 대비 작업 트리\): \*\*50%\*\*[\s\S]*줄 6/);
  assert.equal(runCoverage({ root, diff: {}, min: 50 }).verdict, "GO");
  assert.throws(() => runCoverage({ root: mkdtempSync(join(tmpdir(), "axnone-")) }), /보고서를 찾지 못했습니다/);
});
