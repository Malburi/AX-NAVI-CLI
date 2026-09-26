/*
 * 이어서 열 때 지난 대화 전체를 다시 그리는지 검증.
 *
 * 실측: /resume 이 마지막 8마디를 마디당 6줄로만 보여 줘, 마지막 턴들이 붙여넣기 조각이던 세션은
 * 앞에서 무슨 일을 했는지 알 수 없었다. Claude 가 남긴 전체 기록(질문 19·도구 호출 117)을 그리게 했다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptPath, humanText, renderClaudeSession } from "../../cli/src/session-replay.mjs";

const plain = { dim: (s) => s, cyan: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s };

test("Claude 기록 파일 위치는 작업 폴더 경로의 영숫자 아닌 글자를 '-' 로 바꾼 폴더다", () => {
  assert.equal(claudeTranscriptPath("C:\\Users\\a\\x-y", "s1", "H"), join("H", ".claude", "projects", "C--Users-a-x-y", "s1.jsonl"));
});

test("사람이 쓴 말만 남긴다 — axnavi 안내문은 걷고, 스킬 지시는 한 줄로 줄이고, 시스템 알림은 버린다", () => {
  assert.equal(humanText("<쓸 수 있는 도구>\nRead\n</쓸 수 있는 도구>\n\n<역할 지침>\n너는\n</역할 지침>\n\n<응답 방식>\n-\n</응답 방식>\n\n뭐해 되고있어?"), "뭐해 되고있어?");
  assert.equal(humanText("# 요청\n수강신청 찾아줘\n\n프로젝트 루트: C:/p\n<스킬 절차: find-feature>\n본문…\n</스킬 절차>"), "/find-feature 수강신청 찾아줘");
  assert.equal(humanText("# 실행 지시\n\n사용자가 덧붙인 조건: 페어 마무리\n\n## 절차: harness-init\n본문"), "/harness-init 페어 마무리");
  assert.equal(humanText("<system-reminder>x</system-reminder>"), null);
  assert.equal(humanText("<역할 지침>\n만\n</역할 지침>"), null, "안내문만 있는 메시지는 사람 말이 아니다");
});

test("질문·답·도구 호출과 결과를 순서대로 그리고, 결과를 못 받은 호출도 밝힌다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ax-replay-"));
  try {
    const path = join(dir, "s.jsonl");
    const lines = [
      { type: "user", message: { content: "<역할 지침>\n…\n</역할 지침>\n\n수강신청 어디 있어?" } },
      { type: "assistant", message: { content: [{ type: "text", text: "인덱스를 먼저 확인하겠습니다." }, { type: "tool_use", id: "t1", name: "mcp__axnavi__QueryIndex", input: { command: "search", q: "수강신청" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"total\": 4}" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "## 결과\n- **front/course/apply**" }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", isMeta: true, message: { content: "<command-name>/x</command-name>" } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
    const out = renderClaudeSession({ path, root: dir, width: 100, ui: plain });
    const text = (out ?? []).join("\n");
    assert.match(text, /› 수강신청 어디 있어\?/);
    assert.ok(!/역할 지침/.test(text), "axnavi 안내문이 보인다");
    assert.match(text, /● QueryIndex/, "mcp 접두어를 걷고 도구 호출을 그린다");
    assert.match(text, /결과/);
    assert.ok(!text.includes("**"), "마크다운을 서식으로 바꾸지 않았다");
    assert.match(text, /● Bash[\s\S]*결과를 받지 못했습니다/, "결과 없는 호출을 숨겼다");
    assert.ok(text.indexOf("수강신청 어디") < text.indexOf("QueryIndex"), "순서가 뒤집혔다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(renderClaudeSession({ path: join(tmpdir(), "없는-파일.jsonl"), root: ".", width: 80, ui: plain }), null, "기록이 없으면 null — 호출부가 예전 방식으로 대신한다");
});
