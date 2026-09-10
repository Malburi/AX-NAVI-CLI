# 설치

AX Navi는 Claude Code 플러그인으로 배포됩니다. 이 페이지는 사전 요구 사항 점검부터 마켓플레이스 등록, 플러그인 설치, 설치 확인, 업데이트, 제거까지 한 번에 안내합니다. 처음 설치하는 경우와 구 `AX-NAVI` 저장소 등록이 남아 있는 경우를 모두 다룹니다.

## 사전 요구 사항

| 항목 | 요구 사항 | 어디에 쓰이나 |
|------|-----------|---------------|
| Claude Code | 최신 버전 (`claude plugin` 명령과 `/plugin` 슬래시 명령을 지원하는 버전) | 플러그인 설치·로딩 전체 |
| Node.js | 18 이상 | `build-index.mjs`(결정론적 인덱서)·`ai-budget.mjs`(견적·예산)·`validate-harness.mjs`(인덱스 스키마 검증). npm 의존성은 없습니다 |
| Python | 3 계열 (3.10 이상 권장) | `skills_builder.py`(하네스 파일 조립)·`pattern_profile.py`·`validator_checks.py`·`wiki_generator.py` 등 |
| Git | 임의 버전 | 생성된 `CLAUDE.md`·`.claude/`를 팀과 공유 |
| 셸 (Windows) | PowerShell 기준, Git Bash도 사용 가능 | 스킬 문서의 명령 예시는 PowerShell(`$env:CLAUDE_PLUGIN_ROOT`) 표기이며, bash에서는 `$CLAUDE_PLUGIN_ROOT`로 읽습니다 |

Python 인터프리터 이름은 `python3` → `python` → `py` 순서로 자동 탐지하므로 어느 이름으로 설치돼 있어도 됩니다. Node가 없으면 인덱서 대신 스택별 Python 추출기가 `symbols.json`·`call_graph.json`만 만들고, Python이 없으면 해당 블록을 WARN으로 보고한 뒤 건너뜁니다. 두 도구를 모두 갖추는 편이 결과 품질과 토큰 절감 양쪽에 유리합니다.

버전은 다음 명령으로 확인합니다.

```bash
claude --version
node --version
python --version
```

## 가장 빠른 설치 (터미널)

PowerShell·macOS·Linux에서 아래 두 줄을 그대로 실행하세요. 첫 줄은 `AX-NAVI-V2` GitHub 저장소를 `ax-navi` 마켓플레이스로 등록하고, 둘째 줄은 플러그인을 사용자 범위에 설치합니다. 마켓플레이스 등록은 최초 1회만 필요합니다.

```bash
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

이미 `ax-navi` 마켓플레이스를 등록했다면 첫 줄은 건너뛰고 둘째 줄만 실행하면 됩니다. 설치 후 새 Claude Code 세션을 시작하거나 `/reload-plugins`를 실행하세요.

## Claude Code 안에서 설치 (슬래시 명령)

터미널 대신 Claude Code 대화창에서도 같은 작업을 할 수 있습니다. 어느 프로젝트에서 실행해도 됩니다.

```text
/plugin marketplace add Malburi/AX-NAVI-V2
/plugin install ax-navi@ax-navi
/plugin list
```

`/plugin list` 결과에 `ax-navi@ax-navi — enabled`가 보이면 설치가 끝난 것입니다.

## 구 AX-NAVI 등록과 충돌할 때

기존 `ax-navi` 마켓플레이스가 구 저장소 `Malburi/AX-NAVI`를 가리키고 있으면 V2 등록이 이름 충돌을 일으킵니다. 이 경우 구 설치본과 마켓플레이스를 먼저 제거하고 V2를 등록합니다.

```bash
claude plugin uninstall ax-navi@ax-navi --scope user
claude plugin marketplace remove ax-navi
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

기존 마켓플레이스의 출처가 이미 `AX-NAVI-V2`라면 제거하지 말고 갱신만 하면 됩니다.

