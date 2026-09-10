# plan-migration

스택 마이그레이션 계획을 수립하는 대화형 오케스트레이터다. 인벤토리, 매핑 테이블, 단계별 계획, 위험 등록부, 테스트 전략, 롤백 계획, 체크포인트 7종 문서를 생성하며, Struts → Spring Boot나 Oracle → PostgreSQL처럼 스택 자체를 바꾸는 큰 단위 작업의 시작점에서 쓴다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "마이그레이션 계획", "Spring Boot로 마이그레이션", "Struts → Spring", "iBatis → MyBatis", "Oracle → PostgreSQL", ".NET Core로 옮겨야 해", "Java 17 업그레이드", "JSP를 React로", "AngularJS → Angular", "마이그레이션 로드맵", "전환 계획", "리프트앤시프트" |
| 영어 | "migration plan" |
| 축약 호출 | "마이그 [현재 → 목표]" |
| 슬래시 호출 | `/ax-navi:plan-migration` |
| 자동 트리거 | 없다. |

별칭은 없다. harness-init에서 "마이그레이션"·"레거시" 키워드가 있으면 Full Tier가 강제되므로, 마이그레이션을 앞두고 있다면 [harness-init](/skills/harness-init.md)을 Full로 먼저 돌려 인덱스를 확보한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 0 | 마이그레이션 컨텍스트 수집. 소스 스택은 analyzer 결과에서 자동 추출하고 나머지는 대화형으로 확인해 `_workspace/migration/00_context.md`에 저장한다. | 없음 | 타겟 스택, 범위, 주요 동기, 일정 제약, 운영 중 여부, 외부 시스템 연계 변경 가능성, 백업·롤백 인프라를 답한다. |
| Phase 1 | 인벤토리 사전 점검. 분석 리포트와 인덱스를 로드하고 누락이 있으면 analyzer 전체 재실행을 권고한다. | 인덱스 로드 | 인덱스 누락 시 "하네스 초기화 — 인덱스 갱신"을 실행한다. |
| Phase 2 | migration-planner 호출. 7개 문서를 생성한다. | [migration-planner](/agents/migration-planner.md) | 없음 |
| Phase 3 | 결과 검토 + 결정 포인트. 생성 문서 목록과 핵심 의사결정 5개를 제시한다. | 리포트 읽기 | 데드 코드 제외 대상, DB 마이그레이션 전략, 외부 시스템 조율, canary 비율, Phase 0 시작일을 결정한다. 답변 후 문서가 업데이트되고 변경 이력이 기록된다. |
| Phase 4 | 다음 액션 안내. 즉시 / Phase 1 시작 시 / 각 Phase 종료 시 / 문제 발생 시 할 일을 안내한다. | 없음 | "Phase 1 시작" 또는 "Phase 0 준비 항목 확인"으로 이어간다. |

### Phase 0 수집 항목

| 질문 | 예시 답 |
|------|---------|
| 소스 스택 | (analyzer 결과에서 자동 추출) "Struts 1.x + Spring 3 + Oracle" |
| 타겟 스택 | "Spring Boot 3 + PostgreSQL" |
| 범위 | "전체 모듈" / "Order 모듈만" / "DB만" |
| 주요 동기 | "기술 부채" / "라이선스 비용" / "성능" / "클라우드 이전" |
| 일정 제약 | "1년 내" / "고객사 요구 6개월" |
| 운영 중인가 | yes/no (운영 중이면 단계적 전환 권장) |
| 외부 시스템 연계 변경 가능? | "변경 불가 (API 동결)" / "협의 가능" |
| 백업·롤백 인프라 | "DB 백업 가능, 코드 git" / "VM 스냅샷" |

### Phase 3 핵심 의사결정

