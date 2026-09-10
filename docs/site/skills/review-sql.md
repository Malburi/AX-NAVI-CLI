# review-sql

SQL 텍스트·SQL ID·DDL·SQL diff를 받아 사용처·인덱스 활용·N+1·인젝션·트랜잭션·락·대량 처리·스키마 영향을 종합 리뷰하는 오케스트레이터다. ITO/SI에서 DB가 사고의 절반이라는 점을 고려해 운영 컨텍스트에 따라 평가를 보수적으로 조정하며, 결과는 확정 발견 · 조건부 권고 · 수정안 SQL 3분법으로 보고한다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "SQL 리뷰", "이 쿼리 점검", "N+1 확인", "이 쿼리 성능", "인덱스 잘 쓰고 있어?", "이 SQL 안전한가?", "DDL 영향 분석", "이 컬럼 추가해도 돼?", "프로시저 리뷰", "운영 SQL 검토" |
| 영어 | "SQL review" |
| 축약 호출 | "SQL리뷰 [SQL ID·쿼리]", "쿼리리뷰 [대상]" |
| 슬래시 호출 | `/ax-navi:review-sql`, 별칭 `/sql [쿼리·SQL ID·DDL]` |
| 자동 트리거 | 없다. [scaffold-feature](/skills/scaffold-feature.md)가 DB 영향이 있는 기능에서 사전 호출을 권고한다. |

`/sql`은 `ax-navi:review-sql`로 위임하는 별칭이며 뒤에 쓴 내용 전부를 그대로 전달한다. "이 컬럼 추가해도 돼?"는 [analyze-impact](/skills/analyze-impact.md)와 겹치는데, DDL 문장이 함께 오면 review-sql이 DDL 모드로 처리한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 0 | 입력 정규화. SQL 입력 형식을 자동 감지한다. | `sql_usage.json` 조회 | 없음 |
| Phase 1 | 운영 모드 감지. 자연어 키워드로 mode를 정한다. | 키워드 매칭 | 없음 |
| Phase 2 | sql-reviewer 호출. SQL 원문 또는 ID, mode, 프로젝트 루트, 인덱스 경로를 전달한다. | [sql-reviewer](/agents/sql-reviewer.md) | 없음 |
| Phase 3 | 결과 보고. 차원별 평가, 위험도, 결정, 확정 발견, 조건부 권고, 수정안 SQL, 권고를 표시한다. | 리포트 읽기 | GO면 EXPLAIN·dry-run을 직접 수행하고, HOLD면 보완 항목을 처리한다. |
| 자동 후속 | DDL GO 시 마이그레이션 스크립트 변환 제안과 Down 스크립트 권고, DML이면 analyze-impact 추가 분석 권장, 레거시 SQL이면 legacy-decoder 안내. | — | 원하면 "마이그레이션 스크립트로 만들어줘"를 요청한다. |

### Phase 0 입력 형식

| 입력 형식 | 처리 |
|-----------|------|
| SQL ID (`ORDER_LMS_S01`) | `sql_usage.json`에서 텍스트 조회 |
| SQL 텍스트 (DML/SELECT) | 그대로 |
| DDL (CREATE/ALTER/DROP) | DDL 모드 |
| git diff (`*.sql` 또는 query XML) | diff 파싱 후 변경 SQL 추출 |
| 파일 경로 | 파일 내 SQL 모두 분석 |

### Phase 1 운영 모드

| 키워드 | 모드 | 평가 조정 |
|--------|------|-----------|
| "운영 DB", "프로덕션 쿼리" | production | 모든 차원 ×1.5 |
| "야간 배치", "배치 SQL" | batch | 대량 처리 ×0.5 |
| "운영 시간 패치" | live_patch | 락 ×2 |
| "OLTP", "온라인 트랜잭션" | oltp | 락 ×2 |
| "OLAP", "데이터 웨어하우스", "분석 쿼리" | olap | 성능 ×2, 락 ×0.5 |
| (없음) | normal | 기본 |

