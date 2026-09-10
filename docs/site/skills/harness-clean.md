# harness-clean

현재 프로젝트에 설치된 harness 파일 전체를 안전하게 제거하는 스킬이다. AX Navi가 생성한 `CLAUDE.md` · `.claude/skills/` · `.claude/agents/` · `.claude/patterns/` · `_workspace/`를 정리하며, 삭제 전 반드시 목록을 보여주고 사용자 확인을 받는다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "하네스 삭제", "하네스 제거", "harness 지워줘", "초기화 되돌려줘" |
| 영어 | "harness clean", "harness remove", "harness uninstall", "harness 롤백" |
| 슬래시 호출 | `/ax-navi:harness-clean` |
| 자동 트리거 | 없다. |

별칭은 없다. 프로젝트를 원래 상태로 되돌리거나, 다른 방식으로 다시 초기화하기 전에 잔여 파일을 깨끗이 비울 때 쓴다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Step 1 | `pwd`로 절대 경로를 확보하고 harness가 설치된 프로젝트 루트인지(`CLAUDE.md` 또는 `.claude/` 존재) 확인한다. 흔적이 없으면 "이 디렉토리에 harness가 설치되어 있지 않습니다."를 안내하고 종료한다. | 없음 | 없음 |
| Step 2 | 삭제 대상 경로를 Glob으로 확인해 존재하는 항목만 목록화한다. `CLAUDE.md`는 "## 변경 이력" 섹션에 `AX Navi v1`(또는 이전 이름 `harness-fin v1`) 항목이 있을 때만 harness 생성으로 판단한다. | Glob | 없음 |
| Step 3 | 탐지된 목록을 [harness 파일] / [분석 산출물] / [별도 확인 필요]로 나눠 제시하고 확인을 요청한다. | 없음 | **"삭제" 또는 "yes"**는 harness 파일과 산출물 삭제, **"전체 삭제"**는 `CLAUDE.md`까지 삭제, 그 외 입력은 취소다. |
| Step 4 | 확인된 항목을 삭제한다. `.claude/` 디렉토리가 비어 있으면 디렉토리도 함께 제거한다. | `Remove-Item -Recurse -Force` | 없음 |
| Step 5 | 삭제된 항목과 남아 있는 항목을 보고하고, 플러그인 자체 제거 명령(`/plugin uninstall ax-navi@ax-navi`)을 선택 사항으로 안내한다. | 없음 | 없음 |

### 삭제 대상 목록

| 분류 | 경로 | 조건 |
|------|------|------|
| 프로젝트 harness 파일 | `CLAUDE.md` | harness가 생성한 경우만, 별도 확인 항목 |
| 프로젝트 harness 파일 | `.claude/skills/trace.md`, `scaffolder.md`, `find-logic.md` | 존재하는 것만 |
| 프로젝트 harness 파일 | `.claude/skills/cross-repo-scaffold.md`, `cross-repo-modify.md` | 파트너 연동 시만 |
| 프로젝트 harness 파일 | `.claude/agents/domain-expert.md` | 존재하면 |
| 프로젝트 harness 파일 | `.claude/ito-guide.md` | 존재하면 |
| 프로젝트 harness 파일 | `.claude/patterns/`, `.claude/backup/` | 하위 파일 전체 |
| 분석 산출물 | `_workspace/` | 하위 파일 전체(`_workspace/wiki/` 포함) |

`analyze-impact`/`safe-modify`/`scaffold-feature`/`vibe`/`plan-migration`/`review-sql`은 프로젝트에 로컬 배포되지 않는 플러그인 전역 스킬이라 목록에 없다. 다만 구버전으로 초기화된 레거시 프로젝트에 잔존 사본이 있을 수 있어, `.claude/skills/*.md` 중 위 목록에 없는 파일이 발견되면 "레거시 잔존 사본으로 추정, 함께 삭제할지"를 별도 확인 항목으로 제시한다.

## 입력과 산출물

