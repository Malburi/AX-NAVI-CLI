# vibe

영향도·안전성 에이전트 게이트는 생략하되 기존 프로젝트 패턴과 최소 실행 검증은 유지하는 빠른 작업 모드다. 버튼 라벨 변경이나 로그 한 줄 추가처럼 사소한 요청에 매번 영향 분석과 독립 리뷰 에이전트를 태우는 낭비를 줄이려는 경로이며, 사용자가 "알아서/그냥/바이브"라고 명시적으로 말했을 때만 탄다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "알아서 해줘", "그냥 해줘", "바이브로", "바이브 코딩", "빠르게 그냥 고쳐" |
| 영어 | "vibe" |
| 슬래시 호출 | `/ax-navi:vibe` |
| 자동 트리거 | 없다. 범용 수정/개발 요청("고쳐줘", "개발해줘")은 [safe-modify](/skills/safe-modify.md) / [scaffold-feature](/skills/scaffold-feature.md)가 기본 경로이고, vibe는 명시적 opt-out 문구 전용이다. |

별칭은 없다. 생략 범위가 암묵적으로 넓어지지 않도록 명시적 문구 전용 스킬로 분리되어 있다.

## 실행 흐름

vibe는 Phase가 나뉜 오케스트레이터가 아니라 6개 규칙을 순서대로 적용하는 단일 흐름이다.

| 순서 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| 1 | 외과적 변경 원칙으로 요청된 부분만 건드린다. | 없음 | 없음 |
| 2 | 변경 대상 경로가 정해지면 `pattern_profile.py validate`와 `select`를 실행하고 선택된 실제 `reference_files`를 읽는다. 기존 파일의 국소 수정은 그 파일 자체의 스타일도 함께 유지한다. | `pattern_profile.py validate/select` | 없음 |
| 3 | 신규 파일인데 검증된 preferred 프로필·실제 기준 파일이 없으면 추측 생성하지 않고 `scaffold-feature`로 승격한다. | — | 승격 안내를 받는다. |
| 4 | 변경 범위에 해당하는 가장 작은 테스트·빌드·린트 명령을 실제 실행한다. `detect`로 명령을 확보하고 가장 작은 것을 `run`으로 돌린 뒤 `overall`과 `fail_lines`만 확인한다. | `verify-target.mjs detect/run` | 없음 |
| 5 | 소스·API·DB 구조가 바뀌면 결정론적 인덱스와 wiki를 갱신한다. | `build-index.mjs`, [generate-wiki](/skills/generate-wiki.md) | 없음 |
| 6 | 완료 후 변경 파일, 적용한 기준 프로필·파일, 검증 명령과 exit code를 간단히 보고한다. | 없음 | 없음 |

생략되는 것은 [analyze-impact](/skills/analyze-impact.md) / [pattern-conformance](/agents/pattern-conformance.md) / [change-safety](/agents/change-safety.md) 에이전트 게이트다. 생략되지 않는 것은 패턴 선택과 실행 검증이다.

### 승격 조건

아래에 해당하면 바로 진행하지 않는다. 기존 코드 변경은 safe-modify, 신규 파일·기능은 scaffold-feature로 승격한다.

| 조건 | 승격 대상 |
|------|-----------|
| DB 스키마 변경 (DDL, 컬럼 추가/삭제) | safe-modify |
| 외부 API 계약 변경 (요청/응답 필드, 엔드포인트) | safe-modify |
| 트랜잭션 경계 변경 | safe-modify |
| 3개 이상 파일에 걸친 수정 | safe-modify |
| 구조화 패턴이 없거나 대상 모듈과 일치하는 preferred 프로필이 없음 | 기존 파일이면 safe-modify, 신규 파일이면 scaffold-feature |

