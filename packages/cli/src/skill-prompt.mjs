/*
 * 스킬 실행 지시문 — v2.
 *
 * v1 비교 실험(108회)에서 절차 비용이 한 저장소 질문을 평범한 Claude Code 의 3~28배로 만들었다. 지시문에서
 * 원인이 된 것을 걷어 낸다.
 *   - 저장소가 둘 이상이면 저장소마다 서브에이전트를 띄우게 했다(실측 3분43초 → 17분). → 한 세션에서 impact 로 본다.
 *   - 리포트 파일을 "답하기 전에 꼭" 쓰게 했다. → 기본은 답만. /report 를 켜면 런타임이 답을 저장한다.
 *   - 모델이 --check-stale 을 돌렸다. → 런타임이 실행 전에 맞춘다(freshness.mjs).
 * 대신 영향도 · 수정이면 런타임이 인덱스로 계산한 사전 영향도를 앞에 둔다(precompute.mjs).
 */

/*
 * 화면에 보이는 진행 문장의 언어. 규칙이 어디에도 없어서, 녹화용 /flow 를 세 번 돌리는 동안 매번
 * 리포트를 쓰기 직전에 "Now I will write the trace report." 같은 영어 한 줄이 섞였다(실측).
 */
export const LANGUAGE_RULE = "- 사용자에게 보이는 모든 문장은 한국어로 쓴다. 도구를 부르기 전의 짧은 진행 설명도 마찬가지다. 코드·경로·식별자는 원문 그대로 둔다.";

/*
 * 탐색 범위. 실측(safe-modify 녹화 두 번 연속): `find / -path …` 로 120초 제한에 걸려 2분을 썼다.
 * 프레임워크 jar 안은 소스가 없으니 찾을 것이 없다.
 */
export const SEARCH_SCOPE_RULE = "- 파일 탐색은 프로젝트 루트(와 아래 적힌 짝 저장소) 안에서만 한다. `find /` 처럼 디스크 전체를 뒤지지 마라. 프레임워크·라이브러리(jar) 안의 클래스는 소스가 없으니 '저장소 밖이라 확인하지 못함'으로 보고한다.";

export const FRESH_RULE = "- 인덱스는 실행 전에 런타임이 최신으로 맞췄다. `build-index.mjs --check-stale` 이나 인덱스 재생성을 직접 돌리지 마라.";

/* v1 은 소스 수정을 Edit 로 하라는 말이 없어 python -c 로 고친 실행이 있었다(실제 레거시 벤치 C-R2-1). */
export const EDIT_RULE = "- 소스는 Edit·Write 도구로만 고친다. python·sed·리다이렉트 같은 셸 명령으로 소스를 쓰지 마라 — 런타임이 막거나 승인을 다시 묻고, 레거시 인코딩(EUC-KR) 보호도 받지 못한다.";

/**
 * @param {ReadonlyArray<{ name: string, paths: { root: string } }>} roots
 * @returns {string[]}
 */
export function multiRootLines(roots) {
  if (roots.length <= 1) return [];
  return [
    `- 저장소 ${roots.length}개를 함께 본다: ${roots.map((r) => `${r.name}(${r.paths.root})`).join(", ")}.`,
    "  다른 저장소에 미치는 영향은 `QueryIndex` 의 `impact`(sql=… 또는 id=…, column=…) 한 번으로 본다 — 짝 저장소까지 따라간다.",
    "  저장소마다 서브에이전트를 띄우지 마라. 한 세션에서 QueryIndex(root=…) · grep 으로 처리한다.",
  ];
}

/**
 * @param {boolean} reportOn
 * @returns {string}
 */
export function reportRule(reportOn) {
  return reportOn
    ? "- 네 답이 그대로 `_workspace/reports/` 에 리포트로 저장된다(런타임이 쓴다). 리포트 파일을 따로 쓰지 마라."
    : "- 리포트 파일은 쓰지 않는다 — 에이전트 지침에 리포트 경로가 있어도 답으로만 보고한다. 저장할지 묻지도 마라.";
}

/*
 * "없음의 확인"을 요구한다. 플러그인 답과 비교해 보니 값진 부분이 "확인했는데 없더라"였다.
 * 이름 목록 grep 0건을 "기능이 없다"로 쓰면 틀린다(실측: @EgovNullCheck 를 못 보고 "검증 없음").
 */
export const REPORT_FORMAT = [
  "## 보고 형식",
  "결론을 먼저 쓰고, 셋을 나눠 보고한다.",
  "1. **찾은 것** — 파일 경로와 줄 번호를 함께.",
  "2. **확인했는데 없는 것** — 무엇을 어떻게 확인했는지(어느 인덱스 질의 · 어떤 grep). 이름 목록 grep 0건은 \"그 이름이 없다\"까지만 쓴다.",
  "3. **확인하지 못한 것** — 왜 못 했는지(소스 없음 · 인덱스 없음 · 범위 밖).",
  "오탐을 걸러냈으면 무엇을 왜 걸렀는지 한 줄로 남겨라.",
].join("\n");

