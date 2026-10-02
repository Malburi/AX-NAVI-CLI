---
name: safe-modify
model: sonnet
orchestrator: true
review_limit: 1
description: "코드 변경을 사전 영향 분석 → 적용 → 사후 안전성 평가 순으로 안전하게 수행. \"안전하게 수정\", \"회귀 위험 없이 변경\", \"safe modify\", \"이 변경 안전한가?\", \"변경 전 체크\", \"이 패치 적용해도 돼?\", \"운영 패치 검토\", \"긴급 핫픽스\", \"이 수정 GO/NO-GO?\", \"변경 리뷰\" 요청 시 트리거. 범용 수정 요청(\"수정해줘\", \"고쳐줘\", \"개선해줘\", \"버그 잡아줘\", \"이거 바꿔줘\")도 기본적으로 이 스킬을 탄다 — 게이트 없이 바로 하려면 vibe 스킬(\"알아서 해줘\"). 축약 호출: \"안전수정 [내용]\"."
---

# Safe Modify (오케스트레이터) — v2

변경 *전* 영향도, *중* 외과적 적용, *후* 재확인 · 안전성 판단. "수정 → 곧장 commit → 운영 사고"를 끊는다.

v2 에서 바뀐 것(실제 레거시 비교 실험 근거):
- 영향도의 출발점은 **인덱스의 `impact`** 다. 화면이 문자열 디스패치로 부르고 결과를 위치(`rtInfo[1][2]`)로 읽는 곳까지 저장소를 넘어 나온다. v1 은 이것을 grep 으로 찾다가 놓쳐 화면 24곳을 깨뜨렸다.
- **사용자의 전제가 인덱스 사실과 다르면 멈추고 고르게 한다**("안 쓰는 것 같으니 빼줘" 인데 24곳이 쓴다).
- 고친 뒤 평가는 **결정적 검사**(재영향도 · 검증 명령 · 런타임의 위치 읽기 HOLD)가 기본이다. LLM 평가(change-safety)는 위험한 변경에서만 **한 번** 부른다 — v2 벤치에서 마지막 수정 뒤 시간의 약 70%가 평가 서브에이전트였고(재평가 · 패턴 대조를 이어 부름), 결과를 바꾼 경우는 보이지 않았다. 런타임도 평가 서브에이전트를 1번까지만 허용한다.
- 위키 재생성은 기본으로 하지 않는다.

**모델 고정:** 모든 Agent 호출과 재시도는 `sonnet` 별칭. Opus 로 자동 승격하지 않는다.

## 원칙

- **외과적 변경**: 요청된 부분만 고친다. 인접 코드 · 주석 · 포맷을 "개선"하지 않는다. 내가 만든 orphan 만 정리한다.
- **소스는 Edit · Write 로만** 고친다. python · sed · 리다이렉트로 소스를 쓰지 않는다(승인 · 레거시 인코딩 보호를 거치지 않는다).
- **인덱스로 좁히고 원문으로 확인한다.** 인덱스 결론만으로 "안 쓴다 · 죽은 코드다"라고 말하지 않는다 — 문자열 디스패치 · 리플렉션으로 불리는 메서드는 호출이 코드에 없다.

---

## Phase 0: 준비

1. 운영 모드 키워드 → mode: "운영 패치·프로덕션" production · "긴급 핫픽스·장애" hotfix · "레거시·옛날 코드" legacy · "고객 데모" customer_facing · 없으면 normal.
2. 인덱스 신선도: **AX-NAVI CLI 로 실행 중이면 런타임이 이미 맞췄다 — 건너뛴다.** 플러그인(Claude Code)에서 실행 중이면
   `node "${CLAUDE_PLUGIN_ROOT}/agents/lib/build-index.mjs" --root "[루트]" --check-stale` → exit 1 이면 `--mode incremental` 로 다시 만든다.
