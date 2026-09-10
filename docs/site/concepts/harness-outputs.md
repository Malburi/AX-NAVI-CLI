# 하네스가 만드는 것

`harness-init`을 한 번 실행하면 대상 프로젝트에 세 묶음의 파일이 생긴다. Claude가 매 대화마다 읽는 안내 파일(`CLAUDE.md`·`AGENTS.md`), 프로젝트 전용 로컬 스킬·에이전트·패턴(`.claude/`), 그리고 분석 산출물과 인덱스(`_workspace/`)다. 이 문서는 각 파일이 무엇이고 누가 만들며, 무엇을 git에 올리고 무엇을 무시해야 하는지 정리한다.

## 한눈에 보기

| 경로 | 만드는 주체 | 내용 | 커밋 |
|------|------|------|------|
| `CLAUDE.md` | writer(필드) + `skills_builder.py`(조립) | 프로젝트 가이드, 매 대화 자동 로드 | 권장 |
| `AGENTS.md` | `skills_builder.py`(템플릿 복사) | 세션 진입 시 읽는 초경량 규약 | 권장 |
| `.claude/skills/{trace,scaffolder,find-logic}.md` | writer | 프로젝트 전용 로컬 스킬 3종 | 권장 |
| `.claude/agents/domain-expert.md` | `skills_builder.py`(리포트 복사) | 분석 리포트를 그대로 주입한 도메인 에이전트 | 권장 |
| `.claude/patterns/*.md` | `skills_builder.py`(스켈레톤) + pattern-extractor(본문) | 레이어별 코딩 컨벤션 | 권장 |
| `.claude/patterns/pattern_profile.json` | pattern-extractor | 구조화 패턴 프로필과 실제 기준 파일 | 권장 |
| `.claude/ito-guide.md` | `skills_builder.py`(템플릿 조립) | 이 프로젝트용 하네스 사용 설명서 | 권장 |
| `.claude/backup/` | harness-init 재초기화 | 이전 하네스 백업 | 무시 |
| `_workspace/index/` | `build-index.mjs` + analyzer 패치 | 결정론적 인덱스 | 팀 결정(`_ai_patch.json`은 필수) |
| `_workspace/*.md`, `*.json` | 각 에이전트·스크립트 | 파이프라인 리포트와 결정 값 | 참조용 |
| `_workspace/reports/` | 작업용 에이전트 | 영향도·안전성·SQL 리뷰 등 작업 리포트 | 무시 가능 |
| `_workspace/wiki/` | `generate-wiki` | 정적 wiki 페이지 | 무시 |

## CLAUDE.md — 매 대화에 자동으로 읽히는 가이드

`CLAUDE.md`는 Claude Code가 프로젝트를 열 때마다 읽는 파일이라 하네스의 핵심이다. 골격은 `agents/lib/claude_md.md.template`에 있고 섹션 순서는 다음과 같다.

| 순서 | 섹션 | 내용 | 채우는 쪽 |
|------|------|------|------|
| 1 | 자동 워크플로우 | 상황별 스킬 표(trace·find-logic·scaffolder·analyze-impact·safe-modify·scaffold-feature·vibe·cross-repo). `plan-migration`·`review-sql` 행은 조건부 | 템플릿 고정 |
| 2 | 작업 프로토콜 (인덱스 우선) | `--check-stale` → `query-index.mjs` 질의 → 실물 대조 3단계 | 템플릿 고정 |
| 3 | 프로젝트명 — 한 줄 설명 | 프로젝트 식별 | writer |
| 4 | 기술 스택 | 언어·프레임워크·DB 2~3줄 | writer |
| 5 | 요청 흐름 | Controller → Service → DAO → DB 경로 | writer |
| 6 | 주요 파일 위치 | 레이어별 실제 경로 표 | writer |
| 7 | 빌드 / 실행 | 빌드·실행 명령 | writer |
| 8 | 작업 시 주의사항 | 분석 리포트의 "보완 권장(자동 탐지 불가)" 중 중요 항목 | writer |
| 9 | 파트너 섹션 | `pair_config.md`가 있을 때만 | 스크립트 |
| 10 | 변경 이력 | 날짜·변경 내용·대상·사유 표 | 스크립트 |

