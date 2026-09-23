/*
 * 줄 단위 diff — 승인 창에서 "무엇이 바뀌는지" 를 보여 주려고 쓴다.
 *
 * 플러그인에서는 Claude Code 가 Edit 를 허용하기 전에 바뀌는 줄을 빨강·초록으로
 * 보여 줬다. 경로만 보고 "예" 를 누르게 하면 승인이 형식이 된다.
 *
 * 의존성 0 원칙이라 직접 짠다. 정확한 최소 diff 가 목표가 아니라 **사람이 읽을 수
 * 있는 diff** 가 목표다 — 그래서 앞뒤 공통 줄을 먼저 떼고, 가운데만 LCS 로 맞춘다.
 * 편집은 대개 한 곳에 몰려 있어서 가운데가 작다. 가운데가 너무 크면(파일 통째 교체)
 * 맞추기를 포기하고 "지운 줄 → 넣은 줄" 로 보여 준다. 느려서 창이 늦게 뜨는 것보다 낫다.
 */

/** 가운데 LCS 표 크기 상한 (칸 수). 넘으면 맞추기를 포기한다. */
const MAX_CELLS = 250_000;
/** 바뀐 곳 앞뒤로 보여 줄 문맥 줄 수. git 과 같다. */
const CONTEXT = 3;

/**
 * @typedef {{ kind: "add" | "del" | "ctx" | "gap" | "note", text: string, no?: number }} PreviewLine
 *   kind  add 넣은 줄 · del 지운 줄 · ctx 문맥 · gap 생략 표시 · note 설명
 *   no    그 줄의 번호 (del 은 원래 파일 기준, 나머지는 바뀐 파일 기준)
 */

/** @param {string} text */
function toLines(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 끝 줄바꿈이 만든 빈 꼬리는 줄로 세지 않는다.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 두 줄 목록의 편집 순서. 앞뒤 공통부를 떼고 가운데만 LCS 로 맞춘다.
 *
 * @param {string[]} a  원래 줄
 * @param {string[]} b  바뀐 줄
 * @returns {Array<{ op: "=" | "-" | "+", text: string }>}
 */
export function diffLines(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail += 1;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  /** @type {Array<{ op: "=" | "-" | "+", text: string }>} */
  const out = a.slice(0, head).map((text) => ({ op: /** @type {"="} */ ("="), text }));

  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) out.push({ op: "-", text });
    for (const text of midB) out.push({ op: "+", text });
  } else {
    // 뒤에서부터 채운 LCS 길이표. 한 줄짜리 배열로 둬 메모리를 아낀다.
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const len = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        len[i * w + j] = midA[i] === midB[j]
          ? /** @type {number} */ (len[(i + 1) * w + j + 1]) + 1
          : Math.max(/** @type {number} */ (len[(i + 1) * w + j]), /** @type {number} */ (len[i * w + j + 1]));
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: "=", text: /** @type {string} */ (midA[i]) });
        i += 1;
        j += 1;
      } else if (/** @type {number} */ (len[(i + 1) * w + j]) >= /** @type {number} */ (len[i * w + j + 1])) {
        out.push({ op: "-", text: /** @type {string} */ (midA[i]) });
        i += 1;
      } else {
        out.push({ op: "+", text: /** @type {string} */ (midB[j]) });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ op: "-", text: /** @type {string} */ (midA[i]) });
    for (; j < m; j += 1) out.push({ op: "+", text: /** @type {string} */ (midB[j]) });
  }

  for (const text of a.slice(a.length - tail)) out.push({ op: "=", text });
  return out;
}

/**
 * 편집 순서를 사람이 볼 줄로 — 바뀐 곳 앞뒤 문맥만 남기고 나머지는 접는다.
 *
 * @param {string} before
 * @param {string} after
 * @param {number} [firstLine]  before 의 첫 줄이 파일에서 몇 번째 줄인지 (Edit 는 파일 중간이다)
 * @returns {{ lines: PreviewLine[], added: number, removed: number }}
 */
export function diffPreview(before, after, firstLine = 1) {
  const ops = diffLines(toLines(before), toLines(after));
  let added = 0;
  let removed = 0;
  /** 각 편집 줄의 번호. 지운 줄은 원래 번호, 나머지는 바뀐 쪽 번호다. */
  /** @type {Array<{ op: "=" | "-" | "+", text: string, no: number }>} */
  const numbered = [];
  let oldNo = firstLine;
  let newNo = firstLine;
  for (const { op, text } of ops) {
    if (op === "-") {
      numbered.push({ op, text, no: oldNo });
      oldNo += 1;
      removed += 1;
    } else if (op === "+") {
      numbered.push({ op, text, no: newNo });
      newNo += 1;
      added += 1;
    } else {
      numbered.push({ op, text, no: newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  // 바뀐 줄에서 CONTEXT 줄 안쪽인 문맥만 남긴다.
  const keep = new Uint8Array(numbered.length);
  numbered.forEach((row, i) => {
    if (row.op === "=") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(numbered.length - 1, i + CONTEXT); k += 1) keep[k] = 1;
  });

  /** @type {PreviewLine[]} */
  const lines = [];
  let skipped = false;
  numbered.forEach((row, i) => {
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push({ kind: "gap", text: "⋯" });
    skipped = false;
    lines.push({ kind: row.op === "+" ? "add" : row.op === "-" ? "del" : "ctx", text: row.text, no: row.no });
  });
  return { lines, added, removed };
}
