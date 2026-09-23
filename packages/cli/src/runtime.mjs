/*
 * CLI 런타임 조립.
 *
 * Core는 "누가 묻고, 어디에 기록하고, 어떻게 보여줄지"를 모른다 — 전부 인터페이스로만 받는다.
 * 이 파일이 그 구멍을 터미널 구현으로 메운다. 다른 프런트엔드(IDE 확장, 서버 모드)를 붙일 때
 * 갈아끼우는 지점도 여기다.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { askText, pick } from "./picker.mjs";
import { DEFAULT_MODE } from "./mode.mjs";

/** @typedef {import("@ax-navi/core").AuditRecord} AuditRecord */
/** @typedef {import("@ax-navi/core").ProjectPaths} ProjectPaths */

/** 이 저장소 루트. CLI가 설치된 위치에서 agents/·skills/를 찾는다 — 환경변수가 필요 없는 이유다. */
/*
 * 끝의 경로 구분자를 뗀다.
 *
 * fileURLToPath 는 디렉터리 URL 을 항상 구분자로 끝나게 돌려준다. 그 값이 그대로
 * CLAUDE_PLUGIN_ROOT 와 스킬 본문 치환에 실려 나가는데, 윈도우에서는 그게 역슬래시다.
 * 그러면 에이전트가 쓴 bash 명령에서 따옴표가 깨진다(실측).
 *
 *   ls "D:AI새 폴더AX-NAVIagentslib\"
 *   → ls: unknown option -- e     (\" 가 따옴표를 이스케이프했다)
 *
 * join() 으로 쓰는 자리는 구분자가 있든 없든 같으므로, 떼는 쪽이 안전하다.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\\\/]+$/, "");
export const AGENTS_DIR = join(REPO_ROOT, "agents");
export const SKILLS_DIR = join(REPO_ROOT, "skills");

/* ---------- 출력 ---------- */

/*
 * 상세 출력.
 *
 * 내부 진단(치환된 경로 수, 도구 목록, 통제 주체 이전 같은 것)은 기본으로 감춘다.
 * 사용자에게는 제품이 보여야지 구현이 보이면 안 된다. 필요할 때만 --verbose 로 연다.
 */
export const VERBOSE = process.env["AXNAVI_VERBOSE"] === "1" || process.argv.includes("--verbose");

/** @param {string} text */
export function debug(text) {
  if (VERBOSE) process.stderr.write(text);
}

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
/** @param {string} code @param {string} text */
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);

export const ui = {
  /** @param {string} s */ dim: (s) => paint("2", s),
  /** @param {string} s */ bold: (s) => paint("1", s),
  /** @param {string} s */ cyan: (s) => paint("36", s),
  /** @param {string} s */ green: (s) => paint("32", s),
  /** @param {string} s */ yellow: (s) => paint("33", s),
  /** @param {string} s */ red: (s) => paint("31", s),
};


/* ---------- 감사 기록 ---------- */

/**
 * 감사 기록은 JSONL로 남긴다. 어떤 역할이 어떤 도구를 어떤 입력으로 불렀고
 * 허용됐는지 거부됐는지가 한 줄에 들어간다(브리프 §12).
 * @param {ProjectPaths} paths
 */
export function createAuditSink(paths) {
  const file = join(paths.logsDir, "audit.jsonl");
  /** @type {Promise<unknown>} */
  let chain = mkdir(paths.logsDir, { recursive: true });
  return {
    /** @param {AuditRecord} entry */
    record(entry) {
      // 입력에 비밀값이 섞일 수 있으므로 길이를 자르고 통째로 남기지 않는다.
      const safe = { ...entry, input: redact(entry.input) };
      chain = chain
        .then(() => appendFile(file, `${JSON.stringify(safe)}\n`, "utf8"))
        .catch(() => undefined);
    },
    flush: () => chain,
    file,
  };
}

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|credential)/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…(잘림)` : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "***" : redact(v);
  }
  return out;
}

/* ---------- 사용자 질의 ---------- */

/**
 * 선택지를 그리고 답을 고른다.
 *
 * 입력을 **직접 읽지 않고** 주어진 readLine 으로만 받는 것이 요점이다.
 * 예전에는 여기서 readline 인터페이스를 새로 만들었는데, REPL 이 이미 stdin 을
 * 붙잡고 있어서 두 인터페이스가 경쟁했다 — 질문은 떴지만 사용자가 무엇을 눌러도
 * REPL 쪽 큐로 들어가 버려 선택이 되지 않았다(실측).
 *
 * @param {() => Promise<string | null>} readLine  한 줄을 읽어 오는 함수
 * @returns {import("@ax-navi/core").Elicitor}
 */
export function createElicitor(readLine) {
  return {
    async ask(question, options, opts = {}) {
      process.stdout.write(`
