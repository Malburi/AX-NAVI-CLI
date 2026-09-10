# find-feature

기능명·키워드·도메인 용어로 관련 파일·클래스·메서드·SQL을 찾아 목록으로 돌려주는 스킬이다. 키워드와 범위를 추출해 `feature-finder` 에이전트에 넘기고 결과를 요약해 전달하는 오케스트레이터로, 읽기 전용이라 언제 실행해도 프로젝트에 흔적을 남기지 않는다. "어디 있어?"라는 질문에 답하는 것이 역할이며, 흐름을 따라가는 [trace-logic](/skills/trace-logic.md)의 앞 단계로 자주 쓰인다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 위치 질문 | "결제 관련 파일 어디 있어?", "회원가입 어디서 처리해?", "배송 로직 어디 있어?" |
| 코드 탐색 | "쿠폰 관련 코드 찾아줘", "관련 코드 찾아줘", "관련 파일", "코드 어디에?" |
| 담당 지정 | "담당 파일", "담당 클래스", "어디서 처리해?" |
| 축약형 | "찾아 [대상]", "찾기 [대상]" (예: "결제 찾아", "쿠폰 찾기") |
| 영어 | "find feature" |

호출 방법은 세 가지다.

| 방법 | 입력 |
|------|------|
| 자연어 | 위 트리거 문구 중 하나를 포함해 요청 |
| 슬래시 | `/ax-navi:find-feature 결제 승인 처리` |
| 별칭 | `/find 결제 승인 처리` (find-feature로 그대로 위임) |

주의할 예외가 하나 있다. bare "찾아줘"에 대상어가 없거나 버그·수정 맥락이면 find-feature가 아니라 safe-modify 성격일 수 있으므로 하드 트리거로 고정하지 않는다. "찾아 결제"처럼 대상어가 붙은 축약형은 별칭을 거치지 않고 find-feature로 직접 라우팅된다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 입력 파악 | 검색 키워드와 범위(전체·레이어·SQL·패키지)를 추출 | 없음 | 키워드가 없으면 "어떤 기능/키워드를 찾을까요?" 1회 확인 |
| Phase 1 인덱스 확인 | 인덱스 신선도를 확인하고 `symbols.json`으로 먼저 훑음 | `build-index.mjs --check-stale`, `query-index.mjs symbol --name <키워드>` | 없음 |
| Phase 2 feature-finder 호출 | 키워드·범위·루트·출력 경로만 인자로 전달 | `ax-navi:feature-finder` (model sonnet) | 없음 |
| Phase 3 결과 전달 | 리포트를 읽어 요약 출력하고 다음 단계를 권고 | 없음 | 권고 중 하나를 골라 이어갈 수 있음 |

Phase 0의 추출 규칙은 SKILL.md의 표를 그대로 따른다.

| 사용자 표현 | 키워드 | 범위 |
|------------|--------|------|
| "결제 관련 파일 어디 있어?" | 결제 | 전체 |
| "쿠폰 서비스 레이어만 찾아줘" | 쿠폰 | service 레이어 |
| "TBL_ORDER 건드리는 SQL 찾아줘" | TBL_ORDER | SQL |
| "com.example.order 패키지 회원 관련" | 회원 | 패키지 지정 |

Phase 1의 분기는 인덱스 상태에 따라 갈린다.

| 인덱스 상태 | 동작 |
|------------|------|
| `symbols.json` 있고 fresh (exit 0) | `query-index.mjs symbol --name <키워드>`로 먼저 훑고 결과를 feature-finder에 전달 |
| stale (exit 1) | `--mode incremental` 재인덱싱 시도. 탐색성 질의라 급하지 않으면 "인덱스가 stale일 수 있음"만 알리고 진행 가능 |
| 인덱스 없음 | feature-finder가 다중 grep 전략으로 대체 |

