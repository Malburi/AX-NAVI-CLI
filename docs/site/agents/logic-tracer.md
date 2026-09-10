# logic-tracer

특정 기능·API·화면·버튼의 처리 흐름을 진입점부터 DB까지 계층별로 추적하는 에이전트다. "어디서 시작해서 어디까지 가는가"를 Controller → Service → Repository → SQL → Table 순으로 따라가며 외부 통신·권한 필터·트랜잭션 경계도 함께 기록한다. 인덱스는 `query-index.mjs` 질의로 우선 활용하고 없으면 grep으로 대체한다. 탐색과 분석만 하며 코드를 수정하지 않는다. feature-finder가 "위치 탐색"이라면 이 에이전트는 "흐름 추적"이다.

## 호출 경로

- [trace-logic](/skills/trace-logic.md) Phase 2가 부른다. Phase 0에서 입력을 파악하고 Phase 1에서 인덱스를 준비한 뒤다.
- `/flow` 별칭은 trace-logic으로 위임한다. `/trace`가 아닌 이유는 하네스가 대상 프로젝트마다 로컬 `trace` 스킬을 배포해 이름이 충돌하기 때문이다.
- frontmatter description에 "주문 취소 로직 어디 있어?", "이 API 어떻게 처리돼?", "결제 흐름 보여줘", "trace logic", "flow of" 같은 트리거 문구가 있다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. Step 0에서 `query-index.mjs summary`로 인덱스를 확인한다. `symbol --name`은 위치, `callers`/`callees`/`trace --id --depth N`은 호출 관계, `sql --id`/`table --table`은 SQL 매핑, `transaction --id`는 트랜잭션 경계에 쓴다. 인덱스가 없으면 grep/glob으로 대체하고 속도 저하를 명시한다.
2. Step 1에서 대상 유형별로 진입점을 찾는다. API는 `endpoint --path`, 기능명은 컨트롤러·핸들러 grep, 화면 ID는 JSP/Vue/React 파일에서 연결 API 추출, 클래스명은 `symbol --name`이다. 진입점이 여럿이면 모두 나열하고 선택을 요청하거나 가장 관련성 높은 1개를 선택 후 명시한다.
3. Step 2에서 `trace --id [진입점] --depth 3`으로 호출 체인을 하향 추적한다. 깊이가 모자라면 값을 올리거나 말단에 `callees --id`를 이어 붙인다. 각 레이어에서 파일·클래스·메서드(줄 번호), 분기별 경로, 예외 처리 경로를 기록한다.
4. Step 3에서 SQL 레이어의 문장·사용처·영향 테이블(MyBatis ID, JPA 메서드, JDBC 문자열)과 `transaction --id`로 marker·propagation·isolation을 확인한다.
5. Step 4에서 외부 API·메시지큐 호출의 URL/토픽, 위치, 동기/비동기, 타임아웃·재시도를 추출한다.
6. Step 5(선택)에서 필터·인터셉터·요청 유효성 검사·전처리 AOP를 역방향으로 확인한다.
7. `_workspace/reports/trace_<slug>.md`에 저장하고 사용자에게 요약을 출력한다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 추적 대상(기능명/API/화면명/버튼), `_workspace/index/*.json`(질의로만), 대상 소스 |
| 씀 | `_workspace/reports/trace_<slug>.md` |

`truncated > 0`이면 경로 목록이 잘린 것이므로 "이게 전부"라고 쓰지 않고 `--limit`을 올리거나 `--depth`를 줄여 다시 조회한다.

## 판정·출력 형식

점수나 GO/HOLD 판정은 없다. 출력은 레이어별 구획선 형식이다.

```
로직 흐름 추적: [추적 대상]
── 진입점 ── [파일:줄] 메서드명
── Controller ── [파일:줄] 메서드명
── Service ── [파일:줄] 메서드명 ├─ [분기 A] 조건 └─ [분기 B] 조건
── Repository / DAO ── [파일:줄] 메서드명
── SQL ── ID · 테이블(UPDATE/INSERT) · 트랜잭션 @Transactional(REQUIRED) @ 위치
── 외부 통신 ── (없음 / 있으면 표시)
── 권한·필터 ── [파일:줄] Interceptor.preHandle
⚠️ 동적 호출(리플렉션/AOP)·런타임 분기는 정적 분석 한계로 누락될 수 있습니다.
전체 리포트: _workspace/reports/trace_<slug>.md
```

모호한 입력에는 1회 확인 질문("어떤 화면/기능/엔드포인트를 추적할까요?")을 한다.

## 원칙

- 인덱스 원본을 Read로 열지 않고 `summary` 뒤 질의 명령으로 필요한 줄만 가져온다.
- 탐색 한계를 항상 명시한다. 리플렉션 경유 호출은 추적 불가, 동적 SQL 조립은 테이블 추출이 불완전하며, 비동기 이벤트 체인은 발행 시점까지만 추적한다(소비자 측은 별도 추적).
- 잘린 목록을 전체로 표기하지 않는다.

## 관련 문서

- [trace-logic](/skills/trace-logic.md)
- [스킬 별칭](/skills/aliases.md)
- [feature-finder](/agents/feature-finder.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [작은 버그 수정 튜토리얼](/tutorials/small-bugfix.md)