3. 어댑터 커버리지(대상 파일마다):
   `node "${CLAUDE_PLUGIN_ROOT}/agents/lib/check-adapter-coverage.mjs" --root "[루트]" --target "[대상 상대 경로]"`
   `FULL/GO` 진행 · `PARTIAL/READ` 연결된 설정 · 화면 · SQL 원문을 직접 읽고 진행(읽은 목록을 `원문 확인`으로 남김) · `UNSUPPORTED/HOLD` 변경 금지.
4. 기준 패턴:
   `python "${CLAUDE_PLUGIN_ROOT}/agents/lib/pattern_profile.py" select --root "[루트]" --target "[대상 경로]" --limit 20`
   프로필이 없으면 `reference_files`(이웃 파일)를 기준으로 읽는다. 사용자에게 기준을 고르게 하지 않는다.

## Phase 1: 사전 영향도

**프롬프트에 `<사전 영향도>` 블록이 있으면 그것이 출발점이다**(AX-NAVI CLI 가 인덱스로 계산해 넣는다). 없으면 직접 질의한다:

`QueryIndex impact`(sql=<SQL id>, column=<컬럼> 또는 id=<메서드>) — 플러그인에서는
`node "${CLAUDE_PLUGIN_ROOT}/agents/lib/query-index.mjs" impact --sql <SQL id> [--column <컬럼>] --root "[루트]"`

결과에서 본다:
- `screen_callers` — 다른 저장소 화면까지. `verdict: breaks` 는 이 변경으로 깨지는 곳이다(위치로 읽는 결과가 밀린다).
- `code_callers` · `methods[].result_keys` · `sql[].columns`(SELECT 순서).
- 위치로 읽는 곳(`reads_by_position`)이 있으면 컬럼 추가 · 삭제 · 순서 변경은 그 화면을 모두 함께 고쳐야 한다.

원문은 표본으로 확인한다 — `breaks` 화면 2~3곳과 SQL · 메서드를 열어 인덱스와 맞는지 본다. 24곳을 하나씩 grep 하지 않는다.
인덱스가 못 잡는 곳을 한 번 더 본다: 컬럼 이름 · SQL id 문자열로 grep(동적으로 만든 파라미터 · 다른 파일의 콜백).

**규모 판정** — `small`: 변경 파일 3개 이하이고 API 계약 · DB 스키마 · 트랜잭션 경계 · 인증/인가 · 공통 모듈을 바꾸지 않으며 `breaks` 가 0. 하나라도 걸리면 `normal`.

**멈추고 묻는 경우** — 아래뿐이다. 그 밖에는 권장안으로 진행한다.
1. **요청의 전제가 인덱스 사실과 다르다** — 예: "안 쓰는 컬럼이니 빼줘" 인데 `breaks` 화면이 있다. 선택지를 준다:
   `1. 그대로 두기 (권장) — 쓰는 곳 N곳`, `2. 빼고 쓰는 곳 N곳을 함께 고치기 (저장소 M개)`, `3. 중단`. 쓰는 곳 목록을 함께 보여 준다.
2. 위험도 CRITICAL — `1. 진행 2. 회귀 테스트 먼저(test-generator) 3. 중단`.
3. 데이터를 바꾸는 변경(INSERT · UPDATE · DELETE · DDL)인데 전제를 소스로 확인하지 못했다.
4. 요청을 두 가지 이상으로 해석할 수 있고 결과가 달라진다.

`normal` 이면 맥락 파일을 쓴다(서브에이전트가 같은 파일을 다시 읽지 않게):
`_workspace/reports/context_<slug>.md` — 요청 · 규모 · 변경 예정 파일 · 원문 확인 · 핵심 사실(SQL id · SELECT 순서 · 쓰는 곳 · 인코딩 · 기준 파일) · 확인하지 못한 사실.

## Phase 2: 적용

- 기준 파일(`reference_files`)의 명명 · 구조 · 들여쓰기를 따른다. 요청 범위 밖 현대화는 하지 않는다.
- 쓰는 곳을 함께 고치기로 했으면 `screen_callers` 의 **모든** 자리를 고친다. 다른 저장소 파일도 Edit 로 고친다(경로는 `repo`/`file`).
- 구현 방식이 둘이면 전제를 소스로 확인할 수 있는 쪽을 고른다.

