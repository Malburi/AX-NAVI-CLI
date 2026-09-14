/*
 * 터미널 폭 계산.
 *
 * 색 코드를 길이에 넣고 세면 줄이 폭을 넘어 접히고, 접힌 줄은 한 줄만 지우는 코드와
 * 어긋나 화면에 잔상이 남는다 — 실제로 그래서 상태줄이 출력마다 쌓였다.
 * 사본을 여러 곳에 두지 않고 여기 하나만 둔다(예전에 두 벌이었고 한쪽만 틀렸다).
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\[[0-9;]*m`, "g");

/**
 * ANSI 색 코드를 뺀 표시 길이.
 * @param {string} s
 * @returns {number}
 */
export function visibleLength(s) {
  return s.replace(ANSI, "").length;
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
    if (shown >= max) break;
    out += s[i];
    shown += 1;
  }
  return out;
}
