# 백엔드·프론트엔드 분리 저장소

백엔드(Spring Boot)와 프론트엔드(Vue)가 별도 저장소다. 두 저장소를 하네스 수준에서 연동하고, 주문 취소 기능을 API부터 화면까지 한 번에 만들고, 이후 API 필드를 바꿀 때 양쪽을 함께 고치는 흐름이다. 파트너 저장소의 파일은 만들어 주지만 커밋은 절대 자동으로 하지 않는다는 점이 핵심이다.

- **소요 시간** — 연동 10분(파트너 하네스가 없으면 그 초기화 시간 추가), 풀스택 스캐폴딩 15~20분, 크로스 수정 15~30분.
- **전제** — 두 저장소가 로컬에 clone돼 있다. 최소 현재 저장소에 하네스가 있다. 1:N(백엔드+웹+모바일+관리자)도 같은 스킬이 지원한다.
- **이 튜토리얼이 다루는 스킬·에이전트** — `pair-init`, `cross-repo-scaffold`, `cross-repo-modify`, `api-bridge`.

## 준비

가장 간단한 길은 `harness-init` Phase -1에서 "서버·클라이언트 각각 초기화 후 연결 (1:1)"을 고르는 것이다. 양쪽 하네스가 대칭 레인으로 만들어지고 `pair-init`이 자동으로 이어진다. 이 튜토리얼은 이미 하네스가 있는 저장소에서 `pair-init`을 직접 부르는 경로를 다룬다.

파트너 저장소의 절대 경로와 로컬 개발 기준 API base URL(예: `http://localhost:8080`)을 준비한다.

## 단계별 진행

### 1. pair-init으로 연동

백엔드 저장소에서 시작한다.

```text
백엔드 프론트엔드 연결해줘
```

`pair-init`이 Phase 0에서 `CLAUDE.md`와 `.claude/`를 확인하고(없으면 harness-init 안내 후 중단), "몇 개 프로젝트를 연동하나요? (1 = 1:1, 2개 이상 = 1:N)"를 묻는다. 1:1이면 Phase 1-A에서 한 번에 묻는다.

```text
1. 현재 프로젝트 역할: backend
2. 파트너 프로젝트 절대 경로: C:\work\order-frontend
3. API base URL: http://localhost:8080
4. (선택) 파트너 스택: Vue 3
```

파트너에 `CLAUDE.md`가 없으면 세 가지 중 고른다. "1. 자동으로 파트너 하네스 생성 (권장)"은 subagent가 파트너 루트에서 harness-init을 Full로 대신 실행한다. "2. 하네스 없이 진행"은 계약 추출만 하고 드리프트 검증을 건너뛴다.

이후 자동으로 진행되는 것은 다음과 같다.

| Phase | 하는 일 | 산출물 |
|---|---|---|
| 2-A | 양쪽에 `_workspace/pair_config.md` 생성(역방향 포함) | `partner_root`·`api_base_url`·`partner_api_contract` 등 |
| 3 | `api-bridge extract`로 백엔드 API 계약 추출 | `[백엔드]/_workspace/index/api_contract.json` |
| 4-A | 파트너 하네스가 있으면 `api-bridge validate`로 드리프트 검증 | `[프론트엔드]/_workspace/reports/api_drift_report.md` |
| 5-A | 양쪽 `CLAUDE.md`에 "## 파트너 프로젝트" 절과 크로스 리포 워크플로우 표 추가 | |

Phase 6 보고에서 엔드포인트 수와 드리프트 건수(MISSING/MISMATCH/UNUSED)를 확인한다. HIGH 드리프트는 "즉시 수정 권장"으로 표시된다.

### 2. 풀스택 기능 스캐폴딩

연동 뒤에는 어느 저장소에서든 부를 수 있다.

```text
주문 취소 기능 전체 만들어줘
```

`cross-repo-scaffold`가 Phase 0에서 백엔드와 클라이언트 모두에 대해 어댑터 커버리지·`pattern_profile.py validate`·API 계약 로드를 확인한다. 어느 한쪽이라도 PARTIAL/UNSUPPORTED이거나 패턴이 미추출이면 그 저장소의 판정은 최소 HOLD이고 전체 GO로 올라가지 않는다. 1:N에서 클라이언트가 2개 이상이면 포함할 클라이언트를 체크리스트로 묻는다.

Phase 1에서 한 번에 묻는다.

