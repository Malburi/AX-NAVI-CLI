# harness-init

프로젝트 코드베이스를 심층 분석해 맞춤형 하네스(CLAUDE.md, 로컬 스킬 3종, 도메인 에이전트, 패턴, 인덱스)를 자동 생성하는 팀 모드 오케스트레이터다. 처음 투입된 프로젝트에서 가장 먼저 실행하며, 이후 코드가 크게 바뀌었거나 패턴·인덱스만 다시 만들어야 할 때도 같은 스킬을 부분 재실행 모드로 쓴다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 초기 실행 | "하네스 초기화", "하네스 만들어줘", "프로젝트 분석해서 설정해줘", "이 프로젝트 Claude 설정해줘", "create harness", "initialize harness", "generate project harness" |
| 재초기화 | "하네스 다시 초기화", "harness 다시 만들어줘", "re-initialize harness" |
| 업데이트·보완 | "하네스 업데이트", "하네스 보완" |
| 부분 재실행 | "스킬만 다시 생성", "에이전트만 다시 생성", "validator만 다시 실행", "패턴 추출해줘", "pattern extract" |
| 인덱스 리프레시 | "인덱스만 갱신해줘", "인덱스만 다시", "인덱스 리프레시" |
| Tier 강제 | "빠르게"·"간단히"·"quick"·"fast"는 Standard, "깊게"·"심층"·"마이그레이션"·"레거시"·"전체"·"deep"은 Full |
| 슬래시 호출 | `/ax-navi:harness-init` |
| 자동 트리거 | `.claude/skills/trace.md`가 없으면 자동 트리거된다. |

별칭은 없다. 작업 전 목적·범위를 먼저 정리하고 싶으면 [spec-gate](/skills/spec-gate.md)를 독립적으로 먼저 호출한다. harness-init이 spec-gate를 자동 호출하지는 않는다.

## 실행 흐름

실행 모드는 에이전트 팀이다. `TaskCreate` 의존성으로 작업 그래프를 만들고 `_workspace/` 파일로 산출물을 전달한다. 필수 파이프라인은 analyzer → writer → pattern-extractor + 프로필 검증 → validator이고, 품질 루프로 harness-evaluator가 붙는다.

### Phase -1 ~ Phase 1. 구성 확인과 계획

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase -1 | 현재 작업 폴더 절대경로를 출력하고 초기화 구성을 2단계 질문으로 확인한다. 결과를 `_workspace/00_init_scope.md`에 기록한다. | `AskUserQuestion` | 1차 질문에서 단일·모노레포·1:1·기타 중 선택한다. "기타"면 2차 질문에서 부분 범위·허브형(1:N)을 고른다. |
| Phase 0 Step 2 | 기존 하네스 감지. `CLAUDE.md`의 "## 변경 이력", `.claude/skills/trace.md`, `.claude/ito-guide.md`, `_workspace/index/*.json`, `_workspace/pair_config.md` 존재를 확인한다. | 파일 검사 | 없음 |
| Phase 0 Step 2.2 | 공유 하네스 이어받기. `CLAUDE.md`가 커밋돼 있고 `_workspace/`가 없으면 전체 초기화를 하지 않고 `--check-stale`만 확인한다. | `build-index.mjs --check-stale` | 없음 |
| Phase 0 Step 2.5 | Tier 결정. override 키워드가 있으면 즉시 확정하고, 없으면 기본 Full로 두되 확인은 인덱싱 뒤 2-0.7에서 한다. | 키워드 매칭 | 없음(이 시점) |
| Phase 0 Step 3 | 실행 모드 분기(초기 실행 / 재초기화 / 부분 재실행 / 업데이트 / 인덱스 리프레시). 재초기화·업데이트는 `.claude/backup/[YYYYMMDD-HHmmss]/`로 백업한다. | 파일 이동·복사 | 없음 |
| Phase 1 | 작업 그래프 생성. T-I → T-A → T-W → T-P → T-V → T-E 순으로 의존성을 건다. | `TaskCreate` | 없음 |

Phase -1은 `_workspace/00_init_scope.md`가 이미 있거나, 부분 재실행이거나, 재초기화에 "다시"만 붙었거나, 요청문에 구성과 경로를 이미 명시한 경우 건너뛴다.

