/*
 * 작업 중 화면 바닥에 붙는 판.
 *
 * 에이전트가 도는 동안 무슨 일이 얼마나 벌어지고 있는지, 그리고 지금 무엇을 치고
 * 있는지를 함께 보여 준다. 없으면 긴 작업이 그냥 멈춘 것처럼 보인다.
 *
 * 한때 한 줄만 그렸다. 프롬프트에 붙박이를 달았더니 Enter 가 커서를 한 줄 내려
 * 우리가 센 줄 수와 어긋났기 때문이다(실측: 출력마다 상태줄이 쌓였다).
 *
 * 지금은 여러 줄을 그린다. 조건이 달라졌다 — 턴이 도는 동안에는 readline 을 물러나게
 * 하고 키를 직접 받으므로 **화면 바닥을 온전히 우리가 소유한다.** 다툴 커서가 없으니
 * 줄 수를 정확히 세면 된다. 대신 두 가지를 지킨다.
 *   - 줄마다 폭을 넘지 않게 자른다. 접히면 올라갈 줄 수가 틀린다.
 *   - 커서 이동은 전부 상대 이동이다. 화면이 스크롤해도 함께 밀린다.
 */

import { clipToWidth, visibleLength } from "./width.mjs";

const ESC = String.fromCharCode(27);
/** 커서 아래를 끝까지 지운다. */
const CLEAR_DOWN = `${ESC}[0J`;
const COL_ZERO = "\r";
const NEWLINE = String.fromCharCode(10);
/** @param {number} n */
const up = (n) => (n > 0 ? `${ESC}[${n}A` : "");

/** 회전자. 유니코드 점 패턴이라 대부분의 터미널에서 폭이 1이다. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;

/**
 * @typedef {object} ActivityState
 * @property {string} label        지금 도는 역할
 * @property {string} [tool]       마지막으로 부른 도구
 * @property {string} [subagent]   지금 도는 서브에이전트 이름
 * @property {string} [typing]     지금 치고 있는 글
 * @property {number} outputTokens
 * @property {number} [queued]     처리 대기 중인 입력 줄 수
 * @property {string} [runtime]    실행 경로 (예: "claude-cli 2.1.259")
 * @property {string} [model]      이번 턴이 쓰는 등급
 * @property {string} [mode]       지금 실행 모드
 * @property {number} [contextTokens]
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
  /** 지금 화면에 그려 둔 줄 수. 지울 때 그만큼 올라간다. */
  let painted = 0;
  /*
   * 멈춰 세운 상태. 회전자 타이머는 계속 도니까, 이 표시가 없으면 suspend() 로 지워도
   * 120ms 뒤 타이머가 그대로 다시 그린다 — 질문의 입력 자리를 덮어써서 어디에 답해야
   * 할지 안 보이게 된다(실측: AskUserQuestion 선택 불가).
   */
  let suspended = false;
  /** @type {ActivityState} */
  let state = { label: "", outputTokens: 0 };

  /**
   * 화면 바닥에 그릴 줄들.
   * @returns {string[]}
   */
  function panel() {
    const cap = Math.max(20, (output.columns ?? 80) - 1);
    const rule = ui.dim("─".repeat(cap));

    // 입력 줄 — 작업 중에 친 글이 여기 그대로 보인다.
    const typed = state.typing ?? "";
    const waiting = state.queued ? ui.yellow(`  ⌨ ${state.queued}건 대기`) : "";
    // 비어 있으면 비워 둔다. 안내문을 상주시켜 두면 한 번 읽히고 그 뒤로는 소음이다.
    const input = `${ui.cyan("❯")} ${typed}${ui.dim("▏")}${waiting}`;

    // 진행 줄 — 누가 얼마나 무엇을 하고 있는가.
    const who = state.subagent ? `${state.label} › ${state.subagent}` : state.label;
    const bits = [ui.cyan(who), ui.dim(elapsed(Date.now() - startedAt))];
    if (state.outputTokens > 0) bits.push(ui.dim(`↓ ${compact(state.outputTokens)} tokens`));
    if (state.tool) bits.push(ui.dim(state.tool));
    const left = `${ui.cyan(FRAMES[frame % FRAMES.length] ?? "")} ${bits.join(ui.dim(" · "))}`;

    // 우측 — 무엇으로 돌고 있고 얼마나 실어 보냈는가.
    const right = [
      state.mode,
      state.runtime,
      state.model,
      state.contextTokens ? `Ctx ${compact(state.contextTokens)}` : "",
    ].filter(Boolean).join(" · ");

    return [rule, input, rule, fit(left, right ? ui.dim(right) : "", cap)]
      .map((l) => clipToWidth(l, cap));
  }

  function paint() {
    if (!active || suspended) return;
    const lines = panel();
    /*
     * 다시 그리기 전에 **판의 첫 줄로 올라간다.**
     *
     * 그리고 나면 커서는 마지막 줄 끝에 있다. 거기서 그냥 지우고 써 버리면 앞서 그린
     * 줄들은 그대로 남고 아래에 한 벌 더 쌓인다. 회전자 타이머가 120ms마다 부르므로
     * 순식간에 화면이 판으로 덤인다(실측).
     */
    output.write(COL_ZERO + up(Math.max(0, painted - 1)) + CLEAR_DOWN + lines.join(NEWLINE));
    painted = lines.length;
  }

  /** 화면에서 지운다. 출력이 끼어들 때와 끝날 때 쓴다. */
  function erase() {
    if (!painted) return;
    // 마지막 줄에 서 있으므로 painted-1 만큼 올라간다. 상대 이동이라 스크롤과 함께 밀린다.
    output.write(COL_ZERO + up(painted - 1) + CLEAR_DOWN);
    painted = 0;
  }

  return {
    /** @param {string} label */
    start(label) {
      /*
       * 세션 내내 같은 것은 살려 둔다.
       * 전부 초기화하면 턴 시작 전에 설정한 실행 경로가 지워져 판 오른쪽이 비었다(실측).
       */
      state = { label, outputTokens: 0, ...(state.runtime ? { runtime: state.runtime } : {}), ...(state.mode ? { mode: state.mode } : {}) };
      startedAt = Date.now();
      frame = 0;
      suspended = false;
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
    suspend() {
      suspended = true;
      erase();
    },
    resume() {
      suspended = false;
      paint();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      suspended = true;
      erase();
    },
  };
}

/**
 * 왼쪽과 오른쪽을 한 줄에 밀어 붙인다.
 * 자리가 모자라면 오른쪽을 버린다 — 진행 상황이 더 급하다.
 *
 * @param {string} left
 * @param {string} right
 * @param {number} cap
 * @returns {string}
 */
export function fit(left, right, cap) {
  if (!right) return left;
  const gap = cap - visibleLength(left) - visibleLength(right);
  return gap < 2 ? left : `${left}${" ".repeat(gap)}${right}`;
}

/**
 * 경과 시간.
 *
 * 초로만 보여 주면 긴 작업에서 읽히지 않는다 — 898s 가 얼마인지 암산해야 한다.
 * harness-init 은 실측으로 10분을 넘기는 일이 흔하다.
 *
 * @param {number} ms
 * @returns {string}
 */
export function elapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