${ui.yellow("●")} ${ui.bold(question)}
`);
      options.forEach((opt, i) => process.stdout.write(`  ${ui.cyan(String(i + 1))}. ${opt}
`));
      const hint = options.length
        ? (opts.multiSelect ? "번호(쉼표로 여러 개)" : "번호")
        : "답";
      process.stdout.write(`${ui.dim(`  ${hint} > `)}`);

      const answer = (await readLine())?.trim() ?? "";
      if (!answer) return [];
      if (!options.length) return [answer];

      const picked = answer
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
        .map((n) => /** @type {string} */ (options[n - 1]));
      // 번호로 안 읽히면 자유 입력으로 취급한다 — 되묻느라 절차를 멈추지 않는다.
      return picked.length ? picked : [answer];
    },
  };
}

/*
 * stdin 은 하나뿐이다 — 지금 누가 쥐고 있는지 여기서 기억한다.
 *
 * REPL 이 돌 때는 REPL 의 입력 큐가 유일한 독자다. 질문할 때마다 readline 을 새로
 * 열면 두 인터페이스가 경쟁해서, 질문은 떠 있는데 무엇을 눌러도 선택이 되지 않는다
 * (실측: /harness-init 의 AskUserQuestion 이 응답을 못 받고 멈췄다).
 *
 * 인자로 넘기지 않고 여기 두는 이유는 실행 경로가 넷(/skill, 오케스트레이터, /agent,
 * 일반 대화)이라 배관만 늘기 때문이다. 프로세스에 하나뿐인 자원이니 자리도 하나면 된다.
 */
/** @type {(() => Promise<string | null>) | null} */
let lineReader = null;

/**
 * stdin 을 쥔 쪽이 자기 줄 읽기를 등록한다. REPL 이 시작할 때 한 번 부른다.
 * @param {(() => Promise<string | null>) | null} fn
 */
export function setLineReader(fn) {
  lineReader = fn;
}

/*
 * 지금 도는 턴의 취소 손잡이.
 *
 * stdin 과 같은 성격이다 — 전면에서 도는 턴은 언제나 하나뿐이다. 그래서 자리도 하나만
 * 둔다. 실행 경로가 넷(/skill, 오케스트레이터, /agent, 일반 대화)이라 인자로 끌고
 * 다니면 배관만 늘고, 한 곳이라도 빠뜨리면 그 경로만 조용히 안 멈춘다.
 */
/** @type {AbortController | null} */
let currentTurn = null;

/*
 * 접어 둔 결과의 전문.
 *
 * 화면에는 앞 몇 줄만 보이고 "… +N줄" 로 끝난다. 그 나머지를 보려면 도구를 다시
 * 돌려야 했는데, 그건 돈이 드는 일이다. 마지막 것들을 들고 있다가 Ctrl+O 에 풀어 준다.
 *
 * Claude Code 처럼 그 자리에서 펼쳐 보이지는 못한다 — 기록을 흘려보내는 구조라 지나간 줄을
 * 다시 그릴 수 없다. 대신 아래에 덧붙여 찍는다.
 */
const FOLDED_KEEP = 20;
/** @type {Array<{ label: string, text: string }>} */
let folded = [];

/**
 * 접힌 덩어리 하나를 기억해 둔다.
 * @param {string} label
 * @param {string} text
 */
export function rememberFolded(label, text) {
  folded.push({ label, text });
  if (folded.length > FOLDED_KEEP) folded = folded.slice(folded.length - FOLDED_KEEP);
}

/** @returns {{ label: string, text: string } | null} 가장 최근에 접힌 것을 꺼낸다. */
export function takeFolded() {
  return folded.pop() ?? null;
}

/*
 * 세션 동안의 선택 — 실행 모드와 모델.
 *
 * stdin · 취소 손잡이와 같은 자리에 둔다. 실행 경로가 넷(/skill, 오케스트레이터,
 * /agent, 일반 대화)이라 인자로 끌고 다니면 한 곳만 빼먹어도 그 경로만 조용히 모드를
 * 무시한다. 그런 구명은 화면에 안 드러나서 더 위험하다.
 */
let currentMode = DEFAULT_MODE;
/** @type {import("@ax-navi/core").ModelTier | null} */
let modelOverride = null;

/** @returns {string} */
export function sessionMode() {
  return currentMode;
}

/** @param {string} id */
export function setSessionMode(id) {
  currentMode = id;
}

/** @returns {import("@ax-navi/core").ModelTier | null} */
export function sessionModel() {
  return modelOverride;
}

/** @param {import("@ax-navi/core").ModelTier | null} tier */
export function setSessionModel(tier) {
  modelOverride = tier;
}

/*
 * 턴이 도는 동안 사용자가 치고 있는 글.
 *
 * 상태 표시 줄이 이걸 보여 줘야 한다 — 그 구간에는 readline 을 물러나게 하므로
 * 터미널이 알아서 에코해 주지 않는다. 안 보여 주면 장님 타이핑이 된다.
 */
/** @type {(() => { text: string, queued: number }) | null} */
let typingProbe = null;

/** @param {(() => { text: string, queued: number }) | null} fn */
export function setTypingProbe(fn) {
  typingProbe = fn;
}

/*
 * 판에 모드를 알린다.
 *
 * 턴이 도는 중에 Shift+Tab 을 누르면 다음 턴부터 바뀜는데, 화면이 그걸 안 밝히면
 * 바뀌었는지 알 길이 없다. 프롬프트는 그때 화면에 없어서 거기 붙이는 것만으로는 부족하다.
 */
/** @type {((label: string) => void) | null} */
let panelMode = null;

/** @param {((label: string) => void) | null} fn */
export function setPanelModeSink(fn) {
  panelMode = fn;
}

/** @param {string} label */
export function setPanelMode(label) {
  panelMode?.(label);
}

/** @returns {{ text: string, queued: number }} */
export function readTyping() {
  return typingProbe?.() ?? { text: "", queued: 0 };
}

/**
 * 턴을 시작하며 취소 손잡이를 등록한다. 끝나면 반드시 endTurn 으로 돌려준다.
 * @returns {AbortController}
 */
export function beginTurn() {
  currentTurn = new AbortController();
  return currentTurn;
}

/**
 * @param {AbortController} controller
 */
export function endTurn(controller) {
  // 이미 다음 턴이 등록됐으면 건드리지 않는다.
  if (currentTurn === controller) currentTurn = null;
}

/**
 * 도는 턴이 있으면 중단시킨다.
 * @returns {boolean} 실제로 멈출 게 있었는지. 없으면 호출자가 다른 뜻(종료 등)으로 해석한다.
 */
export function interruptTurn() {
  if (!currentTurn || currentTurn.signal.aborted) return false;
  currentTurn.abort();
  return true;
}

/**
 * 지금 환경에 맞는 질문 통로를 만든다.
 *
 * 실터미널이면 방향키로 고르게 하고, 파이프·로그면 번호 입력으로 내려앉는다.
 * 번호 경로는 등록된 줄 독자를 쓴다 — 그러지 않으면 REPL 과 stdin 을 다푼다.
 *
 * @returns {import("@ax-navi/core").Elicitor}
 */
export function createHostElicitor() {
  const byLine = createElicitor(async () => {
    if (lineReader) return lineReader();
    if (!process.stdin.isTTY) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  });

  return {
    async ask(question, options, opts = {}) {
      /*
       * TTY 가 아니면 줄 입력으로 간다 — 파이프·CI 경로다.
       * TTY 라면 선택지가 있든 없든 **키를 직접 받는다.**
       *
       * 예전에는 자유 입력만 줄 큐로 받았는데, 턴이 도는 동안에는 readline 이 물러나
       * 있고 대신 들어선 typeahead 가 화면에 글자를 안 찍는다(친 글은 바닥 판에
       * 보여 주는데, 질문을 띄우려고 그 판을 걷어 낸 상태다). 사용자는 눈먼 채로
       * 타이핑하게 됐다 — 실측으로 "입력이 안 되고 엔터도 안 쳐진다"였다.
       */
      if (!process.stdin.isTTY) return byLine.ask(question, options, opts);
      if (!options.length) {
        return askText({
          question,
          ...(opts.header ? { header: opts.header } : {}),
          input: process.stdin,
          output: process.stdout,
          ui,
          onInterrupt: () => { interruptTurn(); },
        });
      }
      return pick({
        question,
        options,
        multiSelect: opts.multiSelect === true,
        ...(opts.header ? { header: opts.header } : {}),
        input: process.stdin,
        output: process.stdout,
        ui,
        onInterrupt: () => { interruptTurn(); },
      });
    },
  };
}

/* ---------- 진행 표시 ---------- */

export function createProgressSink() {
  return {
    /**
     * @param {string} taskId
     * @param {"pending" | "in_progress" | "completed" | "failed"} status
     * @param {string} [title]
     */
    update(taskId, status, title) {
      const mark = { pending: "·", in_progress: "▶", completed: "✓", failed: "✗" }[status];
      const color = status === "failed" ? ui.red : status === "completed" ? ui.green : ui.dim;
      process.stderr.write(`${color(`  ${mark} ${taskId}${title ? ` · ${title}` : ""}`)}\n`);
    },
  };
}
