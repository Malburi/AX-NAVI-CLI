/*
 * 붙여넣은 여러 줄을 한 메시지로 묶는다.
 *
 * readline 은 붙여넣기를 줄마다 따로 line 이벤트로 준다. 그대로 대기열에 넣으면 줄 하나가
 * 턴 하나가 된다. 실측: 옆 창의 화면 조각 8줄(입력칸 테두리·상태표시줄·코드 몇 줄)이
 * 붙여 넣어지자 8번의 턴이 12초 간격으로 돌았고, 같은 모양의 답이 되풀이됐다.
 * Claude Code 는 붙여넣기를 메시지 하나로 받는다.
 *
 * 사람이 Enter 를 두 번 치는 간격은 이보다 훨씬 길다. 한 덩어리로 들어온 줄만 합친다.
 */

export const PASTE_GAP_MS = 40;

/**
 * @param {(text: string) => void} deliver  합쳐진 메시지를 받는 쪽
 * @param {{ gapMs?: number, enabled?: boolean }} [opts]  enabled=false 면 줄마다 그대로 넘긴다(파이프 입력)
 */
export function createLineBurst(deliver, opts = {}) {
  const gapMs = opts.gapMs ?? PASTE_GAP_MS;
  /** @type {string[]} */
  let lines = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!lines.length) return;
    const text = lines.join("\n");
    lines = [];
    deliver(text);
  };

  return {
    /** @param {string} line */
    push(line) {
      if (opts.enabled === false) {
        deliver(line);
        return;
      }
      lines.push(line);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, gapMs);
    },
    /** 입력이 닫힐 때 남은 것을 내보낸다. */
    flush,
  };
}
