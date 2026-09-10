# 마이그레이션 프로젝트 시작

Struts 1.x로 된 시스템을 Spring Boot 3으로 전환하기로 결정됐다. 첫 주에 해야 할 일은 코드를 바꾸는 것이 아니라 인벤토리·매핑·단계·위험·테스트·롤백을 문서로 확정하는 것이다. 이 튜토리얼은 `plan-migration`이 만드는 산출물을 읽고 결정 포인트에 답한 뒤, 실제 변환 단계에서 `scaffold-feature`·`test-generator`·`safe-modify`로 어떻게 이어지는지를 다룬다.

- **소요 시간** — Full 하네스 초기화 10분 내외, 컨텍스트 대화와 계획 생성 20~30분, 문서 검토 반나절.
- **전제** — 하네스가 Full Tier로 초기화돼 있다. `dead_code.json`을 포함한 인덱스가 필요하므로 Standard로 만들었다면 재초기화한다.
- **이 튜토리얼이 다루는 스킬·에이전트** — `harness-init`(Full), `spec-gate`, `plan-migration`, `migration-planner`, 이후 `scaffold-feature`·`test-generator`·`safe-modify`.

## 준비

Full Tier 하네스를 만든다. "마이그레이션"·"레거시"·"심층" 키워드는 Full을 강제하므로 Tier 질문이 생략된다.

```text
심층 분석해서 하네스 만들어줘
```

완료 보고의 `[Indexes]` 목록에 `_workspace/index/dead_code.json`·`external_io.json`·`transactions.json`·`env_branches.json`·`schema.json`이 있는지 확인한다. `plan-migration`은 이 인덱스들을 Phase 분리 기준·위험 항목·제외 후보로 쓴다.

범위가 흔들리면 계획 전에 정리한다.

```text
작업 범위 정해줘
```

`spec-gate`가 `_workspace/00_spec_report.md`에 목표·범위·제약을 남긴다. 마이그레이션 계획 수립 전은 이 스킬의 대표 사용 시점이다.

## 단계별 진행

### 1. 계획 요청과 컨텍스트 대화

```text
Struts에서 Spring Boot 3으로 마이그레이션 계획 짜줘
```

`plan-migration`이 Phase 0에서 대화형으로 컨텍스트를 모은다. 소스 스택은 analyzer 결과에서 자동 추출되고 나머지를 묻는다.

| 질문 | 예시 답 |
|---|---|
| 타겟 스택 | "Spring Boot 3 + PostgreSQL" |
| 범위 | "전체 모듈" / "Order 모듈만" / "DB만" |
| 주요 동기 | "기술 부채" / "라이선스 비용" / "성능" |
| 일정 제약 | "1년 내" / "고객사 요구 6개월" |
| 운영 중인가 | yes → 단계적 전환 권장 |
| 외부 시스템 연계 변경 가능? | "변경 불가 (API 동결)" / "협의 가능" |
| 백업·롤백 인프라 | "DB 백업 가능, 코드 git" / "VM 스냅샷" |

답은 `_workspace/migration/00_context.md`에 저장된다. Phase 1에서 인덱스 가용성을 점검하고 누락이 있으면 인덱스 갱신을 권고한다.

### 2. 산출물 6종과 체크포인트

Phase 2에서 `migration-planner` 에이전트가 문서를 생성한다. 코드 변환은 하지 않는다.

