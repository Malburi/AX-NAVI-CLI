/*
 * v2 경량 실행 경로 — 인덱스 신선도는 런타임이, 영향도는 인덱스가 먼저, 지시문은 작게.
 * v1 비교 실험(108회)에서 한 저장소 질문이 평범한 Claude Code 의 3~28배였던 원인을 하나씩 막는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../../indexer/index.mjs";
import { ensureFreshIndexes } from "../../cli/src/freshness.mjs";
import { candidateTokens, formatImpact, precomputeImpact } from "../../cli/src/precompute.mjs";
import { agentInstruction, inlineInstruction, orchestratorInstruction } from "../../cli/src/skill-prompt.mjs";

/** @param {string} dir @param {string[]} args */
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
/** @param {string} root @param {string} rel @param {string} text */
function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function pair() {
  const server = mkdtempSync(join(tmpdir(), "ax-lean-server-"));
  const client = mkdtempSync(join(tmpdir(), "ax-lean-client-"));
  write(server, "WEB-INF/config/app.xml", `<beans><bean id="CategoryService" class="acme.CategoryService"/></beans>`);
  write(server, "src/acme/CategoryService.java", `package acme;
public class CategoryService {
  public DataSet doListParentTree(Parameter p) throws SQLException {
    ResultTable rtInfo = (ResultTable) dao.query("CATEGORY_PARENT_TREE_S01", p.getString("no"));
    dataSet.set("rtInfo", rtInfo);
    return dataSet;
  }
}`);
  write(server, "WEB-INF/config/query/q.xml", `<queries><query><id>CATEGORY_PARENT_TREE_S01</id><value>SELECT PARENT_NO, PATH, NO FROM TB_CATEGORY WHERE NO = ?</value></query></queries>`);
  write(client, "js/tree.js", `function openTree() {
  $.ajax({ url: CONTEXT_PATH + "/TransData.do", data: "worker=CategoryService&action=listParentTree&no=" + k, success: onResult });
}
function onResult(request) { var data = transData(request); $('#a').val(data.rtInfo[1][2]); $('#b').val(data.rtInfo[1][1]); }`);
  write(server, "_workspace/pair_config.md", `project_type: backend\npartner_root: ${client}\n`);
  write(client, "_workspace/pair_config.md", `project_type: frontend\npartner_root: ${server}\n`);
  for (const dir of [server, client]) { git(dir, "init", "-q"); git(dir, "add", "."); git(dir, "commit", "-qm", "init"); }
  buildIndex({ root: client, mode: "init", tier: "Standard" });
  buildIndex({ root: server, mode: "init", tier: "Standard" });
  return { server, client };
}

test("런타임이 인덱스 신선도를 맞춘다 — 짝 저장소가 바뀌면 짝을 먼저, 기준 저장소도 다시 만든다", () => {
  const { server, client } = pair();
  const fresh = ensureFreshIndexes([{ root: server, primary: true }, { root: client }]);
  assert.deepEqual(fresh.map((n) => n.state), ["fresh", "fresh"]);
  write(client, "js/tree2.js", `function other() { $.ajax({ url: "/TransData.do", data: "worker=CategoryService&action=listParentTree", success: function (d) { x(d.rtInfo[1][0]); } }); }`);
  /** @type {string[]} */
  const order = [];
  const notes = ensureFreshIndexes([{ root: server, primary: true }, { root: client }], { onStart: (r) => order.push(r) });
  assert.deepEqual(order, [client, server], "짝 저장소 먼저, 기준 저장소는 연결을 다시 만들려고 뒤에");
  assert.ok(notes.every((n) => n.state === "rebuilt"), JSON.stringify(notes));
  const block = precomputeImpact(server, "CATEGORY_PARENT_TREE_S01 에서 PARENT_NO 를 빼면?");
  assert.match(block ?? "", /화면 호출 2곳/, "다시 만든 인덱스를 읽어야 한다(캐시를 비운다)");
});

