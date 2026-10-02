/*
 * 턴 뒤 감사 — 승인 없이 바뀐 소스 파일을 찾고, 셸로 고쳐 UTF-8 이 된 EUC-KR 파일을 되돌린다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTurn, describeAudit, revertChanges, takeSnapshot } from "../../cli/src/turn-audit.mjs";
import { encodeLegacy } from "../../provider-claude-cli/src/legacy-encoding.mjs";

/** @param {string} dir @param {string[]} args */
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "axnavi-audit-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "_workspace"), { recursive: true });
  writeFileSync(join(root, "src", "A.java"), "class A {}\n");
  writeFileSync(join(root, "src", "B.java"), "class B {}\n");
  const xml = '<?xml version="1.0" encoding="EUC-KR"?>\n<sql id="q">SELECT 과정명, HGRK_CRS_CL_NO FROM T -- 상위과정</sql>\n';
  const enc = encodeLegacy(xml, "euc-kr");
  assert.ok(enc.ok);
  writeFileSync(join(root, "src", "query.xml"), /** @type {any} */ (enc).bytes);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

test("승인 없이 바뀐 소스 파일만 골라낸다 — 승인된 수정 · 산출물은 빼고", () => {
  const root = repo();
  writeFileSync(join(root, "src", "B.java"), "class B { int dirty; }\n"); // 턴 전부터 더러움
  const snap = takeSnapshot([root]);
  writeFileSync(join(root, "src", "A.java"), "class A { int x; }\n");
  writeFileSync(join(root, "src", "B.java"), "class B { int dirty; int y; }\n");
  writeFileSync(join(root, "src", "C.java"), "class C {}\n");
  writeFileSync(join(root, "_workspace", "report.md"), "x");
  const approved = { files: new Set([join(root, "src", "A.java").toLowerCase()]), shellUnknown: false };
  const audit = auditTurn(snap, [root], approved);
  assert.deepEqual(audit.approved.map((c) => c.rel), ["src/A.java"]);
  assert.deepEqual(audit.unapproved.map((c) => `${c.rel}:${c.kind}`).sort(), ["src/B.java:modified", "src/C.java:added"]);
  assert.match(describeAudit(audit, root).join("\n"), /승인 없이 바뀐 소스 파일 2개/);
});

test("되돌리기는 턴 전 내용으로 — 턴 전부터 있던 사용자 변경은 지킨다", () => {
  const root = repo();
  writeFileSync(join(root, "src", "B.java"), "class B { int mine; }\n");
  const snap = takeSnapshot([root]);
  writeFileSync(join(root, "src", "B.java"), "class B { int mine; int model; }\n");
  writeFileSync(join(root, "src", "A.java"), "class A { broken }\n");
  writeFileSync(join(root, "src", "New.java"), "x");
  const audit = auditTurn(snap, [root], { files: new Set(), shellUnknown: false });
  const { reverted, failed } = revertChanges(snap, audit.unapproved);
  assert.equal(failed.length, 0);
  assert.equal(reverted.length, 3);
  assert.equal(readFileSync(join(root, "src", "B.java"), "utf8"), "class B { int mine; }\n");
  assert.equal(readFileSync(join(root, "src", "A.java"), "utf8"), "class A {}\n");
  assert.equal(existsSync(join(root, "src", "New.java")), false);
});

test("셸로 고쳐 UTF-8 이 된 EUC-KR 파일을 손실 없이 원래 인코딩으로 되돌린다", () => {
  const root = repo();
  const snap = takeSnapshot([root]);
  /* python 이 utf-8 로 다시 쓴 모양 — 내용 수정 + 인코딩 변환 */
  writeFileSync(join(root, "src", "query.xml"), '<?xml version="1.0" encoding="EUC-KR"?>\n<sql id="q">SELECT 과정명 FROM T -- 상위과정</sql>\n', "utf8");
  const audit = auditTurn(snap, [root], { files: new Set(), shellUnknown: true });
  assert.equal(audit.encoding[0]?.result, "restored");
  assert.equal(audit.viaShell.length, 1, "승인된 셸 명령 뒤 바뀐 파일로 분류한다");
  const bytes = readFileSync(join(root, "src", "query.xml"));
  assert.equal(new TextDecoder("euc-kr").decode(bytes).includes("SELECT 과정명 FROM T"), true, "수정 내용은 살리고 인코딩만 되돌린다");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), "UTF-8 이 아니어야 한다");
});

test("이미 깨진 글자(U+FFFD)는 되돌리지 못한다고 알린다", () => {
  const root = repo();
  const snap = takeSnapshot([root]);
  writeFileSync(join(root, "src", "query.xml"), '<?xml version="1.0" encoding="EUC-KR"?>\n<sql id="q">SELECT �� FROM T</sql>\n', "utf8");
  const audit = auditTurn(snap, [root], { files: new Set(), shellUnknown: false });
  assert.equal(audit.encoding[0]?.result, "broken");
  assert.match(describeAudit(audit, root).join("\n"), /되돌리기를 권합니다/);
});

test("git 저장소가 아니면 감사하지 못한다고 밝힌다", () => {
  const plain = mkdtempSync(join(tmpdir(), "axnavi-nogit-"));
  const snap = takeSnapshot([plain]);
  assert.deepEqual(snap.skipped, [plain]);
});
