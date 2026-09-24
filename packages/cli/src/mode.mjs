/*
 * 실행 모드.
 *
 * Claude Code 는 Shift+Tab 으로 normal / auto-accept / plan 을 돈다. 그중 auto-accept 는
 * 여기에 대응하는 것이 없다 — 우리 Gateway 에는 도구마다 사람에게 묻는 단계가 아예 없어서
 * "자동 수락"할 대상이 없다. 있는 척하면 아무 일도 안 하는 모드가 하나 생긴다.
 *
 * 그래서 **실제로 강제할 수 있는 축**으로만 만든다.
 *   - 읽기 전용: allowMutations 를 끈다. 역할이 무엇이든 쓰기 도구가 목록에서 빠진다.
 *   - 빠름: vibe 스킬의 정책을 얹는다. 이건 강제가 아니라 지침이고, 화면에도 그렇게 적는다.
 */

const NEWLINE = String.fromCharCode(10);

/**
 * @typedef {object} Mode
 * @property {string} id
 * @property {string} label
 * @property {string} hint      한 줄 설명
 * @property {string} [caveat]   런타임이 막지 못하는 부분. 없으면 전부 강제된다.
 * @property {boolean} [explicitOnly]  Shift+Tab 순환에서 빼고 /mode 이름으로만 켠다
 */

/** @type {readonly Mode[]} */
export const MODES = [
  { id: "default", label: "기본", hint: "에이전트가 선언한 도구 그대로" },
  /*
   * 계획 모드의 강제는 절반이다. Write·Edit 은 도구 목록에서 빠지지만,
   * Bash 는 `echo > file` 처럼 쓸 수 있고 그걸 런타임이 가려낼 수 없다.
   * 명령어를 글자로 보고 막는 것은 새는 검사라 하지 않는다 — 대신 그 사실을 적는다.
   */
  { id: "plan", label: "계획", hint: "고치지 않고 계획부터 냅니다", caveat: "Bash 는 지침으로만 막습니다" },
  { id: "vibe", label: "빠름", hint: "영향도·안전 게이트를 건너뛰고 바로 수행합니다", caveat: "전부 지침입니다" },
  /*
   * 승인 창을 끄는 모드. 오래 걸리는 초기화를 믿고 맡길 때 쓴다 — 감사 기록은 그대로 남는다.
   * Shift+Tab 순환에는 넣지 않는다. 다른 회사 운영 소스를 고치는 도구라 실수로 켜지면 안 되고,
   * `/mode 전부승인` 으로 이름을 불러야만 켜진다.
   */
  { id: "trust", label: "전부승인", hint: "이번 세션의 도구 사용을 묻지 않고 허용합니다 — 감사 기록은 남습니다", caveat: "되돌리기 어려운 명령도 묻지 않습니다", explicitOnly: true },
];

export const DEFAULT_MODE = "default";

/**
 * @param {string} id
 * @returns {Mode}
 */
export function modeOf(id) {
  return MODES.find((m) => m.id === id) ?? /** @type {Mode} */ (MODES[0]);
}

/**
 * 다음 모드. Shift+Tab 이 이 함수를 돈다.
 * @param {string} id
 * @returns {string}
 */
export function nextMode(id) {
  const cycle = MODES.filter((m) => !m.explicitOnly);
  const at = cycle.findIndex((m) => m.id === id);
  return /** @type {Mode} */ (cycle[(at + 1) % cycle.length]).id;
}

/*
 * 빠름 모드에 얹는 지침.
 *
 * skills/vibe/SKILL.md 의 규칙을 그대로 옮긴 것이다 — 여기서 새로 지어내면 두 벌이 갈라진다.
 * 특히 승격 조건을 빼면 안 된다. "빠름"은 검증을 건너뛰라는 뜻이지 위험한 변경까지
 * 그냥 하라는 뜻이 아니다.
 */
const VIBE_POLICY = [
  "## 빠름 모드",
  "사용자가 빠른 처리를 골랐다. analyze-impact / pattern-conformance / change-safety 게이트를 건너뛴다.",
  "다만 아래는 빠름 모드에서도 지킨다.",
  "- 요청된 부분만 건드린다. 인접 코드·주석·포맷을 '개선'하지 않는다.",
  "- 기존 파일을 고칠 때는 그 파일 자체의 스타일을 따른다.",
  "- 변경 범위에 해당하는 가장 작은 테스트·빌드·린트를 실제로 돌리고, 실패하면 성공으로 보고하지 않는다.",
  "",
  "아래에 해당하면 빠름 모드로 진행하지 말고 그 사실을 알린 뒤 멈춘다.",
  "- DB 스키마 변경 · 외부 API 계약 변경 · 트랜잭션 경계 변경",
  "- 3개 이상 파일에 걸친 수정",
].join("\n");

const PLAN_POLICY = [
  "## 계획 모드",
  "사용자가 계획 모드를 골랐다. 파일을 고치지 말고, 무엇을 어떻게 바꿀지를 먼저 내놓는다.",
  "조사·분석은 제한 없이 한다 — 근거 없는 계획은 계획이 아니다.",
  "Bash 로도 파일을 고치지 않는다. 리다이렉션·mv·rm·sed -i 같은 것은 쓰지 마라 — 그건 런타임이 막아 주지 않는다.",
  "계획에는 고칠 파일·줄, 순서, 검증 방법을 넣는다.",
].join(NEWLINE);

/**
 * 모드를 에이전트 정의에 반영한다.
 *
 * 원본을 고치지 않고 새 객체를 돌려준다 — 같은 정의가 다음 턴에도 쓰인다.
 *
 * @param {import("@ax-navi/core").AgentDefinition} agent
 * @param {string} modeId
 * @returns {import("@ax-navi/core").AgentDefinition}
 */
export function applyMode(agent, modeId) {
  if (modeId === "plan") {
    /*
     * 쓰기 도구를 뺀다. 그게 전부다.
     *
     * 한때 claude 의 --permission-mode plan 을 같이 썼다. 그쪽은 계획까지 내놓아 더
     * 나아 보였는데, **MCP 도구를 함께 막는다.** --allowedTools 에 명시해도 그렇다.
     *
     *   plan 모드 : permission_denials = [mcp__axnavi__QueryIndex]
     *   기본 모드 : permission_denials = []
     *
     * 그러면 인덱스 질의가 막혀 근거 없는 계획이 나온다. 계획 모드의 값은
     * 근거에 있으므로 쓰지 않는다. 계획을 내놓으라는 것은 지침으로 말한다.
     */
    return {
      ...agent,
      systemPrompt: `${agent.systemPrompt}\n\n${PLAN_POLICY}`,
      role: { ...agent.role, allowMutations: false },
    };
  }
  if (modeId === "vibe") {
    // 도구는 그대로 둔다. 빠름은 권한이 아니라 절차에 관한 것이다.
    return { ...agent, systemPrompt: `${agent.systemPrompt}\n\n${VIBE_POLICY}` };
  }
  return agent;
}
