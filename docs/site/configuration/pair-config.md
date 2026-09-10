# 크로스 리포 설정 (pair_config.md)

`_workspace/pair_config.md`는 분리된 저장소를 하네스 수준에서 연결하는 설정 파일입니다. `pair-init`이 만들고 `build-index.mjs`·`skills_builder.py`·`wiki_generator.py`·`analyze-impact`가 읽습니다. 백엔드 1개와 클라이언트 1개를 잇는 1:1(`paired-roots`)과 백엔드 1개에 클라이언트 여러 개를 붙이는 1:N(`hub-roots`) 두 형식이 있습니다.

## 두 형식 한눈에

| 구분 | 1:1 `paired-roots` | 1:N `hub-roots` |
|------|--------------------|-----------------|
| 파일 구조 | 최상위 `key: value` 줄만 있는 flat 형식 | 공통 키 3줄 + `## Partner: <role_label>` 블록을 클라이언트 수만큼 반복 |
| 어느 쪽에 생기나 | 양쪽 프로젝트 모두(역방향 내용) | hub(백엔드)에는 다중 블록, 각 클라이언트에는 1:1 flat 형식 |
| 식별 방법 | `## Partner:`가 없음 | `init_mode: hub-roots`와 `## Partner:` 블록 존재 |
| 파서 | `parse_pair_config()` | `parse_pair_config_partners()` |

클라이언트 쪽 파일은 항상 1:1 형식입니다. 클라이언트 입장에서 파트너는 hub 하나뿐이므로 hub-roots를 인식할 필요가 없습니다.

## 1:1 형식

```markdown
# Pair Configuration

project_type: backend
partner_type: frontend
partner_root: C:\work\my-frontend
partner_workspace: C:\work\my-frontend\_workspace
partner_stack: Vue 3
api_base_url: http://localhost:8080
api_contract_path: _workspace/index/api_contract.json
partner_api_contract: C:\work\my-frontend\_workspace\index\api_contract.json
linked_at: 2026-09-10
```

| 키 | 의미 | 채우는 쪽 |
|----|------|-----------|
| `project_type` | 현재 프로젝트 역할. `backend` 또는 `frontend` | pair-init Phase 1-A 질문 1 |
| `partner_type` | 파트너 역할(현재의 반대) | 자동 |
| `partner_root` | 파트너 프로젝트 절대경로 | 질문 2. `Test-Path`/`[ -d ]`로 존재 확인 |
| `partner_workspace` | `partner_root/_workspace` | 자동 |
| `partner_stack` | 파트너 스택. 미입력 시 `unknown` | 질문 4(선택) |
| `api_base_url` | 로컬 개발 기준 API base URL | 질문 3 |
| `api_contract_path` | 현재 프로젝트 기준 계약 경로(항상 `_workspace/index/api_contract.json`) | 자동 |
| `partner_api_contract` | 파트너 계약의 절대경로 | 자동 |
| `linked_at` | 연동일 | 자동 |

## 1:N 형식 (hub 쪽)

```markdown
# Pair Configuration

project_type: backend
init_mode: hub-roots
linked_at: 2026-09-10

## Partner: web-frontend
partner_role_label: web-frontend
partner_type: frontend
partner_root: C:\work\web
partner_workspace: C:\work\web\_workspace
partner_stack: React
api_base_url: http://localhost:8080
api_contract_path: _workspace/index/api_contract.json
partner_api_contract: C:\work\web\_workspace\index\api_contract.json

## Partner: mobile-ios
partner_role_label: mobile-ios
partner_type: frontend
partner_root: C:\work\ios
partner_workspace: C:\work\ios\_workspace
partner_stack: Swift
api_base_url: http://localhost:8080
api_contract_path: _workspace/index/api_contract.json
partner_api_contract: C:\work\ios\_workspace\index\api_contract.json
```

`partner_role_label`은 자유 입력이지만 다른 클라이언트와 겹치지 않아야 합니다. 예시로 `web-frontend`·`mobile-ios`·`mobile-android`·`admin-panel`이 안내됩니다. API base URL을 비우면 1번 클라이언트와 같다고 가정합니다.

블록을 추가·교체하는 규칙은 다음과 같습니다.

| 작업 | 파일 변화 |
|------|-----------|
| 새 클라이언트 추가 | 파일 맨 끝에 `## Partner:` 블록 하나만 덧붙임. 다른 블록은 건드리지 않음 |
| 특정 클라이언트 재설정 | 그 `role_label`의 블록만 통째로 교체 |
| 전체 재설정 | 백업 없이 덮어씀(사용자가 방금 선택했으므로) |

## pair-init이 채우는 것

`pair_config.md`는 pair-init Phase 2에서 만들어지고, 이어지는 단계가 나머지 연동 산출물을 채웁니다.

