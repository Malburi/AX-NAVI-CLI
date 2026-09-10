# 담당자 교체·인수인계

다음 주에 담당자가 바뀐다. 넘겨줄 것은 코드가 아니라 맥락이다. 하네스가 만들어 둔 인덱스·wiki·레거시 해석 리포트·CLAUDE.md 변경 이력을 한 묶음으로 정리해 넘기고, 새 담당자가 첫날 어떤 명령부터 치면 되는지까지 정해 두는 절차다.

- **소요 시간** — 넘겨주는 쪽 1~2시간, 받는 쪽 첫 명령까지 10분.
- **전제** — 하네스가 있고 git으로 공유 중이다. 없으면 [신규 프로젝트 투입 첫날](/tutorials/onboarding-day1.md)의 초기화부터 한다.
- **이 튜토리얼이 다루는 스킬·에이전트** — `harness-init`(공유 하네스 이어받기), `doc-syncer`, `generate-wiki`, `publish-wiki`, `legacy-decoder` 리포트 활용.

## 준비

무엇이 어디에 있고 어떻게 넘어가는지 먼저 정리한다.

| 산출물 | 위치 | 넘기는 경로 |
|---|---|---|
| CLAUDE.md, ito-guide, 로컬 스킬 3종, domain-expert, 패턴 | `CLAUDE.md`, `.claude/` | git 커밋 |
| AI 보강 패치 | `_workspace/index/_ai_patch.json` | git 커밋(필수) 또는 publish-wiki |
| 결정론적 인덱스 | `_workspace/index/*.json` | git 커밋(선택) 또는 publish-wiki. 커밋하지 않아도 수십 초에 재생성된다 |
| wiki | `_workspace/wiki/` | publish-wiki 또는 재생성 |
| 작업 리포트 | `_workspace/reports/decoded_*.md`, `impact_*.md`, `trace_*.md`, `safety_*.md` | 별도 복사(자동으로 넘어가지 않는다) |
| 마이그레이션 계획 | `_workspace/migration/` | 별도 복사 |

`_workspace/`는 재생성 가능한 산출물 폴더라 `.gitignore` 대상이 되기 쉽다. 그 안에서 반드시 살려야 하는 것은 `_ai_patch.json`이다. 다시 만들려면 LLM 분석을 다시 돌려야 한다.

## 단계별 진행

### 1. 하네스 신선도 맞추기

넘기기 전에 하네스가 현재 코드를 반영하는지 확인한다.

```text
인덱스 갱신해줘
```

`harness-init`의 인덱스 리프레시 모드가 변경 파일만 재분석해 `_workspace/index/`를 갱신한다. 최근에 기능이 대거 추가됐거나 의존성이 바뀌었으면 한 단계 더 간다.

```text
하네스 업데이트해줘
```

업데이트 모드는 기존 파일을 `.claude/backup/[YYYYMMDD-HHmmss]/`에 백업한 뒤 analyzer incremental과 후속 단계를 재실행한다. CLAUDE.md의 `## 변경 이력` 표는 기존 행을 유지하고 이번 실행 행만 추가한다.

### 2. CLAUDE.md 변경 이력 정리

`CLAUDE.md` 하단의 `## 변경 이력` 표가 인수인계의 타임라인이다. 최근 변경이 빠져 있으면 `doc-syncer`로 채운다.

```text
변경 사항 문서 동기화
```

`doc-syncer`가 변경 파일과 문서를 대조해 `_workspace/reports/docs_sync_<slug>.md`를 만든다. "4. 변경 이력 항목 권고" 절에 다음 형태의 행이 제안된다.

```markdown
| 2026-09-10 | [변경 내용 요약] | [영향 파일/모듈] | [사유] |
```

"전체 적용" 또는 "선택 적용 N1, N3"로 승인하면 문서에 반영된다. 승인 없이는 고치지 않는다. 담당자 교체 자체도 한 행으로 남긴다. 예를 들어 "담당자 교체 — 인수인계 완료, 새 담당자 첫 명령은 ito-guide 5절 참고" 같은 행이다.

