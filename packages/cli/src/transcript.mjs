/*
 * 도구 호출 기록을 읽을 수 있게 그린다.
 *
 * 예전에는 호출 한 줄(`→ Bash command=... description=...`)과 결과 한 줄(`← ...`)을
 * 오는 대로 흘려보냈다. 두 가지가 문제였다.
 *   - claude 는 도구를 병렬로 돌린다. 호출 대여섯 개가 먼저 쏟아지고 결과가 뒤늦게
 *     따라오니 **어느 결과가 어느 호출의 것인지** 화면에서 알 수 없었다(실측).
 *   - 인자를 전부 펼쳐 한 줄에 이어 붙이니 터미널 폭을 넘겨 접히고, 정작 중요한
 *     첫 인자가 잘려 나갔다.
 *
 * 그래서 **결과가 올 때까지 기다렸다가 짝을 지어 한 덩어리로** 찍는다. 무엇이 지금
 * 도는지는 상태 표시 줄이 이미 보여 주므로 기다리는 동안 깜깜하지 않다.
 */

import { clipToWidth, visibleLength } from "./width.mjs";

/** 결과에서 보여 줄 줄 수. 넘치면 몇 줄이 더 있는지만 알린다. */
const RESULT_LINES = 4;
const NEWLINE = String.fromCharCode(10);

/**
 * 도구별로 "이것만 보면 무슨 일을 하는지 아는" 인자.
 * 없는 도구는 아래 fallback 이 첫 문자열 인자를 고른다.
 */
const PRIMARY = {
  Bash: ["command"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  Task: ["description", "subagent_type"],
  QueryIndex: ["command"],
  AskUserQuestion: ["question"],
};

/**
 * 화면에 쓸 도구 이름. 브리지 전송 경로 이름은 사용자가 알 필요가 없다.
 * @param {string} tool
 * @returns {string}
 */
export function toolName(tool) {
  return tool.replace(/^mcp__axnavi__/, "");
}

/**
 * 프로젝트 안의 경로는 짧게 줄인다. 절대경로를 그대로 두면 한 줄이 경로로 다 찬다.
 * @param {string} value
 * @param {string} [root]
 * @returns {string}
 */
export function shorten(value, root) {
  const BACKSLASH = String.fromCharCode(92);
  if (!root) return value;
  const norm = (/** @type {string} */ s) => s.split(BACKSLASH).join("/");
  const from = norm(root).replace(/\/$/, "");
  const target = norm(value);
  return target.startsWith(`${from}/`) ? target.slice(from.length + 1) : value;
}

/**
 * 호출 한 줄. `Bash(cd ... && grep ...)` 꼴.
 *
 * @param {string} tool
 * @param {unknown} input
 * @param {{ root?: string }} [opts]
 * @returns {string}
 */
export function headline(tool, input, opts = {}) {
  const name = toolName(tool);
  const args = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};

  const keys = /** @type {string[] | undefined} */ (/** @type {any} */ (PRIMARY)[name]);
  let value;
  for (const key of keys ?? []) {
    if (typeof args[key] === "string" && args[key]) { value = /** @type {string} */ (args[key]); break; }
  }
  if (value === undefined) {
    // 모르는 도구 — 첫 문자열 인자를 쓴다. 지어내는 것보다 있는 것을 보여 주는 편이 낫다.
    value = Object.values(args).find((v) => typeof v === "string" && v) ?? "";
  }

  const text = shorten(String(value), opts.root).replace(/\s+/g, " ").trim();
  return text ? `${name}(${text})` : name;
}

/*
 * 결과를 그대로 보여 주면 안 되는 도구들.
 *
 * Read 의 결과는 파일 내용 그 자체다. 그 앞 네 줄을 찍어 봐야 "이 파일을
 * 읽었다"는 사실 외에 알 수 있는 게 없고, 파일 수십 개를 읽는 동안 화면이
 * 남의 파일 앞도리로 덤복된다(실측: harness-init 중 화면의 대부분이 이것이었다).
 * 무엇을 얼만큼 했는지만 남긴다.
 *
 * Bash 는 일부러 뺄다 — 출력 그 자체가 보고 싶은 것이다.
 */
/** 결과 줄 수와 무관하게 항상 같은 말을 하는 도구. */
const FIXED = {
  Write: "저장됨",
  Edit: "고쳐짐",
  MultiEdit: "고쳐짐",
};

const SUMMARIZE = {
  /** @param {number} n */ Read: (n) => `${n}줄 읽음`,
  /** @param {number} n */ Write: (n) => `${n}줄 썼`,
  /** @param {number} n */ Glob: (n) => `파일 ${n}개`,
  /** @param {number} n */ Grep: (n) => `${n}건`,
  /** @param {number} n */ QueryIndex: (n) => `${n}줄`,
};

/**
 * 이 결과를 한 줄로 줄일 수 있는가.
 *
 * 실패했을 때는 줄이지 않는다 — 왜 실패했는지가 결과 본문에 들어 있다.
 * 한 줄짜리도 줄이지 않는다 — "파일 없음" 같은 안내가 사라진다.
 *
 * @param {string} tool
 * @param {string} result
 * @param {boolean} [isError]
 * @returns {string | null}
 */