| 단계 | 산출물 | 위치 |
|------|--------|------|
| Phase 2-A/2-B | `pair_config.md` (양쪽 또는 hub+각 클라이언트) | 각 프로젝트 `_workspace/` |
| Phase 3 | `api-bridge extract`로 백엔드 API 계약 | 백엔드 `_workspace/index/api_contract.json` |
| Phase 4-A/4-B | `api-bridge validate`로 클라이언트별 드리프트 리포트 | 각 클라이언트 `_workspace/reports/api_drift_report.md` |
| Phase 5-A/5-B | CLAUDE.md "## 파트너 프로젝트" 섹션 | 양쪽 CLAUDE.md |

harness-init에서 `paired-roots`/`hub-roots`를 선택한 경우에는 양쪽 하네스가 대칭 2-레인으로 먼저 만들어지고 P-BARRIER를 통과한 뒤 pair-init이 `entry_point: "P-PAIR"`로 호출되어 Phase 2부터 시작합니다. 사용자가 pair-init을 직접 호출하면 파트너 하네스가 없을 때 자동 생성·하네스 없이 진행·중단 3지선다가 나옵니다.

## 파트너 경로와 라벨 규칙

- `partner_root`는 절대경로여야 하며 존재하지 않으면 재입력을 요청합니다. 접근 불가한 파트너는 그 항목만 건너뛰고 나머지는 계속 진행합니다.
- 인덱서(`build-index.mjs`)는 `partner_root`와 `partner_api_contract` 줄을 정규식으로 읽으며, 같은 키를 여러 줄 반복하거나 `partner_root[n]` 형태로 써도 파트너 목록으로 인식합니다. `partner_api_contract`가 없으면 `partner_root/_workspace/index/api_contract.json`으로 유도합니다.
- 계약 파일 이름은 단수 `api_contract.json`으로 고정입니다. 이미 배포된 `pair_config.md`들이 이 경로를 절대경로로 박고 있기 때문입니다.
- hub-roots에서 클라이언트가 1개뿐이면 진행은 되지만 "1:1이 더 단순합니다" 안내만 나옵니다.

## 어디에 영향을 주는가

| 소비자 | pair_config.md가 있을 때의 동작 |
|--------|-------------------------------|
| `harness-init` Phase 0 | 존재 여부로 파트너 연동 상태를 감지하고 `partner_root` 변수를 설정 |
| `build-index.mjs` | 파트너 `api_contract.json`을 읽어 `api_contract`의 `source: external` 레코드와 `matches`를 만듦 |
| `skills_builder.py` | CLAUDE.md "## 파트너 프로젝트" 섹션을 필드값만으로 조립(LLM 없음). 1:N이면 클라이언트 표 형식. `cross-repo-scaffold.md`·`cross-repo-modify.md` 로컬 스킬 생성 여부도 이 파일 존재로 결정 |
| `writer` | pair_config가 있으면 `cross-repo-scaffold.md`·`cross-repo-modify.md`도 작성 |
| `analyze-impact` | API 계약 변경 시 등록된 파트너(전체 클라이언트) 영향을 자동 포함 |
| `generate-wiki` | 파트너의 `call_graph.json`·`01_analyzer_report.md`·`api_contract.json`·`schema.json`·`external_io.json`을 읽어 architecture/api-endpoints/database/external-systems 페이지와 call-graph.html에 자동 병합. 별도 인자 없음 |
| `cross-repo-scaffold`·`cross-repo-modify` | 포함할 클라이언트를 체크리스트로 묻고 저장소별 패턴·검증·API 드리프트 게이트 실행 |
| `publish-wiki` | 백엔드·프론트엔드를 컴포넌트로 분리 저장 |

## 손으로 고칠 때

| 상황 | 방법 |
|------|------|
| 파트너 폴더를 옮겼다 | `partner_root`·`partner_workspace`·`partner_api_contract` 세 줄을 모두 새 절대경로로. 한 줄만 고치면 계약 경로가 어긋남 |
| 클라이언트를 추가하고 싶다 | 직접 편집보다 "[새 역할] 클라이언트 추가해줘"로 pair-init 재실행을 권장 |
| 드리프트를 다시 확인하고 싶다 | "API 드리프트 확인해줘" → pair-init 재실행. 파일은 그대로 두고 Phase 3~4만 다시 수행 |
| 연동을 해제하고 싶다 | 양쪽 `pair_config.md` 삭제 후 "스킬만 다시 생성"으로 CLAUDE.md 파트너 섹션과 cross-repo 로컬 스킬 정리 |

편집 후 `generate-wiki`를 다시 실행하면 병합 결과가 반영됩니다. wiki 빌드 보고(`07_wiki_build.md`)의 "크로스 리포 병합" 줄에서 병합된 노드·페이지 수 또는 스킵 사유를 확인할 수 있습니다.

## 관련 문서

- [pair-init](/skills/pair-init.md)
- [cross-repo-scaffold](/skills/cross-repo-scaffold.md)
- [cross-repo-modify](/skills/cross-repo-modify.md)
- [api-bridge](/agents/api-bridge.md)
- [분리 저장소 기능 개발](/tutorials/cross-repo-feature.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [_workspace 파일 사전](/reference/workspace-files.md)
