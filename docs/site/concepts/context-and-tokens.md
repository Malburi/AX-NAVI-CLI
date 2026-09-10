# 컨텍스트와 토큰 관리

AX Navi의 설계 결정 상당수는 토큰 때문이다. 레거시 코드베이스는 인덱스 파일 하나가 수십~수백 MB이고, 초기화 파이프라인은 여러 에이전트와 스크립트 왕복을 거치며, 그 과정에서 메인 컨텍스트가 커질수록 이후 모든 호출이 비싸진다. 이 문서는 컨텍스트를 작게 유지하고 토큰을 예측·제한하기 위해 하네스가 쓰는 장치와 그 한계를 정리한다.

## 인덱스 원본을 직접 열지 않는다

실측한 대형 레거시 인덱스는 `sql_usage.json` 143MB, `dead_code.json` 38MB, `call_graph.json` 36MB, `symbols.json` 26MB였다. "이 메서드의 호출자 5개"를 알기 위해 143MB를 Read로 여는 것은 성립하지 않는다. 그래서 세션 진입 규약(`AGENTS.md`)과 `CLAUDE.md`의 작업 프로토콜이 같은 순서를 강제한다.

1. `query-index.mjs summary`로 규모를 먼저 가늠한다.
2. `symbol`·`callers`·`callees`·`trace`·`sql`·`table`·`schema`·`endpoint`·`transaction`으로 필요한 줄만 조회한다.
3. 질의 결과로 좁혀진 파일·라인만 Read로 열어 실물과 대조한다.

```bash
node "$CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs" summary --root <프로젝트 루트>
node "$CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs" callers --id OrderService.cancel --root <프로젝트 루트>
```

응답은 기본 50건 상한(최대 500건)에 걸리며 `truncated`로 잘린 수를 밝힌다. 잘렸으면 `--limit`을 올려 다시 조회하고 실제 `total`을 근거로 써야 한다. 기존 패턴 확인도 파일 원문 대신 `symbol` 조회로 시그니처·위치만 보고, 원문이 꼭 필요할 때만 해당 범위를 읽는다.

analyzer도 같은 원칙을 따른다. 대형 인덱스 원본이 아니라 상한이 걸린 요약 `_analysis_input.json`을 읽고, 소스를 재순회하지 않으며, digest가 지목한 좌표만 선택적으로 연다.

## 스크립트 왕복은 pipeline-runner로 뺀다

harness-init의 인덱싱·하네스 조립·기계 검증·wiki 생성 네 블록은 LLM 판단이 필요 없는 스크립트 작업이지만 한 번의 호출로 끝나는 일이 드물다. 실행 환경 확인, 설정 파일 작성, 폴백 사다리, 재시도, 산출물 확인이 뒤따른다. 오케스트레이터가 이를 직접 하면 매 왕복마다 200~350K 컨텍스트를 다시 읽는다.

`pipeline-runner` 에이전트가 대신 하면 그 왕복이 전부 버려지는 컨텍스트 안에서 일어나고 메인 스레드는 요약 한 덩어리만 받는다.

| 블록 | 시점 | 실행하는 것 |
|------|------|------|
| `index` | 2-0.5 | `build-index.mjs`, Vue 보강, 폴백 사다리, `ai-budget.mjs init` |
| `assemble` | 2-2.3 | `skills_builder.py`(CLAUDE.md·AGENTS.md·domain-expert·패턴 스켈레톤·ito-guide 조립) |
| `verify` | 2-3.5 | `pattern_profile.py validate`, `validate-harness.mjs`, `validator_checks.py` |
| `wiki` | 3.7 | `wiki_generator.py`, 선택 시 내러티브 페이지 |

반환에는 절대 규칙이 있다. 스크립트가 만든 파일의 본문을 붙이지 않고 규정된 형식의 필드값만 돌려준다. 한 호출은 블록 하나만 실행하므로 네 블록의 절차를 전부 싣고 시작하지 않고 자기 블록의 파일 하나만 읽는다. 메인에는 `--apply-ai-patch`, `analyzer_index_summary.py --assemble-report`, `ai-budget.mjs estimate/claim/record`처럼 다음 분기를 결정하는 단발 제어 호출만 남는다.

## AI 호출 예산 — ai-budget.mjs

harness-init Phase 2의 AI 호출(analyzer·writer·pattern-extractor)은 `agents/lib/ai-budget.mjs`가 스크립트로 강제하는 예산 게이트를 통과해야 한다. 장부는 `_workspace/ai-budget.json`이다.

