/*
 * 문자열 디스패치 · 결과 소비 · 다른 저장소 영향도.
 *
 * 픽스처는 실제 레거시(xu25)의 모양만 본떠 새로 쓴 것이다 — 사내 코드는 넣지 않는다.
 *   서버  jar 안 AjaxController(소스 없음) · XML 빈 · do+메서드 · <query><id><value> 컨테이너(EUC-KR)
 *   화면  $.ajax({ url: CONTEXT_PATH + "/TransData.do", data: "worker=…&action=…", success: onResult }) · rtInfo[1][2]
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../build-index.mjs";
import { COMMANDS } from "../query-index.mjs";
import { extractDispatchCalls, extractResultKeys, inferDispatchRules, positionalEffect, resolveCall, selectColumns } from "../index/dispatch.mjs";

function write(root, rel, content, encoding = "utf8") {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, encoding);
}

/* "상위분류 조회" 를 EUC-KR 로 — 한글 주석이 든 쿼리 파일이 EUC-KR 인 레거시 모양. */
const EUCKR_COMMENT = Buffer.from("bbf3c0a7bad0b7f920c1b6c8b8", "hex");

function serverRepo(root) {
  write(root, "WEB-INF/web.xml", `<web-app><servlet><servlet-name>ajax</servlet-name><servlet-class>acme.frame.servlet.AjaxController</servlet-class></servlet>
<servlet-mapping><servlet-name>ajax</servlet-name><url-pattern>/TransData.do</url-pattern></servlet-mapping></web-app>`);
  write(root, "WEB-INF/config/app-common.xml", `<beans>
  <bean id="CategoryService" class="acme.lms.service.CategoryService"/>
</beans>`);
  write(root, "WEB-INF/src/acme/lms/service/CategoryService.java", `package acme.lms.service;
public class CategoryService extends BaseService {
  public DataSet doListParentTree(Parameter param) throws SQLException {
    DataAccesser dataAccesser = createDataAccesser(param.getTransaction());
    DataSet dataSet = createDataSet();
    ResultTable rtInfo = (ResultTable) dataAccesser.query("CATEGORY_PARENT_TREE_S01", param.getString("no"));
    dataSet.set("rtInfo", rtInfo);
    return dataSet;
  }
  public DataSet doListChildren(Parameter param) throws SQLException {
    DataSet dataSet = createDataSet();
    dataSet.set("rtList", createDataAccesser(null).query("CATEGORY_CHILD_S01", "x"));
    return dataSet;
  }
  public void helperNobodyCalls() {}
}
`);
  const head = Buffer.from(`<?xml version="1.0" encoding="EUC-KR"?>
<queries>
  <query>
    <id>CATEGORY_PARENT_TREE_S01</id>
    <value>
      SELECT PARENT_NO, REPLACE(SYS_CONNECT_BY_PATH(CHR(47)||NAME, '+'),'+'), NO
      FROM TB_CATEGORY WHERE NO = ?
      START WITH PARENT_NO = 0 CONNECT BY PRIOR NO = PARENT_NO
    </value>
    <description>`, "latin1");
  const tail = Buffer.from(`</description>
  </query>
  <query><id>CATEGORY_CHILD_S01</id><value>SELECT NO, NAME AS CATEGORY_NAME FROM TB_CATEGORY WHERE PARENT_NO = ?</value></query>
</queries>
`, "latin1");
  write(root, "WEB-INF/config/query/query-common.xml", Buffer.concat([head, EUCKR_COMMENT, tail]), undefined);
  /* 서버 JSP 도 같은 디스패처를 부른다 */
  write(root, "WEB-INF/jsp/back/task/checkList.jsp", `<%@ page contentType="text/html; charset=UTF-8" %>
<script>
function onInitAjax() {
  $.ajax({ type: "POST", url: CONTEXT_PATH + "/TransData.do", dataType: "html",
    data: "worker=CategoryService&action=listParentTree&no=" + no, success: onResult });
}
function onResult(request) {
  var data = transData(request);
  $('#path').val(data.rtInfo[1][1]);
  $('#no').val(data.rtInfo[1][2]);
}
</script>`);
}

function clientRepo(root) {
  /* 업무 폴더 이름이 target 이다 — 빌드 결과물로 오인해 빼면 안 된다 */
  write(root, "html/script/js/back/demand/target/target_view.js", `
function openTree() {
  var url = CONTEXT_PATH + "/TransData.do";
  var pars = "worker=CategoryService&action=listParentTree&no=" + key;
  $.ajax({ type: "POST", url: url, data: pars, success: onResult });
}
function onResult(request) {
  var data = transData(request);
  var rt = data.rtInfo;
  if (rt.length > 1) { $('input[name=hl]').val(rt[1][2]); $('input[name=nm]').val(data.rtInfo[1][1]); }
}`);
  write(root, "html/script/js/back/common/tree_inline.js", `
$(function () {
  $.ajax({ url: CONTEXT_PATH + "/TransData.do", data: { worker: "CategoryService", action: "listParentTree" },
    success: function (data) { fill(data); } });
});
function fill(res) { var d = transData(res); $('#x').val(d.rtInfo[1][0]); }`);
  /* 다른 메서드를 부르는 화면 — 대상이 아니다 */
  write(root, "html/script/js/back/common/children.js", `
function loadChildren() { $.post(CONTEXT_PATH + "/TransData.do", "worker=CategoryService&action=listChildren", function (data) { show(data.rtList[0][1]); }); }`);
}

