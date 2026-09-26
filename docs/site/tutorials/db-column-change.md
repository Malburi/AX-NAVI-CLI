# DB 컬럼 추가

운영 중인 `TBL_ORDER`에 `STATUS` 컬럼을 추가해 달라는 요청이 왔다. DDL 자체의 위험, 그 컬럼을 쓰게 될 코드의 영향, Entity·DTO 변경의 안전성을 순서대로 확인한다. 이 튜토리얼은 특히 `review-sql` 리포트의 확정 발견·조건부 권고를 구분해 읽는 법에 집중한다.

- **소요 시간** — 리뷰와 영향 분석 15분, Entity 변경과 안전 평가 15~30분. DDL 실행은 DBA 일정에 따른다.
- **전제** — 하네스와 인덱스가 있다. `_workspace/index/schema.json`과 `sql_usage.json`이 있으면 분석이 정확해진다. 운영 DB 접속은 필요하지 않다.
- **이 튜토리얼이 다루는 스킬·에이전트** — `review-sql`(`/sql`), `analyze-impact`, `safe-modify`, `sql-reviewer`, `doc-syncer`.

## 준비

하네스는 운영 DB 접속을 요청하지 않는다. 스키마는 DDL 파일 또는 ORM 매핑에서 역추출되고, DDL이 없으면 SQL에서 유도된다. `_workspace/index/schema.json`이 있는지 확인한다. 없으면 `review-sql`이 "DB 접속하여 스키마 추출 필요"를 안내하므로 read-only 계정과 connection string을 제공할지 팀과 정해 둔다.

DDL 문장을 미리 써 둔다. 예시는 다음과 같다.

```sql
ALTER TABLE TBL_ORDER ADD STATUS VARCHAR2(20) DEFAULT 'PENDING' NOT NULL
```

## 단계별 진행

### 1. DDL 리뷰 (운영 모드)

```text
운영 DB에 적용할 DDL 리뷰해줘 — ALTER TABLE TBL_ORDER ADD STATUS VARCHAR2(20) DEFAULT 'PENDING' NOT NULL
```

`review-sql`이 Phase 0에서 입력을 DDL로 감지하고, Phase 1에서 "운영 DB" 키워드로 `production` 모드를 잡아 모든 차원에 ×1.5 가중치를 준다. `sql-reviewer`가 `schema.json`과 `sql_usage.json`을 읽어 `_workspace/reports/sql_review_<slug>.md`를 만든다.

화면 보고는 차원별 표(사용처·인덱스·N+1·인젝션·트랜잭션·락·대량·DDL 영향·성능)와 위험도, 결정, 그리고 세 절로 나뉜 발견이다.

| 절 | 무엇이 들어가는가 | 어떻게 다루는가 |
|---|---|---|
| 확정 발견 (근거 있음) | 코드·인덱스에서 직접 읽힌 문제. 항목마다 파일:라인·SQL ID·`schema.json` 항목이 붙는다 | 그대로 신뢰하고 조치 계획에 넣는다 |
| 조건부 권고 (실 DB 확인 필요) | 실행 계획·인덱스 통계·데이터 분포를 봐야 결론이 나는 항목. 확인 방법이 함께 적힌다 | DBA와 EXPLAIN·건수 조회로 확인한 뒤 결정한다 |
| 수정안 SQL | 의미 보존을 확신할 때만 제시. 확신이 없으면 "생략 — 사유" 한 줄 | 생략됐다고 문제가 없는 것이 아니다. 조건부 권고를 본다 |

이 시나리오에서 확정 발견은 "DDL 영향 — NOT NULL이지만 DEFAULT가 있어 기존 데이터 영향 낮음", "스키마 의존성 — 영향 SQL ID 24개, 영향 @Entity Order" 같은 항목이다. 조건부 권고는 "STATUS로 조회하는 화면이 생기면 인덱스 추가 검토 — 확인 방법: 예상 조회 패턴과 건수" 같은 항목이다. 시나리오 예시의 위험도는 4/10 MEDIUM, 결정 HOLD다. HOLD의 보완 항목은 리포트 하단에 번호로 나열된다.

