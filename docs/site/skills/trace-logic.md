# trace-logic

특정 기능·API·화면의 처리 흐름을 진입점부터 DB까지 추적하는 스킬이다. 사용자 표현에서 추적 대상을 뽑아 `logic-tracer` 에이전트에 넘기고, 에이전트가 쓴 리포트를 그대로 사용자에게 전달하는 얇은 오케스트레이터다. 코드를 바꾸지 않는 읽기 전용 작업이므로 장애 대응이나 신규 투입 첫날처럼 "지금 이게 어떻게 돌아가는지"를 빠르게 알아야 할 때 가장 먼저 쓰게 된다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 기능 흐름 | "주문 취소 로직 어디 있어?", "결제 흐름 보여줘", "로그인 로직 따라가줘" |
| API 흐름 | "이 API 어떻게 처리돼?" |
| 화면 이벤트 | "이 화면 저장 버튼 누르면 뭐가 실행돼?" |
| 일반 표현 | "처리 흐름 알려줘", "실행 흐름", "로직 흐름", "흐름 추적", "어떻게 동작해?", "동작 방식", "내부 구조" |
| 영어 | "trace logic", "flow of" |

호출 방법은 세 가지다.

| 방법 | 입력 |
|------|------|
| 자연어 | 위 트리거 문구 중 하나를 포함해 요청 |
| 슬래시 | `/ax-navi:trace-logic 주문 취소` |
| 별칭 | `/flow 주문 취소` (trace-logic으로 그대로 위임) |

별칭 이름이 `/trace`가 아니라 `/flow`인 이유는 harness-init이 대상 프로젝트마다 로컬 스킬 `.claude/skills/trace.md`를 배포하기 때문이다. 이름이 겹치면 어느 쪽이 실행될지 모호해지므로 전역 별칭은 `/flow`로 정했다. 자세한 관계는 [별칭 스킬](/skills/aliases.md)에 있다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 입력 파악 | 사용자 표현에서 기능명·API·클래스·UI 이벤트 중 하나를 추적 대상으로 추출 | 없음 | 모호하면 "어떤 기능/API/화면의 흐름을 추적할까요?" 1회 확인 |
| Phase 1 인덱스 준비 | 결정적 인덱스의 신선도를 확인하고 필요하면 증분 재인덱싱 | `build-index.mjs --check-stale`, `query-index.mjs trace --id <진입점> --depth 3`, `build-index.mjs --mode incremental` | 없음 |
| Phase 2 logic-tracer 호출 | 추적 대상·프로젝트 루트·출력 경로만 인자로 전달 | `ax-navi:logic-tracer` (model sonnet) | 없음 |
| Phase 3 결과 전달 | 리포트를 읽어 출력하고 다음 단계를 권고 | 없음 | 권고 중 하나를 골라 이어갈 수 있음 |

Phase 0의 추출 규칙은 SKILL.md의 표를 그대로 따른다.

| 사용자 표현 | 추출 결과 |
|------------|----------|
| "주문 취소 로직 추적" | 기능명 "주문 취소" |
| "POST /api/orders/{id}/cancel 흐름" | API `POST /api/orders/{id}/cancel` |
| "OrderCancelController 어떻게 돼?" | 클래스 `OrderCancelController` |
| "결제 화면 확인 버튼 누르면" | UI 이벤트 "결제 화면 확인 버튼" |

Phase 1의 분기는 인덱스 상태에 따라 갈린다.

| 인덱스 상태 | 동작 |
|------------|------|
| fresh (exit 0) | `query-index.mjs trace`로 경로를 먼저 뽑아 logic-tracer에 전달 |
| stale (exit 1) | `--mode incremental`로 재인덱싱 후 진행. 급한 1회성 추적이면 "인덱스가 stale일 수 있음"만 알리고 진행 가능 |
| 인덱스 없음 | logic-tracer가 grep 탐색으로 대체하며 속도 저하를 안내 |

