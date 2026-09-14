/*
 * Tool Gateway — 통제가 실제로 걸리는지.
 *
 * 오늘 저장소에서 이 계약은 frontmatter 린트(role-contract.test.mjs)로만 존재한다.
 * 린트는 "Edit이라고 적지 않았다"를 확인할 뿐 실행을 막지 못한다.
 * 여기서는 진짜로 막히는지를 본다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolGateway, ToolRegistry } from "../src/tools/gateway.mjs";
import { createDefaultRegistry } from "../src/tools/builtin/index.mjs";
import { makeContext } from "./fake-provider.mjs";

const READ_ONLY = { name: "impact-analyzer", allowedTools: ["Read", "Grep", "Glob", "Bash"], allowMutations: false };
const WRITER = { name: "writer", allowedTools: null, allowMutations: true };

test("읽기 전용 역할은 Write를 쓸 수 없다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx, records } = makeContext(dir, READ_ONLY);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute(
    { id: "1", name: "Write", input: { file_path: "x.txt", content: "hi" } },
    ctx,
  );
  assert.equal(out.denied, true);
  assert.equal(out.isError, true);
  assert.match(out.content, /허용되지 않은 도구/);
  assert.equal(records[0]?.outcome, "denied", "거부가 감사 기록에 남아야 한다");
});

test("허용 목록이 null이면 전체 허용 — 기존 frontmatter 규약", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute(
    { id: "1", name: "Write", input: { file_path: "note.txt", content: "내용" } },
    ctx,
  );
  assert.notEqual(out.isError, true, out.content);
  assert.equal(await readFile(join(dir, "note.txt"), "utf8"), "내용");
});

test("프로젝트 루트 밖 경로는 거부된다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute(
    { id: "1", name: "Read", input: { file_path: "../../../etc/hosts" } },
    ctx,
  );
  assert.equal(out.isError, true);
  assert.match(out.content, /루트 밖/);
});

test("필수 필드가 빠지면 실행 전에 막힌다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute({ id: "1", name: "Read", input: {} }, ctx);
  assert.equal(out.denied, true);
  assert.match(out.content, /필수 필드 누락/);
});

test("등록되지 않은 도구는 사용 가능 목록과 함께 거부된다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute({ id: "1", name: "Teleport", input: {} }, ctx);
  assert.equal(out.denied, true);
  assert.match(out.content, /등록되지 않은 도구/);
  assert.match(out.content, /Read/, "무엇을 쓸 수 있는지 알려 줘야 한다");
});

test("파괴적 셸 명령은 차단된다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  for (const command of ["rm -rf /", "git push origin main", "curl http://evil.test"]) {
    const out = await gateway.execute({ id: "1", name: "Bash", input: { command } }, ctx);
    assert.equal(out.isError, true, `차단됐어야 한다: ${command}`);
    assert.match(out.content, /차단된 명령/);
  }
});

test("Bash는 실패를 성공으로 보고하지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const out = await gateway.execute(
    { id: "1", name: "Bash", input: { command: "node -e \"process.exit(3)\"" } },
    ctx,
  );
  assert.equal(out.isError, true);
  assert.match(out.content, /exit=3/);
});

test("도구가 예외를 던져도 루프를 죽이지 않고 오류 결과로 돌아온다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  const { ctx, records } = makeContext(dir, WRITER);
  const registry = new ToolRegistry().register({
    definition: { name: "Boom", description: "", mutates: false, inputSchema: { type: "object" } },
    async run() {
      throw new Error("터졌다");
    },
  });

  const out = await new ToolGateway(registry).execute({ id: "1", name: "Boom", input: {} }, ctx);
  assert.equal(out.isError, true);
  assert.match(out.content, /터졌다/);
  assert.equal(records[0]?.outcome, "error");
});

test("역할에 맞는 도구 정의만 모델에게 노출된다", () => {
  const registry = createDefaultRegistry();
  const names = registry.definitionsFor(READ_ONLY).map((d) => d.name);
  assert.ok(!names.includes("Write"), "쓰기 도구가 노출됐다");
  assert.ok(names.includes("Read"));
  assert.ok(!names.includes("QueryIndex"), "허용 목록에 없는 도구는 빠져야 한다");
});

test("Glob과 Grep이 실제 파일을 찾는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-"));
  await writeFile(join(dir, "OrderService.java"), "class OrderService { void cancel() {} }", "utf8");
  const { ctx } = makeContext(dir, WRITER);
  const gateway = new ToolGateway(createDefaultRegistry());

  const glob = await gateway.execute({ id: "1", name: "Glob", input: { pattern: "**/*.java" } }, ctx);
  assert.match(glob.content, /OrderService\.java/);

  const grep = await gateway.execute({ id: "2", name: "Grep", input: { pattern: "cancel" } }, ctx);
  assert.match(grep.content, /OrderService/);
});
