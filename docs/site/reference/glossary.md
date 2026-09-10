# 용어집

AX Navi 문서와 에이전트 리포트에 반복해서 나오는 용어를 모았습니다. 각 항목은 이 플러그인 안에서의 의미만 적었고, 정의의 근거가 되는 파일이나 상세 페이지를 함께 표시했습니다. 외부 제품·프레임워크 일반 용어는 다루지 않습니다.

## 하네스와 산출물

| 용어 | 의미 |
|------|------|
| 하네스(harness) | harness-init이 대상 프로젝트에 생성하는 맞춤 가이드 세트. `CLAUDE.md`, `.claude/ito-guide.md`, 로컬 스킬 3종, `domain-expert.md`, 패턴, 인덱스를 통칭 |
| CLAUDE.md | 매 세션 자동 로드되는 프로젝트 가이드. writer의 `claude_md_fields.json`을 `skills_builder.py`가 조립하며 "## 변경 이력" 표를 유지 |
| ito-guide | `.claude/ito-guide.md`. 이 프로젝트에 맞는 스킬 트리거 예시·시나리오·주의사항을 담은 사용 설명서. `ito_guide.md.template`에서 LLM 없이 조립 |
| domain-expert | `.claude/agents/domain-expert.md`. `01_analyzer_report.md`를 시스템 프롬프트로 그대로 주입한 프로젝트 전용 도메인 에이전트 |
| 로컬 스킬 | 대상 프로젝트 `.claude/skills/`에 배포되는 프로젝트 전용 스킬 3종 `trace`·`scaffolder`·`find-logic`(연동 시 `cross-repo-scaffold`·`cross-repo-modify` 추가). writer가 프로젝트별 트리거로 작성 |
| 전역 스킬 | 플러그인 `skills/<name>/SKILL.md` 한 곳에만 존재하는 스킬. 정적 6종(analyze-impact·safe-modify·scaffold-feature·vibe·plan-migration·review-sql)은 로컬 사본 없이 전역판만 사용 |
| 별칭 스킬 | 절차 없이 args를 본편에 넘기는 얇은 위임 스킬 7종. `/modify`·`/impact`·`/scaffold`·`/find`·`/flow`·`/sql`·`/wiki` |
| AGENTS.md | 세션 진입 시 먼저 읽는 초경량 규약. 모든 프로젝트에서 내용이 같고, 인덱스는 질의 도구로·검증은 `verify-target.mjs`로·수정은 스킬 게이트로 가라는 4원칙 |
| `_workspace/` | 파이프라인 산출물 작업 공간. 에이전트 간 인자 전달이 이 폴더의 파일로 이뤄짐. 상세는 [_workspace 파일 사전](/reference/workspace-files.md) |
| 부분 재실행 | 기존 하네스에서 "스킬만"·"에이전트만"·"validator만"·"패턴만"·"qa만" 등 한 단계만 다시 돌리는 harness-init 모드 |
| 인덱스 리프레시 | "인덱스만 갱신해줘"로 LLM 분석 없이 인덱스를 다시 만들고 `_ai_patch.json`을 재적용하는 모드 |

## 인덱스