두 절을 섞어 읽지 않는다. "발견만" 필요하면 "발견만 보여줘"로 요청하면 조건부 권고·수정안이 생략된다.

### 2. 컬럼을 쓰는 코드의 영향

```text
TBL_ORDER에 STATUS 컬럼 추가하면 어디 영향?
```

`analyze-impact`가 입력을 DB 스키마 변경으로 정규화하고 `impact-analyzer`가 `table --table TBL_ORDER` 질의로 컬럼을 쓰는 SQL ID와 호출 위치, ORM 매핑, 인덱스 영향을 모은다. 결과는 `_workspace/reports/impact_TBL_ORDER_STATUS.md`다.

리포트에서 볼 절은 다음이다.

- **DB 영향** — 사용 SQL ID 목록과 각 SQL의 SELECT/UPDATE/INSERT/WHERE 위치, `@Entity` 클래스와 필드, 영향받는 인덱스.
- **직접 영향** — 그 SQL을 부르는 Mapper·Service 메서드.
- **사전 체크리스트** — "(DB 변경) 마이그레이션 스크립트 dry-run", "(DB 변경) Down 스크립트 준비"가 체크박스로 들어 있다.

이어서 Entity 변경이 API 응답에 미치는 영향을 본다.

```text
Order Entity에 status 필드 추가하면 어디 영향?
```

호출자와 JSON 응답 shape 변경이 나온다. 시나리오처럼 클라이언트 영향이 없는지는 사용자가 API 응답 호환성을 검토해 판단한다. `_workspace/pair_config.md`가 있으면 파트너 프로젝트 영향 절이 자동으로 추가된다.

### 3. DDL 실행은 DBA가

하네스는 SQL을 절대 자동 실행하지 않는다. 리뷰가 GO로 바뀐 뒤 실행은 DBA가 한다. 마이그레이션 도구를 쓰는 프로젝트라면 다음처럼 요청할 수 있다.

```text
이 DDL 마이그레이션 스크립트로 만들어줘
```

DDL이고 GO 결정이면 Liquibase/Flyway changeSet 형식 변환을 제안하고 Down 스크립트 작성을 권고한다. Down 스크립트는 `change-safety`의 롤백 차원에서도 요구되는 항목이므로 이 시점에 만들어 둔다.

### 4. Entity 변경을 safe-modify로

DDL이 적용됐거나 적용 일정이 확정됐으면 코드를 바꾼다.

```text
운영 배포 예정 — 이 변경 안전하게 적용해줘. Order Entity에 status 필드 추가, OrderMapper.xml의 selectOrder에 STATUS 컬럼 포함, OrderDto에 status 노출
```

`safe-modify`가 "운영 배포" 키워드로 `production` 모드를 잡는다. DB 스키마가 걸린 변경이라 규모는 `normal`이고, Phase 1은 2단계 리포트를 재사용하지 않고 `impact-analyzer`로 영향 분석을 새로 한다. 결과를 보여 준 뒤 묻지 않고 진행하며, DDL 적용 여부처럼 변경의 전제를 원문으로 확인하지 못했을 때만 먼저 묻는다. 적용 뒤 `pattern-conformance` → `verify-target.mjs run` → `change-safety` 순으로 평가한다.

`change-safety`의 롤백 차원은 "DB 스키마 변경 포함 → 다운 마이그레이션 스크립트 필요"로 채점한다. 3단계에서 Down 스크립트를 준비했으면 여기서 근거로 제시한다. 사이드 이펙트 차원은 새 트랜잭션 경계나 외부 통신이 도입되지 않았는지 본다.

### 5. 판정 읽기와 후속