| 파일 | 내용 | 먼저 볼 것 |
|---|---|---|
| `_workspace/migration/00_inventory.md` | 소스 파일 수, DB 객체, 외부 의존성과 타겟 호환 여부, 외부 연계, 환경 분기, 데드 코드 후보 | "마이그레이션 제외 (데드 코드 후보)" 절 |
| `_workspace/migration/01_mapping_table.md` | 클래스·메서드·설정 수준의 AS-IS → TO-BE 변환 규칙과 예외 케이스 | Action → `@Controller`, ActionForm → DTO, struts-config → `@RequestMapping` 행 |
| `_workspace/migration/02_phased_plan.md` | Phase 0 준비 → 1 LOW → 2 MEDIUM → 3 HIGH → 4 정리. Strangler Fig 기본 | Phase 1 대상 모듈 목록(impact 점수 ≤ 3) |
| `_workspace/migration/03_risk_register.md` | R001~ 위험·영향도·확률·완화책·담당 | R006 외부 시스템 연계, R007 데이터 손실 |
| `_workspace/migration/04_test_strategy.md` | Phase별 회귀 baseline, 동등성 테스트, 부하 테스트, 테스트 데이터 | Phase 2부터 붙는 동등성 테스트 |
| `_workspace/migration/05_rollback_plan.md` | Phase별 롤백 트리거와 절차, DB 롤백 | Phase 3 트래픽 전환 롤백 트리거 |
| `_workspace/migration/checkpoints/phase1.md`~`phase4.md` | Phase 종료 조건 체크리스트, 메트릭, 다음 Phase 진입 조건 | 사인오프 항목 |

앞의 6종에 컨텍스트 파일 `00_context.md`가 더해져 `_workspace/migration/` 아래에 놓인다. 일정은 자체 추정에 50% 버퍼가 적용돼 있다. 외부 통신이 발견되면 위험 등록부에 반드시 반영된다.

### 3. 결정 포인트에 답하기

Phase 3에서 자동으로 결정할 수 없는 항목 5개를 묻는다.

```text
핵심 의사결정 필요:
1. 데드 코드 제외 대상 — 후보 N개 파일 (00_inventory.md) — 진짜 제외 / 검증 후 결정 / 모두 마이그레이션
2. DB 마이그레이션 전략 — In-place / 병행 (운영 중이면 병행 권고)
3. 외부 시스템 조율 — 발견된 연계 N건 (03_risk_register.md R006) — 사전 통지·동결 기간
4. canary 비율 — 권고 1% → 10% → 50% → 100%
5. Phase 0(준비) 시작일
```

각 항목에 답하면 문서에 반영되고 변경 이력이 기록된다. 데드 코드 제외는 `dead_code.json`의 정적 판정이므로 반드시 사람이 사인오프한다. 자동 추측은 하지 않는다.

### 4. Phase 0은 외부 작업

Phase 4 안내의 "즉시" 항목은 타겟 환경 셋업, 위험 등록부 사인오프(PM·고객사), 외부 시스템 담당자 통지다. 이 셋은 하네스 밖에서 이루어진다. `02_phased_plan.md`의 Phase 0 절(빌드·배포·테스트 환경, CI/CD 이중화, 모니터링 동등 구성, 회귀 baseline 측정)을 체크리스트로 쓴다.

### 5. Phase 1부터 모듈 단위 변환

Phase 1 대상 모듈마다 네 스킬을 순서대로 조합한다.

```text
OrderAction을 Spring Controller로 변환할 빈 구조 만들어줘
```

`scaffold-feature`가 타겟 스택 컨벤션으로 빈 구조를 만든다. 타겟 스택의 패턴 프로필이 있어야 하므로 Phase 0에서 만든 타겟 프로젝트 골격에 대해 패턴이 추출돼 있어야 한다.

이어서 `01_mapping_table.md`를 보며 사람이 코드를 변환한다. 그 뒤 회귀 테스트와 안전성 평가를 받는다.

```text
회귀 테스트 만들어줘
```

```text
이 변환 안전한가?
```

`test-generator`가 골격을 만들고 `safe-modify`가 패턴 적합성·실제 검증 실행·`change-safety`로 GO/HOLD/STOP을 낸다. GO면 canary 배포하고 모듈을 닫는다. Phase 2부터는 `04_test_strategy.md`의 동등성 테스트(같은 입력 → 소스·타겟 응답 비교)를 추가한다.

### 6. Phase 종료와 체크포인트

Phase가 끝나면 `_workspace/migration/checkpoints/phase[N].md`를 연다. 모든 완료 조건이 체크되고 위험 등록부에 신규 위험이 반영되고 사용자 승인이 있어야 다음 Phase로 간다. 문제가 생기면 `05_rollback_plan.md`의 해당 Phase 절차를 그대로 수행하고 사후 분석으로 위험 등록부와 매핑 테이블을 보완한다.