Phase 2의 호출은 네임스페이스를 지정하므로 에이전트 지침이 자동 로드된다. 네임스페이스를 지원하지 않는 호스트에서는 `general-purpose`로 폴백하되 "`agents/logic-tracer.md`의 지침을 읽고 그대로 따른다"를 프롬프트에 명시한다.

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root "[프로젝트 루트 절대 경로]" --check-stale
```

`$env:CLAUDE_PLUGIN_ROOT`가 비어 있으면 스킬 로드 시 표시된 "Base directory for this skill"에서 `/skills/trace-logic`를 뗀 경로를 대신 쓴다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `_workspace/index/*.json` | `build-index.mjs`가 만든 결정적 인덱스. `query-index.mjs trace`가 여기서 호출 경로를 뽑는다 |
| 읽음 | 프로젝트 소스 | logic-tracer가 인덱스 결과를 검증하거나, 인덱스가 없을 때 grep으로 직접 탐색 |
| 씀 | `_workspace/reports/trace_<slug>.md` | 추적 결과 리포트. slug는 `order_cancel`, `payment_confirm`처럼 대상의 안전한 파일명 |
| 갱신 가능 | `_workspace/index/` | stale 판정 시 증분 재인덱싱으로 갱신 |

리포트 형식 자체는 [logic-tracer](/agents/logic-tracer.md) 에이전트가 정한다. 사용자 설명서에 실린 출력 예시는 진입점 → Service → 외부 연동 → DB → 이벤트 순으로 번호를 붙여 보여준다.

## 예시

```text
사용자: 주문 취소 로직 전체 흐름 보여줘

Claude: 인덱스 신선도를 확인합니다. (build-index.mjs --check-stale → fresh)
        query-index.mjs trace --id OrderController.cancelOrder --depth 3 결과를 logic-tracer에 전달합니다.

        [logic-tracer 실행 후]

        주문 취소 처리 흐름

        ① 진입점
           POST /api/orders/{id}/cancel → OrderController.cancelOrder()
        ② Service
           → OrderService.cancel(orderId, reason)  @Transactional 시작
        ③ 외부 연동
           → PaymentService.refund()  ← PG사 환불 API 호출
        ④ DB
           UPDATE TBL_ORDER SET STATUS = 'CANCELLED'
           INSERT INTO TBL_ORDER_HISTORY
        ⑤ 이벤트
           → OrderCancelledEvent 발행

        리포트 위치는 _workspace/reports/trace_order_cancel.md 입니다.
        변경 계획이 있으면 analyze-impact로 영향도 확인을 권고합니다.
```

```text
사용자: /flow 로그인 처리

Claude: (/flow 별칭이 ax-navi:trace-logic으로 위임)
        인덱스가 stale입니다(exit 1). --mode incremental로 재인덱싱 후 진행할까요,
        아니면 stale 상태로 바로 추적할까요?

사용자: 바로 추적해

Claude: "인덱스가 stale일 수 있음"을 logic-tracer에 알리고 추적을 시작합니다.
```

## 원칙과 주의

- 이 스킬은 코드를 수정하지 않는다. 추적 결과를 보고 고치려면 [analyze-impact](/skills/analyze-impact.md)나 [safe-modify](/skills/safe-modify.md)로 이어간다.
- 결과 끝에는 항상 다음 단계를 권고한다. 변경 계획이 있으면 analyze-impact, 레거시 코드가 섞여 있으면 legacy-decoder, 특정 SQL이 궁금하면 review-sql이다.
- 인덱스는 코드에서 자동 추출한 결과라 동적 로딩·리플렉션·런타임 DI는 놓칠 수 있다. 중요한 판단 전에는 리포트에 적힌 파일과 라인을 직접 확인한다.
- stale 인덱스로 진행한 추적은 최근 변경을 반영하지 못할 수 있다. 정확도가 중요하면 재인덱싱을 먼저 한다. 갱신 방법은 [인덱스 갱신](/configuration/index-refresh.md)에 있다.
- 로컬 스킬 `.claude/skills/trace.md`는 harness-init의 writer가 프로젝트별로 작성한 것이라 스택 키워드와 트리거가 프로젝트마다 다르다. 전역 trace-logic과 겹쳐 보여도 둘은 별개 파일이다.

## 관련 문서

- [logic-tracer 에이전트](/agents/logic-tracer.md)
- [별칭 스킬 (/flow)](/skills/aliases.md)
- [결정적 인덱스](/concepts/deterministic-index.md)
- [튜토리얼: 신규 투입 첫날](/tutorials/onboarding-day1.md)
- [튜토리얼: 레거시 해독](/tutorials/legacy-decode.md)