| # | 결정 항목 | 검토 위치 | 권고 |
|---|-----------|-----------|------|
| 1 | 데드 코드 제외 대상 | `00_inventory.md` | 진짜 제외 / 검증 후 결정 / 모두 마이그레이션 중 선택 |
| 2 | DB 마이그레이션 전략 | — | In-place(같은 DB에 점진적 변경) 또는 병행(새 DB로 복제 후 전환). 운영 중이면 병행 권고 |
| 3 | 외부 시스템 조율 | `03_risk_register.md` (R006) | 사전 통지·동결 기간 필요 |
| 4 | canary 비율 (Phase 3) | `02_phased_plan.md` | 1% → 10% → 50% → 100% 권고, 변경 가능 |
| 5 | Phase 0(준비) 시작일 | — | 환경 셋업 시작 일자 |

### 부분 재실행

| 요청 | 동작 |
|------|------|
| "매핑 테이블만 다시" | migration-planner를 mapping-only 모드로 호출 |
| "위험 등록부 업데이트" | risk register만 갱신 |
| "체크포인트 추가" | 새 phase 체크포인트 생성 |
| "롤백 계획 보완" | rollback plan만 갱신 |

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `_workspace/01_analyzer_report.md` | 소스 스택 추출 |
| 읽는 파일 | `_workspace/index/call_graph.json` | 모듈 간 의존성(Phase 분리 기준) |
| 읽는 파일 | `_workspace/index/external_io.json` | 외부 시스템 연계(위험 항목) |
| 읽는 파일 | `_workspace/index/transactions.json` | 트랜잭션 경계(분할 가능성) |
| 읽는 파일 | `_workspace/index/dead_code.json` | 마이그레이션 제외 대상 후보 |
| 읽는 파일 | `_workspace/index/env_branches.json` | 환경별 처리 |
| 읽는 파일 | `_workspace/index/schema.json` | DB 객체(DB 마이그레이션 시) |
| 쓰는 파일 | `_workspace/migration/00_context.md` | Phase 0 컨텍스트 |
| 쓰는 파일 | `_workspace/migration/00_inventory.md` | 전환 대상 전체 목록과 데드 코드 후보 |
| 쓰는 파일 | `_workspace/migration/01_mapping_table.md` | AS-IS / TO-BE 변환 룰(클래스·메서드·설정 수준) |
| 쓰는 파일 | `_workspace/migration/02_phased_plan.md` | Strangler Fig 기반 Phase 0~4 계획 |
| 쓰는 파일 | `_workspace/migration/03_risk_register.md` | 위험 ID·영향도·발생 확률·완화책·담당 |
| 쓰는 파일 | `_workspace/migration/04_test_strategy.md` | 회귀 baseline, Phase별 테스트, 동등성·부하 테스트 |
| 쓰는 파일 | `_workspace/migration/05_rollback_plan.md` | Phase별 롤백 트리거와 절차, DB 롤백 |
| 쓰는 파일 | `_workspace/migration/checkpoints/phase[1-4].md` | Phase 종료 시 완료 조건·메트릭·다음 Phase 진입 조건 |

migration-planner가 지원하는 시나리오는 프레임워크(Struts 1 → Spring MVC, Spring 3 → Spring Boot, EJB → Spring), ORM(iBatis → MyBatis 3, MyBatis → JPA), DB(Oracle → PostgreSQL, Tibero → Oracle), 언어/런타임(Java 6 → 17, .NET FW 4 → .NET 8, Python 2 → 3), 프론트엔드(JSP → React/Vue, AngularJS → Angular), 인프라(On-prem → 클라우드, VM → Kubernetes), 빌드(Ant → Maven, Maven → Gradle)다.

## 예시

