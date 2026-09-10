# pair-init

별도 저장소로 분리된 백엔드·프론트엔드(1:1) 또는 백엔드+여러 클라이언트(1:N, 예: 백엔드+웹+모바일+관리자)를 하네스 레벨에서 연동하는 스킬이다. 연동의 결과물은 `_workspace/pair_config.md`, 백엔드 API 계약 `api_contract.json`, 클라이언트별 드리프트 리포트, 그리고 양쪽 `CLAUDE.md`의 파트너 섹션이다. 연동 후에는 모든 연동 프로젝트 어디서나 `cross-repo-scaffold`로 전체 스택 기능을 동시 생성하고, `analyze-impact`가 API 계약 변경 시 파트너 영향을 자동으로 포함한다.

## 언제 쓰는가

SKILL.md description에 적힌 트리거 문구는 다음과 같다.

| 유형 | 트리거 문구 |
|------|------------|
| 1:1 연동 | "백엔드 프론트엔드 연결해줘", "페어 설정", "두 프로젝트 연동", "백엔드랑 프론트 같이 분석해줘" |
| 1:N 연동 | "모바일도 추가해줘", "클라이언트 여러 개 연동", "허브형 연동" |
| 계약·설정 | "API 계약 추출해줘", "크로스리포 설정", "파트너 프로젝트 등록" |
| 영어 | "pair init" |

슬래시 호출은 `/ax-navi:pair-init`이며 별칭은 없다. 자동 호출 경로가 있다. harness-init에서 프로젝트 구성으로 "3. 서로 다른 폴더의 서버·클라이언트를 각각 초기화 후 연결"(`paired-roots`) 또는 허브형(`hub-roots`)을 선택하면 양쪽 하네스를 대칭 레인으로 만든 뒤 `P-PAIR` 단계에서 이 스킬을 `entry_point: "P-PAIR"`와 함께 호출한다. 이때는 정보 수집·하네스 확인을 전부 건너뛰고 Phase 2로 직행한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|----------------------|------------|
| Phase 0 사전 확인·모드 판단 | `CLAUDE.md`·`.claude/` 존재 확인, 기존 `pair_config.md` 형식으로 1:1/1:N 판단 | 없음 | 신규면 "몇 개 프로젝트를 연동하나요?" 질문, 기존 1:N이면 3지선다 |
| Phase 1-A / 1-B 정보 수집 | 1:1은 역할·파트너 경로·API base URL·스택, 1:N은 클라이언트 수만큼 역할 라벨·경로·URL·스택 | 파트너 하네스가 없으면 `general-purpose`가 harness-init 대행 | 정보 입력, 하네스 없을 때 3지선다 |
| Phase 2-A / 2-B pair_config.md 생성 | 현재 프로젝트와 파트너(들) 양쪽에 생성 | 없음 | 없음 |
| Phase 3 API 계약 추출 | 백엔드 루트에서 계약 추출 | `ax-navi:api-bridge` mode extract | 없음 |
| Phase 4-A / 4-B 드리프트 검증 | 하네스 있는 클라이언트마다 계약 대조 (1:N은 병렬) | `ax-navi:api-bridge` mode validate | 없음 |
| Phase 5-A / 5-B CLAUDE.md 파트너 섹션 | 양쪽 `CLAUDE.md`에 "## 파트너 프로젝트" 추가·갱신 | 없음 | 없음 |
| Phase 6 결과 보고 | 계약·드리프트 요약과 이후 가능한 작업 안내 | 없음 | HIGH 드리프트가 있으면 즉시 수정 권장 확인 |

Phase 0의 모드 판단 표는 다음과 같다.

