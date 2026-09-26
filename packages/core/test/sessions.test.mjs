/*
 * 세션 저장소가 깨진 파일·이상한 id·커밋 위험에 버티는지 검증.
 *
 * 리뷰 실측: 내용이 `{}` 인 세션 파일 하나로 `/sessions` 가 통째로 죽었고, `/resume ../../x` 가 sessions 밖
 * 파일을 열었으며, `.gitignore` 는 `axnavi init` 을 해야만 생겨 대화 기록이 커밋될 수 있었다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestSession, listSessions, loadSession, saveSession, sessionIsCorrupt } from "../src/context/sessions.mjs";

function paths() {
  const root = mkdtempSync(join(tmpdir(), "ax-sess-"));
  const axnaviDir = join(root, ".axnavi");
  return { root, axnaviDir, sessionsDir: join(axnaviDir, "sessions"), logsDir: join(axnaviDir, "logs") };
}
const record = (/** @type {string} */ id) => ({ id, root: ".", agent: "axnavi", turns: 1, createdAt: "", updatedAt: "", title: id, conversation: { turns: [] } });

test("저장하면 .gitignore 가 생기고, 깨진 파일은 목록에서 빠지며 손상으로 구분된다", async () => {
  const p = /** @type {any} */ (paths());
  try {
    await saveSession(p, record("20260101000000-aaaa"));
    assert.match(readFileSync(join(p.axnaviDir, ".gitignore"), "utf8"), /^sessions\/$/m, "init 없이 저장했는데 커밋에서 빠지지 않는다");
    writeFileSync(join(p.sessionsDir, "20260101000001-bbbb.json"), "{}");
    writeFileSync(join(p.sessionsDir, "20260101000002-cccc.json"), "{깨짐");
    const list = await listSessions(p);
    assert.deepEqual(list.map((r) => r.id), ["20260101000000-aaaa"], "깨진 세션이 목록에 섞였다");
    assert.equal(await loadSession(p, "20260101000001-bbbb"), null);
    assert.ok(sessionIsCorrupt(p, "20260101000001-bbbb"), "손상과 없음을 구분하지 못한다");
    assert.ok(!sessionIsCorrupt(p, "없는-세션"));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("세션 id 는 우리가 만든 모양만 받는다 — sessions 밖 파일을 열지 않는다", async () => {
  const p = /** @type {any} */ (paths());
  try {
    mkdirSync(p.sessionsDir, { recursive: true });
    writeFileSync(join(p.root, "evil.json"), JSON.stringify(record("evil")));
    assert.equal(await loadSession(p, "../../evil"), null);
    assert.equal(await loadSession(p, "..\\evil"), null);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("--continue 는 마지막으로 쓴 대화를 연다(만든 순서가 아니라)", async () => {
  const p = /** @type {any} */ (paths());
  try {
    await saveSession(p, record("20260101000000-old"));
    await saveSession(p, record("20260102000000-new"));
    const past = Date.now() / 1000 - 3600;
    utimesSync(join(p.sessionsDir, "20260102000000-new.json"), past, past);
    assert.equal((await latestSession(p))?.id, "20260101000000-old", "옛 세션을 이어 쓴 뒤인데 다른 세션을 열었다");
    assert.ok(!existsSync(join(p.sessionsDir, "20260101000000-old.json.tmp-" + process.pid)), "임시 파일이 남았다");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