앞부분의 고정 블록을 모든 프로젝트에서 동일하게 두는 이유는 프롬프트 캐싱이다. 접두사가 일치할 때 캐시 할인이 적용되므로 프로젝트별 정보는 구분선 아래부터 시작한다.

writer는 이 파일을 마크다운으로 직접 쓰지 않는다. `_workspace/claude_md_fields.json`에 `project_name`·`one_line_desc`·`tech_stack_summary`·`request_flow`·`file_locations_rows`·`build_run`·`cautions` 일곱 필드만 채우고, `skills_builder.py`가 템플릿과 조립한다. 재초기화나 업데이트 때는 기존 `## 변경 이력` 표의 데이터 행을 추출해 이어 붙이고 이번 실행 행만 추가한다.

## AGENTS.md — 세션 진입 규약

`agents/lib/agents.md.template`을 필드 치환 없이 그대로 복사한 파일이다. 세션 진입 시 먼저 읽는 초경량 규약이며 네 가지 원칙만 담는다.

1. 인덱스를 통째로 열지 않고 `query-index.mjs`로 필요한 줄만 조회한다. 규모는 `summary`로 먼저 가늠한다.
2. 전체 파일을 읽지 않고 `symbol` 조회로 시그니처·위치만 본다.
3. 검증은 로컬 먼저, 실패 라인만 본다. `verify-target.mjs detect`로 명령을 감지하고 `run`으로 실행해 `overall`과 `fail_lines`만 확인한다.
4. 수정은 `safe-modify`, 신규 기능은 `scaffold-feature`, 빠른 처리는 `vibe` 게이트를 탄다.

프로젝트별로 달라질 내용이 없어 모든 프로젝트에서 동일하며, 이 역시 캐싱 접두사 역할을 한다.

## .claude/skills/ — 로컬 스킬은 3종만

하네스가 대상 프로젝트에 파일로 배포하는 스킬은 `trace.md`·`scaffolder.md`·`find-logic.md` 셋뿐이다.

| 스킬 | 역할 | 프로젝트 전용인 이유 |
|------|------|------|
| `trace` | 요청 흐름을 진입점부터 단계별로 탐색(스택별 분기) | 이 프로젝트의 실제 클래스·메서드 ID로 `query-index.mjs` 명령 예시를 최소 2개 담는다 |
| `scaffolder` | 신규 기능 파일 체크리스트(기본형) | 탐지된 스택·레이어 구성이 프로젝트마다 다르다 |
| `find-logic` | 쿼리·route에서 코드로 가는 역방향 탐색 | 실제 인덱스 경로와 심볼을 예시로 쓴다 |

세 파일 모두 frontmatter에 `name`·`description`·`model` 세 필드를 반드시 갖고, description은 한국어 트리거 3개 이상·영어 2개 이상·스택 키워드 1개 이상을 충족해야 한다(validator가 검사한다).

반대로 `analyze-impact`·`safe-modify`·`scaffold-feature`·`vibe`·`plan-migration`·`review-sql`은 프로젝트별 변수가 없는 고정 텍스트라 플러그인 전역판 하나만 존재한다. writer와 `skills_builder.py`는 이 여섯 파일을 복사하지 않으며, 커밋할 대상 자체가 없다. writer가 판단하는 것은 `plan-migration`(마이그레이션 후보 스택 식별 시)과 `review-sql`(DB/ORM 사용 확인 시)을 `CLAUDE.md` 표와 `ito-guide.md`에 권장 항목으로 올릴지 여부만이며, 결과는 `writer_decisions.json`의 `plan_migration`·`review_sql` 필드에 남는다.

