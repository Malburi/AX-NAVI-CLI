# feature-finder

기능명·키워드·도메인 용어로 관련 파일·클래스·메서드·SQL의 위치를 빠르게 찾아 목록으로 돌려주는 에이전트다. logic-tracer가 "흐름 추적"이라면 feature-finder는 "위치 탐색"으로, 작업의 시작점을 잡는 데 특화되어 있다. 인덱스는 `query-index.mjs` 질의로 우선 활용하고 없으면 다중 전략 grep을 쓴다. 탐색과 목록화만 하며 코드를 수정하지 않는다.

## 호출 경로

- [find-feature](/skills/find-feature.md) Phase 2가 부른다. Phase 0에서 입력을 파악하고 Phase 1에서 인덱스를 확인한 뒤다.
- `/find` 별칭은 find-feature로 위임한다.
- frontmatter description에 "결제 관련 파일 어디 있어?", "회원가입 어디서 처리해?", "find feature", "어디 있어?", "관련 코드", "찾아줘" 같은 트리거 문구가 있다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. Strategy 1 인덱스 탐색. `summary`로 존재를 확인한 뒤 `symbol --name`(클래스·메서드 부분 일치), `sql --id`/`sql --table`(SQL ID·사용처), `endpoint --path`(엔드포인트), `callers`/`callees --id`(관련 노드 클러스터), `dead --file`(찾은 결과가 죽은 코드인지)로 질의한다.
2. Strategy 2 다중 키워드 grep(인덱스 없을 때). "주문취소"를 `orderCancel`·`OrderCancel`·`ORDER_CANCEL`·`order_cancel`처럼 변형해 `.java`·`.kt`·`.py`·`.js`·`.ts`·`.vue`·`.xml`·`.sql`·`.jsp` 등에서 병렬 탐색한다.
3. Strategy 3 파일명 탐색. `*{keyword}*.java` 같은 glob으로 `controller/`·`service/`·`mapper/`·`repository/`·`dao/` 폴더를 우선 본다.
4. Strategy 4 SQL·매퍼 탐색. MyBatis XML과 SQL 파일에서 SQL ID와 예상 테이블명을 찾는다.
5. 찾은 항목을 Controller/Handler/Router, Service, Repository/DAO/Mapper, SQL/Mapper XML, UI/View, Config/Properties 레이어로 분류한다.
6. 결과가 20개를 넘으면 레이어별 상위 5개만 표시하고 나머지는 리포트 파일을 안내한다. 0개면 철자 변형·영한 혼용으로 유사 키워드를 제안한다.
7. 사용자가 "서비스 레이어만", "SQL만", "프런트엔드 쪽", "com.example.order 패키지"처럼 범위를 지정하면 그 범위만 탐색한다.
8. `_workspace/reports/found_<slug>.md`에 전체 목록을 쓰고 인라인 요약을 출력한다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 기능명/키워드, 범위 제한(선택), `_workspace/index/*.json`(질의로만), 소스·매퍼 파일 |
| 씀 | `_workspace/reports/found_<slug>.md` |

"총 N개 항목 발견"의 N은 응답의 `returned`가 아니라 `total`을 쓰고, `truncated > 0`이면 목록이 잘렸음을 결과에 명시한다.

## 판정·출력 형식

점수나 판정은 없다. 인라인 요약은 레이어별 구획선 형식이다.

```
"[키워드]" 관련 코드 탐색 결과
총 N개 항목 발견
── Controller ── 파일:줄 · 메서드 시그니처 · → HTTP 메서드 + 경로
── Service ── 파일:줄 · 메서드
── DAO / Mapper ── 파일:줄 · 메서드
── SQL ── 파일:줄 · ID · → 테이블 (동작)
── UI ── 파일:줄
전체 목록: _workspace/reports/found_<slug>.md
다음 단계:
- 흐름을 따라가려면 "… 로직 흐름 추적해줘" (trace-logic)
- 변경 영향 확인 "… 영향도 분석" (analyze-impact)
```

## 원칙

- 인덱스 원본을 Read로 열지 않고 `summary` 뒤 질의 명령으로 필요한 줄만 가져온다.
- 잘린 목록을 전체로 표기하지 않는다.
- 찾은 결과가 이미 죽은 코드인지 `dead --file`로 확인한다.
- 결과 뒤에 trace-logic·analyze-impact로 이어지는 다음 단계를 안내한다.

## 관련 문서

- [find-feature](/skills/find-feature.md)
- [스킬 별칭](/skills/aliases.md)
- [logic-tracer](/agents/logic-tracer.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [온보딩 첫날](/tutorials/onboarding-day1.md)
