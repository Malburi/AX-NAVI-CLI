# scaffold-feature

추출된 프로젝트 컨벤션에 따라 신규 기능을 Controller/Service/DAO/DTO/테스트까지 전체 레이어로 스캐폴딩하는 오케스트레이터다. 로컬 `scaffolder` 스킬이 체크리스트만 제공하는 것과 달리 실제 파일 생성까지 수행하며, "개발해줘"·"구현해줘" 같은 범용 개발 요청도 기본적으로 이 스킬을 탄다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "[기능명] 기능 추가", "주문 취소 기능 만들어줘", "신규 모듈 생성 컨벤션", "패턴대로 만들어줘", "프로젝트 스타일로 새 기능", "보일러플레이트 생성", "새 API 만들어줘 컨벤션 따라" |
| 영어 | "scaffold feature" |
| 범용 문구 (기본 경로) | "개발해줘", "구현해줘", "코드 짜줘", "새 기능 만들어줘" |
| 축약 호출 | "스캐폴드 [기능명]" |
| 슬래시 호출 | `/ax-navi:scaffold-feature`, 별칭 `/scaffold [기능명]` |
| 자동 트리거 | 없다. 범용 개발 요청이 기본 경로로 라우팅될 뿐이다. |

게이트 없이 바로 하려면 [vibe](/skills/vibe.md) 스킬("알아서 해줘")을 명시적으로 부른다. 기존 코드 변경이면 [safe-modify](/skills/safe-modify.md), 새 파일·기능 생성이면 이 스킬이다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 0 | 사전 조건 확인. 어댑터 커버리지 게이트, `pair_config.md` 확인, 패턴 로드와 `pattern_profile.json` 기계 검증, 분석 리포트 로드. | `check-adapter-coverage.mjs`, `pattern_profile.py validate` | 패턴이 스켈레톤이면 "패턴 추출 먼저 필요"를 안내받는다. |
| Phase 1 | 기능 명세 수집(1~2회 질문)과 유사 기능·기준 패턴 선정. `pattern_profile.py select`로 레이어별 `preferred` 프로필과 `reference_files`를 고른다. | [feature-finder](/agents/feature-finder.md), `pattern_profile.py select` | 기능명, 영향 레이어, 기존 유사 모듈, API 엔드포인트, DB 테이블 영향을 답한다. |
| Phase 2 | 사전 영향 체크(선택). 같은 엔드포인트·SQL ID·클래스/메서드명 충돌을 점검한다. | [analyze-impact](/skills/analyze-impact.md) | 충돌 발견 시 명명 조정을 결정한다. |
| Phase 3 | 파일 생성. 분석된 `workspace.kind`와 선택 프로필에 따라 해당 구조만 생성한다. 테스트 레이어는 test-generator가 골격만 만든다. | Edit/Write, [test-generator](/agents/test-generator.md) | 없음 |
| Phase 4-1 | 패턴 적합성 독립 검증. CONFORM이면 다음 단계, HOLD면 사용자 확인 후 수정·재검증, FAIL이면 수정 후 재검증이며 FAIL 상태에서는 GO 보고 금지. | [pattern-conformance](/agents/pattern-conformance.md) | HOLD 시 충돌·의도적 차이를 확인한다. |
| Phase 4-2 | 프로젝트 검증 명령 실행. `detect` 후 생성 범위에 필요한 항목을 `run`으로 실제 실행해 `cmd`·`exit`·`fail_lines`를 기록한다. | `verify-target.mjs detect/run` | 없음 |
| Phase 4-3 | 변경 안전성 평가. 생성 파일, 패턴 적합성 리포트, 실제 검증 결과를 함께 전달한다. | [change-safety](/agents/change-safety.md) | 없음 |
| Phase 4-4 | GO일 때 인덱스를 incremental 모드로 갱신하고 generate-wiki를 재실행한다. | `build-index.mjs --mode incremental`, [generate-wiki](/skills/generate-wiki.md) | 없음 |
| Phase 5 | 결과 보고. 생성 파일, 패턴 적합성, 검증 증거, 인덱스·위키 상태, TODO 항목, 다음 단계. | 리포트 읽기 | TODO를 채우고 assertion을 보완한다. |

### Phase 0 어댑터 커버리지 게이트

생성 예정 경로의 확장자마다 판정한다. 기존 파일이 아직 없더라도 같은 확장자의 `_meta.json.adapter_coverage` 항목으로 판정한다.