`trace-logic`의 슬래시 별칭이 `/trace`가 아니라 `/flow`인 것도 이 로컬 `trace` 스킬과 이름이 충돌하기 때문이다.

## .claude/agents/domain-expert.md

`_workspace/01_analyzer_report.md`를 frontmatter만 붙여 그대로 주입한 파일이다. writer가 같은 내용을 다시 타이핑하는 것은 중복이라 `skills_builder.py`의 `deploy_domain_expert()`가 복사로 만든다. 다른 에이전트가 프로젝트 맥락이 필요할 때 참조하며, `"domain-expert에게: 외부 연동 인터페이스들의 역할을 설명해줘"`처럼 직접 호출할 수도 있다. 코드가 크게 바뀌어 analyzer를 다시 돌리면 이 파일도 함께 갱신된다.

## .claude/patterns/ — 패턴 문서와 구조화 프로필

두 종류가 함께 생긴다.

- `.claude/patterns/*.md`는 사람이 읽는 레이어별 상세 패턴이다. 파일명 목록(`controller_pattern.md`·`service_pattern.md`·`dao_pattern.md`·`test_pattern.md` 등)은 writer가 탐지된 스택에 실제로 존재하는 레이어만 골라 `writer_decisions.json`의 `pattern_files`에 기록하고, 스켈레톤 헤더는 `skills_builder.py`가 조립하며, 본문은 pattern-extractor가 채운다. 분석 리포트에 `LegacyStaticJS` 분류가 있으면 `client_pattern.md`가 자동 추가된다.
- `.claude/patterns/pattern_profile.json`은 도구가 검증·선택하는 구조화 프로필이다. 모듈·레이어별 `preferred`/`legacy`/`anti_pattern` 상태와 실제 기준 파일(`reference_files`)을 담는다.

상세는 [패턴 프로필과 적합성 게이트](/concepts/pattern-profiles.md)를 참조한다.

## .claude/ito-guide.md

`agents/lib/ito_guide.md.template`을 이미 배포된 스킬 목록과 `claude_md_fields.json` 값만으로 조립한 사용 설명서다. LLM을 쓰지 않는다. 스킬별 용도와 트리거 문장, `domain-expert` 직접 호출 시나리오가 들어 있어 팀원이 처음 하네스를 받았을 때 읽기 좋다.

## _workspace/ — 분석 산출물

| 파일 | 내용 | 만드는 쪽 |
|------|------|------|
| `00_init_scope.md` | 프로젝트 구성 확인 결과, Tier, `ai_budget_session` | harness-init Phase -1 |
| `00_stack_precheck.json` | 인덱서가 어느 순위(폴백)로 실행됐는지 | pipeline-runner `index` 블록 |
| `indexer-config.json` | 인덱서 설정(포함 경로·워크스페이스·제외 옵션) | pipeline-runner `index` 블록 |
| `index/` | 결정론적 인덱스 12종 + 제어 파일 + `_ai_patch.json` | `build-index.mjs`, analyzer |
| `ai-budget.json` | AI 호출 예산 장부(session·limits·used·claims) | `ai-budget.mjs` |
| `01_analyzer_report.md` | 전체 분석 리포트 | analyzer + `analyzer_index_summary.py` |
| `claude_md_fields.json` | CLAUDE.md 서술형 필드 7개 | writer |
| `writer_decisions.json` | 탐지 스택, 패턴 파일명, 조건부 스킬 적용 여부와 사유 | writer |
| `02_writer_files.md` | 생성 파일 목록 보고 | `skills_builder.py` |
| `05_patterns_extracted.md` | 패턴 추출 집계(샘플 수·신뢰도·안티패턴 수) | pattern-extractor + `pattern_tally.py` |
| `pattern_profile_validation.json` | 구조화 프로필 기계 검증 결과 | `pattern_profile.py validate` |
| `validator_schema.json` | 인덱스 JSON 스키마 검증 결과 | `validate-harness.mjs` |
| `03_validator_report.md` | 구조 검증 결과와 신뢰도 | validator |
| `06_eval_report.md` | 품질 평가 점수(커버리지·정확도·실행가능성·컨텍스트 품질) | harness-evaluator |
| `04_qa_report.md` | 경계면 QA 결과, 선택 작업으로 실행한 경우만 | qa |
| `07_wiki_build.md` | wiki 생성 결과, 선택 작업으로 실행한 경우만 | `wiki_generator.py` |
| `reports/` | `impact_<slug>.md`·`safety_<slug>.md`·`pattern_conformance_<slug>.md`·`sql_review_<slug>.md`·`pattern_selection.json` 등 작업 리포트 | 작업용 에이전트·스크립트 |
| `wiki/`, `wiki_prev/` | 정적 wiki와 1세대 백업 | `generate-wiki` |