/**
 * 단일 에이전트 스킬의 지시문. 요청을 맨 앞에 둔다 — 절차 문서를 앞에 두면 모델이 스킬 소개를 한다(실측).
 * @param {object} a
 * @param {{ name: string, body: string }} a.skill
 * @param {string} a.agentName
 * @param {string} a.prompt
 * @param {string} a.projectRoot
 * @param {ReadonlyArray<{ name: string, paths: { root: string } }>} a.roots
 * @param {string | null} a.precomputed
 * @param {boolean} a.reportOn
 * @returns {string}
 */
export function agentInstruction({ skill, agentName, prompt, projectRoot, roots, precomputed, reportOn }) {
  return [
    "# 요청",
    prompt,
    "",
    `프로젝트 루트: ${projectRoot}`,
    ...multiRootLines(roots),
    ...(precomputed ? ["", precomputed, "위 사전 영향도는 인덱스의 사실이다. 출발점으로 삼아 원문으로 검증 · 보완하고, 같은 탐색을 처음부터 반복하지 마라."] : []),
    "",
    "---",
    `'${skill.name}' 스킬 경로로 들어온 요청이다. 너는 실행자(${agentName})다. 아래 절차는 참고 자료다 — 설명하지 말고 요청을 수행하라.`,
    LANGUAGE_RULE,
    SEARCH_SCOPE_RULE,
    FRESH_RULE,
    reportRule(reportOn),
    "- 서브에이전트를 띄우지 마라. 절차에 위임이 적혀 있어도 네가 직접 한다.",
    "",
    REPORT_FORMAT,
    "",
    `<스킬 절차: ${skill.name}>`,
    skill.body,
    "</스킬 절차>",
  ].join("\n");
}

/**
 * 오케스트레이터 스킬(서브에이전트를 지휘)의 지시문.
 * @param {object} a
 * @param {{ name: string, body: string }} a.skill
 * @param {string} a.prompt
 * @param {string} a.projectRoot
 * @param {ReadonlyArray<{ name: string, paths: { root: string } }>} a.roots
 * @param {string | null} a.precomputed
 * @param {boolean} a.reportOn
 * @returns {string}
 */
export function orchestratorInstruction({ skill, prompt, projectRoot, roots, precomputed, reportOn }) {
  return [
    "# 실행 지시",
    "",
    `아래 절차(${skill.name})를 **지금 이 프로젝트에 실제로 수행**하라. 절차를 설명하지 마라.`,
    `프로젝트 루트: ${projectRoot}`,
    prompt ? `사용자 요청: ${prompt}` : "사용자 요청: 없음",
    ...multiRootLines(roots),
    ...(precomputed ? ["", precomputed, "위 사전 영향도는 인덱스의 사실이다. 영향도 단계는 이것을 검증 · 보완하는 것으로 갈음하고, 같은 탐색을 서브에이전트로 다시 돌리지 마라."] : []),
    "",
    LANGUAGE_RULE,
    SEARCH_SCOPE_RULE,
    FRESH_RULE,
    EDIT_RULE,
    /* 오케스트레이터는 서브에이전트끼리 리포트 파일로 결과를 넘긴다(impact_ → safety_). 그건 절차대로 쓴다. */
    `- 절차가 서브에이전트끼리 넘기는 중간 산출물(\`_workspace/reports/*\`)은 절차대로 쓴다. 최종 보고는 답으로 한다${reportOn ? " — 답은 런타임이 리포트로도 저장한다" : ""}.`,
    "",
    "## 이 런타임에서 위임하는 법",
    "- 서브에이전트는 절차가 꼭 요구할 때만 띄운다. 직접 할 수 있는 확인은 직접 한다 — 서브에이전트마다 시간과 비용이 몇 배로 든다.",
    "- 띄울 때는 절차에 적힌 `ax-navi:<에이전트>` 이름을 그대로 `Task` 의 `subagent_type` 에 넣는다. general-purpose 로 폴백하지 마라.",
    "- 띄운 서브에이전트의 결과를 받기 전에 턴을 끝내지 마라. 이 실행 경로에는 네가 나중에 깨어날 방법이 없다(실측). 결과는 `TaskOutput` 으로 받는다.",
    "  정말 더 기다릴 수 없으면(상한 · 중단) 끝났다고 하지 말고, 어느 단계가 어디까지 갔는지와 다음에 이을 일을 체크포인트 파일에 적고 알려라.",
    "- 진행 상황은 `TaskCreate`/`TaskUpdate` 로 관리한다. 없으면 `_workspace/00_pipeline_status.md` 체크리스트로 한다.",
    "- 사용자에게 물어야 하면 AskUserQuestion 을 쓴다. 답이 비어 오면 기본값으로 진행하되 \"사용자 확인\"으로 기록하지 말고(unconfirmed: true) 무엇을 가정했는지 밝혀라.",
    "- 스킵 조건에 걸려 이전 결정을 재사용할 때는 화면에 밝혀라 — 무엇 때문에 어느 단계를 건너뛰고 어떤 값을 재사용하는지 한 줄로.",
    "  재사용하려는 값이 미확인(unconfirmed)으로 기록돼 있으면 건너뛰지 말고 다시 물어라.",
    "- 인덱스 질의는 `mcp__axnavi__QueryIndex`(impact · search · trace …)를 쓴다. 스크립트 경로는 절대경로로 치환돼 있으니 그대로 Bash 로 실행한다.",
    "",
    `## 절차: ${skill.name}`,
    "",
    skill.body,
  ].join("\n");
}