```text
1. 기능명: 주문 취소
2. API 엔드포인트: POST /api/orders/{id}/cancel
3. 백엔드 생성 범위: [전체] Controller + Service + DAO/Repository + DTO + Test
4. 프론트엔드 생성 범위: [전체] Service 스텁 + Component + Route 등록
5. 유사 기존 기능 (선택): 주문 환불처럼
```

이후 순서는 다음과 같다.

1. Phase 2 충돌 검사 — `api_contract.json`에 같은 경로·메서드가 있으면 덮어쓸지 다른 경로를 쓸지 묻고, 클라이언트마다 같은 도메인 서비스 파일·컴포넌트명을 검색한다.
2. Phase 3 백엔드 — `scaffold-feature` 지침으로 레이어 생성, 결과는 `[백엔드]/_workspace/reports/cross_scaffold_backend.md`.
3. Phase 4 계약 갱신 — `api-bridge extract`가 신규 엔드포인트만 `api_contract.json`에 append.
4. Phase 5 클라이언트 — `api-bridge generate-stub` 지침으로 서비스 스텁(계약의 `models{}`를 읽어 타입을 채움), 컴포넌트, 라우트 등록. 결과는 `[클라이언트]/_workspace/reports/cross_scaffold_frontend.md`.
5. Phase 6 통합 검사 — 저장소마다 `pattern-conformance` → 실제 테스트·빌드·린트 → `change-safety`, 그리고 클라이언트마다 `api-bridge validate`로 정합성.

프론트엔드 스텁은 항상 백엔드 `api_contract.json` 기준으로 생성되며 URL·메서드를 추측하지 않는다.

### 3. 결과 보고와 TODO

Phase 7 보고는 백엔드·클라이언트별로 파일 경로, 패턴 적합성(기준 파일), 실행 검증(명령·exit), 안전성을 나열하고 마지막에 전체 판정을 낸다. 전체 GO 조건은 모든 저장소의 어댑터 FULL, 패턴 CONFORM, 필수 검증 exit 0, change-safety GO, 모든 클라이언트 드리프트 0건이다. 하나라도 빠지면 가장 낮은 판정을 쓴다.

TODO 절에 백엔드 비즈니스 로직·실제 쿼리, 클라이언트 UI 구현이 남는다. 계약의 `models`에 없어 `// TODO`로 남은 DTO 필드만 백엔드 실제 필드 기준으로 보완한다. 채운 뒤 백엔드를 실행하고 각 클라이언트에서 API 연동 테스트를 한다.

### 4. 기존 API 수정을 양쪽에 반영

운영 중인 API에 필드를 추가해야 한다. 백엔드 저장소에서 시작한다.

```text
이 API 필드 추가해줘 — GET /api/orders/{id} 응답에 cancelReason 추가. 프론트도 같이
```

`cross-repo-modify`가 `safe-modify` 흐름 위에 파트너 분기를 얹어 진행한다.

1. Phase 0 — `pair_config.md` 확인, 운영 모드 키워드 감지(safe-modify와 같은 표), 양쪽 패턴 프로필 검증.
2. Phase 1 — 시작 측 `impact-analyzer`로 `_workspace/reports/impact_<slug>.md`. 변경 대상이 파트너 노출 대상(엔드포인트·컨트롤러·DTO)이 아니면 단독 `safe-modify`로 진행한다.
3. Phase 2 — 파트너마다 `api-bridge check-impact`로 호출 위치·영향 컴포넌트를 찾는다. 전부 0건이면 단독 진행이다.
4. Phase 3 — 파트너 반영 확인 게이트.

```text
이 변경은 아래 파트너 프로젝트(들)에도 영향을 줍니다:

frontend (C:\work\order-frontend)
  영향받는 파일/함수: 2개
  - src/api/orderService.ts:41 — getOrder
  - src/views/OrderDetail.vue:88 — loadOrder

진행 옵션:
1. 전부 반영 (커밋은 하지 않음, 검토 후 각자 커밋)
2. 일부만 반영
3. 이 프로젝트만 수정 (파트너는 수동 안내만 출력)
4. 중단
```

무응답이나 다른 주제로 전환하면 4(중단)와 같게 처리된다. 파트너 저장소는 명시적 선택 없이 자동 반영하지 않는다. CRITICAL 등급이면 재확인이 한 번 더 붙는다.