작업 도중 승격 조건이 드러나면(예: 2개 파일을 이미 고친 뒤 3번째 파일이 필요해짐, 수정 중 트랜잭션 경계 변경임을 발견) 그 자리에서 멈추고 승격한다. 이미 적용한 변경은 되돌리지 않되, 승격된 스킬의 사전 영향 분석(safe-modify Phase 1) 대상에 포함시켜 함께 재검증한다.

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `.claude/patterns/pattern_profile.json` | 대상 모듈·레이어의 preferred 프로필 |
| 읽는 파일 | 선택된 `reference_files` | 실제 기준 코드 |
| 읽는 파일 | 변경 대상 소스 파일 | 국소 수정 대상과 그 파일의 스타일 |
| 쓰는 파일 | 변경 대상 소스 파일 | 요청 범위 안에서만 |
| 쓰는 파일 | `_workspace/reports/pattern_selection.json` | `pattern_profile.py select` 결과 |
| 쓰는 파일 | `_workspace/index/*.json`, `_workspace/wiki/` | 소스·API·DB 구조가 바뀐 경우만 갱신 |

`impact_<slug>.md`, `pattern_conformance_<slug>.md`, `safety_<slug>.md`는 만들지 않는다. 그 리포트가 필요하면 vibe가 아니라 safe-modify를 쓴다.

## 예시

```text
사용자: 알아서 해줘 — 주문 목록 화면의 "취소" 버튼 라벨을 "주문 취소"로 바꿔

하네스: pattern_profile.py validate → PASS. select → order/view preferred 프로필, 기준 파일 OrderListView.vue.
        변경: src/views/order/OrderListView.vue 1개 파일, 문자열 1곳.
        검증: verify-target detect → npm run lint (가장 작은 명령) → run → overall: pass, exit 0.
        인덱스·wiki: 소스 구조 변화 없음 — 갱신 생략.

        완료.
        - 변경 파일: src/views/order/OrderListView.vue
        - 적용 기준: order/view preferred, OrderListView.vue 자체 스타일 유지
        - 검증: npm run lint → exit 0
```

작업 도중 승격되는 경우다.

```text
사용자: 그냥 해줘, 주문 취소 시 쿠폰도 복원되게

하네스: OrderService.java, CouponService.java 수정 완료.
        3번째 파일 OrderCancelTxHandler.java가 필요하고 @Transactional 경계가 바뀝니다.
        여기까지 2개 파일을 수정했고, 승격 조건(3개 이상 파일 + 트랜잭션 경계 변경)이 확인되어
        safe-modify로 전환해 지금까지 변경분까지 검증하겠습니다.
        → safe-modify Phase 1 사전 영향 분석 대상: OrderService.java, CouponService.java, OrderCancelTxHandler.java
```

## 원칙과 주의

- **외과적 변경 원칙 유지.** 요청된 부분만 건드리고 인접 코드·주석·포맷 "개선"은 금지다.
- **빠른 모드여도 컨벤션과 wiki 최신성은 버리지 않는다.** 패턴 선택과 기준 파일 읽기, 인덱스·wiki 갱신은 유지된다.
- **실패하거나 실행하지 못하면 성공으로 보고하지 않는다.** 감지 `count: 0`도 포함이다.
- **신규 파일에 근거가 없으면 추측 생성하지 않는다.** scaffold-feature로 승격한다.
- **승격 시 이미 적용한 변경은 되돌리지 않는다.** 대신 승격된 스킬의 사전 영향 분석 대상에 포함시켜 함께 재검증하고, 사용자에게 "여기까지 N개 파일을 수정했고, 승격 조건([조건])이 확인되어 [safe-modify/scaffold-feature]로 전환해 지금까지 변경분까지 검증하겠습니다"를 알린 뒤 진행한다.
- **기본 경로는 게이트 경로다.** 이 스킬은 사용자가 명시적으로 "알아서/그냥/바이브"라고 말할 때만 탄다. 스킬 트리거는 LLM 판단 기반 확률 매칭이므로 확정 경로가 필요하면 `/ax-navi:vibe`를 직접 호출한다.

## 관련 문서

- [safe-modify](/skills/safe-modify.md)
- [scaffold-feature](/skills/scaffold-feature.md)
- [게이트](/concepts/gates.md)
- [패턴 프로필](/concepts/pattern-profiles.md)
- [트리거 레퍼런스](/reference/triggers.md)
