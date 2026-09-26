# cross-repo-scaffold

`pair-init`으로 연동된 저장소들에 기능을 동시 스캐폴딩하는 스킬이다. 백엔드 API 계약을 기준으로 클라이언트(들)의 서비스·컴포넌트·라우트를 정합하게 생성해 드리프트 없는 풀스택 기능을 만든다. 1:1(백엔드+프론트엔드 1개)과 1:N(백엔드+클라이언트 여러 개)을 모두 지원하며, 단일 저장소용 [scaffold-feature](/skills/scaffold-feature.md)와 달리 페어 연동이 전제 조건이다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 전체 스택 | "전체 스택 기능 만들어줘", "백엔드랑 프론트 같이 만들어줘", "API부터 화면까지 만들어줘" |
| 신규 기능 | "엔드투엔드 기능 추가", "백엔드 API 만들고 프론트 연동해줘" |
| 영어 | "full-stack feature", "cross-repo scaffold" |

슬래시 호출은 `/ax-navi:cross-repo-scaffold`이며 별칭은 없다. `/scaffold`는 단일 저장소용 scaffold-feature로 위임되므로 혼동하지 않는다. `pair-init`이 양쪽 `CLAUDE.md`에 넣어 주는 크로스 리포 워크플로우 표에도 "전체 스택 기능 만들어줘" → cross-repo-scaffold가 적혀 있어, 연동된 프로젝트 어디서 요청해도 이 스킬로 라우팅된다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 사전 조건 확인 | 어댑터 지원 수준, `pair_config.md`, 패턴 프로필, API 계약 확인 | `check-adapter-coverage.mjs`, `pattern_profile.py validate`, 계약 없으면 `api-bridge` extract | 1:N이면 포함할 클라이언트 체크리스트 |
| Phase 1 기능 명세 수집 | 기능명·엔드포인트·백엔드 범위·프론트 범위·유사 기능을 한 번에 질문 | 없음 | 5개 항목 입력 |
| Phase 2 사전 충돌 검사 | 계약의 동일 경로·메서드, 각 클라이언트의 동일 도메인 파일 검색 | 없음 | 충돌 시 덮어쓰기/다른 경로/함수 추가 선택 |
| Phase 3 백엔드 스캐폴딩 | scaffold-feature 지침으로 백엔드 레이어 생성 | `general-purpose` (scaffold-feature 지침, cross-repo 모드) | 없음 |
| Phase 4 API 계약 갱신 | 신규 엔드포인트만 계약에 append | `ax-navi:api-bridge` mode extract | 없음 |
| Phase 5 클라이언트 스캐폴딩 | 선택된 클라이언트 전부 병렬로 서비스 스텁·컴포넌트·라우트 생성 | `general-purpose` (api-bridge generate-stub 지침) | 없음 |
| Phase 6 통합 검사 | 저장소마다 패턴 적합성·실행 검증·안전성 판정, 클라이언트마다 계약 정합성 | `pattern-conformance`, 테스트·빌드·린트 명령, `change-safety`, `ax-navi:api-bridge` mode validate | 없음 |
| Phase 7 결과 보고 | 저장소별 생성 파일·판정·TODO와 전체 판정 | 없음 | TODO 채우기 |

Phase 0에서 `pair_config.md`가 없으면 "먼저 `pair-init`으로 연동하세요" 안내 후 중단한다. `## Partner:` 블록이 있으면 hub-roots(1:N), 없으면 paired-roots(1:1) flat 형식이다. 1:1이면 `frontend_targets`를 1개짜리 리스트로 통일해 이후 Phase가 1:N과 같은 코드 경로를 쓴다. 1:N에서 등록된 클라이언트가 2개 이상이면 매번 포함 대상을 묻고, 무응답이면 전체(all)로 처리한다.

Phase 0의 게이트 규칙은 세 가지다.

| 조건 | 판정 영향 |
|------|----------|
| 어느 저장소든 어댑터 PARTIAL | 유사 화면·설정 원문을 직접 읽어 확인한 뒤 생성(`READ`) |
| 어느 저장소든 어댑터 UNSUPPORTED | 해당 저장소와 전체 판정은 HOLD |
| 패턴 프로필 누락·검증 실패·스켈레톤 상태 | 묻지 않고 이웃 파일을 기준으로 진행(`기준: 이웃 파일`, pattern-extractor 재실행 권고). 이웃 파일까지 없는 저장소만 생성을 멈추고 HOLD |
| 지원 수준이 다른 저장소의 GO | 합쳐서 전체 GO로 올리지 않음 |

Phase 1의 입력 처리는 엔드포인트를 `POST /api/orders/{id}/cancel` 형식으로 정규화하고, `/api/orders/...`에서 `order` 도메인을 뽑아 파일명 접두사를 정한다. 백엔드 기본 범위는 Controller + Service + DAO/Repository + DTO + Test, 프론트 기본 범위는 Service 스텁 + Component + Route 등록이다.

Phase 5의 클라이언트 생성은 세 단계다. Step 1 서비스 스텁은 `api_contract.json`의 `models{}` 정의를 실제로 읽어 DTO 타입을 채우고, models에 없을 때만 `// TODO`로 남긴다. Step 2 컴포넌트는 서비스 함수를 호출하는 골격만 만들고 UI 구현은 TODO다. Step 3 라우트는 Vue Router·React Router·Next.js·모바일 스택별 관행에 맞춰 기존 파일을 덮어쓰지 않고 항목만 추가한다.