/**
 * 절차 스킬(에이전트도 위임도 없는 스크립트 절차)의 지시문.
 * @param {object} a
 * @param {{ name: string, body: string }} a.skill
 * @param {string} a.prompt
 * @param {string} a.projectRoot
 * @returns {string}
 */
export function procedureInstruction({ skill, prompt, projectRoot }) {
  return [
    "# 실행 지시",
    "",
    `아래 절차(${skill.name})를 **지금 이 프로젝트에 실제로 수행**하라. 절차를 설명하지 마라.`,
    `프로젝트 루트: ${projectRoot}`,
    prompt ? `사용자 요청: ${prompt}` : "사용자 요청: 없음",
    LANGUAGE_RULE,
    SEARCH_SCOPE_RULE,
    "",
    "## 이 런타임에서의 실행 방법",
    "- 이 절차는 대부분 결정론적 스크립트 실행이다. 스크립트 경로는 절대경로로 치환돼 있으니 그대로 Bash 로 실행하라.",
    "- 파이썬은 `python3` 을 먼저 시도하고 실패하면 `python` 을 쓴다.",
    "- 서브에이전트는 띄울 수 없다. 절차에 위임이 적혀 있으면 네가 직접 그 일을 하라.",
    "- 스크립트가 실패하면 성공으로 보고하지 마라. 어느 명령이 어떤 오류로 실패했는지 그대로 알려라.",
    "",
    `## 절차: ${skill.name}`,
    "",
    skill.body,
  ].join("\n");
}

/**
 * 대화 중에 부른 단일 에이전트 스킬을 **같은 세션 안에서** 수행하게 하는 지시(도구 결과로 돌려준다).
 * v1 은 대화 인격의 턴이 끝난 뒤 스킬을 새 세션으로 다시 돌려, 요청 하나에 세션이 둘이었다.
 * @param {object} a
 * @param {{ name: string, body: string }} a.skill
 * @param {string} a.agentBody   실행자 에이전트의 지침
 * @param {string} a.request
 * @param {string | null} a.precomputed
 * @param {boolean} a.reportOn
 * @returns {string}
 */
export function inlineInstruction({ skill, agentBody, request, precomputed, reportOn }) {
  return [
    `'${skill.name}' 스킬을 이 턴 안에서 직접 수행하라. 같은 스킬로 이 도구를 다시 부르지 마라. 서브에이전트를 띄우지 마라.`,
    ...(request ? ["", `요청: ${request}`] : []),
    ...(precomputed ? ["", precomputed, "위 사전 영향도는 인덱스의 사실이다. 출발점으로 삼아 원문으로 검증 · 보완하라."] : []),
    "",
    FRESH_RULE,
    reportRule(reportOn),
    "",
    REPORT_FORMAT,
    "",
    "<실행자 지침>",
    agentBody,
    "</실행자 지침>",
    "",
    `<스킬 절차: ${skill.name}>`,
    skill.body,
    "</스킬 절차>",
  ].join("\n");
}

/**
 * 실행자에게 줄 스킬 본문. SKILL.md 에 `<!-- cli:executor -->` … `<!-- /cli:executor -->` 구간이 있으면 그것만 준다.
 * 그 밖의 본문은 플러그인에서 오케스트레이터가 서브에이전트를 부르는 절차라, 실행자 본인에게 주면 자기를 호출하라는
 * 지시를 읽고 헷갈리고 토큰만 든다. 구간이 없으면 본문 전체를 준다(옛 스킬과 호환).
 * @param {string} body
 * @returns {string}
 */
export function executorBody(body) {
  const m = /<!--\s*cli:executor\s*-->([\s\S]*?)<!--\s*\/cli:executor\s*-->/.exec(body);
  return m ? (m[1] ?? "").trim() : body;
}
