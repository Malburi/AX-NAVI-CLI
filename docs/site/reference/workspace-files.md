# _workspace 파일 사전

`_workspace/`는 하네스 파이프라인과 워크플로우 스킬이 산출물을 주고받는 작업 공간입니다. 에이전트 사이의 인자 전달은 프롬프트가 아니라 이 폴더의 파일로 이뤄지므로, 어떤 파일이 어느 단계에서 생기고 누가 읽는지 알면 진행 상황과 실패 지점을 파일만 보고 판단할 수 있습니다. 파일명은 `agents/`·`skills/`·`agents/lib/`에서 실제로 참조되는 것만 실었습니다.

## 초기화 파이프라인 산출물

| 파일 | 생성 단계 · 주체 | 내용 | 읽는 쪽 |
|------|------------------|------|---------|
| `00_init_scope.md` | Phase -1 · 오케스트레이터 | 초기화 구성(`init_layout`·`paths`·`source`), `tier:`, `ai_budget_session` | block: index(indexer-config 변환), analyzer, 부분 재실행 |
| `00_stack_precheck.json` | 2-0.5 · `stack_precheck.py` | `detected_stack`·`extractors`, 실제 사용한 `indexer` 순위, AI 예산 미적용 사유 | block: index 폴백 선택, validator DI 휴리스틱 |
| `00_pipeline_status.md` | Phase 1 · 오케스트레이터 | `TaskCreate`가 없는 호스트의 체크리스트 폴백(`- [ ]`/`- [~]`/`- [x]`) | 사용자 |
| `00_spec_report.md` | spec-gate · spec-clarifier | 모호성 점수·영역별 답변·GO/REFINE 신호 | 사용자, 이후 작업 참고 |
| `01_analyzer_report.md` | 2-1 · analyzer, 2-1.6 `analyzer_index_summary.py`가 Section B 기계 삽입 | 스택·아키텍처·도메인·의존성·DB·외부 연동 분석 | writer, pattern-extractor, validator, harness-evaluator, qa, `domain-expert.md` 원본, wiki |
| `02_writer_files.md` | 2-2.3 · `skills_builder.py` `render_writer_files_report()` | 생성 파일 목록, 워크플로우 스킬 목록, 조건부 스킬 결정 | validator, harness-evaluator |
| `03_validator_report.md` | 2-4 · validator | 체크 1~11 결과, 신뢰도 점수, 보완 권장 | 오케스트레이터(Phase 3 보고, QA 게이트 신뢰도 < 50), harness-evaluator |
| `04_qa_report.md` | 3.7 · qa (온디맨드) | Boundary 1~7 교차 비교, DEAD/ORPHAN | 사용자. 신뢰도 < 50이면 미실행 사유 한 줄만 |
| `05_patterns_extracted.md` | 2-3 · pattern-extractor (`05b_pattern_tally.md` 삽입) | 처리 패턴 파일 수, 신뢰도 분포, 안티패턴 건수 | Phase 3 보고 |
| `05b_pattern_tally.md` | 2-3 · `pattern_tally.py` | 개별 패턴 파일에서 기계 취합한 집계 표 | pattern-extractor가 05에 삽입 |
| `06_eval_report.md` | 2-5·Phase 4 · harness-evaluator | 4차원 점수, PASS/PARTIAL/RETRY, `fix_targets` | Phase 4 재생성 루프 |
| `07_wiki_build.md` | generate-wiki · `wiki_generator.py` | 생성 페이지 목록, 크로스 리포 병합 결과 | generate-wiki 보고 |

## 기계 결정·검증 JSON

