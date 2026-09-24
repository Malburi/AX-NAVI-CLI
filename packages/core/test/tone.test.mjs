/*
 * 사용자에게 나가는 말의 어투.
 *
 * 사용자가 이렇게 말했다 — "왜 자꾸 이런식으로 반말해? ax-navi cli 는 다 반말이네".
 * 맞는 지적이었다. `v0.1.0-alpha.14 로 올렸다. 다시 시작하면 적용된다.` 처럼
 * 화면에 나가는 문장이 전부 평서형(해라체)이었다.
 *
 * 구분해야 할 것이 있다. **주석과 모델 지시문은 반말이 맞다** — 읽는 쪽이 개발자이고
 * 에이전트다. 지시문을 존댓말로 바꾸면 지시의 강도까지 달라진다. 여기서 지키는 것은
 * 사람이 읽는 줄뿐이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";

const NL = String.fromCharCode(10);
const SRC = fileURLToPath(new URL("../../cli/src/", import.meta.url));

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/*
 * 존댓말 인식은 넓게 잡는다. 어미를 하나씩 적으면 "냅니다"·"따릅니다"처럼
 * 멀쩡한 존댓말이 반말로 잡힌다(실제로 그랬다). 한국어 경어체는 결국
 * 니다/니까 또는 요 로 끝난다.
 */
const POLITE = /(니다|니까|십시오|[가-힣]요|죠)[.!?]?$/;

/*
 * 종결형 판정을 **뒤집었다.**
 *
 * 처음에는 반말 어미를 목록으로 들고 있었는데, 목록은 늘 샌다 — "옮겼다", "것이라서다"
 * 처럼 안 적어 둔 어미가 그대로 빠져나갔다. 그래서 반대로 본다. 한국어 문장처럼
 * 끝나는데(다/라/요/까/죠/네) 존댓말이 아니면 잡는다.
 */
const SENTENCE = /[가-힣](다|라|요|까|죠|네)[.!?]?$/;

/*
 * 모델에게 가는 문자열은 건너뛴다.
 *
 *   - 주석
 *   - mcp/ 전체 — 도구 설명과 도구 결과다. 둘 다 읽는 쪽이 모델이다.
 *   - instruction/PROMPT 배열 (오케스트레이터·절차 실행 지시문)
 *   - systemPrompt (여러 줄로 이어지는 것까지)
 *   - onSkillRequest 가 모델에게 돌려주는 값
 *
 * 이 경계가 이 테스트의 전부다. 잘못 그으면 지시문을 존댓말로 바꾸게 되고,
 * 그러면 지시의 강도가 달라진다.
 */
/** 문자열 리터럴 — 따옴표 세 종류를 모두 본다. */
const STR = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const MODEL_ONLY = new Set(["시작한다."]);

/*
 * 프롬프트 문자열을 짓는 함수들. 이름만으로는 배열 리터럴 규칙에 안 걸린다.
 * 여기 적힌 함수의 본문은 통째로 건너뛴다 — 읽는 쪽이 에이전트다.
 */
const PROMPT_FNS = new Set(["delegationLines", "toolBriefing", "inlineSkill"]);

/** @returns {Array<{ file: string, line: number, text: string }>} */
function scan() {
  /** @type {Array<{ file: string, line: number, text: string }>} */
  const hits = [];
  for (const file of walk(SRC)) {
    // MCP 서버의 문자열은 전부 모델이 읽는다 — 도구 설명과 도구 결과다.
    if (file.includes(`${sep}mcp${sep}`)) continue;
    // persona.mjs 는 파일 전체가 AX-NAVI 인격의 시스템 프롬프트다.
    if (file.endsWith(`${sep}persona.mjs`)) continue;
    const lines = readFileSync(file, "utf8").split(NL);
    let inBlock = false;
    let inPrompt = false;
    let inSystem = false;
    let inPromptFn = false;
    lines.forEach((raw, i) => {
      const t = raw.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return;
      }
      if (t.startsWith("/*")) {
        if (!t.includes("*/")) inBlock = true;
        return;
      }
      if (t.startsWith("//") || t.startsWith("*")) return;
      // 프롬프트를 짓는 함수는 본문 전체를 건너뛴다. 닫는 중괄호가 열의 첫 글자다.
      if (inPromptFn) {
        if (/^}$/.test(raw)) inPromptFn = false;
        return;
      }
      {
        const fn = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/.exec(t);
        if (fn && PROMPT_FNS.has(String(fn[1]))) {
          inPromptFn = true;
          return;
        }
      }
      // throw 메시지는 개발자용 불변식이다. 사용자에게 보이라고 쓴 문장이 아니다.
      if (t.includes("throw new Error(")) return;
      if (/const (instruction|PROMPT|VIBE_POLICY|PLAN_POLICY|payload|briefing) = \[/.test(t)) inPrompt = true;
      if (inPrompt) {
        if (/^\]/.test(t)) inPrompt = false;
        return;
      }
      /*
       * 시스템 프롬프트는 여러 줄로 이어진다. 닫히는 줄까지 건너뛰되 **반드시 닫아야**
       * 한다 — 예전 판은 닫는 조건이 배열 전용(`]`)이라 systemPrompt 뒤의 파일 전체를
       * 건너뛰었다. 그래서 그 아래에 있던 안내문의 반말을 못 잡았다.
       */
      if (inSystem) {
        if (/,\s*$/.test(t) || /^\},?$/.test(t)) inSystem = false;
        return;
      }
      if (/systemPrompt:/.test(t)) {
        inSystem = !/,\s*$/.test(t);
        return;
      }

      for (const m of raw.matchAll(STR)) {
        const s = (m[2] ?? "").replace(/\n/g, " ").trim();
        if (!/[가-힣]/.test(s) || MODEL_ONLY.has(s)) continue;
        for (const piece of s.split(/\s—\s|·/)) {
          // 끝의 보간(`${NEWLINE}` 등)을 벗겨야 종결형이 드러난다.
          const last = piece.replace(/\$\{[^}]*\}\s*$/, "").trim();
          if (!/[가-힣]/.test(last) || POLITE.test(last)) continue;
          if (SENTENCE.test(last)) {
            hits.push({ file: file.slice(SRC.length), line: i + 1, text: last.slice(0, 60) });
            break;
          }
        }
      }
    });
  }
  return hits;
}

test("화면에 나가는 한국어 문장은 존댓말이다", () => {
  const hits = scan();
  const shown = hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join(NL);
  assert.equal(hits.length, 0, `반말로 나가는 줄이 ${hits.length}건 있다${NL}${shown}`);
});

test("주석과 모델 지시문은 이 검사에 걸리지 않는다", () => {
  /*
   * 이 테스트가 없으면 다음 사람이 검사를 넓히려다 지시문까지 존댓말로 바꾼다.
   * 지시문은 반말이어야 한다 — 그게 이 저장소의 선택이고, 강도가 달라지면 안 된다.
   */
  const commands = readFileSync(join(SRC, "commands.mjs"), "utf8");
  assert.match(commands, /너는 AX-NAVI의 오케스트레이터다/, "지시문이 존댓말로 바뀌었다");
  assert.match(commands, /절차를 설명하지 마라/, "지시문이 존댓말로 바뀌었다");
});