### 위험도와 결정

sql-reviewer는 10개 차원(사용처, 인덱스 활용, N+1, 인젝션, 트랜잭션, 락·동시성, 대량 처리, DDL 영향, 스키마 의존성, 성능 추정)을 검토하고 가산점으로 위험도를 매긴다. SQL 인젝션 +5, WHERE 없는 UPDATE/DELETE +10(즉시 STOP), DROP/TRUNCATE +10(즉시 STOP), 트랜잭션 안 외부 통신 +4, N+1 확정 +3, 인덱스 미사용 가능 +2, 데이터 손실 가능 DDL +5 등이다.

| 점수 | 등급 | 결정 |
|------|------|------|
| 0~3 | LOW | GO |
| 4~6 | MEDIUM | HOLD — 보완 후 진행 |
| 7~9 | HIGH | STOP — 재설계 권고 |
| 10 | CRITICAL | 즉시 STOP |

### 보고의 3분법

| 구분 | 담는 것 | 기준 |
|------|---------|------|
| 확정 발견 (Confirmed) | 코드·인덱스에서 직접 읽혀 확정된 문제 | 항목마다 파일:라인 / SQL ID / `schema.json` 항목 근거를 붙인다. |
| 조건부 권고 (Conditional) | 실 DB의 실행 계획·인덱스 통계·데이터 분포를 봐야 판단이 끝나는 항목 | 무엇을 확인해야 결론이 나는지(EXPLAIN / 인덱스 통계 / 건수·분포 조회)를 함께 적는다. |
| 수정안 SQL | 결과 집합·부수 효과가 바뀌지 않는다고 확신할 때만 작성 | 확신이 없으면 "생략 — [사유]" 한 줄만 남기고 조건부 권고로 돌린다. |

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `_workspace/index/sql_usage.json` | SQL ID 텍스트 조회와 사용처(호출 지점) 역추적 |
| 읽는 파일 | `_workspace/index/schema.json` | 인덱스 정의, 컬럼, 영향받는 뷰/프로시저/트리거 |
| 읽는 파일 | 사용자 제공 EXPLAIN 결과 | 있으면 성능 추정에 활용 |
| 읽는 파일 | `_workspace/reports/impact_<slug>.md` | 선택 입력 |
| 쓰는 파일 | `_workspace/reports/sql_review_<slug>.md` | 10개 차원 리뷰, 위험도 산출 내역, 결정, 확정 발견, 조건부 권고, 수정안 SQL, 보완 액션·대안, 실행 전 체크리스트 |

slug는 SQL ID가 있으면 그대로, 텍스트면 첫 30자 해시다. 소스 코드와 DB는 건드리지 않는다.

## 예시

```text
사용자: 운영 DB에 TBL_ORDER.STATUS 컬럼 추가해야 해. 영향 분석해줘.
        ALTER TABLE TBL_ORDER ADD STATUS VARCHAR2(10) DEFAULT 'PENDING' NOT NULL

하네스: SQL 리뷰 완료

        대상:
        ALTER TABLE TBL_ORDER ADD STATUS VARCHAR2(10) DEFAULT 'PENDING' NOT NULL

        운영 모드: production (모든 차원 ×1.5)

        차원별 평가:
        | 사용처 | 인덱스 | N+1 | 인젝션 | 트랜잭션 | 락 | 대량 | DDL 영향 | 성능 |
        | 24 SQL | 해당없음 | 없음 | 없음 | DDL 자동커밋 | 테이블 락 | — | DEFAULT 있음 | 1M+ rows |

        위험도: 4 / 10 (MEDIUM)
        즉시 STOP 트리거: 없음
        결정: HOLD

        확정 발견 (근거 있음):
        - TBL_ORDER를 참조하는 SQL ID 24개 — sql_usage.json
        - ORM 매핑 Order 엔티티에 status 필드 없음 — Order.java:31
        - DEFAULT 있음 → 기존 데이터 영향 LOW — schema.json TBL_ORDER

        조건부 권고 (실 DB 확인 필요):
        - 1M+ rows 테이블의 ALTER 락 시간 — 확인 방법: 테스트 DB에서 동일 DDL 소요 시간 측정
        - STATUS 조회 패턴에 인덱스 필요 여부 — 확인 방법: 신규 조회 SQL의 EXPLAIN

        수정안 SQL: 생략 — DDL 의미 변경 없이 제시할 수정이 없음

        [HOLD]
        보완 항목:
        1. 운영 영향 시간대 확인 후 실행 계획 수립
        2. Down 스크립트 (ALTER TABLE TBL_ORDER DROP COLUMN STATUS) 준비
        전체 리포트: _workspace/reports/sql_review_TBL_ORDER_STATUS.md
```