| 명령 | 역할 |
|------|------|
| `init` | 세션 ID와 한도(`--initial 3 --retries 2`, 견적의 2배인 `--minutes`·`--tokens`)로 장부 생성. 같은 세션으로 재호출하면 새 인자를 무시하는 멱등 가드가 있다 |
| `estimate` | 인덱스 규모에서 LLM 구간 예상 토큰·분을 계산 |
| `claim` | 에이전트 호출 직전 예산 차감. `--kind initial`은 역할당 평생 1회만 허용되고, `--kind retry`는 validator 실패 사유(`--reason`) 없이는 거부된다 |
| `record` | 역할별 소비 토큰을 사후 기록 |
| `status` | 현재 장부 출력 |

예산이 소진되면 exit 1로 끝나며 조용히 넘어가지 않는다. 한도를 호출 횟수로만 걸면 미해결 판정 한 번의 "호출"이 파일 2,000개 열람일 수 있어 큰 소비를 못 막기 때문에 시간·토큰 한도를 함께 건다. Phase 3 보고에는 `AI 예산 증적: [session] · initial [used]/[limit] · retries [used]/[limit]`가 표시된다. `node`가 없는 환경에서는 예산이 `skipped`로 기록되고 `claim` 없이 진행한다.

## 사전 견적 — 시작 전에 자릿수를 본다

이 하네스의 가장 큰 실패 모드는 "돌려봐야 얼마 드는지 안다"였다. 인덱싱은 LLM 없이 끝나므로 그 결과만 있으면 이후 LLM 구간의 규모를 미리 가늠할 수 있다. harness-init 2-0.7은 사용자가 비용을 알고 결정하는 유일한 지점이다.

```text
인덱싱 완료 — 소스 [files]개 파일, 심볼 [symbols]개. (여기까지 LLM 사용 없음)

이제 LLM 분석 구간입니다. 예상 규모:
  Tier [tier] 기준 · 약 [estimated_minutes]분 · 약 [estimated_tokens] 토큰
  판정이 필요한 미해결 관계: [decidable_unresolved]건

  1. Full 로 진행
  2. Standard 로 진행  — 위 견적의 약 60%
  3. 여기서 중단        — 인덱스만 두고 나중에 이어서
```

견적은 고정비(Standard 45K / Full 70K 토큰) + 파일 수 × 계수 + 판정 대상 그룹 수 × 900 + 패턴 추출 25K로 계산되며, 정확한 예측이 아니라 자릿수를 보여주는 것이 목적이다. 3번을 골라 중단해도 인덱스는 남으므로 `analyze-impact`·`trace-logic`은 이미 동작한다. Tier가 요청문의 키워드로 이미 확정됐으면 견적만 보이고 질문 없이 진행한다.

## 대표 파일 바이트 예산

`_analysis_input.json`의 `evidence.representative_files`는 analyzer와 pattern-extractor가 열람 후보로 쓰는 대표 파일 목록이다. 개수 상한만 두면 레거시에서 상한이 사실상 무의미해진다. 파일 크기가 균일하지 않아 3.8MB짜리 생성 XJS 파일과 2KB짜리 VO 클래스가 똑같이 "1개"로 세어지기 때문이다. 실측에서 Full tier 300개를 그대로 고르면 24.5MB(약 21M 토큰)였다.

그래서 개수와 함께 바이트 예산을 건다.

| 항목 | 값 | 이유 |
|------|------|------|
| 개수 상한 | Standard 150 / Full 300 | 경로 문자열만이라 넉넉히 준다 |
| 총 바이트 예산 | Standard 768KB / Full 1.5MB | 열었을 때의 비용으로 상한을 건다 |
| 파일당 상한 | 128KB | 지나치게 큰 파일은 생성물·번들·데이터라 "대표"가 아니다 |

목록 전체를 열었을 때의 실제 크기는 `evidence.representative_files_bytes`에, 예산 때문에 빠진 파일 수는 `representative_files_skipped`에 기록된다. analyzer는 목록을 읽기 목록이 아니라 후보 목록으로 취급하고, 예산이 모자라면 파일 수를 줄이는 대신 Read의 offset/limit으로 해당 좌표 주변만 읽는다.

## 미해결 관계는 그룹 단위로 판정한다