export function summarizeResult(tool, result, isError) {
  if (isError) return null;
  /*
   * Write 의 결과는 "File created successfully at: … (file state is current…)" 같은
   * 긴 안내다. 경로는 이미 제목 줄에 있으니 되풀이할 이유가 없다.
   */
  const fixed = /** @type {string | undefined} */ (/** @type {any} */ (FIXED)[tool]);
  if (fixed) return fixed;

  const make = /** @type {((n: number) => string) | undefined} */ (/** @type {any} */ (SUMMARIZE)[tool]);
  if (!make) return null;
  const lines = (result ?? "").trimEnd().split(NEWLINE).filter((l) => l.trim());
  if (lines.length <= 1) return null;
  return make(lines.length);
}

/**
 * 결과 덩어리. 앞 몇 줄만 보이고 나머지는 개수로 알린다.
 *
 * @param {string} text
 * @param {{ max?: number }} [opts]
 * @returns {{ lines: string[], hidden: number }}
 */
export function resultBlock(text, opts = {}) {
  const max = opts.max ?? RESULT_LINES;
  // 앞뒤 빈 줄은 자리만 먹는다.
  const all = (text ?? "").replace(/\s+$/, "").split("\n");
  while (all.length && !(all[0] ?? "").trim()) all.shift();
  if (!all.length) return { lines: [], hidden: 0 };
  return { lines: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

/**
 * 호출 + 결과를 화면에 쓸 줄들로 만든다.
 *
 * 색을 여기서 입히는 이유는 **폭 계산과 색 입히기가 같은 곳에 있어야** 하기 때문이다.
 * 떨어뜨려 놓으면 색 코드를 길이에 섞어 세서 줄이 접히고, 그러면 상태 표시가 어긋난다 —
 * 이 저장소에서 이미 겪은 결함이다.
 *
 * @param {object} args
 * @param {string} args.tool
 * @param {unknown} args.input
 * @param {string} [args.result]
 * @param {boolean} [args.isError]
 * @param {boolean} [args.pending]   결과를 못 받고 끝난 호출 (중단 등)
 * @param {number} [args.depth]      서브에이전트 안의 일이면 1
 * @param {string} [args.root]
 * @param {number} args.width
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, green: (s: string) => string, red: (s: string) => string, yellow: (s: string) => string, bold: (s: string) => string }} args.ui
 * @returns {string[]}
 */
export function renderCall({ tool, input, result, isError, pending, root, depth = 0, width, ui }) {
  // 서브에이전트 안의 일은 한 칸 들여써 누가 한 일인지 보이게 한다.
  const pad = depth > 0 ? `${ui.dim("│")} ` : "";
  const cap = Math.max(20, width - 1);
  const bullet = pending ? ui.yellow("●") : isError ? ui.red("●") : ui.green("●");
  const head = headline(tool, input, root === undefined ? {} : { root });
  // 도구 이름만 진하게. 인자는 흐리게 두어야 이름이 눈에 먼저 들어온다.
  const open = head.indexOf("(");
  const painted = open === -1
    ? ui.bold(head)
    : `${ui.bold(head.slice(0, open))}${ui.dim(head.slice(open))}`;
  const lines = [clipToWidth(`${pad}${bullet} ${painted}`, cap)];

  if (pending) {
    lines.push(clipToWidth(`${pad}${ui.dim("  ⎿  (결과를 받지 못했다)")}`, cap));
    return lines;
  }

  const tint = isError ? ui.red : ui.dim;

  /*
   * 한 마디로 끝나는 결과는 제목 줄에 붙인다.
   *
   * Read·Grep 처럼 연속으로 수십 번 불리는 도구는 두 줄씩 차지하면 화면이 그것만으로
   * 차버린다(실측: 도구 25회가 50줄이 됐다). 내용은 그대로 두고 줄 수만 반으로 줄인다.
   */
  const short = summarizeResult(toolName(tool), result ?? "", isError);
  if (short !== null) {
    lines[0] = clipToWidth(`${lines[0]}  ${tint(short)}`, cap);
    return lines;
  }

  const { lines: body, hidden } = resultBlock(result ?? "");

  /*
   * 한 줄짜리 결과도 폭에 들어가면 제목 줄에 붙인다 — "No matches found",
   * "OK 10" 같은 것을 따로 한 줄 내주면 길이만 두 배로 먹는다.
   * 안 들어가면 잘라 버리지 않고 아래 덩어리로 내린다.
   */
  const only = body.length === 1 && !hidden ? /** @type {string} */ (body[0]) : null;
  if (only !== null && visibleLength(lines[0] ?? "") + visibleLength(only) + 2 < cap) {
    lines[0] = `${lines[0]}  ${tint(only)}`;
    return lines;
  }

  if (!body.length) {
    lines.push(clipToWidth(`${pad}${tint("  ⎿  (출력 없음)")}`, cap));
  } else {
    body.forEach((line, i) => {
      lines.push(clipToWidth(`${pad}  ${ui.dim(i === 0 ? "⎿ " : "  ")} ${tint(line)}`, cap));
    });
  }
  if (hidden) lines.push(clipToWidth(`${pad}${ui.dim(`     … +${hidden}줄`)}`, cap));
  return lines;
}

export { RESULT_LINES, visibleLength };
