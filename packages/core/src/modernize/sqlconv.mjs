/*
 * Oracle 함수 호출 → PostgreSQL 식 (한 줄 안에서 끝나는 호출만).
 *
 * 줄 단위 레시피에 끼우려고 호출이 같은 줄에서 닫힐 때만 바꾼다 — 여러 줄에 걸친 DECODE 는 수동(또는 --draft AI 초안)으로 남긴다.
 * 작은따옴표 문자열('' 이스케이프)은 건너뛰며 괄호를 센다. 자바 줄에서는 호출 안에 큰따옴표가 있으면(문자열 이음) 바꾸지 않는다.
 *
 * DECODE(e, s1, r1, …, [d]) → CASE e WHEN s1 THEN r1 … [ELSE d] END
 *   - 찾는 값이 모두 리터럴(숫자·'문자')이면 단순 CASE — DECODE 와 뜻이 같다(e 가 NULL 이면 둘 다 기본값).
 *   - 찾는 값에 NULL 이나 컬럼·바인드가 있으면 DECODE 는 NULL = NULL 을 참으로 보므로
 *     CASE WHEN e IS NULL … / WHEN e IS NOT DISTINCT FROM s … 로. 이때 e 를 여러 번 쓰므로 e 가 단순한 이름·바인드일 때만.
 * NVL2(a, b, c) → CASE WHEN a IS NOT NULL THEN b ELSE c END
 * INSTR(s, t)   → strpos(s, t)   (인자 두 개만 — 시작 위치·번째가 있으면 수동)
 */

const LITERAL = /^(-?\d+(\.\d+)?|'(?:[^']|'')*')$/;
const NULL_LIT = /^NULL$/i;
const SIMPLE = /^([A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*)?|#\{[^{}]+\}|\$\{[^{}]+\}|:[A-Za-z_]\w*|\?)$/;

/**
 * 줄에서 name( … ) 호출을 찾아 인자를 나눈다. 같은 줄에서 닫히지 않으면 null.
 * @param {string} line @param {number} open  여는 괄호 위치
 * @returns {{ args: string[], end: number } | null}  end = 닫는 괄호 다음 위치
 */
function splitCall(line, open) {
  let depth = 0;
  let start = open + 1;
  /** @type {string[]} */
  const args = [];
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return null;
      i = close;
      // '' 이스케이프 — 다음 글자가 ' 면 문자열이 이어진다
      while (line[i + 1] === "'") {
        const next = line.indexOf("'", i + 2);
        if (next < 0) return null;
        i = next;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        args.push(line.slice(start, i));
        return { args, end: i + 1 };
      }
    } else if (c === "," && depth === 1) {
      args.push(line.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/**
 * @param {string} line
 * @param {string} name  함수 이름(대소문자 무시)
 * @param {(args: string[]) => string | null} make  인자(이미 안쪽까지 바꾼 것) → 바꿀 식, 못 바꾸면 null
 * @param {{ java?: boolean }} [opts]
 */
export function rewriteCalls(line, name, make, opts = {}) {
  const re = new RegExp(`(^|[^\\w.$#])(${name})\\s*\\(`, "gi");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    const nameAt = m.index + /** @type {string} */ (m[1]).length;
    const open = line.indexOf("(", nameAt);
    // 작은따옴표 문자열 안이면 건너뛴다(앞의 따옴표 개수가 홀수)
    if (((line.slice(0, nameAt).match(/'/g) ?? []).length & 1) === 1) continue;
    const call = splitCall(line, open);
    if (!call) continue;
    const inner = line.slice(open, call.end);
    if (opts.java && inner.includes('"')) continue;
    if (/[<>]/.test(inner.replace(/&lt;|&gt;|<>|<=|>=|\s[<>]\s/g, ""))) continue; // XML 태그가 섞인 것
    const args = call.args.map((a) => rewriteAll(a, opts).trim());
    const rep = make(args);
    if (rep === null) continue;
    out += line.slice(last, nameAt) + rep;
    last = call.end;
    re.lastIndex = call.end;
  }
  return last ? out + line.slice(last) : line;
}

/** @param {string[]} a */
export function decodeToCase(a) {
  if (a.length < 3) return null;
  const [e, ...rest] = a;
  const pairs = [];
  for (let i = 0; i + 1 < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
  const dflt = rest.length % 2 === 1 ? rest[rest.length - 1] : null;
  const tail = `${dflt !== null ? ` ELSE ${dflt}` : ""} END`;
  if (pairs.every(([s]) => LITERAL.test(/** @type {string} */ (s)))) return `CASE ${e}${pairs.map(([s, r]) => ` WHEN ${s} THEN ${r}`).join("")}${tail}`;
  if (!SIMPLE.test(/** @type {string} */ (e))) return null;
  return `CASE${pairs.map(([s, r]) => (NULL_LIT.test(/** @type {string} */ (s)) ? ` WHEN ${e} IS NULL THEN ${r}` : LITERAL.test(/** @type {string} */ (s)) ? ` WHEN ${e} = ${s} THEN ${r}` : ` WHEN ${e} IS NOT DISTINCT FROM ${s} THEN ${r}`)).join("")}${tail}`;
}

/** @param {string[]} a */
export const nvl2ToCase = (a) => (a.length === 3 ? `CASE WHEN ${a[0]} IS NOT NULL THEN ${a[1]} ELSE ${a[2]} END` : null);

/** @param {string[]} a */
export const instrToStrpos = (a) => (a.length === 2 ? `strpos(${a[0]}, ${a[1]})` : null);

/** 줄 안의 모든 대상 함수를 바꾼다(안쪽부터) @param {string} s @param {{ java?: boolean }} [opts] */
export function rewriteAll(s, opts = {}) {
  let out = rewriteCalls(s, "DECODE", decodeToCase, opts);
  out = rewriteCalls(out, "NVL2", nvl2ToCase, opts);
  out = rewriteCalls(out, "INSTR", instrToStrpos, opts);
  return out;
}
