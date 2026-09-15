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

/**
 * @typedef {object} Mode
 * @property {string} id
 * @property {string} label
 * @property {string} hint      한 줄 설명
 * @property {boolean} enforced 런타임이 막는가, 아니면 모델에게 부탁하는가
 */

/** @type {readonly Mode[]} */
export const MODES = [
  { id: "default", label: "기본", hint: "에이전트가 선언한 도구 그대로", enforced: true },
  { id: "readonly", label: "읽기 전용", hint: "무엇도 고치지 않는다 — 조사·분석만", enforced: true },
  { id: "vibe", label: "빠름", hint: "영향도·안전 게이트를 건너뛰고 바로 수행", enforced: false },
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
  const at = MODES.findIndex((m) => m.id === id);
  return /** @type {Mode} */ (MODES[(at + 1) % MODES.length]).id;
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

const READONLY_POLICY = [
  "## 읽기 전용",
  "사용자가 읽기 전용을 골랐다. 파일을 만들거나 고치지 않는다 — 쓰기 도구는 실제로 막혀 있다.",
  "무엇을 어떻게 바꾸면 되는지는 설명하되, 바꾸지는 마라.",
].join("\n");

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
  if (modeId === "readonly") {
    return {
      ...agent,
      systemPrompt: `${agent.systemPrompt}\n\n${READONLY_POLICY}`,
      role: { ...agent.role, allowMutations: false },
    };
  }
  if (modeId === "vibe") {
    // 도구는 그대로 둔다. 빠름은 권한이 아니라 절차에 관한 것이다.
    return { ...agent, systemPrompt: `${agent.systemPrompt}\n\n${VIBE_POLICY}` };
  }
  return agent;
}
