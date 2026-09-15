/*
 * 답변의 마크다운을 터미널 서식으로 옮긴다.
 *
 * 없으면 `**오프라인 강의실 대관 예약**` 이나 `` `classroom` `` 이 기호째 보인다(실측).
 * 모델은 마크다운으로 쓰는데 우리가 날것으로 흘려보내고 있었다.
 *
 * 설계에서 정한 선
 * - **한 줄씩** 처리한다. 답이 스트리밍으로 오기 때문이다. 코드 울타리만 줄을 넘어
 *   이어지므로 그것만 상태로 들고 간다.
 * - `*기울임*` 은 다루지 않는다. SQL 의 `SELECT *` 같은 홑별표를 서식으로 오인해
 *   문장을 망가뜨리는 쪽이 못 알아보는 것보다 나쁘다.
 * - 원문을 지우지 않는다. 알아보지 못한 기호는 그대로 남긴다 — 서식이 아니라
 *   내용일 수 있다.
 */

/** @typedef {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, green: (s: string) => string, yellow: (s: string) => string }} Ui */

const BULLET = "•";

/**
 * @param {object} args
 * @param {Ui} args.ui
 * @returns {{ line: (text: string) => string, reset: () => void }}
 */
export function createMarkdown({ ui }) {
  // 울타리 안에서는 어떤 서식도 걸지 않는다. 코드에 든 기호는 코드다.
  let inFence = false;

  return {
    /** @param {string} text */
    line(text) {
      const fence = /^\s*(```|~~~)/.exec(text);
      if (fence) {
        inFence = !inFence;
        return ui.dim(text);
      }
      if (inFence) return ui.cyan(text);
      return block(text, ui);
    },
    reset() {
      inFence = false;
    },
  };
}

/**
 * 줄 단위 서식. 들여쓰기는 건드리지 않는다 — 목록의 깊이가 곧 정보다.
 * @param {string} text
 * @param {Ui} ui
 * @returns {string}
 */
function block(text, ui) {
  const indent = /^\s*/.exec(text)?.[0] ?? "";
  const body = text.slice(indent.length);
  if (!body) return text;

  // 구분선
  if (/^([-*_])\1{2,}\s*$/.test(body)) return ui.dim(text);

  // 제목 — 굵게 쓰고 색을 준다. # 기호는 화면에서 군더더기다.
  const heading = /^(#{1,6})\s+(.*)$/.exec(body);
  if (heading) return `${indent}${ui.cyan(ui.bold(inline(heading[2] ?? "", ui)))}`;

  // 인용
  const quote = /^>\s?(.*)$/.exec(body);
  if (quote) return `${indent}${ui.dim("│")} ${ui.dim(inline(quote[1] ?? "", ui))}`;

  // 글머리 기호 — 마커만 바꾸고 들여쓰기는 그대로 둔다.
  const bullet = /^([-*+])\s+(.*)$/.exec(body);
  if (bullet) return `${indent}${ui.cyan(BULLET)} ${inline(bullet[2] ?? "", ui)}`;

  // 번호 목록
  const ordered = /^(\d{1,3}[.)])\s+(.*)$/.exec(body);
  if (ordered) return `${indent}${ui.cyan(ordered[1] ?? "")} ${inline(ordered[2] ?? "", ui)}`;

  /*
   * 표.
   *
   * 구분줄(|---|---|)은 내용이 없으니 흐리게 둔다.
   * 내용 줄은 상자만 흐리게 해서 값이 먼저 눈에 들게 한다 — 줄을 다시 짜지는 않는다.
   * 폭을 맞추려면 표 전체를 모아 들고 있어야 하는데, 답이 줄 단위로 온다.
   */
  if (/^\|[\s|:-]+\|$/.test(body)) {
    // 가로막대도 상자 글자로 바꾼다. 내용 줄과 세로줄이 안 맞으면 표로 안 보인다.
    return `${indent}${ui.dim(body.replace(/\|/g, "┼").replace(/[-:]/g, "─"))}`;
  }
  if (body.startsWith("|") && body.endsWith("|") && body.length > 2) {
    const cells = body.slice(1, -1).split("|");
    return `${indent}${ui.dim("│")}${cells.map((cell) => inline(cell, ui)).join(ui.dim("│"))}${ui.dim("│")}`;
  }

  return `${indent}${inline(body, ui)}`;
}

/**
 * 줄 안의 서식.
 *
 * 코드 조각을 먼저 갈라낸다 — 코드 안의 `**` 는 서식이 아니라 글자다.
 * @param {string} text
 * @param {Ui} ui
 * @returns {string}
 */
export function inline(text, ui) {
  const parts = text.split("`");
  /*
   * 백틱이 홀수면 짝이 안 맞는다는 뜻이다. 그때 코드로 칠하면 줄 끝까지 물든다 —
   * 차라리 서식으로 안 보고 넘긴다.
   */
  if (parts.length % 2 === 0) return emphasize(text, ui);

  return parts
    .map((segment, i) => (i % 2 === 1 ? ui.cyan(segment) : emphasize(segment, ui)))
    .join("");
}

/**
 * @param {string} text
 * @param {Ui} ui
 * @returns {string}
 */
function emphasize(text, ui) {
  let out = text;
  // `**` 를 `*` 보다 먼저 봐야 한다. 반대로 하면 별 두 개를 반으로 쪼갠다.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, inner) => ui.bold(inner));
  out = out.replace(/__([^_]+)__/g, (_, inner) => ui.bold(inner));
  out = out.replace(/~~([^~]+)~~/g, (_, inner) => ui.dim(inner));
  return out;
}
