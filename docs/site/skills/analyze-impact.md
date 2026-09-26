# analyze-impact

변경 대상(파일/함수/클래스/SQL/엔드포인트/DB 컬럼)의 직간접 영향과 위험도를 분석하는 읽기 전용 오케스트레이터다. 수정·개발·마이그레이션 작업의 시작점으로, "이거 바꾸면 어디 영향가?"라는 질문에 인덱스 기반 근거와 0~10 위험도 점수로 답하며 [safe-modify](/skills/safe-modify.md)·[scaffold-feature](/skills/scaffold-feature.md)·[plan-migration](/skills/plan-migration.md)도 내부적으로 이 스킬을 호출한다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "영향도 분석", "이거 수정하면 어디 영향?", "이 함수 수정해도 돼?", "이 SQL 바꾸면 어디 영향?", "이 컬럼 추가했을 때 영향", "이 API 변경 영향", "분석해줘 영향", "이거 건드려도 돼?", "어디서 쓰이고 있어?", "이 메서드 호출처" |
| 영어 | "impact analysis" |
| 축약 호출 | "영향도 [대상]", "임팩트 [대상]" |
| 슬래시 호출 | `/ax-navi:analyze-impact`, 별칭 `/impact [대상]` |
| 자동 우선 실행 | 질문에 "영향", "영향도", "impact", "어디 영향", "어디서 쓰여" 키워드가 있거나, 변경 의사("이거 바꿔도 돼", "수정 가능?")를 표현하며 대상이 식별 가능하면 자동 우선 실행된다. |

`/impact`는 `ax-navi:analyze-impact`로 위임하는 별칭이며, 뒤에 쓴 내용 전부가 그대로 전달된다. 인덱스가 없으면 analyzer를 feature-scoped 모드로 먼저 호출한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 0 | 입력 정규화. 자연어에서 변경 대상을 추출한다. 모호하면 1회만 확인 질문("어떤 함수/클래스/엔드포인트를 의미하시나요?")을 한다. | 없음 | 모호할 때만 대상을 답한다. |
| Phase 1 | 인덱스 준비. `--check-stale`로 신선도를 확인하고 `stale:true`면 재인덱싱한다. `reason`이 `인덱스 없음`이면 `--mode init`, 그 외는 `--mode incremental`이다. | `build-index.mjs --check-stale`, `query-index.mjs` | 없음 |
| Phase 2 | impact-analyzer 호출. 호출 후 `_workspace/reports/impact_<slug>.md`가 실제로 생성됐는지 확인하고, 없으면 1회 재호출한다. | [impact-analyzer](/agents/impact-analyzer.md) | 없음 |
| Phase 3 | 결과 보고. 위험도·직접/간접 영향·영향 테스트·외부 통신·트랜잭션·DB·인증·환경 분기 영향과 다음 단계 권고를 표시한다. | 리포트 읽기 | 다음 액션(safe-modify 또는 중단)을 결정한다. |

### Phase 0 정규화 예

| 사용자 표현 | 추출 결과 |
|-------------|-----------|
| "OrderService.cancel 수정하면" | 메서드 `OrderService.cancel` |
| "user_service.py 영향" | 파일 `user_service.py` |
| "ORDER_LMS_U02 쿼리 바꾸면" | SQL ID `ORDER_LMS_U02` |
| "TBL_ORDER에 STATUS 컬럼 추가" | DB 스키마 변경 |
| "/api/orders/{id} 응답 변경" | API 엔드포인트 |

### Phase 1 인덱스 활용

| 인덱스 | 필요한 분석 | 질의 예시 |
|--------|-------------|-----------|
| `call_graph.json` | 메서드/함수 영향 분석 | `callers --id <메서드>`, `trace --id <메서드> --depth 3` |
| `sql_usage.json` | SQL ID 영향 | `sql --id <SQL ID>` 또는 `sql --table <테이블>` |
| `schema.json` | DB 컬럼 영향 | `schema --table <테이블>` |
| `external_io.json` | 외부 시스템 영향 평가 | 아직 `query-index.mjs` 명령이 없어 필요 시 직접 열람 |
| `transactions.json` | 트랜잭션 경계 영향 | `transaction --id <메서드>` |

원본 JSON을 Read로 직접 열지 않는다. 대형 인덱스는 수십 MB에 이르므로 `query-index.mjs` 질의로 필요한 줄만 가져온다.

### 위험도 등급과 권고

| 점수 | 등급 | 권고 |
|------|------|------|
| 1~3 | LOW | 즉시 진행 가능. 영향 테스트만 실행 권고. |
| 4~6 | MEDIUM | 영향 파일 단위 테스트 권고. |
| 7~8 | HIGH | 회귀 테스트 + 사전 리뷰 필수. |
| 9~10 | CRITICAL | 외부 조율 + 단계별 배포 + 롤백 계획. |