## Phase 3: 재확인 · 검증

1. **재영향도** — 고친 뒤 같은 `impact` 를 다시 질의한다(AX-NAVI CLI 는 턴 뒤에 런타임이 다시 확인한다). 처리하지 않은 `breaks` 가 남으면 GO 가 아니다.
2. **검증 명령** — `node "${CLAUDE_PLUGIN_ROOT}/agents/lib/verify-target.mjs" detect --root "[루트]" --target "[대상]"` 로 후보를 받고, 바뀐 파일 종류를 검사하는 가장 작은 명령을 `verify-target.mjs run --cmd "<명령>"` 으로 실행한다. 없으면 `검증 수단 없음` + 정적 대조(SELECT 순서 ↔ 화면 인덱스, 태그 짝 등).
3. **패턴 대조(직접)** — 기준 파일과 바뀐 줄을 대조한다. 다르면 고치고 한 번 더 본다.
4. **안전성** — 기본은 **직접 판단**이다(규모와 무관). diff 의 위험 신호(SQL 문자열 결합 · innerHTML · 인증/트랜잭션 변경 · DDL · 외부 호출 추가 · 데이터 변경)를 보고 위 1~3 의 결과로 결정한다.
   - 아래에 해당할 때만 `change-safety` 를 **한 번** 부른다: DDL · 트랜잭션 경계 · 인증/인가 · 공통 모듈 변경, 데이터 변경(INSERT · UPDATE · DELETE), 외부 호출 추가, 운영 패치 · 핫픽스 모드(production · hotfix), 사용자가 안전성 평가를 요청함.
   - 평가가 HOLD 를 내도 재평가 · 패턴 대조를 서브에이전트로 다시 부르지 않는다. 지적을 직접 고치고 직접 다시 확인해 결정한다(런타임이 두 번째 평가 호출을 거부한다).
     ```
     Agent(subagent_type="ax-navi:change-safety", description="변경 안전성 평가", model="sonnet",
       prompt="<변경 파일: [목록]. mode: [mode]. 맥락: _workspace/reports/context_<slug>.md. 재영향도: [남은 breaks 수 · 목록]. 검증: [cmd·exit·fail_lines 또는 검증 수단 없음 + 정적 대조]. 패턴 대조: [일치/차이]. 출력: _workspace/reports/safety_<slug>.md>")
     ```
     결과 파일이 없고 본문을 돌려줬으면 그 본문을 그 경로에 쓴다. 둘 다 없으면 "대기 없이 이번 턴에 직접 산출하라"를 붙여 1회만 다시 부른다.

## Phase 4: 결정 · 보고

GO 조건: 어댑터 FULL 또는 READ(원문 확인) + 남은 `breaks` 0 + 패턴 일치 + (검증 exit 0, 또는 검증 수단 없음 + 정적 대조 — DDL · 트랜잭션 · 인증 · 공통 모듈 변경이 아닐 때만) + (change-safety 를 불렀으면 그 결과 GO).
그 밖은 HOLD, 즉시 STOP 트리거(change-safety)면 STOP.

```
결정: [GO / HOLD / STOP]
바뀐 파일: [저장소/경로 목록]
영향도: 쓰는 곳 N곳(화면 · 코드) — 처리 [N] · 남음 [N]
검증 증거: [명령·exit / 검증 수단 없음(사유) + 정적 대조]
확인하지 못한 사실: [없음 또는 목록 — 어디서 확인하면 되는지]
[GO] commit 메시지 권고 · 배포 후 확인 권장(있으면)
[HOLD/STOP] 사유 · 보완할 일
```

GO 뒤 인덱스는 다음 실행에서 런타임이 갱신한다(플러그인이면 `build-index.mjs --mode incremental`). `_workspace/wiki/` 가 있으면 "위키 다시 만들어줘"로 갱신할 수 있다고 한 줄 안내만 한다.

## 자동 후속 (옵션)

사용자가 명시하면 test-generator(회귀 테스트) · doc-syncer(문서 동기화)를 부른다. 기본은 OFF.
