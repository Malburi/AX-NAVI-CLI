# harness-evaluator

생성된 하네스가 실제로 사용 가능한지를 커버리지·정확도·실행가능성·컨텍스트 품질 4개 차원(각 25점)으로 평가하는 에이전트다. 총점 80 이상이면 PASS, 미만이면 차원별 재생성 대상(`fix_targets`)을 돌려준다. validator가 파일 존재·형식·경로 같은 구조적 정확성을 보는 데 비해 이 에이전트는 실제 코드와의 의미적 일치·실용성을 본다. 평가와 리포트만 하며 파일을 수정하지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 2-5(모든 Tier)가 첫 평가를 부른다.
- harness-init Phase 4 Eval Loop에서 `fix_targets` 재생성이 끝난 뒤 다시 불러 개선 델타를 확인한다(평가 회차 1/2).
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. 차원 1 커버리지에서 analyzer 리포트의 "아키텍처 레이어" 목록이 CLAUDE.md·writer 작성 스킬(trace/scaffolder/find-logic)·patterns/에 모두 언급됐는지, 외부 통신이 trace.md 또는 CLAUDE.md 주의사항에 반영됐는지 본다. 레이어 1개 미반영은 -3(최대 -15), 외부 연동 미반영은 -5다.
2. 차원 2 정확도에서 샘플 5개를 교차 검증한다. CLAUDE.md 파일 위치 2개, trace.md 파일/클래스 2개를 Glob으로 확인하고 `pattern_profile.json`의 preferred 프로필 `reference_files` 1개가 실존하며 `rules`가 코드에 드러나는지 본다. 1개 불일치 -5, 2~3개 -10, 4개 이상 -20이다.
3. 차원 3 실행가능성에서 writer 작성 스킬의 트리거 문구 수(한국어 3개·영어 2개), scaffolder.md의 실제 경로 참조, 전역 analyze-impact·safe-modify가 참조하는 인덱스 존재(`query-index.mjs summary`의 `index_sizes`로 판정), 도메인 키워드 10개 이상, 패턴 프로필 `valid: true`를 본다.
4. 차원 4 컨텍스트 품질에서 CLAUDE.md 요청 흐름을 실제 코드로 1개 직접 trace하고, 도메인 문서의 프로젝트 특화 내용, analyzer "보완 권장" 반영을 본다.
5. `_workspace/00_spec_report.md`가 있을 때만 spec goal_hint·목표·제약 반영을 검증한다. 없으면 관련 항목은 전부 스킵하고 감점하지 않는다.
6. 총점을 계산해 PASS/PARTIAL/RETRY를 결정하고 `fix_targets` 표를 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `_workspace/01_analyzer_report.md`, 생성된 하네스 파일들, `_workspace/03_validator_report.md`, `_workspace/pattern_profile_validation.json`, `_workspace/00_spec_report.md`(있으면), `writer_decisions.json` |
| 읽지 않음 | `.claude/agents/domain-expert.md` — analyzer 리포트를 그대로 복사한 파일이라 두 번 읽게 되므로 따로 열지 않는다 |
| 씀 | `_workspace/06_eval_report.md` |

전역 워크플로우 스킬 6종(analyze-impact/safe-modify/scaffold-feature/vibe/plan-migration/review-sql)은 프로젝트에 복사되지 않으므로 본문은 채점 대상이 아니다. CLAUDE.md 등록과 `writer_decisions.json`의 조건부 적용 결정, 필요한 인덱스의 존재만 본다.

## 판정·출력 형식

| 총점 | 결정 | 의미 |
|------|------|------|
| 80~100 | PASS | 하네스 사용 가능, git commit 권장 |
| 60~79 | PARTIAL | 특정 차원 타겟 재생성 권고, fix_targets 반환 |
| 0~59 | RETRY | 주요 에이전트 재실행 필요, fix_targets 반환 |

`fix_targets`는 리포트의 `## Fix Targets` 표가 유일한 전달 형식이며 별도 JSON은 만들지 않는다. 각 행은 `agent`(`analyzer` 또는 `writer`만 허용)·`scope`·`instruction` 세 값을 채운다. 정확도처럼 두 에이전트가 필요하면 행을 나누고 analyzer 행을 위에 둔다. RETRY일 때는 점수가 가장 낮은 2개 차원만 반환해 과도한 재실행을 막는다.

```
=== HARNESS EVAL REPORT ===
평가 시각 · 평가 회차 [1 / 2] · spec_context [있음/없음]
## 차원별 점수 (표)
**총점: [N] / 100 — [PASS / PARTIAL / RETRY]**
## Fix Targets (PASS이면 생략)
## 개선 권고 (자동 재생성 없이 수동 조치 권장)
=== END ===
```

## 원칙

- 구조 검증(validator)과 실용 품질(evaluator)의 역할을 나눈다.
- `truncated > 0`인 인덱스 질의 결과를 전체로 간주해 "없음"으로 감점하지 않는다.
- `fix_target.agent`에 analyzer·writer 이외의 에이전트를 반환하지 않는다. harness-init Phase 4의 task-id 매핑이 이 둘만 지원한다.
- spec 리포트가 없으면 spec 관련 감점을 하지 않는다.

## 관련 문서

- [게이트](/concepts/gates.md)
- [harness-init](/skills/harness-init.md)
- [validator](/agents/validator.md)
- [spec-clarifier](/agents/spec-clarifier.md)
- [첫 하네스 만들기](/getting-started/first-harness.md)