| 상황 | 판단 |
|------|------|
| harness-init `P-PAIR`에서 `partner_info`/`partner_list` + `entry_point: "P-PAIR"`와 함께 호출 | Phase 0/1 전부 건너뛰고 Phase 2로 직행 |
| harness-init에서 `partner_info`만 (구버전 호환) | 1:1 모드, 질문 생략 |
| harness-init에서 `partner_list`만 (구버전 호환) | 1:N 모드, 질문 생략 |
| `pair_config.md` 없음, 컨텍스트도 없음 | "몇 개 프로젝트를 연동하나요? (1 = 1:1, 2개 이상 = 1:N)" |
| 기존 1:1(flat) 형식 | 현재 설정을 보여주고 "재설정 / 새 클라이언트 추가해서 1:N으로 전환" 확인 |
| 기존 hub-roots(`## Partner:` 블록) 형식 | "새 클라이언트 추가 / 특정 클라이언트 재설정 / 전체 재설정" 3지선다 |

Phase 1에서 파트너에 `CLAUDE.md`가 없으면 standalone 호출에 한해 3지선다가 나온다.

| 선택 | 동작 |
|------|------|
| 1 | subagent가 파트너 루트에서 harness-init을 대신 실행 (Full Tier 확정, Phase 3.5·3.6 스킵) |
| 2 | 하네스 없이 진행. API 계약 추출만 하고 드리프트 검증은 스킵 |
| 3 | 중단. 파트너에서 직접 harness-init 실행 후 재시도 |

1:N에서 하네스 없는 클라이언트가 M개면 자동 생성 Agent를 M개 같은 메시지에서 병렬 발행한다. 일부 실패해도 나머지는 계속 진행하며 실패한 클라이언트만 선택지 2로 폴백한다. harness-init이 주도하는 흐름에서는 이미 대칭 레인이 양쪽 하네스를 만들었으므로 이 3지선다에 도달하지 않는다.

Phase 3의 계약은 백엔드 1개에서 한 번만 추출하며 모든 클라이언트가 공유한다. 추출 실패 시 "API 계약 추출 실패 — 수동으로 `api-bridge extract` 호출 가능" WARN 후 계속한다. Phase 4는 파트너 `CLAUDE.md`가 있고 Phase 3이 성공한 경우에만 실행되며, 각 클라이언트의 결과는 그 클라이언트 루트에 개별 저장된다.

## 입력과 산출물

| 구분 | 경로 | 설명 |
|------|------|------|
| 읽음 | `CLAUDE.md`, `.claude/` (현재·파트너) | 하네스 존재 확인 |
| 읽음 | `_workspace/pair_config.md` (있을 때) | 기존 연동 형식 판단 |
| 씀 | `_workspace/pair_config.md` (현재 프로젝트) | 1:1은 flat 형식, 1:N hub는 `## Partner: <role_label>` 블록 반복 형식 |
| 씀 | `[파트너]/_workspace/pair_config.md` | 역방향 flat 형식. 클라이언트 쪽은 항상 1:1 형식이며 hub-roots를 인식할 필요가 없음 |
| 씀 | `[백엔드]/_workspace/index/api_contract.json` | api-bridge extract 결과 |
| 씀 | `[클라이언트]/_workspace/reports/api_drift_report.md` | api-bridge validate 결과. 클라이언트마다 개별 파일 |
| 갱신 | `CLAUDE.md` (양쪽) | "## 파트너 프로젝트" 섹션과 크로스 리포 워크플로우 표 |

1:1 flat 형식의 `pair_config.md` 필드는 다음과 같다.

```markdown
# Pair Configuration

project_type: [backend/frontend]
partner_type: [frontend/backend]
partner_root: [절대경로]
partner_workspace: [절대경로/_workspace]
partner_stack: [스택 — 미입력 시 unknown]
api_base_url: [http://localhost:8080]
api_contract_path: _workspace/index/api_contract.json
partner_api_contract: [파트너 절대경로]/_workspace/index/api_contract.json
linked_at: [YYYY-MM-DD]
```

1:N hub 쪽은 `project_type: backend`, `init_mode: hub-roots`, `linked_at` 뒤에 `## Partner: [role_label]` 블록이 클라이언트 수만큼 반복된다. "새 클라이언트 추가"는 블록 하나만 덧붙이고, "특정 클라이언트 재설정"은 그 블록만 교체한다. 필드 상세는 [크로스 리포 설정](/configuration/pair-config.md)에 있다.