| 용어 | 의미 |
|------|------|
| 결정론적 인덱스 | `build-index.mjs`(Node 18+, LLM 미개입)가 소스에서 만드는 `_workspace/index/*.json`. 같은 소스면 같은 결과 |
| 인덱서(indexer) | `agents/lib/build-index.mjs`. `INDEXER_VERSION`(현재 `1.11.0`)이 `_meta.version`에 기록됨 |
| `_meta.json` | 인덱스 전역 매니페스트. tier·복잡도·`adapter_coverage`·`indexes[]`·`source_fingerprint`·`excluded_sources`·`encoding` |
| 소스 지문(source_fingerprint) | 인덱싱 시점 소스 상태의 해시. `--check-stale`이 현재 지문과 비교해 재인덱싱 필요 여부를 판정 |
| stale | 인덱스가 코드보다 오래된 상태. `--check-stale` exit 1, 또는 스킬 리포트의 `지식 모델 stale` WARN |
| 미해결 관계(unresolved) | 이름 해석 후보가 하나로 좁혀지지 않아 인덱서가 엣지를 만들지 않은 관계. `_unresolved.jsonl`에 기록 |
| 판정 그룹(unresolved group) | 같은 `(kind, key_field, candidates)` 조합의 미해결 관계를 묶은 고유 패턴. `_unresolved_groups.json`의 `group_id`로 식별되며 analyzer는 그룹당 한 번 판정 |
| `_ai_patch.json` | analyzer가 제출하는 보강 오퍼레이션(`add_edge`·`resolve_group`·`set_node_note`·`set_endpoint_description` 등). `--apply-ai-patch`로 병합되고 incremental 재인덱싱에도 재적용되는 LLM 산출물 |
| AI 보강(ai-enrichment) | `_ai_patch.json`이 병합된 레코드의 `origin` 값. 인덱서 추출(`deterministic-indexer`)·폴백(`analyzer-fallback`)과 구분 |
| 스코프 좁히기 | 후보가 둘 이상일 때 `same_file`→`same_package`→`same_workspace` 순으로 걸러 하나로 줄면 `confidence: MEDIUM`으로 확정하는 인덱서 규칙 |
| dangling 엣지 | `from`/`to`가 존재하지 않는 노드를 가리키는 엣지. 인덱서 계약상 구조적으로 생기지 않으며 validator가 검증 |
| 벤더 제외 | 라이브러리 배포 디렉터리·미니파이 파일을 인덱싱하지 않는 규칙. `_meta.excluded_sources`에 기록, `vendor_exclude: false`로 해제 |
| 어댑터 커버리지 | 확장자별 결정적 추출 수준. 파일 단위 `FULL`/`PARTIAL`/`UNSUPPORTED`, 전체 상태 `FULL`/`PARTIAL`/`WARN`. `PARTIAL`·`UNSUPPORTED` 대상 변경은 최소 HOLD |
| `query-index.mjs` | 인덱스를 통째로 읽지 않고 `symbol`·`callers`·`callees`·`trace`·`sql`·`table` 등으로 필요한 줄만 조회하는 도구. 상한과 `truncated`를 함께 반환 |
| `verify-target.mjs` | 프로젝트 매니페스트에서 lint/typecheck/test 명령을 `detect`하고 `run`으로 실행해 실패 라인만 압축 반환하는 도구 |

## 패턴

| 용어 | 의미 |
|------|------|
| 패턴 프로필(pattern_profile.json) | `.claude/patterns/pattern_profile.json`. 모듈·레이어·스택 범위별 상태·신뢰도·기준 파일·규칙을 담은 구조화 프로필 |
| preferred / legacy / anti_pattern | 프로필 상태. 현재 따라야 할 기준 / 유지보수 시 이해만 하는 과거 방식 / 복제 금지 |
| reference_files | 프로필이 가리키는 실제 기준 파일 목록(`path`·`reason`). 신규 코드는 이 파일을 읽고 따름 |
| 패턴 스켈레톤 | `skills_builder.py`가 `writer_decisions.json`의 `pattern_files`로 만드는 빈 `.claude/patterns/*.md`. pattern-extractor가 본문을 채움 |
| 프로필 검증 | `pattern_profile.py validate`. 중복 ID·잘못된 상태·프로젝트 밖 경로·없는 기준 파일·빈 규칙을 FAIL 처리하고 `pattern_profile_validation.json`에 기록 |
| 패턴 선택 | `pattern_profile.py select`. 대상 경로·모듈·레이어에 가장 가까운 preferred 프로필을 골라 `reports/pattern_selection.json`에 기록 |
| 적합성 게이트 | 변경 코드가 선택된 프로필과 기준 파일을 따르는지 pattern-conformance가 독립 판정하는 사후 게이트 |

