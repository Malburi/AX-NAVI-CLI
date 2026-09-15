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

import { clipToWidth, visibleLength, wrapToWidth } from "./width.mjs";

/** 결과에서 보여 줄 줄 수. 넘치면 몇 줄이 더 있는지만 알린다. */
const RESULT_LINES = 4;
const NEWLINE = String.fromCharCode(10);

/**
 * 도구별로 "이것만 보면 무슨 일을 하는지 아는" 인자.
 * 없는 도구는 아래 fallback 이 첫 문자열 인자를 고른다.
 */
/*
 * 결과를 따로 보여 줄 필요가 없는 도구.
 *
 * 질문은 선택지가 바로 떴고, 스킬은 그 실행이 바로 이어진다. 결과 문구를 한 번 더
 * 찍으면 같은 말을 두 번 하는 것이고, 그 문구가 모델에게 주는 지시면 사용자에게는
 * 엉뚱한 소리로 보인다(실측: "설명을 덧붙이지 말고 여기서 끝내라" 가 화면에 떴다).
 */
const HEADER_ONLY = new Set(["AskUserQuestion", "Skill"]);

const PRIMARY = {
  Bash: ["command"],
  Skill: ["name"],
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

/*
 * 결과 본문이 쓸모없는 도구만 수자로 줄인다.
 *
 * Read 의 결과는 파일 내용 그 자체라 앞 네 줄을 봐도 "이 파일을 읽었다" 외에
 * 알 게 없다. 반면 Grep·QueryIndex 는 **찾은 것 자체**가 답이다 — "16건" 만 보여 주면
 * 무엇을 찾았는지 알 수 없어 따라갈 수가 없다(실측: 30개 호출이 전부 숫자만 남았다).
 */
const SUMMARIZE = {
  /** @param {number} n */ Read: (n) => `${n}줄 읽음`,
  /** @param {number} n */ Glob: (n) => `파일 ${n}개`,
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
  if (tool === "QueryIndex") return describeQuery(result);
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
  /*
   * 긴 명령은 잘라 버리지 않고 한 줄 더 이어 보인다.
   *
   * 한 줄에서 자르면 `cd "..." && python -c "` 에서 끝나 정작 무었 했는지가 안 보인다
   * (실측). 두 줄까지만 쓴다 — 더 늘리면 본문보다 명령이 화면을 차지한다.
   */
  const open = head.indexOf("(");
  const name = open === -1 ? head : head.slice(0, open);
  const args = open === -1 ? "" : head.slice(open);
  const first = cap - visibleLength(pad) - 2 - visibleLength(name);
  const wrapped = args ? wrapToWidth(args, Math.max(10, first)) : [""];

  const lines = [`${pad}${bullet} ${ui.bold(name)}${ui.dim(wrapped[0] ?? "")}`];
  if (wrapped.length > 1) {
    // 두 번째 줄까지. 그래도 남으면 줄임표로 끝낸다.
    const rest = wrapped.slice(1).join("");
    const room = cap - visibleLength(pad) - 4;
    const tail = visibleLength(rest) > room ? `${clipToWidth(rest, room - 2)}…` : rest;
    lines.push(`${pad}    ${ui.dim(tail)}`);
  }

  if (pending) {
    lines.push(clipToWidth(`${pad}${ui.dim("  ⎿  (결과를 받지 못했다)")}`, cap));
    return lines;
  }

  const tint = isError ? ui.red : ui.dim;

  // 실패는 보여 준다 — 접수된 줄 알고 지나가면 무엇이 안 돌았는지 모른다.
  if (!isError && HEADER_ONLY.has(toolName(tool))) return lines;

  /*
   * 결과는 항상 ⎿ 줄로 내린다.
   *
   * 한때 제목 줄에 붙였는데, 그러면 줄 수는 줄지만 어디까지가 호출이고 어디부터가
   * 결과인지 눈으로 안 갈린다. 줄이 많아지는 것보다 읽히지 않는 쪽이 나쁘다.
   */
  const short = summarizeResult(toolName(tool), result ?? "", isError);
  if (short !== null) {
    lines.push(clipToWidth(`${pad}  ${ui.dim("⎿")} ${tint(short)}`, cap));
    return lines;
  }

  const { lines: body, hidden } = resultBlock(result ?? "");
  if (!body.length) {
    lines.push(clipToWidth(`${pad}  ${ui.dim("⎿")} ${tint("(출력 없음)")}`, cap));
  } else {
    body.forEach((line, i) => {
      lines.push(clipToWidth(`${pad}  ${ui.dim(i === 0 ? "⎿" : " ")} ${tint(line)}`, cap));
    });
  }
  // 몇 줄이 숨었는지와 펼치는 법을 같이 적는다 — 안 적으면 나머지를 볼 길이 없는 줄 안다.
  if (hidden) lines.push(clipToWidth(`${pad}    ${ui.dim(`… +${hidden}줄  Ctrl+O`)}`, cap));
  return lines;
}

/**
 * 스킬 실행 머리말.
 *
 * 자연어로 부르든 슬래시로 부르든 **같은 모양**이어야 한다. 예전에는 자연어 경로에만
 * 표시가 붙고 `/find` 는 그냥 답부터 찍혀서, 무엇이 돌고 있는지 구분이 안 됐다.
 *
 * 설명은 SKILL.md 의 frontmatter 에서 온다 — 여기서 지어내지 않는다.
 *
 * @param {object} args
 * @param {string} args.name          실제 실행되는 스킬 이름
 * @param {string} [args.description] frontmatter 설명 (첫 문장으로 줄여 넣는다)
 * @param {readonly string[]} [args.via]  거쳐 온 별칭 사슬
 * @param {number} args.width
 * @param {{ dim: (s: string) => string, green: (s: string) => string, bold: (s: string) => string }} args.ui
 * @returns {string[]}
 */
export function renderSkillHeader({ name, description, via = [], width, ui }) {
  const cap = Math.max(20, width - 1);
  // 별칭으로 들어왔으면 어느 이름으로 불렀는지도 남긴다. 그걸 숨기면 목록과 대응이 안 된다.
  const alias = via.length ? ui.dim(`  ← /${via[0]}`) : "";
  const lines = [clipToWidth(`${ui.green("●")} ${ui.bold(`Skill(${name})`)}${alias}`, cap)];
  const summary = (description ?? "").trim();
  if (summary) lines.push(clipToWidth(`  ${ui.dim(summary)}`, cap));
  return lines;
}

export { RESULT_LINES, visibleLength };

/**
 * 인덱스 질의 결과를 한 줄로.
 *
 * 그대로 보여 주면 옆으로 벌어진 JSON 의 앞 네 줄, 즉 `{ "query": { "q": ... }` 만
 * 보인다(실측). 그건 질문을 되풀이한 것이지 답이 아니다.
 * 몇 건이 나왔고 첫 건이 무엇인지가 화면에서 필요한 전부다.
 *
 * @param {string} result
 * @returns {string | null}
 */
function describeQuery(result) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    /*
     * 위임 경로는 도구 결과를 2000자에서 자른다. 큰 질의 결과는 그래서 파싱이
     * 안 되고, 그대로 두면 잘린 JSON 의 앞부분이 화면을 덮는다(실측).
     * 잘렸어도 total 과 첫 id 는 앞쪽에 있으니 글자로 찾는다.
     */
    return looksLikeJson(result) ? scavenge(result) : null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const items = Array.isArray(parsed.items) ? parsed.items : null;
  if (!items) {
    // summary 처럼 목록이 아닌 결과는 키만 보여 준다.
    const keys = Object.keys(parsed).filter((k) => k !== "note" && k !== "query");
    return keys.length ? keys.slice(0, 6).join(", ") : null;
  }

  const total = typeof parsed.total === "number" ? parsed.total : items.length;
  if (total === 0) return "0건";
  const head = items[0] ?? {};
  const first = String(head.id ?? head.name ?? head.from ?? head.file ?? head.sql_id ?? "").split("/").at(-1) ?? "";
  const more = total > 1 ? ` 외 ${total - 1}` : "";
  return first ? `${total}건 · ${first}${more}` : `${total}건`;
}

