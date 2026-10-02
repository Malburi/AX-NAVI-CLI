# AX Navi — Claude Code 플러그인

> **처음 투입된 레거시 프로젝트, 첫날부터 길을 잃지 않게.**
> ITO/SI/SM 현장을 위한 Claude Code 플러그인 — 코드베이스 지도를 먼저 만들고, 그 지도를 근거로 찾고 · 따라가고 · 고칩니다.

Claude Code 안에서 설치해 씁니다. 별도 실행 프로그램은 없습니다(터미널 전용 실행기가 필요하면 [AX-NAVI-CLI](https://github.com/Malburi/AX-NAVI-CLI)).

## 설치

```bash
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

이미 설치돼 있으면 갱신합니다.

```bash
claude plugin marketplace update ax-navi
claude plugin update ax-navi@ax-navi
```

요구 사항: Node.js 18 이상, git. Python 3 은 harness-init 의 보조 스크립트 · 위키 생성에만 씁니다.

## 첫날 하는 질문, 그대로 물어보세요

| 이럴 때 | Claude Code 에서 |
|---|---|
| 코드베이스 지도를 만든다(처음 한 번) | `하네스 초기화 해줘` 또는 `인덱스만 만들어줘` |
| 기능이 어디 구현돼 있는지 | `/ax-navi:find 결제 승인 기능 찾아줘` |
| 버튼 하나 누르면 뭐가 도는지 | `/ax-navi:flow 수강신청 저장 버튼 누르면 뭐가 실행돼?` |
| 이거 고치면 어디가 터질지 | `/ax-navi:impact 이 쿼리 첫 컬럼을 빼면?` |
| 컨벤션 지켜 안전하게 고치기 | `/ax-navi:modify 승인 시각을 함께 저장하게 해줘` |
| 백엔드 · 프론트 저장소 함께 고치기 | `pair-init` 으로 연결한 뒤 `cross-repo-modify` |

명령을 외우지 않아도 됩니다. 말로 부탁하면 알맞은 스킬이 실행됩니다.

## v2 에서 달라진 것

v1 을 평범한 Claude Code 와 같은 과제로 비교해 보니 강점은 **다른 저장소까지의 영향도**, 약점은 **절차 비용**과 **지침에만 있던 안전장치**였습니다. v2 는 그 결과대로 고쳤습니다.

- **인덱스 2.0 — 코드에 안 보이는 연결.** 화면이 `TransData.do?worker=…&action=…` 처럼 문자열로 서버 메서드를 부르고 결과를 `rtInfo[1][2]` 처럼 위치로 읽는 구조를 설정 없이 찾아 백엔드 메서드 · SQL 컬럼 순서와 잇습니다. `query-index impact` 한 번으로 짝 저장소 화면까지 "이 컬럼을 빼면 어디가 깨지는지"가 나옵니다. 이런 메서드를 죽은 코드로 보지 않습니다.
- **플러그인 훅이 하는 일**
  | 시점 | 하는 일 |
  |---|---|
  | 세션 시작 | 인덱스가 있으면 신선도를 확인하고, 바뀐 저장소만 다시 만듭니다(AI 0원) |
  | 질문 입력 | 영향도 · 수정 요청이면 인덱스로 계산한 사전 영향도를 맥락으로 넣습니다 |
  | 셸 명령 실행 전 | `python -c` · `sed -i` · 리다이렉트처럼 **셸로 소스를 쓰려 하면 승인을 묻습니다**(Edit · Write 승인은 Claude Code 권한 모드 그대로). 디스크 전체 검색(`find /`)은 막습니다 |
  | 서브에이전트 실행 전 | 평가 서브에이전트(change-safety 등)는 요청당 1번까지 |
  | 파일 읽기 · 쓰기 | EUC-KR 등 레거시 인코딩을 지킵니다 |
  | 답이 끝날 때 | UTF-8 로 바뀐 EUC-KR 파일을 원래 인코딩으로 되돌려 쓰고, SELECT 순서를 바꿨는데 결과를 위치로 읽는 화면이 남았으면 **Claude 가 이어서 처리하게** 합니다 |
- **가벼운 수정 절차.** safe-modify · cross-repo-modify 는 영향도를 인덱스로 먼저 잡고, 고친 뒤에는 결정적 검사(재영향도 · 검증 명령)가 기본입니다. LLM 재평가는 DDL · 트랜잭션 · 인증 · 데이터 변경 같은 위험한 변경에서만 한 번 돕니다.

같은 과제 재측정(AX Navi 실행기 기준, 3회 평균): 실제 사내 레거시에서 "쿼리 첫 컬럼을 빼면 어디가 깨지나"(정답 24곳)를 평범한 Claude Code 는 1/24, v1 은 24/24 · $0.74, v2 는 24/24 · $0.12 로 찾았고, "안 쓰는 컬럼이니 빼줘"에 화면을 깨뜨린 횟수는 v1 2/3 → v2 0/3 이었습니다. 한 저장소 안의 단순한 질문은 평범한 Claude Code 가 여전히 더 쌉니다. 자세한 결과는 [AX-NAVI-CLI 변경 이력](https://github.com/Malburi/AX-NAVI-CLI/blob/main/docs/changelog.md)에 있습니다.

## 구성

| 경로 | 내용 |
|---|---|
| `agents/` | 전문 에이전트 19종 (`agents/lib/` 결정론적 인덱서 · 질의 · 검증 스크립트) |
| `skills/` | 워크플로우 스킬 17종 + 단축 별칭 7종 |
| `hooks/hooks.json` | 위 표의 플러그인 훅 |
| `packages/` | 훅이 쓰는 런타임 모듈만 담은 것(쓰기 판정 · 턴 감사 · 고친 뒤 검증 · 인코딩 보존). 실행기는 들어 있지 않습니다 |
| `docs/` | 사용자 문서(`docs/site/`), 인덱스 스키마 |

이 저장소는 [AX-NAVI-CLI](https://github.com/Malburi/AX-NAVI-CLI) 의 `scripts/build-plugin.mjs` 로 만들어집니다. 에이전트 · 스킬 · 인덱서는 두 저장소가 같은 원본을 씁니다.

## 라이선스

MIT