재초기화 때는 기존 `_workspace/`가 `_workspace_prev/`로 옮겨지고 새로 만들어진다. 부분 재실행은 기존 산출물을 그대로 재사용한다.

## 무엇을 커밋하고 무엇을 무시할까

원칙은 하나다. LLM을 다시 돌려야 복원되는 것은 커밋하고, 스크립트가 수십 초에 다시 만들 수 있는 것은 팀이 정한다.

| 분류 | 대상 | 이유 |
|------|------|------|
| 반드시 커밋 | `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `.claude/agents/`, `.claude/patterns/`, `.claude/ito-guide.md` | analyzer·writer·pattern-extractor의 LLM 산출물. 팀원이 pull하면 초기화 없이 바로 쓴다 |
| 반드시 커밋 | `_workspace/index/_ai_patch.json` | analyzer가 미해결 관계를 판정한 결과. 다시 만들려면 LLM 분석을 다시 돌려야 한다 |
| 팀 결정 | `_workspace/index/*.json` 나머지 | 결정론적이라 팀원이 `--check-stale` 후 수십 초면 재생성한다. 경로가 루트 기준 상대경로라 이식 가능하지만 대형 레거시에서는 수십~수백 MB가 될 수 있다 |
| 참조용 보관 | `_workspace/01_analyzer_report.md` 등 리포트 | 커밋해도 되지만 `domain-expert.md`에 같은 내용이 있다 |
| 무시 권장 | `.claude/backup/`, `_workspace_prev/`, `_workspace/wiki/`, `_workspace/wiki_prev/`, `_workspace/reports/` | 백업·재생성 가능 산출물·개인 작업 리포트 |

`.gitignore`에 `_workspace/`를 통째로 넣으면 `_ai_patch.json`까지 버려진다. harness-init은 Phase 3 보고에서 이 파일이 무시 규칙에 걸려 있지 않은지 확인시킨다. 인덱스를 커밋하지 않기로 했다면 다음처럼 예외를 둔다.

```gitignore
.claude/backup/
_workspace_prev/
_workspace/wiki/
_workspace/wiki_prev/
_workspace/reports/
_workspace/index/*.json
_workspace/index/_unresolved.jsonl
!_workspace/index/_ai_patch.json
```

팀원이 공유 하네스를 pull한 뒤에는 전체 초기화가 아니라 `--check-stale` 한 번으로 시작한다. exit 0이면 그대로 쓰고, exit 1이면 `index` 블록만 다시 돌리며 저장소에 있는 `_ai_patch.json`은 `--mode incremental`이 자동 병합한다. 인덱스와 패치가 git에 없고 wiki-hub DB에 발행돼 있으면 `publish-wiki`의 `--pull`이 대체 경로다.

## 관련 문서

- [첫 초기화](/getting-started/first-harness.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [패턴 프로필과 적합성 게이트](/concepts/pattern-profiles.md)
- [워크스페이스 파일 목록](/reference/workspace-files.md)
- [인덱스 갱신](/configuration/index-refresh.md)
