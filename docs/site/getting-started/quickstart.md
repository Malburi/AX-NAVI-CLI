# 10분 빠른 시작

플러그인 설치가 끝났다면 이 페이지 하나로 첫 하네스를 만들고 첫 작업 세 개까지 끝낼 수 있습니다. 프로젝트 루트에서 한 문장을 입력하고, 질문 두 개에 답하고, 완료 보고를 확인한 뒤 `/find`·`/flow`·`/impact`로 코드를 바로 탐색하는 흐름입니다. 각 단계의 내부 동작은 [첫 초기화 상세](/getting-started/first-harness.md)에서 다룹니다.

## 0단계 — 준비 (1분)

[설치](/getting-started/install.md)가 끝났는지 `/plugin list`에서 `ax-navi@ax-navi — enabled`를 확인합니다. 그다음 분석할 프로젝트의 루트 폴더에서 Claude Code를 엽니다.

```bash
cd /your/project/root
claude
```

프로젝트 루트란 `pom.xml`·`package.json`·`.git`처럼 저장소 최상위 파일이 있는 폴더입니다. 하위 모듈 폴더에서 시작하면 그 폴더만 분석 대상이 됩니다.

## 1단계 — 하네스 초기화 요청

아래 문장 중 하나를 입력합니다. 모두 `harness-init` 스킬의 트리거 문구입니다.

```text
"하네스 초기화해줘"
"하네스 만들어줘"
"이 프로젝트 Claude 설정해줘"
"프로젝트 분석해서 설정해줘"
"create harness"
```

키워드를 덧붙이면 질문을 줄일 수 있습니다. "빠르게 하네스 초기화해줘"는 Standard Tier로 바로 확정하고, "심층 분석으로 하네스 초기화해줘"는 Full로 확정합니다. 기본값은 Full입니다.

## 2단계 — 질문 두 개에 답하기

초기화 중 사용자에게 묻는 것은 최대 두 가지입니다.

첫 번째는 **프로젝트 구성**입니다. 현재 작업 폴더의 절대경로가 먼저 표시된 뒤 선택지가 나옵니다.

```text
현재 작업 폴더: D:\work\order-service

초기화 구성을 선택해 주세요.
  1. 단일 프로젝트로 초기화 (Recommended)
  2. 서버·클라이언트 함께 초기화 (모노레포)
  3. 서버·클라이언트 각각 초기화 후 연결 (1:1)
  4. 기타 (부분 범위 / 허브형 1:N)
```

대부분의 경우 `1`을 고르면 됩니다. `4`를 고르면 "특정 폴더·모듈만 초기화"와 "허브형(백엔드 1개 + 클라이언트 여러 개)"을 다시 고르는 2차 질문이 이어집니다. 요청문에 구성과 경로를 이미 적었으면 이 질문은 생략됩니다.

두 번째는 **Tier 확인**입니다. 이 질문은 인덱싱이 끝난 뒤에 나옵니다. 인덱싱은 LLM을 쓰지 않고 수십 초 안에 끝나며, 그 결과로 프로젝트 규모와 예상 토큰이 확정되기 때문입니다.

```text
인덱싱 완료 — 소스 1,240개 파일, 심볼 8,912개. (여기까지 LLM 사용 없음)

이제 LLM 분석 구간입니다. 예상 규모:
  Tier Full 기준 · 약 14분 · 약 165,000 토큰
  판정이 필요한 미해결 관계: 46건

  1. Full 로 진행      — 심층 분석 (마이그레이션·대규모 수정 계획이 있으면 권장)
  2. Standard 로 진행  — 위 견적의 약 60% (일상 유지보수에는 대개 충분)
  3. 여기서 중단        — 인덱스만 두고 나중에 이어서 (인덱스는 그대로 남습니다)
```

| 답변 | 결과 |
|------|------|
| `1` 또는 무응답 | Full로 진행 |
| `2` | Standard로 진행 |
| `3` | 여기서 중단. 인덱스는 남아 있어 `analyze-impact`·`trace-logic`은 이미 동작합니다 |

"빠르게"·"심층" 같은 키워드로 Tier를 이미 정했다면 견적만 표시되고 질문은 나오지 않습니다. 여기가 비용을 알고 결정할 수 있는 유일한 지점이며, 이 뒤로는 LLM 구간이라 되돌릴 수 없습니다.

## 3단계 — 완료 확인

분석·생성·검증·품질 평가가 끝나면 다음과 같은 보고가 나옵니다. 소요 시간은 Standard 3~5분, Full 10분 내외이며 프로젝트 크기에 따라 달라집니다.

```text
하네스 초기화 완료 (AX Navi v1) [Tier: Full]

생성된 파일:
[Core]
- CLAUDE.md
- .claude/ito-guide.md               (사용 설명서)
- .claude/skills/trace.md, scaffolder.md, find-logic.md
- .claude/agents/domain-expert.md
- .claude/patterns/controller_pattern.md, service_pattern.md, dao_pattern.md

[Indexes (NEW)]
- _workspace/index/call_graph.json (노드: 8,912, 엣지: 21,004)
- _workspace/index/symbols.json
- ...

Eval 품질 점수 (harness-evaluator):
점수: 87/100 — PASS
- 커버리지: 22/25 | 정확도: 23/25 | 실행가능성: 21/25 | 컨텍스트 품질: 21/25
```

