# 첫 초기화 상세

`harness-init`은 프로젝트를 분석해 맞춤형 하네스를 만드는 오케스트레이터 스킬입니다. 이 페이지는 초기화가 어떤 순서로 진행되는지, 각 단계에서 사용자가 화면에서 보는 것과 답해야 하는 것이 무엇인지, 끝나면 어떤 파일이 생기는지, 그리고 일부만 다시 만들고 싶을 때 어떤 문구를 쓰는지를 다룹니다. 빠르게 따라만 하고 싶다면 [10분 빠른 시작](/getting-started/quickstart.md)으로 충분합니다.

## 시작 전 선택 — 범위를 먼저 정리하고 싶다면

`harness-init`은 `spec-gate`를 자동으로 부르지 않습니다. 초기화 전에 목적·범위·제약을 먼저 정리하고 싶으면 "작업 범위 정해줘" 또는 "요구사항 정리해줘"로 [spec-gate](/skills/spec-gate.md)를 따로 실행한 뒤 초기화를 요청하세요. 초기화 자체는 아래 Phase -1부터 시작합니다.

## 전체 흐름 한눈에

| 단계 | 하는 일 | LLM | 사용자가 보는 것 / 답할 것 |
|------|---------|-----|---------------------------|
| Phase -1 | 프로젝트 구성 확인 | 없음 | 구성 선택 질문 (단일·모노레포·1:1·기타) |
| Phase 0 | 기존 하네스 감지, Tier 키워드 확인, 실행 모드 분기 | 없음 | 재초기화라면 백업 위치 안내 |
| 2-0.5 | 결정론적 전수 인덱싱 (`pipeline-runner` block index) | 없음 | 작업 목록에 `T-I · pipeline-runner · 소스 구조와 호출 관계 인덱싱` |
| 2-0.7 | 사전 견적과 Tier 확인 | 없음 | 파일 수·심볼 수·예상 토큰·예상 분, Full/Standard/중단 선택 |
| 2-1 | `analyzer` — 구조·의존성·레거시 로직 분석 | 사용 | `T-A · analyzer · ...` 진행 표시 |
| 2-1.5 / 2-1.6 | AI 보강 패치 병합, 분석 리포트 기계 조립 | 없음 | 없음 (WARN이 있으면 최종 보고에 표시) |
| 2-2 | `writer` — 로컬 스킬 3종과 CLAUDE.md 필드 생성 | 사용 | `T-W · writer · ...` |
| 2-2.3 | 하네스 파일 조립 (`pipeline-runner` block assemble) | 없음 | `T-W-BUILD · pipeline-runner · 하네스 파일 조립` |
| 2-3 | `pattern-extractor` — 레이어별 컨벤션 패턴 추출 | 사용 | `T-P · pattern-extractor · ...` |
| 2-3.5 | 패턴 프로필·인덱스 기계 검증 (`pipeline-runner` block verify) | 없음 | `T-V-CHECK · pipeline-runner · ...` |
| 2-4 | `validator` — 하네스 구조와 근거 검증 | 사용 | `T-V · MJS validator · ...` |
| 2-5 | `harness-evaluator` — 4차원 품질 평가 | 사용 | `T-E · harness-evaluator · ...` |
| Phase 3 | 결과 종합 보고 | 없음 | 생성 파일·검증 점수·Eval 점수·다음 작업 안내 |
| Phase 3.6 / 3.7 | 선택 작업 메뉴 (wiki·QA) | 선택 시만 | 4개 옵션 중 복수 선택 |
| Phase 4 | 인덱스 무결성 게이트 + 점수 기반 타겟 재생성 (최대 1회) | 조건부 | 1차→2차 점수 변화 |

작업 목록을 지원하는 호스트에서는 위 `T-*` 제목이 진행 상태(pending → in_progress → completed)와 함께 표시되고, 지원하지 않는 호스트에서는 `_workspace/00_pipeline_status.md` 체크리스트가 같은 역할을 합니다.

## Phase -1 — 프로젝트 구성 확인

현재 작업 폴더의 절대경로가 먼저 출력되고, 구성을 묻는 질문이 최대 두 단계로 나옵니다.

| 1차 질문 옵션 | 의미 |
|---------------|------|
| 단일 프로젝트로 초기화 (Recommended) | 지금 폴더 전체를 하나의 프로젝트로 분석 |
| 서버·클라이언트 함께 초기화 (모노레포) | 한 상위 폴더 안의 backend와 frontend 등을 워크스페이스로 통합 분석 |
| 서버·클라이언트 각각 초기화 후 연결 (1:1) | 두 프로젝트를 독립 초기화한 뒤 `pair-init`으로 연결 |
| 기타 (부분 범위 / 허브형 1:N) | 2차 질문으로 이어짐 |

