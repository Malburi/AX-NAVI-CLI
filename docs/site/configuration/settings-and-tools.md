# 권한과 도구 제한

AX Navi는 "읽기 전용 에이전트는 소스를 고치지 않는다"는 약속을 문서가 아니라 도구 선언으로 보장하고, `settings.json`에는 의미 있는 hooks만 두도록 writer를 제한합니다. 이 페이지는 두 장치의 의미와 한계, 그리고 Claude Code 권한 모드와의 관계를 정리합니다.

## 에이전트 도구 제한

소스를 수정하지 않는 에이전트 13종은 frontmatter `tools:`에 `Read, Grep, Glob, Bash, Write`만 선언하고 `Edit` 계열을 제외합니다. 리포트는 `_workspace/`에 `Write`로 남기되 기존 소스 파일을 제자리에서 고칠 수 없게 구조로 막는 장치이며, `agents/lib/tests/role-contract.test.mjs`가 이 선언을 고정합니다.

| 에이전트 | 역할 | `tools` 선언 |
|----------|------|--------------|
| `feature-finder` | 위치 탐색 | `Read, Grep, Glob, Bash, Write` |
| `logic-tracer` | 흐름 추적 | 같음 |
| `impact-analyzer` | 영향 분석 | 같음 |
| `sql-reviewer` | SQL 검토 | 같음 |
| `legacy-decoder` | 레거시 해독 | 같음 |
| `change-safety` | 변경 안전성 판정 | 같음 |
| `pattern-conformance` | 패턴 적합성 판정 | 같음 |
| `doc-syncer` | 문서 점검 | 같음 |
| `harness-evaluator` | 실용 품질 평가 | 같음 |
| `qa` | 경계 QA | 같음 |
| `validator` | 구조 검증 | 같음 |
| `migration-planner` | 마이그레이션 계획 | 같음 |
| `spec-clarifier` | 명세 인터뷰 | `Read, Grep, Glob, Bash, Write, AskUserQuestion` |

`tools:`를 선언하지 않은 에이전트는 `analyzer`·`writer`·`pattern-extractor`·`test-generator`·`api-bridge`·`pipeline-runner` 6종입니다. 이들은 하네스 파일·패턴·테스트 골격·API 스텁을 실제로 생성하거나 스크립트를 실행하는 역할이라 편집 도구가 필요합니다.

## 이 제한의 의미와 한계

| 항목 | 내용 |
|------|------|
| 보장하는 것 | 판정·분석 에이전트가 `Edit`로 기존 소스 파일을 제자리에서 수정할 수 없음. "읽기 전용"이라는 역할 계약이 문서 약속에서 도구 선언으로 승격 |
| 보장하지 않는 것 | `Bash`와 `Write`는 남아 있으므로 파일 생성·덮어쓰기·셸 명령 실행은 기술적으로 가능. 따라서 이 제한은 보안 경계가 아니라 역할 드리프트 방지 장치 |
| 실무 해석 | 에이전트가 소스를 고쳤다면 도구 제한이 아니라 에이전트 지침 위반이므로 리포트로 확인하고 되돌림 |
| 실제 수정 주체 | 코드 변경은 `safe-modify`·`scaffold-feature`·`vibe` 스킬을 실행하는 메인 세션이 수행하고, 판정 에이전트는 그 diff를 읽어 판정만 함 |

## writer가 만드는 settings.json 규칙

writer는 대상 프로젝트의 `.claude/settings.json`에 hooks를 함부로 만들지 않습니다. `agents/writer.md`의 "금지: 의미 없는 hooks 생성" 절이 기준입니다.

### 만들면 안 되는 hooks

| 금지 사례 | 이유 |
|-----------|------|
| `echo "[알림] ..."`처럼 터미널 출력만 하는 hooks | Claude가 읽지 않으므로 아무 효과가 없음 |
| "스킬 자동 트리거를 위해" 등록하는 hooks | hooks는 Claude가 특정 스킬을 호출하도록 강제할 수 없음. 트리거 근거는 CLAUDE.md의 자동 워크플로우 표와 SKILL.md description |
| 실행 결과를 Claude가 읽을 수 없는 위치에 기록하는 hooks | 결과가 도구 결과로 돌아오지 않으면 판단에 쓰이지 않음 |

### 허용되는 hooks

| 허용 사례 | 예 |
|-----------|-----|
| 실제 검증·빌드를 수행하고 결과를 파일로 저장 | `ant compile` → `_workspace/compile_result.txt` |
| 위험 파일(운영 DB 접속 정보 등) 수정 시도를 차단 | PreToolUse에서 `exit 2` 반환. Claude Code는 exit 2만 차단으로 해석 |
| Claude가 도구 결과로 읽을 수 있는 정보를 생성 | 검증 요약 파일 생성 |

만들 이유가 분명하지 않으면 만들지 않습니다. 기본은 `{"enabledPlugins": {}}` 또는 기존 설정 유지입니다.

### 트리거 강제는 슬래시 호출만

`settings.json`의 PreToolUse/PostToolUse hooks로는 스킬 트리거를 강제할 수 없습니다. 자연어 매칭은 확률적이므로, 반드시 게이트 경로를 타야 하는 작업은 `/ax-navi:safe-modify`처럼 슬래시로 확정 호출하세요. 자세한 표는 [트리거 문구 전체 표](/reference/triggers.md)에 있습니다.

## Claude Code 권한 모드와의 관계

플러그인은 Claude Code의 권한 모드를 바꾸지 않습니다. 두 층은 독립적으로 동작합니다.

| 층 | 결정 주체 | AX Navi가 하는 일 |
|----|-----------|-------------------|
| 권한 모드(도구 실행 승인 방식) | 사용자·조직의 Claude Code 설정 | 변경하지 않음. 에이전트 지침에서 자동 수정을 금지하는 것과는 별개 |
| 에이전트 `tools:` | 플러그인 `agents/*.md` | 판정 에이전트의 `Edit` 제외 |
| 프로젝트 `settings.json` | writer가 조립 | 의미 없는 hooks 금지, 필요한 경우만 검증·차단 hooks |

권한 모드가 느슨하더라도 판정 에이전트의 도구 선언은 그대로이고, 권한 모드가 엄격하면 `Bash`·`Write` 사용 시 승인 프롬프트가 더 자주 뜰 수 있습니다. 스크립트 실행이 잦은 harness-init에서 프롬프트가 부담되면 프로젝트 `settings.json`의 permissions 허용 목록으로 조정하는 것은 사용자의 선택이며, 플러그인이 대신 설정하지 않습니다.

## 자동 수정 금지 원칙

도구 제한과 별개로, 다음 상황에서는 어떤 에이전트도 자동으로 고치지 않습니다.

- validator가 보안 위험을 발견한 경우. 위치만 명시하고 사용자가 직접 처리합니다.
- qa가 DEAD/ORPHAN을 발견한 경우. 우선순위만 표시합니다.
- change-safety가 HOLD/STOP을 낸 경우. 판정을 우회하는 방법은 제공하지 않습니다.
- 파트너 저장소 커밋. 확인 없이 자동 실행하지 않습니다.

## 관련 문서

- [에이전트 팀과 파이프라인](/concepts/agent-team.md)
- [판정과 게이트](/concepts/gates.md)
- [모델 정책](/configuration/model-policy.md)
- [트리거 문구 전체 표](/reference/triggers.md)
- [writer](/agents/writer.md)
- [에이전트 개요](/agents/README.md)
