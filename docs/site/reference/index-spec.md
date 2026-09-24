# 인덱스 파일 스펙

`_workspace/index/` 아래 JSON 파일은 후속 스킬과 에이전트(impact-analyzer·sql-reviewer·change-safety·migration-planner 등)가 코드를 다시 읽지 않고 조회하는 사실 저장소입니다. 이 페이지는 저장소 `docs/index-spec.md`의 사용자용 요약으로, 파일별 목적·핵심 필드·생성 주체와 공통 규칙을 정리합니다. 필드 단위 예시 JSON과 세부 계약은 저장소 `docs/index-spec.md` 원문을 참고하세요.

## 인덱스 파일 12종

| 파일 | 목적 | 핵심 필드 | 생성 주체 |
|------|------|-----------|-----------|
| `symbols.json` | 클래스·메서드·함수 심볼과 위치 | `symbols[]` — `id`·`type`·`file`·`line`·`package`·`extends`·`implements`·`annotations`·`methods[]` | 인덱서 |
| `call_graph.json` | 호출 관계 그래프 | `nodes[]`(`id`·`type`·`file`·`line`·`signature`·선택 `note`), `edges[]`(`from`·`to`·`type`·`file`·`line`·선택 `note`) | 인덱서. 모호 관계·note는 analyzer 패치 |
| `sql_usage.json` | 어떤 쿼리를 어디서 실행하는가 | `sqls[]`(`id`·`type`·`tables`·`columns_selected`·`columns_where`·`text_preview`), `usages[]`(`sql_id`·`method`·`file`·`line`) | 인덱서 |
| `schema.json` | 테이블·컬럼·PK/FK·인덱스 | `_meta.source`(`ddl`·`live_db`·`derived-from-sql` 등), `tables[]`(`columns`·`primary_key`·`foreign_keys`·`indexes`) | 인덱서(DDL 또는 SQL 유도). 라이브 DB는 analyzer |
| `transactions.json` | 트랜잭션 경계 | `boundaries[]` — `entry_method`·`marker`·`propagation`·`methods_in_scope`·`external_io_calls` | 인덱서 |
| `external_io.json` | 외부 통신 | `communications[]` — `type`(`http`·`kafka_*`·`file_io`·`redis` 등)·`target`·`in_transaction`·선택 `description` | 인덱서. description은 analyzer 패치 |
| `env_branches.json` | 환경별 분기 코드·설정 | `profiles[]`, `branches[]`(`type`·`marker`·`values_per_profile`) | 인덱서 |
| `api_contract.json` | API 명세와 호출처 | `endpoints[]`·`consumers[]`·`matches[]`(`shape_match`)·`unmatched_endpoints`·`unmatched_consumers` | 인덱서. description은 analyzer 패치, 페어 연동 추출·드리프트는 api-bridge |
| `dead_code.json` | 데드 코드 후보 | `unused_methods[]`·`unused_sql_ids[]`·`unused_jsps[]`, 항목별 `reason` | 인덱서 |
| `ui_flow.json` | 화면 이벤트와 서버 호출(Nexacro 등) | `screens[]`·`events[]`·`datasets[]`·`transactions[]` | 인덱서 |
| `data_flow.json` | 요청 → 로직 → DB 체인 | `chains[]` — `endpoint_id`·`method_chain`·`call_edges`·`sql_ids`·`tables_read`·`tables_written`·`max_depth`·`truncated`·선택 `note` | 인덱서(조인). note는 analyzer 패치 |
| `client_index.json` | 레거시 정적 JS ↔ JSP 매핑 | `type`·`js_count`·`domain_structure`·`sample_mappings`·`jquery_versions`, 선택 `ajax_contract`·`naming_convention`·`anti_patterns` | 인덱서(구조). 서술 필드는 analyzer 패치 |
| `owasp_top10.json` | OWASP Top 10 (2021) 매핑 | `categories[]` — `id`(`A01:2021`~`A10:2021`)·`status`(`발견`·`확인필요`·`미탐지`)·`findings[]` | analyzer 전량 작성 |

