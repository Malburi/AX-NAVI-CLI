# AX-NAVI CLI

> **ITO/SI 레거시 코드베이스를 위한 AI 개발 내비게이터**
>
> 처음 투입된 프로젝트에서 _"이 코드 뭐야?"_ 부터 _"이 변경 안전해?"_ 까지.
> 터미널에서 `axnavi` 를 띄우고, 에이전트 19종과 워크플로우 스킬 24종을 자연어로 부릅니다.

<!-- ax = AI Transformation, navi = navigator. 낯선 코드베이스의 지도를 만들고 길을 안내한다는 뜻입니다. -->

```
  ╭─────────╮   ▄▀█ ▀▄▀   █▄░█ ▄▀█ █░█ █
  │ ◉ ─── ◉ │   █▀█ █░█   █░▀█ █▀█ ▀▄▀ █
  │   ▁▁▁   │
  ╰──┬───┬──╯   ITO/SI 레거시 코드베이스를 위한 AI 개발 내비게이터
  ═══╧═══╧═══   Enterprise AI Development Navigator
```

현재 버전 **v0.1.0-alpha.30**

---

## 목차

- [무엇을 하나요](#무엇을-하나요)
- [장점](#장점)
- [설치](#설치)
- [시작하기](#시작하기)
- [사용법](#사용법)
- [명령어](#명령어)
- [인증과 모델](#인증과-모델)
- [에이전트 · 스킬 목록](#에이전트--스킬-목록)
- [지원 스택](#지원-스택)
- [Claude Code 안에서 쓰기](#claude-code-안에서-쓰기)

---

## 무엇을 하나요

낯선 레거시 프로젝트에 들어갔을 때 필요한 일을 터미널 하나에서 합니다.

| 하고 싶은 일 | 이렇게 부탁합니다 |
|---|---|
| 기능이 어디 구현돼 있는지 찾기 | `/find 결제 승인 기능 찾아줘` |
| 화면·API 의 처리 흐름 따라가기 | `/flow 수강신청 저장 버튼 누르면 뭐가 실행돼?` |
| 고치기 전에 영향 범위 보기 | `/impact ApplyService.approve 시그니처 바꾸면?` |
| 컨벤션대로 안전하게 고치기 | `/modify 승인 시각을 함께 저장하게 해줘` |
| 기존 패턴 그대로 새 기능 만들기 | `/scaffold 공지사항 첨부파일 기능 추가` |
| SQL 점검 | `/sql 이 쿼리 성능 괜찮아?` |
| 프로젝트 문서(wiki) 만들기 | `/wiki` |

명령을 외우지 않아도 됩니다. **"하네스 초기화 해줘"** 처럼 말로 부탁하면 알맞은 스킬을 바로 실행합니다.

---

## 장점

- **코드베이스 지도를 먼저 만듭니다.** 심볼 · 호출 그래프 · SQL 사용처 · 트랜잭션 · 외부 통신 · DB 스키마를
  전수 파싱해 인덱스로 둡니다. AI 를 쓰지 않아 비용이 없고, 이후 모든 답이 이 지도를 근거로 나옵니다.
- **"없는 것"까지 알려 줍니다.** 찾은 것 · 확인했는데 없는 것 · 확인하지 못한 것을 나눠 보고합니다.
- **백엔드 · 프론트엔드를 함께 봅니다.** 두 저장소를 담은 상위 폴더에서 띄우면 저장소마다 나눠 병렬로 탐색합니다.
- **고치기 전에 바뀌는 줄을 보여 주고 허락을 받습니다.** 허용 · 거부 이력은 감사 기록으로 남습니다.
- **여러 에이전트가 일하는 모습이 보입니다.** 도는 동안 화면 바닥에 실시간으로 보이고, 끝나면 한 줄로 정리됩니다.
- **작업 중에도 계속 쓸 수 있습니다.** 다음 요청을 미리 입력하거나 `/bg` 로 백그라운드에 돌려 둡니다.
- **어느 환경에서나 알아서 돕니다.** 사내 게이트웨이 · AWS Bedrock 처럼 쓸 수 있는 모델이 정해진 곳에서도
  그 환경의 모델을 찾아 씁니다.
- **EUC-KR 레거시 파일도 인코딩을 지키며 고칩니다.** 고치는 동안에만 UTF-8 로 바꿨다가 원래대로 되돌립니다.
- **설치가 가볍습니다.** Claude 구독이 있으면 API 키도 추가 비용도 필요 없습니다. 폐쇄망은 파일 하나로 옮깁니다.
- **Windows 에서 편합니다.** 경로에 공백 · 한글이 있어도 되고, 한글 폭을 정확히 계산해 화면이 깨지지 않습니다.

---

## 설치

### 요구 사항

| 항목 | 버전 | 용도 |
|---|---|---|
| **Node.js** | 18.18 이상 (20 LTS 권장) | 실행 |
| **`claude` CLI** | 2.x | Claude 구독 로그인 ([인증과 모델](#인증과-모델)) |
| git | 아무 버전 | 변경 범위 표시 |
| Python | 3.8 이상 | wiki 생성 · 패턴 프로필 검증 등 일부 스킬 |

### 인터넷이 되는 PC

```bash
npm i -g https://codeload.github.com/Malburi/AX-NAVI-CLI/tar.gz/refs/tags/v0.1.0-alpha.30
```

git 프로토콜이 막힌 사내망에서도 되는 HTTPS 주소입니다. `npm i -g github:…` 형식은 쓰지 마세요.

### GitHub 에 접속되지 않는 PC

배포 담당자에게 받은 설치 파일로 설치합니다.

```powershell
npm i -g C:\경로\axnavi-0.1.0-alpha.30.tgz --omit=optional
```

`--omit=optional` 을 빼면 설치가 몇 분 멈춘 것처럼 보일 수 있습니다.

> **배포 담당자** — 태그를 체크아웃한 깨끗한 폴더에서 `npm pack` 으로 만듭니다.
> ```powershell
> git checkout v0.1.0-alpha.30
> npm pack    # axnavi-0.1.0-alpha.30.tgz
> ```

### PowerShell 에서 실행되지 않으면

`running scripts is disabled` 가 나오면 실행 정책 때문입니다. 관리자 권한 없이 둘 중 하나로 해결합니다.

```powershell
axnavi.cmd                                          # .cmd 로 부르면 바로 실행됩니다
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned # 또는 내 계정만 허용
```

### 업그레이드

대화형 모드를 띄우면 하루 한 번 새 판을 확인해 알려 줍니다.

```bash
axnavi upgrade                   # 최신 판으로
axnavi upgrade v0.1.0-alpha.29   # 특정 판으로
```

GitHub 에 접속되지 않는 PC는 새 설치 파일로 다시 설치합니다.

### 설치 확인

```bash
cd /path/to/내-프로젝트
axnavi doctor
```

```
진단  C:\work\my-project

  ✓ Node       v20.20.2
  ✓ Python     python 3.12.9
  ✓ git        git version 2.46.0
  ✓ 실행 경로  agent-sdk · 구독 인증 · 질문·승인은 axnavi 화면이 직접 받습니다
  ✓ 로그인     Claude 구독 로그인 기록 있음
  ✓ 인덱스     최신 — 소스 지문 일치 — 재인덱싱 불필요
  ✓ 인덱서     v1.16.0
  ✓ 에이전트   19개
  ✓ 스킬       17개 (+ 별칭 7)
```

---

## 시작하기

```bash
cd /path/to/내-프로젝트

axnavi index build      # 1) 코드베이스 지도 만들기 — AI 불필요, 비용 없음
axnavi index coverage   #    이 도구로 얼마나 다룰 수 있는지 진단서
axnavi                  # 2) 대화형으로 들어가기
```

```
AX-NAVI > 하네스 초기화 해줘.
```

하네스 초기화를 한 번 해 두면 이후 모든 작업이 프로젝트에 맞춰 돕니다.

---

## 사용법

### 대화형 모드

질문은 그대로 대화로 답하고, 스킬이 필요한 부탁은 알맞은 스킬을 바로 실행합니다.
어느 스킬인지 애매하면 짐작하지 않고 선택지를 띄웁니다.

| 조작 | 하는 일 |
|---|---|
| `/` | 명령 목록 — 타이핑하면 좁혀집니다 |
| `Tab` / `↑` `↓` | 후보 이동 |
| `Esc` | 메뉴 닫기 · 작업 중이면 중단 |
| `Ctrl+C` | 작업 중단 · 빈 줄에서 두 번이면 종료 |
| `Shift+Tab` (또는 빈 줄에서 `Tab`) | 실행 모드 바꾸기 |
| `Ctrl+O` | 접힌 결과(`… +N줄`) 펼쳐 보기 |

### 자주 쓰는 스킬 단축 별칭

| 별칭 | 스킬 | 하는 일 |
|---|---|---|
| `/find` | `find-feature` | 기능·키워드로 코드 위치 탐색 |
| `/flow` | `trace-logic` | 처리 흐름 추적 |
| `/impact` | `analyze-impact` | 변경 영향도 분석 |
| `/modify` | `safe-modify` | 안전 변경 (영향도 → 변경 → 3단 검증) |
| `/scaffold` | `scaffold-feature` | 컨벤션 따라 신규 기능 생성 |
| `/sql` | `review-sql` | SQL 리뷰 |
| `/wiki` | `generate-wiki` | 산출물 → wiki 생성 |

### 하네스 초기화

프로젝트를 전수 분석해 이후 작업의 근거가 되는 자산을 만듭니다.

```
프로젝트/
├── CLAUDE.md                ← 프로젝트 맞춤 컨텍스트
├── .claude/
│   ├── agents/              ← 이 프로젝트 전용 도메인 에이전트
│   └── patterns/            ← 코드 컨벤션 프로필 (근거 파일 포함)
└── _workspace/
    ├── index/               ← 코드베이스 전수 인덱스 (심볼 · 호출 · SQL · 트랜잭션 · 스키마 …)
    ├── reports/             ← 스킬이 남기는 리포트
    └── 0*_*.md              ← 단계별 분석 리포트
```

분석 깊이는 두 가지입니다. 인덱싱 후 규모와 견적을 보여 주고 고르게 합니다.

| Tier | 언제 | 비용 |
|---|---|---|
| **Full** (기본) | 심층 분석 · 마이그레이션 · 대규모 수정 계획 | 기준 |
| **Standard** | 일상 유지보수 | Full 의 약 60% |

### 물어봐야 할 때는 물어봅니다

사람이 정할 일은 선택지를 띄웁니다. 방향키나 번호로 고르고 Enter 입니다. 선택지 개수에 제한이 없고,
선택지가 없는 질문은 그 자리에서 입력합니다.

```
╭───────────────╮
│ 프로젝트 구성 │
╰───────────────╯

  프로젝트 루트에 my-client, my-server 두 하위 폴더가 있습니다.
  하네스 초기화를 어떤 구성으로 진행할까요?

  1. 단일 프로젝트로 초기화 (Recommended)
❯ 2. 서버·클라이언트 함께 초기화 (모노레포)
  3. 서버·클라이언트 각각 초기화 후 연결 (1:1)
  4. 기타 (부분 범위 / 허브형 1:N)

  ↑↓ 이동 · Enter 선택 · 번호 입력 · Esc 건너뜀
```

### 파일을 고치기 전에 허락을 받습니다

파일을 쓰거나 고치거나 명령을 실행하기 전에, 무엇이 바뀌는지 보여 주고 묻습니다.

```
╭──────╮
│ 권한 │
╰──────╯

  +1
  4       a.setStatus("Y");
  5 +     a.setApprovedAt(now());
  6       dao.update(a);

● Edit  C:\proj\src\ApplyService.java
  실행할까요?

❯ 1. 예
  2. 예, 이번 세션 동안 파일 수정은(는) 묻지 않음
  3. 예, 이번 세션 동안 모두 묻지 않음
  4. 아니오
```

- 파일 수정은 바뀌는 줄과 줄 번호를, 명령 실행은 명령 전체를 보여 줍니다.
- 아무것도 바꾸지 않는 명령(`ls` · `git status` 등)과 axnavi 자신의 스크립트는 묻지 않습니다.
- "이번 세션 동안 묻지 않음" 은 명령 이름 단위로 기억합니다. `npm` 을 허용해도 `rm` 은 따로 묻습니다.
- 오래 걸리는 초기화는 "모두 묻지 않음" 을 한 번 누르면 됩니다.
- 허용 · 거부 이력은 `.axnavi/logs/audit.jsonl` 에 남습니다.

### 저장소가 여럿이면 나눠 찾습니다

백엔드 · 프론트엔드 저장소를 담은 **상위 폴더**에서 띄워도 됩니다. 인덱스를 가진 하위 저장소를 찾아
저장소마다 에이전트를 하나씩 띄워 병렬로 훑습니다.

```
  ✓ 인덱스      저장소 2개 — my-client(1428파일·Full), my-server(2575파일·Full)
```

### 무엇이 벌어지는지 보입니다

여러 에이전트가 동시에 돌면 화면 바닥에 에이전트마다 최근 활동이 흐르고, 끝나면 한 줄로 정리됩니다.

```
● Task(기능 위치 탐색 (client))
● Task(기능 위치 탐색 (server))
  ⎿ 기능 위치 탐색 (client) 끝남 · 도구 17회 · 2m 41s
  ⎿ 기능 위치 탐색 (server) 끝남 · 도구 31회 · 4m 12s
```

지나간 작업은 `/log` 로 에이전트별로 되짚어 볼 수 있습니다.

### 작업 중에도 계속 쓸 수 있습니다

작업이 도는 동안에도 입력할 수 있고, 입력한 요청은 지금 작업이 끝나면 순서대로 실행됩니다.

```
────────────────────────────────────────────────────────────────────────────
❯ /index refresh▏
────────────────────────────────────────────────────────────────────────────
⠹ harness-init › analyzer · 8m 7s · ↓ 30.6k tokens · Read   agent-sdk · deep · Ctx 27.1k
```

오래 걸리는 일은 백그라운드로 돌려 두고 다른 대화를 이어갑니다.

```
AX-NAVI > /bg 하네스 초기화 해줘
AX-NAVI [⠿ 1] > 이 프로젝트 빌드는 어떻게 해?
```

### 모드와 모델

`Shift+Tab` 으로 실행 모드를 바꿉니다. `/mode 계획` 처럼 이름으로 지정할 수도 있습니다.

| 모드 | 하는 일 |
|---|---|
| **자동** (기본) | 안전한 작업은 판단해서 묻지 않고, 나머지는 묻습니다 |
| **매번 묻기** | 승인이 필요한 작업을 모두 묻습니다 |
| **계획** | 파일을 고치지 않고 고칠 파일 · 순서 · 검증 방법부터 내놓습니다 |
| **빠름** | 영향도 · 안전 검토를 건너뛰고 바로 진행합니다 |
| **전부승인** | 이번 세션의 도구 사용을 묻지 않습니다(감사 기록은 남음). `/mode 전부승인` 으로만 켭니다 |

모델은 `/model` 로 바꿉니다(`haiku` · `sonnet` · `opus` · `기본`). `기본` 은 에이전트마다 정해진 모델을 씁니다.

### 대화가 이어집니다

| 명령 | 하는 일 |
|---|---|
| `/sessions` · `/resume` | 저장된 대화 목록 · 이전 대화로 돌아가기 |
| `/context` · `/new` | 지금 대화 상태 · 새로 시작 |
| `axnavi --continue` | 터미널에서 마지막 대화 이어서 |

대화가 길어지면 오래된 도구 결과부터 접어서 자동으로 줄입니다.

---

## 명령어

```
axnavi                          대화형 모드
axnavi --continue               마지막 대화를 이어서
axnavi --resume <세션id>         특정 대화를 이어서
axnavi ask <요청>               한 번 묻고 답받기 (읽기 전용)
axnavi init                     .axnavi/ 설정 생성
axnavi doctor                   실행 환경 진단
axnavi upgrade [태그]            최신 판으로 (태그를 주면 그 판으로)
axnavi keys                     터미널이 보내는 키 확인

axnavi index build              코드베이스 인덱싱 (AI 불필요)
axnavi index status             인덱스 신선도
axnavi index refresh            증분 갱신
axnavi index coverage [경로]    커버리지 진단서 (AI 불필요)

axnavi agent list | run <이름> <요청>
axnavi skill list | run <이름> <요청>
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--root <경로>` | 현재 폴더 | 프로젝트 루트 |
| `--index-dir <경로>` | `<root>/_workspace/index` | 인덱스 위치 |
| `--tier <등급>` | `Auto` | `Auto` · `Standard` · `Full` |
| `--provider <이름>` | `auto` | `auto` · `agent-sdk` · `claude-cli` · `anthropic` |
| `--verbose` | 꺼짐 | 도구 목록 · 토큰 내역 · 감사 기록 경로 |

**대화형 모드의 슬래시 명령** — `/` 를 치면 아래 목록과 스킬 24종이 함께 뜹니다.

| 명령 | 하는 일 |
|---|---|
| `/help` · `/status` | 명령 목록 · 프로젝트 상태 |
| `/agents` · `/skills` · `/agent <이름> <요청>` | 에이전트 · 스킬 목록, 에이전트 직접 실행 |
| `/index [build\|status\|refresh]` | 인덱스 빌드 · 상태 |
| `/context` · `/new` · `/sessions` · `/resume` | 대화 관리 |
| `/model` · `/mode` | 모델 · 실행 모드 바꾸기 |
| `/bg <요청>` · `/tasks` | 백그라운드 실행 · 작업 목록 (`/tasks stop <번호>`) |
| `/log` | 지나간 작업 되짚어 보기 |
| `/exit` | 종료 |

---

## 인증과 모델

### Claude 구독 (기본 · 권장)

이미 쓰고 있는 `claude` CLI 의 로그인을 그대로 씁니다. **API 키도, 추가 비용도 필요 없습니다.**

```bash
claude     # 한 번 로그인해 두면 됩니다
axnavi
```

연결 방식은 axnavi 가 알아서 고릅니다.

| 연결 | 언제 |
|---|---|
| `agent-sdk` (기본) | 인터넷으로 설치해 Claude Agent SDK 가 함께 설치됐을 때 |
| `claude-cli` | SDK 없이 설치했을 때(폐쇄망 설치 파일). 설치된 `claude` 를 씁니다 |

### Anthropic API 키

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
axnavi --provider anthropic
```

질문 · 대화와 단일 에이전트 스킬에 씁니다. `axnavi index build` 는 인증 없이도 돌아갑니다.

### 쓸 모델

axnavi 는 모델을 `haiku` · `sonnet` · `opus` 세 등급으로 부릅니다. **따로 설정하지 않아도 됩니다.**
사내 게이트웨이나 AWS Bedrock 처럼 쓸 수 있는 모델이 정해진 환경에서 모델이 막히면, 그 환경에서
쓸 수 있는 같은 계열의 가장 새 모델로 바로 다시 실행하고, 다음부터는 처음부터 그 모델을 씁니다.

```
  이 환경은 claude-sonnet-5 를 쓸 수 없어 사용 가능한 모델(claude-sonnet-4-6, …)로 다시 실행합니다.
```

회사에서 쓸 모델을 정해 두려면 `~/.claude/settings.json`(관리자는 `managed-settings.json`)의 `env` 에
지정합니다. 정해 둔 값이 항상 우선합니다.

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

---

## 에이전트 · 스킬 목록

<details>
<summary><b>에이전트 19종</b></summary>

| 에이전트 | 역할 |
|---|---|
| `analyzer` | 코드베이스 전수 분석 → 구조·레이어·의존성 리포트 |
| `writer` | 분석 결과 → CLAUDE.md · 도메인 에이전트 생성 |
| `pattern-extractor` | 코드 컨벤션 추출 → 근거 파일이 있는 패턴 프로필 |
| `validator` | 생성 산출물 검증 (파일 존재 · 트리거 품질 · 경로 교차 · 보안) |
| `qa` | 경계면 교차 비교 (Boundary 1~7) |
| `harness-evaluator` | 4차원 품질 채점 → 80점 미만 시 타겟 재생성 |
| `spec-clarifier` | 착수 전 명세 명확화 |
| `pipeline-runner` | 인덱싱 · 조립 · 검증 스크립트 실행 |
| `impact-analyzer` | 변경 대상의 직간접 영향 분석 |
| `change-safety` | 변경 안전성 판정 (GO / HOLD / STOP) |
| `pattern-conformance` | 변경이 프로젝트 컨벤션을 따르는지 |
| `migration-planner` | 스택 마이그레이션 계획 |
| `test-generator` | 테스트 생성 |
| `sql-reviewer` | SQL 리뷰 |
| `legacy-decoder` | 레거시 코드 해석 |
| `logic-tracer` | 처리 흐름 추적 |
| `feature-finder` | 기능·키워드로 코드 위치 탐색 |
| `doc-syncer` | 문서 동기화 |
| `api-bridge` | 백엔드↔프론트엔드 API 계약 추출·검증·스텁 생성 |

</details>

<details>
<summary><b>워크플로우 스킬 17종 + 단축 별칭 7종</b></summary>

**여러 에이전트를 지휘하는 스킬**

| 스킬 | 하는 일 |
|---|---|
| `harness-init` | 하네스 초기화 / 재초기화 |
| `safe-modify` | 안전 변경 (영향도 → 변경 → conformance·verify·safety 3단 검증) |
| `scaffold-feature` | 컨벤션 따라 신규 기능 생성 |
| `pair-init` | 백엔드·프론트엔드 별도 저장소 연동 |
| `cross-repo-scaffold` | 전체 스택 기능 동시 생성 |
| `cross-repo-modify` | 기존 기능 개선을 양쪽 저장소에 동시 반영 |
| `plan-migration` | 스택 마이그레이션 계획 |
| `spec-gate` | 초기화 전 명세 명확화 |

**단일 에이전트 스킬**

| 스킬 | 별칭 | 하는 일 |
|---|---|---|
| `find-feature` | `/find` | 기능·키워드로 코드 위치 탐색 |
| `trace-logic` | `/flow` | 처리 흐름 추적 |
| `analyze-impact` | `/impact` | 변경 영향도 분석 |
| `review-sql` | `/sql` | SQL 리뷰 |
| `generate-wiki` | `/wiki` | harness 산출물 → wiki |
| `publish-wiki` | | wiki 를 중앙 허브 DB 에 발행 |
| `harness-clean` | | 하네스 전체 제거 |

**작업 방식**

| 스킬 | 하는 일 |
|---|---|
| `vibe` | 영향·안전 검토를 생략한 빠른 작업 (패턴·최소 검증은 유지) |
| `wiki-hub` | 여러 시스템 wiki 통합 열람·검색·버전 관리 |

</details>

---

## 지원 스택

| 스택 | 수준 |
|---|---|
| Java / Spring · Struts | **FULL** — 심볼 · 호출 그래프 · SQL · 트랜잭션 · 스키마 |
| JavaScript / TypeScript (Vue · React) | FULL (일부 동적 패턴은 PARTIAL) |
| Python · Go · C#/.NET | FULL |
| ASP.NET Core · WinForms · Nexacro | 전용 어댑터로 보강 |
| WinForms Designer · DevExpress · XFDL · JSP/Struts XML | **PARTIAL** |
| Oracle PL/SQL (패키지 · 프로시저 · 트리거) | **PARTIAL** — 심볼 · 호출 · 정적 SQL · Java `{call}` 연결 |
| Oracle Pro*C 배치 (`.pc`) | **PARTIAL** — C 함수 · 호출 · EXEC SQL · PL/SQL 프로시저 연결 |
| PowerBuilder 텍스트 내보내기 (`.srw` · `.srd` 등) | **PARTIAL** — 이벤트 · 함수 · 임베디드 SQL · DataWindow 연결 |

PARTIAL 대상은 에이전트가 원문을 직접 읽어 확인한 뒤 수정합니다. 읽을 수 없는 형식만 수정을 보류합니다.

---

## Claude Code 안에서 쓰기

같은 에이전트 · 스킬을 Claude Code 플러그인으로도 쓸 수 있습니다.

```bash
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

이전 주소로 등록해 둔 경우에는 다시 등록합니다.

```bash
claude plugin uninstall ax-navi@ax-navi --scope user
claude plugin marketplace remove ax-navi
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

---

## 개발

```bash
npm test              # 전체 테스트
npm run typecheck     # 타입 검사 (JSDoc + checkJs, 빌드 단계 없음)
```

소스를 그대로 실행합니다 — `node packages/cli/src/bin.mjs` 가 곧 실행 파일입니다.

---

## 라이선스

MIT
