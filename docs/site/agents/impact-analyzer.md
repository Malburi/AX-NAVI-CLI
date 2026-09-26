# impact-analyzer

변경 대상(파일·함수·클래스·SQL·엔드포인트·DB 컬럼)이 어디까지 영향을 미치는지 추적해 근거 있는 위험도를 산출하는 에이전트다. 호출 그래프·데이터 흐름·트랜잭션 경계·외부 통신·테스트 영향·환경 분기·파트너 프로젝트까지 보고 1~10점 위험도와 함께 리포트한다. 인덱스는 `query-index.mjs` 질의로 우선 활용하고 부족하면 grep으로 보완한다. 영향 분석과 리포트만 하며 코드를 수정·삭제하지 않는다.

## 호출 경로

- [analyze-impact](/skills/analyze-impact.md) Phase 2가 부른다. `/impact` 별칭도 같은 경로다.
- [safe-modify](/skills/safe-modify.md) Phase 1은 규모 normal일 때만 이 에이전트를 실행한다(small이면 오케스트레이터가 인덱스 질의로 직접 확인). 결과를 보여 준 뒤 묻지 않고 진행하며, CRITICAL이거나 데이터 변경 전제를 확인하지 못했거나 요청 해석이 갈릴 때만 사용자에게 묻는다.
- frontmatter `model`은 `claude-sonnet-5`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. Step 0에서 `query-index.mjs summary`로 `call_graph`·`symbols`·`sql_usage`·`external_io`·`transactions` 존재를 확인한다. 인덱스 mtime이 코드보다 오래되면 stale 경고 후 진행하고 analyzer incremental 재실행을 권고한다.
2. Step 1에서 입력을 인덱스 조회 가능한 식별자로 정규화한다. 파일 경로는 `symbol --file`로 심볼을 뽑아 분기하고, DB 컬럼은 `table --table`로 사용 SQL ID 집합을 모은다.
3. Step 2에서 `callers --id`로 직접 호출자를 수집한다. 인덱스가 없으면 Java·Python·JS/TS별 grep 폴백을 쓴다.
4. Step 3에서 직접 호출자부터 상류 방향으로 BFS 3홉까지 확장한다. 홉마다 `callers --id`를 반복하며(`trace`는 하류용이라 쓰지 않음), 노드가 100개를 넘으면 다음 홉으로 가지 않고 허브 메서드만 표시한다.
5. Step 4에서 `callers` 응답의 테스트 경로 파일을 영향 테스트로 식별하고, `jacoco.xml`·`coverage.xml`·`lcov.info`가 있으면 실제 커버 테스트만 고른다.
6. Step 5~8에서 `transaction --id`로 트랜잭션 경계, `external_io.json`으로 외부 통신, `table --table`과 `schema.json`으로 DB 영향, `env_branches.json`으로 환경 분기를 확인한다.
7. Step 8.5에서 `_workspace/pair_config.md`가 있으면 파트너 프로젝트 영향을 본다. 1:N(hub-roots)이면 `## Partner:` 블록마다 반복하고, API 계약 영향이 있으면 파트너 루트에서 호출 위치를 grep한다.
8. Step 9에서 위험도 점수를 산출하고 리포트와 사전 체크리스트를 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `_workspace/index/*.json`(질의로만), `_workspace/pair_config.md`(있으면), 파트너의 `api_drift_report.md`(있으면), 커버리지 파일(있으면) |
| 씀 | `_workspace/reports/impact_<slug>.md` |

`truncated > 0`인 응답은 호출자 목록이 잘린 것이므로 그 수로 점수를 매기지 않고 `--limit`을 올려 실제 `total`을 근거로 쓴다.

## 판정·출력 형식

```
기본 점수 1
+ 직접 호출자 수 × 0.2 (최대 +3)
+ 간접 영향 노드 수 × 0.05 (최대 +2)
+ 외부 통신 +2, 트랜잭션 경계 +1, DB 스키마 +2, 인증/인가 경로 +2, 환경 분기 +1, 파트너 영향 +1
- 테스트 커버리지 비율 × 2
최종 = min(10, 반올림)
```

| 점수 | 등급 | 권고 |
|------|------|------|
| 1~3 | LOW | 즉시 진행 가능 |
| 4~6 | MEDIUM | 영향 파일 단위 테스트 권고 |
| 7~8 | HIGH | 회귀 테스트 + 사전 코드 리뷰 필수 |
| 9~10 | CRITICAL | 외부 시스템 조율 + 단계별 배포 + 롤백 계획 필수 |

리포트는 `=== IMPACT ANALYSIS REPORT ===`로 시작해 직접 영향·간접 영향(BFS N홉, 허브 메서드)·영향받는 테스트·트랜잭션 경계·외부 통신·파트너 프로젝트 영향(pair 연동 시)·DB 영향·인증/인가·환경 분기 절을 거쳐 `## 위험도 점수: [N] / 10`과 산출 내역, 권고, 사전 체크리스트로 끝난다. 마지막에 대상 심볼 이름(문자열 리터럴 포함)으로 직접 Grep 한 결과를 "동적 호출 확인: [찾은 위치 또는 없음]" 한 줄로 붙인다. 사용자에게 확인을 떠넘기지 않는다.

## 원칙

- 인덱스 원본을 Read로 열지 않고 `summary` 뒤 질의 명령으로 필요한 줄만 가져온다.
- 잘린 목록을 완전한 값으로 보고 점수를 매기지 않는다.
- 분석 한계를 정직하게 명시한다. 리플렉션·DI 동적 바인딩·문자열 결합 SQL·외부 시스템에서의 호출·AOP 어드바이스·동적 import는 정적 분석으로 잡히지 않는다.
- 파트너 영향 가산(+1)은 파트너 수만큼 중복하지 않는다.

## 관련 문서

- [analyze-impact](/skills/analyze-impact.md)
- [safe-modify](/skills/safe-modify.md)
- [change-safety](/agents/change-safety.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [DB 컬럼 변경 튜토리얼](/tutorials/db-column-change.md)
