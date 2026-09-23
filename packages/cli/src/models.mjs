/*
 * "이 모델은 쓸 수 없다" 오류를 알아보고, 무엇을 설정하면 되는지 알려 준다.
 *
 * 사내 게이트웨이는 허용하는 모델이 조직마다 다르다. 실측으로 이런 오류가 났다.
 *
 *   API Error: 400 'claude-sonnet-5' 모델은 사용할 수 없습니다.
 *   사용 가능한 모델: claude-haiku-4-5-20251001, claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6
 *
 * axnavi 는 `sonnet` 같은 별칭을 넘기고, 실제 모델은 claude 가 정한다. 조직은
 * ANTHROPIC_DEFAULT_*_MODEL 로 별칭이 가리킬 모델을 정할 수 있다. 그 설정을
 * 모르면 사용자는 오류만 보고 막힌다.
 *
 * **자동으로 바꿔 끼우지 않는다.** 어떤 모델로 대신할지는 품질·비용이 걸린 조직의
 * 결정이다. 오류가 알려 준 목록에서 등급별로 가장 새 모델을 골라 "이렇게 설정하면
 * 된다" 고 보여 주기만 한다.
 */

/** 모델을 못 쓴다는 뜻의 오류. 게이트웨이 한국어 문구와 API 영어 문구를 둘 다 본다. */
const UNAVAILABLE =
  /모델은\s*사용할\s*수\s*없|사용할\s*수\s*없는\s*모델|model[^.\n]{0,60}(?:not available|not found|not supported|does not exist|not allowed|is not enabled)|invalid model|unknown model/i;

/** 오류가 알려 주는 허용 목록. */
const OFFERED = /(?:사용\s*가능한\s*모델|available models?|allowed models?)\s*[:：]\s*([^\n]+)/i;

/** 등급 → claude 가 별칭을 풀 때 보는 환경변수. */
const FAMILIES = /** @type {const} */ ([
  ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
]);

/**
 * 모델 ID 의 버전 숫자. 날짜 꼬리(20251001)는 버전이 아니라서 뺀다.
 * @param {string} id
 * @returns {number[]}
 */
function versionOf(id) {
  return id
    .split("-")
    .slice(2)
    .filter((part) => /^\d{1,3}$/.test(part))
    .map(Number);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * 오류가 알려 준 목록에서 등급(계열)별로 가장 새 모델을 고른다.
 * @param {readonly string[]} offered
 * @returns {Array<{ env: string, model: string }>}
 */
export function suggestMapping(offered) {
  /** @type {Array<{ env: string, model: string }>} */
  const out = [];
  for (const [family, env] of FAMILIES) {
    let best = "";
    for (const id of offered) {
      if (!id.startsWith(`claude-${family}-`)) continue;
      if (!best || newer(versionOf(id), versionOf(best))) best = id;
    }
    if (best) out.push({ env, model: best });
  }
  return out;
}

/**
 * 모델을 못 쓴다는 오류면 안내 줄을, 아니면 null.
 * @param {string} reason
 * @returns {string[] | null}
 */
export function modelUnavailableHint(reason) {
  const text = String(reason ?? "");
  if (!UNAVAILABLE.test(text)) return null;

  const rejected = /['"`](claude-[\w.-]+)['"`]/.exec(text)?.[1];
  const listed = OFFERED.exec(text)?.[1] ?? "";
  const offered = [...new Set(listed.match(/claude-[\w.-]+/g) ?? [])].map((id) => id.replace(/[.,]+$/, ""));
  const mapping = suggestMapping(offered);

  const lines = [
    `  이 환경은 ${rejected ? `${rejected} 를` : "요청한 모델을"} 허용하지 않습니다. 등급마다 쓸 모델을 조직 설정으로 정하면 됩니다.`,
  ];
  if (mapping.length) {
    lines.push("  ~/.claude/settings.json 에 아래를 넣고 다시 실행하세요 (관리자라면 managed-settings.json 의 env).");
    lines.push("    \"env\": {");
    mapping.forEach(({ env, model }, i) => {
      lines.push(`      "${env}": "${model}"${i < mapping.length - 1 ? "," : ""}`);
    });
    lines.push("    }");
    lines.push("  위 모델은 오류가 알려 준 목록에서 계열별로 가장 새 것을 고른 예시입니다. 무엇을 쓸지는 조직이 정합니다.");
  } else {
    lines.push("  ~/.claude/settings.json 의 env 에 ANTHROPIC_DEFAULT_SONNET_MODEL · _OPUS_ · _HAIKU_ 를 허용된 모델로 지정하세요.");
  }
  return lines;
}
