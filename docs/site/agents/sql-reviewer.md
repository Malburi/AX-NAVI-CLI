# sql-reviewer

SQL 텍스트·SQL ID·DDL·SQL 변경 diff를 받아 사용처·인덱스 활용·N+1·인젝션·트랜잭션·락·대량 처리·DDL 영향·스키마 의존성·성능 10개 차원으로 종합 리뷰하는 에이전트다. SQL 변경/리뷰의 단일 진입점이며 `_workspace/index/sql_usage.json`과 `schema.json`을 우선 활용한다. 리뷰와 문서화만 하며 SQL을 자동 수정하거나 실제 실행하지 않는다.

## 호출 경로

- [review-sql](/skills/review-sql.md) Phase 2가 부른다. `/sql` 별칭도 같은 경로다. Phase 1에서 오케스트레이터가 사용자 자연어의 운영 컨텍스트 키워드로 mode를 정해 전달한다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스나 SQL 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. 사용처 역추적. SQL ID면 `sql_usage.json`에서 호출 위치를 모두 모으고, 텍스트면 동일·유사 쿼리를 검색한다.
2. 인덱스 활용 가능성. `schema.json`의 인덱스 정의와 WHERE·JOIN 컬럼을 대조하고 leading column 누락·함수 적용·형변환을 본다. 권고 인덱스는 후보만 제시한다.
3. N+1 패턴. 루프 안 SQL 호출과 ORM lazy loading을 확인한다.
4. SQL 인젝션 위험. 문자열 결합, 식별자 위치의 사용자 입력, ORDER BY/LIMIT의 사용자 입력을 찾는다.
5. 트랜잭션 적정성과 락·동시성. DML이 경계 안인지, 경계가 과대한지, 트랜잭션 안에서 외부 통신을 하는지, `FOR UPDATE`·데드락 가능성을 본다.
6. 대량 처리. WHERE 없는 UPDATE/DELETE는 자동 STOP 권고다.
7. DDL이면 컬럼 추가·타입 변경·인덱스 변경·DROP/TRUNCATE 영향과 `@Entity`·SQL ID·뷰/프로시저 의존성을 확인한다.
8. 성능 추정. 사용자가 준 EXPLAIN 결과가 있으면 활용하고 풀 스캔 가능성을 표시한다.
9. 위험도 점수를 산출하고 GO/HOLD/STOP과 리포트를 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | SQL 텍스트/ID/DDL/diff, `_workspace/index/sql_usage.json`, `_workspace/index/schema.json`, impact 리포트(선택), 사용자 제공 EXPLAIN(선택) |
| 씀 | `_workspace/reports/sql_review_<slug>.md` |

## 판정·출력 형식

```
+ SQL 인젝션 위험 +5 · WHERE 없는 UPDATE/DELETE +10 (즉시 STOP) · DROP/TRUNCATE +10 (즉시 STOP)
+ 트랜잭션 안 외부 통신 +4 · N+1 확정 +3 · N+1 가능 +1 · 인덱스 미사용 가능 +2
+ DDL 데이터 손실 가능 +5 · 대량 처리(full scan) +2 · DDL 큰 테이블(1M+ rows) +3
```

| 점수 | 등급 | 결정 |
|------|------|------|
| 0~3 | LOW | GO |
| 4~6 | MEDIUM | HOLD — 보완 후 진행 |
| 7~9 | HIGH | STOP — 재설계 권고 |
| 10 | CRITICAL | 즉시 STOP |

리포트는 `=== SQL REVIEW REPORT ===`로 시작해 원문 SQL, 10개 차원 절, `## 위험도`, `## 결정: [GO / HOLD / STOP]`을 지나 발견과 권고를 세 절로 나눈다.

- `## 확정 발견 (Confirmed)` — 코드·인덱스에서 직접 읽혀 확정된 문제만. 항목마다 `파일:라인 / SQL ID / schema.json 항목` 근거를 붙인다.
- `## 조건부 권고 (Conditional)` — 실 DB의 실행 계획·인덱스 통계·데이터 분포를 봐야 결론이 나는 항목. 무엇을 확인해야 하는지(EXPLAIN·인덱스 통계·건수 분포 조회)를 함께 적는다.
- `## 수정안 SQL (의미 보존 확신 시만)` — 결과 집합과 부수 효과가 바뀌지 않는다고 확신할 때만 작성한다. 확신이 없으면 "생략 — [사유]" 한 줄만 남기고 조건부 권고로 돌린다.

이어서 HOLD/STOP이면 보완 액션과 대안, 마지막에 실행 전 체크리스트(EXPLAIN 확인·테스트 DB dry-run·DDL Down 스크립트·운영 영향 시간대·락 영향 측정)가 온다.

운영 컨텍스트별 조정이 있다. 운영 DB 직접 실행은 모든 차원 ×1.5, 야간 배치는 대량 처리 ×0.5, 운영 시간대 패치는 락/대량 처리 ×2, OLTP는 락 ×2, OLAP/DW는 성능 ×2·락 ×0.5다.

## 원칙

- 발견과 권고를 섞지 않는다. 실 DB 없이 판정할 수 없는 것은 확정 발견으로 쓰지 않는다. "인덱스를 안 탈 수 있다"처럼 통계에 달린 판단은 조건부 권고로 두고 확인 방법을 적는다.
- 수정안 SQL은 의미 보존을 확신할 때만 낸다. 확신 없는 수정안은 권고 문장으로 대신한다.
- "발견만"·"findings only" 요청이면 조건부 권고·수정안 절을 "요청에 따라 생략"으로 채운다.
- 인덱스 추가는 별도 의사결정이므로 권고만 한다.

## 관련 문서

- [review-sql](/skills/review-sql.md)
- [DB 컬럼 변경 튜토리얼](/tutorials/db-column-change.md)
- [impact-analyzer](/agents/impact-analyzer.md)
- [인덱스 명세](/reference/index-spec.md)
- [게이트](/concepts/gates.md)