보고 직후 선택 작업 메뉴(wiki 생성·경계 QA)가 한 번 나옵니다. 처음이라면 "지금 안 함"을 고르세요. 초기화 직후에는 대화 컨텍스트가 커져 있어 같은 작업을 새 세션에서 "위키 만들어줘"로 따로 돌리는 편이 더 저렴합니다.

Eval 점수가 80점 미만이면 낮은 차원만 골라 자동으로 1회 재생성합니다. 사용자가 할 일은 없습니다.

## 4단계 — 첫 작업 세 개

하네스가 생기면 자연어 요청과 단축 별칭 둘 다 쓸 수 있습니다. 별칭은 절차를 새로 정의하지 않고 본편 스킬로 그대로 위임합니다.

### `/find` — 코드 위치 찾기

`find-feature` 스킬로 위임됩니다. "결제 관련 파일 어디 있어?", "쿠폰 관련 코드 찾아줘" 같은 자연어도 같은 스킬을 부릅니다.

```text
사용자: /find 결제 승인 처리

Claude: "결제 승인" 관련 코드 위치

Controller:
  - PaymentController.java (line 45, 89)
Service:
  - PaymentService.java (approve, cancelApproval)
SQL:
  - PaymentMapper.xml (쿼리 ID: insertPayment, updatePaymentStatus)
외부 연동:
  - PgGateway.java ← PG사 승인 API 호출
```

### `/flow` — 처리 흐름 따라가기

`trace-logic` 스킬로 위임됩니다. 별칭이 `/trace`가 아닌 이유는 하네스가 프로젝트마다 로컬 `trace` 스킬을 배포하기 때문입니다. "주문 취소 로직 어디 있어?", "이 API 어떻게 처리돼?"도 같은 스킬입니다.

```text
사용자: /flow 주문 취소

Claude: 주문 취소 처리 흐름

① 진입점   POST /api/orders/{id}/cancel → OrderController.cancelOrder()
② Service  OrderService.cancel() — @Transactional 시작, 상태 검증
③ 외부 연동 PaymentService.refund() ← PG 환불, InventoryService.restore()
④ DB       UPDATE TBL_ORDER SET STATUS='CANCELLED' / INSERT TBL_ORDER_HISTORY
⑤ 이벤트   OrderCancelledEvent → NotificationService (비동기)
```

### `/impact` — 수정 전 영향 범위 보기

`analyze-impact` 스킬로 위임됩니다. 읽기 전용이라 코드를 바꾸지 않습니다. "이거 수정하면 어디 영향?", "이 컬럼 추가했을 때 영향"도 같은 스킬입니다.

```text
사용자: /impact OrderService.cancel

Claude: 영향도 분석 결과 — OrderService.cancel
위험도: MEDIUM (6/10)

직접 영향 (3건): OrderController.cancelOrder, BatchOrderService.cancelExpired, OrderEventListener.onCancel
간접 영향 (5건): 재고 반환, 결제 취소 연동, 알림 발송, 주문 이력, 쿠폰 복원
영향받는 테스트: OrderServiceTest.testCancel, BatchOrderServiceTest.testCancelExpired
외부 시스템: PG사 결제 취소 API 포함 → 운영 테스트 필요
```

세 스킬은 모두 실행 전에 인덱스 신선도(`--check-stale`)를 확인하고, 소스가 바뀌었으면 증분 재인덱싱 후 진행합니다.

## 5단계 — 팀과 공유

생성된 하네스 파일을 커밋하면 팀원은 초기화를 다시 하지 않아도 됩니다. 팀원이 pull한 뒤 "하네스 초기화해줘"를 입력하면 LLM 파이프라인 없이 인덱스만 로컬에서 다시 만듭니다.

```bash
git add CLAUDE.md .claude/
git commit -m "docs: add project harness"
```

`_workspace/`는 런타임 산출물이라 `.gitignore`에 넣는 것이 일반적이지만, `_workspace/index/_ai_patch.json`은 LLM 분석 결과이므로 함께 버려지지 않도록 주의하세요. 자세한 커밋 정책은 [모범 사례](/getting-started/best-practices.md)에 있습니다.

## 다음 단계

- 실제로 코드를 고칠 때는 `/modify` 또는 "이 변경 안전하게 적용해줘"로 [safe-modify](/skills/safe-modify.md)를 사용하세요.
- 새 기능은 `/scaffold` 또는 "컨벤션 따라 만들어줘"로 [scaffold-feature](/skills/scaffold-feature.md)가 전 레이어 골격을 만듭니다.
- 초기화 직후 생성된 `.claude/ito-guide.md`에는 이 프로젝트에 맞는 트리거 예시와 시나리오가 들어 있습니다. "ito-guide 보여줘"로 열어 보세요.

## 관련 문서

- [설치](/getting-started/install.md)
- [첫 초기화 상세](/getting-started/first-harness.md)
- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [투입 첫날 튜토리얼](/tutorials/onboarding-day1.md)
- [단축 별칭](/skills/aliases.md)
