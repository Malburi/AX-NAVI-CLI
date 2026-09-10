# 신규 프로젝트 투입 첫날

처음 보는 코드베이스에 오늘 투입됐다. 시스템이 무엇을 하는지, 핵심 기능이 어디에 있는지, 어떤 순서로 처리되는지를 오늘 안에 파악하고 팀과 공유 가능한 형태로 남기는 것이 목표다.

- **소요 시간** — 하네스 초기화 5~10분(프로젝트 크기에 따라 다름), 핵심 기능 파악 1~2시간, wiki 생성 수 분.
- **전제** — Claude Code 최신 버전, Node 18+, Python이 설치돼 있고 대상 프로젝트를 로컬에 clone해 둔 상태다.
- **이 튜토리얼이 다루는 스킬** — `harness-init`, `find-feature`(`/find`), `trace-logic`(`/flow`), `generate-wiki`(`/wiki`).

## 준비

플러그인이 아직 없다면 터미널에서 두 줄을 실행한다. 마켓플레이스 등록은 최초 1회만 필요하다.

```bash
claude plugin marketplace add Malburi/AX-NAVI-V2
claude plugin install ax-navi@ax-navi --scope user
```

Claude Code 안에서 `/plugin list`를 실행해 `ax-navi@ax-navi — enabled`가 보이면 설치가 끝난 것이다. 재로딩을 요구하면 `/reload-plugins`를 한 번 실행한다. 자세한 절차는 [설치](/getting-started/install.md)를 참고한다.

프로젝트 루트에 `CLAUDE.md`가 이미 커밋돼 있는지 먼저 본다. 있다면 팀원이 먼저 하네스를 만들어 둔 것이므로 3단계의 "공유 하네스 이어받기" 경로로 간다.

## 단계별 진행

### 1. 프로젝트 루트에서 Claude Code 열기

```bash
cd /path/to/project
claude
```

하네스는 현재 작업 폴더를 프로젝트 루트로 삼는다. 하위 폴더에서 열면 분석 범위가 어긋난다.

### 2. 하네스 초기화

```text
하네스 초기화해줘
```

`harness-init`이 다음 순서로 진행한다.

1. **구성 확인(Phase -1)** — "단일 프로젝트로 초기화 (Recommended) / 서버·클라이언트 함께 초기화 (모노레포) / 각각 초기화 후 연결 (1:1) / 기타" 중 하나를 묻는다. 저장소 하나에 백엔드만 있다면 첫 번째를 고른다.
2. **결정론적 인덱싱** — `build-index.mjs`가 LLM 없이 심볼·호출 그래프·SQL 사용처·트랜잭션 경계를 전수 파싱한다. 수십 초 안에 끝난다.
3. **견적과 Tier 확인(2-0.7)** — 인덱싱 결과로 파일 수·예상 토큰·예상 시간을 보여주고 "Full 로 진행 / Standard 로 진행 / 여기서 중단"을 묻는다. 기본은 Full이다. 요청문에 "빠르게"를 넣으면 Standard로 확정되고 이 질문은 생략된다.
4. **LLM 파이프라인** — analyzer → writer → pattern-extractor → validator → harness-evaluator가 순서대로 실행된다.
5. **선택 작업 메뉴(Phase 3.6)** — wiki 생성과 경계 QA를 물어본다. 첫날에는 "지금 안 함 (Recommended)"을 고른다. 초기화 직후에는 컨텍스트가 이미 커져 있어 새 세션에서 따로 돌리는 편이 같은 결과를 더 싸게 얻는다.

완료 보고에서 확인할 것은 세 가지다.

| 확인 항목 | 위치 | 기준 |
|---|---|---|
| 구조 검증 신뢰도 | `_workspace/03_validator_report.md` | 80 이상이면 즉시 사용 가능 |
| 패턴 프로필 검증 | `_workspace/pattern_profile_validation.json` | PASS |
| Eval 품질 점수 | `_workspace/06_eval_report.md` | 80/100 이상이면 PASS |