| 2차 질문 옵션 (1차에서 "기타" 선택 시) | 의미 |
|----------------------------------------|------|
| 특정 폴더·모듈만 초기화 | 선택한 상대경로만 분석 |
| 허브형 (1개 중심 + 클라이언트 여러 개, 1:N) | 백엔드 1개 + 웹·모바일·관리자 등 클라이언트 2개 이상을 독립 초기화하고 연결 |

다음 경우에는 이 질문이 생략됩니다.

- `_workspace/00_init_scope.md`가 이미 있는 경우 (이전 구성 확인 완료).
- "스킬만"·"패턴만"·"validator만" 같은 부분 재실행.
- 요청문에 구성과 경로를 이미 명시한 경우.

결과는 `_workspace/00_init_scope.md`에 기록되며, 이후 Tier와 예산 세션 값도 이 파일에 추가됩니다. 분리 저장소(1:1·허브형)를 고르면 파트너 경로 수집과 2-레인 병렬 실행이 추가되는데, 그 절차는 [페어 설정](/configuration/pair-config.md)에서 다룹니다.

## Phase 0 — 컨텍스트 확인

기존 하네스 흔적(`CLAUDE.md`의 "## 변경 이력", `.claude/skills/trace.md`, `_workspace/index/*.json` 등)을 보고 실행 모드를 정합니다.

| 상황 | 모드 | 처리 |
|------|------|------|
| 기존 하네스 없음 | 초기 실행 | 전체 파이프라인 |
| 기존 + "다시"·"새로" | 재초기화 | `.claude/backup/[YYYYMMDD-HHMMSS]/`로 백업 후 전체 실행 |
| 기존 + "스킬만"·"에이전트만"·"validator만"·"qa만"·"패턴만" | 부분 재실행 | 해당 단계만, 이전 `_workspace/` 산출물 재사용 |
| 기존 + 일반 보완 ("하네스 업데이트") | 업데이트 | 백업 후 analyzer incremental + 재실행 |
| 기존 + "인덱스만 갱신해줘"·"인덱스 리프레시" | 인덱스 리프레시 | 인덱스만 갱신, writer·validator·eval 스킵 |

`CLAUDE.md`가 이미 커밋돼 있고 `_workspace/`가 없는 상태, 즉 팀원이 공유 하네스를 pull한 경우에는 전체 초기화를 하지 않습니다. `build-index.mjs --check-stale`로 인덱스 신선도만 확인하고, 필요하면 인덱싱 한 번(LLM 없음)만 돌린 뒤 종료합니다. 사용자가 "하네스 다시 초기화"를 명시한 경우에만 전체 파이프라인으로 갑니다.

Tier는 요청문 키워드가 있으면 여기서 확정됩니다. "빠르게"·"간단히"·"quick"은 Standard, "심층"·"깊게"·"마이그레이션"·"레거시"·"deep"은 Full입니다. 키워드가 없으면 기본 Full이되, 확인 질문은 규모가 확정되는 2-0.7까지 미룹니다.

## 2-0.5 — 결정론적 전수 인덱싱

`build-index.mjs`가 소스 전체를 파싱해 `_workspace/index/`에 `symbols`·`call_graph`·`sql_usage`·`transactions`·`external_io`·`env_branches`·`schema`·`api_contract`·`dead_code`(해당 사실이 있는 것만)와 `_meta.json`·`_analysis_input.json`·`_unresolved.jsonl`을 만듭니다. Vue·C# Razor 같은 스택은 Python 추출기가 노드·엣지를 보강합니다. 이 단계는 LLM을 전혀 쓰지 않으며, 레거시 대형 저장소라도 보통 수십 초에서 수 분 안에 끝납니다.

Node가 없으면 스택별 Python 추출기로, 그것도 불가능하면 인덱스 없이 analyzer가 직접 작성하는 폴백 사다리가 있습니다. 어느 경로로 실행됐는지(`indexer_rank`)는 최종 보고에 포함됩니다.

## 2-0.7 — 사전 견적과 Tier 확인

인덱싱 결과로 파일 수와 판정이 필요한 미해결 관계 수가 확정되면 `ai-budget.mjs estimate`가 예상 토큰과 예상 시간을 계산해 보여 줍니다. 여기서 Full 진행·Standard 진행·중단 중 하나를 고릅니다. 중단을 골라도 인덱스는 남으므로 `analyze-impact`·`trace-logic`은 바로 쓸 수 있습니다. 견적 공식과 규모별 예시는 [Tier와 토큰 비용](/getting-started/tier-and-cost.md)에 있습니다.

## 2-1 ~ 2-1.6 — analyzer와 리포트 조립