### 3. 하네스 파일과 인덱스 커밋

```bash
git add CLAUDE.md .claude/
git add _workspace/index/_ai_patch.json
git commit -m "docs: harness 인수인계 시점 갱신"
git push
```

`.claude/backup/`은 커밋하지 않는다. 인덱스 전체를 커밋할지는 팀이 정한다. 인덱스는 이식 가능하도록 설계됐다. `source_root`가 `.`이고 경로는 루트 기준 상대경로에 슬래시 정규화이며 줄바꿈·로케일에 따라 내용이 달라지지 않는다. 커밋하면 새 담당자는 `--check-stale`이 exit 0인 동안 인덱싱조차 하지 않는다. 크기가 부담되면 커밋하지 않아도 되고, 그때는 새 담당자가 수십 초짜리 인덱싱을 한 번 한다.

`_ai_patch.json`이 `.gitignore`의 `_workspace/`에 걸려 버려지고 있지 않은지 `git status`로 확인한다.

### 4. wiki 생성과 발행

```text
위키 만들어줘
```

`generate-wiki`로 `_workspace/wiki/`를 최신화한다. 조직에 중앙 DB가 있으면 발행까지 한다. 발행 시 담당자 정보가 남으므로 이 시점에 새 담당자를 시스템 대표로 등록하는 것이 좋다.

```powershell
python "$env:CLAUDE_PLUGIN_ROOT/agents/lib/wikihub_db/publish.py" --root "[절대경로]" `
  --system-key "ORDER" --system-name "주문관리시스템" `
  --component-type backend --component-key "backend" `
  --publisher-company "[회사명]" --publisher-dept "[소속]" --publisher-empno "[새 담당자 사번]" `
  --publisher-name "[새 담당자 성명]" --publisher-phone "[전화]" --publisher-email "[이메일]" `
  --owner-role owner --set-system-owner --summary "담당자 교체" --save-env
```

`--owner-role owner --set-system-owner`가 허브 시스템 목록에 이 사람을 대표 담당자로 표시한다. 발행 기본값은 `_workspace/**/*.json`도 함께 올리므로 인덱스와 `_ai_patch.json`이 DB에도 보관된다. 새 담당자는 `--pull`로 원래 경로에 복원할 수 있다. `--list-owners`로 등록 결과를 확인한다.

### 5. 리포트 묶기

`_workspace/reports/`의 `.md`는 `publish-wiki`가 발행하지 않는다(wiki `.md`·`.html`과 `_workspace/**/*.json`만 발행). 인수인계 폴더를 만들어 복사한다.

- `decoded_*.md` — 레거시 해석. 9절 의문점에 대한 업무 담당자 답변이 기록돼 있어야 한다. 11절 청중별 요약 중 업무담당자 절은 업무 쪽에, 개발자 절은 새 담당자에게 바로 쓸 수 있다.
- `impact_*.md`, `safety_*.md` — 최근 변경의 영향 범위와 GO 근거. 왜 그 변경이 안전하다고 판단했는지가 남아 있다.
- `trace_*.md`, `found_*.md` — 핵심 기능의 흐름과 위치.
- `_workspace/migration/` — 진행 중인 마이그레이션이 있으면 `checkpoints/phase[N].md`의 현재 Phase와 사인오프 상태까지 함께 넘긴다.

복사 위치는 프로젝트 문서 폴더(예: `docs/handover/2026-09/`)로 하고 커밋한다.

### 6. 새 담당자의 첫 명령

새 담당자는 플러그인을 설치하고 저장소를 clone한 뒤 프로젝트 루트에서 Claude Code를 연다.

```text
하네스 초기화해줘
```

`harness-init`이 `CLAUDE.md`가 이미 커밋돼 있고 `_workspace/`가 없는 상태를 "팀원이 공유 하네스를 pull한 상태"로 판정해 Step 2.2로 간다. 전체 초기화는 하지 않는다.

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root "[절대경로]" --check-stale
```