| 파일 | 생성 단계 · 주체 | 내용 | 읽는 쪽 |
|------|------------------|------|---------|
| `claude_md_fields.json` | 2-2 · writer | CLAUDE.md 필드(프로젝트명·한줄설명·스택요약·요청흐름·파일위치표 행·빌드명령·주의사항) | `skills_builder.py`가 CLAUDE.md 조립. 없으면 CLAUDE.md 조립 스킵 WARN |
| `writer_decisions.json` | 2-2 · writer | `detected_stack`·`confidence`·`pattern_files`·`plan_migration`/`review_sql` 적용 여부·`applied_decisions` | `skills_builder.py`가 조건부 스킬·패턴 스켈레톤·02 조립. 없으면 전부 스킵 WARN |
| `pattern_profile_validation.json` | 2-3.5 · `pattern_profile.py validate` | 중복 ID·잘못된 상태·프로젝트 밖 경로·없는 기준 파일·빈 규칙 판정 | validator, harness-evaluator, 코드 작업 스킬 게이트 |
| `validator_mechanical.json` | 2-3.5 · `validator_checks.py` | 체크 1,2,3,4,6,7,8,9,11 기계 결과, `index_integrity_fail`·`index_spotcheck_fail`·`warns` | validator Agent, Phase 4 인덱스 무결성 게이트 |
| `validator_schema.json` | 2-3.5 · `validate-harness.mjs` | 인덱스 스키마 검증 PASS/WARN/FAIL, `plugin_contract_failures` | validator, Phase 4 게이트 |
| `qa_boundary6.md` | 3.7 · `qa_boundary6.py` (qa가 직접 실행) | 워크플로우 스킬 ↔ 인덱스 의존성 파일 존재 확인 | qa가 04 리포트에 삽입 |
| `ai-budget.json` | 2-0.5 Step F · `ai-budget.mjs init` | 세션·역할별 initial/retry 사용량, 시간·토큰 한도 | `ai-budget.mjs claim/record/status`, Phase 3 보고 |
| `wiki_quality.json` | generate-wiki · `wiki_generator.py` | 연결 수·설명 수·깊이 제한 등 커버리지 집계(`status` PARTIAL은 분석 누락 의미) | generate-wiki 보고 |

## 설정 파일

| 파일 | 생성 단계 · 주체 | 내용 | 읽는 쪽 |
|------|------------------|------|---------|
| `indexer-config.json` | 2-0.5 Step B · pipeline-runner | `init_layout`·`include_paths`·`workspace_mode`·`workspaces[]`·`vendor_exclude`·`test_exclude` | `build-index.mjs`(인덱싱·`--check-stale`) |
| `pair_config.md` | pair-init Phase 2 | 파트너 경로·역할·스택·API 계약 경로(1:1 flat 또는 1:N `## Partner:` 블록) | harness-init, `build-index.mjs`, `skills_builder.py`, `wiki_generator.py`, analyze-impact, cross-repo 스킬 |
| `pair_lane_state.md` | harness-init 분리 저장소 Phase -1 | 레인별 `last_stage`·`status`, `pair_state`(`barrier_done`·`complete`) | 분리 저장소 레인 재개 판단 |

## `index/` 디렉터리

| 파일 | 생성 주체 | 내용 |
|------|-----------|------|
| `symbols.json` `call_graph.json` `sql_usage.json` `transactions.json` `external_io.json` `env_branches.json` `schema.json` `api_contract.json` `dead_code.json` `ui_flow.json` `data_flow.json` `client_index.json` | `build-index.mjs` (해당 사실이 있는 것만) | 결정론적 인덱스. 상세는 [인덱스 파일 스펙](/reference/index-spec.md) |
| `owasp_top10.json` | analyzer | OWASP Top 10 매핑 |
| `_meta.json` | 인덱서 | 전역 매니페스트, `source_fingerprint`, `adapter_coverage`, `ai_enrichment` |
| `_analysis_input.json` | 인덱서 | analyzer용 상한 있는 요약·계약 |
| `_unresolved.jsonl` / `_unresolved_groups.json` | 인덱서 | 미해결 관계와 판정 그룹 |
| `_ai_patch.json` | analyzer | AI 보강 오퍼레이션. LLM 산출물이므로 커밋 권장 |

## `reports/` 디렉터리 — 온디맨드 작업 리포트

스킬별 1회성 산출물입니다. `<slug>`는 대상 이름에서 만든 식별자입니다.