## 판정

| 용어 | 의미 |
|------|------|
| CONFORM / HOLD / FAIL | pattern-conformance 판정. 필수 규칙 준수 / 충돌·LOW 신뢰도·표본 부족 / 레이어 오선택·필수 규칙 위반·안티패턴 복제 |
| GO / HOLD / STOP | change-safety 최종 판정. GO는 종합 점수 < 3·보안 < 5·CONFORM·필수 검증 exit 0이 모두 충족될 때만. 검증 미실행은 HOLD, 필수 검증 실패나 즉시 STOP 트리거는 STOP |
| UNVERIFIED | 테스트·빌드·린트를 실행하지 못한 상태. PASS가 아니며 최소 HOLD |
| 즉시 STOP 트리거 | 한 항목이라도 발견되면 점수와 무관하게 STOP이 되는 항목(운영 DB 직접 수정, 인증 우회 등) |
| 모호성 점수 | spec-clarifier가 범위·목표·제약·레거시·우선순위 5영역 응답을 가중 합산한 값. ≤0.2 GO, 0.21~0.4 REFINE(1회 재질문), >0.4는 GO(미답변 진행) |
| PASS / PARTIAL / RETRY | harness-evaluator 총점 구간. 80~100 / 60~79(타겟 재생성) / 0~59(주요 재생성). 2차 평가 후에는 점수와 무관하게 종료 |
| harness-evaluator 4차원 | 커버리지·정확도·실행가능성·컨텍스트 품질, 각 25점 |
| fix_targets | evaluator가 PARTIAL/RETRY일 때 반환하는 재생성 대상(`analyzer` 또는 `writer`)과 지시 |
| 신뢰도 점수(validator) | validator 리포트의 구조 신뢰도. 50 미만이면 경계 QA를 실행하지 않음 |
| targeted 모드 | analyzer가 지목된 항목만 고치는 좁은 패스(`T-A-PATCH`). Phase A/B 재분석과 리포트 재작성 금지 |
| 인덱스 무결성 게이트 | Phase 4에서 점수와 무관하게 먼저 확인하는 기계 게이트. `index_integrity_fail`·`index_spotcheck_fail`·스키마 실패 등을 원인 소유자(인덱서·analyzer·api-bridge·플러그인)별로 라우팅 |
| Boundary 1~7 | qa의 경계면 교차 비교 항목. 1~4는 스택별, 5는 인덱스 ↔ 코드, 6은 워크플로우 스킬 ↔ 인덱스 의존성(`qa_boundary6.py`), 7은 Legacy Static JS 커버리지 |
| DEAD / ORPHAN | qa가 찾는 불일치. 코드에는 있으나 인덱스·하네스에 없는 것과 그 반대. 자동 수정하지 않음 |

## Tier와 비용

| 용어 | 의미 |
|------|------|
| Tier | 분석 범위 단계. Standard와 Full 두 가지만 존재하고 기본은 Full. 인덱스를 생략하는 Tier는 없음 |
| Standard / Full | analyzer가 스택 해당 Phase B만 수행 / 전체 Phase B 수행. 모델은 같고 wiki·QA는 둘 다 온디맨드 |
| override 키워드 | "빠르게"·"간단히"·"quick"은 Standard, "깊게"·"심층"·"마이그레이션"·"레거시"·"deep"은 Full 강제 |
| 사전 견적 | 인덱싱 직후 `ai-budget.mjs estimate`가 내는 `estimated_tokens`·`estimated_minutes`·`decidable_unresolved`. 사용자가 비용을 알고 결정하는 유일한 지점 |
| AI 호출 예산 | `ai-budget.mjs`가 강제하는 역할당 initial 1회·retry 한도·시간·토큰 한도(견적의 2배). `claim` 실패는 하드 스톱 |
| 사전 배분 장부 | 실사용 토큰을 계측할 수 없어 견적의 역할별 비율(analyzer 60%·writer 25%·pattern-extractor 15%)로 `record`하는 근사치 |
| BEP(손익분기점) | 초기화 비용을 작업당 절감으로 나눈 회수. 문서 기준 Standard 약 7회, Full 약 8회 |

