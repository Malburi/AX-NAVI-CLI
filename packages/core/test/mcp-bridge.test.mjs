/*
 * MCP 브리지 — 위임 실행이 사용자에게 되묻는 통로.
 *
 * 위임 프로세스는 별도 프로세스라 터미널이 없다. 그래서 질문을 소켓으로 CLI에 넘기고
 * CLI가 사람에게 물어 답을 돌려준다. 여기서는 그 소켓 왕복만 검증한다 —
 * claude 프로세스를 띄우는 부분은 실제 비용이 들어 테스트하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { startElicitHost } from "../../cli/src/mcp/host.mjs";

/**
 * 소켓에 한 줄 보내고 한 줄 받는다.
 * @param {string} address
 * @param {unknown} payload
 * @returns {Promise<any>}
 */
function roundTrip(address, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, nl)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

test("질문이 CLI까지 가서 답이 돌아온다", async () => {
  /** @type {Array<{ question: string, options: readonly string[] }>} */
  const seen = [];
  const host = await startElicitHost({
    elicitor: {
      async ask(question, options) {
        seen.push({ question, options });
        return ["모노레포"];
      },
    },
  });

  try {
    const res = await roundTrip(host.address, {
      id: "q1",
      question: "프로젝트 구성을 고르세요",
      options: ["단일", "모노레포", "1:1", "부분범위", "허브형"],
    });
    assert.equal(res.id, "q1");
    assert.deepEqual(res.answers, ["모노레포"]);
    assert.equal(seen[0]?.question, "프로젝트 구성을 고르세요");
    // Claude Code에는 옵션 4개 상한이 있었다. 여기엔 없다.
    assert.equal(seen[0]?.options.length, 5);
    assert.equal(host.asked, 1);
  } finally {
    await host.close();
  }
});

test("무응답은 빈 배열로 돌아온다 — 답을 지어내지 않는다", async () => {
  const host = await startElicitHost({ elicitor: { async ask() { return []; } } });
  try {
    const res = await roundTrip(host.address, { id: "q2", question: "무엇이든" });
    assert.deepEqual(res.answers, []);
  } finally {
    await host.close();
  }
});

test("질문 처리가 실패해도 위임 실행을 멈추지 않는다", async () => {
  const host = await startElicitHost({
    elicitor: { async ask() { throw new Error("터미널 없음"); } },
  });
  try {
    const res = await roundTrip(host.address, { id: "q3", question: "무엇이든" });
    // 사유를 실어 보내되 답 자리는 비운다 — 호출 측이 매달리지 않게.
    assert.deepEqual(res.answers, []);
    assert.match(res.error, /터미널 없음/);
  } finally {
    await host.close();
  }
});

test("여러 질문을 순서대로 처리한다", async () => {
  let n = 0;
  const host = await startElicitHost({
    elicitor: { async ask() { n += 1; return [`답${n}`]; } },
  });
  try {
    const a = await roundTrip(host.address, { id: "a", question: "첫째" });
    const b = await roundTrip(host.address, { id: "b", question: "둘째" });
    assert.deepEqual(a.answers, ["답1"]);
    assert.deepEqual(b.answers, ["답2"]);
    assert.equal(host.asked, 2);
  } finally {
    await host.close();
  }
});
