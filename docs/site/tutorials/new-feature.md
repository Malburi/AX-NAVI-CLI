# 신규 기능 개발

주문 일괄 취소 API를 추가해야 한다. 범위를 먼저 정리하고, 프로젝트 컨벤션을 그대로 따르는 골격을 만들고, 그 골격이 실제 기준 파일과 맞는지 검증하고, 회귀 테스트 골격까지 받는 흐름이다.

- **소요 시간** — 범위 정리 10분, 스캐폴딩과 검증 10~20분. 비즈니스 로직과 assertion을 채우는 시간은 별도다.
- **전제** — 하네스가 초기화돼 있고 `.claude/patterns/*.md`에 본문이 채워져 있으며 `.claude/patterns/pattern_profile.json`이 검증을 통과한다.
- **이 튜토리얼이 다루는 스킬·에이전트** — `spec-gate`, `scaffold-feature`(`/scaffold`), `pattern-conformance`, `test-generator`, `review-sql`.

## 준비

패턴 상태를 먼저 확인한다. `.claude/patterns/controller_pattern.md` 같은 파일이 추출 대상과 안티패턴 목록만 있는 스켈레톤이라면 스캐폴딩이 거부된다.

```text
패턴 추출해줘
```

`harness-init`의 부분 재실행 모드로 pattern-extractor만 돌아가며 `_workspace/05_patterns_extracted.md`와 `_workspace/pattern_profile_validation.json`이 갱신된다. 컨벤션 없이 스캐폴딩하면 추측에 기반한 잘못된 표준을 도입할 위험이 있기 때문에 이 준비는 생략할 수 없다.

## 단계별 진행

### 1. spec-gate로 범위 정리

```text
작업 범위 정해줘
```

`spec-gate`가 `spec-clarifier` 에이전트를 question 모드로 호출해 범위·목표·제약·레거시·우선순위 5개 영역에서 질문 3~5개를 만든다. 질문에 답하면 score 모드로 모호성 점수를 계산한다.

| 점수 | 신호 | 동작 |
|---|---|---|
| 0.2 이하 | GO | 명세 리포트 저장 후 다음 작업 안내 |
| 0.21~0.4 | REFINE | 재질문 1회 후 진행 |
| 0.4 초과 | GO (미답변 진행) | 그대로 진행 |

결과는 `_workspace/00_spec_report.md`에 저장되고 화면에 목표·범위·주요 제약·우선순위가 요약된다. 여기서 엔드포인트 경로, 영향 테이블, 참고할 기존 모듈을 확정해 두면 다음 단계 질문이 줄어든다.

### 2. scaffold-feature 호출

```text
주문 일괄 취소 기능을 컨벤션 따라 만들어줘.
엔드포인트는 POST /api/orders/cancel-batch, TBL_ORDER.STATUS 업데이트, OrderRefund 비슷한 패턴
```

`scaffold-feature`가 Phase 0에서 사전 조건을 확인한다.

1. 생성 예정 확장자마다 `check-adapter-coverage.mjs` 실행 — `FULL`만 자동 생성 가능, `PARTIAL`은 HOLD, `UNSUPPORTED`는 추측 스캐폴딩 금지.
2. `_workspace/pair_config.md` 확인 — 있으면 "프론트엔드도 함께 생성할까요?"를 추가로 묻고 Y면 `cross-repo-scaffold`로 위임한다.
3. 패턴 로드와 `pattern_profile.py validate` — 실패하면 pattern-extractor 재실행 후 재검증, 재실패 시 중단.
4. `_workspace/01_analyzer_report.md`에서 레이어 목록·빌드 명령·모듈 분류 방식 로드.

Phase 1에서 기능명·영향 레이어·기존 유사 모듈·엔드포인트·DB 영향을 1~2회 확인한다. 요청문에 이미 적었으면 해당 질문은 생략된다. 이어서 `pattern_profile.py select`로 생성 예정 경로·모듈에 맞는 preferred 프로필을 고르고 결과를 `_workspace/reports/pattern_selection.json`에 남긴다. `legacy`와 `anti_pattern` 프로필은 신규 코드 기준으로 선택하지 않는다.

Phase 2에서 `analyze-impact`로 같은 엔드포인트·같은 SQL ID·같은 클래스명 충돌을 사전 점검한다. 충돌이 있으면 덮어쓰지 않고 명명 조정을 권고한다.

### 3. 파일 생성 확인

Phase 3에서 선택된 기준 파일을 실제로 읽고 레이어별로 생성한다. Spring Boot 기준 예시는 다음과 같다.

```text
생성 파일 목록:
  src/main/java/.../controller/OrderBatchCancelController.java
  src/main/java/.../service/OrderBatchCancelService.java
  src/main/java/.../mapper/OrderBatchCancelMapper.java
  src/main/resources/mapper/OrderBatchCancelMapper.xml   (ORDER_BATCH_CANCEL_U01)
  src/main/java/.../dto/OrderBatchCancelRequest.java
  src/test/java/.../service/OrderBatchCancelServiceTest.java
```

SQL ID는 분석 리포트의 명명 규칙(`MODULE_FEATURE_U01` 형태)을 따른다. 테스트는 `test-generator`가 `.claude/patterns/test_pattern.md`와 기존 테스트 기준 파일을 따라 골격만 만들고 비즈니스 검증은 TODO로 남긴다. Struts·Spring XML·라우터 등록이 필요한 스택이면 설정 파일에 항목을 추가한다.

비즈니스 로직 자리는 비어 있고 TODO로 표기된다. 무조건 success를 반환하는 가짜 구현으로 채우지 않는다.

### 4. 패턴 적합성·검증·안전성

Phase 4는 세 관문이다.