find-feature는 read-only라 safe-modify만큼 인덱스 신선도에 민감하지 않다. 그래서 stale이어도 재인덱싱 없이 진행하는 선택지가 열려 있다.

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root "[프로젝트 루트 절대 경로]" --check-stale
```

`$env:CLAUDE_PLUGIN_ROOT`가 비어 있으면 스킬 로드 시 표시된 "Base directory for this skill"에서 `/skills/find-feature`를 뗀 경로를 대신 쓴다. 네임스페이스를 지원하지 않는 호스트에서는 `general-purpose`로 폴백하되 "`agents/feature-finder.md`의 지침을 읽고 그대로 따른다"를 프롬프트에 명시한다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `_workspace/index/symbols.json` | 클래스·메서드 위치 인덱스. `query-index.mjs symbol`이 여기서 후보를 뽑는다 |
| 읽음 | 프로젝트 소스 | feature-finder가 인덱스 결과를 보강하거나, 인덱스가 없을 때 grep으로 직접 탐색 |
| 씀 | `_workspace/reports/found_<slug>.md` | 탐색 결과 리포트. slug는 `payment`, `coupon`, `member`처럼 키워드의 안전한 파일명 |
| 갱신 가능 | `_workspace/index/` | stale 판정 시 증분 재인덱싱으로 갱신 |

리포트 형식은 [feature-finder](/agents/feature-finder.md) 에이전트가 정한다. 사용자 설명서에 실린 예시는 Controller·Service·SQL·외부 연동으로 묶어 파일과 라인을 나열한다.

## 예시

```text
사용자: 결제 관련 코드 어디 있어?

Claude: 인덱스를 확인합니다. (symbols.json fresh)
        query-index.mjs symbol --name 결제 결과를 feature-finder에 전달합니다.

        "결제" 관련 코드 위치

        Controller
          - PaymentController.java (line 45, 89, 123)
          - OrderController.java (line 201) ← 결제 요청 포함
        Service
          - PaymentService.java (전체)
          - OrderService.java (line 156) ← 결제 상태 확인
        SQL
          - PaymentMapper.xml (쿼리 ID selectPayment, insertPayment)
        외부 연동
          - PgGateway.java ← PG사 API 직접 호출

        리포트는 _workspace/reports/found_payment.md 에 저장했습니다.
        흐름이 궁금하면 trace-logic으로 실행 흐름 추적을 권고합니다.
```

```text
사용자: TBL_ORDER 건드리는 SQL 찾아줘

Claude: 키워드 TBL_ORDER, 범위 SQL로 탐색합니다.
        인덱스가 없어 feature-finder가 다중 grep 전략으로 대체합니다. 속도가 느릴 수 있습니다.

        [결과 요약]
        OrderMapper.xml — selectOrder, updateOrderStatus, insertOrder
        BatchMapper.xml — selectExpiredOrders

        변경 계획이 있으면 analyze-impact로 영향도 확인을 권고합니다.
```

## 원칙과 주의

- 이 스킬은 코드를 수정하지 않는다. 위치를 찾은 뒤 흐름을 보려면 trace-logic, 바꾸려면 analyze-impact·safe-modify로 이어간다.
- 결과 끝에는 다음 단계를 권고한다. 흐름이 궁금하면 trace-logic, 변경 계획이 있으면 analyze-impact, 레거시 코드면 legacy-decoder다.
- 대상어 없는 "찾아줘"는 버그 수정 요청일 수 있어 find-feature로 고정 라우팅하지 않는다. 의도가 탐색이면 대상어를 붙여 말하는 것이 빠르다.
- 인덱스 없는 프로젝트에서도 동작하지만 grep 대체 경로는 느리고 누락 가능성이 있다. 반복해서 쓸 계획이면 [harness-init](/skills/harness-init.md)으로 인덱스를 만들어 두는 것이 낫다.
- 로컬 스킬 `.claude/skills/find-logic.md`는 writer가 프로젝트별로 작성한 것으로 전역 find-feature와 별개다. 관계는 [별칭 스킬](/skills/aliases.md)에 정리돼 있다.

## 관련 문서

- [feature-finder 에이전트](/agents/feature-finder.md)
- [trace-logic](/skills/trace-logic.md)
- [별칭 스킬 (/find)](/skills/aliases.md)
- [결정적 인덱스](/concepts/deterministic-index.md)
- [트리거 레퍼런스](/reference/triggers.md)
