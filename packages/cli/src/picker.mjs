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

import { clipToWidth, visibleLength, wrapToWidth } from "./width.mjs";

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
 * @param {string} [args.header]  짧은 주제말
 * @param {readonly import("./diff.mjs").PreviewLine[]} [args.preview]  질문 위에 보여 줄 미리보기 (승인 창의 diff)
 * @param {number} [args.height]  터미널 줄 수. 미리보기가 화면을 넘지 않게 자르는 데 쓴다
 * @returns {string[]}
 */
export function renderPicker({ question, options, cursor, checked, multiSelect, width, ui, header, preview, height }) {
  const cap = Math.max(20, width - 1);
  const { lines, push } = lineSink(cap, ui);

  /*
   * 주제말을 테두리로 두르는 이유.
   *
   * 질문이 길면(경로·규모가 들어간다) 무엇에 관한 질문인지가 묻힌다.
   * 한 마디로 먼저 걸어 주면 읽기 전에 감이 온다.
   */
  if (header) {
    /*
     * 테두리 폭은 **안에 들어갈 글자 칸 수**로 계산한다.
     * 여백까지 센 길이로 테두리를 그리면 상자가 글자보다 넣어져 어긋난다(실측).
     * 한글은 두 칸이라 글자 수로 세면 더 크게 벌어진다.
     */
    const label = clipToWidth(header.trim(), cap - 4);
    const rule = "─".repeat(visibleLength(label) + 2);
    lines.push(ui.dim(`╭${rule}╮`));
    lines.push(`${ui.dim("│")} ${ui.cyan(ui.bold(label))} ${ui.dim("│")}`);
    lines.push(ui.dim(`╰${rule}╯`));
    lines.push("");
  }

  /*
   * 모든 줄을 표시를 붙이기 **전에** 접는다.
   *
   * 질문문에 줄바꿈이 들어 있거나 줄이 폭을 넘으면 실제로 찍히는 줄 수가 늘어난다.
   * 그걸 한 줄로 세면 지울 때 모자라 매번 몇 줄씩 남는다(실측).
   */
  /*
   * 미리보기는 질문 위에 둔다 — "무엇이 바뀌는지" 를 보고 나서 "할까요?" 를 읽는 순서다.
   * 플러그인에서 Claude Code 가 그렇게 보여 줬다.
   *
   * 높이를 먼저 계산한다. 화면보다 긴 창은 위쪽이 스크롤로 밀려나고, 그 순간
   * 다시 그릴 때 올라갈 줄 수가 틀려 화면이 쌓인다(실측으로 겪은 고장이다).
   */
  if (preview?.length) {
    const questionRows = question.split("\n").reduce((n, part) => n + wrapToWidth(part, cap - 2).length, 0);
    const shownOptions = Math.min(options.length, MAX_VISIBLE);
    const fixed = lines.length + questionRows + shownOptions + 6; // 빈 줄·안내 줄·여유
    const budget = Math.max(4, Math.min(PREVIEW_MAX, (height ?? 40) - fixed));
    lines.push(...renderPreview(preview, cap, ui, budget));
    lines.push("");
  }

  // 도구 기록(● 줄)과 같은 표시를 쓴다 — 화면에서 기호가 한 종류일수록 읽힌다.
  push(question, ui.bold, ui.yellow("●"));
  lines.push("");

  const { start, end } = windowFor(options.length, cursor);
  if (start > 0) push(`⋯ 위로 ${start}개 더`, ui.dim, " ");

  for (let i = start; i < end; i += 1) {
    const here = i === cursor;
    const { title, detail } = splitOption(/** @type {string} */ (options[i]));
    const mark = multiSelect ? (checked.has(i) ? "◉ " : "◯ ") : "";
    // 번호를 보여 준다 — 번호로도 고를 수 있다는 것을 화면이 말해야 알게 된다.
    push(`${mark}${i + 1}. ${title}`, here ? (t) => ui.cyan(ui.bold(t)) : ui.bold, here ? ui.cyan("❯") : " ");
    // 설명은 한 칸 더 들여써 제목과 구분한다.
    if (detail) push(`   ${detail}`, ui.dim, " ");
  }
  if (end < options.length) push(`⋯ 아래로 ${options.length - end}개 더`, ui.dim, " ");

  lines.push("");
  push(
    multiSelect
      ? "↑↓ 이동 · Space 선택 · Enter 확정 · 번호 입력 · Esc 건너뜀"
      : "↑↓ 이동 · Enter 선택 · 번호 입력 · Esc 건너뜀",
    ui.dim,
    " ",
  );
  return lines;
}

