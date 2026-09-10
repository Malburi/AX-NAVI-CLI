# spec-clarifier

작업 시작 전에 소크라테스식 인터뷰로 모호성을 제거하는 에이전트다. 범위·목표·제약·레거시·우선순위 5개 영역에서 질문을 만들고 사용자 응답을 점수화해 모호성 0.2 이하면 GO 신호를 낸다. validator·qa·harness-evaluator가 생성 후 결과물을 검증하는 데 비해 이 에이전트는 분석 전에 "사람이 원하는 것이 명확한가"를 본다. 질문 생성·점수 계산·리포트 작성만 하며 코드 분석이나 파일 수정은 하지 않는다.

## 호출 경로

- [spec-gate](/skills/spec-gate.md) Step 1이 `mode: question`으로, Step 2가 `mode: score`로 부른다. REFINE이면 Step 3에서 한 번 더 부른다.
- harness-init은 더 이상 자동 호출하지 않는다. 필요하면 harness-init 실행 전에 spec-gate를 별도로 실행한다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write, AskUserQuestion`이다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않으며, 19종 중 유일하게 `AskUserQuestion`으로 사용자에게 직접 질문한다.

## 하는 일

1. question 모드에서 코드를 깊이 읽지 않고 루트 파일만 경량 스캔한다. `package.json`·`pom.xml`·`requirements.txt` 등으로 스택을 1차 분류하고 README 첫 30줄과 디렉토리 이름을 본다.
2. 5개 영역에서 각 1개 질문을 만들되 스캔으로 이미 명확한 영역은 건너뛴다. 스택이 확인되면 질문을 구체화한다(예: Vue 2 탐지 시 "Vue 3 마이그레이션을 고려하고 있나요?").
3. 질문을 한국어 번호 목록으로 제시하고 "없음"·"모름"·"스킵" 응답 방법을 안내한다.
4. score 모드에서 응답 유형별로 영역 가중치에 계수를 곱해 모호성 점수를 계산한다.
5. 점수에 따라 GO·REFINE·GO(미답변 진행)를 결정한다.
6. REFINE이면 모호성 높은 영역 최대 2개에 후속 질문 1개씩을 낸다(1회 한도). 2차 응답 후에는 점수와 무관하게 GO다.
7. `_workspace/00_spec_report.md`를 쓰고 analyzer 힌트와 tier 권고를 남긴다.
8. 사용자가 "스킵"이라 하면 점수 계산 없이 즉시 GO를 내고 리포트에 "사용자 스킵 — analyzer 자동 탐지 예정" 한 줄만 쓴다.

## 입력과 산출물

| 구분 | 내용 |
|------|------|
| 읽음 (question) | 프로젝트 루트 파일, README.md 첫 30줄, 디렉토리 이름 |
| 읽음 (score) | 이전 질문 목록 + 사용자 응답 텍스트 |
| 씀 | `_workspace/00_spec_report.md` |

## 판정·출력 형식

영역별 가중치는 범위 0.25, 목표 0.25, 제약 0.20, 레거시 0.15, 우선순위 0.15다. 응답 계수는 명확한 답변 0.0, 부분적 답변 0.5, "없음"/"모름" 0.3, 무응답 1.0이다.

| 총 모호성 | 신호 | 다음 동작 |
|----------|------|---------|
| ≤ 0.2 | GO | 리포트 작성 후 harness-init Phase 0 진행 |
| 0.21 ~ 0.4 | REFINE | 점수 높은 영역 1~2개 재질문 (1회) |
| > 0.4 | GO (미답변 진행) | 강제 중단 없음, analyzer가 코드에서 직접 파악 |

리포트는 `=== SPEC CLARIFICATION REPORT ===`로 시작해 모호성 점수·신호, 명확화된 범위, 작업 목표(코드이해/버그수정/신규개발/마이그레이션/복합), 제약 사항, 레거시 주의사항, 우선순위, 그리고 `Analyzer 지시 사항`(`scope_hint`·`goal_hint`·`constraint_hint`·`priority_hint`·`tier_suggestion`)으로 끝난다. tier 권고는 코드 이해·버그 수정·신규 개발이면 Standard, 마이그레이션이나 레거시 특이사항 언급이면 Full이다.

## 원칙

- 점수가 높아도 강제로 멈추지 않는다. 사용자가 답하기 어려운 상황일 수 있고 analyzer가 코드에서 대부분 추론할 수 있다.
- 전체 분석은 analyzer 담당이다. 경량 스캔은 더 날카로운 질문을 위한 최소 컨텍스트 확보가 목적이다.
- 재질문은 최대 1회다.

## 관련 문서

- [spec-gate](/skills/spec-gate.md)
- [harness-init](/skills/harness-init.md)
- [harness-evaluator](/agents/harness-evaluator.md)
- [Tier와 비용](/getting-started/tier-and-cost.md)
- [온보딩 첫날](/tutorials/onboarding-day1.md)
