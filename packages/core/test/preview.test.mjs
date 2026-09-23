/*
 * 승인 창의 diff 미리보기.
 *
 * 플러그인에서는 Claude Code 가 Edit 를 허용하기 전에 바뀌는 줄을 보여 줬다. 경로만 보고
 * "예" 를 누르게 하면 승인이 형식이 된다.
 *
 * 여기서 지킬 선
 * - 줄 번호는 **파일 기준**이다. Edit 조각의 1번 줄이 아니라 파일의 몇 번째 줄인지.
 *   찾지 못하면 번호를 빼다 — 틀린 번호는 번호가 없는 것보다 나쁘다.
 * - 창은 **화면을 넘지 않는다.** 폭을 넘는 줄은 접지 않고 자른다. 높이를 넘으면
 *   위가 스크롤로 밀려나 다시 그릴 때 화면이 쌓인다(실측으로 겪은 고장).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffPreview } from "../../cli/src/diff.mjs";
import { previewToolUse } from "../../cli/src/approval.mjs";
import { renderPicker, renderPreview } from "../../cli/src/picker.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

/** @param {string} s */
const same = (s) => s;
const plain = { dim: same, cyan: same, bold: same, yellow: same, red: same, green: same };
const ANSI = /\u001b\[[0-9;]*m/g;

test("diff — 바뀐 줄만 +/- 로, 나머지는 그대로", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "B", "c"]);
  assert.deepEqual(ops.map((o) => `${o.op}${o.text}`), ["=a", "-b", "+B", "=c"]);
});

test("diff — 넣기만·지우기만도 맞는다", () => {
  assert.deepEqual(diffLines([], ["x", "y"]).map((o) => o.op), ["+", "+"]);
  assert.deepEqual(diffLines(["x", "y"], []).map((o) => o.op), ["-", "-"]);
  assert.deepEqual(diffLines(["a", "c"], ["a", "b", "c"]).map((o) => `${o.op}${o.text}`), ["=a", "+b", "=c"]);
});

test("diff — 통째 교체처럼 큰 가운데는 맞추기를 포기하되 결과는 맞다", () => {
  const a = Array.from({ length: 1000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 1000 }, (_, i) => `b${i}`);
  const ops = diffLines(a, b);
  assert.equal(ops.filter((o) => o.op === "-").length, 1000);
  assert.equal(ops.filter((o) => o.op === "+").length, 1000);
});

test("미리보기 — 바뀐 곳 앞뒤 3줄만 남기고 접는다", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 5", "LINE 5").replace("line 25", "LINE 25");
  const { lines, added, removed } = diffPreview(before, after);
  assert.equal(added, 2);
  assert.equal(removed, 2);
  assert.ok(lines.some((l) => l.kind === "gap"), "떨어진 두 곳 사이를 접지 않았다");
  assert.ok(!lines.some((l) => l.text === "line 15"), "먼 문맥까지 보여 줬다");
  assert.deepEqual(lines.find((l) => l.kind === "del"), { kind: "del", text: "line 5", no: 5 });
});

test("Edit — 줄 번호는 파일에서 그 자리의 번호다", () => {
  const file = "one\ntwo\nthree\nfour\nfive\n";
  const preview = previewToolUse(
    "Edit",
    { file_path: "x.js", old_string: "four", new_string: "FOUR" },
    () => file,
  );
  assert.deepEqual(preview[0], { kind: "note", text: "+1 −1" });
  assert.deepEqual(preview.find((l) => l.kind === "del"), { kind: "del", text: "four", no: 4 });
  assert.deepEqual(preview.find((l) => l.kind === "add"), { kind: "add", text: "FOUR", no: 4 });
});

test("Edit — 윈도우 줄바꿈 파일에서도 자리를 찾는다", () => {
  const preview = previewToolUse(
    "Edit",
    { file_path: "x.java", old_string: "b\nc", new_string: "b\nC" },
    () => "a\r\nb\r\nc\r\n",
  );
  assert.equal(preview.find((l) => l.kind === "del")?.no, 3);
});

test("Edit — 파일에서 못 찾으면 번호를 빼고, 실패할 거라고 알린다", () => {
  const preview = previewToolUse("Edit", { file_path: "x", old_string: "zzz", new_string: "y" }, () => "abc\n");
  assert.ok(preview.every((l) => l.no === undefined), "틀린 번호를 붙였다");
  assert.ok(preview.some((l) => l.kind === "note" && /찾지 못했습니다/.test(l.text)));
});

