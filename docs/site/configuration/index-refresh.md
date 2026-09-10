# 인덱스 갱신

`_workspace/index/`는 코드에서 결정론적으로 만들어지는 산출물이라 코드가 바뀌면 낡습니다. AX Navi는 stale 여부를 LLM 없이 판정하는 `--check-stale`, LLM 분석 없이 인덱스만 다시 만드는 "인덱스만 갱신해줘" 경로, 그리고 하네스 일부만 다시 만드는 부분 재실행 문구를 제공합니다. 이 페이지는 언제 무엇을 실행해야 하는지와 팀 공유 시 커밋 정책을 정리합니다.

## stale 판정 — `--check-stale`

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root "[프로젝트 절대경로]" --check-stale
```

LLM을 쓰지 않고 JSON 한 덩어리와 exit code로 답합니다.

| exit | `stale` | `reason` | 의미와 조치 |
|------|---------|----------|-------------|
| 0 | `false` | `소스 지문 일치 — 재인덱싱 불필요` | 그대로 사용 |
| 1 | `true` | `인덱스 없음` | `--mode init`으로 생성 |
| 1 | `true` | `인덱서 버전 변경 (x → y)` | 플러그인 업데이트로 `INDEXER_VERSION`이 올라감. `--mode incremental` |
| 1 | `true` | `지문 없는 구버전 인덱스` | `source_fingerprint`가 없는 옛 인덱스. `--mode init` |
| 1 | `true` | `소스가 변경됨` | `--mode incremental` |

판정 순서는 `_meta.json` 존재 → `version`이 현재 `INDEXER_VERSION`(현재 `1.11.0`)과 일치 → `source_fingerprint` 존재 → 현재 소스 지문과 비교입니다. 지문은 git 저장소면 추적 파일 상태에서, 아니면 파일 내용 해시에서 계산하므로 줄바꿈이나 OS 로케일에 따라 달라지지 않습니다.

`safe-modify`·`analyze-impact`·`trace-logic`·`find-feature`는 시작 시 이 검사를 먼저 실행합니다. `safe-modify`와 `analyze-impact`는 stale이면 재인덱싱 후 진행하고, `trace-logic`·`find-feature`는 급한 1회성 조회라면 "인덱스가 stale일 수 있음"만 알리고 진행할 수 있습니다.

## "인덱스만 갱신해줘" — 인덱스 리프레시

harness-init의 실행 모드 표에서 "인덱스만 갱신해줘"·"인덱스만 다시"·"인덱스 리프레시"는 **인덱스 리프레시** 모드로 분기합니다. writer·validator·harness-evaluator는 실행하지 않습니다.

| 단계 | 내용 | LLM |
|------|------|-----|
| 1 | `block: index`를 `--mode incremental`로 실행. 소스 추출은 전수로 다시 하며 파일별 캐시는 두지 않음 | 없음 |
| 2 | `_workspace/index/_ai_patch.json`이 있으면 파일을 쓰기 전에 다시 병합하고 데드코드도 재계산 | 없음 |
| 3 | 저장된 엔드포인트 설명·흐름 note·클라이언트 해설 패치도 다시 적용 | 없음 |
| 4 | analyzer가 필요한 경우(업데이트 모드) `incremental`로 변경 파일만 재분석 | Sonnet 5 |

`analyzer`가 `call_graph.json`을 직접 고치지 않고 `_ai_patch.json`으로 내는 이유가 여기 있습니다. `--mode incremental`은 소스에서 그래프를 다시 만들기 때문에 손으로 덧붙인 엣지는 사라지지만, 패치 파일은 다시 병합되므로 AI 보강이 보존됩니다.

`_meta.generator`가 `deterministic-indexer`가 아닌 옛 인덱스에는 `incremental`을 쓰지 않고 `init`을 강제합니다. 생성기마다 노드 id 체계가 달라 한 파일에 두 네임스페이스가 섞이면 안 되기 때문입니다.

## `--mode` 세 가지

`build-index.mjs`의 `--mode`는 `init`·`incremental`·`feature-scoped` 세 값만 받습니다. `_meta.mode`에 그대로 기록됩니다.

| 모드 | 언제 | 동작 |
|------|------|------|
| `init` | 최초 분석, 재초기화, 인덱스 없음, 구버전 인덱스 | 전체 인덱스 생성. 기존 `_ai_patch.json`은 보존하지 않음 |
| `incremental` | 코드 변경 후 갱신, 인덱서 버전 변경 | 전체 재추출 후 기존 `_ai_patch.json` 재병합. analyzer가 개입하면 변경 파일만 재분석하고 stale 엣지를 무효화 |
| `feature-scoped` | 사용자 지정 범위만 빠르게 | 인덱스에 부분 추가하며 기존 데이터 보존. `analyze-impact`가 인덱스가 없을 때 analyzer를 이 모드로 호출 |

Tier는 `--tier Standard|Full`로 넘기며 생략하면 `Auto`로 복잡도 점수에서 추천합니다. `--config`를 생략하면 `_workspace/indexer-config.json`을 읽습니다.

## 부분 재실행 문구

기존 하네스가 있을 때 특정 단계만 다시 돌리는 문구입니다. 이전 `_workspace/` 산출물은 재사용하고 `00_init_scope.md`의 `tier:`와 `ai_budget_session` 값도 다시 묻지 않고 그대로 씁니다.

| 문구 | 다시 실행하는 것 | 건너뛰는 것 |
|------|------------------|-------------|
| "스킬만 다시 생성" | writer 조립본(`skills_builder.py`) — CLAUDE.md 표·`.claude/ito-guide.md`·로컬 스킬 3종 | analyzer·인덱싱 |
| "에이전트만 다시 생성" | `.claude/agents/domain-expert.md` 재조립 | analyzer·인덱싱 |
| "validator만 다시 실행" | 기계 검증 + validator 리포트 | 생성 단계 전부 |
| "패턴만 다시" / "패턴 추출해줘" | pattern-extractor + 프로필 검증 | analyzer·writer |
| "qa만" | 경계 QA만 | 나머지 |

플러그인 전역 스킬 6종(analyze-impact·safe-modify·scaffold-feature·vibe·plan-migration·review-sql)은 로컬 파일이 없어 플러그인 업데이트만으로 새 트리거가 반영됩니다. CLAUDE.md 표와 ito-guide에 새 이름을 올리려면 "스킬만 다시 생성"을 요청하세요.

## 어떤 문구를 쓸지 고르기

| 상황 | 요청 문구 | 실행 모드 |
|------|-----------|-----------|
| 코드만 바뀌었고 하네스 문서는 그대로 | "인덱스만 갱신해줘" | 인덱스 리프레시 |
| 라이브러리 추가·DB 스키마 변경 | "인덱스 갱신해줘" | 인덱스 리프레시 |
| 새 기능이 대거 추가돼 CLAUDE.md 내용도 낡음 | "하네스 업데이트해줘" | 업데이트(백업 후 analyzer incremental + 재실행) |
| 팀 컨벤션이 바뀜 | "패턴 다시 추출해줘" | 부분 재실행 |
| 마이그레이션 완료 등 구조가 통째로 바뀜 | "하네스 다시 초기화해줘" | 재초기화(`.claude/backup/[시각]/` 백업 후 전체) |

`safe-modify`·`scaffold-feature`·`vibe`는 GO 이후 자기 Phase에서 `--mode incremental` 재인덱싱과 `generate-wiki` 재실행을 수행하므로, 이 스킬로 수정한 뒤에는 별도 갱신 요청이 필요하지 않습니다. 갱신에 실패하면 코드 변경 성공과 구분해 `지식 모델 stale` WARN을 남깁니다.

## 인덱스 커밋 정책

인덱스를 커밋할지는 팀이 정합니다. 판단 기준은 다음과 같습니다.

| 대상 | 커밋 여부 | 이유 |
|------|-----------|------|
| `CLAUDE.md`, `.claude/` | 반드시 | LLM 산출물. 다시 만들려면 초기화 전체를 다시 돌려야 함 |
| `_workspace/index/_ai_patch.json` | 반드시 | analyzer가 미해결 관계를 판정한 LLM 산출물. `.gitignore`의 `_workspace/`에 걸려 버려지지 않는지 확인 |
| `_workspace/index/*.json` (그 외) | 선택 | 결정론적이라 각자 로컬에서 수십 초에 다시 만들 수 있음. 커밋하면 팀원은 `--check-stale`이 exit 0인 동안 인덱싱조차 하지 않음 |
| `_workspace/indexer-config.json` | 인덱스를 커밋하면 함께 | `include_paths`가 지문 계산에 들어감 |

인덱스는 이식 가능하게 설계되어 있습니다. `source_root`가 `.`이고 모든 경로가 루트 기준 상대경로에 슬래시 정규화이며, CRLF/LF와 로케일에 따라 내용이 달라지지 않습니다.

팀원이 공유 하네스를 pull한 경우 harness-init은 전체 초기화 대신 `--check-stale`만 실행하고, exit 1이면 `block: index` 1회(LLM 없음)로 끝냅니다. git에 인덱스와 `_ai_patch.json`이 없고 시스템이 wiki-hub DB에 발행돼 있다면 `publish-wiki --pull`이 `_workspace/**/*.json`을 원래 경로로 복원합니다. 순서는 반드시 pull → check-stale입니다.

## INDEXER_VERSION 상향과 stale

플러그인을 업데이트해 `build-index.mjs`의 `INDEXER_VERSION`이 올라가면, 소스가 그대로여도 `--check-stale`은 `인덱서 버전 변경`으로 exit 1을 돌려줍니다. 추출 규칙이 바뀐 만큼 결과가 달라질 수 있기 때문입니다. 이때는 `--mode incremental`로 한 번 다시 만들면 되고 `_ai_patch.json`은 재병합됩니다. 스키마 검증(`validate-harness.mjs`)이 `plugin_contract_failures`를 보고하면 플러그인 자체 결함이므로 AI로 재시도하지 않고 보고만 합니다.

## 관련 문서

- [결정론적 인덱스](/concepts/deterministic-index.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [인덱스 파일 스펙](/reference/index-spec.md)
- [harness-init](/skills/harness-init.md)
- [safe-modify](/skills/safe-modify.md)
- [publish-wiki](/skills/publish-wiki.md)
- [담당자 인수인계](/tutorials/handover.md)
