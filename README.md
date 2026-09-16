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

> **alpha (v0.1.0-alpha.0).** 실제 저장소에서 매일 쓰면서 다듬는 중입니다.
> 아래 [지금 되는 것 / 아직 안 되는 것](#지금-되는-것--아직-안-되는-것)을 먼저 읽어 주세요.

---

## 목차

- [왜 CLI인가](#왜-cli인가)
- [설치](#설치)
- [인증](#인증)
- [Claude Code 플러그인으로도 쓸 수 있습니다](#claude-code-플러그인으로도-쓸-수-있습니다)
- [3분 만에 해 보기](#3분-만에-해-보기)
- [대화형 모드](#대화형-모드)
- [하네스 초기화](#하네스-초기화)
- [명령어 전체](#명령어-전체)
- [지금 되는 것 / 아직 안 되는 것](#지금-되는-것--아직-안-되는-것)
- [구조](#구조)
- [에이전트 · 스킬 목록](#에이전트--스킬-목록)
- [지원 스택](#지원-스택)
- [개발](#개발)
- [Windows 참고](#windows-참고)

---

## 왜 CLI인가

이 도구는 원래 [Claude Code 플러그인](https://github.com/Malburi/AX-NAVI-V2)이었습니다.
개발 이력을 보면 **노력의 상당 부분이 호스트의 오케스트레이션 한계와 싸우는 데** 들어갔습니다.

| 겪은 일 | 그래서 생긴 것 |
|---|---|
| API 호출 352회 중 335건이 스크립트 왕복으로 약 20M 토큰 소비 | 토큰 절감만을 위한 `pipeline-runner` 에이전트 |
| `Agent()` 호출마다 지침이 재적재됨 | 네임스페이스 호출로 전환해 약 70K 절감 |
| 실사용 토큰 계측이 불가능 | `ai-budget.mjs` 사전 배분 원장 |
| `AskUserQuestion` 4옵션 상한 | **5번째 선택지(허브형 1:N)가 조용히 잘려나간 실사고** |

파이프라인은 이미 결정론적인데, 그 오케스트레이션을 834줄짜리 마크다운으로 적어 두고
LLM이 매 세션 읽어서 따라가게 하고 있었습니다.

**CLI로 옮기면서 오케스트레이션이 프롬프트에서 코드로 내려왔습니다.** 위 네 가지 중
세 가지가 제약 자체로서 사라집니다 — 선택지 개수 상한이 없고, 토큰·비용은 실측값을
그대로 받고, 스크립트는 in-process import로 부릅니다.

> 플러그인 버전은 **계속 유지됩니다.** 같은 `agents/`·`skills/` 를 두 실행 경로가 공유합니다.

---

## 설치

### 요구 사항

| 항목 | 필요 버전 | 없으면 |
|---|---|---|
| **Node.js** | 18.18+ (20 LTS 권장) | 실행 불가 |
| **git** | 아무 버전 | 변경 범위 표시가 비활성 |
| **Python** | 3.8+ | wiki 생성·패턴 프로필 검증 등 일부 스킬만 비활성 |
| `claude` CLI | 2.x | 구독 인증 경로를 못 씀 ([인증](#인증) 참조) |

### 설치하기

```bash
git clone https://github.com/Malburi/AX-NAVI-CLI.git
cd AX-NAVI-CLI
npm install
npm link -w packages/cli     # axnavi 를 전역 명령으로 등록
```

`npm link` 를 쓰지 않으려면 직접 실행해도 됩니다.

```bash
node /path/to/AX-NAVI-CLI/packages/cli/src/bin.mjs --help
```

외부 런타임 의존성은 **`@anthropic-ai/sdk` 하나뿐**입니다. 구독 인증 경로만 쓴다면
그것조차 실행에 쓰이지 않습니다. 인덱서(`agents/lib/`)는 의존성이 0입니다.

### 확인

```bash
cd /path/to/내-프로젝트
axnavi doctor
```

```
진단  C:\work\my-project

  ✓ Node       v20.20.2
  ✓ Python     python 3.12.9
  ✓ git        git version 2.46.0
  ✓ 실행 경로      claude-cli 2.1.259 · 구독 인증
  ! 인덱스        없음 — axnavi index build 로 만드세요
  ✓ 인덱서        v1.11.0
  ✓ 에이전트       19개
  ✓ 스킬         24개
```

---

## 인증

두 경로를 지원합니다. `--provider` 로 고르고, 기본값 `auto` 는 키가 있으면 API를, 없으면 구독을 씁니다.

### 1. Claude 구독 (기본 · 추가 비용 없음)

이미 쓰고 있는 `claude` CLI의 로그인을 그대로 빌려 씁니다. **API 키가 필요 없습니다.**

```bash
claude   # 한 번 로그인해 두면 됨
axnavi
```

내부적으로 `claude -p` 를 헤드리스로 띄웁니다. 그래서 이 경로에서는

- 도구 제약을 우리 Gateway가 아니라 **claude의 권한 체계가** 강제합니다 (허용목록으로 31종 차단)
- 서브에이전트를 쓸 수 있습니다 — `harness-init` 같은 오케스트레이터 스킬이 이 경로에서만 돕니다
- claude 자신의 시스템 프롬프트가 함께 실려 **턴당 약 $0.05~0.20** 이 듭니다

호스트에 설치된 Claude Code 플러그인은 **꺼 둡니다.** 안 그러면 예전 설치본이
지금 쓰는 `agents/` 대신 끼어들 수 있습니다.

### 2. Anthropic API 키

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
axnavi --provider anthropic
```

Messages API를 직접 부릅니다. 루프와 도구 실행을 우리가 소유하므로 역할별 도구 제약이
`ToolGateway` 한 곳에서 강제되고, 감사 기록(`.axnavi/logs/audit.jsonl`)이 남습니다.
다만 **서브에이전트 팬아웃이 아직 없어** 오케스트레이터 스킬은 못 돕니다.

### 3. 키도 구독도 없이

`axnavi index build` 는 **LLM을 전혀 쓰지 않습니다.** 인증 없이 심볼·호출 그래프·
SQL 사용처·트랜잭션 경계를 전수 파싱합니다.

---

## Claude Code 플러그인으로도 쓸 수 있습니다

이 저장소는 **같은 `agents/`·`skills/` 를 두 실행 경로가 공유**합니다.
CLI를 쓰지 않고 Claude Code 안에서 그대로 쓰려면 플러그인으로 설치하면 됩니다.

```bash
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

기존 `ax-navi` 등록이 구 저장소를 가리키고 있으면 다음 순서로 전환합니다.

```bash
claude plugin uninstall ax-navi@ax-navi --scope user
claude plugin marketplace remove ax-navi
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

두 방식의 차이는 [왜 CLI인가](#왜-cli인가)에 적었습니다. 선택지 개수 상한,
토큰 계측, 스크립트 왕복 비용이 CLI 쪽에서만 해소됩니다.

> CLI가 `claude` 구독 인증으로 돌 때는 **호스트에 설치된 플러그인을 꺼 둡니다.**
> 두 벌이 섞이면 어느 쪽이 돌았는지 화면에서 구분되지 않기 때문입니다.

---

## 3분 만에 해 보기

```bash
cd /path/to/내-프로젝트

# 1) 결정론적 인덱싱 — LLM·API 키 불필요
axnavi index build

# 2) 물어보기 (읽기 전용)
axnavi ask "결제 승인 처리가 어디서 시작되나?"

# 3) 대화형으로 들어가기
axnavi
```

---

## 대화형 모드

`axnavi` 를 인자 없이 실행하면 REPL이 뜹니다.

```
AX-NAVI > 이 프로젝트 인증은 어떻게 되어 있어?
```

스킬을 자연어로 부탁해도 됩니다. **명령을 안내하지 않고 바로 실행합니다.**

```
AX-NAVI > 하네스 초기화 해줘.
  ⋯ /harness-init
  오케스트레이터 스킬 — 에이전트 7종을 지휘한다
```

일반 질문("이 프로젝트 뭐 하는 거야?")은 그대로 대화로 답합니다.
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

### 모드와 모델

`Shift+Tab` 으로 실행 모드를 돕니다. 지금 모드는 프롬프트에 붙어 있습니다.

> **Windows 콘솔은 `Shift+Tab` 을 그냥 `Tab` 으로 보냅니다** — `shift` 표시가 없어
> 둘을 가를 수가 없습니다(`axnavi keys` 로 확인할 수 있습니다). 그래서 **빈 줄에서의
> `Tab`** 도 모드 전환으로 받습니다. 글을 친 뒤의 `Tab` 은 건드리지 않습니다.
> `/mode 계획` 처럼 이름으로 바로 지정할 수도 있습니다.

| 모드 | 하는 일 | 런타임이 막는가 |
|---|---|---|
| **기본** | 에이전트가 선언한 도구 그대로 | 그렇다 |
| **계획** | 고치지 않고 계획부터 낸다 | `Write`·`Edit` 만. `Bash` 는 지침 |
| **빠름** | 영향도·안전 게이트를 건너뛴다 | 아니다 (전부 지침) |

```
AX-NAVI (계획) > 이 로직 리팩터링 해줘
  → 파일은 안 고치고, 고칠 파일·줄·순서·검증 방법을 먼저 내놓습니다
```

계획 모드는 쓰기 도구를 실제로 목록에서 빼고, 계획을 내놓으라고 지침으로 말합니다.
**조사·분석은 제한 없이 합니다** — 근거 없는 계획은 계획이 아니니까요.

> `claude` 의 `--permission-mode plan` 은 쓰지 않습니다. 그쪽은 계획까지 내놓아
> 더 나아 보이지만 **MCP 도구를 함께 막습니다** — `--allowedTools` 에 명시해도
> `QueryIndex` 가 거부됩니다(실측). 인덱스 질의를 잃으면 근거가 사라집니다.

**무엇이 막히고 무엇이 부탁인지 갈라 적습니다.** 계획 모드에서 `Write`·`Edit` 은
도구 목록에서 실제로 빠집니다. 하지만 `Bash` 로는 `echo > file` 처럼 고칠 수 있고
**그건 런타임이 가려낼 수 없습니다** — 명령어를 글자로 보고 막는 것은 새는 검사라
하지 않습니다. 대신 그 사실을 화면에 적고 모델에게도 지침으로 말합니다.

빠름은 전부 지침입니다. 다만 그 안에서도 스키마·API 계약·트랜잭션 경계 변경과
3개 이상 파일 수정은 멈추게 합니다.

모델은 `/model` 로 바꿉니다. 에이전트 frontmatter 선언을 세션 동안 덮어씁니다.

```
AX-NAVI > /model          방향키로 고름
AX-NAVI > /model opus     바로 지정 (haiku | sonnet | opus | 기본)
```

`기본` 은 에이전트마다 다릅니다 — `analyzer` 는 sonnet, 어떤 것은 opus 를 선언합니다.
그래서 한 줄로 묶지 않고 "선언대로"를 고를 수 있게 뒀습니다.

### 작업 중에도 계속 쓸 수 있습니다

턴이 도는 동안 화면 바닥에 판이 붙습니다.

```
────────────────────────────────────────────────────────────────────────────
❯ /index refresh▏
────────────────────────────────────────────────────────────────────────────
⠹ harness-init › analyzer · 8m 7s · ↓ 30.6k tokens · Read   claude-cli · deep · Ctx 27.1k
```

작업 중에 친 글이 **그 자리에 그대로 보이고**, 턴이 끝나면 순서대로 실행됩니다.

턴이 도는 동안에는 `readline` 을 물러나게 하고 키를 직접 받습니다 — 그래서 화면
바닥을 온전히 소유할 수 있습니다. 대신 편집은 백스페이스까지만 됩니다.
방향키는 흘려보냅니다(예전엔 그게 히스토리를 불러내 화면을 어질렀습니다).

### 물어봐야 할 때는 물어봅니다

절차가 사용자 확인을 요구하면 선택지가 뜹니다. 방향키로 고르고 Enter입니다.

```
╭───────────────╮
│ 프로젝트 구성 │
╰───────────────╯

  프로젝트 루트에 xu43-client, xu43-server 두 하위 폴더가 있습니다.
  하네스 초기화를 어떤 구성으로 진행할까요?

  1. 단일 프로젝트로 초기화 (Recommended)
     지금 폴더 전체를 단일 프로젝트로 분석합니다
❯ 2. 서버·클라이언트 함께 초기화 (모노레포)
     xu43-server(backend)와 xu43-client(frontend)를 워크스페이스로 통합 분석합니다
  3. 서버·클라이언트 각각 초기화 후 연결 (1:1)
     두 프로젝트를 독립적으로 초기화하고 pair-init으로 연결합니다
  4. 기타 (부분 범위 / 허브형 1:N)

  ↑↓ 이동 · Enter 선택 · 번호 입력 · Esc 건너뜀
```

**선택지 개수에 상한이 없습니다.** 플러그인 시절 4옵션 상한 때문에 5번째 항목이
조용히 잘려나간 실사고가 있었고, 그게 이 전환의 이유 중 하나입니다.

### 무엇이 벌어지는지 보입니다

```
● Task(백엔드 분석)
│ ● Read(src/main/java/.../PaymentService.java)  240줄 읽음
│ ● Grep(doApprove)  12건
│ ● Bash(python agents/lib/pattern_profile.py --root .)
│   ⎿  profile=spring-mvc confidence=0.82
│      근거 파일 14개
  ⎿ 끝남 · 도구 3회 · 1m 12s
```

서브에이전트 안에서 난 일은 들여써서 누가 한 일인지 구분됩니다.

### 대화가 이어집니다

```
AX-NAVI > /sessions        저장된 대화 목록
AX-NAVI > /resume          이전 대화로 돌아가기 (방향키로 고름)
AX-NAVI > /context         지금 대화 상태
AX-NAVI > /new             대화를 끊고 새로 시작
```

이어서 열면 **지난 대화를 먼저 되살려 보여 줍니다.**

```
─  이전 대화 · 2턴 · 이 프로젝트 빌드 도구? ────────────────────────
› 이 프로젝트 빌드 도구?
  Ant

› 배포 산출물 파일명은?
  ROOT.war
────────────────────────────────────────────────────────────────────
```

긴 답은 앞 몇 줄만 보이고 나머지는 줄 수로 알립니다.

터미널 밖에서도 이어집니다.

```bash
axnavi --continue           # 마지막 대화
axnavi --resume <세션id>     # 특정 대화
```

컨텍스트가 한계에 가까워지면 **도구 결과부터 접어서** 자동으로 줄이고, 줄였다는
사실을 화면에 밝힙니다 — 답이 앞 내용을 잊은 이유가 될 수 있기 때문입니다.

---

## 하네스 초기화

`harness-init` 은 프로젝트를 전수 분석해 **다음 작업들이 근거 위에서 돌도록** 자산을 만듭니다.
에이전트 7종을 순서대로 지휘하는 오케스트레이터 스킬입니다.

```bash
axnavi                      # 대화형에서
AX-NAVI > /harness-init

# 또는 한 번에
axnavi skill run harness-init
```

> 구독 인증(`claude-cli`) 경로에서만 됩니다 — 서브에이전트가 필요하기 때문입니다.

만들어지는 것:

```
프로젝트/
├── CLAUDE.md                    ← 프로젝트 맞춤 컨텍스트
├── .claude/
│   ├── agents/                  ← 이 프로젝트 전용 도메인 에이전트
│   ├── skills/                  ← 이 프로젝트 전용 워크플로우
│   └── patterns/                ← 코드 컨벤션 프로필 (근거 파일 포함)
└── _workspace/
    ├── index/                   ← 결정론적 전수 인덱스 (LLM 무관)
    │   ├── symbols.json         ← 심볼 정의·위치
    │   ├── call_graph.json      ← 호출 관계
    │   ├── sql_usage.json       ← SQL 사용처
    │   ├── transactions.json    ← 트랜잭션 경계
    │   ├── external_io.json     ← 외부 통신
    │   └── schema.json          ← DB 스키마 (DDL 없으면 SQL에서 유도)

인덱스는 **코드 식별자** 기준이라, 한글 업무 용어는 `search` 로 찾습니다.
SQL 본문·주석과 AI 보강 설명까지 훑습니다 — 인덱스를 다시 만들 필요는 없습니다.

```
axnavi index build 이후
  symbol "로그인"  →   0건   (심볼 이름에 한글이 없다)
  search "로그인"  → 384건   (SQL 주석·엔드포인트 설명에서 찾는다)
```
    └── 0*_*.md                  ← 단계별 분석 리포트
```

### 분석 깊이

| Tier | 언제 | 비용 |
|---|---|---|
| **Full** (기본) | 심층 분석 · 마이그레이션 · 대규모 수정 계획이 있을 때 | 기준 |
| **Standard** | 일상 유지보수에는 대개 충분 | Full의 약 60% |

```bash
axnavi --tier Standard
```

초기화 중에 실측 견적을 보여 주고 고르게 합니다. 인덱싱까지는 LLM을 쓰지 않으므로
**규모를 확인한 뒤에 결정**할 수 있습니다.

---

## 명령어 전체

```
axnavi                          대화형 모드
axnavi --continue               마지막 대화를 이어서
axnavi --resume <세션id>         특정 대화를 이어서
axnavi ask <요청>               한 번 묻고 답받기 (읽기 전용)
axnavi init                     .axnavi/ 설정 생성
axnavi doctor                   실행 환경 진단

axnavi index build              결정론적 인덱싱 (LLM·API 키 불필요)
axnavi index status             인덱스 신선도
axnavi index refresh            증분 갱신

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
| `--provider <이름>` | `auto` | `auto` · `anthropic` · `claude-cli` |
| `--verbose` | 꺼짐 | 도구 목록 · 토큰 내역 · 감사기록 경로 |

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

---

## 지금 되는 것 / 아직 안 되는 것

솔직하게 적습니다. alpha입니다.

### 되는 것

| | claude-cli (구독) | anthropic (API 키) |
|---|---|---|
| `index build` / `status` / `refresh` | 가능 | 가능 (LLM 무관) |
| `ask` · `agent run` | 가능 | 가능 |
| 단일 에이전트 스킬 (`find-feature` 등) | 가능 | 가능 |
| 오케스트레이터 스킬 (`harness-init` 등) | 가능 | **불가** — 서브에이전트 미구현 |
| 서브에이전트 진행 상황 표시 | 가능 | — |
| `AskUserQuestion` (선택지 상한 없음) | 가능 | 가능 |
| 세션 저장 · 이어가기 · 컨텍스트 압축 | 가능 | 가능 |
| 도구 제약 강제 | claude 권한 체계 | `ToolGateway` + 감사 기록 |
| 비용 표시 | 실측값 | 실측값 |

### 아직 안 되는 것

- **`anthropic` 경로의 서브에이전트 팬아웃.** 오케스트레이터 스킬 8종이 구독 경로 전용입니다.
- **`anthropic` 경로가 하네스 패턴 프로필·`ito-guide.md` 를 읽지 않습니다.**
- **`wiki-hub` 스킬.** 미배포 외부 바이너리에 의존합니다.

### 알려진 비용

구독 경로는 claude 자신의 시스템 프롬프트가 함께 실려 **턴당 약 $0.05~0.20** 입니다.
`harness-init` 전체는 프로젝트 규모에 따라 수 달러 이상 나올 수 있습니다.
초기화 중 실측 견적을 보여 주고 중단할 기회를 줍니다.

---

## 구조

```
AX-NAVI-CLI/
├── packages/
│   ├── cli/                  REPL · 슬래시 명령 · 자동완성 · 선택지 · 상태 표시
│   ├── core/                 에이전트 루프 · ToolGateway · 로더 · 컨텍스트 관리
│   │   ├── src/tools/        Read/Grep/Glob/Bash/Write + QueryIndex/AskUserQuestion
│   │   ├── src/agents/       프론트매터 로더 + 프롬프트 shim
│   │   ├── src/skills/       SKILL.md 로더 + 오케스트레이터 판별
│   │   └── src/context/      세션 저장 · 압축 · 프로젝트 컨텍스트
│   ├── indexer/              agents/lib/*.mjs 재수출 (사본 없음 — 단일 소스)
│   ├── provider-anthropic/   Messages API
│   └── provider-claude-cli/  claude CLI 위임 (구독 인증)
├── agents/                   에이전트 19종 (플러그인과 공유, 무수정)
│   └── lib/                  결정론적 인덱서 · Python 도구 (npm 의존성 0)
├── skills/                   워크플로우 스킬 24종 (플러그인과 공유, 무수정)
└── docs/                     인덱스 스키마 · 문서 사이트
```

### 설계에서 지킨 것

- **`agents/*.md` 와 `skills/*/SKILL.md` 는 한 글자도 고치지 않습니다.**
  플러그인이 같은 저장소에서 계속 돌기 때문입니다. 로딩 시점에 30줄짜리 shim이
  `$CLAUDE_PLUGIN_ROOT` 치환과 호스트 전용 도구 무력화를 처리합니다.
- **도구 이름을 `Read`/`Grep`/`Glob`/`Bash`/`Write` 로 고정**했습니다.
  13개 에이전트가 이 다섯을 그대로 선언하고 있어 본문 수정이 0건입니다.
- **Core는 Claude 모델 이름을 모릅니다.** `tier.mjs` 한 파일에서만 별칭을 정규화합니다.
- **인덱서는 복사하지 않고 재수출합니다.** 사본이 없으니 드리프트도 없습니다.

---

## 에이전트 · 스킬 목록

<details>
<summary><b>에이전트 19종</b></summary>

| 에이전트 | 역할 |
|---|---|
| `analyzer` | 코드베이스 전수 분석 → 구조·레이어·의존성 리포트 |
| `writer` | 분석 결과 → CLAUDE.md · 도메인 에이전트 · 워크플로우 스킬 생성 |
| `pattern-extractor` | 코드 컨벤션 추출 → 근거 파일이 있는 패턴 프로필 |
| `validator` | 생성 산출물 검증 (파일 존재 · 트리거 품질 · 경로 교차 · 보안) |
| `qa` | 경계면 교차 비교 (Boundary 1~7) |
| `harness-evaluator` | 4차원 품질 채점 → 80점 미만 시 타겟 재생성 |
| `spec-clarifier` | 착수 전 명세 명확화 |
| `pipeline-runner` | 결정론적 스크립트 실행 위임 |
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

**오케스트레이터** (구독 경로 전용 — 서브에이전트 필요)

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

**단일 에이전트 스킬** (두 경로 모두)

| 스킬 | 별칭 | 하는 일 |
|---|---|---|
| `find-feature` | `/find` | 기능·키워드로 코드 위치 탐색 |
| `trace-logic` | `/flow` | 처리 흐름 추적 |
| `analyze-impact` | `/impact` | 변경 영향도 분석 |
| `review-sql` | `/sql` | SQL 리뷰 |
| `generate-wiki` | `/wiki` | harness 산출물 → wiki |
| `publish-wiki` | | wiki를 중앙 허브 DB에 발행 |
| `harness-clean` | | 하네스 전체 제거 |

**정책 · 보류**

| | |
|---|---|
| `vibe` | 영향·안전 에이전트를 생략한 빠른 작업 모드 (패턴·최소 검증은 유지) |
| `wiki-hub` | 미배포 외부 바이너리 의존 — 아직 못 씁니다 |

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

인덱서는 확장자와 파일별로 `FULL` / `PARTIAL` / `UNSUPPORTED` 를 기록합니다.
**"파일을 발견했다"를 "안전하게 자동 수정할 수 있다"로 과장하지 않습니다** —
PARTIAL 대상은 빌드·UI·통합 검증 전까지 자동 변경 판정이 `HOLD` 입니다.

---

## 개발

```bash
npm test              # 인덱서 회귀 103건 + CLI 166건
npm run test:harness  # node agents/lib/tests/run.js  (의존성 0 자체 러너)
npm run test:cli      # node --test packages/core/test/
npm run typecheck     # tsc --noEmit (JSDoc + checkJs — 빌드 단계 없음)
npm run validate:plugin
```

TypeScript 컴파일 단계가 없습니다. **JSDoc + `checkJs`** 로 타입을 검사하고
소스를 그대로 실행합니다 — `node packages/cli/src/bin.mjs` 가 곧 실행 파일입니다.

터미널 렌더링(상태 표시 · 선택지 · 자동완성)은 **눈으로만 보면 틀린 줄 모르는** 부류라
줄 수 계산과 폭 계산을 테스트로 고정해 두었습니다. 실제로 세 번 겪은 결함입니다.

---

## Windows 참고

주된 개발·검증 환경이 Windows입니다.

- 경로에 **공백과 한글**이 있어도 됩니다. 인덱서를 spawn이 아니라 in-process import로
  부르므로 argv 인용 문제가 원천적으로 없습니다.
- `python3` 가 깨진 Store 셰임인 환경이 실재합니다. `agents/lib/python-bin.mjs` 가
  실제로 `--version` 을 실행해 검증하고 폴백합니다.
- 한글은 터미널에서 두 칸을 차지합니다. 폭 계산이 이를 반영합니다.
- 중단 시 자식 프로세스를 `taskkill /T` 로 트리째 끝냅니다 —
  `child.kill()` 만으로는 MCP 서버가 손자로 살아남습니다.

---

## 참고

- **플러그인 버전**: [Malburi/AX-NAVI-V2](https://github.com/Malburi/AX-NAVI-V2) — Claude Code 안에서 쓰는 원형
- 기반 방법론: [neoruler001/harness-new](https://github.com/neoruler001/harness-new) 의 4-에이전트 파이프라인 +
  [Malburi/harness-ito](https://github.com/Malburi/harness-ito) 의 메타 방법론
- 설계 참고: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) ·
  [obra/superpowers](https://github.com/obra/superpowers) · [Andrej Karpathy](https://karpathy.bearblog.dev)

---

## 라이선스

MIT