5. Phase 4 — 시작 측 변경 적용. 계약 형태가 바뀌면 `api-bridge extract`로 `api_contract.json` 갱신.
6. Phase 5 — 선택된 파트너에 갱신된 계약 기준으로 변경 적용. 결과는 `[파트너]/_workspace/reports/cross_modify_partner.md`. 파일 작성까지만 하고 커밋하지 않는다.
7. Phase 6 — 시작 측과 파트너 각각 `pattern-conformance` → 실제 검증 → `change-safety`, 파트너마다 `api-bridge validate`로 드리프트 재검증. GO인 저장소는 인덱스 incremental 갱신과 `generate-wiki`.

### 5. 저장소마다 따로 커밋

Phase 7 보고의 GO 다음 단계는 "시작 측 → 영향 테스트 실행 → commit", "반영된 대상마다 → TODO 완성 → 자체 리뷰 → commit"이다. 각 저장소는 별도 PR·커밋이 필요하며 이 스킬은 파일만 준비한다. 파트너 팀의 리뷰 흐름을 우회하지 않기 위한 정책이다. 파트너 저장소로 이동해 diff를 검토하고 그 팀의 절차대로 커밋한다.

### 6. 드리프트 재확인

시간이 지나 API가 달라졌는지 의심되면 연동을 다시 돈다.

```text
API 드리프트 확인해줘
```

`pair-init` 재실행이 계약을 다시 추출하고 `api_drift_report.md`를 갱신한다. 클라이언트를 추가하려면 "모바일도 추가해줘"로 1:N 전환을 시작한다.

## 결과 확인

- 양쪽 `_workspace/pair_config.md`와 `CLAUDE.md`의 "## 파트너 프로젝트" 절.
- `[백엔드]/_workspace/index/api_contract.json`에 신규 엔드포인트 항목.
- `[프론트엔드]/_workspace/reports/api_drift_report.md` — 드리프트 0건 또는 항목 목록.
- `cross_scaffold_backend.md`·`cross_scaffold_frontend.md` — 생성 파일 목록.
- `cross_modify_partner.md` — 파트너 측 변경 파일과 TODO.
- 저장소별 `pattern_conformance_<slug>.md`·`safety_<slug>.md`.
- 파트너 저장소의 워킹 트리에 변경이 있지만 커밋되지 않은 상태.

## 막혔을 때

- **"먼저 pair-init으로 연동하세요"** — `_workspace/pair_config.md`가 없다. 1단계를 먼저 한다. 단일 저장소만 고치려면 `safe-modify`를 쓴다.
- **파트너 경로 접근 불가** — 그 파트너 설정만 스킵하고 나머지는 계속된다. 경로를 고친 뒤 `pair-init`을 재실행하면 "재설정" 선택지가 나온다.
- **패턴 미추출 WARN이 나온다** — 계속 진행할 수 있지만 그 저장소는 최소 HOLD다. 해당 저장소에서 "패턴 추출해줘"를 먼저 한다.
- **드리프트가 HIGH다** — `MISSING_ENDPOINT`(프론트가 부르는데 백엔드에 없음), `METHOD_MISMATCH`(경로 같고 메서드 다름)는 즉시 수정 대상이다. `UNUSED_ENDPOINT`는 정보성이다.
- **파트너 파일이 고쳐졌는데 커밋이 안 됐다** — 의도된 동작이다. 어느 저장소든 git commit은 자동 실행하지 않는다.
- **1:N인데 특정 클라이언트만 반영하고 싶다** — Phase 3 게이트의 "2. 일부만 반영"으로 라벨을 고른다. 체크리스트는 "확인 후보"를 좁힐 뿐이고 실제 반영은 이 게이트에서 결정된다.
- **wiki가 한쪽만 나온다** — `generate-wiki`는 `pair_config.md`가 있으면 어느 쪽에서 실행해도 architecture·api-endpoints·database·external-systems를 병합한다. 파트너 `_workspace/index/`가 없으면 그쪽에서 인덱싱을 먼저 한다.

## 관련 문서

- [pair-init](/skills/pair-init.md) — 1:1과 1:N 모드, `pair_config.md` 형식.
- [cross-repo-scaffold](/skills/cross-repo-scaffold.md) · [cross-repo-modify](/skills/cross-repo-modify.md) — Phase 전문과 원칙.
- [api-bridge](/agents/api-bridge.md) — extract/validate/generate-stub/check-impact 모드.
- [페어 설정](/configuration/pair-config.md) — `pair_config.md` 필드 설명.
- [신규 기능 개발](/tutorials/new-feature.md) — 단일 저장소 스캐폴딩과의 차이.
