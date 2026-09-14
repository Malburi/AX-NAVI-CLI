/*
 * 화면 관리 — 입력줄과 상태줄을 바닥에 붙들어 둔다.
 *
 * 그냥 stdout에 쓰면 에이전트 출력이 프롬프트를 밀어내 버려서, 작업이 도는 동안
 * 입력할 곳이 화면에서 사라진다. 사용자는 그 사이에도 타이핑하고 싶어 한다.
 *
 * 해법은 단순하다. **프롬프트 영역은 항상 화면의 마지막 두 줄**이라는 불변식을 세우고,
 * 출력할 일이 생기면 그 두 줄을 지우고 → 출력을 흘리고 → 두 줄을 다시 그린다.
 * 스크롤은 터미널이 알아서 한다.
 *
 * 상태줄을 프롬프트 **위**에 둔 것은 의도적이다. 아래에 두면 커서가 입력줄에 있는 채로
 * 그 아래를 계속 다시 그려야 해서 한 글자마다 깜빡인다. 위에 두면 입력줄이 항상
 * 마지막 줄이라 커서 위치가 단순해진다.
 */

/*
 * 제어 시퀀스는 코드로 만든다.
 *
 * 소스에 원시 ESC 바이트를 박아 두면 편집·인코딩 과정에서 조용히 사라진다 —
 * 실제로 그렇게 날아가서 `[1A[0J` 가 화면에 글자로 찍히고, 지워지지 않으니
 * 키를 칠 때마다 상태줄이 쌓였다. 코드로 만들면 그 일이 생길 수 없다.
 */
const ESC = String.fromCharCode(27);
const CLEAR_TO_END = `${ESC}[0J`;
const UP_ONE = `${ESC}[1A`;
const COL_ZERO = "\r";

/**
 * @typedef {object} Screen
 * @property {(text: string) => void} print        출력 한 덩어리 (프롬프트 영역을 피해 흘린다)
 * @property {() => void} redraw                   상태줄·프롬프트 다시 그리기
 * @property {() => void} clear                    프롬프트 영역 지우기
 * @property {(fn: () => string) => void} setStatus 상태줄 내용 제공자
 * @property {(v: boolean) => void} setActive      프롬프트 영역을 붙들지 여부
 */

/**
 * @param {object} args
 * @param {NodeJS.WriteStream} args.output
 * @param {string} args.prompt
 * @param {() => string} args.currentInput   지금 입력 중인 내용 (readline 버퍼)
 * @returns {Screen}
 */
export function createScreen({ output, prompt, currentInput }) {
  /** 지금 프롬프트 영역이 화면에 그려져 있는가. */
  let drawn = false;
  /** 붙들기를 켤지. 비TTY(파이프)에서는 커서 제어가 의미 없어 끈다. */
  let active = Boolean(output.isTTY);
  /** @type {() => string} */
  let status = () => "";

  function clear() {
    if (!drawn) return;
    output.write(COL_ZERO);
    output.write(UP_ONE); // 상태줄로
    output.write(CLEAR_TO_END);
    drawn = false;
  }

  function redraw() {
    if (!active) return;
    clear();
    output.write(`${status()}\n`);
    output.write(prompt + currentInput());
    drawn = true;
  }

  return {
    /** @param {string} text */
    print(text) {
      if (!active) {
        // 붙들기를 안 해도 한 덩어리는 한 줄이다 — 안 그러면 파이프에서 전부 붙어 나온다.
        output.write(text.endsWith("\n") ? text : `${text}\n`);
        return;
      }
      clear();
      output.write(text);
      // 출력이 줄바꿈으로 끝나지 않으면 프롬프트가 같은 줄에 붙는다.
      if (!text.endsWith("\n")) output.write("\n");
      redraw();
    },
    redraw,
    clear,
    /** @param {() => string} fn */
    setStatus(fn) {
      status = fn;
    },
    /** @param {boolean} v */
    setActive(v) {
      if (!v) clear();
      active = v && Boolean(output.isTTY);
    },
  };
}
