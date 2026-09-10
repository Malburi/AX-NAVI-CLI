# cross-repo-modify

`pair-init`으로 연동된 저장소들 중 한쪽에서 시작한 기존 기능 개선·수정이 API 계약에 영향을 줄 때, 파트너(들) 저장소까지 함께 안전하게 반영하는 스킬이다. 신규 기능을 만드는 [cross-repo-scaffold](/skills/cross-repo-scaffold.md)와 달리 이미 존재하는 기능의 변경을 다룬다. 구조는 [safe-modify](/skills/safe-modify.md)의 사전 영향 분석 → 적용 → 사후 안전성 흐름을 그대로 따르되, 각 단계에 파트너 저장소 분기를 얹은 것이다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 개선·수정 | "이 기능 개선해줘", "API 필드 추가해줘" |
| 양쪽 반영 | "이거 고쳐야 하는데 프론트도 같이", "양쪽 다 수정해줘", "백엔드 프론트 둘 다 고쳐줘" |
| 조건부 반영 | "이 API 바꾸는데 프론트 영향 있으면 같이 처리해줘" |
| 영어 | "cross-repo modify", "풀스택 수정" |

슬래시 호출은 `/ax-navi:cross-repo-modify`이며 별칭은 없다. `/modify`는 단일 저장소용 safe-modify로 위임된다. `pair-init`이 `CLAUDE.md`에 넣어 주는 워크플로우 표에는 "이 기능 개선해줘 (프론트도 같이)" → cross-repo-modify가 적혀 있다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 사전 조건 확인 | 어댑터 지원 수준, `pair_config.md`, 운영 모드 키워드, 패턴 프로필 확인 | `check-adapter-coverage.mjs`, `pattern_profile.py validate` | hub에서 시작하고 클라이언트가 2개 이상이면 확인 후보 체크리스트 |
| Phase 1 시작 측 영향 분석 | 변경 대상 정규화와 영향 리포트, 파트너 노출 대상 여부 판별 | `impact-analyzer` | 없음 |
| Phase 2 파트너 영향 확인 | 대상마다 파트너 호출 위치·영향 컴포넌트 확인 (병렬) | `ax-navi:api-bridge` mode check-impact | 없음 |
| Phase 3 파트너 반영 확인 게이트 | 영향받는 파트너 파일을 나열하고 반영 범위를 확인 | 없음 | 1 전부 반영 / 2 일부만 / 3 이 프로젝트만 / 4 중단 |
| Phase 4 시작 측 변경 적용 | preferred 프로필 선택 후 변경 적용, 계약 형태가 바뀌면 계약 갱신 | `pattern_profile.py select`, `api-bridge` extract | 직접 작성 또는 자연어 설명 |
| Phase 5 파트너 측 변경 적용 | 남은 대상 전부 병렬로 safe-modify Phase 2 지침만 수행 | `general-purpose` | 없음 |
| Phase 6 통합 평가·드리프트 재검증 | 저장소마다 패턴 적합성·실행 검증·안전성, 파트너마다 드리프트 재검증 | `pattern-conformance`, 테스트·빌드·린트 명령, `ax-navi:change-safety`, `ax-navi:api-bridge` mode validate | 없음 |
| Phase 7 결과 보고 | 저장소별 변경 파일·판정·TODO와 전체 결정 | 없음 | HOLD/STOP이면 보완 |

Phase 0에서 `pair_config.md`가 없으면 "파트너 연동이 없습니다. 이 프로젝트만 수정하려면 `safe-modify`를 사용하세요. 양쪽 연동은 `pair-init`으로 먼저 설정하세요" 안내 후 중단한다. 1:N에서는 현재 프로젝트가 hub인지 클라이언트인지에 따라 동작이 다르다.

| 현재 프로젝트 | 동작 |
|------|------|
| hub(backend) 쪽에서 시작 | 클라이언트가 2개 이상이면 확인 후보를 체크리스트로 묻는다. 실제 반영 여부는 Phase 2·3에서 다시 결정 |
| 클라이언트 쪽에서 시작 | 클라이언트의 `pair_config.md`는 항상 1:1 flat 형식이므로 1:1과 동일 처리 |

운영 모드 키워드는 safe-modify Phase 0과 같은 표(`production`/`hotfix`/`legacy`/`customer_facing`/`normal`)를 쓰고, 이후 양쪽 change-safety 호출에 같은 mode를 전달한다.

단독 진행으로 갈라지는 지점이 두 곳 있다. Phase 1에서 변경 대상이 순수 내부 로직(프론트 전용 UI 스타일, 백엔드 전용 배치 잡 등)이면 Phase 2·3·5를 건너뛰고 Phase 4로 직행한다. Phase 2에서 영향 있는 대상이 하나도 없으면(전부 호출 위치 0건) 단독 진행을 안내하고 Phase 4로 간다. 영향 없는 대상은 `modify_targets`에서 제외된다.

Phase 3 게이트의 규칙은 다음과 같다.

| 상황 | 동작 |
|------|------|
| 옵션 1·2 선택 | 파트너 파일을 수정하되 어느 저장소든 git commit은 자동 실행하지 않음 |
| 옵션 2 선택 | 선택되지 않은 대상은 이후 Phase에서 제외 |
| Phase 1 impact가 CRITICAL | 옵션 1·2 선택 시 "운영 영향도가 높습니다. 정말 진행할까요?" 재확인 |
| 무응답·다른 주제 전환·비대화형 호출 | 4 중단과 동일 처리. 파트너 저장소 미반영이 기본값 |