### Phase 2. 팀원 실행

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| 2-0.5 (T-I) | 결정론적 전수 인덱싱. LLM을 쓰지 않고 `_workspace/index/*.json`을 만든다. | [pipeline-runner](/agents/pipeline-runner.md) `block: index` | 없음 |
| 2-0.7 | 사전 견적 및 진행 확인. 파일 수·예상 토큰·예상 분을 보여주고 Full / Standard / 중단을 묻는다. | `ai-budget.mjs estimate` | **여기가 비용을 알고 결정하는 유일한 지점이다.** `1`·무응답은 Full, `2`는 Standard, `3`은 중단이다. |
| 2-1 (T-A) | 프로젝트 구조·의존성·레거시 로직 분석. 기계 인덱스가 있으면 `_ai_patch.json`만 출력한다. | [analyzer](/agents/analyzer.md) | 없음 |
| 2-1.5 | AI 보강 patch 병합. 기존 노드 사이의 엣지만 추가된다. | `build-index.mjs --apply-ai-patch` | 없음 |
| 2-1.6 | 분석 리포트 기계 조립. `[SECTION_B_INDEX_SUMMARY_INSERT]`를 최신 인덱스 요약으로 교체한다. | `analyzer_index_summary.py --assemble-report` | 없음 |
| 2-2 (T-W) | 하네스 파일과 프로젝트 가이드 생성. trace/scaffolder/find-logic 스킬을 직접 쓰고, CLAUDE.md 필드와 결정 값은 JSON으로 낸다. | [writer](/agents/writer.md) | 없음 |
| 2-2.3 (T-W-BUILD) | CLAUDE.md · domain-expert.md · 패턴 스켈레톤 · ito-guide.md · 02_writer_files.md 조립. | [pipeline-runner](/agents/pipeline-runner.md) `block: assemble` | 없음 |
| 2-3 (T-P) | 레이어별 컨벤션 패턴 추출. 패턴 본문과 `pattern_profile.json`을 채운다. | [pattern-extractor](/agents/pattern-extractor.md) | 없음 |
| 2-3.5 (T-V-CHECK) | 패턴 프로필과 인덱스 기계 검증. `PROFILE_FAIL` 1회차는 pattern-extractor에 보완을 시키고, 2회차는 FAIL로 다룬다. | [pipeline-runner](/agents/pipeline-runner.md) `block: verify` | 없음 |
| 2-4 (T-V) | 하네스 구조와 근거 검증. | [validator](/agents/validator.md) | 없음 |
| 2-5 (T-E) | harness 품질 평가. 모든 Tier에서 실행한다. | [harness-evaluator](/agents/harness-evaluator.md) | 없음 |

Tier는 Standard와 Full 2단계만 있고 기본은 Full이다. Standard는 analyzer가 스택 해당 Phase B만 분석하고, Full은 전체 분석 범위를 유지한다. 두 Tier 모두 모델은 `claude-sonnet-5`로 고정이며, 인덱스를 생략하는 Tier는 없다.

### Phase 3 ~ Phase 4. 보고, 선택 작업, 품질 루프

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 3 | 결과 종합 보고. 생성 파일, 인덱스, validator 신뢰도, 패턴 추출 결과, Eval 점수를 한 화면에 보인다. | 리포트 읽기 | 피드백 요청에 답할 수 있다. |
| Phase 3.5 | 파트너 연동(P-BARRIER → P-PAIR → P-REFRESH). `paired-roots`·`hub-roots`에서만 진행한다. | `references/split-repo.md` 절차 | 구성에 따라 연동 여부를 묻는다. |
| Phase 3.6 | 선택 작업 안내. "지금 안 함 / wiki 생성 / wiki 생성 + AI 해설 / 경계 QA" 4개 옵션을 한 번에 묻는다. | `AskUserQuestion` (`multiSelect: true`) | 고르지 않으면 둘 다 실행하지 않는다. |
| Phase 3.7 | 선택된 것만 실행한다. wiki가 생성되면 중앙 허브 발행 여부를 이어서 묻는다. | [pipeline-runner](/agents/pipeline-runner.md) `block: wiki`, [qa](/agents/qa.md) | 허브 발행 Y면 [publish-wiki](/skills/publish-wiki.md)로 위임한다. |
| Phase 4 게이트 | 인덱스 무결성 기계 게이트. 점수와 무관하게 `index_integrity_fail`·`index_spotcheck_fail`·스키마 FAIL을 먼저 확인하고 원인 소유자(인덱서 / analyzer / api-bridge / 플러그인)에 맞게 조치한다. | `block: index` 재실행 또는 analyzer `mode: targeted` (T-A-PATCH) | 없음 |
| Phase 4 점수 | 80~100은 PASS로 완료, 60~79는 PARTIAL로 타겟 재생성 1회, 0~59는 RETRY로 상위 2개 에이전트 재실행 1회다. 재평가는 1회만 하고 무한 루프는 없다. | analyzer·writer 재실행, harness-evaluator 2차 | 없음 |

