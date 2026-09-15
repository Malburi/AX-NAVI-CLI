/*
 * 답변 마크다운 → 터미널 서식 검증.
 *
 * 없으면 `**DB/SQL 없이 순수 프론트엔드로만 구현**` 이 기호째 보인다(실측).
 *
 * 여기서 지켜야 할 것은 "예쁘게"보다 **망가뜨리지 않기**다. 코드·SQL·경로에는
 * 마크다운 기호처럼 생긴 글자가 흔하고, 그걸 서식으로 오인하면 내용이 사라진다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdown, inline } from "../../cli/src/markdown.mjs";
import { visibleLength } from "../../cli/src/width.mjs";

const ESC = String.fromCharCode(27);
const NEWLINE = String.fromCharCode(10);
const ui = {
  dim: (/** @type {string} */ s) => `${ESC}[2m${s}${ESC}[0m`,
  cyan: (/** @type {string} */ s) => `${ESC}[36m${s}${ESC}[0m`,
  bold: (/** @type {string} */ s) => `${ESC}[1m${s}${ESC}[0m`,
  green: (/** @type {string} */ s) => s,
  yellow: (/** @type {string} */ s) => s,
};

/** 서식만 걷어 낸 알맹이. 내용이 살아남았는지 보는 용도. */
const plain = (/** @type {string} */ s) => s.split(ESC).map((p) => p.replace(/^\[\d+m/, "")).join("");

/**
 * 한 줄을 넣고 나오는 대로 받는다.
 * 표는 모았다 한꺼번에 나오므로 줄 하나가 줄 여럿이 될 수 있다.
 * @param {string} text
 * @returns {string}
 */
const one = (text) => {
  const md = createMarkdown({ ui });
  return [...md.line(text), ...md.flush()].join(NEWLINE);
};

/* ---------- 걸려야 하는 것 ---------- */

test("굵게가 서식이 된다 — 별표는 화면에서 사라진다", () => {
  const out = one("이 기능은 **DB/SQL 없이** 구현되어 있습니다.");
  assert.ok(out.includes(`${ESC}[1m`), "굵게가 안 걸렸다");
  assert.ok(!plain(out).includes("**"), "별표가 그대로 남았다");
  assert.match(plain(out), /이 기능은 DB\/SQL 없이 구현되어 있습니다\./);
});

test("코드 조각에 색이 붙고 백틱은 사라진다", () => {
  const out = one("`classroom` 키워드는 118건 잡힙니다");
  assert.ok(out.includes(`${ESC}[36m`));
  assert.ok(!plain(out).includes("`"));
  assert.match(plain(out), /classroom 키워드는 118건/);
});

test("제목은 굵게 쓰고 # 은 지운다", () => {
  assert.match(plain(one("## Controller")), /^Controller$/);
  assert.ok(one("## Controller").includes(`${ESC}[1m`));
});

test("글머리 기호와 들여쓰기 깊이를 유지한다 — 깊이가 곧 정보다", () => {
  assert.match(plain(one("- 첫 항목")), /^• 첫 항목$/);
  assert.match(plain(one("  - 중첩 항목")), /^ {2}• 중첩 항목$/);
  assert.match(plain(one("1. 번호 항목")), /^1\. 번호 항목$/);
});

test("인용문을 세로줄로 표시한다", () => {
  assert.match(plain(one("> 인용입니다")), /^│ 인용입니다$/);
});

/* ---------- 건드리면 안 되는 것 ---------- */

test("SQL 의 홑별표를 서식으로 오인하지 않는다", () => {
  const sql = "SELECT * FROM TB_MEMBER WHERE A = B * 2";
  assert.equal(plain(one(sql)), sql);
});

test("코드 울타리 안에서는 어떤 서식도 걸지 않는다", () => {
  const md = createMarkdown({ ui });
  md.line("```sql");
  const inside = md.line("SELECT **not bold** FROM T").join(NEWLINE);
  md.line("```");
  assert.ok(plain(inside).includes("**not bold**"), "울타리 안의 별표를 먹었다");
});

test("울타리를 닫으면 다시 서식이 걸린다", () => {
  const md = createMarkdown({ ui });
  md.line("```");
  md.line("코드");
  md.line("```");
  assert.ok(md.line("**굵게**").join("").includes(`${ESC}[1m`), "울타리가 안 닫혔다");
});

test("짝이 안 맞는 백틱은 서식으로 보지 않는다 — 줄 끝까지 물든다", () => {
  const text = "백틱 하나만 ` 있는 줄";
  assert.equal(plain(one(text)), text);
});

test("경로와 파일명은 그대로 남는다", () => {
  const path = "xu43-server/WEB-INF/src/java/eduport/lms/study/StudyMainService.java:1492-1608";
  assert.equal(plain(one(path)), path);
});

test("빈 줄은 빈 줄로 둔다", () => {
  assert.equal(one(""), "");
});

/* ---------- 폭 ---------- */

test("서식은 폭 계산에 잡히지 않는다 — 잡히면 줄이 접혀 화면이 어긋난다", () => {
  const text = "**굵게** 와 `코드` 가 섞인 줄";
  // 들여쓰기는 호출부(execute.mjs)가 붙인다. 렌더러는 폭을 한 칸도 늘리지 않는다.
  const before = visibleLength(text.replace(/[*`]/g, ""));
  assert.equal(visibleLength(one(text)), before, "서식 코드가 폭에 세어졌다");
});

/* ---------- 줄 안 ---------- */

test("한 줄에 여러 서식이 섞여도 각각 걸린다", () => {
  const out = inline("**굵게** 그리고 `코드` 그리고 ~~지움~~", ui);
  assert.ok(out.includes(`${ESC}[1m`));
  assert.ok(out.includes(`${ESC}[36m`));
  assert.ok(out.includes(`${ESC}[2m`));
  assert.equal(plain(out), "굵게 그리고 코드 그리고 지움");
});

/* ---------- 표 ---------- */

/** 표 전체를 한 번에 넣고 나온 줄들을 받는다. */
function table(/** @type {string[]} */ rows, width = 100) {
  const md = createMarkdown({ ui, width });
  /** @type {string[]} */
  const out = [];
  for (const row of rows) out.push(...md.line(row));
  out.push(...md.flush());
  return out;
}

/*
 * 칸 폭을 맞추려면 표 전체를 봐야 한다. 그래서 표만 모았다가 한꺼번에 내보낸다 —
 * 스트리밍이 멈추는 구간은 표 길이만큼뿐이다.
 */
test("칸 폭을 맞춰 그린다 — 한글은 두 칸이라 글자 수로 맞추면 어긋난다", () => {
  const lines = table(["| 타깃 | 동작 |", "|---|---|", "| ant | 컴파일한다 |", "| deploy | scp |"]);
  const widths = lines.map((l) => visibleLength(l));
  assert.equal(new Set(widths).size, 1, `줄마다 폭이 다르다: ${widths.join(", ")}`);
});

test("머리줄과 본문을 가로줄로 가른다", () => {
  const lines = table(["| A | B |", "|---|---|", "| 1 | 2 |"]);
  assert.ok(plain(/** @type {string} */ (lines[0])).startsWith("╭"), "위 테두리가 없다");
  assert.ok(plain(lines.join(NEWLINE)).includes("├"), "머리줄 구분이 없다");
  assert.ok(plain(/** @type {string} */ (lines.at(-1))).startsWith("╰"), "아래 테두리가 없다");
});

test("칸 안의 서식도 살린다", () => {
  const lines = table(["| A | B |", "|---|---|", "| `code` | **bold** |"]);
  const body = lines.join("");
  assert.ok(body.includes(`${ESC}[36m`), "코드 조각에 색이 없다");
  assert.ok(body.includes(`${ESC}[1m`), "굵게가 안 걸렸다");
});

test("폭을 넘으면 맞추기를 포기한다 — 억지로 맞추면 내용이 잘린다", () => {
  const lines = table(["| " + "가".repeat(60) + " | " + "나".repeat(60) + " |", "|---|---|"], 60);
  assert.ok(plain(lines.join("")).includes("가".repeat(60)), "내용을 잘랐다");
});

test("표가 끝나기 전에는 내보내지 않는다 — 폭을 아직 모른다", () => {
  const md = createMarkdown({ ui });
  assert.deepEqual(md.line("| A | B |"), []);
  assert.deepEqual(md.line("|---|---|"), []);
  assert.ok(md.line("본문").length > 3, "표를 안 내보내고 본문만 냈다");
});

test("답이 표로 끝나도 흘리지 않는다", () => {
  const md = createMarkdown({ ui });
  md.line("| A |");
  assert.ok(md.flush().length > 0, "마지막 표가 사라졌다");
});