Phase 6의 전체 GO 조건은 모든 저장소의 대상 어댑터가 FULL 또는 READ(원문 확인), 패턴 CONFORM, 필수 검증 exit 0(또는 `검증 수단 없음` + 정적 대조, 위험 변경 아님), change-safety GO, 모든 클라이언트의 API 드리프트 0건일 때만이다. 그 외에는 가장 낮은 판정을 쓴다. 적용 가능하고 실행 가능한 검증 명령을 돌리지 않았으면 `UNVERIFIED`이며 최소 HOLD, 패턴 FAIL 또는 검증 명령 실패는 STOP이다. GO인 저장소는 analyzer incremental로 인덱스를 갱신한 뒤 `generate-wiki`를 실행한다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `_workspace/pair_config.md` | 백엔드·클라이언트 루트와 계약 경로 |
| 읽음 | `[backend_root]/_workspace/index/api_contract.json` | 충돌 검사와 스텁 생성의 기준 계약. 없으면 즉시 추출 |
| 읽음 | `.claude/patterns/pattern_profile.json`, `.claude/patterns/*.md` (각 저장소) | preferred 프로필과 실제 기준 파일 |
| 읽음 | `_workspace/01_analyzer_report.md` (각 저장소) | 스택·구조 파악 |
| 읽음 | `_workspace/wiki/architecture.md` (있을 때) | 기존 구조 훑기용 스냅샷. 계약·패턴은 라이브로 재확인 |
| 씀 | 백엔드 소스 (Controller·Service·DAO·DTO·Test), 설정·라우팅 등록 | Phase 3 |
| 씀 | 클라이언트 소스 (Service 스텁·Component·Route) | Phase 5 |
| 씀 | `[backend_root]/_workspace/index/api_contract.json` | 신규 엔드포인트 append |
| 씀 | `[backend_root]/_workspace/reports/cross_scaffold_backend.md` | 백엔드 생성 파일 목록 |
| 씀 | `[target.root]/_workspace/reports/cross_scaffold_frontend.md` | 클라이언트별 생성 파일 목록 |
| 갱신 | `_workspace/index/`, `_workspace/wiki/` (GO 저장소) | incremental 인덱스와 wiki 재생성 |

## 예시

```text
사용자: 주문 취소 기능 전체 스택으로 만들어줘

Claude: pair_config.md 확인 결과 hub-roots 형식입니다.
        등록된 클라이언트는 web-frontend, mobile-ios, admin-panel 입니다.
        이번 스캐폴딩에 포함할 클라이언트를 선택하세요 (쉼표로 구분, 전체는 "all").

사용자: web-frontend, admin-panel

Claude: 어댑터 지원 수준 FULL, 패턴 프로필 검증 통과, api_contract.json 로드 완료.
        전체 스택 기능 스캐폴딩 정보를 입력해주세요.
        1. 기능명  2. API 엔드포인트  3. 백엔드 생성 범위  4. 프론트엔드 생성 범위  5. 유사 기존 기능(선택)

사용자: 주문 취소 / post /api/orders/{id}/cancel / 전체 / 전체 / 주문 환불처럼

Claude: 엔드포인트를 POST /api/orders/{id}/cancel 로 정규화했습니다. 도메인은 order 입니다.
        충돌 검사 결과 계약에 동일 엔드포인트가 없고 두 클라이언트 모두 OrderCancel 파일이 없습니다.

        [Phase 3~6 실행]

        전체 스택 스캐폴딩 완료: 주문 취소
        백엔드는 Controller·Service·Mapper·DTO·Test 5개 파일을 생성했고 패턴 CONFORM, 테스트 exit 0, 안전성 GO 입니다.
        web-frontend 는 orderService.ts 에 cancelOrder() 를 추가하고 OrderCancelModal.vue 와 라우트를 등록했습니다. 정합성 ✓.
        admin-panel 도 동일하게 생성했고 정합성 ✓ 입니다.
        api_contract.json 에 POST /api/orders/{id}/cancel 을 추가했습니다.
        TODO는 Service 비즈니스 로직, Mapper 실제 쿼리, 두 클라이언트의 UI 구현입니다.
        전체 판정은 GO 입니다.
```

```text
사용자: 전체 스택 기능 만들어줘

Claude: _workspace/pair_config.md 가 없습니다. 먼저 pair-init 으로 연동하세요.
        이 프로젝트 하나만 만들려면 scaffold-feature 를 쓰면 됩니다.
```

## 원칙과 주의

- 계약 우선이다. 프론트엔드 스텁은 항상 백엔드 `api_contract.json` 기준으로 생성하며 계약 없이 추측으로 URL·메서드를 정하지 않는다.
- TODO를 정직하게 표기한다. 자동 생성된 비즈니스 로직·UI는 `// TODO`로 명시하고 가짜 구현으로 채우지 않는다.
- 충돌은 자동으로 회피한다. 기존 파일·메서드와 충돌하면 덮어쓰지 않고 사용자에게 확인한다.
- 일부 클라이언트가 실패해도 나머지는 계속 진행하고 실패 목록을 Phase 7 보고에 명시한다.
- `architecture.md`는 생성 시점 스냅샷이다. 구조 파악에는 참고하되 실제 계약·패턴은 반드시 라이브로 다시 확인한다.
- 이 스킬은 파일만 준비한다. 각 저장소의 commit·PR은 사용자가 따로 진행한다.

## 관련 문서

- [pair-init](/skills/pair-init.md)
- [cross-repo-modify](/skills/cross-repo-modify.md)
- [api-bridge 에이전트](/agents/api-bridge.md)
- [게이트와 판정](/concepts/gates.md)
- [튜토리얼: 크로스 리포 기능](/tutorials/cross-repo-feature.md)
