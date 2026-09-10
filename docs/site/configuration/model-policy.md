# 모델 정책

AX Navi는 비용이 큰 초기화 경로와 수정 경로의 모델을 `claude-sonnet-5`로 고정하고, 그 밖의 에이전트는 각자의 frontmatter에 선언된 모델을 따릅니다. 이 페이지는 `docs/role-map.md`의 "초기화·수정 모델 정책"을 사용자 관점에서 다시 정리하고, `agents/*.md` frontmatter의 실제 `model` 값을 표로 모았습니다.

## 고정 범위

다음 경로는 메인 스킬·위임 호출·재시도·폴백까지 모두 `claude-sonnet-5`를 사용합니다.

| 경로 | 고정 대상 | 근거 파일 |
|------|-----------|-----------|
| `harness-init` | 메인 스킬, pipeline-runner·analyzer·writer·pattern-extractor·validator·harness-evaluator·qa 호출, Phase 4 재시도(`T-A-PATCH`·`T-A-RETRY`·`T-W-RETRY`) | `skills/harness-init/SKILL.md` "모델 고정" |
| `/modify` → `safe-modify` → `analyze-impact` | 별칭 스킬, 본편 스킬, impact-analyzer 호출, 인덱스 부재 시 feature-scoped analyzer, general-purpose 폴백 | 각 SKILL.md frontmatter `model: claude-sonnet-5` |
| `analyzer`·`impact-analyzer`·`writer` | 에이전트 기본 모델 | `agents/*.md` frontmatter |

Standard와 Full Tier는 분석 범위만 다르고 모델은 같습니다. Full의 전체 Phase B 분석과 변경 안전성 게이트는 모델 고정과 무관하게 유지됩니다.

마이그레이션 계획(`plan-migration`)과 레거시 해석(`legacy-decoder`)처럼 독립적인 경로는 이번 고정 범위에 들어 있지 않으며, 아래 표의 기존 모델을 그대로 씁니다.

## 별칭 `sonnet`과 공식 ID의 차이

| 표기 | 의미 | 정책 |
|------|------|------|
| `claude-sonnet-5` | 공식 모델 ID | 초기화·수정 경로는 이 값만 사용 |
| `sonnet` | 호스트가 해석하는 별칭. 호스트 버전·조직 allowlist·클라우드 제공자 설정에 따라 실제 모델이 달라질 수 있음 | 고정 경로에서는 사용하지 않음. 그 밖의 에이전트는 별칭을 유지 |
| `opus` | 별칭 | `legacy-decoder`·`migration-planner`만 사용. 점수가 낮아도 다른 경로가 Opus로 자동 승격하지 않음 |

실행 모델을 호스트에서 확인할 수 없으면 스킬은 "Sonnet 5 실행을 검증했다"고 보고하지 않습니다. 모델 미지원·권한 거부·다른 모델로의 대체가 확인되면 진행을 멈추고 사용자에게 알리며, 조용히 폴백하지 않습니다. 이 규칙은 harness-init과 analyze-impact 양쪽 SKILL.md에 같은 문장으로 들어 있습니다.

## 세션 모델과 스킬 모델의 구분

스킬 frontmatter의 `model:`은 그 스킬이 실행되는 턴에만 적용됩니다. 다음 사용자 메시지에서는 세션 모델이 복원될 수 있으므로, 여러 턴에 걸친 메인 작업까지 계속 Sonnet 5로 두고 싶으면 세션에서 직접 선택합니다.

```
/model claude-sonnet-5
```

구분해야 하는 세 층은 다음과 같습니다.

| 층 | 결정 주체 | 예 |
|----|-----------|-----|
| 세션 모델 | 사용자(`/model`) 또는 전역 설정 | 사용자가 평소 쓰는 모델 |
| 스킬 메인 모델 | SKILL.md frontmatter `model:` | `harness-init` 실행 턴은 `claude-sonnet-5` |
| Agent 호출 모델 | 스킬 본문의 `Agent(model="...")` 또는 에이전트 frontmatter | analyzer 호출은 항상 `claude-sonnet-5` |

플러그인은 사용자·조직의 전역 모델 설정과 기존 프로젝트에 이미 배포된 에이전트 사본을 자동 수정하지 않습니다.

## 에이전트별 model 표

`agents/*.md` frontmatter의 실제 값입니다. harness-init 파이프라인에서 호출될 때는 스킬 쪽 `model="claude-sonnet-5"` 인자가 우선하므로, 별칭 `sonnet`인 에이전트도 초기화 중에는 Sonnet 5로 호출됩니다.

| 에이전트 | frontmatter `model` | 비고 |
|----------|---------------------|------|
| `analyzer` | `claude-sonnet-5` | 고정 범위 |
| `impact-analyzer` | `claude-sonnet-5` | 고정 범위 |
| `writer` | `claude-sonnet-5` | 고정 범위 |
| `api-bridge` | `sonnet` | pair-init·cross-repo 경로 |
| `change-safety` | `sonnet` | |
| `doc-syncer` | `sonnet` | |
| `feature-finder` | `sonnet` | |
| `harness-evaluator` | `sonnet` | 초기화 중에는 Sonnet 5로 호출 |
| `logic-tracer` | `sonnet` | |
| `pattern-conformance` | `sonnet` | |
| `pattern-extractor` | `sonnet` | 초기화 중에는 Sonnet 5로 호출 |
| `pipeline-runner` | `sonnet` | 초기화 중에는 Sonnet 5로 호출 |
| `qa` | `sonnet` | 초기화 중에는 Sonnet 5로 호출 |
| `spec-clarifier` | `sonnet` | |
| `sql-reviewer` | `sonnet` | |
| `test-generator` | `sonnet` | |
| `validator` | `sonnet` | 초기화 중에는 Sonnet 5로 호출 |
| `legacy-decoder` | `opus` | 고정 범위 밖 |
| `migration-planner` | `opus` | 고정 범위 밖 |

스킬 중 frontmatter에 `model`을 선언한 것은 `harness-init`·`analyze-impact`·`safe-modify`·`modify` 네 개이며 모두 `claude-sonnet-5`입니다. 나머지 스킬은 세션 모델을 따릅니다.

harness-init이 대상 프로젝트에 만드는 `.claude/agents/domain-expert.md`는 frontmatter에 `model`을 선언하지 않습니다. 세션 모델을 그대로 따르므로, 초기화 경로처럼 Sonnet 5로 쓰고 싶으면 위의 `/model` 선택이 필요합니다.

## 비용 관점에서 알아둘 것

- 초기화 비용 측정치(`docs/harness-description.md`)는 analyzer가 Opus로 실행되던 시점의 값이며 Sonnet 5 고정 이후 재측정 예정으로 표기되어 있습니다. 자릿수 감각으로만 참고하세요.
- Phase 4 재생성은 점수가 낮아도 Sonnet 5를 유지하고, 모델 고정을 이유로 보정 범위나 재시도 횟수를 늘리지 않습니다.
- AI 호출 예산(`ai-budget.mjs`)은 모델이 아니라 역할당 호출 횟수·시간·토큰 근사치로 관리됩니다. 자세한 내용은 [Tier와 토큰 비용](/getting-started/tier-and-cost.md)을 참고하세요.

## 관련 문서

- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [에이전트 팀과 파이프라인](/concepts/agent-team.md)
- [권한과 도구 제한](/configuration/settings-and-tools.md)
- [harness-init](/skills/harness-init.md)
- [safe-modify](/skills/safe-modify.md)
- [에이전트 개요](/agents/README.md)
