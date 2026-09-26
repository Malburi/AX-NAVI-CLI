/*
 * 약속한 산출물이 실제로 쓰였는가.
 *
 * 실측 사고 — 저장소 둘을 병렬로 훑은 실행에서 server 쪽 서브에이전트가 이렇게 끝냈다.
 *
 *   전체 상세: …\xu43-server\_workspace\reports\found_video-subtitle.md
 *
 * 그런데 그 파일을 쓰지 않았다. 로그 전체에 `Write` 호출이 client 쪽 하나뿐이었다.
 * 앞선 실행이 남긴 같은 이름의 파일이 이미 있었고, 에이전트가 그것을 읽고
 * "확인했다"로 갈음한 것이다. 사용자는 새 리포트인 줄 알고 옛 내용을 본다.
 *
 * 지침으로도 막지만 지침은 지켜지지 않을 수 있다. 그래서 사실로 확인한다.
 * 여기서 지킬 선 — **애매하면 경고하지 않는다.** 늘 뜨는 경고는 경고가 아니다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrittenClaims } from "../../cli/src/claims.mjs";

/** @param {(root: string) => void} fn */
function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "claims-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 리포트 하나를 만든다.
 * @param {string} root
 * @param {string} name
 * @param {number} [mtimeMs]  주면 그 시각으로 돌려놓는다 (앞선 실행이 남긴 것 흉내)
 */
function makeReport(root, name, mtimeMs) {
  const dir = join(root, "_workspace", "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "# 리포트\n", "utf8");
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    utimesSync(path, t, t);
  }
  return path;
}

test("이번 턴에 안 쓰인 산출물을 잡는다 — 이번 사고 그대로", () => {
  withTemp((root) => {
    const since = Date.now();
    // 앞선 실행이 한 시간 전에 남긴 파일. 이번 턴에는 아무도 안 썼다.
    makeReport(root, "found_video-subtitle.md", since - 3_600_000);

    const answer = `전체 상세: ${join(root, "_workspace", "reports", "found_video-subtitle.md")}`;
    const missing = unwrittenClaims(answer, [root], since);
    assert.equal(missing.length, 1, `잡지 못했다: ${JSON.stringify(missing)}`);
  });
});

test("이번 턴에 쓰인 산출물은 안 잡는다", () => {
  withTemp((root) => {
    const since = Date.now() - 1000;
    makeReport(root, "found_x.md"); // 지금 씀
    const answer = `전체 상세: ${join(root, "_workspace", "reports", "found_x.md")}`;
    assert.deepEqual(unwrittenClaims(answer, [root], since), []);
  });
});

/*
 * 실측: server 에서 돈 pair-init 이 옆 저장소의 `xu25-client/_workspace/reports/api_drift_report.md` 를
 * 이번 턴에 썼는데, server 기준으로만 붙여 "쓰이지 않았다"고 잘못 경고했다.
 */
test("옆 저장소 이름으로 시작하는 상대경로는 부모 폴더 기준으로도 본다", () => {
  withTemp((parent) => {
    const server = join(parent, "xu25-server");
    const client = join(parent, "xu25-client");
    mkdirSync(server, { recursive: true });
    const since = Date.now() - 1000;
    makeReport(client, "api_drift_report.md");
    const answer = "상세: xu25-client/_workspace/reports/api_drift_report.md";
    assert.deepEqual(unwrittenClaims(answer, [server], since), [], "옆 저장소에 쓴 산출물을 못 찾았다");
  });
});

test("아예 없는 파일도 잡는다", () => {
  withTemp((root) => {
    const answer = `리포트: ${join(root, "_workspace", "reports", "없는파일.md")}`;
    assert.equal(unwrittenClaims(answer, [root], Date.now()).length, 1);
  });
});

test("저장소 상대경로도 루트를 붙여 본다", () => {
  withTemp((root) => {
    const since = Date.now() - 1000;
    makeReport(root, "found_rel.md");
    const missing = unwrittenClaims("전체 상세: `_workspace/reports/found_rel.md`", [root], since);
    assert.deepEqual(missing, [], `상대경로를 못 붙였다: ${JSON.stringify(missing)}`);
  });
});

test("여러 저장소 중 한 곳에만 있어도 지킨 것으로 본다 — 애매하면 경고하지 않는다", () => {
  withTemp((root) => {
    const since = Date.now() - 1000;
    const a = join(root, "server");
    const b = join(root, "client");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    makeReport(b, "found_both.md"); // client 에만 썼다

    const missing = unwrittenClaims("리포트: `_workspace/reports/found_both.md`", [a, b], since);
    assert.deepEqual(missing, [], "한 곳에 썼는데 경고했다");
  });
});

test("산출물 경로가 없는 답에는 아무 말도 하지 않는다", () => {
  withTemp((root) => {
    const answer = "수강승인은 ApplyApproveService.java:814 에서 처리합니다. 파일을 고치지는 않았습니다.";
    assert.deepEqual(unwrittenClaims(answer, [root], Date.now()), []);
  });
});

test("소스 파일 경로는 산출물로 세지 않는다 — 늘 뜨는 경고는 경고가 아니다", () => {
  withTemp((root) => {
    const answer = [
      "WEB-INF/src/java/eduport/lms/back/education/apply/service/ApplyApproveService.java:814",
      "`xu43-client/web/src/js/study.js:120`",
      "docs/index-schema/symbols.schema.json",
    ].join("\n");
    assert.deepEqual(unwrittenClaims(answer, [root], Date.now()), []);
  });
});

test("묶음 표기 {a,b} 는 파일마다 풀어서 본다 — 셋 다 썼으면 경고하지 않는다", () => {
  withTemp((root) => {
    const dir = join(root, "_workspace", "reports");
    mkdirSync(dir, { recursive: true });
    for (const n of ["impact", "safety"]) writeFileSync(join(dir, `${n}_x.md`), "ok");
    const answer = "리포트: _workspace/reports/{impact,safety}_x.md";
    assert.deepEqual(unwrittenClaims(answer, [root], Date.now() - 60_000), []);
    const partial = "리포트: _workspace/reports/{impact,missing}_x.md";
    assert.deepEqual(unwrittenClaims(partial, [root], Date.now() - 60_000), ["_workspace/reports/missing_x.md"]);
  });
});

test("같은 경로를 여러 번 적어도 한 번만 센다", () => {
  withTemp((root) => {
    const p = join(root, "_workspace", "reports", "dup.md");
    const answer = `${p} 를 보세요. 다시 말하지만 ${p} 입니다.`;
    assert.equal(unwrittenClaims(answer, [root], Date.now()).length, 1);
  });
});

test("지침도 함께 막는다 — 읽고 '확인했다'로 갈음하지 못하게", () => {
  /*
   * 런타임 경고는 사후 통보다. 애초에 그러지 않게 말해 두는 편이 낫고, 둘 다 있어야
   * 한쪽이 새도 다른 쪽이 잡는다.
   */
  const src = readFileSync(new URL("../../cli/src/commands.mjs", import.meta.url), "utf8");
  assert.match(src, /이번 실행의 결과로 새로 써라/);
  assert.match(src, /갈음하지 마라/);
  assert.match(src, /쓰지 않은 파일의 경로를 답에 적지 마라/);
});
