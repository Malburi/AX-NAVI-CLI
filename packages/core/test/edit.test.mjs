/*
 * 부분 수정 도구 검증.
 *
 * 이 도구가 없어서 생긴 실측 결함 — `tools:` 선언이 없는 에이전트 6종과 오케스트레이터가
 * 플러그인 때는 쓰던 Edit 을 잃고 "No such tool available: Edit" 을 받았다.
 *
 * 되살리면서 지켜야 할 것이 둘이다.
 *   1. 소스를 고치지 않는 13종은 여전히 못 써야 한다 (frontmatter 계약)
 *   2. 못 찾았거나 여러 군데면 조용히 넘어가면 안 된다 — 고쳤다고 믿고 다음 단계로 간다
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry } from "../src/tools/builtin/index.mjs";
import { ToolGateway } from "../src/tools/gateway.mjs";

/** @returns {Promise<{ root: string, file: string }>} */
async function sandbox(content = "가\n나\n다\n") {
  const root = await mkdtemp(join(tmpdir(), "axnavi-edit-"));
  const file = join(root, "a.txt");
  await writeFile(file, content, "utf8");
  return { root, file };
}

/** @param {string} root @param {{ allowedTools?: string[] | null, allowMutations?: boolean }} [role] */
function ctxFor(root, role = {}) {
  return {
    paths: /** @type {any} */ ({ root }),
    allowedRoots: [root],
    role: {
      name: "t",
      allowedTools: role.allowedTools === undefined ? null : role.allowedTools,
      allowMutations: role.allowMutations !== false,
    },
    audit: { record: () => {}, flush: async () => {}, file: "" },
    elicitor: { ask: async () => [] },
    progress: { update: () => {} },
    signal: new AbortController().signal,
  };
}

const registry = createDefaultRegistry();

/** @param {string} root @param {Record<string, unknown>} input @param {any} [role] */
function runEdit(root, input, role) {
  const gateway = new ToolGateway(registry);
  return gateway.execute({ id: "1", name: "Edit", input }, /** @type {any} */ (ctxFor(root, role)));
}

/* ---------- 있는가 ---------- */

test("Edit 이 기본 도구로 등록돼 있다 — 없으면 6종이 수단을 잃는다", () => {
  assert.ok(registry.names().includes("Edit"));
});

test("소스를 고치는 역할에는 보이고, 읽기 전용 13종에는 안 보인다", () => {
  const all = registry.definitionsFor({ allowedTools: null, allowMutations: true });
  assert.ok(all.some((t) => t.name === "Edit"), "tools 선언이 없는 역할이 Edit 을 못 받았다");

  // validator 등 13종이 실제로 선언하는 목록. Edit 이 없다.
  const readOnly = registry.definitionsFor({
    allowedTools: ["Read", "Grep", "Glob", "Bash", "Write", "TaskUpdate"],
    allowMutations: true,
  });
  assert.ok(!readOnly.some((t) => t.name === "Edit"), "읽기 전용 역할에 Edit 이 새어 들어갔다");
});

test("쓰기를 막은 역할에는 Edit 도 없다", () => {
  const none = registry.definitionsFor({ allowedTools: null, allowMutations: false });
  assert.ok(!none.some((t) => t.name === "Edit"));
});

/* ---------- 동작 ---------- */

test("한 대목만 바꾼다", async () => {
  const { root, file } = await sandbox();
  const out = await runEdit(root, { file_path: file, old_string: "나", new_string: "라" });
  assert.equal(out.isError, undefined);
  assert.equal(await readFile(file, "utf8"), "가\n라\n다\n");
});

test("빈 문자열로 바꾸면 지워진다", async () => {
  const { root, file } = await sandbox("앞[지울것]뒤");
  await runEdit(root, { file_path: file, old_string: "[지울것]", new_string: "" });
  assert.equal(await readFile(file, "utf8"), "앞뒤");
});

test("여러 줄에 걸친 대목도 바꾼다", async () => {
  const { root, file } = await sandbox("a\nb\nc\n");
  await runEdit(root, { file_path: file, old_string: "a\nb", new_string: "x" });
  assert.equal(await readFile(file, "utf8"), "x\nc\n");
});

/* ---------- 실패는 실패라고 ---------- */

test("못 찾으면 실패로 돌려준다 — 조용히 넘어가면 고친 줄 안다", async () => {
  const { root, file } = await sandbox();
  const out = await runEdit(root, { file_path: file, old_string: "없는것", new_string: "x" });
  assert.equal(out.isError, true);
  assert.match(out.content, /찾지 못했다/);
  assert.equal(await readFile(file, "utf8"), "가\n나\n다\n", "실패인데 파일이 바뀌었다");
});

test("여러 군데면 멈추고 몇 군데인지 알린다", async () => {
  const { root, file } = await sandbox("x\nx\nx\n");
  const out = await runEdit(root, { file_path: file, old_string: "x", new_string: "y" });
  assert.equal(out.isError, true);
  assert.match(out.content, /3군데/);
  assert.equal(await readFile(file, "utf8"), "x\nx\nx\n", "애매한데 하나를 골라 바꿨다");
});

test("replace_all 이면 전부 바꾼다", async () => {
  const { root, file } = await sandbox("x\nx\nx\n");
  const out = await runEdit(root, { file_path: file, old_string: "x", new_string: "y", replace_all: true });
  assert.equal(out.isError, undefined);
  assert.equal(await readFile(file, "utf8"), "y\ny\ny\n");
});

test("바꿀 것과 바뀔 것이 같으면 거절한다", async () => {
  const { root, file } = await sandbox();
  const out = await runEdit(root, { file_path: file, old_string: "나", new_string: "나" });
  assert.equal(out.isError, true);
});

test("프로젝트 루트 밖은 건드리지 못한다", async () => {
  const { root } = await sandbox();
  const outside = await mkdtemp(join(tmpdir(), "axnavi-outside-"));
  const victim = join(outside, "b.txt");
  await writeFile(victim, "건드리지 마라", "utf8");

  const out = await runEdit(root, { file_path: victim, old_string: "건드리지", new_string: "건드렸다" });
  assert.equal(out.isError, true);
  assert.equal(await readFile(victim, "utf8"), "건드리지 마라");
});