| exit | 의미 | 동작 |
|---|---|---|
| 0 | 소스 지문이 인덱스와 일치 | 아무것도 하지 않고 사용 가능한 스킬만 안내 |
| 1 | 인덱스가 없거나 소스가 변경됨 | 인덱싱 블록만 1회 실행(LLM 없음, 수십 초). `_ai_patch.json`이 있으면 자동 병합 |

인덱스와 `_ai_patch.json`이 git에 없고 DB에 발행돼 있다면 순서를 지킨다. 먼저 `publish.py --pull`로 복원하고, 그 다음 `--check-stale`이다. 반대로 하면 방금 만든 로컬 인덱스를 오래된 DB 사본이 덮어쓴다.

이어서 세 가지를 한다.

```text
/flow 주문 취소
```

하네스가 있으면 이 한 줄로 바로 시작할 수 있다. `.claude/ito-guide.md`를 읽고, `_workspace/wiki/serve.bat`으로 wiki를 열고, 인수인계 폴더의 `decoded_*.md` 11절 개발자 절을 훑는다.

## 결과 확인

- git에 커밋된 `CLAUDE.md`(변경 이력 표에 인수인계 행 포함), `.claude/`, `_workspace/index/_ai_patch.json`.
- `publish.py --list-owners`에 새 담당자가 owner로 보인다.
- 인수인계 폴더에 `decoded_*.md`·`impact_*.md`·`safety_*.md`·`trace_*.md`와(있으면) `_workspace/migration/` 사본.
- 새 담당자 환경에서 `--check-stale` exit 0, `/flow` 결과가 정상 출력.

## 막혔을 때

- **새 담당자가 전체 재초기화를 하려 한다** — 필요 없다. LLM 산출물은 이미 `CLAUDE.md`·`.claude/`에 있고 인덱스는 결정론적이라 로컬에서 다시 만드는 편이 싸다. "하네스 다시 초기화"라고 명시적으로 말할 때만 전체 파이프라인이 돈다.
- **`_ai_patch.json`이 저장소에 없다** — `.gitignore`에 걸렸을 가능성이 크다. 이전 담당자 환경에서 `git add -f _workspace/index/_ai_patch.json`으로 강제 추가하거나, `publish-wiki`로 DB에 올린 뒤 `--pull`로 받는다. 둘 다 없으면 "하네스 다시 초기화"로 LLM 분석을 다시 돌려야 한다.
- **변경 이력 표가 한 행으로 리셋됐다** — 표 형식이 깨져 파싱에 실패하면 `skills_builder.py`가 `WARN: ... '## 변경 이력' 표를 파싱하지 못해 ...`를 출력하고 이번 행으로 대체한다. `.claude/backup/[시각]/CLAUDE.md`에서 이력 표를 복원한다.
- **wiki가 코드와 다르다** — wiki는 발행 시점의 스냅샷이다. `generate-wiki` → `publish-wiki`를 다시 돌린다. 영향도 판단은 wiki가 아니라 `analyze-impact`의 라이브 재분석으로 한다.
- **담당자 정보가 예전 사람으로 남아 있다** — `--owner-role owner --set-system-owner`로 새 담당자를 발행하면 시스템 대표가 바뀐다. `/s/[시스템키]` 화면의 담당자 표에서도 확인할 수 있다(wiki-hub 서버가 배포된 경우).
- **레거시 리포트의 의문점이 답 없이 남아 있다** — 그대로 넘긴다. 답을 모른다고 남기는 것이 추측보다 낫다. 새 담당자가 업무 담당자와 확인할 목록으로 쓴다.

## 관련 문서

- [harness-init](/skills/harness-init.md) — Step 2.2 공유 하네스 이어받기와 실행 모드 표.
- [인덱스 갱신](/configuration/index-refresh.md) — `--check-stale`과 incremental 재인덱싱.
- [publish-wiki](/skills/publish-wiki.md) — 담당자 등록과 `--pull`.
- [doc-syncer](/agents/doc-syncer.md) — 변경 이력 항목 권고.
- [워크스페이스 파일](/reference/workspace-files.md) — `_workspace/` 아래 파일별 커밋 여부.
