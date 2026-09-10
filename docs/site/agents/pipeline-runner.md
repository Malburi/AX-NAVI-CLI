# pipeline-runner

harness-init의 결정론적 스크립트 블록(인덱싱·하네스 조립·기계 검증·wiki 생성)을 오케스트레이터 대신 실행하고 요약만 돌려주는 에이전트다. 존재 이유는 토큰이다. 이 블록들은 실행 환경 확인·설정 작성·폴백 사다리·재시도·산출물 확인이 뒤따르는데, 오케스트레이터가 직접 하면 매 왕복마다 200~350K 컨텍스트를 다시 읽는다. 이 에이전트가 대신 하면 그 왕복이 버려지는 컨텍스트 안에서 일어나고 메인 스레드는 요약 한 덩어리만 받는다. 코드나 하네스 파일 내용을 작성·수정하지 않고, 분석·패턴 추출·품질 판정도 하지 않는다.

## 호출 경로

[harness-init](/skills/harness-init.md)이 `block` 이름과 함께 네 곳에서 부른다.

| `block:` 값 | 실행 시점 | 읽을 블록 파일 |
|---|---|---|
| `index` | Phase 2-0.5 (`T-I`, 분리 저장소는 `B-I`/`C-I`) | `agents/lib/pipeline-runner/block-index.md` |
| `assemble` | Phase 2-2.3 | `agents/lib/pipeline-runner/block-assemble.md` |
| `verify` | Phase 2-3.5 | `agents/lib/pipeline-runner/block-verify.md` |
| `wiki` | Phase 3.7 (3.6 메뉴에서 선택된 경우만) | `agents/lib/pipeline-runner/block-wiki.md` |

frontmatter `model`은 `sonnet`, `tools`는 지정하지 않는다. 역할 표에 "코드·하네스 파일 내용 작성·수정"이 "하지 않는다" 열에 있다.

## 하는 일

1. 프롬프트로 `block`·`root`·`tier`·`plugin_root`·`mode`(init/incremental)·`ai_budget_session`·`lane`을 받는다.
2. 디스패치 표에서 자기 블록의 파일 하나만 읽는다. 다른 블록 파일은 읽지 않는다. 블록별 절차를 이 에이전트 파일에 두지 않는 이유도 매 호출이 쓰지 않을 지침을 3배로 읽지 않게 하기 위함이다.
3. 파이썬 인터프리터는 `python3 --version`이 성공하면 `python3`, 실패하면 `python`을 쓴다. 둘 다 없으면 "파이썬 없음"을 WARN으로 보고하고 그 블록만 건너뛴다.
4. 스크립트는 `$env:CLAUDE_PLUGIN_ROOT`(bash는 `$CLAUDE_PLUGIN_ROOT`) 기준 절대경로로 부른다. `--out`/`--summary` 인자는 생략해 스크립트 기본값(`--root` 기준)을 쓴다. cwd가 root와 다를 때 상대경로를 넘기면 엉뚱한 프로젝트에 읽기·쓰기가 발생한다.
5. 블록 파일의 Step 순서·폴백 사다리·재시도 규칙을 그대로 따른다. 1회 재시도 후 재실패는 WARN으로 남기고 다음 항목으로 진행하며, `hard_stop` 조건이 명시된 항목은 그 자리에서 중단한다.
6. exit 1을 무조건 실패로 보지 않는다. `validate-harness.mjs`는 스키마 FAIL이 있으면 exit 1이지만 결과 파일은 정상적으로 쓰므로 검증 결과로 취급한다.
7. 산출물 존재를 확인하고 블록 파일의 "반환 형식"으로 압축해 반환한다.
8. `block:` 값이 넷 중 어느 것도 아니면 스크립트를 실행하지 않고 `RESULT: FAIL`과 `WARN: 알 수 없는 block 값`만 반환한다.

## 입력과 산출물

| 구분 | 내용 |
|------|------|
| 읽음 | `agents/lib/pipeline-runner/block-<블록명>.md` 한 파일, 스크립트 실행 결과 |
| 씀 (스크립트 경유) | `index`는 `_workspace/index/*.json`, `assemble`은 CLAUDE.md·domain-expert.md·패턴 스켈레톤·ito-guide.md·`02_writer_files.md`, `verify`는 `validator_mechanical.json`·`validator_schema.json`·`pattern_profile_validation.json`, `wiki`는 wiki 페이지와 `07_wiki_build.md` |
| 반환 | 블록 파일에 규정된 필드값만. 산출물 본문은 붙여넣지 않는다 |

## 판정·출력 형식

반환문의 첫 줄은 항상 `BLOCK: [블록명] | LANE: [lane] | RESULT: ...`이고 마지막 줄은 항상 `WARN:`이다(없으면 "없음"). 블록 파일의 반환 형식에 있는 필드를 임의로 생략하지 않고 없는 필드를 추가하지도 않는다.

## 원칙

- 스크립트가 만든 파일의 본문을 반환문에 붙여넣지 않는다. 오케스트레이터가 원문이 필요하면 자기가 읽는다.
- 스크립트가 만들지 못한 산출물을 "생성"으로 적지 않는다.
- 폴백으로 내려간 실행은 어느 순위였는지 반환에 남기고 재시도 횟수를 감추지 않는다.
- 실패를 성공으로 보고하거나 조용히 넘기지 않는다. 사용자에게 질문하지도 않는다.
- 반환 형식에 없는 값을 추가해 길이를 늘리지 않는다. 오케스트레이터가 이 반환문을 자기 컨텍스트에 그대로 싣기 때문이다.

## 관련 문서

- [harness-init](/skills/harness-init.md)
- [컨텍스트와 토큰](/concepts/context-and-tokens.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [generate-wiki](/skills/generate-wiki.md)
