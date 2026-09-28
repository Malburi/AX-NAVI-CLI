# 모델 정책

AX Navi는 모델을 `haiku` · `sonnet` · `opus` 세 **별칭**으로만 부릅니다. 각 별칭이 실제로 어떤 모델이 될지는 실행 환경이 정하고, 조직이 따로 정해 두면 그 값이 항상 우선합니다. 이 페이지는 `docs/role-map.md`의 "초기화·수정 모델 정책"을 사용자 관점에서 정리하고, `agents/*.md` frontmatter의 실제 `model` 값을 표로 모았습니다.

## 초기화·수정 경로는 `sonnet` 하나로 통일

비용이 큰 경로는 메인 스킬·위임 호출·재시도·폴백까지 모두 `sonnet` 별칭을 씁니다. Opus로 자동 승격하지 않습니다.

| 경로 | 대상 | 근거 파일 |
|------|------|-----------|
| `harness-init` | 메인 스킬, pipeline-runner·analyzer·writer·pattern-extractor·validator·harness-evaluator·qa 호출, Phase 4 재시도(`T-A-PATCH`·`T-A-RETRY`·`T-W-RETRY`) | `skills/harness-init/SKILL.md` "모델 고정" |
| `/modify` → `safe-modify` → `analyze-impact` | 별칭 스킬, 본편 스킬, impact-analyzer 호출, 인덱스 부재 시 feature-scoped analyzer, general-purpose 폴백 | 각 SKILL.md frontmatter `model: sonnet` |
| `analyzer`·`impact-analyzer`·`writer` | 에이전트 기본 모델 | `agents/*.md` frontmatter |

Standard와 Full Tier는 분석 범위만 다르고 모델은 같습니다. Full의 전체 Phase B 분석과 변경 안전성 게이트는 모델과 무관하게 유지됩니다.

마이그레이션 계획(`plan-migration`)과 레거시 해석(`legacy-decoder`)처럼 독립적인 경로는 아래 표의 기존 모델을 그대로 씁니다.

## 왜 정식 모델 ID를 쓰지 않나

에이전트·스킬 파일에는 `claude-sonnet-5` 같은 정식 ID를 적지 않습니다. 사내 게이트웨이나 AWS Bedrock처럼 허용하는 모델이 정해진 환경이 있는데, 정식 ID를 박아 두면 그 모델을 허용하지 않는 곳에서 초기화가 첫 호출부터 막힙니다. 서브에이전트 frontmatter에 적힌 정식 ID는 환경변수로도 바꿀 수 없어서 설정으로 풀 방법도 없습니다. 별칭이면 환경과 조직 설정에 따라 알맞은 모델로 풀립니다.

`role-contract.test.mjs`가 에이전트·스킬 파일에 정식 ID가 다시 들어오지 않게 고정합니다.

## 실제로 어떤 모델이 쓰이나

| 표기 | 의미 |
|------|------|
| `sonnet` | 초기화·수정 경로와 대부분의 에이전트 |
| `opus` | `legacy-decoder`·`migration-planner`만 사용. 다른 경로가 Opus로 자동 승격하지 않음 |
| `haiku` | `/model haiku`로 고른 경우 |

별칭은 다음 순서로 실제 모델이 됩니다.

1. **조직·사용자 설정** — `~/.claude/settings.json`(관리자는 `managed-settings.json`)의 `env`에 지정한 값이 항상 우선합니다.
2. **axnavi가 이 환경에서 찾아 둔 모델** — 아래 참고.
3. **실행 환경의 기본값** — 지정이 없으면 Claude Code가 정하는 최신 모델입니다.

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

## 쓸 수 없는 모델을 만나면

따로 설정하지 않아도 됩니다. 모델이 막히면 axnavi가 오류에 적힌 "사용 가능한 모델" 목록에서 같은 계열의 가장 새 모델을 골라 바로 다시 실행합니다.

```
  이 환경은 claude-sonnet-5 를 쓸 수 없어 사용 가능한 모델(claude-sonnet-4-6, …)로 다시 실행합니다.
```