## 입력과 산출물

### 읽는 파일

| 파일 | 용도 |
|------|------|
| `_workspace/00_init_scope.md` | 이전 구성 확인 결과와 `tier:`·`ai_budget_session` 재사용 |
| `_workspace/00_spec_report.md` | spec-gate를 먼저 돌렸으면 harness-evaluator가 품질 평가에 반영한다. |
| `CLAUDE.md`, `.claude/skills/trace.md`, `.claude/ito-guide.md` | 기존 하네스 감지 |
| `_workspace/index/*.json` | 인덱스 존재 여부와 신선도(`--check-stale`) |
| `_workspace/pair_config.md` | 파트너 프로젝트 연동 상태 |
| `_workspace/index/_ai_patch.json` | analyzer가 미해결 관계를 판정한 결과. 재인덱싱 시 자동 병합된다. |

### 쓰는 파일

| 파일 | 만드는 단계 |
|------|-------------|
| `CLAUDE.md` | 2-2.3 조립 |
| `.claude/ito-guide.md` | 2-2.3 조립(사용 설명서) |
| `.claude/skills/trace.md`, `scaffolder.md`, `find-logic.md` | 2-2 writer |
| `.claude/skills/cross-repo-scaffold.md`, `cross-repo-modify.md` | 2-2 writer(`pair_config.md` 있을 때만) |
| `.claude/agents/domain-expert.md` | 2-2.3 조립 |
| `.claude/patterns/*.md`, `.claude/patterns/pattern_profile.json` | 2-2.3 스켈레톤, 2-3 본문 |
| `.claude/backup/[YYYYMMDD-HHmmss]/` | 재초기화·업데이트 시 백업 |
| `_workspace/00_init_scope.md` | Phase -1 |
| `_workspace/01_analyzer_report.md` | 2-1 analyzer |
| `_workspace/02_writer_files.md` | 2-2.3 조립 |
| `_workspace/03_validator_report.md` | 2-4 validator |
| `_workspace/04_qa_report.md` | 3.7 qa(선택 시만) |
| `_workspace/05_patterns_extracted.md` | 2-3 pattern-extractor |
| `_workspace/06_eval_report.md` | 2-5 harness-evaluator |
| `_workspace/pattern_profile_validation.json`, `validator_mechanical.json`, `validator_schema.json` | 2-3.5 기계 검증 |
| `_workspace/ai-budget.json` | 2-0.5 AI 예산 장부 |
| `_workspace/index/*.json` | 2-0.5 인덱스(call_graph, symbols, transactions, external_io, sql_usage, schema, dead_code, env_branches, owasp_top10 등) |
| `_workspace/claude_md_fields.json`, `_workspace/writer_decisions.json` | 2-2 writer 중간 산출물 |

analyze-impact / safe-modify / scaffold-feature / vibe / plan-migration / review-sql는 플러그인 전역 스킬이라 로컬 파일을 만들지 않는다. harness-init은 CLAUDE.md 자동 워크플로우 표와 `.claude/ito-guide.md`에 이름만 등록한다.

## 예시

첫 초기화 요청이다.