/** 미리보기에 쓸 줄 수 상한. 터미널이 커도 이보다 길면 읽지 않고 누른다. */
const PREVIEW_MAX = 30;

/**
 * 승인 창의 diff 를 그린다.
 *
 * **접지 않고 자른다.** 한 줄이 두 줄로 접히면 줄 번호 칸이 어긋나 diff 로 안 읽히고,
 * 무엇보다 찍힌 줄 수가 틀려 다시 그릴 때 잔상이 남는다. 폭을 넘는 줄은 끝을 `…` 로 자른다.
 *
 * @param {readonly import("./diff.mjs").PreviewLine[]} preview
 * @param {number} cap      한 줄 최대 칸 수
 * @param {{ dim: (s: string) => string, red?: (s: string) => string, green?: (s: string) => string }} ui
 * @param {number} maxRows  이 줄 수를 넘기지 않는다
 * @returns {string[]}
 */
export function renderPreview(preview, cap, ui, maxRows) {
  const red = ui.red ?? ((/** @type {string} */ s) => s);
  const green = ui.green ?? ((/** @type {string} */ s) => s);
  const digits = Math.max(1, ...preview.map((l) => String(l.no ?? "").length));
  // 탭은 폭이 들쭉날쭉하고, 제어 문자는 화면을 망가뜨린다. 그리기 전에 치운다.
  const clean = (/** @type {string} */ s) => s.replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

  /** @param {import("./diff.mjs").PreviewLine} line */
  const draw = (line) => {
    if (line.kind === "note") return ui.dim(`  ${clipToWidth(clean(line.text), cap - 2)}`);
    if (line.kind === "gap") return ui.dim(`  ${" ".repeat(digits)} ⋯`);
    const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    const gutter = `  ${String(line.no ?? "").padStart(digits)} ${sign} `;
    const body = clipToWidth(clean(line.text), Math.max(4, cap - visibleLength(gutter)));
    const text = `${gutter}${body}`;
    return line.kind === "add" ? green(text) : line.kind === "del" ? red(text) : ui.dim(text);
  };

  if (preview.length <= maxRows) return preview.map(draw);
  const shown = preview.slice(0, Math.max(1, maxRows - 1)).map(draw);
  shown.push(ui.dim(`  … ${preview.length - (maxRows - 1)}줄 더`));
  return shown;
}

/**
 * 선택지를 제목과 설명으로 가른다.
 *
 * 스킬들이 이미 "제목 — 설명" 꼴로 쓰고 있다(harness-init 의 구성 선택 등).
 * 그걸 한 줄로 두면 제목이 설명에 묻혀 무엇을 고르는지 한눈에 안 들어온다.
 *
 * @param {string} text
 * @returns {{ title: string, detail: string }}
 */
