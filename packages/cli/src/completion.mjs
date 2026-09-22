/*
 * 슬래시 명령 레지스트리와 Tab 자동완성.
 *
 * 설계 하나를 여기서 되살린다 — 원래 플러그인은 자주 쓰는 스킬 7종을 `/modify`,
 * `/impact` 처럼 슬래시 한 번으로 불렀다(skills/{find,impact,modify,...}). CLI에서도
 * 같은 방식이 되도록 **스킬 이름 자체를 슬래시 명령으로** 등록한다. 별칭 7종은
 * 로더가 본편으로 풀어 주므로 `/modify`가 safe-modify로 간다.
 *
 * 자동완성은 readline의 completer 계약을 따른다 — `[매칭목록, 원문]`을 돌려주면
 * 하나면 바로 채워 넣고, 여럿이면 목록을 보여 준다.
 */

/**
 * @typedef {object} SlashCommand
 * @property {string} name
 * @property {"builtin" | "skill"} kind
 * @property {string} summary
 * @property {string} [usage]
 */

/**
 * REPL 자체 기능. 스킬 이름과 겹치지 않게 관리한다.
 * @type {SlashCommand[]}
 */
const BUILTINS = [
  { name: "help", kind: "builtin", summary: "명령 목록" },
  { name: "agents", kind: "builtin", summary: "에이전트 19종 목록" },
  { name: "agent", kind: "builtin", summary: "에이전트 직접 실행", usage: "/agent <이름> <요청>" },
  { name: "skills", kind: "builtin", summary: "스킬 목록" },
  { name: "index", kind: "builtin", summary: "인덱스 빌드·상태", usage: "/index [build|status|refresh]" },
  { name: "status", kind: "builtin", summary: "현재 프로젝트 상태" },
  { name: "context", kind: "builtin", summary: "진행 중인 대화 상태" },
  { name: "new", kind: "builtin", summary: "대화를 끊고 새로 시작" },
  { name: "sessions", kind: "builtin", summary: "저장된 대화 목록" },
  { name: "resume", kind: "builtin", summary: "이전 대화로 돌아가기" },
  { name: "model", kind: "builtin", summary: "모델 바꾸기 (haiku | sonnet | opus)" },
  { name: "mode", kind: "builtin", summary: "실행 모드 보기·바꾸기 (기본 | 계획 | 빠름)" },
  { name: "bg", kind: "builtin", summary: "백그라운드로 돌리기 — 도는 동안 계속 대화합니다", usage: "/bg <요청>" },
  { name: "tasks", kind: "builtin", summary: "백그라운드 작업 목록 · /tasks stop <번호>" },
  { name: "log", kind: "builtin", summary: "지나간 작업 되짚어 보기 (서브에이전트별)" },
  { name: "exit", kind: "builtin", summary: "종료" },
];

/**
 * 슬래시 명령 전체 목록을 만든다.
 * @param {Array<{ name: string, description: string, delegatesTo: string | null, agents: string[] }>} skills
 * @returns {SlashCommand[]}
 */
export function buildCommands(skills) {
  const builtinNames = new Set(BUILTINS.map((b) => b.name));
  /** @type {SlashCommand[]} */
  const out = [...BUILTINS];

  for (const skill of skills) {
    // 이름이 겹치면 REPL 기능이 이긴다 — 사용자가 /help로 스킬을 부르는 일은 없다.
    if (builtinNames.has(skill.name)) continue;
    out.push({
      name: skill.name,
      kind: "skill",
      summary: skill.delegatesTo
        ? `→ ${skill.delegatesTo}`
        : firstSentence(skill.description),
    });
  }
  return out;
}

/**
 * description 앞머리만 잘라 한 줄 요약으로 쓴다.
 *
 * 메뉴와 실행 머리말이 같은 규칙을 써야 한다 — 사본을 두면 한쪽만 고쳐져 갈라진다.
 * 길이만 자리에 따라 다르므로 그것만 인자로 받는다.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function firstSentence(text, limit = 46) {
  // 따옴표로 시작하는 설명이 있다(safe-modify). 먼저 벗기지 않으면 첫 조각이 빈 문자열이 된다.
  const body = text.trim().replace(/^["'"]+/, "");
  // 첫 문장만. 트리거 예시("~ 요청 시")는 목록에서 군더더기라 잘라 낸다.
  const head = body.split(/[.。]\s|\. |["'"]/)[0] ?? body;
  const cut = head.replace(/\s*—.*$/, "").trim();
  return cut.length > limit ? `${cut.slice(0, limit)}…` : cut;
}

/**
 * readline completer.
 *
 * 두 단계를 지원한다.
 *   `/ag`          → 슬래시 명령 이름
 *   `/agent ana`   → 그 명령의 인자(에이전트 이름)
 *
 * @param {string} line 현재 입력 전체
 * @param {{ commands: SlashCommand[], agentNames: string[] }} ctx
 * @returns {[string[], string]}
 */
