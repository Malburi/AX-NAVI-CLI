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

/** @typedef {import("@ax-navi/core").AuditRecord} AuditRecord */
/** @typedef {import("@ax-navi/core").ProjectPaths} ProjectPaths */

/** 이 저장소 루트. CLI가 설치된 위치에서 agents/·skills/를 찾는다 — 환경변수가 필요 없는 이유다. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
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
${ui.yellow("?")} ${ui.bold(question)}
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
 * 등록된 독자가 있으면 그쪽으로, 없으면(단발 실행) 직접 readline 을 연다.
 * @returns {import("@ax-navi/core").Elicitor}
 */
export function createHostElicitor() {
  return createElicitor(async () => {
    if (lineReader) return lineReader();
    if (!process.stdin.isTTY) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  });
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