test("AXNAVI_NO_AUTO_INDEX=1 이면 손대지 않는다 · 인덱스가 없는 저장소는 만들지 않는다", () => {
  const empty = mkdtempSync(join(tmpdir(), "ax-lean-empty-"));
  assert.equal(ensureFreshIndexes([{ root: empty, primary: true }])[0]?.state, "skipped");
  assert.equal(ensureFreshIndexes([{ root: empty, primary: true }], { env: { AXNAVI_NO_AUTO_INDEX: "1" } })[0]?.reason, "AXNAVI_NO_AUTO_INDEX=1");
});

test("사전 영향도 — 요청의 SQL id · 컬럼을 인덱스에서 찾아 화면까지 계산한다", () => {
  const { server } = pair();
  const block = precomputeImpact(server, "CATEGORY_PARENT_TREE_S01 의 첫 컬럼 PARENT_NO 를 SELECT 에서 빼면 어디가 영향받아?") ?? "";
  assert.match(block, /컬럼 PARENT_NO\(0번째\)/);
  assert.match(block, /컬럼을 빼면 깨지는 곳 1/);
  assert.match(block, /\[깨짐\].*tree\.js/);
  const byMethod = precomputeImpact(server, "CategoryService.doListParentTree 결과의 PARENT_NO 컬럼은 안 쓰니 빼줘") ?? "";
  assert.match(byMethod, /컬럼을 빼면 깨지는 곳 1/, "메서드로 물어도 그 메서드의 SQL 컬럼으로 계산한다");
  assert.equal(precomputeImpact(server, "로그인 화면이 어디야?"), null, "대상이 없으면 아무것도 넣지 않는다");
});

test("대상 후보는 보수적으로 뽑는다", () => {
  const t = candidateTokens("CourseSessionService.doListCourseIdParentTree 의 HGRK_CRS_CL_NO 컬럼 · COURSESESSIONSERVICE_CRS_ID_PARENT_TREE_LIST_S01");
  assert.ok(t.sqlLike.includes("COURSESESSIONSERVICE_CRS_ID_PARENT_TREE_LIST_S01"));
  assert.ok(t.idLike.some((x) => x.endsWith("doListCourseIdParentTree")));
  assert.ok(t.upper.includes("HGRK_CRS_CL_NO"));
  assert.ok(formatImpact({ query: { sql: "X", id: null }, summary: { repos: ["a"], methods: 0, code_callers: 0, screen_call_sites: 0, screen_files: 0, breaks_if_column_removed: null, reads_by_position: 0 }, sql: [], methods: [], code_callers: { items: [] }, screen_callers: { items: [], total: 0, truncated: 0 }, notes: [] }).startsWith("<사전 영향도"));
});

test("지시문 예산 — 우리 텍스트(스킬 본문 · 사전 영향도 제외)가 v1 보다 작다", () => {
  const roots = [{ name: "a", paths: { root: "/a" } }, { name: "b", paths: { root: "/b" } }];
  const empty = { name: "x", body: "" };
  const agent = agentInstruction({ skill: empty, agentName: "logic-tracer", prompt: "", projectRoot: "/a", roots, precomputed: null, reportOn: false });
  const orch = orchestratorInstruction({ skill: empty, prompt: "", projectRoot: "/a", roots, precomputed: null, reportOn: false });
  const inline = inlineInstruction({ skill: empty, agentBody: "", request: "", precomputed: null, reportOn: false });
  /* v1 실측: 단일 에이전트 래퍼 약 1.4K자(다중 저장소 위임 지시 포함 시 더), 오케스트레이터 약 2.1K자. */
  assert.ok(agent.length <= 1500, `단일 에이전트 래퍼 ${agent.length}자`);
  assert.ok(orch.length <= 2000, `오케스트레이터 래퍼 ${orch.length}자`);
  assert.ok(inline.length <= 800, `세션 안 스킬 래퍼 ${inline.length}자`);
  assert.doesNotMatch(agent, /서브에이전트를.*하나씩/, "저장소마다 띄우라는 지시가 남아 있다");
  assert.match(agent, /서브에이전트를 띄우지 마라/);
});