export async function test(register, assert) {
  register("SELECT 컬럼 순서를 별칭 · 식까지 뽑는다", () => {
    const cols = selectColumns("SELECT A.NO, NAME AS CATEGORY_NAME, REPLACE(SYS_CONNECT_BY_PATH(CHR(47)||NAME, '+'),'+'), COUNT(*) CNT FROM T A WHERE x IN (SELECT y FROM z)");
    assert.equal(cols.map((c) => c.name).join("|"), "NO|CATEGORY_NAME|REPLACE(SYS_CONNECT_BY_PATH(CHR(47)||NAME, '+'),'+')|CNT");
  });

  register("메서드가 쿼리 결과를 내보내는 이름을 잡는다 — 변수 경유 · 한 줄 형태", () => {
    const text = readFileSync(new URL(import.meta.url), "utf8"); // 아무 텍스트 — 아래에서 직접 만든다
    const body = `class C {
  public DataSet doA(Parameter p) { ResultTable rtInfo = (ResultTable) dao.query("A_S01", x); ds.set("rtInfo", rtInfo); return ds; }
  public DataSet doB(Parameter p) { ds.set("rtList", dao.query("B_S01", y)); return ds; }
}`;
    const methods = [
      { id: "C.doA", start: body.indexOf("public DataSet doA"), end: body.indexOf("public DataSet doB") },
      { id: "C.doB", start: body.indexOf("public DataSet doB"), end: body.length },
    ];
    const keys = extractResultKeys(body, methods);
    assert.equal(keys.map((k) => `${k.method}:${k.key}:${k.sql_id}`).join(","), "C.doA:rtInfo:A_S01,C.doB:rtList:B_S01");
    assert.ok(text.length > 0);
  });

  register("화면의 문자열 디스패치 호출 · 콜백 · 위치 읽기를 뽑는다 — 변수에 담은 주소 · 별칭 · 인라인 콜백 · 넘겨받은 함수", () => {
    const client = mkdtempSync(join(tmpdir(), "ax-dispatch-unit-"));
    try {
      clientRepo(client);
      const a = extractDispatchCalls(readFileSync(join(client, "html/script/js/back/demand/target/target_view.js"), "utf8"), "a.js");
      assert.equal(a.length, 1);
      assert.equal(a[0].endpoint, "/TransData.do");
      assert.equal(a[0].callback, "onResult");
      assert.equal(a[0].params.worker, "CategoryService");
      assert.equal(a[0].reads.map((r) => `${r.key}[${r.row}][${r.col}]`).sort().join(","), "rtInfo[1][1],rtInfo[1][2]", "별칭(rt = data.rtInfo)도 결과 이름으로 푼다");
      const b = extractDispatchCalls(readFileSync(join(client, "html/script/js/back/common/tree_inline.js"), "utf8"), "b.js");
      assert.equal(b[0]?.callback, "(inline)");
      assert.equal(b[0]?.reads[0]?.via, "fill", "콜백이 넘겨준 함수의 읽기도 잡는다");
      const c = extractDispatchCalls(readFileSync(join(client, "html/script/js/back/common/children.js"), "utf8"), "c.js");
      assert.equal(c[0]?.params.action, "listChildren");
      assert.equal(c[0]?.reads[0]?.key, "rtList", "$.post 의 세 번째 인자를 콜백으로 본다");
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  });

  register("규칙은 빈 이름과 실제 메서드가 맞을 때만 추론한다", () => {
    const calls = [{ file: "a.js", line: 1, function: null, endpoint: "/app/TransData.do", params: { worker: "CategoryService", action: "listParentTree", no: "x" }, callback: null, reads: [] }];
    const rules = inferDispatchRules(calls, (id) => (id === "CategoryService" ? "acme.CategoryService" : null), (cls, m) => cls === "acme.CategoryService" && m === "doListParentTree");
    assert.equal(rules.length, 1);
    assert.equal(`${rules[0].endpoint}|${rules[0].bean_param}|${rules[0].method_param}|${rules[0].method_template}`, "/TransData.do|worker|action|do{Action}");
    assert.equal(resolveCall(calls[0], rules)?.method, "doListParentTree");
    assert.equal(inferDispatchRules(calls, () => null, () => true).length, 0, "빈이 없으면 규칙이 아니다");
  });

  register("컬럼을 빼면 위치로 읽던 자리가 무엇을 읽게 되는지 계산한다", () => {
    const cols = [{ index: 0, name: "PARENT_NO" }, { index: 1, name: "PATH" }, { index: 2, name: "NO" }];
    const read = (col) => ({ key: "rtInfo", row: 1, col, name: null, line: 1, text: "" });
    assert.equal(positionalEffect(read(0), 0, cols).effect, "reads_removed");
    assert.equal(positionalEffect(read(1), 0, cols).after, "NO");
    assert.equal(positionalEffect(read(2), 0, cols).after, "(없음 — undefined)");
    assert.equal(positionalEffect(read(0), 1, cols).effect, "unaffected");
  });

  register("저장소 둘을 이어 디스패치 엣지를 달고, 죽은 코드에서 빼고, impact 가 화면까지 따라간다", () => {
    const server = mkdtempSync(join(tmpdir(), "ax-dispatch-server-"));
    const client = mkdtempSync(join(tmpdir(), "ax-dispatch-client-"));
    try {
      serverRepo(server);
      clientRepo(client);
      write(client, "_workspace/pair_config.md", `project_type: frontend\npartner_root: ${server}\n`);
      write(server, "_workspace/pair_config.md", `project_type: backend\npartner_root: ${client}\n`);
      buildIndex({ root: client, mode: "init", tier: "Standard", config: null });
      buildIndex({ root: server, mode: "init", tier: "Standard", config: null });

      const dispatch = JSON.parse(readFileSync(join(server, "_workspace", "index", "dispatch.json"), "utf8"));
      assert.equal(dispatch.rules.length, 1, JSON.stringify(dispatch.rules));
      assert.equal(dispatch.rules[0].source, "inferred");
      assert.ok(dispatch.result_keys.some((k) => k.key === "rtInfo" && k.sql_id === "CATEGORY_PARENT_TREE_S01"));
      const target = "acme.lms.service.CategoryService.doListParentTree";
      assert.equal(dispatch.partner_links.filter((l) => l.method_id === target).length, 2, "target 폴더의 화면까지 이어야 한다");

      const graph = JSON.parse(readFileSync(join(server, "_workspace", "index", "call_graph.json"), "utf8"));
      assert.ok(graph.edges.some((e) => e.type === "dispatch" && e.to === target && e.from.endsWith("checkList.onInitAjax")), "서버 JSP 호출도 잇는다");
      const ids = new Set(graph.nodes.map((n) => n.id));
      assert.ok(graph.edges.every((e) => ids.has(e.to)), "끊어진 엣지가 없다");

      const dead = COMMANDS.dead({ root: server, limit: 100 });
      assert.ok(!dead.items.some((d) => d.id.endsWith(".doListParentTree")), "디스패치로 불리는 메서드는 죽은 코드가 아니다");
      assert.ok(dead.items.some((d) => d.id.endsWith(".helperNobodyCalls")), "규칙 모양이 아닌 메서드는 여전히 후보다");

      const sqlUsage = JSON.parse(readFileSync(join(server, "_workspace", "index", "sql_usage.json"), "utf8"));
      assert.equal(sqlUsage.sqls.find((s) => s.id === "CATEGORY_PARENT_TREE_S01")?.columns?.[0]?.name, "PARENT_NO", "EUC-KR 쿼리 파일에서도 SELECT 순서를 남긴다");

      const impact = COMMANDS.impact({ root: server, sql: "CATEGORY_PARENT_TREE_S01", column: "PARENT_NO", limit: 50 });
      assert.equal(impact.summary.repos.length, 2);
      assert.equal(impact.summary.screen_call_sites, 3, JSON.stringify(impact.screen_callers.items.map((i) => i.file)));
      assert.equal(impact.summary.breaks_if_column_removed, 3);
      assert.ok(impact.screen_callers.items.every((i) => i.verdict === "breaks"));
      assert.ok(!impact.screen_callers.items.some((i) => i.file.includes("children")), "다른 메서드를 부르는 화면은 넣지 않는다");

      const byMethod = COMMANDS.impact({ root: server, id: "doListParentTree", limit: 50 });
      assert.equal(byMethod.summary.screen_call_sites, 3);
    } finally {
      rmSync(server, { recursive: true, force: true });
      rmSync(client, { recursive: true, force: true });
    }
  });
}

export async function testLargeFile(register, assert) {
  register("호출이 많은 큰 번들 JS 도 몇 초 안에 인덱싱한다 — 멤버 호출 판정이 제곱으로 느려지지 않는다", () => {
    /* 실측: 번들 라이브러리 pdfmake.js(1.4MB) 하나에 수 분, 인덱스 갱신 전체 8분 30초. 원인은 호출마다 본문 앞부분을 잘라 끝 공백 정규식을 돌린 것. */
    const root = mkdtempSync(join(tmpdir(), "ax-big-js-"));
    try {
      const chunk = Array.from({ length: 4000 }, (_, i) => `    a${i % 50} .  call${i}(x);\n        \n    helper${i % 7}(y);\n`).join("");
      write(root, "web/src/big.js", `function bundle() {\n${chunk}}\nfunction helper0(){} function helper1(){}\n`);
      const started = Date.now();
      buildIndex({ root, mode: "init", tier: "Standard", config: null });
      const ms = Date.now() - started;
      assert.ok(ms < 8000, `큰 파일 인덱싱이 ${ms}ms 걸렸다`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