| 판정 | 동작 |
|------|------|
| `FULL` | 자동 생성 가능. |
| `PARTIAL` (예: XFDL 혼합 XML/Script, 프로젝트 메타데이터) | `READ` — 실제 유사 화면·Designer·설정 파일 원문을 직접 읽어 구조를 확인한 뒤 생성. |
| `UNSUPPORTED` | 추측 스캐폴딩 금지. 먼저 어댑터와 회귀 픽스처를 추가한다. |

### Phase 1 pair 연동 분기

`_workspace/pair_config.md`가 있고 `partner_root`가 유효하면 `pair_linked = true`가 되어 "프론트엔드도 함께 생성할까요?" 질문이 추가된다. Y면 즉시 [cross-repo-scaffold](/skills/cross-repo-scaffold.md)로 위임하고 scaffold-feature는 종료한다. N이면 백엔드만 진행한다.

### Phase 3 스택별 생성 구조

| 스택 | 생성 구조 |
|------|-----------|
| 서버/API | Controller·Action·Router / Service / Repository·Mapper / DTO / Test |
| WinForms·DevExpress | Form·UserControl / Designer partial / UI event / application service / Test |
| Nexacro | XFDL Form / XJS 공통 모듈 / Dataset / transaction·callback / 서버 Action·Controller / Test 또는 수동 시나리오 |
| Vue·React | Component / composable·hook / store / API client / route / Test |

설정·라우팅 등록도 스택별로 수행한다. Struts는 `struts-*.xml`에 `<action>`, Spring XML은 `applicationContext-*.xml`에 Bean, 프론트엔드는 route 등록이다. SQL ID는 분석 리포트의 명명 규칙(`MODULE_FEATURE_S01` 등)을 따른다.

### Phase 4 결정 기준

GO는 패턴 CONFORM + 필수 검증 명령 exit 0 + change-safety GO가 모두 충족된 경우만이다. 테스트 골격만 생성되고 assertion이 비어 있으면 통과 증거가 아니므로 HOLD로 표시한다. 감지 `count: 0`이면 `검증 수단 없음`으로 밝히고, 원문과 대조해 생성 결과를 확인했으면 GO로 보고한다. STOP은 거의 발생하지 않으며 보안 위험이 자동 도입된 경우만이다.

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `.claude/patterns/*.md` | 레이어별 컨벤션 본문(`controller_pattern.md`, `service_pattern.md`, `dao_pattern.md`, `dto_pattern.md`, `test_pattern.md` 등) |
| 읽는 파일 | `.claude/patterns/pattern_profile.json` | 모듈·레이어별 preferred/legacy/anti_pattern 프로필과 실제 기준 파일 |
| 읽는 파일 | `_workspace/01_analyzer_report.md` | 아키텍처 레이어 목록, 빌드/실행 명령, 모듈 분류 방식 |
| 읽는 파일 | `_workspace/pair_config.md` | 파트너 연동 여부와 `partner_root` |
| 읽는 파일 | `_workspace/index/_meta.json` | 어댑터 커버리지 |
| 읽는 파일 | 선택된 `reference_files` | 생성 전에 실제로 읽는 기준 코드 |
| 쓰는 파일 | 각 레이어의 신규 소스 파일과 설정 파일 항목 | Phase 3 |
| 쓰는 파일 | `_workspace/reports/pattern_selection.json` | Phase 1 `pattern_profile.py select` 결과 |
| 쓰는 파일 | `_workspace/reports/impact_<slug>.md` | Phase 2 충돌 점검(선택) |
| 쓰는 파일 | `_workspace/reports/pattern_conformance_<slug>.md` | Phase 4-1 |
| 쓰는 파일 | `_workspace/reports/safety_<slug>.md` | Phase 4-3 |
| 쓰는 파일 | `_workspace/index/*.json`, `_workspace/wiki/` | Phase 4-4 GO 시 갱신 |

## 예시