```bash
claude plugin marketplace update ax-navi
claude plugin install ax-navi@ax-navi --scope user
```

## 설치 확인

플러그인 상세 화면에서 구성 요소가 모두 로딩됐는지 확인합니다.

```bash
claude plugin details ax-navi@ax-navi
```

Claude Code 안에서는 `/plugin details ax-navi@ax-navi`로 같은 화면을 볼 수 있습니다. 다음 숫자가 맞으면 정상입니다.

| 구성 요소 | 개수 | 내용 |
|-----------|------|------|
| 스킬 | 24 | 워크플로우 스킬 17종 + 단축 별칭 7종(`/modify` `/impact` `/scaffold` `/find` `/flow` `/sql` `/wiki`) |
| 에이전트 | 19 | analyzer·writer·pattern-extractor·validator·harness-evaluator·pipeline-runner 등 |

설치 결과가 재로딩을 요구하면 `/reload-plugins`를 실행합니다. 다른 플러그인과 스킬 이름이 겹칠 수 있으면 첫 실행부터 네임스페이스를 붙여 호출할 수 있습니다.

```text
/ax-navi:harness-init
```

## 업데이트

마켓플레이스 카탈로그를 먼저 갱신한 뒤 플러그인을 업데이트합니다.

```bash
claude plugin marketplace update ax-navi
claude plugin update ax-navi@ax-navi
```

업데이트 후에는 새 세션을 시작하거나 `/reload-plugins`를 실행해야 새 스킬·에이전트 정의가 반영됩니다. 플러그인을 업데이트해도 대상 프로젝트에 이미 생성된 `CLAUDE.md`·`.claude/`는 바뀌지 않습니다. 생성 규칙이 크게 바뀐 릴리스라면 프로젝트에서 "하네스 다시 초기화해줘"로 재생성하세요.

## 제거

제거는 두 층으로 나뉩니다. 프로젝트에 생성된 하네스 파일과 플러그인 자체는 별개입니다.

| 대상 | 방법 | 비고 |
|------|------|------|
| 프로젝트의 하네스 파일 | 프로젝트 루트에서 "하네스 삭제해줘" 또는 "harness clean" | `harness-clean` 스킬이 삭제 대상 목록을 먼저 보여주고 확인을 받습니다. 자동 삭제는 없습니다 |
| 플러그인 자체 | `claude plugin uninstall ax-navi@ax-navi --scope user` 또는 `/plugin uninstall ax-navi@ax-navi` | 설치된 다른 프로젝트의 하네스 파일은 그대로 남습니다 |
| 마켓플레이스 등록 | `claude plugin marketplace remove ax-navi` | 다시 설치할 계획이 있으면 남겨 두어도 됩니다 |

`harness-clean`이 정리하는 항목은 `CLAUDE.md`(하네스가 생성한 경우만)·`.claude/skills/{trace,scaffolder,find-logic}.md`·`.claude/agents/domain-expert.md`·`.claude/ito-guide.md`·`.claude/patterns/`·`.claude/backup/`·`_workspace/`입니다.

## 설치가 안 될 때

- 저장소를 직접 클론했다면 루트에서 `claude plugin validate . --strict`를 실행해 매니페스트 오류를 확인하세요.
- Claude Code를 최신 버전으로 갱신하세요. 플러그인 명령 체계는 비교적 최근에 추가된 기능입니다.
- `/plugin list`에 보이는데 스킬이 동작하지 않으면 `/reload-plugins` 후 새 세션을 시작하세요.
- 그 밖의 증상은 [문제 해결](/troubleshooting.md)을 참고하세요.

## 관련 문서

- [10분 빠른 시작](/getting-started/quickstart.md)
- [첫 초기화 상세](/getting-started/first-harness.md)
- [Tier와 토큰 비용](/getting-started/tier-and-cost.md)
- [설정과 도구 정책](/configuration/settings-and-tools.md)
- [문제 해결](/troubleshooting.md)
