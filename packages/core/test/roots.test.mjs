/*
 * 인덱스를 가진 저장소 찾기.
 *
 * 실측 사고 — 사용자가 부모 폴더에서 axnavi 를 띄웠다.
 *
 *   C:\Users\HHI\xu43-wikwik\        ← 여기서 실행. _workspace 없음
 *     xu43-server\_workspace\index\   2,575 파일
 *     xu43-client\_workspace\index\   1,428 파일
 *
 * 우리는 부모의 _workspace 만 보고 "인덱스가 없습니다"로 끝냈고, 에이전트가 grep 으로
 * 내려앉았다. 같은 질문을 플러그인에 던지면 양쪽 인덱스를 찾아 저장소별로 나눠
 * 탐색했다. 답의 깊이가 갈린 지점이 그것이었다.
 *
 * 여기서 지키는 것 둘.
 *   - 단일 루트에서는 **아무것도 하지 않는다**. 기존 동작을 한 글자도 바꾸지 않는다.
 *   - 훑는 깊이는 1로 못 박는다. 재귀하면 대형 저장소에서 시작이 느려진다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverRoots } from "../src/config/roots.mjs";

const NL = String.fromCharCode(10);
const SRC_CLI = fileURLToPath(new URL("../../cli/src/", import.meta.url));

/**
 * 인덱스를 가진 저장소 하나를 만든다.
 * @param {string} dir
 * @param {{ files?: number, tier?: string, partner?: string, role?: string }} [opts]
 */
function makeRepo(dir, opts = {}) {
  const index = join(dir, "_workspace", "index");
  mkdirSync(index, { recursive: true });
  writeFileSync(
    join(index, "_meta.json"),
    JSON.stringify({ source_file_count: opts.files ?? 100, tier: opts.tier ?? "Full" }),
    "utf8",
  );
  if (opts.partner !== undefined) {
    writeFileSync(
      join(dir, "_workspace", "pair_config.md"),
      ["# Pair Configuration", "", `project_type: ${opts.role ?? "backend"}`, `partner_root: ${opts.partner}`, ""].join(NL),
      "utf8",
    );
  }
}

/** @param {(root: string) => void} fn */
function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "roots-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("선 자리에 인덱스가 있으면 훑지 않는다 — 기존 동작 그대로", () => {
  withTemp((root) => {
    makeRepo(root, { files: 42 });
    // 하위에도 하나 둔다. 훑었다면 이것까지 잡힐 것이다.
    makeRepo(join(root, "sub"), { files: 999 });

    const d = discoverRoots(root);
    assert.equal(d.scanned, false, "선 자리에 인덱스가 있는데 훑었다");
    assert.equal(d.roots.length, 1);
    assert.equal(d.roots[0]?.files, 42);
    assert.equal(d.primary.root, d.roots[0]?.paths.root);
  });
});

test("부모에서 띄우면 하위 저장소를 찾는다 — 이번 사고의 핵심", () => {
  withTemp((root) => {
    makeRepo(join(root, "xu43-server"), { files: 2575, partner: join(root, "xu43-client") });
    makeRepo(join(root, "xu43-client"), { files: 1428 });

    const d = discoverRoots(root);
    assert.equal(d.scanned, true);
    assert.equal(d.roots.length, 2, `찾은 저장소: ${d.roots.map((r) => r.name).join(", ")}`);
    const names = d.roots.map((r) => r.name).sort();
    assert.deepEqual(names, ["xu43-client", "xu43-server"]);
  });
});

test("기본 대상은 backend 다 — 페어는 양쪽 다 pair_config 를 갖는다", () => {
  /*
   * 실측: "pair 가 있는 쪽"으로 고르면 양쪽 다 걸려서 알파벳 순으로 앞선 client 가
   * 뽑혔다. 페어는 서로를 가리키므로 양쪽에 pair_config 가 있다. project_type 을 봐야 한다.
   */
  withTemp((root) => {
    // 파일 수는 client 가 더 많게 둔다. 역할이 우선하는지 보려는 것이다.
    makeRepo(join(root, "client"), { files: 9000, partner: join(root, "server"), role: "frontend" });
    makeRepo(join(root, "server"), { files: 100, partner: join(root, "client"), role: "backend" });

    const d = discoverRoots(root);
    assert.equal(d.primary.root, join(root, "server"), "backend 가 기본이 아니다");
  });
});

