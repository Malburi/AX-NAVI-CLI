/*
 * 인라인 자동완성 메뉴.
 *
 * 목록을 화면에 한 번 쏟아내는 대신, 입력 아래에 떠 있으면서 타이핑에 따라 좁혀지고
 * 위·아래로 고를 수 있게 한다.
 *
 * 구현에서 가장 중요한 결정은 **선택 = 입력 그 자체**로 둔 것이다.
 * 선택을 따로 들고 있다가 Enter에서 합치려 하면 readline의 Enter 처리를 가로채야 하는데,
 * 그 타이밍 싸움은 깨지기 쉽다. 대신 위·아래·Tab을 누를 때마다 입력 줄 자체를 고른 후보로
 * 바꿔 버리면, Enter·Backspace·커서 이동이 전부 readline의 기본 동작 그대로 맞아떨어진다.
 *
 * 대신 대가가 하나 있다 — rl.write()는 "사용자가 친 것처럼" 입력을 흘려보내 keypress를
 * 다시 일으킨다. 그래서 프로그램으로 줄을 고쳐 쓰는 구간에는 키 처리를 잠근다(writing).
 */

import { clipToWidth } from "./width.mjs";

const MAX_VISIBLE = 7;

/**
 * 보여 줄 구간을 고른다. 선택 항목이 항상 창 안에 들어오도록 민다.
 * 순수 함수로 뺀 이유는 TTY 없이 검증하기 위해서다 — 나머지는 커서 제어라 테스트가 어렵다.
 *
 * @param {number} total
 * @param {number} selected
 * @param {number} max
 * @returns {{ start: number, end: number }}
 */
export function computeWindow(total, selected, max = MAX_VISIBLE) {
  if (total <= max) return { start: 0, end: total };
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(selected - half, total - max));
  return { start, end: start + max };
}

/*
 * ANSI — 전부 **상대** 이동으로 다룬다.
 *
 * 예전엔 커서 저장/복원(ESC 7 / ESC 8)을 썼는데, 그건 화면의 **절대 행**을 기억한다.
 * 메뉴를 화면 밑쪽에서 그리면 터미널이 스크롤하고, 그순간 저장해 둔 행이 한 칸씩
 * 밀려 복원이 엉뚱한 자리로 간다. 그 뒤로는 메뉴가 안 지워지고(쌓임), 새 메뉴가
 * 이전 메뉴 위에 어긋나게 덮여져 글자가 섞인 것처럼 보인다 — 실측으로 `/context` 가
 * `/pontext`·`/coetext` 처럼 보였다. 상대 이동은 스크롤과 함께 밀려서 안전하다.
 */
const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CLEAR_DOWN = ESC + "[0J";
/** @param {number} n */
const up = (n) => (n > 0 ? ESC + "[" + n + "A" : "");
/** @param {number} n */
const right = (n) => (n > 0 ? ESC + "[" + n + "C" : "");

/**
 * @typedef {object} MenuItem
 * @property {string} value   입력에 채워 넣을 값 (예: "/find")
 * @property {string} hint    오른쪽에 흐리게 붙일 설명
 */

/**
 * readline 인터페이스에 자동완성 메뉴를 붙인다.
 *
 * @param {object} args
 * @param {import("node:readline").Interface & { line?: string }} args.rl
 * @param {NodeJS.ReadStream} args.input
 * @param {NodeJS.WriteStream} args.output
 * @param {(line: string) => MenuItem[]} args.source  현재 입력에 대한 후보 목록
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string }} args.ui
 * @returns {{ close: () => void, dispose: () => void }}
 */