`owasp_top10.json`은 판단이 필요해 기계화 대상이 아니며, `미탐지`는 "취약점 없음"의 보증이 아닙니다. Vue 컴포넌트·Pinia 스토어 노드와 `import`·`inject` 엣지는 `index_extractor_vue.py`가 인덱서 결과에 병합합니다.

## 제어 파일 3종

인덱서가 인덱스와 함께 만드는 파일입니다. `_meta` 블록을 갖지 않으므로 아래 9필드 규칙의 대상이 아닙니다.

| 파일 | 내용 | 읽는 쪽 |
|------|------|---------|
| `_meta.json` | 전역 매니페스트 — `version`(INDEXER_VERSION)·`tier`·복잡도·`adapter_coverage`·`indexes[]`·`source_fingerprint`·`excluded_sources`·`encoding`·`ai_enrichment` | `--check-stale`, validator, check-adapter-coverage, harness-evaluator |
| `_analysis_input.json` | analyzer가 읽는 상한 있는 요약과 계약 — `coverage.unresolved_decidable_group_count`, `analyzer_contract`, `evidence.test_deploy_inventory` | analyzer, ai-budget estimate |
| `_unresolved.jsonl` | 이름 해석을 확정하지 못한 관계. 후보 2개 이상인 레코드만 판정 대상(`group_id` 부여), 후보 0~1개는 `no_candidates: true`로 감사 기록만 | analyzer |
| `_unresolved_groups.json` | 판정 대상을 `(kind, key_field, candidates)`로 묶은 고유 패턴 그룹. `group_id`는 해시라 재인덱싱에도 유지 | analyzer(`resolve_group` 제출) |
| `_ai_patch.json` | analyzer가 제출하는 보강 오퍼레이션(`add_edge`·`resolve_group`·`set_node_note`·`set_endpoint_description` 등) | `build-index.mjs --apply-ai-patch`, incremental 재인덱싱 |

## 공통 `_meta` 규칙

모든 인덱스 파일은 최상위에 `_meta` 블록을 가지며, 다음 9필드가 필수입니다. 없으면 `validator_checks.py`가 하드 FAIL 처리합니다.

| 필드 | 값 |
|------|-----|
| `generated_at` | `now_kst.py` 실행 결과(KST, `+09:00`). 자정 고정값이나 UTC `Z` 표기는 WARN |
| `generator` | `deterministic-indexer` / `analyzer` 등 |
| `version` | 인덱서 버전(현재 `1.12.0`) |
| `source_root` | `.` (이식 가능한 인덱스) |
| `mode` | `init` / `incremental` / `feature-scoped` |
| `git_commit` | `git rev-parse HEAD` 결과. git 저장소가 아니면 `null` |
| `sampled` | 샘플링 여부 |
| `files_scanned` | 실제 읽은 파일 수 |
| `files_total` | 대상 파일 수 |

`call_graph.json`은 추가로 `node_count`·`edge_count`가 실제 배열 길이와 일치해야 하고, 모든 엣지의 `from`/`to`는 `nodes`에 실존하는 id여야 합니다(dangling 금지).

형식 규칙은 JSON, UTF-8(BOM 없음), 2칸 들여쓰기입니다. 사람이 검토할 수 있도록 압축하지 않습니다.

## origin과 confidence

`call_graph`·`api_contract`의 모든 레코드에는 출처와 신뢰도가 붙습니다.

| 필드 | 값 | 의미 |
|------|-----|------|
| `origin` | `deterministic-indexer` | 인덱서가 소스에서 직접 추출 |
| | `ai-enrichment` | analyzer가 `_ai_patch.json`으로 보강 |
| | `api-bridge` | 페어 연동 계약 추출(api_contract만) |
| | `analyzer-fallback` | 인덱서가 없어 analyzer가 직접 작성 |
| `confidence` | `HIGH` | 후보가 하나로 확정 |
| | `MEDIUM` | 스코프 좁히기(`resolved_by: same_file`·`same_package`·`same_workspace`)로 확정, 또는 SQL에서 유도한 스키마 |
| | `LOW` | 리플렉션 등 휴리스틱 |