/** @param {string} text @returns {boolean} */
function looksLikeJson(text) {
  return text.trimStart().startsWith("{");
}

/**
 * 잘린 JSON 에서 숫자와 첫 이름만 긁어온다.
 * 정규식을 안 쓰는 것은 도구를 거치며 역슬래시가 먹히는 일이 잦기 때문이다.
 * @param {string} text
 * @returns {string | null}
 */
function scavenge(text) {
  /** @param {string} key */
  const after = (key) => {
    const at = text.indexOf(`"${key}"`);
    if (at === -1) return "";
    const colon = text.indexOf(":", at);
    if (colon === -1) return "";
    return text.slice(colon + 1, colon + 200).trim();
  };

  /*
   * 앞쪽 연속된 숫자만 읽는다.
   * 전체에서 숫자를 걸러 이으면 "total": 384, "returned": 50, "truncated": 334 가
   * 38450334 가 된다 — 실제로 그러게 나왔다.
   */
  let digits = "";
  for (const ch of after("total")) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else break;
  }
  const total = digits ? Number(digits) : null;

  const idRaw = after("id");
  const quoted = idRaw.startsWith('"') ? idRaw.slice(1, idRaw.indexOf('"', 1)) : "";
  const first = quoted.split("/").at(-1) ?? "";

  if (total === null && !first) return null;
  if (total === null) return `${first} …`;
  const more = total > 1 && first ? ` 외 ${total - 1}` : "";
  return first ? `${total}건 · ${first}${more}` : `${total}건`;
}
