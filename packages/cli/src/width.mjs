/*
 * 터미널 폭 계산.
 *
 * 색 코드를 길이에 넣고 세면 줄이 폭을 넘어 접히고, 접힌 줄은 한 줄만 지우는 코드와
 * 어긋나 화면에 잔상이 남는다 — 실제로 그래서 상태줄이 출력마다 쌓였다.
 * 사본을 여러 곳에 두지 않고 여기 하나만 둔다(예전에 두 벌이었고 한쪽만 틀렸다).
 */

const ESC = String.fromCharCode(27);
const NEWLINE = new RegExp(`\\r?\\n`);
const ANSI = new RegExp(`${ESC}\[[0-9;]*m`, "g");

/*
 * 두 칸을 먹는 글자들.
 *
 * 한글·한자·가나는 터미널에서 두 칸이다. 글자 수로 세면 한글 80자가 160칸을
 * 차지해 폭 80 터미널에서 접힌다. 그러면 우리가 센 줄 수와 실제 줄 수가 어긋나고,
 * 지울 때 모자라서 화면에 잔상이 쌓인다 — 이 저장소에서 반복해 겪은 결함이다.
 * 폭이 애매한 글자까지 따지지는 않는다. 분모가 한글이라 그쪽이 중요하다.
 */
/** @type {ReadonlyArray<readonly [number, number]>} */
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
];

/**
 * 이 글자가 몇 칸을 먹는가.
 * @param {number} code
 * @returns {number}
 */
function charWidth(code) {
  for (const [lo, hi] of WIDE) if (code >= lo && code <= hi) return 2;
  return 1;
}

/**
 * ANSI 색 코드를 제외한, 화면에서 차지하는 칸 수.
 * @param {string} s
 * @returns {number}
 */
export function visibleLength(s) {
  const plain = s.replace(ANSI, "");
  let width = 0;
  for (const ch of plain) width += charWidth(/** @type {number} */ (ch.codePointAt(0)));
  return width;
}

/**
 * 폭을 넘지 않도록 자른다. 색 코드 중간에서 잘리지 않게 보이는 글자만 센다.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function clipToWidth(s, max) {
  if (visibleLength(s) <= max) return s;
  let out = "";
  let shown = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ESC) {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    const w = charWidth(/** @type {number} */ (s.codePointAt(i)));
    if (shown + w > max) break;
    out += s[i];
    // 대리쌍(이모지 등)은 두 칸을 쓰는 한 글자다. 나누어 넣으면 깨진다.
    if (/** @type {number} */ (s.codePointAt(i)) > 0xffff) {
      out += s[i + 1];
      i += 1;
    }
    shown += w;
  }
  return out;
}


/**
 * 줄바꿈을 나누고 폭에 맞게 접어 **실제로 찍힐 줄들**을 돌려준다.
 *
 * 자르지 않고 접는 이유 — 질문문이나 선택지는 내용 자체가 정보라 잘라 나가면
 * 무엇을 고르는지 알 수 없다. 대신 줄 수를 정확히 돌려줘야 지울 때 모자라지 않는다.
 * 입력에 이미 줄바꿈이 들어 있는 경우가 실제로 있었다 — harness-init 의 견적 안내가
 * 여러 줄짜리 질문으로 왔고, 그걸 한 줄로 세는 바람에 선택지가 화면에 쌓였다.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function wrapToWidth(text, max) {
  const cap = Math.max(1, max);
  /** @type {string[]} */
  const out = [];
  for (const raw of String(text ?? "").split(NEWLINE)) {
    let rest = raw;
    if (!rest) {
      out.push("");
      continue;
    }
    while (visibleLength(rest) > cap) {
      const head = clipToWidth(rest, cap);
      if (!head) break;
      out.push(head);
      rest = rest.slice(head.length);
    }
    out.push(rest);
  }
  return out;
}