test("Edit — replace_all 이면 몇 곳을 바꾸는지 알린다", () => {
  const preview = previewToolUse(
    "Edit",
    { file_path: "x", old_string: "foo", new_string: "bar", replace_all: true },
    () => "foo\nfoo\nfoo\n",
  );
  assert.ok(preview.some((l) => l.kind === "note" && /3곳/.test(l.text)));
});

test("Write — 새 파일이면 새 파일이라고, 있으면 무엇이 바뀌는지", () => {
  const fresh = previewToolUse("Write", { file_path: "n.md", content: "a\nb\n" }, () => null);
  assert.deepEqual(fresh[0], { kind: "note", text: "새 파일 · 2줄" });
  assert.equal(fresh.filter((l) => l.kind === "add").length, 2);

  const over = previewToolUse("Write", { file_path: "o.md", content: "a\nB\n" }, () => "a\nb\n");
  assert.deepEqual(over[0], { kind: "note", text: "덮어쓰기 · +1 −1" });

  const same = previewToolUse("Write", { file_path: "o.md", content: "a\n" }, () => "a\r\n");
  assert.deepEqual(same, [{ kind: "note", text: "지금 파일과 내용이 같습니다" }]);
});

test("MultiEdit — 편집마다 자기 자리의 번호로", () => {
  const preview = previewToolUse(
    "MultiEdit",
    { file_path: "x", edits: [{ old_string: "b", new_string: "B" }, { old_string: "d", new_string: "D" }] },
    () => "a\nb\nc\nd\n",
  );
  assert.deepEqual(preview[0], { kind: "note", text: "편집 2건" });
  assert.deepEqual(preview.filter((l) => l.kind === "del").map((l) => l.no), [2, 4]);
});

test("Bash — 짧은 명령은 한 줄 요약으로 충분하고, 여러 줄이면 전체를 보여 준다", () => {
  assert.deepEqual(previewToolUse("Bash", { command: "npm test" }), []);
  const multi = previewToolUse("Bash", { command: "cd x\nrm -rf build\nnpm run build" });
  assert.deepEqual(multi.map((l) => l.text), ["cd x", "rm -rf build", "npm run build"]);
});

test("미리보기 줄은 폭을 넘지 않는다 — 접지 않고 자른다", () => {
  const lines = renderPreview(
    [{ kind: "add", text: "가".repeat(200), no: 12 }, { kind: "del", text: "x\ty".repeat(100), no: 3 }],
    40,
    plain,
    10,
  );
  assert.equal(lines.length, 2, "한 줄이 여러 줄로 접혔다");
  for (const line of lines) assert.ok(visibleLength(line.replace(ANSI, "")) <= 40, `폭 초과: ${visibleLength(line)}`);
});

test("미리보기가 길면 잘라서 몇 줄 더 있는지 알린다", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ kind: /** @type {const} */ ("add"), text: `l${i}`, no: i + 1 }));
  const lines = renderPreview(many, 80, plain, 10);
  assert.equal(lines.length, 10);
  assert.match(lines[9] ?? "", /91줄 더/);
});

test("승인 창 전체가 터미널 높이를 넘지 않는다", () => {
  const preview = previewToolUse(
    "Write",
    { file_path: "big.md", content: Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n") },
    () => null,
  );
  for (const height of [20, 30, 50]) {
    const lines = renderPicker({
      question: "Write  C:\\p\\big.md\n실행할까요?",
      options: ["예", "예, 이번 세션 동안 파일 수정은(는) 묻지 않음", "아니오"],
      cursor: 0,
      checked: new Set(),
      multiSelect: false,
      width: 80,
      ui: plain,
      header: "권한",
      preview,
      height,
    });
    assert.ok(lines.length <= height, `높이 ${height} 에 ${lines.length}줄을 그렸다`);
    for (const line of lines) assert.ok(visibleLength(line) <= 80, "폭을 넘었다");
  }
});

test("미리보기가 없으면 창 모양이 예전과 같다", () => {
  const args = {
    question: "질문", options: ["a", "b"], cursor: 0, checked: new Set(),
    multiSelect: false, width: 80, ui: plain,
  };
  assert.deepEqual(renderPicker({ ...args, preview: [] }), renderPicker(args));
});
