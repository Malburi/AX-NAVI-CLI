# 에이전트 개요

AX Navi는 19종의 서브에이전트로 구성된다. 하네스를 만드는 파이프라인 에이전트, 만들어진 하네스 위에서 수정·개발·리뷰를 돕는 작업용 에이전트, 백엔드와 프론트엔드가 별도 저장소일 때 둘을 이어 주는 크로스 리포 에이전트로 나뉜다. 각 에이전트의 정의는 플러그인의 `agents/<name>.md` 한 파일이며, 역할은 그 파일의 frontmatter `description`에 적혀 있다.

## 19종 한눈에 보기

"소스 수정" 열은 frontmatter `tools`에 `Edit`가 있는지로 판단했다. `Edit`가 없는 에이전트는 `Write`로 새 리포트를 쓸 수는 있어도 기존 소스 파일을 제자리에서 고치지 않는다. `tools`를 지정하지 않은 에이전트는 기본 도구 세트를 쓰므로 본문에 적힌 작업 범위를 함께 표기했다.

| 이름 | 역할 한 줄 | 호출하는 스킬 | 모델 | 소스 수정 |
|------|-----------|--------------|------|----------|
| [analyzer](/agents/analyzer.md) | 코드베이스 구조·스택·의존성·트랜잭션·외부 통신을 분석해 리포트와 인덱스를 만든다 | harness-init | claude-sonnet-5 | tools 미지정. 본문이 하네스·코드 수정을 금지 |
| [writer](/agents/writer.md) | 분석 리포트로 프로젝트 전용 스킬(trace·scaffolder·find-logic)과 결정 값 JSON을 생성한다 | harness-init | claude-sonnet-5 | tools 미지정. 하네스 파일만 생성 |
| [pattern-extractor](/agents/pattern-extractor.md) | 실제 코드 샘플로 레이어별 컨벤션을 추출해 패턴 문서와 `pattern_profile.json`을 만든다 | harness-init | sonnet | tools 미지정. 패턴 파일만 생성 |
| [validator](/agents/validator.md) | 생성된 하네스와 인덱스를 11개 항목으로 검증해 신뢰도 점수를 낸다 | harness-init | sonnet | 읽기·리포트 전용 |
| [qa](/agents/qa.md) | 코드·인덱스·하네스 경계면을 Set 연산으로 교차 비교해 누락·고아 항목을 찾는다 | harness-init (온디맨드) | sonnet | 읽기·리포트 전용 |
| [harness-evaluator](/agents/harness-evaluator.md) | 하네스의 실용 품질을 4개 차원 100점으로 평가하고 재생성 대상을 돌려준다 | harness-init | sonnet | 읽기·리포트 전용 |
| [spec-clarifier](/agents/spec-clarifier.md) | 작업 전 소크라테스식 인터뷰로 모호성을 점수화하고 GO/REFINE을 낸다 | spec-gate | sonnet | 읽기·리포트 전용 (+AskUserQuestion) |
| [pipeline-runner](/agents/pipeline-runner.md) | harness-init의 결정론적 스크립트 블록을 대신 실행하고 요약만 반환한다 | harness-init | sonnet | tools 미지정. 파일 내용 작성·수정 금지 |
| [impact-analyzer](/agents/impact-analyzer.md) | 변경 대상의 직간접 영향을 추적해 위험도 점수 1~10을 낸다 | analyze-impact, safe-modify | claude-sonnet-5 | 읽기·리포트 전용 |
| [change-safety](/agents/change-safety.md) | diff·영향·패턴 판정·실행 증거를 종합해 GO/HOLD/STOP을 낸다 | safe-modify, scaffold-feature, cross-repo-modify | sonnet | 읽기·리포트 전용 |
| [pattern-conformance](/agents/pattern-conformance.md) | 변경 코드가 모듈의 실제 기준 파일과 패턴 프로필을 따르는지 CONFORM/HOLD/FAIL로 판정한다 | safe-modify, scaffold-feature | sonnet | 읽기·리포트 전용 |
| [migration-planner](/agents/migration-planner.md) | 스택 마이그레이션의 인벤토리·매핑·단계 계획·위험·테스트·롤백 문서를 만든다 | plan-migration | opus | 읽기·문서 생성 전용 |
| [test-generator](/agents/test-generator.md) | 기존 테스트 컨벤션을 따라 회귀 테스트 골격을 생성한다 | scaffold-feature, safe-modify (선택) | sonnet | tools 미지정. 테스트 파일만 생성, non-test 수정 금지 |
| [sql-reviewer](/agents/sql-reviewer.md) | SQL·DDL을 사용처·성능·보안·트랜잭션·스키마 관점으로 리뷰한다 | review-sql | sonnet | 읽기·리포트 전용 |
| [legacy-decoder](/agents/legacy-decoder.md) | 주석 없는 레거시 코드를 근거 있는 해석으로 역공학한다 | 직접 호출 | opus | 읽기·리포트 전용 |
| [doc-syncer](/agents/doc-syncer.md) | 코드 변경 후 문서 불일치를 점검하고 업데이트를 권고한다 | 직접 호출, safe-modify (선택) | sonnet | 읽기·리포트 전용. 승인 시 Write로 문서 갱신 |
| [logic-tracer](/agents/logic-tracer.md) | 기능·API·화면의 처리 흐름을 진입점부터 DB까지 추적한다 | trace-logic | sonnet | 읽기·리포트 전용 |
| [feature-finder](/agents/feature-finder.md) | 기능명·키워드로 관련 파일·클래스·메서드·SQL 위치를 찾는다 | find-feature | sonnet | 읽기·리포트 전용 |
| [api-bridge](/agents/api-bridge.md) | 백엔드 API 계약을 추출·검증하고 프론트엔드 서비스 스텁을 만든다 | pair-init, cross-repo-scaffold, cross-repo-modify, 직접 호출 | sonnet | tools 미지정. 기존 코드 수정 금지 |