export function attachAutocomplete({ rl, input, output, source, ui }) {
  /** @type {MenuItem[]} */
  let items = [];
  let selected = 0;
  /** 지금 화면에 그려 둔 메뉴 줄 수 — 지울 때 필요하다. */
  let painted = 0;
  /*
   * 우리가 줄을 프로그램으로 고쳐 쓰는 중인지.
   *
   * rl.write()는 "사용자가 친 것처럼" 입력을 흘려보내므로 keypress가 글자마다 다시 난다.
   * 그대로 두면 선택을 옮기자마자 그 결과를 새 필터로 오해해 후보가 한 개로 줄고
   * 커서가 제자리에 묶인다. 그래서 이 구간에는 키 처리를 잠근다.
   */
  let writing = false;

  /**
   * 입력 줄에서 커서가 몇 칸째에 있는가.
   * 메뉴를 그리고 돌아올 때 이 자리로 되돌려야 한다.
   * @returns {number}
   */
  function column() {
    try {
      return rl.getCursorPos().cols;
    } catch {
      return (rl.getPrompt?.() ?? "").length + (rl.cursor ?? 0);
    }
  }

  /**
   * @param {number} rows
   * @param {number} col
   * @returns {string}
   */
  function backToInput(rows, col) {
    return up(rows) + CR + right(col);
  }

  function clear() {
    if (!painted) return;
    const col = column();
    // 한 줄 내려가 거기서부터 아래를 다 지우고, 올라와 제자리로.
    output.write(NL + CLEAR_DOWN + backToInput(1, col));
    painted = 0;
  }

  function close() {
    clear();
    items = [];
    selected = 0;
  }

  function paint() {
    clear();
    if (!items.length) return;

    const { start, end } = computeWindow(items.length, selected);
    const window = items.slice(start, end);
    const width = Math.max(...window.map((i) => i.value.length));
    const cap = (output.columns ?? 80) - 1;

    /** @type {string[]} */
    const lines = [];
    for (const [offset, item] of window.entries()) {
      const index = start + offset;
      const on = index === selected;
      const mark = on ? ui.cyan("❯") : " ";
      const label = on ? ui.cyan(ui.bold(item.value.padEnd(width))) : ui.cyan(item.value.padEnd(width));
      // 폭을 넘기면 줄이 접혀 올라올 줄 수가 틀리고, 그럼 메뉴가 똑같이 쌓인다.
      lines.push(clipToWidth(`  ${mark} ${label}  ${ui.dim(item.hint)}`, cap));
    }
    const hidden = items.length - window.length;
    if (hidden > 0) lines.push(clipToWidth(`    ${ui.dim(`… ${hidden}개 더  (↑↓ 이동)`)}`, cap));

    const col = column();
    output.write(NL + CLEAR_DOWN + lines.join(NL) + backToInput(lines.length, col));
    painted = lines.length;
  }



  /**
   * 입력 줄을 통째로 바꾼다.
   * Ctrl+U(줄 처음까지 삭제) 후 다시 타이핑하는 방식이라 readline의 내부 상태와 어긋나지 않는다.
   * @param {string} text
   */
  function setLine(text) {
    writing = true;
    try {
      rl.write(null, { ctrl: true, name: "u" });
      rl.write(text);
    } finally {
      // setImmediate로 푸는 이유 — rl.write가 낸 keypress들이 이 틱에 아직 남아 있다.
      setImmediate(() => { writing = false; });
    }
  }

  /** @param {number} delta */
  function move(delta) {
    if (!items.length) return;
    selected = (selected + delta + items.length) % items.length;
    const item = items[selected];
    if (item) setLine(item.value);
    paint();
  }

  function refresh() {
    const line = rl.line ?? "";
    if (!line.startsWith("/")) {
      close();
      return;
    }
    // move()가 바꾼 줄은 writing 잠금 때문에 여기로 오지 않는다 — 사용자가 친 것만 온다.
    items = source(line);
    selected = 0;
    paint();
  }

  /**
   * @param {string | undefined} str
   * @param {{ name?: string, ctrl?: boolean, shift?: boolean, meta?: boolean } | undefined} key
   */
  function onKeypress(str, key) {
    if (writing) return;
    const name = key?.name;

    // 메뉴가 떠 있을 때만 방향키·Tab을 가로챈다.
    if (painted && (name === "up" || name === "down" || name === "tab")) {
      /*
       * readline도 같은 키를 처리한다(위·아래는 히스토리, Tab은 completer).
       * 우리가 먼저 줄을 바꾸고 setImmediate로 한 번 더 덮어써서 최종 상태를 확정한다.
       */
      const delta = name === "up" ? -1 : 1;
      const step = name === "tab" && key?.shift ? -1 : delta;
      setImmediate(() => move(step));
      return;
    }

    if (name === "escape") {
      close();
      return;
    }

    if (name === "return" || name === "enter") {
      clear();
      painted = 0;
      return;
    }

    // 그 외 입력은 필터가 바뀐 것으로 보고 다시 계산한다.
    setImmediate(refresh);
  }

  input.on("keypress", onKeypress);

  return {
    close,
    dispose() {
      close();
      input.off("keypress", onKeypress);
    },
  };
}