**공유 하네스 이어받기.** `CLAUDE.md`가 이미 커밋돼 있고 `_workspace/`가 없다면 `harness-init`은 전체 초기화를 하지 않는다. `build-index.mjs --check-stale`로 인덱스 신선도만 확인하고, 필요하면 인덱싱 블록만 1회 실행한다(LLM 없음). 이 경로는 사람당 1회가 아니라 팀당 1회만 LLM 비용을 쓰게 하려는 설계다. 상세는 [인덱스 갱신](/configuration/index-refresh.md)에 있다.

### 3. CLAUDE.md와 ito-guide 읽기

생성된 두 문서를 순서대로 읽는다. 10분이면 충분하다.

`CLAUDE.md`는 Claude가 매 대화마다 자동으로 읽는 프로젝트 개요서다. 다음 절이 있다.

- 기술 스택 — 언어·프레임워크·DB.
- 요청 흐름 — Controller → Service → DAO → DB 경로.
- 주요 파일 위치 — 레이어별 실제 경로.
- 빌드 / 실행 — 실제 명령어.
- 자동 워크플로우 — 어떤 상황에 어떤 스킬이 뜨는지.
- 작업 시 주의사항 — 레거시 특이사항, 금지 패턴.
- 변경 이력 — 하네스 변경 기록 표.

`.claude/ito-guide.md`는 이 프로젝트 전용 하네스 사용 설명서다. 1절 스킬 사용법, 2절 `domain-expert` 에이전트 직접 호출, 3절 패턴 파일, 4절 인덱스 파일 설명과 "코드 수정 전 영향 확인 순서", 5절 실전 시나리오, 6절 주의사항으로 구성된다. 4절의 인덱스 표는 이후 모든 작업의 근거가 어디서 오는지 알려 주므로 한 번은 읽어 둔다.

### 4. `/find`로 핵심 기능 위치 찾기

업무 담당자나 인수인계 문서에서 들은 핵심 기능 세 개를 골라 위치를 찾는다. 예를 들어 결제·주문 취소·정산이라면 다음처럼 입력한다.

```text
/find 결제
```

`find-feature`가 `feature-finder` 에이전트를 호출해 Controller·Service·SQL·외부 연동 위치를 목록으로 돌려준다. 결과는 `_workspace/reports/found_<slug>.md`에 남는다(예: `found_payment.md`). 인덱스가 있으면 `symbols.json`을 먼저 훑고, 없으면 grep 전략으로 대체한다.

"결제 관련 코드 어디 있어?" 같은 자연어도 같은 스킬을 트리거한다.

### 5. `/flow`로 처리 흐름 추적

위치를 알았으면 흐름을 본다.

```text
/flow 주문 취소
```

`trace-logic`이 `logic-tracer` 에이전트를 호출해 진입점 → Service → 외부 연동 → DB → 이벤트 순으로 처리 경로를 그려 준다. 결과는 `_workspace/reports/trace_<slug>.md`에 남는다(예: `trace_order_cancel.md`). 별칭이 `/trace`가 아니라 `/flow`인 이유는 하네스가 프로젝트마다 로컬 `trace` 스킬을 배포하기 때문이다.

핵심 기능 세 개에 대해 4단계와 5단계를 반복한다. 결과 끝에 "레거시 코드가 포함되어 있으면 legacy-decoder로 상세 해석 권고"가 붙어 있으면 [레거시 코드 해석](/tutorials/legacy-decode.md)으로 이어 간다.

### 6. wiki 생성과 팀 공유

새 세션을 열고 wiki를 만든다.

```text
위키 만들어줘
```

`generate-wiki`가 `wiki_generator.py`(LLM 없음)로 `_workspace/wiki/`에 페이지 세트를 만든다. `_workspace/wiki/serve.bat`을 실행하고 `http://localhost:3501`에 접속하면 Docsify로 열린다. `call-graph.html`은 인터랙티브 호출 그래프이고 `diagrams.md`는 문서에 붙여 넣을 수 있는 Mermaid 마크업이다.