test("역할을 그대로 돌려준다 — 질문이 어느 쪽인지 가르는 데 쓴다", () => {
  withTemp((root) => {
    makeRepo(join(root, "be"), { files: 10, partner: join(root, "fe"), role: "backend" });
    makeRepo(join(root, "fe"), { files: 10, partner: join(root, "be"), role: "frontend" });
    const d = discoverRoots(root);
    const roles = Object.fromEntries(d.roots.map((r) => [r.name, r.role]));
    assert.deepEqual(roles, { be: "backend", fe: "frontend" });
  });
});

test("pair 가 없으면 파일이 가장 많은 쪽을 기본으로 삼는다", () => {
  withTemp((root) => {
    makeRepo(join(root, "small"), { files: 10 });
    makeRepo(join(root, "big"), { files: 5000 });

    const d = discoverRoots(root);
    assert.equal(d.primary.root, join(root, "big"));
  });
});

test("인덱스 없는 하위 폴더는 세지 않는다", () => {
  withTemp((root) => {
    makeRepo(join(root, "has-index"), { files: 50 });
    mkdirSync(join(root, "no-index", "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    const d = discoverRoots(root);
    assert.equal(d.roots.length, 1);
    assert.equal(d.roots[0]?.name, "has-index");
  });
});

test("깊이 2 는 찾지 않는다 — 비용 상한을 고정한다", () => {
  withTemp((root) => {
    // 한 단계 아래에는 인덱스가 없고, 두 단계 아래에만 있다.
    makeRepo(join(root, "a", "deep"), { files: 77 });

    const d = discoverRoots(root);
    assert.equal(d.roots.length, 0, "두 단계 아래를 찾았다 — 재귀하면 시작이 느려진다");
  });
});

test("아무 데도 없으면 빈 목록이다 — 예외로 시작을 막지 않는다", () => {
  withTemp((root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    const d = discoverRoots(root);
    assert.equal(d.roots.length, 0);
    assert.equal(d.primary.root, root, "기본 대상은 선 자리로 남아야 한다");
  });
});

test("형제가 아닌 파트너도 pair_config 를 따라가 찾는다", () => {
  withTemp((root) => {
    // server 는 하위에, client 는 완전히 다른 곳에 둔다.
    const away = join(root, "elsewhere", "client");
    makeRepo(join(root, "repos", "server"), { files: 300, partner: away });
    makeRepo(away, { files: 200 });
    // repos/ 아래라 한 단계 훑기로는 server 가 안 잡힌다. 그래서 repos 자체를 루트로.
    const d = discoverRoots(join(root, "repos"));
    assert.equal(d.roots.length, 2, `찾은 것: ${d.roots.map((r) => r.name).join(", ")}`);
    assert.ok(d.roots.some((r) => r.paths.root === away), "pair_config 의 파트너를 안 따라갔다");
  });
});

test("깨진 _meta.json 은 없는 것으로 본다 — 시작을 막지 않는다", () => {
  withTemp((root) => {
    const index = join(root, "broken", "_workspace", "index");
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, "_meta.json"), "{ 이건 JSON 이 아니다", "utf8");
    makeRepo(join(root, "ok"), { files: 5 });

    const d = discoverRoots(root);
    assert.equal(d.roots.length, 1);
    assert.equal(d.roots[0]?.name, "ok");
  });
});

test("tier 와 파일 수를 함께 돌려준다 — 화면과 컨텍스트가 이 값을 쓴다", () => {
  withTemp((root) => {
    makeRepo(join(root, "r"), { files: 1428, tier: "Standard" });
    const d = discoverRoots(root);
    assert.equal(d.roots[0]?.files, 1428);
    assert.equal(d.roots[0]?.tier, "Standard");
  });
});

/* ---------- 컨텍스트에 실리는가 ---------- */

/*
 * 에이전트는 QueryIndex 도구뿐 아니라 Bash 로 `query-index.mjs --root <여기>` 를
 * 직접 돌린다. 그 루트는 buildProjectContext 의 "루트:" 줄에서 온다. 실측으로
 * 부모 폴더를 적어 줬더니 그대로 넣어 "인덱스가 없습니다"를 받고 grep 으로 내려앉았다.
 * 이 줄이 맞으면 그 아래가 전부 맞는다.
 */