```text
사용자: 하네스 초기화해줘

하네스: 현재 작업 폴더: D:\work\order-system
        초기화할 프로젝트 구성을 선택해주세요.
          1. 단일 프로젝트로 초기화 (Recommended)
          2. 서버·클라이언트 함께 초기화 (모노레포)
          3. 서버·클라이언트 각각 초기화 후 연결 (1:1)
          4. 기타 (부분 범위 / 허브형 1:N)
사용자: 1

하네스: 인덱싱 완료 — 소스 1,240개 파일, 심볼 8,913개. (여기까지 LLM 사용 없음)
        이제 LLM 분석 구간입니다. 예상 규모:
          Tier Full 기준 · 약 9분 · 약 180K 토큰
          1. Full 로 진행   2. Standard 로 진행   3. 여기서 중단
사용자: 1

하네스: 하네스 초기화 완료 (AX Navi v1) [Tier: Full]
        [Core] CLAUDE.md, .claude/ito-guide.md, .claude/skills/trace.md, scaffolder.md, find-logic.md,
               .claude/agents/domain-expert.md, .claude/patterns/...
        [Indexes] _workspace/index/call_graph.json (노드: 8,913, 엣지: 21,406) ...
        구조 검증 (validator): 신뢰도 88
        패턴 추출: 구조화 프로필 검증 PASS (preferred 6개, 실제 기준 파일 14개)
        Eval 품질 점수: 91/100 — PASS
        초기화가 끝났습니다. 아직 실행하지 않은 선택 작업입니다.
          지금 안 함 (Recommended) / wiki 생성 / wiki 생성 + AI 해설 / 경계 QA
```

팀원이 공유 하네스를 pull한 뒤의 요청이다.

```text
사용자: 하네스 초기화해줘

하네스: CLAUDE.md가 이미 커밋돼 있고 _workspace/가 없습니다 — 공유 하네스를 이어받습니다.
        build-index.mjs --check-stale → exit 1 (인덱스 없음)
        block: index 1회 실행 (LLM 없음, 약 40초) → _ai_patch.json 자동 병합
        하네스가 이미 쓸 수 있는 상태입니다. 전체 파이프라인은 실행하지 않았습니다.
        사용 가능: analyze-impact / safe-modify / scaffold-feature / vibe / trace-logic
```

## 원칙과 주의

- **모델 고정.** 메인 스킬과 모든 팀원·폴백·재시도는 `claude-sonnet-5`를 사용한다. `sonnet` 별칭이나 Opus 자동 승격을 사용하지 않는다. 모델 미지원·권한 거부·다른 모델로의 대체가 확인되면 진행을 멈추고 알린다. 사용자·조직의 전역 모델 설정은 수정하지 않는다.
- **사용자 질문은 한국어.** `AskUserQuestion`의 `question`·`header`·옵션 `label`·`description`을 전부 한국어로 채운다.
- **옵션은 한 질문에 최대 4개.** 5개를 한 질문에 담았다가 5번이 조용히 잘려나간 실사고가 있어 구성 확인은 2단계로 나눈다.
- **초기화는 팀당 1회.** 팀원이 공유 하네스를 pull한 상태면 LLM 파이프라인을 돌리지 않고 인덱스만 로컬에서 다시 만든다. 반드시 커밋해야 하는 것은 인덱스가 아니라 `_workspace/index/_ai_patch.json`이다.
- **wiki·QA는 온디맨드.** Tier와 무관하게 자동 실행하지 않으며, Phase 3.6에서 선택했을 때만 Phase 3.7에서 실행한다. 초기화 컨텍스트가 최대인 시점이라 새 세션에서 "위키 만들어줘"로 따로 돌리는 편이 더 싸다.
- **보안 위험·DEAD/ORPHAN은 자동 수정하지 않는다.** validator·qa가 위치와 우선순위만 표시하고 사용자가 직접 처리한다.
- **에러 핸들링 원칙.** 1회 재시도 후 재실패 시 결과 없이 진행하고 보고서에 누락을 명시한다. 상충 데이터는 출처를 병기한다. AI 예산 `claim`이 exit 1이면 해당 Agent 호출을 하지 않고 레인을 중단한다.
- **변경 이력 보존.** 재초기화·업데이트 시 기존 CLAUDE.md의 `## 변경 이력` 표를 이어 붙인다. 표 파싱에 실패하면 `WARN`이 stderr에 나오므로 백업본에서 복원한다.
- **스크립트 경로.** `$env:CLAUDE_PLUGIN_ROOT`가 비어 있으면 스킬이 위치한 플러그인 디렉터리 절대경로로 대체한다. `python`과 `python3`는 어느 쪽도 하드코딩하지 않는다.

## 관련 문서

- [첫 하네스 만들기](/getting-started/first-harness.md)
- [Tier와 비용](/getting-started/tier-and-cost.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [튜토리얼: 투입 첫날](/tutorials/onboarding-day1.md)