## 팀·파이프라인

| 용어 | 의미 |
|------|------|
| 오케스트레이터 | 사용자 요청을 받아 순서·게이트·후속 작업을 지휘하는 스킬. 에이전트는 경계가 분명한 전문 작업만 수행 |
| pipeline-runner | harness-init의 결정론적 스크립트 블록(`index`·`assemble`·`verify`·`wiki`)을 오케스트레이터 대신 실행하고 요약만 반환하는 에이전트 |
| 블록(block) | pipeline-runner가 실행하는 절차 단위. 상세는 `agents/lib/pipeline-runner/block-*.md` |
| 네임스페이스 호출 | `subagent_type="ax-navi:<에이전트>"`. 에이전트 지침이 서브에이전트 시스템 프롬프트로 자동 로드됨. 미지원 호스트는 `general-purpose` 폴백 |
| 레인(lane) | 분리 저장소 초기화에서 저장소별로 독립 실행되는 파이프라인(`B-*` 백엔드, `C1..CM-*` 클라이언트). 상태는 `pair_lane_state.md` |
| P-BARRIER / P-PAIR / P-REFRESH | 분리 저장소 Phase 3.5 단계. 양쪽 검증 확인 → pair-init 호출 → API 계약·미매칭 갱신 |
| 온디맨드 | 자동 실행되지 않고 사용자가 선택할 때만 실행되는 작업. wiki와 경계 QA가 해당 |

## 크로스 리포와 wiki

| 용어 | 의미 |
|------|------|
| paired-roots | 백엔드 1개 + 클라이언트 1개의 1:1 분리 저장소 구성 |
| hub-roots | 백엔드 1개(hub) + 클라이언트 N개의 1:N 구성. hub 쪽 `pair_config.md`만 `## Partner:` 블록 형식 |
| pair_config | `_workspace/pair_config.md`. 파트너 경로·역할·스택·API 계약 경로. 상세는 [크로스 리포 설정](/configuration/pair-config.md) |
| 파트너(partner) | 연동된 상대 저장소. `partner_root`로 지정 |
| role_label | hub-roots에서 클라이언트를 구분하는 자유 입력 라벨(`web-frontend`·`mobile-ios` 등) |
| API 계약(api_contract) | 백엔드가 제공하는 엔드포인트와 호출처를 담은 `api_contract.json`. api-bridge `extract`가 생성 |
| 드리프트(drift) | 계약과 클라이언트 호출이 어긋난 상태. `shape_match: MISMATCH` 또는 `api_drift_report.md`의 MISSING/MISMATCH/UNUSED |
| wiki | `wiki_generator.py`가 산출물을 변환한 `_workspace/wiki/` 정적 페이지 세트. LLM 없음(선택 해설 페이지만 예외) |
| call-graph.html | 데이터를 인라인 포함한 vis-network 시스템 지도. `file://`로 단독 열람 가능 |
| wiki-hub | 여러 시스템 wiki를 DB(MSSQL/PostgreSQL/Oracle/SQLite)에 버전 관리와 함께 모아 열람하는 별도 런타임. 발행은 플러그인 내장 `wikihub_db/`가 수행 |
| `--pull` | publish-wiki의 역방향. DB에서 wiki와 `_workspace/**/*.json`을 원래 경로로 복원 |

## 관련 문서

- [하네스가 만드는 것](/concepts/harness-outputs.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [패턴 프로필과 적합성 게이트](/concepts/pattern-profiles.md)
- [판정과 게이트](/concepts/gates.md)
- [에이전트 팀과 파이프라인](/concepts/agent-team.md)
- [인덱스 파일 스펙](/reference/index-spec.md)
- [_workspace 파일 사전](/reference/workspace-files.md)
