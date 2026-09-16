/*
 * 지나간 턴을 되짚어 보는 전체 화면.
 *
 * 왜 전체 화면인가 — 우리 화면은 흘러가는 기록이라 **이미 지나간 자리를 다시 그릴 수
 * 없다.** 위로 스크롤한 서브에이전트 블록을 그 자리에서 펼치려면 그 아래 모든 줄을
 * 다시 그려야 하는데, 터미널은 스크롤백을 우리에게 돌려주지 않는다.
 *
 * 그래서 방식을 바꾼다. 대체 화면 버퍼(ESC[?1049h)로 **딴 장을 펴서** 거기서 마음껏
 * 그리고, 나올 때 되돌린다(ESC[?1049l). 원래 기록은 한 글자도 건드리지 않는다 —
 * 터미널이 버퍼 두 개를 따로 들고 있기 때문이다. vim·less 가 쓰는 그 방법이다.
 *
 * 화면을 소유하는 동안에는 readline 의 키 처리를 떼어 둔다. picker.mjs 와 같은 수법이고
 * 이유도 같다 — 안 떼면 같은 키가 두 번 해석된다.
 */

import { clipToWidth, visibleLength } from "./width.mjs";
import { allTurns, linesOf } from "./record.mjs";
import { elapsed } from "./activity.mjs";

