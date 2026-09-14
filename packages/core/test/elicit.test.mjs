/*
 * 질문 통로 검증.
 *
 * 실제로 겪은 결함 — /harness-init 이 AskUserQuestion 을 띄웠는데 무엇을 눌러도
 * 선택이 되지 않았다. 원인은 두 가지였고 둘 다 여기서 못 박는다.
 *   1. REPL 이 이미 stdin 을 쥐고 있는데 질문이 readline 을 새로 열어 경쟁했다
 *   2. 회전자 타이머가 질문의 입력 자리를 덮어썼다 (activity.test.mjs 가 담당)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElicitor, createHostElicitor, setLineReader } from "../../cli/src/runtime.mjs";

/** @param {string[]} lines */
function reader(lines) {
  const rest = [...lines];
  return async () => rest.shift() ?? null;
}

test("번호로 고르면 해당 선택지를 돌려준다", async () => {
  const answers = await createElicitor(reader(["2"])).ask("무엇?", ["가", "나", "다"], {});
  assert.deepEqual(answers, ["나"]);
});

test("쉼표로 여러 개를 고른다", async () => {
  const answers = await createElicitor(reader(["1, 3"])).ask("무엇?", ["가", "나", "다"], {
    multiSelect: true,
  });
  assert.deepEqual(answers, ["가", "다"]);
});

test("선택지가 4개를 넘어도 고를 수 있다 — 호스트 상한을 물려받지 않는다", async () => {
  const options = ["1안", "2안", "3안", "4안", "5안"];
  const answers = await createElicitor(reader(["5"])).ask("무엇?", options, {});
  assert.deepEqual(answers, ["5안"], "5번째가 잘려나갔다");
});

test("범위 밖 번호는 자유 입력으로 받는다 — 되묻느라 절차를 멈추지 않는다", async () => {
  const answers = await createElicitor(reader(["99"])).ask("무엇?", ["가", "나"], {});
  assert.deepEqual(answers, ["99"]);
});

test("빈 답은 빈 배열 — 아무거나 골라 주지 않는다", async () => {
  const answers = await createElicitor(reader([""])).ask("무엇?", ["가", "나"], {});
  assert.deepEqual(answers, []);
});

test("선택지가 없으면 자유 입력을 그대로 쓴다", async () => {
  const answers = await createElicitor(reader(["결제 모듈"])).ask("어디?", [], {});
  assert.deepEqual(answers, ["결제 모듈"]);
});

test("등록된 독자로 읽는다 — readline 을 새로 열어 stdin 을 다투지 않는다", async () => {
  let calls = 0;
  setLineReader(async () => {
    calls += 1;
    return "1";
  });
  try {
    const answers = await createHostElicitor().ask("무엇?", ["가", "나"], {});
    assert.deepEqual(answers, ["가"]);
    assert.equal(calls, 1, "등록된 독자를 쓰지 않았다 — stdin 경쟁이 다시 생긴다");
  } finally {
    setLineReader(null);
  }
});