GO는 `어댑터 FULL 또는 READ(원문 확인) + 패턴 CONFORM + 필수 검증 exit 0 + change-safety GO`가 모두 충족될 때만이다. DB 스키마 변경은 위험 변경이므로 검증 수단이 없으면 `검증 수단 없음` + 정적 대조만으로 GO가 나오지 않는다. `production` 모드에서는 보안 가중치가 2배이므로 같은 변경도 HOLD가 나오기 쉽다. HOLD면 보완 항목을 처리하고 "이 변경 다시 평가해줘"로 재평가한다.

GO 뒤 Phase 5가 인덱스를 incremental로 갱신하고 wiki를 재생성한다. 스키마가 바뀌었으므로 `schema.json`과 `sql_usage.json`이 새 컬럼을 반영하는지 보고에서 확인한다.

```text
변경 문서 동기화
```

`doc-syncer`가 API 스펙(Swagger/OpenAPI) 업데이트와 CLAUDE.md 변경 이력 항목을 권고한다. 권고만 하며 승인 전 문서를 고치지 않는다.

## 결과 확인

- `_workspace/reports/sql_review_<slug>.md` — DDL 영향과 스키마 의존성, 확정 발견·조건부 권고·수정안 SQL 3분법.
- `_workspace/reports/impact_TBL_ORDER_STATUS.md` — 사용 SQL ID, ORM 매핑, 사전 체크리스트.
- `_workspace/reports/impact_Order.md` 등 Entity 영향 리포트 — 응답 shape 변경 범위.
- Down 스크립트와(도구를 쓰면) changeSet 파일.
- `_workspace/reports/safety_<slug>.md` — 롤백 차원 근거가 채워진 GO.
- 갱신된 `_workspace/index/schema.json`·`sql_usage.json`과 `_workspace/wiki/database.md`.

## 막혔을 때

- **`schema.json`이 없다** — DDL 파일이나 ORM 매핑이 없어 유도하지 못한 경우다. DDL 스크립트를 저장소에 추가하고 "인덱스 갱신해줘"를 실행하거나, read-only 접속 정보를 직접 제공한다.
- **사용처가 0건으로 나온다** — `sql_usage.json`이 없거나 stale이면 리포트의 사용처 차원에 "인덱스 없음 — 사용처 미확정"이 표시된다. 이것은 "아무도 안 쓰는 안전한 SQL"이 아니다. 인덱스를 갱신하고 다시 리뷰한다.
- **조건부 권고가 많아 결정이 안 된다** — 실 DB 없이는 끝나지 않는 항목이다. 각 권고에 적힌 확인 방법(EXPLAIN, 인덱스 통계, 건수 조회)을 DBA에게 그대로 전달하면 된다.
- **"알아서 해줘"로 하려 했다** — DB 스키마 변경은 `vibe`의 승격 조건이다. 자동으로 `safe-modify`로 승격되므로 처음부터 `safe-modify`를 쓴다.
- **NOT NULL인데 DEFAULT를 빼려 한다** — `sql-reviewer`의 DDL 영향 차원이 "NOT NULL + DEFAULT 없음 → 기존 데이터 영향"으로 잡아 위험도가 오른다. 기존 행을 채우는 절차 없이는 HOLD가 유지된다.
- **큰 테이블이라 락이 걱정된다** — "운영 시간 패치"를 문장에 넣으면 `live_patch` 모드로 락 가중치가 ×2가 된다. 야간 배치 시간대에 적용할 계획이면 그 사실을 문장에 적어 평가 컨텍스트를 맞춘다.

## 관련 문서

- [review-sql](/skills/review-sql.md) — 입력 형식, 운영 모드 표, 발견·권고 분리 원칙.
- [sql-reviewer](/agents/sql-reviewer.md) — 10개 리뷰 차원과 위험도 점수.
- [analyze-impact](/skills/analyze-impact.md) · [impact-analyzer](/agents/impact-analyzer.md) — DB 스키마 입력과 Step 7 DB 영향.
- [safe-modify](/skills/safe-modify.md) — 운영 모드와 Phase 5 갱신.
- [인덱스 스펙](/reference/index-spec.md) — `schema.json`·`sql_usage.json` 구조.