const ESC = String.fromCharCode(27);
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const HOME = `${ESC}[H`;
const CLEAR = `${ESC}[2J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const NEWLINE = String.fromCharCode(10);

/**
 * 목록에 뜨는 줄 하나.
 * @typedef {object} Row
 * @property {"turn" | "agent" | "root"} kind
 * @property {string} text
 * @property {import("./record.mjs").TurnRecord} turn
 * @property {string} [owner]  agent 행이면 그 Task 호출 id
 */

/**
 * 기록을 목록 행으로 편다. 최신 턴이 위로 온다.
 *
 * 펼쳐진 턴만 자식을 보여 준다. 전부 펴 두면 하네스 초기화 한 번에 수천 줄이라
 * 목록이 그 자체로 또 하나의 흘러가는 기록이 된다.
 *
 * @param {readonly import("./record.mjs").TurnRecord[]} turns
 * @param {Set<number>} open  펼쳐 둔 턴 id
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string, green: (s: string) => string, yellow: (s: string) => string, red: (s: string) => string }} ui
 * @returns {Row[]}
 */
export function buildRows(turns, open, ui) {
  /** @type {Row[]} */
  const rows = [];
  for (const turn of [...turns].reverse()) {
    const mark = turn.status === "running" ? ui.yellow("◍") : turn.status === "failed" ? ui.red("●") : ui.green("●");
    const took = turn.endedAt ? elapsed(turn.endedAt - turn.startedAt) : "도는 중";
    const tag = turn.background ? ui.dim(" [백그라운드]") : "";
    const arrow = open.has(turn.id) ? "▾" : "▸";
    rows.push({
      kind: "turn",
      turn,
      text: `${arrow} ${mark} ${ui.bold(turn.title || "(제목 없음)")}${tag}  ${ui.dim(`${took} · 에이전트 ${turn.agents.length}`)}`,
    });
    if (!open.has(turn.id)) continue;

    // 본인이 낸 줄. 서브에이전트에 귀속되지 않은 것들이다.
    const own = linesOf(turn);
    if (own.length) rows.push({ kind: "root", turn, text: `    ${ui.dim(`본인 출력 ${own.length}줄`)}` });

    for (const block of turn.agents) {
      const lines = linesOf(turn, block.id).length;
      const dur = block.endedAt ? elapsed(block.endedAt - block.startedAt) : "도는 중";
      rows.push({
        kind: "agent",
        turn,
        owner: block.id,
        text: `    ${ui.cyan("└")} ${block.label}  ${ui.dim(`${lines}줄 · 도구 ${block.tools}회 · ${dur}`)}`,
      });
    }
  }
  return rows;
}

/**
 * 고른 행의 본문.
 * @param {Row} row
 * @returns {string[]}
 */
export function bodyOf(row) {
  if (row.kind === "agent") return linesOf(row.turn, row.owner);
  if (row.kind === "root") return linesOf(row.turn);
  // 턴 행에서는 전체를 순서대로 — 누가 냈든 찍힌 차례가 곧 맥락이다.
  return row.turn.lines.map((l) => l.text);
}

/**
 * 한 화면을 그린다.
 *
 * 순수 함수로 둔다 — 터미널 없이 테스트할 수 있어야 그리기 규칙이 고정된다.
 *
 * @param {object} args
 * @param {Row[]} args.rows
 * @param {number} args.cursor
 * @param {string[]} args.body     오른쪽(아래)에 펼쳐 보일 본문
 * @param {number} args.bodyTop    본문 스크롤 위치
 * @param {number} args.columns
 * @param {number} args.rowsHeight 터미널 높이
 * @param {any} args.ui
 * @returns {string[]}
 */
export function renderViewer({ rows, cursor, body, bodyTop, columns, rowsHeight, ui }) {
  const width = Math.max(20, columns - 1);
  /** @type {string[]} */
  const out = [];
  out.push(ui.bold(" 지나간 작업 ") + ui.dim(" ↑↓ 이동 · Enter 펼치기 · PgUp/PgDn 본문 · q 나가기"));
  out.push(ui.dim("─".repeat(width)));

  /*
   * 목록은 화면의 절반까지만 쓴다. 나머지는 본문 자리다.
   * 목록이 길면 커서가 가운데 오도록 창을 민다 — 위아래 맥락이 같이 보여야 고르기 쉽다.
   */
  const listHeight = Math.max(3, Math.min(rows.length, Math.floor((rowsHeight - 5) / 2)));
  const start = Math.max(0, Math.min(cursor - Math.floor(listHeight / 2), rows.length - listHeight));
  for (let i = start; i < Math.min(rows.length, start + listHeight); i += 1) {
    const row = /** @type {Row} */ (rows[i]);
    const selected = i === cursor;
    const text = `${selected ? ui.cyan("❯") : " "} ${row.text}`;
    out.push(clipToWidth(text, width));
  }
  if (!rows.length) out.push(ui.dim("  아직 기록이 없다."));

  out.push(ui.dim("─".repeat(width)));
  const room = Math.max(1, rowsHeight - out.length - 1);
  const slice = body.slice(bodyTop, bodyTop + room);
  for (const line of slice) out.push(clipToWidth(line, width));
  if (body.length > bodyTop + room) {
    out.push(ui.dim(`  … ${body.length - bodyTop - room}줄 더 (PgDn)`));
  }
  /*
   * 마지막에 한 번 더 자른다.
   *
   * 자르기를 각 push 자리에 흩어 두면 새로 더한 줄이 빠진다 — 실측으로 머리글과
   * "더 있다" 줄이 그렇게 빠져 폭을 넘었다. 넘은 줄은 터미널이 접어 버리고, 그러면
   * 우리가 센 줄 수와 화면이 어긋나 아래가 잘린다. 나가는 문을 하나로 둔다.
   */
  return out.map((l) => clipToWidth(l, width));
}

/**
 * 뷰어를 연다. 나갈 때까지 기다린다.
 *
 * @param {object} args
 * @param {NodeJS.ReadStream} args.input
 * @param {NodeJS.WriteStream} args.output
 * @param {any} args.ui
 * @returns {Promise<void>}
 */
export function openViewer({ input, output, ui }) {
  return new Promise((resolve) => {
    const turns = allTurns();
    /** 마지막 턴은 펴 둔다 — 대개 방금 본 것을 되짚으려고 연다. */
    const open = new Set(turns.length ? [/** @type {any} */ (turns[turns.length - 1]).id] : []);
    let cursor = 0;
    let bodyTop = 0;
    /** @type {Row[]} */
    let rows = buildRows(turns, open, ui);

    /*
     * readline 의 키 처리를 떼어 둔다. picker.mjs 와 같은 이유다 —
     * 안 떼면 우리가 읽은 키를 readline 도 읽어 프롬프트가 딴 화면에 찍힌다.
     */
    const saved = /** @type {Function[]} */ (input.listeners("keypress"));
    for (const fn of saved) input.off("keypress", /** @type {any} */ (fn));
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    output.write(ALT_ON + HIDE_CURSOR);

    const draw = () => {
      const row = rows[cursor];
      const body = row ? bodyOf(/** @type {Row} */ (row)) : [];
      const lines = renderViewer({
        rows,
        cursor,
        body,
        bodyTop,
        columns: output.columns ?? 80,
        rowsHeight: output.rows ?? 24,
        ui,
      });
      output.write(HOME + CLEAR + lines.join(NEWLINE));
    };

    const finish = () => {
      input.off("keypress", onKey);
      for (const fn of saved) input.on("keypress", /** @type {any} */ (fn));
      input.setRawMode?.(wasRaw);
      /*
       * 대체 화면을 닫으면 원래 기록이 그대로 돌아온다 — 우리가 다시 그리지 않는다.
       * 직접 다시 그리려 들면 스크롤백이 두 벌이 되고, 그 시점부터 무엇이 진짜인지 모른다.
       */
      output.write(SHOW_CURSOR + ALT_OFF);
      resolve();
    };

    /**
     * @param {string} _str
     * @param {{ name?: string, ctrl?: boolean }} key
     */
    const onKey = (_str, key) => {
      const name = key?.name ?? "";
      if (name === "q" || name === "escape" || (key?.ctrl && name === "c")) return finish();

      if (name === "up" || name === "k") {
        cursor = Math.max(0, cursor - 1);
        bodyTop = 0;
      } else if (name === "down" || name === "j") {
        cursor = Math.min(Math.max(0, rows.length - 1), cursor + 1);
        bodyTop = 0;
      } else if (name === "return" || name === "space" || name === "right" || name === "left") {
        const row = rows[cursor];
        if (row && row.kind === "turn") {
          const id = row.turn.id;
          if (open.has(id)) open.delete(id);
          else open.add(id);
          rows = buildRows(turns, open, ui);
          cursor = Math.min(cursor, Math.max(0, rows.length - 1));
          bodyTop = 0;
        }
      } else if (name === "pagedown") {
        bodyTop += Math.max(1, Math.floor((output.rows ?? 24) / 2));
      } else if (name === "pageup") {
        bodyTop = Math.max(0, bodyTop - Math.max(1, Math.floor((output.rows ?? 24) / 2)));
      } else if (name === "home") {
        bodyTop = 0;
      }
      draw();
    };

    input.on("keypress", onKey);
    draw();
  });
}

export { visibleLength };
