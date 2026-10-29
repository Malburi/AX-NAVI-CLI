# AX-NAVI CLI

> **ITO/SI 레거시 코드베이스를 위한 AI 개발 내비게이터**
>
> 처음 투입된 프로젝트에서 _"이 코드 뭐야?"_ 부터 _"이 변경 안전해?"_ 까지.
> 터미널에서 `axnavi` 를 띄우고, 에이전트 19종과 워크플로우 스킬 26종을 자연어로 부릅니다.

<!-- ax = AI Transformation, navi = navigator. 낯선 코드베이스의 지도를 만들고 길을 안내한다는 뜻입니다. -->

```
  ╭─────────╮   ▄▀█ ▀▄▀   █▄░█ ▄▀█ █░█ █
  │ ◉ ─── ◉ │   █▀█ █░█   █░▀█ █▀█ ▀▄▀ █
  │   ▁▁▁   │
  ╰──┬───┬──╯   ITO/SI 레거시 코드베이스를 위한 AI 개발 내비게이터
  ═══╧═══╧═══   Enterprise AI Development Navigator
```

현재 버전 **v0.1.0-alpha.27**

---

## 목차

- [무엇을 하나요](#무엇을-하나요)
- [장점](#장점)
- [설치](#설치)
- [시작하기](#시작하기)
- [사용법](#사용법)
- [명령어](#명령어)
- [인증](#인증)
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

**코드베이스 전체 지도를 먼저 만듭니다.**
심볼 · 호출 그래프 · SQL 사용처 · 트랜잭션 경계 · 외부 통신 · DB 스키마를 전수 파싱해 인덱스로 둡니다.
이 단계는 AI 를 쓰지 않아 비용이 들지 않고, 이후 모든 답이 이 지도를 근거로 나옵니다.

**찾은 것뿐 아니라 "없는 것"까지 알려 줍니다.**
찾은 것 · 확인했는데 없는 것 · 확인하지 못한 것을 나눠서 보고합니다.
"관련 DB 컬럼 없음 · SQL 0건" 같은 사실이 판단에 바로 쓰입니다.

**백엔드 · 프론트엔드 저장소를 함께 봅니다.**
두 저장소를 담은 상위 폴더에서 띄우면 알아서 찾아 저장소마다 나눠 병렬로 탐색합니다.

**고치기 전에 무엇이 바뀌는지 보여 주고 허락을 받습니다.**
바뀌는 줄을 줄 번호와 함께 보여 주고, "예 / 이번 세션 동안 묻지 않음 / 이번 세션 동안 모두 묻지 않음 / 아니오" 로 고릅니다.
읽기만 하는 명령과 axnavi 자신의 스크립트는 묻지 않습니다. 허용 · 거부 이력은 감사 기록으로 남습니다.

**여러 에이전트가 동시에 일하는 모습이 보입니다.**
어떤 에이전트가 무엇을 하고 있는지 화면 바닥에 실시간으로 보이고, 끝나면 한 줄로 정리됩니다.
지나간 작업은 `/log` 로 에이전트별로 되짚어 볼 수 있습니다.

**작업 중에도 계속 쓸 수 있습니다.**
긴 작업이 도는 동안 다음 요청을 입력해 두거나, `/bg` 로 백그라운드에 돌려 두고 다른 대화를 이어갑니다.

**필요할 때는 묻고, 선택지 개수에 제한이 없습니다.**
프로젝트 구성처럼 사람이 정할 일은 선택지를 띄워 묻습니다. 자유 입력도 그 자리에서 받습니다.

**비용과 토큰이 그대로 보입니다.**
턴마다 걸린 시간 · 비용 · 컨텍스트 크기를 표시합니다.

**설치가 가볍습니다.**
필수 런타임 의존성이 0입니다. Claude 구독이 있으면 API 키 없이 추가 비용 없이 씁니다.
기본 연결인 Claude Agent SDK 는 선택 의존성이라 인터넷이 되면 함께 설치되고(Claude Code 실행 파일 포함, 약 240MB),
폐쇄망에 파일 하나로 옮겨 SDK 가 없으면 설치된 `claude` CLI 연결로 자동으로 돕니다.

**Windows 에서 편하게 씁니다.**
경로에 공백과 한글이 있어도 되고, 한글 폭을 정확히 계산해 화면이 깨지지 않습니다.

**EUC-KR 레거시 파일도 인코딩을 지키며 고칩니다.**
EUC-KR · CP949 등으로 저장된 파일은 읽고 고치는 동안에만 UTF-8 로 바꿨다가 끝나면(실패 · 거부 · 세션 종료 포함) 원래 인코딩으로 되돌립니다.
원래 인코딩으로 온전히 되돌릴 수 없거나 32MB 를 넘는 파일은 읽기만 하고 수정은 `인코딩 보존 불가` 로 거부합니다. Claude Code 플러그인으로 쓸 때도 같은 훅이 걸립니다.

---

## 설치

### 요구 사항

| 항목 | 버전 | 용도 |
|---|---|---|
| **Node.js** | 18.18 이상 (20 LTS 권장) | 실행 |
| **`claude` CLI** | 2.x | 구독 로그인([인증](#인증)). SDK 가 없는 설치(폐쇄망)에서는 실행도 맡습니다 |
| git | 아무 버전 | 변경 범위 표시 |
| Python | 3.8 이상 | wiki 생성 · 패턴 프로필 검증 등 일부 스킬 |

### 설치하기

GitHub 태그에서 바로 받습니다. npm 계정이 필요 없습니다.

```bash
npm i -g https://codeload.github.com/Malburi/AX-NAVI-CLI/tar.gz/refs/tags/v0.1.0-alpha.27
```

> `npm i -g github:Malburi/AX-NAVI-CLI` 대신 위의 주소를 쓰세요.
> 위 주소는 평범한 HTTPS 다운로드라 git 프로토콜이 막힌 사내망에서도 설치됩니다.
> 의존성 버전은 `npm-shrinkwrap.json` 으로 고정돼 있어 언제 설치해도 같은 판이 깔립니다.

**폐쇄망**에서는 파일 하나로 옮깁니다. 태그를 체크아웃한 깨끗한 폴더에서 만들어야 받는 쪽이 태그와 같은 판을 받습니다.

```powershell
git checkout v0.1.0-alpha.27
npm pack                                                          # axnavi-0.1.0-alpha.27.tgz 생성
npm i -g \\공유폴더\axnavi-0.1.0-alpha.27.tgz --omit=optional   # 받는 쪽
```

`--omit=optional` 을 빼면 npm 이 선택 의존성(Claude Agent SDK)을 받으려고 레지스트리에 붙다가 약 5분 동안 멈춘 것처럼 보입니다. SDK 없이 설치하면 설치된 `claude` CLI 로 실행합니다.

**PowerShell 에서 `axnavi` 가 실행되지 않으면** 실행 정책 때문입니다(`running scripts is disabled`). 관리자 권한 없이 둘 중 하나로 해결합니다.

```powershell
axnavi.cmd                                          # .cmd 로 부르면 정책과 상관없이 실행됩니다
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned # 또는 내 계정만 허용
```

### 업그레이드

대화형 모드를 띄우면 하루 한 번 새 판이 있는지 확인해 알려 줍니다.

```
  새 판  0.1.0-alpha.26 → v0.1.0-alpha.27 · axnavi upgrade
```

```bash
axnavi upgrade                   # 최신 판으로
axnavi upgrade v0.1.0-alpha.26   # 특정 판으로
```

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
  ✓ 실행 경로  claude-cli 2.x · 구독 인증 · 도구 제약은 claude 권한 체계가 강제합니다
  ✓ 로그인     Claude 구독 로그인 기록 있음
  ! CLI 설정   없음 — axnavi init
  ✓ 인덱스     최신 — 소스 지문 일치 — 재인덱싱 불필요
  ✓ 인덱서     v1.16.0
  ✓ 에이전트   19개
  ✓ 스킬       17개 (+ 별칭 7)
```

---

## 시작하기

```bash
cd /path/to/내-프로젝트

# 1) 코드베이스 지도 만들기 — AI 를 쓰지 않아 비용이 없습니다
axnavi index build
axnavi index coverage   # 이 도구로 얼마나 다룰 수 있는지 진단서 (역시 AI 불필요)

# 2) 한 번 물어보기
axnavi ask "결제 승인 처리가 어디서 시작되나?"

# 3) 대화형으로 들어가기
axnavi
```

프로젝트를 깊이 있게 쓰려면 대화형 모드에서 **하네스 초기화**를 한 번 해 두세요.

```
AX-NAVI > 하네스 초기화 해줘.
```

---

## 사용법

### 대화형 모드

`axnavi` 를 인자 없이 실행하면 대화형 모드가 뜹니다. 질문은 그대로 대화로 답하고,
스킬이 필요한 부탁은 알맞은 스킬을 바로 실행합니다.

```
AX-NAVI > 이 프로젝트 인증은 어떻게 되어 있어?
AX-NAVI > 하네스 초기화 해줘.
  ⋯ /harness-init
```

어느 스킬인지 애매하면 짐작하지 않고 선택지를 띄웁니다.

| 조작 | 하는 일 |
|---|---|
| `/` | 명령 목록이 아래에 뜨고, 타이핑하면 좁혀집니다 |
| `Tab` / `↑` `↓` | 후보 이동 |
| `Enter` | 실행 |
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

`harness-init` 은 프로젝트를 전수 분석해 이후 작업이 근거 위에서 돌도록 자산을 만듭니다.
분석 · 작성 · 패턴 추출 · 검증 에이전트를 차례로 지휘합니다.

```
AX-NAVI > /harness-init
```

```
프로젝트/
├── CLAUDE.md                    ← 프로젝트 맞춤 컨텍스트
├── .claude/
│   ├── agents/                  ← 이 프로젝트 전용 도메인 에이전트
│   └── patterns/                ← 코드 컨벤션 프로필 (근거 파일 포함)
└── _workspace/
    ├── index/                   ← 코드베이스 전수 인덱스
    │   ├── symbols.json         ← 심볼 정의·위치
    │   ├── call_graph.json      ← 호출 관계
    │   ├── sql_usage.json       ← SQL 사용처
    │   ├── transactions.json    ← 트랜잭션 경계
    │   ├── external_io.json     ← 외부 통신
    │   └── schema.json          ← DB 스키마 (DDL 없으면 SQL에서 유도)
    ├── reports/                 ← 스킬이 남기는 리포트
    └── 0*_*.md                  ← 단계별 분석 리포트
```

분석 깊이는 두 가지입니다. 초기화 중에 규모와 견적을 보여 주고 고르게 합니다.

| Tier | 언제 | 비용 |
|---|---|---|
| **Full** (기본) | 심층 분석 · 마이그레이션 · 대규모 수정 계획 | 기준 |
| **Standard** | 일상 유지보수 | Full 의 약 60% |

인덱스는 코드 식별자 기준이고, 한글 업무 용어는 `search` 로 찾습니다.
SQL 주석과 엔드포인트 설명까지 훑어서 찾습니다.

```
  symbol "로그인"  →   0건
  search "로그인"  → 384건
```

### 물어봐야 할 때는 물어봅니다

사람이 정할 일은 선택지를 띄웁니다. 방향키나 번호로 고르고 Enter 입니다.

```
╭───────────────╮
│ 프로젝트 구성 │
╰───────────────╯

  프로젝트 루트에 my-client, my-server 두 하위 폴더가 있습니다.
  하네스 초기화를 어떤 구성으로 진행할까요?

  1. 단일 프로젝트로 초기화 (Recommended)
     지금 폴더 전체를 단일 프로젝트로 분석합니다
❯ 2. 서버·클라이언트 함께 초기화 (모노레포)
     my-server(backend)와 my-client(frontend)를 워크스페이스로 통합 분석합니다
  3. 서버·클라이언트 각각 초기화 후 연결 (1:1)
     두 프로젝트를 독립적으로 초기화하고 pair-init으로 연결합니다
  4. 기타 (부분 범위 / 허브형 1:N)

  ↑↓ 이동 · Enter 선택 · 번호 입력 · Esc 건너뜀
```

선택지 개수에 제한이 없습니다. 선택지가 없는 질문은 그 자리에서 바로 입력합니다.

```
  답 > http://localhost:8080/api▏
  Enter 확인 · Esc 건너뜀
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

| 도구 | 보여 주는 것 |
|---|---|
| 파일 수정 (`Edit`) | 바뀌는 줄과 앞뒤 3줄, 파일에서의 실제 줄 번호 |
| 파일 쓰기 (`Write`) | 새 파일이면 줄 수, 있는 파일이면 바뀌는 부분 |
| 여러 곳 수정 (`MultiEdit`) | 편집마다 각자의 줄 번호로 |
| 명령 실행 (`Bash`) | 실행할 명령 전체 |

- **묻지 않는 것** — 아무것도 바꾸지 않는 명령(`ls` · `cat` · `grep` · `find` · `git status` · `git log` 등)과
  axnavi 자신의 스크립트(`agents/lib/*` 인덱서 · 검증기)는 창 없이 허용하고 감사 기록에만 남깁니다.
  따옴표 밖 리다이렉트(`>`) · 명령 치환(`$(…)`) · `find -delete` · `sed -i` 처럼 바꿀 수 있는 형태가 섞이면 묻습니다.
- **"이번 세션 동안 묻지 않음"** 은 대화가 이어지는 동안 유지됩니다.
  명령은 이름 단위로 기억하므로 `npm` 을 허용해도 `rm` 은 따로 묻습니다. `git` 은 하위 명령 단위입니다
  (`git status` 와 `git push` 는 따로). `ls …; git push` 같은 복합 명령은 조각마다 허용돼 있어야 지나갑니다.
- **"이번 세션 동안 모두 묻지 않음"** 은 오래 걸리는 초기화를 믿고 맡길 때 한 번만 누르면 됩니다.
- 허용 · 거부 이력은 `.axnavi/logs/audit.jsonl` 에 남습니다.
- 개인 · 조직의 Claude Code 권한 설정을 그대로 따릅니다. 설정이 묻지 않아도 된다고 한
  작업은 창 없이 진행합니다.

### 저장소가 여럿이면 나눠 찾습니다

백엔드 · 프론트엔드 저장소를 담은 **상위 폴더**에서 띄워도 됩니다. 인덱스를 가진 하위
저장소를 찾아 저장소마다 따로 질의하고, 서브에이전트를 저장소마다 하나씩 띄워 병렬로 훑습니다.

```
  ✓ 인덱스      저장소 2개 — my-client(1428파일·Full), my-server(2575파일·Full)
```

`pair_config.md` 로 연결된 짝 저장소는 옆 폴더가 아니어도 따라갑니다.

### 무엇이 벌어지는지 보입니다

여러 에이전트가 동시에 돌면 화면 바닥에 에이전트마다 블록이 붙어 최근 활동이 흐르고,
끝나면 한 줄로 정리됩니다.

```
● Task(기능 위치 탐색 (client))
● Task(기능 위치 탐색 (server))
  ⎿ 기능 위치 탐색 (client) 끝남 · 도구 17회 · 2m 41s
  ⎿ 기능 위치 탐색 (server) 끝남 · 도구 31회 · 4m 12s
```

서브에이전트 안에서 난 일은 들여써서 누가 한 일인지 구분합니다.

```
● Task(백엔드 분석)
│ ● Read(src/main/java/.../PaymentService.java)  240줄 읽음
│ ● Grep(doApprove)  12건
│ ● Bash(python agents/lib/pattern_profile.py --root .)
│   ⎿  profile=spring-mvc confidence=0.82
  ⎿ 끝남 · 도구 3회 · 1m 12s
```

답이 리포트 파일을 안내했는데 이번 실행에서 그 파일이 쓰이지 않았으면 끝에 알려 줍니다.

지나간 작업은 `/log` 로 되짚습니다. 전체 화면이 열리고, 턴 → 서브에이전트로 접었다 펴면서
그 에이전트가 한 일만 따로 볼 수 있습니다. `q` 로 나가면 원래 화면으로 돌아옵니다.

### 작업 중에도 계속 쓸 수 있습니다

작업이 도는 동안 화면 바닥에 입력 판과 상태 줄이 붙습니다.

```
────────────────────────────────────────────────────────────────────────────
❯ /index refresh▏
────────────────────────────────────────────────────────────────────────────
⠹ harness-init › analyzer · 8m 7s · ↓ 30.6k tokens · Read   agent-sdk · deep · Ctx 27.1k
```

작업 중에 입력한 요청은 그대로 보이고, 지금 작업이 끝나면 순서대로 실행됩니다.

오래 걸리는 일은 백그라운드로 돌려 두고 다른 대화를 이어갈 수 있습니다.

```
AX-NAVI > /bg 하네스 초기화 해줘
AX-NAVI [⠿ 1] > 이 프로젝트 빌드는 어떻게 해?
```

| 명령 | 하는 일 |
|---|---|
| `/bg <요청>` | 백그라운드로 돌리기 |
| `/tasks` | 백그라운드 작업 목록 · `/tasks stop <번호>` 로 중단 |

### 모드와 모델

`Shift+Tab` 으로 실행 모드를 바꿉니다. 지금 모드는 프롬프트에 표시됩니다.
`/mode 계획` 처럼 이름으로 바로 지정할 수도 있습니다.

| 모드 | 하는 일 |
|---|---|
| **기본** | 에이전트가 선언한 도구 그대로 |
| **계획** | 파일을 고치지 않고, 고칠 파일 · 줄 · 순서 · 검증 방법을 먼저 내놓습니다 |
| **빠름** | 영향도 · 안전 검토를 건너뛰고 빠르게 진행합니다 |
| **전부승인** | 이번 세션의 도구 사용을 묻지 않고 허용합니다(감사 기록은 남음). `Shift+Tab` 으로는 켜지지 않고 `/mode 전부승인` 으로만 켭니다 |

```
AX-NAVI (계획) > 이 로직 리팩터링 해줘
  → 파일은 고치지 않고 계획부터 내놓습니다
```

모델은 `/model` 로 바꿉니다.

```
AX-NAVI > /model          방향키로 고름
AX-NAVI > /model opus     바로 지정 (haiku | sonnet | opus | 기본)
```

`기본` 은 에이전트마다 선언된 모델을 씁니다.

### 대화가 이어집니다

```
AX-NAVI > /sessions        저장된 대화 목록
AX-NAVI > /resume          이전 대화로 돌아가기
AX-NAVI > /context         지금 대화 상태
AX-NAVI > /new             대화를 끊고 새로 시작
```

이어서 열면 지난 대화를 먼저 보여 줍니다. 터미널 밖에서도 이어집니다.

```bash
axnavi --continue           # 마지막 대화
axnavi --resume <세션id>     # 특정 대화
```

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
axnavi index coverage [경로]    커버리지 진단서 (AI 불필요 · 기본 _workspace/reports/coverage.md)

axnavi review [--diff A..B]     변경 리뷰 GO/HOLD/STOP (AI 불필요 · 종료 코드 0/3/4)
axnavi scan security [경로...]  저장소 보안 점검 (AI 불필요 · 기본 _workspace/reports/security_scan.md)

axnavi doc new <종류|all>       SDLC 산출물 양식 (docs/sdlc/, 규모·스택·API·테이블·패턴은 인덱스로 자동)
axnavi doc list                 산출물 현황 (필수 절 작성 · 승인 상태)
axnavi adr new "<제목>"          아키텍처 결정 기록 (docs/adr/NNNN-제목.md)
axnavi gate <req|design|dev|test>  단계 게이트 GO/HOLD/STOP (AI 불필요 · 종료 코드 0/3/4)

axnavi agent list               에이전트 목록
axnavi agent run <이름> <요청>   에이전트 직접 실행
axnavi skill list               스킬 목록
axnavi skill run <이름> <요청>   스킬 실행
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--root <경로>` | 현재 폴더 | 프로젝트 루트 |
| `--index-dir <경로>` | `<root>/_workspace/index` | 인덱스 위치 |
| `--tier <등급>` | `Auto` | `Auto` · `Standard` · `Full` |
| `--provider <이름>` | `auto` | `auto` · `anthropic` · `agent-sdk` · `claude-cli` |
| `--verbose` | 꺼짐 | 도구 목록 · 토큰 내역 · 감사 기록 경로 |

**변경 리뷰 · 보안 점검 (CI 게이트)** — `review` 와 `scan security` 는 AI 를 부르지 않습니다. 같은 변경에는 늘 같은 판정이 나와 머지 요청 게이트로 쓸 수 있습니다.

| 옵션 | 설명 |
|---|---|
| `--diff <A..B>` | 비교 범위. 생략하면 HEAD 대비 작업 트리, `--staged` 면 스테이징된 변경 |
| `--verify "<명령>"` | 테스트·빌드 명령을 직접 실행해 결과를 판정에 넣음 (실패하면 STOP) |
| `--tests-passed` | CI 앞 단계에서 테스트가 통과했음을 알림 |
| `--format md\|json` · `--out <파일>` | 리포트 형식과 저장 위치 |
| `--fail-on <심각도>` | `scan security` 에서 그 심각도 이상이 있으면 종료 코드 1 |

- 판정은 change-safety 에이전트와 같은 6개 차원·공식입니다(회귀·컨벤션·사이드 이펙트·롤백·보안×2·테스트). 패턴 일치는 AI 판정이라 헤드리스에서는 평가하지 않고 리포트에 그렇게 적습니다.
- 즉시 STOP: 평문 비밀번호·키, SQL 문자열 결합·MyBatis `${}`, 인가 검사 제거, DROP·TRUNCATE·WHERE 없는 DELETE, 검증 명령 실패.
- 인덱스가 있으면 바뀐 메서드의 호출자 수·관련 테이블·엔드포인트·거슬러 올라간 화면 이벤트까지 리포트에 나옵니다.
- 의도된 사용이면 그 줄이나 바로 윗줄에 `axnavi:allow <규칙ID> <사유>` 를 적어 억제합니다. 억제한 항목도 사유와 함께 리포트에 남습니다.
- GitLab 머지 요청 템플릿: [`docs/ci/gitlab-axnavi-review.yml`](docs/ci/gitlab-axnavi-review.yml) — HOLD 는 경고, STOP 은 차단.

**테스트 계획 · 커버리지** — AI 없이(`packages/core/src/testing/`).

- `axnavi test plan --spec <PMS-X 구현 명세.json>` → `_workspace/tests/<SR>.plan.json`. `test scaffold <SR>` → JUnit 5(서버 소스 패키지에 `SR_0012Test`) 또는 Vitest 골격, 케이스마다 `@DisplayName("TC01 …")` + `@Disabled("작성 필요")`(it.todo). 다시 만들면 없는 케이스만 덧붙임
- `axnavi test status [SR] [--junit <폴더>]` — surefire·Gradle·Vitest JUnit XML 로 케이스별 작성 필요·실패·통과, 종료 코드 0/3/4
- `axnavi coverage [--jacoco] [--lcov] [--diff A..B|--staged] [--min %]` — 전체와 바뀐 줄 커버리지, 닿지 않은 줄 번호, 기준 미달 HOLD
- GitLab 머지 요청 템플릿: [`docs/ci/gitlab-axnavi-quality.yml`](docs/ci/gitlab-axnavi-quality.yml) — 빌드·테스트 → 테스트 계획 진행(`test status`) → 바뀐 줄 커버리지 게이트, 현대화 점검(수동 실행)

**현대화 레시피** — `axnavi modernize <java17|java21|jakarta|boot3|oracle-pg> [경로...] [--apply] [--force] [--verify "<명령>"]`. AI 없이 규칙으로 자동(기계적 치환)·수동(안내)을 나눕니다(`packages/core/src/modernize/`). 남은 수동 SQL 은 `--draft` 로 AI 초안을 받습니다.

- java17/21: 빌드 대상 1.8 → 17/21, 박싱 생성자 → valueOf(자동) · BASE64·javax.xml.bind·Nashorn·finalize·Thread.stop·SecurityManager·내부 API(수동)
- jakarta: EE 패키지 javax → jakarta, 배치 서술자 네임스페이스(자동) · 의존성 좌표(수동). JDK 에 남은 javax(crypto·sql·transaction.xa·annotation.processing …)는 그대로
- boot3: Spring Boot 부모·플러그인 버전(`--boot 3.5.x`, 기본 3.5.0)·dependency-management 1.1.7, javax 의존성 좌표 → jakarta(Maven 블록·Gradle 문자열), 이름이 바뀐 설정 키(properties), Hibernate 버전별 방언 → 공통 방언(자동) · WebSecurityConfigurerAdapter·antMatchers·authorizeRequests·spring.factories·@Type·YAML 키(수동). jakarta 레시피를 함께 돈다
- oracle-pg: NVL·SYSDATE·FROM DUAL·NEXTVAL·MINUS·DDL 타입, 한 줄에서 닫히는 DECODE → CASE·NVL2 → CASE·INSTR(두 인자) → strpos(자동) · 여러 줄 DECODE·ROWNUM·(+)·CONNECT BY·MERGE·전용 함수·힌트·TO_DATE(수동). 매퍼 XML·SQL 파일·자바 문자열 SQL 만. DECODE 는 찾는 값에 NULL·컬럼·바인드가 있으면 `IS NULL`·`IS NOT DISTINCT FROM` 으로 바꿔 NULL = NULL 뜻을 지킨다
- `--draft [--draft-limit N]`(oracle-pg): 수동으로 남은 ROWNUM·(+)·CONNECT BY·MERGE·여러 줄 DECODE 를 문장 단위(매퍼는 `<select id>` 요소, SQL 파일은 `;` 사이, 자바는 문자열 묶음)로 잘라 AI 초안과 확인할 점을 `modernize_oracle-pg_drafts.md` 에 남깁니다. 소스는 고치지 않습니다. HNIX AX 게이트웨이(`AXNAVI_OPENAI_BASE_URL`)가 먼저, 없으면 본인 claude CLI(조직 정책이 구독을 허용할 때)
- UTF-8 이 아닌 파일(EUC-KR)은 바이트를 보존하고 한글 없는 줄만 고칩니다. `--apply` 는 고칠 파일이 git 에서 깨끗할 때만. 종료 코드 0/3/4 — 검증 실패 STOP, 수동 남음 HOLD

**SDLC 산출물 · 단계 게이트** — 요구 → 설계 → 개발 → 테스트. 산출물 양식과 게이트 판정은 AI 를 부르지 않습니다. 서술은 사람이 쓰거나 `sdlc-docs` 스킬("설계서 써줘")이 근거를 붙여 채웁니다.

| 단계 | 산출물 (`docs/sdlc/`) | 게이트가 보는 것 |
|---|---|---|
| `req` 요구 | 프로젝트 정의서 · 요구사항 명세서 | 필수 절 작성(STOP) · 문서 승인(HOLD) |
| `design` 설계 | 설계서 · 개발 표준 · ADR(`docs/adr/`) | + ADR 유무 · 제안 상태 ADR · ADR 본문(HOLD) |
| `dev` 개발 | 진행 기록서 | + `axnavi review` (STOP 이면 STOP, HOLD 면 HOLD) |
| `test` 테스트 | 품질 검증서 | + 보안 점검 치명(STOP) · 높음(HOLD) |

- 조직 양식: `.axnavi/templates/<종류>.md`(프로젝트) → `AXNAVI_TEMPLATES_DIR`(조직 공용 폴더) → 내장 양식 순으로 찾습니다. 양식 머리말의 `required:` 에 적은 절이 작성 필수입니다.
- 양식 그대로 · 자동 항목만 · `확인 필요` 줄만 있는 절은 작성된 것으로 보지 않습니다. 문서 머리말의 `상태:` 를 `승인` 으로 바꾸는 것은 검토자 몫입니다.
- `gate ... --record` 는 진행 기록서의 "단계 게이트 이력" 표에 한 줄을 남깁니다. doc-syncer 는 변경에 아키텍처 결정이 있으면 ADR(상태 `제안`)을 새로 씁니다.

**대화형 모드의 슬래시 명령** — `/` 를 치면 아래 목록과 스킬 26종이 함께 뜹니다.

| 명령 | 하는 일 |
|---|---|
| `/help` | 명령 목록 |
| `/status` | 현재 프로젝트 상태 |
| `/agents` · `/skills` | 에이전트 · 스킬 목록 |
| `/agent <이름> <요청>` | 에이전트 직접 실행 |
| `/index [build\|status\|refresh]` | 인덱스 빌드 · 상태 |
| `/review [A..B]` | 지금 변경을 GO/HOLD/STOP 으로 리뷰 (`--staged` · `--verify <명령>`) |
| `/context` | 진행 중인 대화 상태 |
| `/new` · `/sessions` · `/resume` | 새 대화 · 저장된 대화 목록 · 이전 대화로 |
| `/model` · `/mode` | 모델 · 실행 모드 바꾸기 |
| `/bg <요청>` · `/tasks` | 백그라운드 실행 · 작업 목록 |
| `/log` | 지나간 작업 되짚어 보기 |
| `/exit` | 종료 |

---

## 외부 MCP 서버 · 조직 사용 현황

**외부 MCP 서버 붙이기** — `.axnavi/mcp.json` 에 Claude Code 의 `.mcp.json` 과 같은 형식으로 적습니다. 키는 파일에 적지 말고 `${환경변수}` 로 받습니다.

```json
{
  "mcpServers": {
    "hnix": { "type": "http", "url": "${HNIX_AX_SERVER}/mcp", "headers": { "Authorization": "Bearer ${HNIX_AX_KEY}" } }
  }
}
```

- HNIX AX 플랫폼 허브(`/mcp`)를 붙이면 PMS-X(화면·버튼 흐름·영향도·SR 구현 명세)·문서 RAG·사내 도구를 에이전트가 함께 씁니다.
- 이 서버들의 도구는 AX-NAVI 기본 도구가 아니라서 **실행할 때마다 승인 창**을 거칩니다("이번 세션 동안 묻지 않음" 가능).
- 환경변수가 없거나 설정이 틀린 서버는 그 서버만 빼고 이유를 알립니다. `axnavi doctor` 에서도 보입니다.
- 위임 경로(구독·claude CLI·Agent SDK)에 적용됩니다. API 키 직접 경로(anthropic)는 아직 외부 MCP 를 쓰지 않습니다.

**조직 설정 받기** — 플랫폼 관리자가 "AX-NAVI 조직 설정"에서 배포한 묶음(규칙·SDLC 양식·MCP 서버·인증 정책, IDE 스킬)을 받습니다. `HNIX_AX_SERVER`·`HNIX_AX_KEY` 가 있으면 대화·에이전트를 시작할 때 10분 간격으로 자동으로 받고, 직접은 `axnavi org pull`, 상태는 `axnavi org status`.

- `~/.axnavi/org/`(`AXNAVI_ORG_DIR`)에 깔립니다. 규칙은 에이전트 지침의 `<조직 규칙>`, 양식은 `AXNAVI_TEMPLATES_DIR` 다음 자리, `mcp.json` 서버는 허용 없이 쓰고(같은 이름의 저장소 설정보다 우선), `policy.json` 은 허용 경로를 좁히기만 합니다(선호·게이트웨이는 PC 공용 정책이 비워 둔 경우에만).
- AX-NAVI IDE 용으로 규칙은 `~/.roo/rules/axnavi-org-*.md`, 스킬은 `~/.roo/skills/<이름>/` 에도 놓습니다(`AXNAVI_ORG_IDE=0` 이면 안 함). 다음 배포본에서 빠진 것은 지우고, 직접 만든 규칙·스킬은 건드리지 않습니다.
- 사용자 정의 모드(`modes/<slug>.json`)는 IDE 전역 `custom_modes.yaml`(`%APPDATA%\AX-NAVI IDE\User\globalStorage\hnix.axnavi\settings\`, `AXNAVI_IDE_MODES_FILE` 로 바꿈)에 표시 주석과 함께 넣습니다. 사용자가 같은 이름으로 만든 모드가 있으면 그쪽을 두고, IDE 가 파일을 다시 써 표시가 없어져도 지난번에 넣은 이름으로 찾아 갈아 끼웁니다.
- 서버에 닿지 않으면 지난 배포본을 그대로 쓰고 실행을 막지 않습니다. 자동 받기를 끄려면 `AXNAVI_ORG_AUTO=0`.

**조직 사용 현황(Insight)으로 보내기** — `HNIX_AX_SERVER`(예: `http://ax.hd.local:8700`)와 `HNIX_AX_KEY`(**ingest** 권한 키)를 설정하면 실행마다 요약(에이전트·소요 시간·결과·작업번호·세션 ID)을 보냅니다. 설정하지 않으면 아무것도 보내지 않습니다.

- 토큰·비용은 API 키 직접 경로일 때만 싣습니다. 구독·위임 경로는 Claude Code 세션 로그에 같은 호출이 남고 플랫폼 수집기(`hnix-ax collect`)가 집계하므로, 여기서 또 보내면 두 번 셉니다.
- 서버에 닿지 않으면 `.axnavi/logs/insight-queue.jsonl` 에 쌓았다가 다음 실행 때 함께 보냅니다(최근 1,000건).
- 브랜치 이름의 작업번호(`feature/SR-2026-0142`)를 뽑아 SR 별 AI 사용량으로 묶입니다.

---

## 인증

### Claude 구독 (기본 · 권장)

이미 쓰고 있는 `claude` CLI 의 로그인을 그대로 씁니다. **API 키도, 추가 비용도 필요 없습니다.**

```bash
claude     # 한 번 로그인해 두면 됩니다
axnavi
```

여러 에이전트의 병렬 실행, 하네스 초기화 같은 오케스트레이터 스킬, 파일 수정 전 승인 창이
모두 이 경로에서 동작합니다.

연결은 axnavi 가 알아서 고릅니다. **요금제(Pro·Max·Team·Enterprise)는 보지 않습니다** — 누구의 자격으로 어디서 부르는지만 세 경로로 나눕니다.

| 경로 | 해당하는 개발자 | 연결 | 과금 |
|---|---|---|---|
| `key` (API 키) | `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN` 이 있는 사람 | `anthropic`(Messages API) → SDK 가 없으면 `agent-sdk` → 그것도 없으면 키를 넘긴 `claude-cli` | 키 주인 |
| `subscription` (구독 로그인) | `claude` 에 로그인한 사람 — 개인 구독·Team·Enterprise 좌석, `claude setup-token` 토큰, Claude Code 에 Bedrock·Vertex 를 설정한 경우 | `claude-cli` (본인 claude 에 위임). 질문·승인 창은 axnavi 브리지가 받습니다 | 본인 구독·좌석, 또는 클라우드 계약 |
| `gateway` (사내 게이트웨이) | 위 둘이 없거나, 조직이 게이트웨이를 강제한 사람 | `openai` (HNIX AX 게이트웨이 → 조직 API 키·사내 로컬 모델) | 조직 |

- 기본 순서는 `key → subscription → gateway` 이고, 로그인 기록이 없으면 구독을 건너뜁니다(첫 요청에서 "Not logged in" 으로 죽지 않게).
- 여러 개를 가졌으면 `AXNAVI_AUTH=subscription|key|gateway` 로 먼저 쓸 경로를 고릅니다. 구독을 고르면 환경에 API 키가 있어도 위임 프로세스에서 뺍니다(`claude -p` 는 키가 있으면 키를 먼저 쓰기 때문).
- `axnavi doctor` 의 **과금** 줄이 지금 누구에게 과금되는지 보여 줍니다.
- `agent-sdk` 를 키 없이 직접 고르면 구독 로그인으로 돌지만 경고를 냅니다(아래 원칙).

#### 조직 정책
관리자는 PC 공용 정책 파일로 허용 경로를 정합니다. 개발자 권한으로 못 고치는 위치에 두십시오.

| OS | 위치 |
|---|---|
| Windows | `%ProgramData%\axnavi\policy.json` |
| macOS | `/Library/Application Support/axnavi/policy.json` |
| Linux | `/etc/axnavi/policy.json` |

```json
{
  "allowedRoutes": ["subscription", "gateway"],
  "preferred": "subscription",
  "gateway": { "baseUrl": "http://ax-platform:8700/v1", "model": "hnix-claude" },
  "message": "기밀 과제는 사내 게이트웨이만 씁니다"
}
```
- `gateway` 를 적어 두면 개발자는 키(`AXNAVI_OPENAI_API_KEY=hx-...`)만 넣으면 됩니다.
- 저장소의 `.axnavi/policy.json` 은 허용 경로를 **더 좁히기만** 합니다(예: 기밀 저장소는 `["gateway"]`). 넓히거나 게이트웨이 주소를 바꾸지 못합니다.
- 정책을 벗어난 `--provider`·`AXNAVI_AUTH` 는 이유와 함께 멈춥니다. 정책 파일이 깨져 있으면 실행하지 않습니다.
- 개발자별 설정 조각은 HNIX AX 플랫폼의 **내 연결 설정** 화면에서 상황을 고르면 만들어 줍니다.

> **구독 사용 원칙.** Anthropic 은 승인 없이 제3자 제품(Agent SDK 로 만든 에이전트 포함)이 claude.ai 로그인을 쓰는 것을 허용하지 않고, 서버가 여러 사람의 요청을 구독 자격 증명으로 중계하는 것도 금지합니다([Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview), [법률·준수](https://code.claude.com/docs/en/legal-and-compliance)). 그래서 axnavi 는 각자 PC 에서 각자 로그인한 Claude Code 에 위임할 때만 구독을 씁니다. 조직 배포는 개인별 Claude Team·Enterprise 좌석(각자 로그인), 또는 API 키·사내 게이트웨이(`--provider openai`)로 합니다. 로그인 창을 띄울 수 없는 CI 에서는 `claude setup-token` 으로 만든 본인 토큰을 `CLAUDE_CODE_OAUTH_TOKEN` 에 넣습니다.

### Anthropic API 키

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
axnavi --provider anthropic
```

Messages API 를 직접 부르며, 역할별 도구 제한과 감사 기록이 적용됩니다.
단일 에이전트 스킬과 질문 · 대화에 씁니다.

### OpenAI 호환 게이트웨이 (HNIX AX · 사내 로컬 모델 · watsonx)

```bash
export AXNAVI_OPENAI_BASE_URL=http://ax-platform:8700/v1   # 게이트웨이 /v1
export AXNAVI_OPENAI_API_KEY=hx-...                         # 게이트웨이 가상 키(llm 범위)
axnavi --provider openai ask "TB_EMP 를 쓰는 화면이 어디야?"
# 대화형 모드: AXNAVI_PROVIDER=openai axnavi
```

- 모델은 게이트웨이 별칭으로 고릅니다. 기본은 등급별 `hnix-local`(fast) · `hnix-smart`(standard·deep)이고, `AXNAVI_OPENAI_MODEL` 또는 `AXNAVI_OPENAI_MODEL_FAST|STANDARD|DEEP` 로 바꿉니다.
- Anthropic API 경로와 같이 **도구는 axnavi 의 Gateway 가 실행**합니다(역할별 도구 제한 · 승인 · 감사 기록 유지). 그래서 단일 에이전트 스킬(질문 · `/find` · `/flow` · `/sql` · `/impact` 등)에 씁니다. 서브에이전트를 지휘하는 스킬(harness-init 등)은 구독 경로에서 돌립니다.
- 요청에는 `x-hnix-client: axnavi` 가 붙어 게이트웨이 사용 현황에 집계됩니다. 비용·토큰은 게이트웨이가 계량하므로 Insight 실행 요약에는 싣지 않습니다(이중 집계 방지).
- SDK 없이 fetch 만 씁니다 — 폐쇄망 설치본에 의존성이 늘지 않습니다. `axnavi doctor` 의 "OpenAI 호환" 줄로 설정을 확인합니다.

### 인증 없이

`axnavi index build` 는 AI 를 쓰지 않으므로 인증 없이 돌아갑니다.

### 쓸 모델 정하기

axnavi 는 모델을 `haiku` · `sonnet` · `opus` 세 등급으로 부르고, 각 등급이 실제로 어떤 모델이
될지는 조직이 정합니다. 사내 게이트웨이처럼 허용 모델이 정해진 환경에서는
`~/.claude/settings.json`(관리자는 `managed-settings.json`)의 `env` 에 지정합니다.

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

구독 경로와 API 키 경로가 같은 설정을 따릅니다. 허용되지 않은 모델을 만나면 axnavi 가
그 환경에서 쓸 수 있는 모델로 위 설정을 채워 보여 줍니다.

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
<summary><b>워크플로우 스킬 19종 + 단축 별칭 7종</b></summary>

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
| `security-scan` | | 보안 점검 — 규칙 엔진 전수 점검 후 치명·높음만 원문 확인해 Findings 리포트 |
| `sdlc-docs` | | SDLC 산출물·ADR 을 조직 양식으로 만들고 근거 있는 내용만 채운 뒤 단계 게이트로 확인 |
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
| PowerBuilder 텍스트 내보내기 (`.srw` · `.srd` 등) | **PARTIAL** — 이벤트 · 함수 · 임베디드 SQL · DataWindow 연결 (`.pbl` 바이너리는 불가) |

인덱서는 파일마다 `FULL` / `PARTIAL` / `UNSUPPORTED` 를 기록합니다.
PARTIAL 대상은 에이전트가 원문을 직접 읽어 확인한 뒤 수정합니다(`READ`). 읽을 수 없는 UNSUPPORTED 대상만 보류(`HOLD`)합니다.

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
