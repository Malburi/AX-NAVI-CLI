/*
 * 이어서 열 때 이전 대화를 다시 보여 준다.
 *
 * 이게 없으면 "이어서 시작 · 2턴" 한 줄만 뜨고 화면은 비어 있다. 무엇을 이어가는
 * 중인지 알 수 없으니 사용자는 결국 앞 질문을 다시 쓰게 된다.
 *
 * 다시 보여 줄 내용을 **우리가 따로 쌓아 둔다.** 위임 경로(claude CLI)는 대화를
 * 그쪽이 들고 있어서 conversation.turns 가 비어 있기 때문이다(실측).
 *
 * 긴 답변을 통째로 쏟으면 터미널이 이전 대화로 가득 찬다. 마디마다 몇 줄만 보이고
 * 나머지는 줄 수로 알린다 — 도구 기록을 접는 방식과 같다.
 */

import { clipToWidth, visibleLength, wrapToWidth } from "./width.mjs";

/** 한 마디에서 보여 줄 줄 수. */
const LINES_PER_MESSAGE = 6;
/** 화면에 되살릴 마디 수. 그보다 오래된 것은 몇 개인지만 알린다. */
const MESSAGES_SHOWN = 8;

/**
 * @param {object} args
 * @param {readonly import("@ax-navi/core").SessionMessage[]} args.messages
 * @param {number} args.width
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string }} args.ui
 * @param {number} [args.shown]  되살릴 마디 수 (테스트용)
 * @returns {string[]}
 */
export function renderReplay({ messages, width, ui, shown = MESSAGES_SHOWN }) {
  if (!messages.length) return [];

  const cap = Math.max(20, width - 1);
  const start = Math.max(0, messages.length - shown);
  /** @type {string[]} */
  const out = [];

  if (start > 0) {
    // 잘라 냈다는 사실을 숨기지 않는다 — 앞 내용이 없는 이유가 된다.
    out.push(clipToWidth(ui.dim(`  ⋯ 앞선 ${start}마디는 접었습니다`), cap));
  }

  for (const message of messages.slice(start)) {
    const mine = message.role === "user";
    const head = mine ? ui.cyan("›") : " ";
    const paint = mine ? ui.bold : ui.dim;

    const lines = wrapToWidth(message.text, cap - 2);
    const visible = lines.slice(0, LINES_PER_MESSAGE);
    visible.forEach((line, i) => {
      out.push(clipToWidth(`${i === 0 ? head : " "} ${paint(line)}`, cap));
    });
    const hidden = lines.length - visible.length;
    if (hidden > 0) out.push(clipToWidth(ui.dim(`   … +${hidden}줄`), cap));

    // 사람 말과 답 사이를 띄운다. 붙여 두면 누가 한 말인지 눈으로 안 갈린다.
    if (!mine) out.push("");
  }

  // 마지막 빈 줄은 프롬프트가 바로 붙게 둔다.
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * 되살린 대화를 감싸는 머리·꼬리 줄.
 *
 * 지금 치는 것과 예전 것이 구분되지 않으면 대화가 이어졌다는 사실 자체가 혼란이 된다.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {number} args.turns
 * @param {number} args.width
 * @param {{ dim: (s: string) => string }} args.ui
 * @returns {{ head: string, tail: string }}
 */
export function replayFrame({ title, turns, width, ui }) {
  const cap = Math.max(20, width - 1);
  const label = `  이전 대화 · ${turns}턴${title ? ` · ${title}` : ""} `;
  /*
   * 제목이 길면 먼저 자른다 — 길이만 맞추고 자르지 않으면 틀이 폭을 넘어 접힌다.
   * 접히면 이후 줄 수 계산이 어긋난다 — 테스트가 잡았다(폭 30에서 152칸).
   */
  const rule = (/** @type {string} */ text) => {
    const head = clipToWidth(text, cap);
    return ui.dim(`${head}${"─".repeat(Math.max(0, cap - visibleLength(head)))}`);
  };
  return { head: rule(`─${label}`), tail: ui.dim("─".repeat(cap)) };
}