export function splitOption(text) {
  const one = String(text ?? "").trim();
  for (const sep of [" — ", " - ", " – "]) {
    const at = one.indexOf(sep);
    // 너무 앞에서 갈라지면 제목이 토막이 된다. 구분자가 아니라 내용일 수 있다.
    if (at > 1) return { title: one.slice(0, at).trim(), detail: one.slice(at + sep.length).trim() };
  }
  return { title: one, detail: "" };
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
  // 도구 기록(● 줄)과 같은 표시를 쓴다 — 화면에서 기호가 한 종류일수록 읽힌다.
  push(question, ui.bold, ui.yellow("●"));
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
 * @param {string} [args.header]  짧은 주제말
 * @param {NodeJS.ReadStream} args.input
 * @param {NodeJS.WriteStream} args.output
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @param {() => void} [args.onInterrupt]  선택지 위에서 Ctrl+C 를 누른 경우
 * @param {readonly import("./diff.mjs").PreviewLine[]} [args.preview]  질문 위에 보여 줄 미리보기.
 *        고른 뒤에는 남기지 않는다 — 기록은 질문과 답 한 줄이면 된다
 * @returns {Promise<string[]>}
 */
export function pick({ question, options, multiSelect = false, header, input, output, ui, onInterrupt, preview }) {
  return new Promise((resolve) => {
    let cursor = 0;
    /** @type {Set<number>} */
    const checked = new Set();
    let drawn = 0;

    const paint = () => {
      const lines = renderPicker({
        question, options, cursor, checked, multiSelect,
        width: output.columns ?? 80, ui,
        ...(header ? { header } : {}),
        ...(preview?.length ? { preview, height: output.rows ?? 40 } : {}),
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

/**
 * 자유 입력 질문 — 선택지가 없을 때.
 *
 * 왜 따로 만드는가. 예전에는 이 경우만 REPL 의 줄 큐로 받았다. 그런데 턴이 도는
 * 동안에는 readline 이 물러나 있고, 대신 들어선 typeahead 는 **화면에 글자를 찍지
 * 않는다** — 친 글을 바닥 판에 보여 주는 구조인데, 질문을 띄우려고 그 판을 걷어 낸
 * 상태다. 그래서 사용자는 눈먼 채로 타이핑하게 된다. 실측으로 이렇게 보고됐다.
 *
 *   "이 상황에서 입력이 안 되. 엔터도 안 쳐지고"
 *
 * 선택지 질문이 쓰는 방법을 그대로 쓴다 — keypress 를 직접 받고 우리가 그린다.
 * 줄 큐와 무관해지므로 미리 쳐 둔 명령이 답으로 먹히는 일도 없다.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {string} [args.header]
 * @param {NodeJS.ReadStream} args.input
 * @param {NodeJS.WriteStream} args.output
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @param {(how: "Ctrl+C") => void} [args.onInterrupt]
 * @returns {Promise<string[]>} 답 한 줄. 건너뛰면 빈 배열
 */
export function askText({ question, header, input, output, ui, onInterrupt }) {
  return new Promise((resolve) => {
    let typed = "";
    let drawn = 0;

    const width = () => Math.max(20, (output.columns ?? 80) - 1);

    const draw = () => {
      /** @type {string[]} */
      const lines = [""];
      if (header) lines.push(`  ${ui.dim(header)}`);
      for (const l of wrapToWidth(`${ui.yellow("●")} ${ui.bold(question)}`, width())) lines.push(l);
      lines.push("");
      // 커서 자리를 ▏로 표시한다 — 실제 커서는 숨겨 두었다.
      lines.push(clipToWidth(`  ${ui.cyan("답")} ${ui.dim(">")} ${typed}${ui.dim("▏")}`, width()));
      lines.push(`  ${ui.dim("Enter 확인 · Esc 건너뜀")}`);
      output.write(cursorUp(drawn) + CLEAR_DOWN + lines.join("\n") + "\n");
      drawn = lines.length;
    };

    /* 선택지 질문과 같은 이유로 readline 의 키 처리를 잠시 뗀다. */
    const saved = /** @type {Function[]} */ (input.listeners("keypress"));
    for (const fn of saved) input.off("keypress", /** @type {any} */ (fn));
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    output.write(HIDE_CURSOR);

    /** @param {string[]} answer */
    const finish = (answer) => {
      input.off("keypress", onKey);
      for (const fn of saved) input.on("keypress", /** @type {any} */ (fn));
      input.setRawMode?.(wasRaw);
      output.write(SHOW_CURSOR);
      // 고른 결과를 한 줄로 남긴다. 질문 블록을 걷어 내고 답만 남겨야 기록이 읽힌다.
      const shown = answer[0]?.trim() ? answer[0] : ui.dim("(건너뜀)");
      output.write(cursorUp(drawn) + CLEAR_DOWN + `  ${ui.cyan("답")} ${ui.dim(">")} ${shown}\n`);
      resolve(answer);
    };

    /**
     * @param {string | undefined} ch
     * @param {{ name?: string, ctrl?: boolean, meta?: boolean } | undefined} key
     */
    const onKey = (ch, key) => {
      if (key?.ctrl && key.name === "c") {
        finish([]);
        onInterrupt?.("Ctrl+C");
        return;
      }
      // ESC 는 "이 질문 건너뜀"이다. 작업 전체 중단이 아니다 — 선택지 질문과 같다.
      if (key?.name === "escape") return finish([]);
      if (key?.name === "return" || key?.name === "enter") return finish(typed.trim() ? [typed.trim()] : []);
      if (key?.name === "backspace") {
        typed = typed.slice(0, -1);
        return draw();
      }
      /* 붙여넣기로 한 번에 들어오는 경우가 있다 — 여러 글자를 통째로 받는다. */
      if (ch && !key?.ctrl && !key?.meta) {
        const add = [...ch].filter((c) => {
          const code = c.codePointAt(0) ?? 0;
          return code >= 0x20 && code !== 0x7f;
        }).join("");
        if (add) {
          typed += add;
          draw();
        }
      }
    };

    input.on("keypress", onKey);
    draw();
  });
}
