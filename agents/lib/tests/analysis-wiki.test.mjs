import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { buildIndex, applyAiPatch } from "../build-index.mjs";
import { validateHarness } from "../validate-harness.mjs";
import { pythonBin } from "../python-bin.mjs";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function write(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
const read = (root, name) => JSON.parse(readFileSync(join(root, "_workspace/index", `${name}.json`), "utf8"));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "ax-analysis-wiki-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function source(root) {
  write(root, "src/OrderController.java", `package com.acme;
@RequestMapping("/orders")
public class OrderController {
  @Autowired private OrderService service;
  @PostMapping("/{id}/cancel")
  public void cancel() { service.cancel(); }
}
class OrderService {
  @Autowired private OrderDao repository;
  public void cancel() { repository.remove(); }
}
class OrderDao {
  @Autowired private SqlSessionTemplate sqlSession;
  public void remove() { sqlSession.update("OrderMapper.cancel", null); }
}
class AuditDao {
  @Autowired private SqlSessionTemplate sqlSession;
  public void append() { sqlSession.insert("OrderMapper.audit", null); }
}
`);
  write(root, "src/OrderMapper.xml", `<mapper namespace="OrderMapper">
<update id="cancel">UPDATE ORDERS SET STATUS='CANCEL' WHERE ID=#{id}</update>
<insert id="audit">INSERT INTO AUDIT_LOG (ID) VALUES (#{id})</insert>
</mapper>`);
  write(root, "src/external.ts", "export function send() { return fetch('https://example.com/payment'); }\n");
}