`analyzer`는 기계 인덱스를 다시 쓰지 않습니다. `_unresolved.jsonl`에 남은 미해결 관계를 판정해 `_ai_patch.json`으로만 내고, `_workspace/01_analyzer_report.md`를 작성합니다. 그 뒤 `build-index.mjs --apply-ai-patch`가 패치를 인덱스에 병합하고(`_meta.json`의 `ai_enrichment`에 기록), `analyzer_index_summary.py --assemble-report`가 리포트의 인덱스 요약 구간을 최신 값으로 채웁니다. 패치가 전부 거부되면 WARN으로 보고하고 계속 진행합니다.

## 2-2 ~ 2-2.3 — writer와 하네스 파일 조립

`writer`는 `.claude/skills/trace.md`·`scaffolder.md`·`find-logic.md`만 직접 작성합니다. `CLAUDE.md`에 들어갈 필드는 `_workspace/claude_md_fields.json`으로, 조건부 스킬 적용 여부와 패턴 파일 목록은 `_workspace/writer_decisions.json`으로 냅니다. 이어서 `skills_builder.py`(block assemble)가 다음을 LLM 없이 조립합니다.

- `CLAUDE.md` (템플릿 + 필드, 기존 "## 변경 이력" 표는 이어 붙임).
- `.claude/agents/domain-expert.md` (분석 리포트를 그대로 주입).
- `.claude/patterns/*.md` 스켈레톤 (Legacy Static JS 탐지 시 `client_pattern.md` 추가).
- `.claude/ito-guide.md` (이 프로젝트용 사용 설명서).
- `_workspace/02_writer_files.md`.

`analyze-impact`·`safe-modify`·`scaffold-feature`·`vibe`·`plan-migration`·`review-sql`은 플러그인 전역 스킬이라 로컬 파일을 만들지 않고 `CLAUDE.md`의 자동 워크플로우 표에 이름만 등록됩니다.

## 2-3 ~ 2-3.5 — pattern-extractor와 기계 검증

`pattern-extractor`가 스켈레톤을 실제 코드 근거로 채우고 `.claude/patterns/pattern_profile.json`과 `_workspace/05_patterns_extracted.md`를 만듭니다. 이어서 block verify가 `pattern_profile.py validate`(근거 파일이 실제로 존재하는지), `validator_checks.py`(체크 1~4·6~9 기계 실행), `validate-harness.mjs`(인덱스 JSON 스키마 검증)를 차례로 돌립니다. 프로필 검증이 실패하면 pattern-extractor에 1회 보완을 시키고, 두 번째도 실패하면 파이프라인을 FAIL로 다룹니다.

## 2-4 ~ 2-5 — validator와 harness-evaluator

`validator`는 기계 검증 결과를 옮겨 적고 LLM 판단이 필요한 항목(체크 5·10 일부)만 직접 판단해 `_workspace/03_validator_report.md`를 씁니다. `harness-evaluator`는 커버리지·정확도·실행가능성·컨텍스트 품질 각 25점, 총 100점으로 채점해 `_workspace/06_eval_report.md`를 씁니다. 두 단계 모두 Tier와 무관하게 항상 실행됩니다.

## Phase 3 — 결과 보고

생성 파일 목록, 사용 가능한 워크플로우 스킬, 인덱스 파일과 노드·엣지 수, validator 신뢰도, 패턴 프로필 검증 결과, Eval 점수, 다음 작업 안내가 한 번에 출력됩니다. AI 예산이 초기화됐다면 `AI 예산 증적` 한 줄도 함께 나옵니다. 보고에서 특히 확인할 것은 두 가지입니다.

- HIGH 우선순위 보완 항목이 있으면 명시적으로 안내되지만 자동 수정은 하지 않습니다.
- `_workspace/index/_ai_patch.json`이 `.gitignore`에 걸려 버려지고 있지 않은지 확인하라는 안내가 포함됩니다. 이 파일은 LLM 판정 결과라 다시 만들려면 분석을 다시 돌려야 합니다.

## Phase 3.6 / 3.7 — 선택 작업 메뉴

기본 파이프라인에 포함되지 않는 후속 작업을 한 번의 질문으로 제시합니다. 복수 선택이 가능하며 고르지 않은 항목은 실행하지 않습니다.

| 옵션 | 내용 |
|------|------|
| 지금 안 함 (Recommended) | 초기화만 마칩니다. 새 세션에서 따로 실행하는 편이 저렴합니다 |
| wiki 생성 | 산출물을 정적 wiki 페이지로 변환합니다 (LLM 없음) |
| wiki 생성 + AI 해설 | 시스템 개요 내러티브 페이지를 더합니다 (약 5~10K 토큰) |
| 경계 QA | writer 주장이 실제 코드·인덱스와 일치하는지 교차 검증합니다 |

validator 신뢰도가 50 미만이면 경계 QA는 선택해도 실행되지 않고 사유만 기록됩니다. wiki가 실제로 생성되면 중앙 허브 발행 여부를 이어서 묻습니다.

