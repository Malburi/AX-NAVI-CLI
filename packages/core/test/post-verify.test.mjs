/*
 * 고친 뒤 검증 — SELECT 순서를 바꾸고 위치로 읽는 화면을 다 고치지 않았으면 런타임이 HOLD 로 알린다.
 * 실측(실제 레거시 벤치 R2): v1 은 컬럼을 빼고 JSP 하나만 고친 채 GO 로 보고했다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../../indexer/index.mjs";
import { auditTurn, takeSnapshot } from "../../cli/src/turn-audit.mjs";
import { changedSelects, describePostVerify, postVerify, selectStatements } from "../../cli/src/post-verify.mjs";

/** @param {string} dir @param {string[]} args */
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
/** @param {string} root @param {string} rel @param {string} text */
function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}
const QUERY = (cols) => `<queries><query><id>CATEGORY_PARENT_TREE_S01</id><value>SELECT ${cols} FROM TB_CATEGORY WHERE NO = ?</value></query></queries>`;
const SCREEN = (a, b) => `function openTree() {
  $.ajax({ url: CONTEXT_PATH + "/TransData.do", data: "worker=CategoryService&action=listParentTree&no=" + k, success: onResult });
}
function onResult(request) { var data = transData(request); $('#a').val(data.rtInfo[1][${a}]); $('#b').val(data.rtInfo[1][${b}]); }`;

function pair() {
  const server = mkdtempSync(join(tmpdir(), "ax-pv-server-"));
  const client = mkdtempSync(join(tmpdir(), "ax-pv-client-"));
  write(server, "WEB-INF/config/app.xml", `<beans><bean id="CategoryService" class="acme.CategoryService"/></beans>`);
  write(server, "src/acme/CategoryService.java", `package acme;
public class CategoryService {
  public DataSet doListParentTree(Parameter p) throws SQLException {
    ResultTable rtInfo = (ResultTable) dao.query("CATEGORY_PARENT_TREE_S01", p.getString("no"));
    dataSet.set("rtInfo", rtInfo);
    return dataSet;
  }
}`);
  write(server, "WEB-INF/config/query/q.xml", QUERY("PARENT_NO, PATH, NO"));
  write(client, "js/a.js", SCREEN(2, 1));
  write(client, "js/b.js", SCREEN(2, 1).replace("openTree", "openTreeB"));
  write(server, "_workspace/pair_config.md", `project_type: backend\npartner_root: ${client}\n`);
  write(client, "_workspace/pair_config.md", `project_type: frontend\npartner_root: ${server}\n`);
  for (const dir of [server, client]) { git(dir, "init", "-q"); git(dir, "add", "."); git(dir, "commit", "-qm", "init"); }
  buildIndex({ root: client, mode: "init", tier: "Standard" });
  buildIndex({ root: server, mode: "init", tier: "Standard" });
  return { server, client, roots: [{ root: server, primary: true }, { root: client }] };
}

test("SELECT 문의 컬럼 순서를 파일에서 읽는다", () => {
  assert.deepEqual(selectStatements(QUERY("PARENT_NO, PATH, NO")).get("CATEGORY_PARENT_TREE_S01"), ["PARENT_NO", "PATH", "NO"]);
});

test("컬럼을 빼고 화면을 하나만 고쳤으면 고치지 않은 화면을 남은 곳으로 알린다(HOLD)", () => {
  const { server, client, roots } = pair();
  const snap = takeSnapshot([server, client]);
  write(server, "WEB-INF/config/query/q.xml", QUERY("PATH, NO"));
  write(client, "js/a.js", SCREEN(1, 0)); // 한 화면만 고쳤다
  const audit = auditTurn(snap, [server, client], { files: new Set(), shellUnknown: true });
  const changes = [...audit.approved, ...audit.viaShell, ...audit.unapproved];
  assert.equal(changedSelects(snap, changes)[0]?.from, 0);
  const pv = postVerify(snap, changes, roots);
  assert.equal(pv.verdict, "hold", JSON.stringify(pv.results));
  assert.equal(pv.results[0]?.unhandled.map((u) => u.file).join(","), "js/b.js");
  assert.match(describePostVerify(pv, server).join("\n"), /런타임 판정: HOLD/);
});

test("위치로 읽는 화면을 모두 함께 고쳤으면 통과다", () => {
  const { server, client, roots } = pair();
  const snap = takeSnapshot([server, client]);
  write(server, "WEB-INF/config/query/q.xml", QUERY("PATH, NO"));
  write(client, "js/a.js", SCREEN(1, 0));
  write(client, "js/b.js", SCREEN(1, 0).replace("openTree", "openTreeB"));
  const audit = auditTurn(snap, [server, client], { files: new Set(), shellUnknown: true });
  const pv = postVerify(snap, [...audit.approved, ...audit.viaShell, ...audit.unapproved], roots);
  assert.equal(pv.verdict, "ok", JSON.stringify(pv.results));
});

test("SELECT 순서를 바꾸지 않은 변경은 검증 대상이 아니다", () => {
  const { server, client, roots } = pair();
  const snap = takeSnapshot([server, client]);
  write(server, "WEB-INF/config/query/q.xml", QUERY("PARENT_NO, PATH, NO").replace("WHERE NO = ?", "WHERE NO = ? AND USE_YN = 'Y'"));
  const audit = auditTurn(snap, [server, client], { files: new Set(), shellUnknown: true });
  assert.equal(postVerify(snap, [...audit.approved, ...audit.viaShell, ...audit.unapproved], roots).verdict, "none");
});