```text
사용자: Struts에서 Spring Boot 3으로 마이그레이션 계획 짜줘

하네스: 소스 스택: Struts 1.3 + Spring 3.2 + iBatis + Oracle 11g (analyzer 리포트에서 추출)
        몇 가지 확인이 필요합니다.
        - 타겟 스택은 Spring Boot 3 + 어떤 DB인가요?
        - 범위는 전체 모듈인가요?
        - 운영 중인 시스템인가요?
        - 외부 시스템 연계 변경이 가능한가요?
        - 백업·롤백 인프라는 어떻게 되나요?
사용자: Spring Boot 3 + PostgreSQL, 전체, 운영 중, 외부 API는 동결, DB 백업 가능하고 코드는 git

하네스: 마이그레이션 계획 수립 완료

        소스 → 타겟: Struts 1.3 + iBatis + Oracle → Spring Boot 3 + MyBatis 3 + PostgreSQL
        범위: 전체 모듈
        예상 기간: 11개월 (50% 버퍼 포함)

        생성 문서:
        - _workspace/migration/00_context.md
        - _workspace/migration/00_inventory.md
        - _workspace/migration/01_mapping_table.md
        - _workspace/migration/02_phased_plan.md
        - _workspace/migration/03_risk_register.md
        - _workspace/migration/04_test_strategy.md
        - _workspace/migration/05_rollback_plan.md
        - _workspace/migration/checkpoints/phase[1-4].md

        핵심 의사결정 필요:
        1. 데드 코드 제외 대상 — 후보 37개 파일 (00_inventory.md)
        2. DB 마이그레이션 전략 — 운영 중이므로 병행 권고
        3. 외부 시스템 조율 — 발견된 연계 6건 (03_risk_register.md R006)
        4. canary 비율 — 1% → 10% → 50% → 100% 권고
        5. Phase 0(준비) 시작일
        답변하시면 의사결정을 문서에 반영합니다.
```

부분 재실행이다.

```text
사용자: 매핑 테이블만 다시. ActionForm을 record로 매핑하는 걸로
하네스: migration-planner mapping-only 모드 실행 → _workspace/migration/01_mapping_table.md 갱신.
        변경 이력: ActionForm → @ModelAttribute DTO 행을 Java record 매핑으로 교체.
```

## 원칙과 주의

- **마이그레이션은 코드 작성이 아닌 작전이다.** 이 스킬은 계획 수립만 한다. 실제 코드 변환은 사용자가 매핑 테이블에 따라 수행하고, 각 모듈마다 [safe-modify](/skills/safe-modify.md) + [scaffold-feature](/skills/scaffold-feature.md) + test-generator를 조합해 안전하게 진행한다. 검토 없는 자동 변환은 ITO/SI에서 사고의 주범이다.
- **일정 보수성.** migration-planner가 산출하는 일정에 50% 버퍼를 적용한다. ITO/SI 마이그레이션은 거의 항상 예상보다 오래 걸린다.
- **외부 시스템 우선.** 내부 코드만 보고 계획하면 가장 큰 위험인 외부 시스템 인터페이스를 놓친다. `external_io.json` 결과는 항상 risk register에 반영한다.
- **사용자 결정 강제.** 자동 결정 불가 항목(데드 코드 제외, DB 전략, canary 비율, 외부 조율)은 명시적으로 묻고 자동 추측을 금지한다.
- **빅뱅 금지.** 단계별 계획은 Strangler Fig 패턴(점진적 교체)을 기본으로 하며, Phase 1 LOW → Phase 2 MEDIUM → Phase 3 HIGH 모듈 순으로 위험도가 낮은 것부터 전환한다.
- **계획만 생성하므로 코드는 그대로다.** 마이그레이션 도중에도 일반 버그 수정을 동시에 진행할 수 있으며, 마이그레이션 대상 모듈 충돌만 주의한다.
- migration-planner 에이전트 정의의 model은 `opus`다. 다른 오케스트레이터와 달리 Sonnet 5 고정 문구가 SKILL.md에 없다.

## 관련 문서

- [migration-planner 에이전트](/agents/migration-planner.md)
- [스택 매트릭스](/reference/stack-matrix.md)
- [legacy-decoder 에이전트](/agents/legacy-decoder.md)
- [spec-gate](/skills/spec-gate.md)
- [튜토리얼: 마이그레이션 킥오프](/tutorials/migration-kickoff.md)