`_workspace/pair_lane_state.md`는 harness-init의 레인 상태 파일로 이 스킬이 만드는 `pair_config.md`와 다른 파일이다.

## 예시

```text
사용자: 백엔드 프론트엔드 연결해줘

Claude: 몇 개 프로젝트를 연동하나요? (1 = 1:1, 2개 이상 = 1:N)

사용자: 1

Claude: 페어 설정에 필요한 정보를 입력해주세요.
        1. 현재 프로젝트 역할 (backend / frontend)
        2. 파트너 프로젝트 절대 경로
        3. API base URL (로컬 개발 기준)
        4. (선택) 파트너 스택

사용자: backend / C:\work\order-web / http://localhost:8080 / Vue 3

Claude: 파트너 경로 확인 완료. CLAUDE.md 가 있어 하네스 확인도 통과했습니다.
        pair_config.md 를 양쪽에 생성하고 api-bridge extract 를 실행합니다.

        페어 설정 완료
        API 계약 추출은 성공했고 엔드포인트 42개(공개 12 | 인증 30)입니다.
        API 드리프트 검증 결과는 MISSING 1건, MISMATCH 2건, UNUSED 5건이며
        상세는 C:\work\order-web\_workspace\reports\api_drift_report.md 에 있습니다.
        이제 "주문 취소 기능 전체 만들어줘"로 cross-repo-scaffold 를 실행할 수 있습니다.
```

```text
사용자: 모바일도 추가해줘

Claude: 기존 클라이언트 연동이 있습니다. web-frontend, admin-panel
        1. 새 클라이언트 추가  2. 특정 클라이언트 재설정  3. 전체 재설정

사용자: 1

Claude: 클라이언트 정보를 입력해주세요. 역할 라벨 / 절대 경로 / API base URL(선택) / 스택(선택)

사용자: mobile-ios / C:\work\order-ios / / Swift

Claude: pair_config.md 끝에 "## Partner: mobile-ios" 블록을 덧붙이고 C:\work\order-ios 에 역방향 설정을 만들었습니다.
        하네스가 없어 3지선다를 드립니다. 1. 자동 생성 (권장)  2. 하네스 없이 진행  3. 중단
```

## 원칙과 주의

- 하네스가 없는 프로젝트에서는 실행되지 않는다. 먼저 `harness-init`으로 현재 프로젝트 하네스를 만든다.
- 파트너·클라이언트 경로에 접근할 수 없으면 그 쪽 설정만 스킵하고 나머지는 계속한다. 1:N에서 특히 중요한 규칙이다.
- 파트너 `CLAUDE.md`를 수정할 권한이 없으면 현재 프로젝트 `CLAUDE.md`만 고치고 해당 쪽은 수동 안내한다.
- 기존 `pair_config.md`가 있으면 덮어쓰기 전 확인한다. 1:N에서는 Phase 0의 3지선다가 그 확인을 대체하며, "전체 재설정"은 백업 없이 덮어쓴다.
- hub-roots에서 클라이언트가 1개뿐이면 진행은 하되 "1개면 1:1(`paired-roots`)이 더 단순합니다"라고만 안내한다.
- 드리프트 검증은 연동 시점 스냅샷이다. API가 바뀐 뒤에는 "API 드리프트 확인해줘"로 pair-init을 재실행하거나 "API 계약 갱신해줘"로 `api-bridge extract`를 다시 돌린다.

## 관련 문서

- [api-bridge 에이전트](/agents/api-bridge.md)
- [크로스 리포 설정](/configuration/pair-config.md)
- [cross-repo-scaffold](/skills/cross-repo-scaffold.md)
- [cross-repo-modify](/skills/cross-repo-modify.md)
- [튜토리얼: 크로스 리포 기능](/tutorials/cross-repo-feature.md)