| 구분 | 대상 | 내용 |
|------|------|------|
| 읽는 파일 | `CLAUDE.md`의 "## 변경 이력" 섹션 | harness 생성 여부 판단 |
| 읽는 파일 | `.claude/`, `_workspace/` 하위 목록 | 존재하는 삭제 대상 탐지 |
| 쓰는 파일 | 없음 | 이 스킬은 파일을 생성하지 않고 삭제만 한다. |

삭제 뒤 남는 것은 사용자가 제외한 `CLAUDE.md`와 harness 외 파일이 섞여 있던 `.claude/` 디렉토리 자체다.

## 예시

```text
사용자: 하네스 삭제해줘

하네스: 다음 파일/폴더를 삭제합니다:

        [harness 파일]
          ✓ .claude/skills/trace.md
          ✓ .claude/skills/scaffolder.md
          ✓ .claude/skills/find-logic.md
          ✓ .claude/agents/domain-expert.md
          ✓ .claude/ito-guide.md
          ✓ .claude/patterns/ (하위 7개 파일)

        [분석 산출물]
          ✓ _workspace/ (하위 34개 파일)

        [별도 확인 필요]
          ? CLAUDE.md — harness가 생성한 것으로 보입니다. 함께 삭제할까요?

        백업 위치: .claude/backup/ 이 있으면 함께 삭제됩니다.

        계속하려면 "삭제" 또는 "yes"를 입력해주세요.
        CLAUDE.md도 함께 삭제하려면 "전체 삭제"를 입력해주세요.
        취소하려면 다른 내용을 입력해주세요.

사용자: 전체 삭제

하네스: harness 제거 완료

        삭제된 항목:
          - .claude/skills/ (3개 파일)
          - .claude/agents/domain-expert.md
          - .claude/patterns/ (7개 파일)
          - _workspace/ (34개 파일)
          - CLAUDE.md (전체 삭제 선택 시)

        플러그인 제거 (선택):
          AX Navi 플러그인 자체를 제거하려면 Claude Code에서 아래 명령을 실행하세요:
          /plugin uninstall ax-navi@ax-navi
```

취소하는 경우다.

```text
사용자: harness clean
하네스: (삭제 목록 제시)
사용자: 아니 잠깐, 위키는 남겨야 해
하네스: 취소됐습니다.
```

## 원칙과 주의

- **삭제 전 반드시 목록을 보여주고 사용자 확인을 받는다. 자동 삭제 없음.** 이것이 이 스킬의 최우선 원칙이다.
- **`CLAUDE.md`는 별도 확인 항목이다.** "## 변경 이력" 표에 AX Navi 항목이 없으면 사용자 작성 파일일 수 있으므로 harness 파일과 분리해 묻는다. "삭제"만으로는 지우지 않고 "전체 삭제"를 입력해야 함께 삭제된다.
- **`.claude/`에 harness 외 파일이 있으면** 디렉토리 자체는 삭제하지 않고 개별 파일만 삭제한다.
- **`_workspace/`에 사용자 파일이 섞여 있다고 의심되면** harness 산출물 파일명(`01_analyzer_report.md` 등)만 삭제하고 나머지는 보존한다.
- **삭제 권한이 없는 파일은** 건너뛰고 목록에 "삭제 실패"로 표시한다.
- **git 추적 파일을 삭제할 때는** "git에서 추적 중인 파일입니다. 삭제 후 git rm 또는 commit이 필요합니다."를 사전에 안내한다.
- `_workspace/wiki/`도 `_workspace/`와 함께 삭제된다. 위키를 보존해야 하면 취소하고 별도로 백업한 뒤 다시 실행한다.
- 플러그인 자체는 이 스킬이 제거하지 않는다. 안내된 `/plugin uninstall ax-navi@ax-navi`를 사용자가 직접 실행한다.

## 관련 문서

- [harness-init](/skills/harness-init.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [워크스페이스 파일](/reference/workspace-files.md)
- [설치](/getting-started/install.md)
- [문제 해결](/troubleshooting.md)
