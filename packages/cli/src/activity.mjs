/*
 * 작업 중 상태 표시.
 *
 * 에이전트가 도는 동안 무슨 일이 얼마나 벌어지고 있는지 한 줄로 보여 준다.
 * 없으면 긴 작업이 그냥 멈춘 것처럼 보인다.
 *
 * 설계에서 중요한 선택 하나 — **프롬프트에 상태줄을 붙박이로 달지 않는다.**
 * 처음엔 그렇게 했는데, 사용자가 Enter를 치면 readline이 줄바꿈을 내보내 커서가
 * 한 줄 내려가고, 우리가 세어 둔 "그린 줄 수"와 어긋나 상태줄이 화면에 남았다.
 * 출력할 때마다 하나씩 쌓였다(실측).
 *
 * 그래서 상태 표시는 **한 줄, 제자리 갱신**으로만 한다. Enter 직후부터 턴이 끝날
 * 때까지만 살아 있고, 그 구간에는 프롬프트가 화면에 없으므로 커서 다툼이 없다.
 * 한 줄만 다루니 접힘 계산도 필요 없다.
 */

import { clipToWidth } from "./width.mjs";

const ESC = String.fromCharCode(27);
/** 커서가 있는 줄을 끝까지 지운다. */
const CLEAR_LINE = `${ESC}[2K`;
const COL_ZERO = "\r";

/** 회전자. 유니코드 점 패턴이라 대부분의 터미널에서 폭이 1이다. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;

/**
 * @typedef {object} ActivityState
 * @property {string} label        지금 도는 역할
 * @property {string} [tool]       마지막으로 부른 도구
 * @property {number} outputTokens
 * @property {number} [queued]     처리 대기 중인 입력 줄 수
 */

/**
 * @param {object} args
 * @param {NodeJS.WriteStream} args.output
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @returns {{
 *   start: (label: string) => void,
 *   set: (patch: Partial<ActivityState>) => void,
 *   bump: (tokens: number) => void,
 *   suspend: () => void,
 *   resume: () => void,
 *   stop: () => void,
 * }}
 */
export function createActivity({ output, ui }) {
  const active = Boolean(output.isTTY);
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let frame = 0;
  let startedAt = 0;
  let painted = false;
  /** @type {ActivityState} */
  let state = { label: "", outputTokens: 0 };

  function line() {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    const bits = [ui.cyan(state.label), ui.dim(`${seconds}s`)];
    if (state.outputTokens > 0) bits.push(ui.dim(`↓${compact(state.outputTokens)}`));
    if (state.tool) bits.push(ui.dim(state.tool));
    // 작업 중에 친 입력이 사라진 게 아니라 줄 서 있다는 것을 보여 준다.
    if (state.queued) bits.push(ui.yellow(`⌨ ${state.queued}건 대기`));
    return `  ${ui.cyan(FRAMES[frame % FRAMES.length] ?? "")} ${bits.join(ui.dim(" · "))}`;
  }

  function paint() {
    if (!active) return;
    // 폭을 넘으면 줄이 접히고, 한 줄만 지우는 이 코드와 어긋나 잔상이 남는다.
    output.write(COL_ZERO + CLEAR_LINE + clipToWidth(line(), (output.columns ?? 80) - 1));
    painted = true;
  }

  /** 화면에서 지운다. 출력이 끼어들 때와 끝날 때 쓴다. */
  function erase() {
    if (!painted) return;
    output.write(COL_ZERO + CLEAR_LINE);
    painted = false;
  }

  return {
    /** @param {string} label */
    start(label) {
      state = { label, outputTokens: 0 };
      startedAt = Date.now();
      frame = 0;
      if (!active) return;
      paint();
      timer = setInterval(() => {
        frame += 1;
        paint();
      }, TICK_MS);
      // 이 타이머가 프로세스 종료를 막으면 안 된다.
      timer.unref?.();
    },
    /** @param {Partial<ActivityState>} patch */
    set(patch) {
      state = { ...state, ...patch };
      if (painted) paint();
    },
    /** @param {number} tokens */
    bump(tokens) {
      state.outputTokens += tokens;
      if (painted) paint();
    },
    suspend: erase,
    resume: paint,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      erase();
    },
  };
}

/**
 * @param {number} n
 * @returns {string}
 */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