Phase 6의 전체 GO 조건은 모든 대상 어댑터가 FULL, 패턴 CONFORM, 필수 검증 exit 0, change-safety GO, API 드리프트 0건일 때만이다. 미실행(`UNVERIFIED`)은 최소 HOLD, 패턴 FAIL 또는 필수 명령 실패는 STOP이다. GO인 각 저장소는 analyzer incremental로 인덱스를 갱신한 후 `generate-wiki`를 실행한다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `_workspace/pair_config.md` | 파트너 루트와 계약 경로 |
| 읽음 | `[backend_root]/_workspace/index/api_contract.json` | 파트너 변경의 기준 계약 |
| 읽음 | `.claude/patterns/pattern_profile.json` (각 저장소) | preferred 프로필과 실제 기준 파일 |
| 읽음 | `_workspace/wiki/architecture.md` (있을 때) | 전체 구조 훑기용 스냅샷. 영향 분석은 라이브로 |
| 씀 | `_workspace/reports/impact_<slug>.md` | Phase 1 영향 리포트 (시작 측) |
| 씀 | 시작 측 소스 | Phase 4 변경 |
| 씀 | `[backend_root]/_workspace/index/api_contract.json` | 계약 형태가 바뀌면 신규 필드만 append |
| 씀 | 파트너 소스 | Phase 5 변경 (옵션 1·2 선택 시) |
| 씀 | `[target.root]/_workspace/reports/cross_modify_partner.md` | 파트너별 변경 파일과 TODO |
| 씀 | `_workspace/reports/pattern_conformance_<slug>.md`, `safety_<slug>.md` (각 저장소) | Phase 6 판정 |
| 갱신 | `_workspace/index/`, `_workspace/wiki/` (GO 저장소) | incremental 인덱스와 wiki 재생성 |

## 예시

```text
사용자: 주문 조회 API 응답에 cancelReason 필드 추가해줘. 프론트 영향 있으면 같이 처리해줘

Claude: pair_config.md 는 1:1 flat 형식입니다. 파트너는 frontend (C:\work\order-web) 입니다.
        운영 모드는 normal 로 감지했습니다. 패턴 프로필 검증 통과.
        impact-analyzer 결과 GET /api/orders/{id} 응답 DTO 변경으로 파트너 노출 대상입니다.
        api-bridge check-impact 결과 프론트에서 호출 위치 3곳이 확인됐습니다.

        이 변경은 아래 파트너 프로젝트에도 영향을 줍니다.
        frontend (C:\work\order-web) — 영향받는 파일/함수 3개
          - src/services/orderService.ts:41 — getOrder()
          - src/types/order.ts:12 — OrderDetail
          - src/views/OrderDetailPage.vue:88 — renderStatus()
        1. 전부 반영  2. 일부만 반영  3. 이 프로젝트만 수정  4. 중단

사용자: 1

Claude: 백엔드 OrderDetailResponse 에 cancelReason 을 추가하고 api_contract.json 을 갱신했습니다.
        프론트엔드 OrderDetail 타입과 getOrder() 를 계약 기준으로 수정했습니다. UI 표시는 // TODO 로 남겼습니다.

        크로스 리포 수정 완료: GET /api/orders/{id} 응답 필드 추가
        backend 는 패턴 CONFORM, 테스트 exit 0, 안전성 GO (8/10) 입니다.
        frontend 는 패턴 CONFORM, 빌드 exit 0, 안전성 GO (8/10), 드리프트 재검증 ✓ 일치입니다.
        결정은 GO 입니다. 각 저장소는 별도 커밋이 필요하며 이 스킬은 파일만 준비했습니다.
```

```text
사용자: 이 기능 개선해줘 — 주문 목록 화면 정렬 버튼 스타일

Claude: impact-analyzer 결과 프론트 전용 UI 스타일 변경으로 파트너 계약과 무관합니다.
        파트너 영향 없음으로 판단해 safe-modify 와 동일하게 단독 진행합니다.
```

## 원칙과 주의

- 파트너 저장소는 남의 저장소다. Phase 3 확인 없이 파트너 파일을 고치지 않고, 커밋도 절대 자동으로 하지 않는다. 별도 git·배포·리뷰 프로세스를 우회하지 않기 위해서다.
- 계약 우선, 추측 금지다. 파트너 측 변경은 항상 `api_contract.json` 갱신 이후, 갱신된 계약 기준으로 생성한다.
- 단독 실행 경로가 있다. 파트너 영향이 없거나 사용자가 "이 프로젝트만"을 선택하면 사실상 safe-modify와 동일하게 동작한다. 이 스킬은 safe-modify를 대체하는 것이 아니라 그 위에 파트너 분기를 얹은 것이다.
- `pair_config.md` 없이는 실행되지 않는다. cross-repo-scaffold와 같은 전제 조건이다.
- 일부 파트너가 실패해도 나머지는 계속 진행하고 실패 목록을 Phase 7에 명시한다.
- 결정은 전체 대상 중 가장 낮은 등급 기준이다. 한 저장소가 HOLD면 전체가 HOLD다.

## 관련 문서

- [safe-modify](/skills/safe-modify.md)
- [pair-init](/skills/pair-init.md)
- [api-bridge 에이전트](/agents/api-bridge.md)
- [change-safety 에이전트](/agents/change-safety.md)
- [게이트와 판정](/concepts/gates.md)