팀 공유는 두 갈래다.

```bash
git add CLAUDE.md .claude/
git commit -m "docs: add project harness"
```

하네스 파일은 git으로 공유한다. `.claude/backup/`은 gitignore를 권장한다. `_workspace/index/_ai_patch.json`은 다시 만들려면 LLM 분석이 필요하므로 커밋 대상에 포함되는지 확인한다.

wiki는 `_workspace/` 아래에 있어 재생성 가능한 산출물로 취급된다. 여러 시스템을 한곳에서 보고 싶으면 `generate-wiki`가 마지막에 묻는 "중앙 허브(wiki-hub)에도 발행할까요?"에 Y로 답해 `publish-wiki`로 이어 간다. 절차는 [wiki 생성과 발행](/tutorials/wiki-and-publish.md)에 있다.

## 결과 확인

오늘 끝에 다음이 남아 있으면 첫날 목표를 달성한 것이다.

- `CLAUDE.md`, `.claude/ito-guide.md`, `.claude/skills/trace.md`·`scaffolder.md`·`find-logic.md`, `.claude/agents/domain-expert.md`, `.claude/patterns/*.md`와 `pattern_profile.json`.
- `_workspace/index/call_graph.json`·`symbols.json`·`transactions.json`·`external_io.json` 등 인덱스.
- `_workspace/reports/found_*.md` 3개와 `trace_*.md` 3개.
- `_workspace/wiki/` 폴더와 `_workspace/07_wiki_build.md`.
- git에 커밋된 하네스 파일.

이 시점부터 "이 함수 영향도 분석해줘", "이 변경 안전하게 적용해줘" 같은 작업 스킬이 인덱스 위에서 동작한다.

## 막혔을 때

- **초기화 질문이 영어로 나온다** — 호스트가 `AskUserQuestion`을 지원하지 않으면 번호 목록 평문으로 폴백한다. 번호로 답하면 된다.
- **Eval 점수가 80 미만이다** — Phase 4가 fix_targets 기반으로 1회 타겟 재생성을 하고 2차 점수를 보고한다. 점수가 오히려 떨어지면 1차 결과를 유지한다. 그래도 낮으면 `03_validator_report.md`의 보완 권장 항목을 먼저 처리한다.
- **`/find` 결과가 비어 있다** — 인덱스가 없거나 stale일 수 있다. "인덱스 갱신해줘"로 incremental 재인덱싱을 한 뒤 다시 시도한다. 인덱스를 쓰는 스킬은 stale 경고를 자동 표시한다.
- **레거시 프로젝트인데 Standard로 초기화했다** — 데드코드 탐지는 Full에만 있다. "심층 분석해서 하네스 만들어줘"로 재초기화하면 기존 파일은 `.claude/backup/[시각]/`에 백업된다.
- **동적 로딩·리플렉션 코드가 그래프에 안 보인다** — 정적 분석 한계다. 리포트 끝의 "리플렉션/동적 호출 가능성 — 수동 확인 필요" 문구를 확인하고 해당 구간은 직접 본다.
- **비용이 걱정된다** — 2-0.7 견적 화면이 비용을 알고 결정할 수 있는 유일한 지점이다. Standard는 견적의 약 60%다. [Tier와 비용](/getting-started/tier-and-cost.md)을 참고한다.

## 관련 문서

- [harness-init](/skills/harness-init.md) — 초기화 Phase 전체와 모드 표.
- [find-feature](/skills/find-feature.md) · [trace-logic](/skills/trace-logic.md) — 위치 탐색과 흐름 추적.
- [하네스 산출물](/concepts/harness-outputs.md) — `_workspace/`와 `.claude/` 파일 설명.
- [결정론적 인덱스](/concepts/deterministic-index.md) — 인덱스가 어떻게 만들어지고 무엇을 보장하는지.
- [담당자 교체·인수인계](/tutorials/handover.md) — 공유 하네스를 넘겨받는 쪽의 절차.