test("저장소가 여럿이면 컨텍스트가 루트를 하나씩 적는다", async () => {
  const { buildProjectContext } = await import("../src/context/project.mjs");
  withTemp((root) => {
    makeRepo(join(root, "server"), { files: 2575, partner: join(root, "client"), role: "backend" });
    makeRepo(join(root, "client"), { files: 1428, partner: join(root, "server"), role: "frontend" });

    const d = discoverRoots(root);
    const text = buildProjectContext({ paths: d.primary, roots: d.roots, includeClaudeMd: false });

    assert.match(text, /저장소 2개/, "저장소 수를 안 밝혔다");
    assert.ok(text.includes(join(root, "server")), "server 루트가 빠졌다");
    assert.ok(text.includes(join(root, "client")), "client 루트가 빠졌다");
    assert.match(text, /--root/, "어떻게 질의하라는 건지 안 알려 준다");
    assert.match(text, /(backend)/, "역할을 안 밝혔다");
    assert.match(text, /(frontend)/, "역할을 안 밝혔다");
  });
});

test("단일 저장소면 컨텍스트가 예전 그대로다", async () => {
  const { buildProjectContext } = await import("../src/context/project.mjs");
  withTemp((root) => {
    makeRepo(root, { files: 300 });
    const d = discoverRoots(root);
    const text = buildProjectContext({ paths: d.primary, roots: d.roots, includeClaudeMd: false });
    assert.ok(!text.includes("저장소 "), `다중 루트 문구가 새어 나왔다:\n${text}`);
    assert.match(text, /인덱스: 있음/);
  });
});

test("roots 를 안 넘기면 기존 동작 그대로 — 호출부 전부를 한 번에 고치지 않아도 된다", async () => {
  const { buildProjectContext } = await import("../src/context/project.mjs");
  const { resolveProjectPaths } = await import("../src/config/paths.mjs");
  withTemp((root) => {
    makeRepo(root, { files: 7 });
    const text = buildProjectContext({ paths: resolveProjectPaths(root), includeClaudeMd: false });
    assert.match(text, /인덱스: 있음/);
  });
});

/* ---------- 조건부 위임 ---------- */

test("저장소가 여럿일 때만 위임을 연다", () => {
  /*
   * 단일 저장소에서 위임을 열면 얻는 것 없이 시간과 비용만 몇 배가 된다
   * (실측: 단일 3분 43초 · $0.59 대 병렬 17분 11초).
   */
  const src = readFileSync(join(SRC_CLI, "execute.mjs"), "utf8");
  assert.match(src, /const multiRoot = discovery\.roots\.length > 1/, "다중 루트 판정이 없다");
  assert.match(src, /if \(multiRoot && !agent\.allowDelegation\)/, "조건 없이 위임을 열거나 아예 안 연다");
});

test("지시문이 저장소 수에 따라 갈린다", () => {
  const src = readFileSync(join(SRC_CLI, "commands.mjs"), "utf8");
  assert.match(src, /function delegationLines/, "지시문 분기가 없다");
  assert.match(src, /저장소마다 하나씩/, "저장소별로 띄우라는 말이 없다");
  assert.match(src, /각 저장소의 .*_workspace\/reports/, "리포트를 양쪽에 남기라는 말이 없다");
});

test("보고 형식이 '확인했는데 없는 것'을 요구한다", () => {
  /*
   * 플러그인 답변이 값졌던 이유가 이것이었다 — "DB 컬럼 없음, SQL 0건, 업로드 화면 없음",
   * "study_screen.js 실물이 두 저장소 어디에도 없음". 찾은 것만 적으면 읽는 사람이
   * 나머지를 직접 다시 뒤져야 한다.
   */
  const src = readFileSync(join(SRC_CLI, "commands.mjs"), "utf8");
  assert.match(src, /확인했는데 없는 것/);
  assert.match(src, /확인하지 못한 것/);
  assert.match(src, /오탐/);
});

test("QueryIndex 가 루트를 인자로 받되 허용 범위를 검사한다", () => {
  const src = readFileSync(join(SRC_CLI, "mcp", "server.mjs"), "utf8");
  assert.match(src, /root: \{/, "도구 스키마에 root 가 없다 — 모델이 쓸 줄 모른다");
  assert.match(src, /isWithin\(\[PROJECT_ROOT\], wanted\)/, "받은 경로를 검사하지 않는다");
});