축약 호출과 인덱스 부재 상황이다.

```text
사용자: SQL리뷰 selectOrderList

하네스: _workspace/index/sql_usage.json이 없습니다 — 사용처를 grep으로 보완합니다.
        ...
        | 사용처 | ... |
        | 인덱스 없음 — 사용처 미확정 (grep 2건) | ... |
        결정: GO
        확정 발견: 없음
        조건부 권고:
        - ORDER_DATE 범위 조건이 인덱스를 탈지 — 확인 방법: EXPLAIN
        - 실행 전 EXPLAIN 확인 권고 · 테스트 DB dry-run
```

## 원칙과 주의

- **실행은 절대 자동으로 하지 않는다.** sql-reviewer는 리뷰만 하며 운영 DB에 자동 실행하지 않는다. 인덱스 추가도 권고만 하고 의사결정은 별도다.
- **운영 모드 가중치.** 운영 환경 키워드가 감지되면 평가가 보수적이 된다. 사용자가 "그래도 진행"을 요청해도 사용자가 알고 진행해야 함을 명시한다.
- **발견과 권고를 섞지 않는다.** sql-reviewer 리포트의 확정 발견·조건부 권고·수정안 SQL 3분법을 그대로 보고에 옮긴다. 실 DB 없이 판정할 수 없는 것은 확정 발견으로 쓰지 않는다. 사용자가 "발견만"을 요청하면 조건부 권고·수정안을 생략하고 확정 발견만 보고한다.
- **인덱스/스키마 캐시 의존.** `_workspace/index/schema.json`이 있어야 정확한 분석이 가능하다. 없으면 "DB 접속하여 스키마 추출 필요"를 안내한다.
- **"사용처 0건"을 "안전한 SQL"로 오인하지 않는다.** `sql_usage.json`이 없거나 stale이면 grep으로 보완하되 `사용처` 차원에 반드시 **"인덱스 없음 — 사용처 미확정"**을 표시해 인덱스 부재와 실제 미사용을 구분한다.
- **레거시 SQL은 위임한다.** 주석 없는 대형 프로시저·트리거·동적 SQL 등 의도 파악이 어려운 경우 리뷰는 위험 평가에 집중하고 로직 역공학은 [legacy-decoder](/agents/legacy-decoder.md)로 위임한다.
- **DDL GO 후속.** "마이그레이션 스크립트로 만들어줘" 요청이 있으면 Liquibase/Flyway changeSet 형식으로 변환을 제안하고 Down 스크립트 자동 작성을 권고한다. DML 변경 SQL이면 영향받는 코드 위치를 analyze-impact로 추가 분석하도록 권장한다.

## 관련 문서

- [sql-reviewer 에이전트](/agents/sql-reviewer.md)
- [analyze-impact](/skills/analyze-impact.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [별칭](/skills/aliases.md)
- [튜토리얼: DB 컬럼 변경](/tutorials/db-column-change.md)
