/*
 * 컨텍스트 압축.
 *
 * 대화를 이어가면 turns가 계속 쌓인다. 그냥 두면 컨텍스트 한계에 부딪혀
 * 실패하는데, 실패하는 순간이 하필 대화가 길어져 가장 아까운 때다.
 *
 * 압축 대상을 고르는 원칙 — **도구 결과가 먼저다.**
 * 대화에서 자리를 가장 많이 차지하는 것은 사람의 말도 모델의 답도 아니라
 * grep 결과·파일 본문 같은 도구 출력이고, 그것들은 대개 한 번 쓰이고 역할이 끝난다.
 * 반면 사용자의 요청과 모델의 결론은 짧으면서 나중까지 의미가 있다.
 *
 * 그래서 오래된 도구 결과부터 들어내고, 그래도 모자라면 오래된 턴을 통째로 접는다.
 * 지운 자리에는 지웠다는 표시를 남긴다 — 모델이 "원래 없었다"고 오해하지 않도록.
 */

/** @typedef {import("../../types/llm.js").Turn} Turn */
/** @typedef {import("../../types/llm.js").ContentBlock} ContentBlock */

/*
 * 토큰 추정.
 *
 * 정확한 수는 count_tokens API로만 알 수 있지만, "지금 압축해야 하나"를 판단하려고
 * 매 턴 네트워크를 왕복할 이유는 없다. 여기서는 자릿수만 맞으면 된다.
 * 한글은 문자당 토큰 비율이 영문보다 높아 넉넉하게 잡는다(보수적으로 과대 추정).
 */
const CHARS_PER_TOKEN = 2.5;

/**
 * @param {readonly Turn[]} turns
 * @returns {number}
 */
export function estimateTokens(turns) {
  let chars = 0;
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_result") chars += block.content.length;
      else if (block.type === "tool_use") chars += JSON.stringify(block.input ?? "").length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 들어낸 자리에 남길 표시. 모델이 "원래 없었다"고 읽지 않게 한다. */
const DROPPED = "(오래된 도구 결과가 컨텍스트 확보를 위해 생략됐다. 필요하면 다시 조회하라.)";

/**
 * @typedef {object} CompactionResult
 * @property {Turn[]} turns
 * @property {boolean} changed
 * @property {number} before   압축 전 추정 토큰
 * @property {number} after    압축 후 추정 토큰
 * @property {string} [note]   사용자에게 보여 줄 한 줄
 */

/**
 * 컨텍스트가 한계에 가까우면 줄인다.
 *
 * @param {readonly Turn[]} turns
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]    이 값을 넘으면 압축한다
 * @param {number} [opts.keepRecent]   최근 몇 턴은 손대지 않는가
 * @returns {CompactionResult}
 */
export function compactTurns(turns, opts = {}) {
  const maxTokens = opts.maxTokens ?? 120_000;
  const keepRecent = opts.keepRecent ?? 6;

  const before = estimateTokens(turns);
  if (before <= maxTokens) {
    return { turns: [...turns], changed: false, before, after: before };
  }

  /*
   * 1단계 — 오래된 도구 결과 들어내기.
   * 최근 keepRecent 턴은 건드리지 않는다. 방금 읽은 파일 내용을 지우면
   * 바로 다음 답이 엉뚱해진다.
   */
  const cutoff = Math.max(0, turns.length - keepRecent);
  /** @type {Turn[]} */
  let working = turns.map((turn, index) => {
    if (index >= cutoff) return turn;
    const content = turn.content.map((block) =>
      block.type === "tool_result" && block.content !== DROPPED
        ? { ...block, content: DROPPED }
        : block,
    );
    return { ...turn, content };
  });

  let after = estimateTokens(working);
  let note = "오래된 도구 결과를 생략했다";

  /*
   * 2단계 — 그래도 넘치면 오래된 턴을 통째로 접는다.
   * 첫 사용자 요청은 남긴다. 그게 이 대화가 무엇을 하려던 것인지를 담고 있다.
   */
  if (after > maxTokens && working.length > keepRecent + 1) {
    const head = working[0];
    const tail = working.slice(-keepRecent);
    const foldedCount = working.length - tail.length - 1;
    /** @type {Turn} */
    const marker = {
      role: "user",
      content: [
        {
          type: "text",
          text: `(앞선 ${foldedCount}개 턴이 컨텍스트 확보를 위해 생략됐다. 맥락이 필요하면 사용자에게 묻거나 다시 조회하라.)`,
        },
      ],
    };
    working = head ? [head, marker, ...tail] : [marker, ...tail];
    after = estimateTokens(working);
    note = `오래된 도구 결과와 턴 ${foldedCount}개를 생략했다`;
  }

  return { turns: working, changed: true, before, after, note };
}