문서 일부만 갱신할 때는 부분 재실행을 쓴다.

| 요청 | 동작 |
|---|---|
| "매핑 테이블만 다시" | mapping-only 모드 |
| "위험 등록부 업데이트" | risk register만 갱신 |
| "체크포인트 추가" | 새 phase 체크포인트 생성 |
| "롤백 계획 보완" | rollback plan만 갱신 |

## "자동 변환 금지" 원칙

`plan-migration`과 `migration-planner`는 계획만 만든다. 코드 변환은 사람이 매핑 테이블에 따라 수행한다. 검토 없는 자동 변환은 ITO/SI 사고의 주범이라는 전제이며, 자동 변환은 별도 도구·스크립트 영역으로 남겨 두었다. 하네스가 변환 단계에서 하는 일은 빈 구조 생성(`scaffold-feature`), 테스트 골격(`test-generator`), 변환 결과의 안전성 평가(`safe-modify`)까지다. "이 Action 전부 Controller로 바꿔줘"라고 요청하면 계획 산출물이 아니라 일반 수정 요청으로 처리되어 `safe-modify` 게이트를 타게 되므로, 모듈 단위로 나눠 위 순서를 지킨다.

## 결과 확인

- `_workspace/migration/00_context.md` — 대화로 확정한 타겟·범위·동기·일정·운영 여부.
- `_workspace/migration/00_inventory.md`~`05_rollback_plan.md` 6종 — 결정 포인트 답이 반영된 상태.
- `_workspace/migration/checkpoints/phase1.md`~`phase4.md` — Phase별 종료 조건.
- 계획 화면의 "소스 → 타겟, 범위, 예상 기간 N개월"과 "총 위험 항목 M개(CRITICAL/HIGH/MEDIUM/LOW)".
- 위험 등록부 사인오프와 외부 시스템 담당자 통지 기록(하네스 밖).

## 막혔을 때

- **인덱스 누락으로 계획이 멈췄다** — `plan-migration` Phase 1이 `call_graph`·`external_io`·`transactions`·`dead_code`·`env_branches`·`schema`를 요구한다. "인덱스 갱신해줘"로 갱신하거나, `dead_code.json`이 없으면 Full Tier로 "하네스 다시 초기화해줘"를 실행한다.
- **마이그레이션 중에 일반 버그 수정을 해도 되나** — 가능하다. 계획은 코드를 건드리지 않으므로 일반 작업과 병행할 수 있다. 변환 중인 모듈과 충돌만 주의한다.
- **레거시 Action이 무엇을 하는지 모른다** — "이 Struts Action 클래스 뭐하는 거야?"로 `legacy-decoder`를 호출해 `_workspace/reports/decoded_<slug>.md`를 받고, 의문점을 업무 담당자에게 확인한 뒤 변환한다. [레거시 코드 해석](/tutorials/legacy-decode.md) 참고.
- **DB 마이그레이션도 함께 한다** — 인벤토리의 DB 객체 절과 `05_rollback_plan.md`의 "DB 마이그레이션 롤백"(Down 스크립트, 사전 백업, 역변환 스크립트)을 따른다. 개별 DDL은 `review-sql`로 점검한다.
- **일정이 너무 길게 나왔다** — 50% 버퍼가 의도된 보수성이다. 범위를 줄이려면 `00_context.md`의 범위를 바꿔 다시 계획하거나 Phase 1 대상 모듈을 조정한다.
- **마이그레이션이 끝났다** — 타겟 프로젝트에서 "하네스 다시 초기화해줘"로 새 스택 기준 하네스를 만든다.

## 관련 문서

- [plan-migration](/skills/plan-migration.md) — Phase 0~4와 부분 재실행.
- [migration-planner](/agents/migration-planner.md) — 지원 시나리오와 각 문서 템플릿.
- [scaffold-feature](/skills/scaffold-feature.md) · [safe-modify](/skills/safe-modify.md) — 변환 단계에서 쓰는 두 스킬.
- [Tier와 비용](/getting-started/tier-and-cost.md) — Full Tier가 필요한 이유.
- [스택 매트릭스](/reference/stack-matrix.md) — 지원 소스·타겟 스택.