```text
사용자: 주문 일괄 취소 기능을 컨벤션 따라 만들어줘.
        엔드포인트는 POST /api/orders/cancel-batch, TBL_ORDER.STATUS 업데이트, OrderRefund 비슷한 패턴

하네스: 어댑터 커버리지: .java FULL, .xml FULL.
        pattern_profile.json 검증 PASS — order 모듈 Controller/Service/Mapper preferred 프로필 선택,
        기준 파일: OrderRefundController.java, OrderRefundService.java, OrderRefundMapper.xml
        DB 영향이 있어 review-sql 사전 호출을 권고합니다.
        영향도 사전 체크: 충돌 없음 (동일 엔드포인트·SQL ID 없음)

        신규 기능 스캐폴딩 완료: 주문 일괄 취소

        생성된 파일:
        - [Controller] src/main/java/.../controller/OrderBatchCancelController.java
        - [Service]    src/main/java/.../service/OrderBatchCancelService.java
        - [DAO/Mapper] src/main/resources/mapper/OrderBatchCancelMapper.xml (ORDER_BATCH_CANCEL_U01)
        - [DTO]        src/main/java/.../dto/OrderBatchCancelRequest.java
        - [Test]       src/test/java/.../service/OrderBatchCancelServiceTest.java

        패턴 적합성: CONFORM (기준 프로필 order/service, 기준 파일 OrderRefundService.java)
        검증 증거: ./gradlew compileJava → exit 0 · ./gradlew test --tests OrderBatchCancelServiceTest → exit 0
        인덱스·위키: 갱신 완료

        ⚠️ TODO 항목 (수동 완성 필요):
        - OrderBatchCancelService.cancelBatch(): 취소 가능 상태 검증과 재고 복원 로직
        - OrderBatchCancelServiceTest: assertion 3건

        다음 단계:
        - 비즈니스 로직 구현 (TODO 채우기)
        - "이 SQL 점검해줘 — ORDER_BATCH_CANCEL_U01"
        - 통과 후 commit
```

패턴이 없어 거부되는 경우다.

```text
사용자: 스캐폴드 쿠폰 발급
하네스: .claude/patterns/가 스켈레톤 상태입니다 — 패턴 추출 먼저 필요합니다.
        pattern-extractor를 실행할까요? ("패턴 추출해줘")
```

## 원칙과 주의

- **근거 있는 컨벤션 준수.** 선택된 모듈·레이어의 `preferred` 프로필과 실제 기준 파일을 따르며, 서로 다른 모듈의 다수 패턴을 평균내지 않는다. 패턴이 모호하거나 충돌하면 생성을 중단하고 사용자에게 결정을 요청한다.
- **같은 세대 코드만 기준으로 삼는다.** 사용자가 유사 모듈을 지정하지 않으면 같은 모듈·같은 레이어·같은 작업 유형의 후보를 찾고, 이름만 비슷한 다른 세대 코드는 고르지 않는다. `legacy`와 `anti_pattern`은 신규 코드 기준으로 선택 금지다.
- **생성 전에 기준 파일을 실제로 읽는다.** Markdown 패턴만 읽고 일반적인 프레임워크 예제를 작성하지 않는다. 코드 골격은 일반 Spring 예제가 아니라 선택된 실제 기준 파일의 구조를 따른다.
- **TODO 정직 표기.** 자동 생성된 비즈니스 로직은 비어 있으며 TODO로 명시한다. 무조건 success를 반환하는 식의 가짜 구현으로 채우지 않는다.
- **충돌 자동 회피.** 기존 파일/메서드/SQL ID와 충돌하면 덮어쓰지 않고 사용자에게 조정을 요청한다.
- **패턴 부재 시 거부.** `.claude/patterns/`가 비어 있거나 스켈레톤이면 pattern-extractor를 먼저 실행하도록 권고한다. 컨벤션 없이 스캐폴딩하면 추측에 기반한 잘못된 표준을 도입할 위험이 있다. 프로필 검증이 재실패하면 추측 생성 금지 후 중단한다.
- **웹 Controller/Service/DAO 구조를 모든 시스템에 강제하지 않는다.** `workspace.kind`에 따라 WinForms·Nexacro·Vue/React 구조를 각각 쓴다.
- **인덱스·위키 갱신 실패는 코드 생성 성공과 구분해 WARN으로 보고한다.** 실패 사유와 stale 상태를 남긴다.

## 관련 문서

- [패턴 프로필](/concepts/pattern-profiles.md)
- [pattern-extractor 에이전트](/agents/pattern-extractor.md)
- [pattern-conformance 에이전트](/agents/pattern-conformance.md)
- [test-generator 에이전트](/agents/test-generator.md)
- [cross-repo-scaffold](/skills/cross-repo-scaffold.md)
- [튜토리얼: 신규 기능](/tutorials/new-feature.md)