## 세 갈래 구분

### 파이프라인 에이전트

[harness-init](/skills/harness-init.md) 한 번의 실행 안에서 순서대로 움직인다. `analyzer` → `writer` → `pattern-extractor` → `validator` → `harness-evaluator`가 기본 흐름이고, `pipeline-runner`가 그 사이의 인덱싱·조립·기계 검증·wiki 블록을 스크립트로 처리한다. `qa`는 Phase 3.6 메뉴에서 사용자가 고를 때만 Phase 3.7에서 실행되고, `spec-clarifier`는 harness-init이 아니라 별도 스킬 [spec-gate](/skills/spec-gate.md)가 부른다. 산출물은 `_workspace/00~07_*.md` 번호 파일과 `_workspace/index/*.json`이다.

### 작업용 에이전트

하네스가 만들어진 뒤 개별 작업 스킬이 부른다. `impact-analyzer`·`pattern-conformance`·`change-safety`는 [safe-modify](/skills/safe-modify.md)의 사전·사후 게이트를 이루고, `test-generator`는 [scaffold-feature](/skills/scaffold-feature.md)의 테스트 레이어를 채운다. `migration-planner`·`sql-reviewer`·`logic-tracer`·`feature-finder`는 각각 대응 스킬 하나가 전담 호출한다. `legacy-decoder`와 `doc-syncer`는 스킬 없이 직접 부른다.

### 크로스 리포 에이전트

`api-bridge` 하나다. 백엔드와 프론트엔드가 별도 저장소인 Type B 구조에서 `extract`·`validate`·`generate-stub`·`check-impact` 네 모드로 동작하며 [pair-init](/skills/pair-init.md), [cross-repo-scaffold](/skills/cross-repo-scaffold.md), [cross-repo-modify](/skills/cross-repo-modify.md)가 부른다.

## 네임스페이스 호출 방식

스킬 안의 모든 `Agent()` 호출은 `subagent_type="ax-navi:<에이전트 이름>"` 형식이다. 네임스페이스로 부르면 `agents/<name>.md`의 지침이 서브에이전트의 시스템 프롬프트로 자동 로드되므로 서브에이전트가 지침 파일을 직접 읽지 않고, 프롬프트에는 프로젝트 루트·mode·tier·입출력 파일 같은 인자만 남는다. `description`에는 `[task-id] · [에이전트 이름] · 한글 목적`을 넣어 사용자 화면에 어느 단계가 실행 중인지 드러낸다.

```
Agent(
  subagent_type="ax-navi:impact-analyzer",
  description="impact-analyzer · 변경 영향 분석",
  prompt="<프로젝트 루트: [절대경로]. 변경 대상: [식별자]. 출력: _workspace/reports/impact_<slug>.md>"
)
```

## 직접 호출 가능한 에이전트

루트 CLAUDE.md의 자동 워크플로우 표는 스킬을 거치지 않고 에이전트를 바로 부르는 경우를 세 가지 적어 두었다.

| 상황 | 직접 호출 대상 |
|------|--------------|
| 레거시 코드 해석 | `legacy-decoder` |
| 문서 동기화 | `doc-syncer` |
| 프론트엔드 서비스 스텁만 생성 | `api-bridge` (`generate-stub` 모드) |

`logic-tracer`와 `feature-finder`도 frontmatter에 자연어 트리거 문구가 있지만, 정상 경로는 [trace-logic](/skills/trace-logic.md)(`/flow`)과 [find-feature](/skills/find-feature.md)(`/find`) 스킬이 인덱스를 준비한 뒤 부르는 것이다.

## 산출물 위치 규칙

작업용 에이전트의 리포트는 모두 `_workspace/reports/<종류>_<slug>.md`에 쓴다. `slug`는 변경 대상이나 검색어에서 만든 식별자다.

| 에이전트 | 파일 |
|---------|------|
| impact-analyzer | `impact_<slug>.md` |
| pattern-conformance | `pattern_conformance_<slug>.md` |
| change-safety | `safety_<slug>.md` |
| test-generator | `tests_<slug>.md` |
| sql-reviewer | `sql_review_<slug>.md` |
| legacy-decoder | `decoded_<slug>.md` |
| doc-syncer | `docs_sync_<slug>.md` |
| logic-tracer | `trace_<slug>.md` |
| feature-finder | `found_<slug>.md` |
| api-bridge (validate) | `api_drift_report.md` (프론트엔드 루트) |

파이프라인 에이전트는 `_workspace/01_analyzer_report.md`, `03_validator_report.md`, `04_qa_report.md`, `06_eval_report.md`처럼 번호 파일을 쓰고, `migration-planner`는 `_workspace/migration/` 폴더에 문서 6종과 체크포인트를 쓴다. 파일 목록 전체는 [작업공간 파일](/reference/workspace-files.md)에 있다.

## 관련 문서

- [에이전트 팀 개념](/concepts/agent-team.md)
- [게이트](/concepts/gates.md)
- [모델 정책](/configuration/model-policy.md)
- [설정과 도구](/configuration/settings-and-tools.md)
- [스킬 별칭](/skills/aliases.md)
