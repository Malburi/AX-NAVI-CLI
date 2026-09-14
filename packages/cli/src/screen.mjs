/*
 * 화면 관리 — 입력줄과 상태줄을 바닥에 붙들어 둔다.
 *
 * 그냥 stdout에 쓰면 에이전트 출력이 프롬프트를 밀어내 버려서, 작업이 도는 동안
 * 입력할 곳이 화면에서 사라진다. 사용자는 그 사이에도 타이핑하고 싶어 한다.
 *
 * 해법은 단순하다. **프롬프트 영역은 항상 화면의 마지막 몇 줄**이라는 불변식을 세우고,
 * 출력할 일이 생기면 그 영역을 지우고 → 출력을 흘리고 → 다시 그린다.
 * 스크롤은 터미널이 알아서 한다.
 *
 * 상태줄을 프롬프트 **위**에 둔 것은 의도적이다. 아래에 두면 커서가 입력줄에 있는 채로
 * 그 아래를 계속 다시 그려야 해서 한 글자마다 깜빡인다.
 *
 * 까다로운 지점은 **줄 접힘**이다. 상태줄이나 입력이 터미널 폭을 넘으면 물리적으로
 * 두 줄 이상을 차지하는데, 지울 때 한 줄만 올라가면 접힌 윗줄이 화면에 남는다.
 * 실제로 그래서 출력마다 상태줄이 쌓였다 — 그래서 여기서는 **그린 물리 줄 수를 세어**
 * 그만큼 되짚어 올라간 뒤 지운다.
 */

/*
 * 제어 시퀀스는 코드로 만든다.
 *
 * 소스에 원시 ESC 바이트를 박아 두면 편집·인코딩 과정에서 조용히 사라진다 —
 * 실제로 그렇게 날아가서 `[1A[0J` 가 화면에 글자로 찍혔다. 코드로 만들면 그 일이 없다.
 */
const ESC = String.fromCharCode(27);
const CLEAR_TO_END = `${ESC}[0J`;
const COL_ZERO = "\r";
/** @param {number} n */
const up = (n) => (n > 0 ? `${ESC}[${n}A` : "");

/**
 * ANSI 이스케이프를 뺀 표시 길이. 색을 넣은 채로 세면 줄 수를 잘못 계산한다.
 * @param {string} s
 * @returns {number}
 */
export function visibleLength(s) {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").length;
}

/**
 * 이 문자열이 차지하는 물리 줄 수.
 * @param {string} text
 * @param {number} cols
 * @returns {number}
 */
export function physicalLines(text, cols) {
  const len = visibleLength(text);
  if (cols <= 0) return 1;
  return Math.max(1, Math.ceil(len / cols) || 1);
}

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
  /** 지금 그려져 있는 물리 줄 수. 0이면 안 그려져 있다. */
  let drawnLines = 0;
  /** 붙들기를 켤지. 비TTY(파이프)에서는 커서 제어가 의미 없어 끈다. */
  let active = Boolean(output.isTTY);
  /** @type {() => string} */
  let status = () => "";

  const cols = () => output.columns ?? 80;

  function clear() {
    if (!drawnLines) return;
    output.write(COL_ZERO);
    // 마지막 물리 줄에 커서가 있으므로 (drawnLines - 1)만큼 올라가야 첫 줄이다.
    output.write(up(drawnLines - 1));
    output.write(CLEAR_TO_END);
    drawnLines = 0;
  }

  function redraw() {
    if (!active) return;
    clear();
    const width = cols();
    const statusText = status();
    const inputLine = prompt + currentInput();
    output.write(`${statusText}\n`);
    output.write(inputLine);
    drawnLines = physicalLines(statusText, width) + physicalLines(inputLine, width);
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
