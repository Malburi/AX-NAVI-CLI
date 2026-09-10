# writer

analyzer의 분석 리포트를 받아 프로젝트 전용 하네스 파일을 실제로 생성하는 에이전트다. 직접 쓰는 것은 `trace.md`·`scaffolder.md`·`find-logic.md`(그리고 `pair_config.md`가 있을 때 `cross-repo-scaffold.md`·`cross-repo-modify.md`)이고, CLAUDE.md는 필드 JSON만, 패턴 스켈레톤과 완료 보고서는 결정 값 JSON만 채운다. 전역 워크플로우 스킬 6종(analyze-impact·safe-modify·scaffold-feature·vibe·plan-migration·review-sql)은 플러그인 전역판을 그대로 쓰므로 작성하지도 로컬 배포하지도 않으며, 에이전트 정의도 만들지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 2-2(`T-W`)가 부른다. 입력은 `_workspace/01_analyzer_report.md`와 인덱스다.
- harness-init Phase 4에서 harness-evaluator가 커버리지·정확도(스킬 본문)·실행가능성·컨텍스트 품질 차원의 `fix_target.agent`로 `writer`를 지정하면 지목된 파일만 다시 쓴다.
- frontmatter `model`은 `claude-sonnet-5`, `tools`는 지정하지 않는다. 작업 범위는 "분석 리포트에 명시된 항목만 반영, 리포트에 없는 내용은 추측 금지"다.

## 하는 일

1. `_workspace/01_analyzer_report.md`를 가장 먼저 읽고, 인덱스는 헤더만 확인한다.
2. `.claude/skills/trace.md`·`scaffolder.md`·`find-logic.md`를 작성한다. 세 파일 모두 frontmatter에 `name`·`description`·`model` 세 필드를 넣고, description은 한국어 트리거 3개 이상·영어 2개 이상·스택 키워드 1개 이상을 충족한다.
3. `trace.md`와 `find-logic.md`에는 이 프로젝트의 실제 심볼로 만든 `query-index.mjs` 실행 명령 예시를 2개 이상 넣는다. 플레이스홀더가 아니라 복사해 바로 돌릴 수 있는 값이어야 한다.
4. CLAUDE.md는 markdown을 쓰지 않고 `_workspace/claude_md_fields.json`에 `project_name`·`one_line_desc`·`tech_stack_summary`·`request_flow`·`file_locations_rows`·`build_run`·`cautions` 7개 필드만 채운다. 골격은 `skills_builder.py`가 조립한다.
5. `plan-migration`·`review-sql` 두 조건부 스킬을 CLAUDE.md 표에 권장 항목으로 반영할지 판단해 `writer_decisions.json`의 `plan_migration`/`review_sql` 필드에 `{"generate": true|false, "reason": ...}`로 기록한다.
6. 탐지된 스택에 실제로 존재하는 레이어만 골라 패턴 파일명 목록(`controller_pattern.md`·`service_pattern.md`·`form_pattern.md` 등)을 `pattern_files` 배열에 적는다. 스켈레톤 본문은 `skills_builder.py`가, 컨벤션 추출은 pattern-extractor가 맡는다.
7. `pair_config.md`가 있으면 `cross-repo-scaffold.md`·`cross-repo-modify.md`를 직접 작성한다.
8. trace/scaffolder/find-logic 작성 중 겪은 컨벤션 선택·상충 사유를 `applied_decisions`에 자유 문장으로 남긴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `_workspace/01_analyzer_report.md`, `_workspace/index/*.json`(헤더만), `_workspace/pair_config.md`(있으면) |
| 씀 | `.claude/skills/trace.md`, `.claude/skills/scaffolder.md`, `.claude/skills/find-logic.md`, (조건부) `.claude/skills/cross-repo-scaffold.md`·`cross-repo-modify.md`, `_workspace/claude_md_fields.json`, `_workspace/writer_decisions.json` |
| 쓰지 않음 | `CLAUDE.md`, `.claude/agents/domain-expert.md`, `.claude/patterns/*` 스켈레톤, `_workspace/02_writer_files.md` — 모두 `skills_builder.py`가 Phase 2-2.3에서 조립 |

## 판정·출력 형식

`writer_decisions.json`의 스키마는 다음과 같다.

```json
{
  "detected_stack": "[탐지된 스택]",
  "confidence": "[analyzer 신뢰도]",
  "pattern_files": ["controller_pattern.md", "service_pattern.md"],
  "plan_migration": {"generate": true, "reason": "[사유]"},
  "review_sql": {"generate": false, "reason": "[사유]"},
  "applied_decisions": ["[선택한 패턴과 이유]", "[상충 시 두 패턴 출처 병기]"]
}
```

`client_pattern.md`는 analyzer 리포트에 "LegacyStaticJS" 분류가 있으면 `skills_builder.py`가 자동 추가하므로 목록에 넣지 않아도 된다.

## 원칙

- 분석 리포트에 없는 내용은 추측하지 않는다.
- 상충 패턴은 임의로 고르지 않고 출처를 병기해 validator/qa가 판단하게 한다.
- `settings.json`에 의미 없는 hooks를 만들지 않는다. `echo`로 터미널에 출력만 하는 hook이나 "스킬 자동 트리거용" hook은 Claude가 읽지 않으므로 효과가 없고, hooks는 특정 스킬 호출을 강제할 수 없다. 이유가 명확하지 않으면 `settings.json`은 `{"enabledPlugins": {}}` 또는 기존 설정을 유지한다.
- 모든 프로젝트에서 같은 고정 텍스트(워크플로우 표·변경이력 헤더·파트너 섹션)는 재작성하지 않고 스크립트에 맡긴다.

## 관련 문서

- [harness-init](/skills/harness-init.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [pattern-extractor](/agents/pattern-extractor.md)
- [validator](/agents/validator.md)
- [설정과 도구](/configuration/settings-and-tools.md)