| 파일 | 생성 스킬 · 에이전트 | 내용 |
|------|----------------------|------|
| `impact_<slug>.md` | analyze-impact · impact-analyzer | 직간접 영향, 위험도, 영향 테스트 |
| `pattern_selection.json` | safe-modify·scaffold-feature·vibe · `pattern_profile.py select` | 대상 경로·모듈·레이어에 선택된 preferred 프로필 |
| `pattern_conformance_<slug>.md` | safe-modify·scaffold-feature·cross-repo · pattern-conformance | CONFORM/HOLD/FAIL과 근거 |
| `safety_<slug>.md` | safe-modify·scaffold-feature·cross-repo · change-safety | GO/HOLD/STOP과 차원별 점수 |
| `tests_<slug>.md` | scaffold-feature·safe-modify(옵션) · test-generator | 생성한 회귀 테스트 골격 목록 |
| `trace_<slug>.md` | trace-logic · logic-tracer | 진입점부터 DB까지 흐름 |
| `found_<slug>.md` | find-feature · feature-finder | 관련 파일·심볼·SQL 위치 |
| `sql_review_<slug>.md` | review-sql · sql-reviewer | 확정 발견·조건부 권고·수정안 SQL |
| `decoded_<slug>.md` | legacy-decoder 직접 호출 | 구조 분해·의도 추정·사이드 이펙트 |
| `docs_sync_<slug>.md` | doc-syncer 직접 호출 | stale 문서 항목과 변경 권고 |
| `api_drift_report.md` | pair-init·cross-repo · api-bridge validate | 클라이언트별 MISSING/MISMATCH/UNUSED |
| `api_contract_schema_check.json` | api-bridge extract | 계약 파일 자체 스키마 검증 |
| `cross_scaffold_backend.md` `cross_scaffold_frontend.md` | cross-repo-scaffold | 저장소별 생성 결과 |
| `cross_modify_partner.md` | cross-repo-modify | 파트너 반영 결과 |

## `migration/` 디렉터리

`plan-migration`이 migration-planner로 만드는 계획 문서입니다. 코드 변환은 하지 않습니다.

| 파일 | 내용 |
|------|------|
| `00_context.md` | 소스·타겟·범위·외부 조율 컨텍스트 |
| `00_inventory.md` | 전환 대상 전체 목록 |
| `01_mapping_table.md` | AS-IS / TO-BE 매핑 |
| `02_phased_plan.md` | 단계별 실행 계획 |
| `03_risk_register.md` | 리스크 목록과 대응 |
| `04_test_strategy.md` | 테스트 전략 |
| `05_rollback_plan.md` | 롤백 시나리오 |
| `checkpoints/phase1~4.md` | Phase 종료 체크포인트·사인오프 |

## `wiki/` 디렉터리와 백업

| 경로 | 내용 |
|------|------|
| `wiki/*.md` | `wiki_generator.py`가 만든 Docsify 페이지(overview·architecture·patterns·business-flows·coverage·domain 등) |
| `wiki/_sidebar.md` `wiki/_navbar.md` | Docsify 네비게이션 |
| `wiki/call-graph.html` | 데이터 인라인 포함 독립 페이지. `file://`로 직접 열람 가능 |
| `wiki/_html/*.html` `wiki/offline.html` | 서버 없이 여는 렌더 사본과 진입점 |
| `wiki/serve.bat` | 로컬 Docsify 서버 실행(`http://localhost:3501`) |
| `wiki_prev/` | 재생성 전 1세대 백업 |
| `_workspace_prev/` | 초기 실행·재초기화 때 이전 `_workspace/` 전체 이동 |

## 커밋과 삭제 판단

| 대상 | 삭제 가능 | 커밋 |
|------|-----------|------|
| `00~07_*.md`, `*_report.md` | 가능(참조용 01은 남기기 권장) | 선택 |
| `index/*.json` (`_ai_patch.json` 제외) | 재생성 가능하나 영향 분석 속도에 직접 영향 | 팀 선택 |
| `index/_ai_patch.json` | 삭제하면 LLM 분석을 다시 돌려야 함 | 반드시 |
| `reports/*`, `wiki/*` | 재생성 가능 | 보통 미커밋 |
| `indexer-config.json`, `pair_config.md` | 삭제하면 범위·연동 정보 소실 | 인덱스 커밋 시 함께 |

`.gitignore`에 `_workspace/`를 통째로 넣었다면 `_ai_patch.json`이 버려지고 있지 않은지 harness-init Phase 3 보고에서 확인하세요. `.claude/backup/[시각]/`은 `_workspace/` 밖에 있는 재초기화 백업으로 gitignore를 권장합니다.

## 관련 문서

- [하네스가 만드는 것](/concepts/harness-outputs.md)
- [인덱스 파일 스펙](/reference/index-spec.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [크로스 리포 설정](/configuration/pair-config.md)
- [harness-init](/skills/harness-init.md)
- [harness-clean](/skills/harness-clean.md)
