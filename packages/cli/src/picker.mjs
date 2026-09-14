/*
 * 방향키로 고르는 선택지.
 *
 * 처음에는 번호를 타이핑하게 했는데 두 가지가 문제였다.
 *   - 답이 REPL 의 줄 큐를 타므로, 작업 중에 미리 쳐 둔 명령이 답으로 먹혔다(실측)
 *   - 긴 선택지를 읽고 번호를 되짚어 찾는 일 자체가 번거롭다
 * 키를 직접 읽으면 둘 다 사라진다 — 줄 큐와 아예 무관해지고, 눈이 머문 곳이 곧 답이다.
 *
 * 구현에서 조심할 점 하나 — 그리는 동안 readline 이 같은 키를 또 처리하면 프롬프트가
 * 끼어들어 화면이 엉킨다. 그래서 keypress 청취자를 **잠시 떼었다가 그대로 되돌린다**.
 * 떼는 대상에는 우리 ESC 중단 처리도 포함되는데, 그게 맞다 — 선택지가 떠 있는 동안
 * ESC 는 "이 질문 취소"여야지 "작업 전체 중단"이 아니다.
 */

import { wrapToWidth } from "./width.mjs";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_DOWN = `${ESC}[0J`;
/** @param {number} n */
const cursorUp = (n) => (n > 0 ? `${ESC}[${n}A` : "");

/** 한 화면에 몇 줄까지 보여 줄지. 넘치면 창이 따라 움직인다. */
const MAX_VISIBLE = 9;

/**
 * 보여 줄 구간. 고른 항목이 늘 창 안에 들어오게 민다.
 * @param {number} total
 * @param {number} selected
 * @param {number} [max]
 * @returns {{ start: number, end: number }}
 */
export function windowFor(total, selected, max = MAX_VISIBLE) {
  if (total <= max) return { start: 0, end: total };
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(selected - half, total - max));
  return { start, end: start + max };
}

/**
 * 화면에 그릴 줄들을 만든다.
 *
 * 커서 제어와 떼어 놓은 이유는 이것만 TTY 없이 검증할 수 있기 때문이다 —
 * 폭 초과로 줄이 접히면 지우는 줄 수가 어긋나 선택지가 쌓이는데, 그게 여기서 잡힌다.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {readonly string[]} args.options
 * @param {number} args.cursor
 * @param {ReadonlySet<number>} args.checked
 * @param {boolean} args.multiSelect
 * @param {number} args.width
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @returns {string[]}
 */
export function renderPicker({ question, options, cursor, checked, multiSelect, width, ui }) {
  const cap = Math.max(20, width - 1);
  const { lines, push } = lineSink(cap, ui);

  /*
   * 모든 줄을 표시를 붙이기 **전에** 접는다.
   *
   * 질문문에 줄바꿈이 들어 있거나 줄이 폭을 넘으면 실제로 찍히는 줄 수가 늘어난다.
   * 그걸 한 줄로 세면 지울 때 모자라 매번 몇 줄씩 남는다 — 실측으로 harness-init 의
   * 견적 안내가 네 줄짜리 질문으로 왔고, 방향키를 움직일 때마다 같은 질문이 쌓였다.
   */
  push(question, ui.bold, ui.yellow("?"));

  const { start, end } = windowFor(options.length, cursor);
  if (start > 0) push(`⋯ 위로 ${start}개 더`, ui.dim, " ");

  for (let i = start; i < end; i += 1) {
    const here = i === cursor;
    const mark = multiSelect ? (checked.has(i) ? "◉ " : "◯ ") : "";
    // 화살표는 첫 줄에만 단다. 접힌 줄마다 붙이면 항목이 여러 개로 보인다.
    push(`${mark}${options[i]}`, here ? ui.cyan : ui.dim, here ? ui.cyan("❯") : " ");
  }
  if (end < options.length) push(`⋯ 아래로 ${options.length - end}개 더`, ui.dim, " ");

  push(
    multiSelect
      ? "↑↓ 이동 · Space 선택 · Enter 확정 · Esc 건너뜀"
      : "↑↓ 이동 · Enter 선택 · Esc 건너뜀",
    ui.dim,
    " ",
  );
  return lines;
}

/**
 * 고른 뒤에 남길 기록.
 *
 * 선택지 목록을 그대로 두면 다음 출력과 섞여 무엇을 골랐는지 되짚기 어렵다.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {readonly string[]} args.answers
 * @param {number} args.width
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @returns {string[]}
 */
export function renderAnswer({ question, answers, width, ui }) {
  const { lines, push } = lineSink(Math.max(20, width - 1), ui);
  push(question, ui.bold, ui.yellow("?"));
  push(answers.length ? answers.join(", ") : "건너뜀", ui.cyan, ui.cyan("❯"));
  return lines;
}

