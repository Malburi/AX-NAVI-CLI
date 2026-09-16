/*
 * 지나간 턴의 기록.
 *
 * 우리 화면은 흘러가는 기록(streaming transcript)이라, 한 번 스크롤해 올라간 서브에이전트
 * 블록으로 되돌아가 펼칠 수가 없다. 그래서 **찍는 동시에 남긴다.** 남겨 두면 뒤에서
 * 되짚어 볼 수 있고(viewer.mjs), 백그라운드로 돌린 작업의 출력도 같은 모양으로 담긴다.
 *
 * 설계에서 정한 선
 * - 기록은 **이미 서식이 걸린 줄 그대로** 담는다. 다시 렌더링하면 화면과 기록이 갈라져,
 *   "봤던 것"과 "되짚은 것"이 달라진다. 그건 기록으로서 실격이다.
 * - 줄마다 주인(어느 서브에이전트가 낸 것인가)을 붙인다. 이게 없으면 되짚어도 평평한
 *   덩어리라 누가 무엇을 했는지 다시 알 수 없다 — 지금 화면이 겪던 문제와 같아진다.
 * - 무한히 쌓지 않는다. 긴 세션에서 메모리가 조용히 자란다.
 */

/** 들고 있을 턴 수. 넘으면 오래된 것부터 버린다. */
const KEEP_TURNS = 20;
/** 한 턴이 들고 있을 줄 수. 하네스 초기화는 실측으로 수천 줄을 낸다. */
const KEEP_LINES = 4000;

/**
 * @typedef {object} AgentBlock
 * @property {string} id        Task 호출 id
 * @property {string} label
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {number} tools
 */

/**
 * @typedef {object} TurnRecord
 * @property {number} id
 * @property {string} title      무엇을 시켰는가
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {"running" | "done" | "failed"} status
 * @property {boolean} background  백그라운드로 돌린 작업인가
 * @property {AgentBlock[]} agents
 * @property {Array<{ text: string, owner?: string }>} lines
 */

/** @type {TurnRecord[]} */
let turns = [];
let nextId = 1;

/**
 * 새 턴 기록을 연다.
 * @param {{ title: string, background?: boolean }} args
 * @returns {TurnRecord}
 */
export function openTurn({ title, background = false }) {
  const turn = {
    id: nextId++,
    title,
    startedAt: Date.now(),
    status: /** @type {"running"} */ ("running"),
    background,
    /** @type {AgentBlock[]} */ agents: [],
    /** @type {Array<{ text: string, owner?: string }>} */ lines: [],
  };
  turns.push(turn);
  if (turns.length > KEEP_TURNS) turns = turns.slice(turns.length - KEEP_TURNS);
  return turn;
}

/**
 * 줄 하나를 남긴다. 이미 서식이 걸린 상태로 받는다.
 * @param {TurnRecord} turn
 * @param {string} text
 * @param {string} [owner]  서브에이전트가 낸 줄이면 그 Task 호출 id
 */
export function recordLine(turn, text, owner) {
  turn.lines.push(owner ? { text, owner } : { text });
  // 앞에서부터 버린다 — 끝으로 갈수록 결론에 가깝다.
  if (turn.lines.length > KEEP_LINES) turn.lines.splice(0, turn.lines.length - KEEP_LINES);
}

/**
 * @param {TurnRecord} turn
 * @param {string} id
 * @param {string} label
 */
export function recordAgentStart(turn, id, label) {
  turn.agents.push({ id, label, startedAt: Date.now(), tools: 0 });
}

/**
 * @param {TurnRecord} turn
 * @param {string} id
 * @param {number} tools
 */
export function recordAgentEnd(turn, id, tools) {
  const block = turn.agents.find((a) => a.id === id);
  if (!block) return;
  block.endedAt = Date.now();
  block.tools = tools;
}

/**
 * @param {TurnRecord} turn
 * @param {"done" | "failed"} status
 */
export function closeTurn(turn, status) {
  turn.endedAt = Date.now();
  turn.status = status;
}

/** @returns {readonly TurnRecord[]} 오래된 것부터. */
export function allTurns() {
  return turns;
}

/**
 * 한 턴에서 특정 주인의 줄만 고른다.
 * @param {TurnRecord} turn
 * @param {string} [owner]  주지 않으면 주인 없는 줄(오케스트레이터 본인)만
 * @returns {string[]}
 */
export function linesOf(turn, owner) {
  return turn.lines.filter((l) => l.owner === owner).map((l) => l.text);
}

/** 테스트용. 세션 안에서는 부르지 않는다. */
export function resetRecord() {
  turns = [];
  nextId = 1;
}