impact-analyzer의 점수 산출식은 기본 1점에 직접 호출자 수 × 0.2(최대 +3), 간접 영향 노드 수 × 0.05(최대 +2), 외부 통신 +2, 트랜잭션 경계 +1, DB 스키마 +2, 인증/인가 경로 +2, 환경 분기 +1, 파트너 프로젝트 영향 +1을 더하고 테스트 커버리지 비율 × 2를 감산해 10으로 상한을 둔다.

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `_workspace/index/call_graph.json`, `symbols.json`, `sql_usage.json`, `schema.json`, `external_io.json`, `transactions.json`, `env_branches.json` | `query-index.mjs` 질의로 영향 관계 추적 |
| 읽는 파일 | `_workspace/pair_config.md` | 파트너 프로젝트 연동 시 API 계약 영향 판단(1:1과 1:N 모두) |
| 읽는 파일 | `jacoco.xml`, `coverage.xml`, `lcov.info` 등 | 있으면 실제 커버하는 테스트 식별 |
| 쓰는 파일 | `_workspace/reports/impact_<slug>.md` | 영향도 리포트(직접/간접 영향, 영향 테스트, 트랜잭션·외부 통신·DB·인증·환경 분기, 위험도 산출 내역, 사전 체크리스트) |
| 쓰는 파일 | `_workspace/index/*.json` | `stale:true`였을 때만 재인덱싱으로 갱신 |

slug는 변경 대상의 안전한 파일명 형태다(예: `OrderService_cancel`, `TBL_ORDER_STATUS`). 코드는 수정하지 않는다.

## 예시

```text
사용자: OrderService.cancel 수정하면 어디 영향가?

하네스: 영향도 분석 완료: OrderService.cancel

        위험도: 6 / 10 (MEDIUM)

        직접 영향:
        - 호출자 3개 (OrderController, BatchOrderService, OrderEventListener)

        간접 영향:
        - BFS 3홉 내 영향 심볼: 5개
        - 허브 메서드: InventoryService.restore, PaymentGateway.refund, NotificationService.send

        영향받는 테스트: 2개
        외부 통신 영향: 있음 — PG사 결제 취소 API
        트랜잭션 경계: OrderService.cancel 단일 경계
        DB 스키마 영향: 없음
        인증/인가 영향: 없음
        환경 분기 영향: 없음

        권고:
        [MEDIUM] 영향 파일 단위 테스트 권고: OrderServiceTest, BatchOrderServiceTest

        동적 호출 확인 (인덱스 밖, 이름으로 Grep 한 결과):
        - 리플렉션/동적 호출: 없음
        - 외부 cron/메시지 큐 호출: 없음

        다음 단계 권고:
        - 진행하시려면: "safe-modify" 호출 또는 변경 적용 후 "안전성 평가"
        - 회귀 테스트 추가: "영향받는 코드 테스트 만들어줘"

        전체 리포트: _workspace/reports/impact_OrderService_cancel.md
```

축약 호출과 인덱스 stale 상황이다.

```text
사용자: 영향도 TBL_ORDER.STATUS 컬럼 추가

하네스: 인덱스 신선도 확인 → stale:true (reason: 소스 변경) → --mode incremental 재인덱싱 완료.
        영향도 분석 완료: TBL_ORDER.STATUS
        위험도: 5 / 10 (MEDIUM)
        DB 스키마 영향: 있음 — 사용 SQL ID 24개, ORM 매핑 Order 엔티티
        ...
        전체 리포트: _workspace/reports/impact_TBL_ORDER_STATUS.md
```

## 원칙과 주의

- **읽기 전용이다.** 변경 의사가 있지만 진행은 아직인 단계이며 코드를 수정하지 않는다. 실제 변경까지 진행하려면 [safe-modify](/skills/safe-modify.md)를 쓴다.
- **모델 고정.** 영향 분석, 인덱스 부재 시 feature-scoped analyzer, general-purpose 폴백과 재시도 모두 `claude-sonnet-5`를 사용한다. Opus로 자동 승격하지 않는다. 모델 선택을 확인할 수 없으면 실제 Sonnet 5 실행을 검증했다고 보고하지 않으며, 모델 변경을 이유로 분석 범위를 줄이지 않는다.
- **한계 정직 안내.** 리포트 끝에 항상 "정적 분석 한계로 리플렉션/동적 바인딩/외부 트리거는 누락될 수 있습니다. 위험도 결과에 +1~2를 고려하세요."를 명시한다.
- **재인덱싱이 불가능하면** `지식 모델 stale` 경고를 리포트에 명시하고 진행한다. 변경 대상 범위가 좁으면 feature-scoped 모드로 대상 주변만 빠르게 재인덱싱해도 된다.
- **no-op 방지.** 에이전트가 실제 작업 없이 대기 응답만 내고 끝나는 경우가 있어, 리포트 파일 생성을 확인하고 없으면 "이번 턴 안에서 직접 산출물을 생성하라"를 명시해 1회 재호출한다. 재시도도 실패하면 사용자에게 알린다.
- **잘린 호출자 목록을 완전한 값으로 보지 않는다.** `query-index.mjs` 응답의 `truncated > 0`이면 `--limit`을 올려 다시 조회한 뒤 실제 `total`을 근거로 쓴다.
- **간접 영향 확장 제한.** BFS 3홉에서 노드 수가 폭증하면(예: 100개 초과) 다음 홉으로 가지 않고 허브 메서드만 표시한다.
- `$env:CLAUDE_PLUGIN_ROOT`가 비어 있으면 스킬 로드 시 표시된 "Base directory for this skill"에서 `/skills/analyze-impact`를 뗀 경로를 대신 쓴다.

## 관련 문서

- [impact-analyzer 에이전트](/agents/impact-analyzer.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [safe-modify](/skills/safe-modify.md)
- [별칭](/skills/aliases.md)
- [튜토리얼: 작은 버그 수정](/tutorials/small-bugfix.md)
- [튜토리얼: DB 컬럼 변경](/tutorials/db-column-change.md)