export async function test(register, assert) {
  register("AI 설명·추가 호출·SQL 테이블은 패치와 재인덱싱을 거쳐 위키까지 보존된다", () => fixture(root => {
    source(root);
    buildIndex({ root, mode: "init", tier: "Standard" });
    const endpoint = read(root, "api_contract").endpoints[0];
    const comm = read(root, "external_io").communications[0];
    const edge = { from: "com.acme.OrderService.cancel", to: "com.acme.AuditDao.append", type: "call" };
    write(root, "_workspace/index/_ai_patch.json", { version: 1, operations: [
      { op: "add_edge", ...edge, file: "src/OrderController.java", line: 10, evidence: "fixture dynamic dispatch" },
      { op: "set_edge_note", ...edge, note: "감사 기록" },
      { op: "set_node_note", id: edge.from, note: "주문 취소" },
      { op: "set_endpoint_description", ids: [endpoint.id], description: "주문 취소 요청" },
      { op: "set_communication_description", id: comm.id, description: "결제 연동" },
      { op: "set_flow_note", id: `dataflow:${endpoint.id}`, note: "취소와 감사 기록" },
    ] });
    assert.equal(applyAiPatch(root, "_workspace/index/_ai_patch.json").rejected, 0);
    for (const mode of [null, "incremental"]) {
      if (mode) buildIndex({ root, mode, tier: "Standard" });
      const graph = read(root, "call_graph");
      assert.equal(graph.nodes.find(n => n.id === edge.from).note, "주문 취소");
      assert.equal(graph.edges.find(e => e.from === edge.from && e.to === edge.to).note, "감사 기록");
      const chain = read(root, "data_flow").chains[0];
      assert.ok(chain.tables_written.includes("AUDIT_LOG"));
      assert.ok(chain.call_edges.some(e => e.to === edge.to));
      assert.equal(chain.note, "취소와 감사 기록");
      assert.equal(read(root, "api_contract").endpoints[0].description, "주문 취소 요청");
      assert.equal(read(root, "external_io").communications[0].description, "결제 연동");
    }
    write(root, "CLAUDE.md", "# Test project\n");
    write(root, "_workspace/01_analyzer_report.md", "## 업무 개요\n주문 취소 업무입니다.\n\n## 업무 규칙\n감사 기록을 남깁니다.\n");
    const wikiDir = join(root, "_workspace/wiki");
    execFileSync(pythonBin(), [join(plugin, "agents/lib/wiki_generator.py"), "--root", root, "--wiki-dir", wikiDir], { encoding: "utf8" });
    const flowPage = readFileSync(join(wikiDir, "business-flows.md"), "utf8");
    assert.ok(flowPage.includes("AUDIT_LOG") && flowPage.includes("취소와 감사 기록"));
    assert.ok(readFileSync(join(wikiDir, "_sidebar.md"), "utf8").includes("(/business-flows)"));
    assert.ok(readFileSync(join(wikiDir, "_html/business-flows.html"), "utf8").includes("<table>"));
    assert.ok(existsSync(join(root, "_workspace/wiki_quality.json")));
    const diagrams = readFileSync(join(wikiDir, "diagrams.md"), "utf8");
    assert.ok(diagrams.includes("erDiagram") && diagrams.includes("ORDERS"), "Mermaid ERD가 유도 스키마에서 생성됨");
    assert.ok(readFileSync(join(wikiDir, "_sidebar.md"), "utf8").includes("(/diagrams)"));
    const graphHtml = readFileSync(join(wikiDir, "call-graph.html"), "utf8");
    for (const match of graphHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new Script(match[1]);
    }
  }));

  register("그룹 판정 한 건은 모든 호출자에 확장되고 그룹 정렬 변경에도 같은 대상을 유지한다", () => fixture(root => {
    const callers = Array.from({ length: 20 }, (_, i) => `export function caller${i}(target: unknown) { target.run(${i}); }`).join("\n");
    write(root, "src/ambiguous.ts", `class FirstTarget {\n run(value: number) {}\n}\nclass SecondTarget {\n run(value: number) {}\n}\n${callers}\n`);
    buildIndex({ root, mode: "init", tier: "Standard" });
    const group = read(root, "_unresolved_groups").groups[0];
    assert.equal(group.occurrences.length, 20);
    const op = { op: "resolve_group", group_id: group.group_id, to: group.candidates[0], type: "call", evidence: "fixture shared type evidence" };
    write(root, "_workspace/index/_ai_patch.json", { version: 1, operations: [op] });
    assert.equal(applyAiPatch(root, "_workspace/index/_ai_patch.json").applied, 20);
    write(root, "src/other.ts", "class FirstOther {\n run() {}\n}\nclass SecondOther {\n run() {}\n}\nexport function otherCaller(other: unknown) { other.run(); }\n");
    buildIndex({ root, mode: "incremental", tier: "Standard" });
    assert.ok(read(root, "_unresolved_groups").groups.some(g => g.group_id === op.group_id));
    assert.equal(read(root, "call_graph").edges.filter(e => e.origin === "ai-enrichment").length, 20);
    write(root, "_workspace/index/_ai_patch.json", { version: 1, operations: [{ ...op, to: "not-a-candidate" }] });
    assert.equal(applyAiPatch(root, "_workspace/index/_ai_patch.json").rejected_reasons.not_a_group_candidate, 1);
  }));

  register("DB 없는 API도 정적 흐름을 제공하며 깊이 상한을 명시한다", () => fixture(root => {
    const methods = Array.from({ length: 9 }, (_, i) => `public void step${i}() { ${i < 8 ? `step${i + 1}();` : ""} }`).join("\n");
    write(root, "src/StatusController.java", `package com.acme;\n@RequestMapping("/status")\npublic class StatusController {\n@GetMapping("/check")\npublic void check() { step0(); }\n${methods}\n}\n`);
    buildIndex({ root, mode: "init", tier: "Standard" });
    const chain = read(root, "data_flow").chains[0];
    assert.equal(chain.sql_ids.length, 0);
    assert.equal(chain.truncated, true);
    assert.equal(chain.traversal, "reachable_calls");
  }));

  register("한글·공백 설치 경로의 CLI가 실제 실행되고 잘못된 스키마 경로는 FAIL한다", () => fixture(root => {
    for (const [script, args] of [["build-index", ["--help"]], ["query-index", ["help"]]]) {
      const result = spawnSync(process.execPath, [join(plugin, `agents/lib/${script}.mjs`), ...args], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.trim().length > 20);
    }
    const bad = spawnSync(process.execPath, [join(plugin, "agents/lib/ai-budget.mjs"), "unknown"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    source(root); buildIndex({ root, mode: "init", tier: "Standard" });
    const result = validateHarness({ root, pluginRoot: join(root, "missing") });
    assert.equal(result.status, "FAIL");
    assert.ok(result.checks.some(c => c.code === "SCHEMA_LOAD"));
  }));

  register("업무 해설·누락 범위·오프라인 렌더·리포트 조립의 Python 계약", () => {
    const result = spawnSync(pythonBin(), [join(plugin, "agents/lib/tests/wiki_content_test.py")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
