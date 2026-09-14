/*
 * 턴이 도는 동안의 입력 받기.
 *
 * 그 구간에는 readline 을 물러나게 한다. 안 그러면 방향키가 화면을 어지른다 —
 * 위·아래는 히스토리를 불러내 프롬프트를 다시 그리고(실측: `> /harness-init` 이
 * 누를 때마다 쌓였다), 좌·우도 입력 줄을 다시 그린다. 그 자리엔 이미 스트리밍
 * 출력이 흐르고 있으니 섞여 버린다.
 *
 * 대신 여기서 키를 직접 받는다. 하는 일은 셋뿐이다 — 글자를 모으고, Enter 에서
 * 한 줄로 넘기고, 나머지는 흘려보낸다. 편집 기능을 흉내 내지 않는 이유는 그게
 * 곧 readline 을 다시 만드는 일이기 때문이다. 제대로 고치고 싶으면 프롬프트를
 * 되돌려 받은 뒤에 하면 된다.
 */

/**
 * @param {object} args
 * @param {(line: string) => void} args.onLine       Enter 로 끝난 한 줄
 * @param {(how: "Ctrl+C" | "ESC") => void} args.onInterrupt
 * @returns {{
 *   handle: (ch: string | undefined, key?: { name?: string, ctrl?: boolean, meta?: boolean }) => void,
 *   text: () => string,
 *   take: () => string,
 * }}
 */
export function createTypeahead({ onLine, onInterrupt }) {
  let typed = "";
  return {
    handle(ch, key) {
      if (key?.ctrl && key.name === "c") return onInterrupt("Ctrl+C");
      if (key?.name === "escape") return onInterrupt("ESC");
      if (key?.name === "return" || key?.name === "enter") {
        // 빈 줄은 넘기지 않는다 — 턴이 끝나자마자 빈 입력이 실행되면 곤란하다.
        if (typed.trim()) onLine(typed);
        typed = "";
        return;
      }
      if (key?.name === "backspace") {
        typed = typed.slice(0, -1);
        return;
      }
      /*
       * 방향키·기능키는 흘려보낸다. 이것이 화면을 어지르던 범인이다.
       * 제어 문자도 거른다 — 눈에 안 보이는 채로 줄에 섞인다.
       */
      if (ch && !key?.ctrl && !key?.meta && isPrintable(ch)) typed += ch;
    },
    text: () => typed,
    /** 남은 글자를 꺼내고 비운다. 턴이 끝날 때 프롬프트로 돌려주려고 쓴다. */
    take() {
      const rest = typed;
      typed = "";
      return rest;
    },
  };
}

/**
 * 화면에 드러나는 글자인가.
 *
 * `ch >= " "` 만으로는 DEL(0x7f)이 빠져나간다 — 0x7f 은 공백보다 크기 때문이다.
 * 테스트가 잡았다.
 * @param {string} ch
 * @returns {boolean}
 */
function isPrintable(ch) {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}