인덱서가 확정하지 못한 호출 관계를 발생 위치마다 판정하면 같은 판정을 수백 번 반복한다. 실측에서 판정 대상 2,380건이 고유 패턴 185개였고, 그룹핑 도입으로 견적이 163분에서 27분으로 줄었다. analyzer는 `_unresolved_groups.json`의 그룹마다 대표 사례 한 곳만 열어 `resolve_group` 한 건을 내고, 인덱서가 모든 발생 위치로 확장한다. 상세는 [결정론적 인덱스](/concepts/deterministic-index.md)를 참조한다.

## 부분 실행 — 필요한 단계만 다시 돌린다

코드 수정 후 전체 재초기화는 가장 비싼 선택이다. harness-init은 요청 문구로 실행 모드를 나눈다.

| 요청 | 모드 | 실행 범위 |
|------|------|------|
| `"하네스 초기화해줘"` (하네스 없음) | 초기 실행 | 전체 파이프라인 |
| `"하네스 다시 초기화해줘"` | 재초기화 | `.claude/backup/`에 백업 후 전체 실행 |
| `"인덱스만 갱신해줘"` | 인덱스 리프레시 | 기계 인덱스 재생성 + 기존 AI 패치 재적용, writer·validator·eval 생략 |
| `"스킬만 다시 생성"`, `"패턴만 다시"`, `"validator만 실행"`, `"qa만"` | 부분 재실행 | 해당 단계만, 이전 `_workspace/` 산출물 재사용 |
| `"하네스 업데이트해줘"` | 업데이트 | 백업 후 analyzer incremental + 재실행 |

팀원이 공유 하네스를 pull한 경우에는 초기화 자체를 하지 않는다. `--check-stale`이 exit 0이면 그대로 쓰고, exit 1이면 `index` 블록만 한 번 돌린다(LLM 0). 초기화는 팀당 1회이고 사람당 1회가 아니다.

Standard Tier도 토큰 절감 수단이다. `"빠르게 하네스 초기화해줘"`로 지정하면 분석 범위만 줄이고 안전성 게이트는 유지한다. 상세는 [Tier와 비용](/getting-started/tier-and-cost.md)을 참조한다.

## 세션 분리 — wiki와 QA는 새 세션에서

초기화 파이프라인이 끝나는 시점은 컨텍스트가 최대인 시점이다. 그래서 wiki 생성과 경계 QA는 자동 실행하지 않고 선택 메뉴로 제시하며, 기본 선택은 "지금 안 함"이다. 같은 작업을 새 세션에서 `"위키 만들어줘"`·`"경계 QA 실행해줘"`로 따로 돌리는 편이 같은 결과를 더 싸게 얻는다. wiki 본문은 `wiki_generator.py`가 LLM 없이 만들고, 선택한 경우에만 내러티브 개요 페이지 하나(약 5~10K 토큰)를 LLM이 쓴다.

일상 작업에서도 큰 작업 하나를 끝냈으면 새 세션을 여는 편이 좋다. `CLAUDE.md`와 `AGENTS.md`의 고정 블록은 모든 프로젝트에서 동일하게 앞에 놓여 프롬프트 캐시 접두사로 동작하므로 새 세션의 진입 비용은 작다.

## 한계 — 실측 토큰 카운터가 없다

토큰 한도가 실제로 의미 있으려면 `used.tokens`가 쌓여야 한다. 그러나 이 하네스는 `Agent()` 호출이 결과 텍스트만 돌려줄 뿐 실사용 토큰 카운터를 주지 않고, 훅도 쓰지 않아 진짜 계측은 불가능하다.

대신 사전 배분 장부로 근사한다. 각 역할의 `claim --kind initial`이 성공한 직후 견적의 대략적 몫을 `record`로 기록한다. 비율은 analyzer 60%, writer 25%, pattern-extractor 15%다(validator·harness-evaluator는 `claim` 대상이 아니라 기록하지 않는다).

이 값은 정확한 실사용량이 아니라 "프로젝트가 견적보다 훨씬 크게 나온 경우"를 잡기 위한 근사치다. 한 역할 내부에서 폭주하는 경우까지는 잡지 못하며, 값을 알 수 없는 호스트에서는 생략되어 한도는 시간 쪽으로만 걸린다. `record`가 쌓이면 프로젝트별로 견적 계수가 보정되지만, 보고서의 토큰 숫자를 청구 금액처럼 읽어서는 안 된다. 실제 사용량은 Claude Code의 사용량 표시나 조직의 청구 내역으로 확인한다.

## 관련 문서

- [결정론적 인덱스](/concepts/deterministic-index.md)
- [에이전트 팀과 파이프라인](/concepts/agent-team.md)
- [Tier와 비용](/getting-started/tier-and-cost.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [모범 사례](/getting-started/best-practices.md)
