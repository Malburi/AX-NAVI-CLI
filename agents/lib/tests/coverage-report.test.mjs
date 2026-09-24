import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../build-index.mjs";
import { buildCoverageReport } from "../coverage-report.mjs";

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export async function test(register, assert) {
  register("커버리지 진단서가 지원 수준·분석 불가·읽지 않는 코드 후보·연결 품질을 인덱스에서 옮긴다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-coverage-"));
    try {
      write(root, "src/OrderDao.java", `package com.acme;
public class OrderDao {
  private SqlSessionTemplate sqlSession;
  public List list() {
    return sqlSession.selectList("OrderMapper.list");
  }
}
`);
      write(root, "src/OrderMapper.xml", `<mapper namespace="OrderMapper">
  <select id="list">SELECT * FROM ORDERS</select>
  <select id="orphan">SELECT * FROM ITEMS</select>
</mapper>`);
      write(root, "db/proc_audit.prc", "CREATE OR REPLACE PROCEDURE proc_audit IS\nBEGIN\n  NULL;\nEND;\n/\n");
      write(root, "legacy/w_order.pbl", "binary");
      write(root, "legacy/batch.pc", "EXEC SQL SELECT 1 FROM DUAL;");
      write(root, "legacy/run.ksh", "#!/bin/ksh\n");
      write(root, "web/logo.png", "img");

      buildIndex({ root, mode: "init", tier: "Standard", config: null });
      const { summary, markdown } = buildCoverageReport(root);
      assert.equal(summary.files.indexed, 4, JSON.stringify(summary.files));
      assert.equal(summary.files.full, 1, "Java만 FULL");
      assert.equal(summary.files.partial, 3, "XML 매퍼·PL/SQL·Pro*C는 PARTIAL");
      assert.equal(summary.files.discovery_only, 1, ".pbl");
      assert.equal(summary.unindexed_code_candidates.map((item) => item.extension).sort().join(","), ".ksh", "이미지는 코드 후보가 아니다");
      assert.equal(summary.quality.sql_linked, 0.5, "두 SQL 중 하나만 코드에서 실행 위치가 있다");
      assert.ok(markdown.includes("| 자동 변경 가능 (FULL → GO) | 1 | 25% |"), markdown);
      assert.ok(markdown.includes("| .ksh | 1 | legacy/run.ksh |"), markdown);
      assert.ok(!markdown.includes(".png"), "이미지는 진단서에 나오지 않는다");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("인덱스가 없으면 커버리지 진단서는 만들지 않고 이유를 알린다", () => {
    const root = mkdtempSync(join(tmpdir(), "ax-coverage-empty-"));
    try {
      let message = "";
      try { buildCoverageReport(root); } catch (error) { message = error.message; }
      assert.ok(message.includes("index build"), message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