export function complete(line, ctx) {
  if (!line.startsWith("/")) return [[], line];

  const spaceAt = line.indexOf(" ");

  // 1단계 — 명령 이름
  if (spaceAt === -1) {
    const typed = line.slice(1);
    const names = ctx.commands.map((c) => `/${c.name}`);
    const hits = names.filter((n) => n.startsWith(line));
    // 아무것도 안 쳤으면(`/`) 전체를 보여 준다.
    return [hits.length ? hits : typed ? [] : names, line];
  }

  // 2단계 — 인자
  const head = line.slice(1, spaceAt);
  const arg = line.slice(spaceAt + 1);
  if (head === "agent") {
    const hits = ctx.agentNames.filter((n) => n.startsWith(arg));
    return [hits.length ? hits : ctx.agentNames, arg];
  }
  if (head === "index") {
    const subs = ["build", "status", "refresh"];
    const hits = subs.filter((n) => n.startsWith(arg));
    return [hits.length ? hits : subs, arg];
  }
  return [[], line];
}

/**
 * 인라인 메뉴에 띄울 후보. complete()와 같은 규칙을 쓰되 설명을 함께 붙인다.
 *
 * @param {string} line
 * @param {{ commands: SlashCommand[], agentNames: string[] }} ctx
 * @returns {Array<{ value: string, hint: string }>}
 */
export function menuItems(line, ctx) {
  if (!line.startsWith("/")) return [];
  const spaceAt = line.indexOf(" ");

  if (spaceAt === -1) {
    return ctx.commands
      .filter((c) => `/${c.name}`.startsWith(line))
      .map((c) => ({ value: `/${c.name}`, hint: c.usage ?? c.summary }));
  }

  const head = line.slice(1, spaceAt);
  const arg = line.slice(spaceAt + 1);
  // 인자에 공백이 들어간 순간은 자유 입력이므로 더 이상 제안하지 않는다.
  if (arg.includes(" ")) return [];

  if (head === "agent") {
    return ctx.agentNames
      .filter((n) => n.startsWith(arg))
      .map((n) => ({ value: `/agent ${n}`, hint: "에이전트" }));
  }
  if (head === "index") {
    return ["build", "status", "refresh"]
      .filter((n) => n.startsWith(arg))
      .map((n) => ({ value: `/index ${n}`, hint: "인덱스" }));
  }
  return [];
}

/**
 * `/help` 로 보여 줄 전체 목록. 내장 기능과 스킬을 나눠 보여 준다.
 * @param {SlashCommand[]} commands
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, bold: (s: string) => string }} ui
 * @returns {string}
 */
export function renderCommandMenu(commands, ui) {
  const builtins = commands.filter((c) => c.kind === "builtin");
  // 별칭(`→ 대상` 요약을 가진 것)은 짧아서 한 줄로 묶는 편이 읽기 쉽다.
  const aliases = commands.filter((c) => c.kind === "skill" && c.summary.startsWith("→"));
  const skills = commands.filter((c) => c.kind === "skill" && !c.summary.startsWith("→"));

  /** @type {string[]} */
  const lines = ["", `  ${ui.bold("명령")}`];
  for (const c of builtins) {
    lines.push(`    ${ui.cyan(`/${c.name}`.padEnd(18))} ${ui.dim(c.usage ?? c.summary)}`);
  }

  if (aliases.length) {
    lines.push("");
    lines.push(`  ${ui.bold("단축")} ${ui.dim("— 자주 쓰는 스킬")}`);
    lines.push(`    ${aliases.map((c) => ui.cyan(`/${c.name}`)).join("  ")}`);
  }

  lines.push("");
  lines.push(`  ${ui.bold("스킬")} ${ui.dim("— /<이름> 뒤에 요청을 쓰면 그대로 전달된다")}`);
  for (const c of skills) {
    lines.push(`    ${ui.cyan(`/${c.name}`.padEnd(18))} ${ui.dim(c.summary)}`);
  }

  lines.push("");
  lines.push(`  ${ui.dim("Tab 자동완성. 슬래시 없이 쓰면 요청 내용으로 에이전트를 고른다.")}`);
  lines.push("");
  return lines.join("\n");
}
