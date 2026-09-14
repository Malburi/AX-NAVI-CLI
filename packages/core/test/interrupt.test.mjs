/*
 * 중단 검증.
 *
 * 실측된 결함 — 작업 중에 Ctrl+C 나 ESC 를 눌러도 턴이 끝까지 갔다.
 * 원인은 둘이었고 둘 다 여기서 못 박는다.
 *   1. execute.mjs 가 process.on("SIGINT") 만 걸었는데, TTY 에서 readline 이
 *      Ctrl+C 를 먼저 가로채 자기 close() 로 처리하고 프로세스 시그널을 올리지 않았다
 *   2. 중단해도 claude 의 자식(MCP 서버)이 살아남아 파이프가 안 닫혔다
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { beginTurn, endTurn, interruptTurn } from "../../cli/src/runtime.mjs";

test("도는 턴이 없으면 중단할 것도 없다고 알린다", () => {
  // 호출자는 이 false 를 "그럼 종료 의사겠구나"로 해석한다. 거짓말하면 앱이 안 닫힌다.
  assert.equal(interruptTurn(), false);
});

test("도는 턴을 중단하면 signal 이 끊긴다", () => {
  const turn = beginTurn();
  assert.equal(turn.signal.aborted, false);
  assert.equal(interruptTurn(), true);
  assert.equal(turn.signal.aborted, true, "signal 이 안 끊겼다 — provider 는 계속 돈다");
  endTurn(turn);
});

test("이미 중단한 턴을 또 중단했다고 보고하지 않는다", () => {
  const turn = beginTurn();
  interruptTurn();
  assert.equal(interruptTurn(), false, "두 번째 Ctrl+C 가 종료로 이어지지 못한다");
  endTurn(turn);
});

test("턴이 끝나면 손잡이를 내려놓는다", () => {
  const turn = beginTurn();
  endTurn(turn);
  assert.equal(interruptTurn(), false, "끝난 턴이 아직 등록돼 있다");
});

test("뒤이어 시작한 턴은 앞 턴의 뒤늦은 정리에 지워지지 않는다", () => {
  const first = beginTurn();
  const second = beginTurn();
  endTurn(first);
  assert.equal(interruptTurn(), true, "살아 있는 턴을 잃었다");
  assert.equal(second.signal.aborted, true);
  assert.equal(first.signal.aborted, false);
  endTurn(second);
});

test("중단이 실제 자식 프로세스까지 닿는다", async () => {
  // 스스로는 절대 안 끝나는 프로세스. 취소가 진짜로 닿는지만 본다.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.equal(child.exitCode, null, "시작도 전에 죽었다 — 이 테스트는 의미가 없다");

  const turn = beginTurn();
  turn.signal.addEventListener("abort", () => child.kill(), { once: true });
  interruptTurn();

  await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, "자식이 살아남았다");
  endTurn(turn);
});
