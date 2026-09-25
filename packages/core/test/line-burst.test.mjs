/*
 * 붙여넣기 묶기 검증.
 *
 * 실측: 옆 창의 화면 조각 8줄이 붙여 넣어지자 줄마다 턴이 하나씩 돌아 같은 모양의 답이
 * 12초마다 되풀이됐다. 한 덩어리로 들어온 줄은 메시지 하나여야 한다.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createLineBurst } from "../../cli/src/line-burst.mjs";

test("한꺼번에 들어온 여러 줄은 메시지 하나로 묶인다", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    /** @type {string[]} */
    const got = [];
    const burst = createLineBurst((t) => got.push(t), { gapMs: 40 });
    for (const line of ["───", "❯", "const offenders = [];", "const bodies = ["]) burst.push(line);
    assert.deepEqual(got, [], "간격이 지나기 전에 내보냈다");
    mock.timers.tick(40);
    assert.deepEqual(got, ["───\n❯\nconst offenders = [];\nconst bodies = ["]);
  } finally {
    mock.timers.reset();
  }
});

test("사람이 사이를 두고 친 줄은 따로 간다", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    /** @type {string[]} */
    const got = [];
    const burst = createLineBurst((t) => got.push(t), { gapMs: 40 });
    burst.push("첫 요청");
    mock.timers.tick(500);
    burst.push("2");
    mock.timers.tick(40);
    assert.deepEqual(got, ["첫 요청", "2"]);
  } finally {
    mock.timers.reset();
  }
});

test("파이프 입력은 줄마다 명령이다 — 합치지 않는다", () => {
  /** @type {string[]} */
  const got = [];
  const burst = createLineBurst((t) => got.push(t), { enabled: false });
  burst.push("/status");
  burst.push("/exit");
  assert.deepEqual(got, ["/status", "/exit"]);
});

test("입력이 닫히면 모아 둔 줄을 버리지 않고 내보낸다", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    /** @type {string[]} */
    const got = [];
    const burst = createLineBurst((t) => got.push(t));
    burst.push("마지막 줄");
    burst.flush();
    assert.deepEqual(got, ["마지막 줄"]);
    mock.timers.tick(1000);
    assert.equal(got.length, 1, "flush 뒤에 한 번 더 내보냈다");
  } finally {
    mock.timers.reset();
  }
});