## Phase 4 — 품질 루프

먼저 인덱스 무결성 기계 게이트가 점수와 무관하게 적용됩니다. dangling edge·스키마 실패 같은 신호가 있으면 원인 소유자에 따라 인덱서 재실행(LLM 없음) 또는 analyzer targeted 재실행(지목 항목만 보정) 중 하나를 1회 수행합니다. 그다음 Eval 총점으로 분기합니다.

| 총점 | 결정 | 동작 |
|------|------|------|
| 80~100 | PASS | 완료 |
| 60~79 | PARTIAL | fix_targets 기반 특정 에이전트 재실행 → 재평가 1회 |
| 0~59 | RETRY | fix_targets 상위 2개 재실행 → 재평가 1회 |

2차 평가 후에는 점수와 무관하게 종료합니다. 재생성 후 점수가 오히려 낮아지면 초기 결과를 유지하고 두 점수를 모두 보고합니다. 보고에는 `63/100 → 84/100 (+21, PARTIAL→PASS)` 형식으로 변화가 표시됩니다.

## 생성되는 파일 트리

```text
프로젝트/
├── CLAUDE.md                          ← 핵심 가이드 (커밋 권장)
├── .claude/
│   ├── ito-guide.md                   ← 이 프로젝트용 사용 설명서
│   ├── skills/
│   │   ├── trace.md                   ← 처리 흐름 추적 (프로젝트 전용)
│   │   ├── scaffolder.md              ← 스캐폴딩 체크리스트
│   │   └── find-logic.md              ← 코드 위치 탐색
│   ├── agents/
│   │   └── domain-expert.md           ← 도메인 지식 (분석 리포트 주입)
│   ├── patterns/
│   │   ├── controller_pattern.md · service_pattern.md · dao_pattern.md ...
│   │   ├── client_pattern.md          ← Legacy Static JS 탐지 시만
│   │   └── pattern_profile.json       ← 모듈·레이어별 preferred 프로필과 실제 기준 파일
│   └── backup/                        ← 재초기화 시 이전 버전 (gitignore 권장)
└── _workspace/                        ← 분석 산출물 (gitignore 권장, 단 아래 주의)
    ├── 00_init_scope.md · 01_analyzer_report.md · 02_writer_files.md
    ├── 03_validator_report.md · 05_patterns_extracted.md · 06_eval_report.md
    ├── 04_qa_report.md                ← 경계 QA를 선택한 경우만
    ├── ai-budget.json · validator_schema.json · pattern_profile_validation.json
    └── index/
        ├── call_graph.json · symbols.json · sql_usage.json · transactions.json
        ├── external_io.json · env_branches.json · schema.json · dead_code.json ...
        ├── _meta.json · _analysis_input.json · _unresolved.jsonl
        └── _ai_patch.json             ← analyzer 판정 결과 (버려지지 않게 주의)
```

각 파일의 역할은 [하네스 산출물](/concepts/harness-outputs.md)과 [워크스페이스 파일](/reference/workspace-files.md)에서 자세히 다룹니다.

## 재초기화와 부분 재실행

전체를 다시 돌리지 않고 필요한 단계만 요청할 수 있습니다. 모두 `harness-init` 트리거이며, Tier와 예산 세션은 `00_init_scope.md`의 기록을 재사용해 다시 묻지 않습니다.

| 문구 | 실행 범위 | 언제 |
|------|-----------|------|
| "인덱스만 갱신해줘" / "인덱스 리프레시" | 인덱스 증분 갱신만 | 코드를 고친 뒤 영향도·추적 결과가 최신이길 원할 때 |
| "스킬만 다시 생성" | writer + 조립 | 로컬 스킬 3종의 설명이 낡았을 때 |
| "패턴만 다시" / "패턴 추출해줘" | pattern-extractor + 프로필 검증 | 팀 컨벤션이 바뀌어 `patterns/`가 옛 규칙을 가리킬 때 |
| "validator만 실행" | validator만 | 수동으로 하네스 파일을 고친 뒤 구조를 다시 점검할 때 |
| "하네스 업데이트" / "하네스 보완" | 백업 후 incremental 분석 + 재실행 | 기능이 대거 추가됐을 때 |
| "하네스 다시 초기화해줘" | 백업 후 전체 재실행 | 마이그레이션 완료 등 구조가 크게 바뀌었을 때 |

재초기화·업데이트 시 `CLAUDE.md`의 "## 변경 이력" 표는 기존 행을 유지하고 이번 실행 행만 추가됩니다. 표 형식이 깨져 파싱에 실패하면 `WARN`이 출력되니 그때는 `.claude/backup/`에서 이력을 복원하세요.

## 관련 문서

- [10분 빠른 시작](/getting-started/quickstart.md)
- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [harness-init 스킬](/skills/harness-init.md)
