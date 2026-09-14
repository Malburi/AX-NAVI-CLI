/*
 * 컨텍스트 관리 — 압축·프로젝트 컨텍스트·세션 저장.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactTurns, estimateTokens } from "../src/context/compaction.mjs";
import { buildProjectContext } from "../src/context/project.mjs";
import { latestSession, listSessions, loadSession, newSessionId, saveSession, toTitle } from "../src/context/sessions.mjs";
import { resolveProjectPaths } from "../src/config/paths.mjs";

/** @param {string} text @returns {import("../types/llm.js").Turn} */
const userTurn = (text) => ({ role: "user", content: [{ type: "text", text }] });

/** @param {string} content @returns {import("../types/llm.js").Turn} */
const resultTurn = (content) => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: "t", content }],
});

/* ---------- 압축 ---------- */

test("한계 아래면 손대지 않는다", () => {
  const turns = [userTurn("짧은 요청"), resultTurn("짧은 결과")];
  const out = compactTurns(turns, { maxTokens: 100_000 });
  assert.equal(out.changed, false);
  assert.deepEqual(out.turns, turns);
});

test("넘치면 오래된 도구 결과부터 들어낸다 — 사용자 말은 남긴다", () => {
  const big = "x".repeat(200_000);
  const turns = [
    userTurn("원래 요청은 이것이다"),
    resultTurn(big),
    resultTurn(big),
    userTurn("최근 요청"),
  ];
  const out = compactTurns(turns, { maxTokens: 10_000, keepRecent: 1 });

  assert.equal(out.changed, true);
  assert.ok(out.after < out.before, `${out.before} → ${out.after}`);
  // 사용자 발화는 보존된다.
  assert.equal(out.turns[0]?.content[0]?.type, "text");
  // 지운 자리에 표시가 남아야 한다 — 모델이 "원래 없었다"고 읽으면 안 된다.
  const flat = JSON.stringify(out.turns);
  assert.match(flat, /생략/);
  assert.ok(!flat.includes("x".repeat(1000)), "큰 결과가 그대로 남아 있다");
});

test("그래도 넘치면 오래된 턴을 접되 첫 요청은 남긴다", () => {
  const turns = [userTurn("최초 목표: 결제 모듈 분석"), ...Array.from({ length: 40 }, (_, i) => userTurn(`중간 ${i} ${"y".repeat(20_000)}`)), userTurn("마지막")];
  const out = compactTurns(turns, { maxTokens: 5_000, keepRecent: 2 });

  assert.equal(out.changed, true);
  assert.ok(out.turns.length < turns.length, "접히지 않았다");
  const first = out.turns[0]?.content[0];
  assert.ok(first && first.type === "text" && first.text.includes("최초 목표"), "첫 요청이 사라졌다");
  assert.match(JSON.stringify(out.turns), /생략됐다/);
});

test("토큰 추정은 내용이 늘면 함께 는다", () => {
  const small = estimateTokens([userTurn("짧다")]);
  const large = estimateTokens([userTurn("길다".repeat(1000))]);
  assert.ok(large > small * 10, `${small} vs ${large}`);
});

/* ---------- 프로젝트 컨텍스트 ---------- */

test("인덱스가 없으면 그 사실과 다음 행동을 알려 준다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-ctx-"));
  const ctx = buildProjectContext({ paths: resolveProjectPaths(dir) });
  assert.match(ctx, /인덱스: 없음/);
  assert.match(ctx, /index build/);
});

test("인덱스가 있으면 스택·파일수를 싣고 원본 JSON을 열지 말라고 못 박는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-ctx-"));
  const paths = resolveProjectPaths(dir);
  await mkdir(paths.indexDir, { recursive: true });
  await writeFile(
    join(paths.indexDir, "_meta.json"),
    JSON.stringify({
      files_total: 107,
      tier: "Full",
      init_layout: "single-root",
      adapter_coverage: { extensions: [{ adapter: "jvm", files: 80 }, { adapter: "sql", files: 20 }] },
    }),
    "utf8",
  );

  const ctx = buildProjectContext({ paths });
  assert.match(ctx, /파일 107개/);
  assert.match(ctx, /tier Full/);
  assert.match(ctx, /jvm/);
  assert.match(ctx, /QueryIndex/);
});

test("위임 경로에서는 CLAUDE.md 본문을 싣지 않는다 — 그쪽이 스스로 읽는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-ctx-"));
  const paths = resolveProjectPaths(dir);
  await writeFile(join(dir, "CLAUDE.md"), "# 프로젝트 규약\nSECRET_MARKER_9931", "utf8");

  const withBody = buildProjectContext({ paths, includeClaudeMd: true });
  const without = buildProjectContext({ paths, includeClaudeMd: false });

  assert.match(withBody, /SECRET_MARKER_9931/);
  assert.ok(!without.includes("SECRET_MARKER_9931"), "중복해서 실렸다");
  assert.match(without, /CLAUDE\.md 있음/);
});

/* ---------- 세션 ---------- */

test("저장하고 다시 불러온다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-sess-"));
  const paths = resolveProjectPaths(dir);
  const id = newSessionId();

  await saveSession(paths, {
    id,
    root: dir,
    agent: "feature-finder",
    turns: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: toTitle("주문 취소 로직 찾아줘"),
    conversation: { turns: [userTurn("주문 취소")], providerSessionId: "abc-123" },
  });

  const back = await loadSession(paths, id);
  assert.ok(back);
  assert.equal(back.agent, "feature-finder");
  assert.equal(back.turns, 3);
  assert.equal(back.conversation.providerSessionId, "abc-123");
});

test("없는 세션은 null — 예외로 CLI를 죽이지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-sess-"));
  assert.equal(await loadSession(resolveProjectPaths(dir), "없는id"), null);
});

test("깨진 세션 파일 하나가 목록 전체를 막지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-sess-"));
  const paths = resolveProjectPaths(dir);
  await mkdir(paths.sessionsDir, { recursive: true });
  await writeFile(join(paths.sessionsDir, "20260101000000-bad.json"), "{ 깨짐", "utf8");
  await saveSession(paths, {
    id: "20260102000000-ok", root: dir, agent: "qa", turns: 1,
    createdAt: "", updatedAt: "", title: "정상", conversation: { turns: [] },
  });

  const list = await listSessions(paths);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "정상");
});

test("가장 최근 세션을 고른다 — --continue 가 쓰는 경로", async () => {
  const dir = await mkdtemp(join(tmpdir(), "axnavi-sess-"));
  const paths = resolveProjectPaths(dir);
  /** @type {Array<[string, string]>} */
  const fixtures = [["20260101000000-a", "예전"], ["20260601000000-b", "최근"]];
  for (const [id, title] of fixtures) {
    await saveSession(paths, {
      id, root: dir, agent: "qa", turns: 1,
      createdAt: "", updatedAt: "", title, conversation: { turns: [] },
    });
  }
  assert.equal((await latestSession(paths))?.title, "최근");
});

test("제목은 한 줄로 잘린다", () => {
  assert.equal(toTitle("  여러   공백이\n섞인  요청  "), "여러 공백이 섞인 요청");
  assert.ok(toTitle("가".repeat(200)).length <= 71);
});