| 관문 | 내용 | 산출물 |
|---|---|---|
| 4-1 | `pattern-conformance`가 생성 코드와 `pattern_selection.json`의 기준 파일을 교차 검증 | `_workspace/reports/pattern_conformance_<slug>.md` — CONFORM/HOLD/FAIL |
| 4-2 | `verify-target.mjs detect`로 검증 명령 확보, 필요한 항목을 `run`으로 실행 | 명령·exit·`fail_lines` |
| 4-3 | `change-safety`가 생성 파일·패턴 판정·검증 결과로 GO/HOLD/STOP | `_workspace/reports/safety_<slug>.md` |

이 단계에서 흔히 HOLD가 나온다. 테스트 골격만 있고 assertion이 비어 있으면 통과 증거가 아니므로 HOLD로 표시된다. 이것은 정상이며 다음 단계에서 채운 뒤 재평가하면 된다. FAIL이면 생성 코드를 수정하고 재검증하며, FAIL 상태에서는 GO를 보고하지 않는다.

Phase 5 보고에는 생성 파일, 패턴 적합성(기준 프로필·파일 표시), 검증 증거, 인덱스·위키 갱신 결과, TODO 목록, 영향도 사전 체크 결과, 다음 단계가 나온다.

### 5. TODO 채우기와 SQL 점검

보고의 TODO 목록을 따라 Service의 비즈니스 로직과 테스트 assertion을 채운다. 그 뒤 새로 추가된 SQL을 점검한다.

```text
이 SQL 점검해줘 — ORDER_BATCH_CANCEL_U01
```

`review-sql`이 `sql_usage.json`에서 SQL ID 텍스트를 찾아 `sql-reviewer`를 호출한다. 시나리오 예시처럼 "WHERE 인덱스 미사용 가능 → 권고 인덱스"가 나오면 조건부 권고다. 실 DB의 실행 계획을 봐야 결론이 나므로 EXPLAIN 확인 방법이 함께 적혀 있다. 인덱스 추가는 DBA와 협의한다. 결과는 `_workspace/reports/sql_review_ORDER_BATCH_CANCEL_U01.md`에 있다.

### 6. 재평가와 커밋

로직과 assertion을 채운 뒤 안전성을 다시 본다.

```text
이 변경 안전한가?
```

`safe-modify`가 변경 파일을 대상으로 패턴 적합성·검증 실행·안전성 평가를 다시 돌린다. GO가 나오면 인덱스와 wiki가 갱신되고 커밋은 사용자가 한다. 빌드 명령은 Phase 5 보고의 "빌드/실행" 항목에 있다.

## 결과 확인

- `_workspace/00_spec_report.md` — 확정된 목표·범위·제약.
- `_workspace/reports/pattern_selection.json` — 레이어별 preferred 프로필과 `reference_files`.
- 생성된 Controller·Service·Mapper·XML·DTO·Test 파일.
- `_workspace/reports/pattern_conformance_<slug>.md` — CONFORM과 레이어별 근거.
- `_workspace/reports/tests_<slug>.md` — 케이스 분포와 TODO.
- `_workspace/reports/sql_review_ORDER_BATCH_CANCEL_U01.md` — 확정 발견과 조건부 권고.
- `_workspace/reports/safety_<slug>.md` — 최종 GO.

## 막혔을 때

- **"패턴 추출 먼저 필요"라고 멈췄다** — 준비 절의 "패턴 추출해줘"를 실행한다. 재검증에도 실패하면 `_workspace/pattern_profile_validation.json`의 `profile_missing` 항목을 확인한다.
- **어댑터 커버리지가 PARTIAL이다** — XFDL 혼합 XML/Script, Designer 파일처럼 실제 유사 화면과 실행 검증 절차를 사용자가 확인해야 하는 스택이다. 확인 전까지 HOLD다. UNSUPPORTED면 어댑터와 회귀 픽스처를 먼저 추가해야 한다.
- **패턴 후보가 충돌한다거나 LOW 신뢰도라 생성이 중단됐다** — 서로 다른 모듈의 패턴을 평균내지 않는 설계다. 어떤 기준 파일을 따를지 직접 고르면 진행된다.
- **같은 엔드포인트가 이미 있다고 한다** — Phase 2 사전 충돌 체크 결과다. 경로를 바꾸거나 기존 기능을 수정하는 쪽(`safe-modify`)으로 전환한다.
- **`scaffolder`와 무엇이 다른가** — 로컬 `scaffolder` 스킬은 체크리스트만 보여 주고, `scaffold-feature`는 실제 파일 생성과 컨벤션 준수, 테스트 골격, 사전 영향 체크까지 한다.
- **게이트 없이 바로 만들고 싶다** — "알아서 해줘"로 `vibe`를 쓸 수 있지만 신규 파일에 검증된 preferred 프로필이 없으면 `vibe`가 스스로 `scaffold-feature`로 승격한다.
- **`pair_config.md`가 있어 프론트엔드 질문이 나온다** — 백엔드만 만들려면 N으로 답한다. Y면 [백엔드·프론트엔드 분리 저장소](/tutorials/cross-repo-feature.md) 흐름이 된다.

## 관련 문서

- [spec-gate](/skills/spec-gate.md) — 모호성 점수와 REFINE 처리.
- [scaffold-feature](/skills/scaffold-feature.md) — Phase 0~5와 원칙.
- [pattern-conformance](/agents/pattern-conformance.md) · [test-generator](/agents/test-generator.md) — 검증 기준과 테스트 생성 정책.
- [패턴 프로필](/concepts/pattern-profiles.md) — preferred/legacy/anti_pattern과 기준 파일.
- [review-sql](/skills/review-sql.md) — SQL ID 입력과 조건부 권고 읽기.