인덱서는 후보가 정확히 하나일 때만 엣지를 만들고, 둘 이상이면 스코프 좁히기를 한 번 시도한 뒤 그래도 남으면 `_unresolved.jsonl`로 넘깁니다. 없는 엣지를 지어내지 않는 것이 인덱서의 계약입니다. analyzer는 기존 노드 사이의 엣지만 추가할 수 있습니다.

## `call_graph` 엣지 type

| type | 의미 | 생성 주체 |
|------|------|-----------|
| `call` | 메서드 직접 호출 | 인덱서 |
| `inject` | DI 주입 | 인덱서 |
| `inherit` | 상속·구현 | 인덱서 |
| `import` | 파일·모듈 import. 인덱서는 만들지 않음 | Vue 추출기 등 파일 단위 생성기 |
| `reflect` | 리플렉션 가능성(신뢰도 낮음) | analyzer 패치만 |
| `ui_event`·`markup_event`·`scheduler`·`process_entry` | 진입점 → 핸들러. 출발점은 `trigger:<파일>#<트리거>` 합성 노드 | 인덱서 |

## 스키마 검증

`agents/lib/validate-harness.mjs`가 `_workspace/index/*.json`을 `docs/index-schema/*.json`과 대조해 타입·enum·필수 필드를 검증합니다. 결과는 `_workspace/validator_schema.json`에 남고 harness-init 2-3.5 `block: verify`에서 실행됩니다.

| 검사 항목 | 내용 |
|-----------|------|
| 스키마 대조 | `symbols`·`call_graph`·`sql_usage`·`transactions`·`external_io`·`env_branches`·`schema`·`api_contract`·`dead_code`·`client_index`·`data_flow` 11종 |
| 엣지 참조 무결성 | `call_graph` 엣지가 실존 노드를 가리키는지, AI 보강 엣지에 `file:line` 근거가 있는지 |
| evidence path | 인덱스가 가리키는 소스 파일이 실제로 존재하는지 |
| `_meta.json` 정합성 | `generator`·선언된 `indexes`·`unresolved_count` |

exit 1은 스키마 FAIL이 있다는 뜻이며 스크립트 실패가 아닙니다. `plugin_contract_failures`(코드 `PLUGIN_INDEX_CONTRACT`)는 `build-index.mjs`나 스키마 파일 자체의 결함이라 AI 재시도 대상이 아니고 보고만 합니다. 스키마 파일 목록은 저장소 `docs/index-schema/`에 있습니다(`_meta.schema.json` 포함 13개).

`validate-harness.mjs`는 형태 검증이고, `validator_checks.py`의 check7/7b는 실제 소스와 대조하는 내용 정확성 검증입니다. 두 층은 서로 대체하지 않고 병행합니다.

## 갱신 정책과 fallback

| 시나리오 | 동작 |
|----------|------|
| `init` | 전체 인덱스 생성 |
| `incremental` | 변경 파일 재분석. stale 엣지는 재분석 전에 제거 후 재수집 |
| `feature-scoped` | 사용자 지정 범위만 부분 추가, 기존 데이터 보존 |

인덱스가 없거나 stale이면 각 에이전트는 grep으로 폴백하지만 느리고 정확도가 떨어집니다. impact-analyzer는 `call_graph`·`sql_usage`·`schema`, sql-reviewer는 `sql_usage`·`schema`, change-safety는 `call_graph`·`external_io`, migration-planner는 `call_graph`·`external_io`·`transactions`·`dead_code`에 의존합니다.

## 관련 문서

- [결정론적 인덱스](/concepts/deterministic-index.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [_workspace 파일 사전](/reference/workspace-files.md)
- [analyzer](/agents/analyzer.md)
- [validator](/agents/validator.md)
