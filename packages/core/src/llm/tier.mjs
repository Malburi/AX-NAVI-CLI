/*
 * 모델 별칭 → 등급 정규화.
 *
 * 저장소 안의 모델 표기는 원래 섞여 있다 — agents/*.md 19종 중 3개는 `claude-sonnet-5`로
 * 고정돼 있고(docs/role-map.md가 "별칭이 아니라 고정"이라고 못 박는다) 나머지는 `sonnet`·`opus`
 * 별칭을 쓴다. 그 혼재를 Core 전체로 번지게 두지 않고 이 파일 하나에 가둔다.
 *
 * 여기가 Core에서 Claude 모델 이름을 아는 마지막 지점이다. 실제 모델 id로의 변환은
 * 각 Provider가 하고, Core의 나머지 코드는 ModelTier만 본다.
 */

/** @typedef {import("../../types/llm.js").ModelTier} ModelTier */

/** @type {Record<string, ModelTier>} */
const ALIASES = {
  // 저장소에 실제로 등장하는 표기
  "claude-sonnet-5": "standard",
  sonnet: "standard",
  opus: "deep",
  haiku: "fast",
  // 등급 이름을 직접 쓴 경우도 받아준다
  fast: "fast",
  standard: "standard",
  deep: "deep",
};

/** @type {ModelTier} */
export const DEFAULT_TIER = "standard";

/**
 * frontmatter의 `model:` 값을 등급으로 바꾼다.
 * 모르는 값은 조용히 삼키지 않고 사유와 함께 기본 등급으로 떨어뜨린다.
 * @param {string | undefined} model
 * @returns {{ tier: ModelTier, warning?: string }}
 */
export function toTier(model) {
  if (!model) return { tier: DEFAULT_TIER };
  const key = model.trim().toLowerCase();
  const hit = ALIASES[key];
  if (hit) return { tier: hit };
  return {
    tier: DEFAULT_TIER,
    warning: `알 수 없는 model 표기 "${model}" — ${DEFAULT_TIER} 등급으로 처리했다.`,
  };
}