/**
 * 줄을 모으는 그릇.
 *
 * 접기·표시 붙이기·들여쓰기를 한 자리에 모아 둔다. 한 곳이라도 빼먹으면 그 줄만
 * 폭을 넘어 접히고, 그순간 전체 줄 수가 틀려 화면에 잔상이 남는다(실측: 안내 줄을
 * 빼먹어 폭 30에서 35칸이 나왔다).
 *
 * @param {number} cap
 * @param {{ dim: (s: string) => string }} _ui
 */
function lineSink(cap, _ui) {
  const INDENT = 2; // 표시 한 칸 + 띄어쓰기
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} text
   * @param {(s: string) => string} paint
   * @param {string} head  첫 줄 앞에 붙일 표시(한 칸)
   */
  const push = (text, paint, head) => {
    wrapToWidth(text, cap - INDENT).forEach((part, i) => {
      lines.push(`${i === 0 ? head : " "} ${paint(part)}`);
    });
  };
  return { lines, push };
}


/**
 * 선택지를 띄우고 사용자가 고를 때까지 기다린다.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {readonly string[]} args.options
 * @param {boolean} [args.multiSelect]
 * @param {NodeJS.ReadStream} args.input
 * @param {NodeJS.WriteStream} args.output
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @param {() => void} [args.onInterrupt]  선택지 위에서 Ctrl+C 를 누른 경우
 * @returns {Promise<string[]>}
 */
export function pick({ question, options, multiSelect = false, input, output, ui, onInterrupt }) {
  return new Promise((resolve) => {
    let cursor = 0;
    /** @type {Set<number>} */
    const checked = new Set();
    let drawn = 0;

    const paint = () => {
      const lines = renderPicker({
        question, options, cursor, checked, multiSelect,
        width: output.columns ?? 80, ui,
      });
      output.write(cursorUp(drawn) + CLEAR_DOWN + lines.join("\n") + "\n");
      drawn = lines.length;
    };

    /*
     * readline 의 키 처리를 잠시 떼어 둔다.
     * 안 떼면 같은 키가 두 번 해석돼 프롬프트가 선택지 사이에 끼어든다.
     */
    const saved = /** @type {Function[]} */ (input.listeners("keypress"));
    for (const fn of saved) input.off("keypress", /** @type {any} */ (fn));
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    output.write(HIDE_CURSOR);

    /** @param {string[]} answers */
    const finish = (answers) => {
      input.off("keypress", onKey);
      for (const fn of saved) input.on("keypress", /** @type {any} */ (fn));
      input.setRawMode?.(wasRaw);
      output.write(SHOW_CURSOR);

      /*
       * 고른 결과를 한 줄로 남긴다.
       * 선택지 목록을 그대로 두면 다음 출력과 섞여 무엇을 골랐는지 되짚기 어렵다.
       */
      const lines = renderAnswer({ question, answers, width: output.columns ?? 80, ui });
      output.write(cursorUp(drawn) + CLEAR_DOWN + lines.join("\n") + "\n");
      resolve(answers);
    };

    /**
     * @param {string} ch
     * @param {{ name?: string, ctrl?: boolean }} [key]
     */
    function onKey(ch, key) {
      const name = key?.name;
      if (key?.ctrl && name === "c") {
        finish([]);
        onInterrupt?.();
        return;
      }
      if (name === "escape") return finish([]);
      if (name === "return" || name === "enter") {
        if (!multiSelect) return finish([/** @type {string} */ (options[cursor])]);
        const picked = [...checked].sort((a, b) => a - b).map((i) => /** @type {string} */ (options[i]));
        // 하나도 안 고르고 Enter 면 지금 커서에 있는 것으로 본다 — 빈손으로 돌려보내지 않는다.
        return finish(picked.length ? picked : [/** @type {string} */ (options[cursor])]);
      }
      if (name === "up" || name === "k") cursor = (cursor - 1 + options.length) % options.length;
      else if (name === "down" || name === "j" || name === "tab") cursor = (cursor + 1) % options.length;
      else if (name === "home") cursor = 0;
      else if (name === "end") cursor = options.length - 1;
      else if (multiSelect && name === "space") {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
      } else if (ch >= "1" && ch <= "9") {
        // 번호도 그대로 받는다 — 손에 익은 사람에게서 빼앗을 이유는 없다.
        const n = Number(ch) - 1;
        if (n < options.length) {
          cursor = n;
          if (!multiSelect) return finish([/** @type {string} */ (options[n])]);
        }
      } else return;
      paint();
    }

    input.on("keypress", onKey);
    paint();
  });
}