- 찾은 모델은 연결 대상(Bedrock 리전, 게이트웨이 주소)별로 `~/.axnavi/models.json`에 기억하고 다음 실행부터 처음부터 씁니다. 7일이 지나면 다시 확인합니다.
- 그 계열이 없으면 가까운 계열로 대신합니다(opus가 없으면 sonnet).
- 조직·사용자가 정해 둔 값은 덮지 않습니다.
- 이미 파일을 읽거나 고친 뒤에 막히면 다시 실행하지 않고, 다음 요청부터 새 모델을 씁니다.
- 목록을 알 수 없는 오류라면 무엇을 설정하면 되는지 안내합니다.

## 세션 모델과 스킬 모델의 구분

스킬 frontmatter의 `model:`은 그 스킬이 실행되는 턴에만 적용됩니다. 여러 턴에 걸쳐 같은 모델을 쓰고 싶으면 세션에서 직접 고릅니다.

```
/model sonnet
```

| 층 | 결정 주체 | 예 |
|----|-----------|-----|
| 세션 모델 | 사용자(`/model`) 또는 전역 설정 | 사용자가 평소 쓰는 모델 |
| 스킬 메인 모델 | SKILL.md frontmatter `model:` | `harness-init` 실행 턴은 `sonnet` |
| Agent 호출 모델 | 스킬 본문의 `Agent(model="...")` 또는 에이전트 frontmatter | analyzer 호출은 `sonnet` |

AX Navi는 사용자·조직의 전역 모델 설정과 기존 프로젝트에 이미 배포된 에이전트 사본을 자동 수정하지 않습니다. 예전 하네스가 대상 프로젝트에 남긴 `model: claude-sonnet-5`는 재초기화 때 `sonnet`으로 바뀝니다.

## 에이전트별 model 표

`agents/*.md` frontmatter의 실제 값입니다.

| 에이전트 | frontmatter `model` | 비고 |
|----------|---------------------|------|
| `analyzer` | `sonnet` | 초기화·수정 경로 |
| `impact-analyzer` | `sonnet` | 초기화·수정 경로 |
| `writer` | `sonnet` | 초기화 경로 |
| `api-bridge` | `sonnet` | pair-init·cross-repo 경로 |
| `change-safety` | `sonnet` | |
| `doc-syncer` | `sonnet` | |
| `feature-finder` | `sonnet` | |
| `harness-evaluator` | `sonnet` | |
| `logic-tracer` | `sonnet` | |
| `pattern-conformance` | `sonnet` | |
| `pattern-extractor` | `sonnet` | |
| `pipeline-runner` | `sonnet` | |
| `qa` | `sonnet` | |
| `spec-clarifier` | `sonnet` | |
| `sql-reviewer` | `sonnet` | |
| `test-generator` | `sonnet` | |
| `validator` | `sonnet` | |
| `legacy-decoder` | `opus` | |
| `migration-planner` | `opus` | |

스킬 중 frontmatter에 `model`을 선언한 것은 `harness-init`·`analyze-impact`·`safe-modify`·`modify` 네 개이며 모두 `sonnet`입니다. 나머지 스킬은 세션 모델을 따릅니다.

harness-init이 대상 프로젝트에 만드는 `.claude/agents/domain-expert.md`는 frontmatter에 `model`을 선언하지 않고 세션 모델을 따릅니다.

## 비용 관점에서 알아둘 것

- 초기화 비용 측정치(`docs/harness-description.md`)는 analyzer가 Opus로 실행되던 시점의 값입니다. 자릿수 감각으로만 참고하세요.
- 환경에 따라 실제로 쓰이는 Sonnet 버전이 다를 수 있습니다. 같은 프로젝트라도 PC마다 결과 품질이 조금 다를 수 있습니다.
- Phase 4 재생성은 점수가 낮아도 `sonnet`을 유지하고, 모델을 이유로 보정 범위나 재시도 횟수를 늘리지 않습니다.
- AI 호출 예산(`ai-budget.mjs`)은 모델이 아니라 역할당 호출 횟수·토큰 근사치로 관리됩니다. 자세한 내용은 [Tier와 토큰 비용](/getting-started/tier-and-cost.md)을 참고하세요.

## 관련 문서

- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [에이전트 팀과 파이프라인](/concepts/agent-team.md)
- [권한과 도구 제한](/configuration/settings-and-tools.md)
- [harness-init](/skills/harness-init.md)
- [safe-modify](/skills/safe-modify.md)
- [에이전트 개요](/agents/README.md)
