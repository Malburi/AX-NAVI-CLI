---
name: safe-modify
model: sonnet
description: "코드 변경을 사전 영향 분석 → 적용 → 사후 안전성 평가 순으로 안전하게 수행. \"안전하게 수정\", \"회귀 위험 없이 변경\", \"safe modify\", \"이 변경 안전한가?\", \"변경 전 체크\", \"이 패치 적용해도 돼?\", \"운영 패치 검토\", \"긴급 핫픽스\", \"이 수정 GO/NO-GO?\", \"변경 리뷰\" 요청 시 트리거. 범용 수정 요청(\"수정해줘\", \"고쳐줘\", \"개선해줘\", \"버그 잡아줘\", \"이거 바꿔줘\")도 기본적으로 이 스킬을 탄다 — 게이트 없이 바로 하려면 vibe 스킬(\"알아서 해줘\"). 축약 호출: \"안전수정 [내용]\"."
---

# Safe Modify (오케스트레이터)

변경을 적용하기 *전·중·후* 모두에 안전 게이트를 둔다.  
ITO/SI에서 "수정 → 곧장 commit → 운영 사고"의 사이클을 끊는 것이 목적.

**모델 고정:** 이 스킬과 영향 분석·패턴 검증·안전성 평가·선택적 테스트 생성/문서 동기화의 모든 Agent 호출 및 재시도는 `sonnet` 별칭을 사용한다. Opus로 자동 승격하지 않는다. 실제 모델은 조직이 `ANTHROPIC_DEFAULT_SONNET_MODEL`로 정한다(지정이 없으면 호스트의 기본 Sonnet). 미지원·권한 거부가 확인되면 중단하고 알린다. 모델을 이유로 영향 확인·HOLD/STOP·실행 검증 기준을 줄이지 않는다. 전역 모델 설정은 변경하지 않는다.

---

## 변경 범위 원칙 (Rule: 외과적 변경)

> 모든 Phase에서 이 원칙이 최우선 적용된다.

- **요청된 부분만** 수정한다. 인접 코드·주석·포맷을 "개선"하지 않는다.
- **내가 만든 orphan만** 정리한다. 기존 dead code는 언급하되 삭제하지 않는다.
- 변경된 모든 줄은 사용자 요청에 직접 연결되어야 한다.
- 리팩터링이 필요해 보이면 *변경 후* 별도 제안으로만 언급한다.

---

## 에이전트 호출 신뢰성 원칙 (에이전트를 부르는 모든 단계 공통)

이 스킬이 호출하는 `impact-analyzer`/`pattern-conformance`/`change-safety` 에이전트는 드물게
실제 작업 없이 "백그라운드로 실행했습니다, 완료되면 알려드리겠습니다" 같은 자기참조적 대기
응답만 내고 끝나는 경우가 있다(no-op). 각 Agent 호출 후:

1. 지시한 출력 파일(`_workspace/reports/impact_<slug>.md` 등)이 **실제로 디스크에 생성됐는지 확인**한다. 응답 텍스트만 보고 완료로 간주하지 않는다.
2. 파일은 없지만 에이전트가 **리포트 본문을 돌려줬으면**(`=== ... REPORT ===` 블록이나 판정·근거가 담긴 최종 응답) 다시 부르지 않는다. 그 본문을 그대로 그 경로에 Write 하고 진행한다. 실측: pattern-conformance 가 판정(CONFORM)과 근거를 응답으로만 돌려줘 같은 검증을 2분 넘게 한 번 더 돌렸다.
3. 파일도 본문도 없거나 응답이 위와 같은 대기·연기 형태면, **같은 에이전트를 1회 재호출**하되 프롬프트에 "이전 시도는 실제 작업 없이 끝났다. 백그라운드 실행이나 대기 언급 없이 이번 턴 안에서 직접 파일을 읽고 분석해서 Write로 산출물을 생성하라"를 명시한다.
4. 재시도까지 실패하면 진행을 멈추고 사용자에게 상황을 알린 뒤 지시를 기다린다(임의로 게이트를 건너뛰지 않는다).

서브에이전트는 포그라운드로 실행한다(`run_in_background`를 쓰지 않는다). 아래는 호스트가 그래도 뒤에서 돌렸을 때만 적용한다.

**잔여 백그라운드 에이전트 위생**: 같은 세션에서 이전에 백그라운드로 띄운 에이전트가 있다면(특히
위 no-op 재시도 후 방치된 것), 새 에이전트 호출을 시작하기 전에 남아 있는지 확인한다.
방치된 에이전트가 뒤늦게 재개되면 이번 작업이 이미 검증·확정한 산출물(`pattern_profile.json` 등)을
예고 없이 덮어쓸 수 있다. 남아 있으면 `TaskStop`으로 정리하고 나서 새 호출을 진행한다. 대기 중인
에이전트가 "추가 작업/스크립트 실행 승인"을 요청하는 경우에도, 이번 작업 범위 밖이면 승인하지 않는다.

---

## Phase 0: 컨텍스트 추출

사용자 자연어에서 운영 모드 키워드 감지:

| 키워드 | mode |
|--------|------|
| "운영 패치", "프로덕션", "운영 배포" | production |
| "긴급 핫픽스", "장애 대응" | hotfix |
| "레거시 손보기", "옛날 코드" | legacy |
| "고객 데모", "데모 직전" | customer_facing |
| (없음) | normal |

mode는 change-safety에 전달되어 가중치 조정에 사용된다.

인덱스 신선도부터 확인한다 — stale한 인덱스로 어댑터 판정·패턴 선택·영향 분석을 하면 근거 자체가
틀릴 수 있다.

아래 명령의 `${CLAUDE_PLUGIN_ROOT}`는 이 스킬을 불러올 때 플러그인 설치 절대경로로 바뀐다.
적힌 경로를 그대로 실행하고, 스크립트를 찾으려고 디스크를 검색하지 않는다. 경로가 변수 이름 그대로
남아 있으면 이 스킬이 로드될 때 표시된 "Base directory for this skill" 경로에서 `/skills/safe-modify`를
뗀 나머지를 플러그인 루트로 대신 쓴다.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/build-index.mjs" --root "[프로젝트 루트 절대 경로]" --check-stale
```

- exit 0(`stale:false`): 그대로 진행.
- exit 1(`stale:true`): 아래로 재인덱싱 후 진행. `reason`이 `인덱스 없음`이면 `--mode init`, 그 외(소스 변경·인덱서 버전 변경)면 `--mode incremental`.
  ```powershell
  node "${CLAUDE_PLUGIN_ROOT}/agents/lib/build-index.mjs" --root "[프로젝트 루트 절대 경로]" --mode incremental
  ```
  재인덱싱이 실패하거나(예: 대형 모노레포에서 시간 초과) 사용자가 건너뛰기를 원하면, 이후 모든 인덱스 기반 판정(어댑터 커버리지·영향 분석·패턴 선택)에 `지식 모델 stale — 최신 코드와 다를 수 있음`을 명시하고 진행한다. 소스를 직접 여는 것으로 대체할 수 있으나 그 사실도 함께 보고한다.

  재인덱싱이 실행됐고 `_workspace/wiki/`가 존재하면 기존 wiki도 stale 상태다 — GO 시 Phase 5에서 함께 갱신되므로 여기서는 인지만 하고, HOLD/STOP으로 끝나면 Phase 4 종료 보고에 `generate-wiki` 재실행 안내를 포함한다.

이제부터 소스 파일을 직접 Read로 여는 대신 `query-index.mjs`(symbol/callers/callees/trace/sql/table)로 먼저 질의해 위치·호출관계를 좁힌 뒤, 그 결과로 좁혀진 파일·라인만 최종 확인 차 Read한다. 인덱스 결과는 반드시 실물과 대조하고 — 인덱스가 stale일 수 있는 구간에서는 특히 — 인덱스만 믿고 결론 내리지 않는다.

변경 대상마다 어댑터 커버리지 게이트를 먼저 실행한다.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/check-adapter-coverage.mjs" --root "[프로젝트 루트 절대 경로]" --target "[변경 대상 상대 경로]"
```

- `FULL/GO`: 다음 단계 진행 가능.
- `PARTIAL/READ`: 인덱스만으로 확정하지 않는다. 대상 파일과 연결된 설정·화면·스크립트·SQL 원문을 **직접 읽어** 변경 지점과 호출 관계를 확인한 뒤 진행한다. 사용자에게 수동 검증을 요구하지 않는다. 읽은 파일 목록을 `원문 확인` 항목으로 change-safety 입력과 최종 보고에 남긴다.
- `UNSUPPORTED/HOLD`: 내용을 읽을 수 없는 형식(바이너리 등)이다. 지원되는 어댑터를 추가하기 전 변경 금지.
- 여러 파일이면 가장 낮은 커버리지를 전체 변경의 커버리지로 사용한다. `change-safety` 입력에도 결과 JSON을 포함한다.

변경 대상 경로가 정해지면 `.claude/patterns/pattern_profile.json`을 검증하고 해당 모듈·레이어의 기준 패턴을 선택한다.

```powershell
python "${CLAUDE_PLUGIN_ROOT}/agents/lib/pattern_profile.py" validate --root "[프로젝트 루트 절대 경로]"
python "${CLAUDE_PLUGIN_ROOT}/agents/lib/pattern_profile.py" select --root "[프로젝트 루트 절대 경로]" --target "[변경 대상 경로]" --module "[모듈명]" --limit 20
```

프로필이 없거나 맞는 프로필이 없으면 `select`가 `basis: "neighbors"`와 `reference_files`(대상 파일 자신 → 같은 폴더 → 상위 폴더의 같은 종류 파일)를 돌려준다. 그 파일들의 원문을 읽어 기준으로 삼고 리포트에 `기준: 이웃 파일`을 표시한다. 사용자에게 기준을 고르게 하지 않는다. `reference_files`까지 비어 있을 때(같은 종류 파일이 주변에 하나도 없음)만 신규 파일 생성 전에 pattern-extractor를 먼저 실행한다.

### 작업 맥락 파일과 규모 판정

서브에이전트는 새 대화로 시작해 앞 단계가 읽은 것을 모른다. 실측(컬럼 1개 추가, 24분): 같은 JSP·SQL·서비스를 오케스트레이터·impact-analyzer·pattern-conformance·change-safety가 네 번 다시 읽었고, 도구 호출 한 번이 5~15초라 그것만으로 수 분이 들었다. Phase 0에서 확인한 것을 파일 하나에 적어 모든 호출에 넘긴다.

`_workspace/reports/context_<slug>.md`에 Write 한다(같은 이름의 이전 파일은 덮어쓴다 — 이전 요청의 것일 수 있다).

```
# 작업 맥락: <slug>
요청: [사용자 요청 원문]
규모: small | normal  (판정 근거 한 줄)
변경 예정 파일: [경로 목록]
원문 확인: [경로:줄 범위 — 무엇을 확인했는지] (Phase 0에서 읽은 것 전부)
핵심 사실: [SQL ID, SELECT 컬럼 순서, 이 SQL·화면을 쓰는 다른 파일, 파일 인코딩, 어댑터 판정, 선택된 기준 파일 등]
확인하지 못한 사실: [없음 또는 목록]
```

**규모 `small`**: 변경 예정 파일이 3개 이하이고, API 계약(엔드포인트 경로·요청/응답 필드)·DB 스키마(DDL)·트랜잭션 경계·인증/인가·공통 모듈을 바꾸지 않는다. 하나라도 걸리면 `normal`이다.

규모는 **무엇을 바꾸는지**로만 정한다. 아직 확인하지 않은 위험(같은 SQL을 다른 화면도 쓸 것 같다, 뷰에 컬럼이 없을 수도 있다)은 규모를 올리는 이유가 아니다 — 그것을 찾는 것이 Phase 1 체크리스트다. 이전 실행이 남긴 `00_pipeline_status.md`·리포트의 판단도 근거로 쓰지 않는다. 실측: 이전 실행 기록의 "CRITICAL 리스크" 문구를 보고 SELECT 컬럼 하나 추가를 `normal`로 올려 영향 분석 에이전트를 다시 불렀다.

Phase 2 적용 뒤 같은 파일 끝에 `## 변경 내역`(파일별 요지, 정적 대조 결과)을 덧붙인다.

이전 실행이 남긴 `impact_<slug>.md`·`pattern_conformance_<slug>.md`·`safety_<slug>.md`는 재사용하지 않는다. 이번 요청의 결과가 아니다.

---

## Phase 1: 사전 영향 분석

**규모 `normal`** → `analyze-impact` 스킬의 Phase 0–2만 수행한다(그 스킬의 "다음 액션을 묻는다"는 하지 않는다):
- 변경 대상 정규화
- 인덱스 준비
- impact-analyzer 실행 → `_workspace/reports/impact_<slug>.md`. 프롬프트에 `맥락: _workspace/reports/context_<slug>.md`와 `규모: normal`을 넣는다.

**규모 `small`** → impact-analyzer 를 부르지 않고 **오케스트레이터가 직접** 확인한다. 이미 Phase 0에서 대상 원문을 읽었으므로 새 대화의 에이전트가 같은 파일을 다시 파악할 이유가 없다(실측: 에이전트로 4분 50초·도구 18회). 아래 체크리스트를 인덱스 질의로 채운다 — 질의 결과로 좁혀진 파일의 필요한 줄만 연다.

| 확인 | 방법 |
|---|---|
| 바꾸는 SQL·메서드를 쓰는 곳 전부 | `query-index.mjs sql --id <SQL id>`(used_by), `callers --id <심볼>` |
| 같은 결과를 **순서(번호)로** 읽는 곳 — 컬럼 추가·삭제 시 값이 조용히 밀린다 | 위에서 나온 화면·코드에서 `getString(n)`·`get(n)`·배열 인덱스 사용 여부를 Grep |
| 컬럼·테이블이 실제로 있는가 | `column --name <컬럼>`, `table --table <테이블>`, `schema --table <테이블>` |
| 트랜잭션 경계 안인가 | `transaction --file <변경 파일>` |
| 영향받는 테스트 | 위 `callers` 결과 중 테스트 경로(`test/`, `*Test.*`, `*_test.*`). 없으면 0 |
| 짝 저장소 영향 | API 계약(엔드포인트 경로·요청/응답 필드)이 바뀔 때만. 아니면 "API 계약 변경 없음 — 파트너 영향 없음" |

하나라도 예상과 다르면(쓰는 곳이 많거나, 트랜잭션·공통 모듈이 걸림) 규모를 `normal`로 올리고 impact-analyzer 를 부른다. 결과는 `_workspace/reports/impact_<slug>.md`에 짧게 Write 한다 — `직접 영향` · `순서로 읽는 곳` · `DB 확인` · `트랜잭션` · `파트너` · `위험도: N/10` · `확인하지 못한 사실`.

영향도 결과를 사용자에게 보여 주고 **묻지 않고 진행**한다 — 사용자는 이미 수정을 요청했다:

```
영향도: [N]/10 ([등급])
영향받는 테스트: K개
확인하지 못한 사실: [없음 또는 목록 — 보고의 위험 항목으로 남김]
→ 변경 적용 후 안전성 평가까지 진행합니다.
```

묻는 것은 아래 경우뿐이다. 그 밖에는 권장안으로 진행한다.
- 등급이 CRITICAL이다 → 1. 진행 2. 사전 회귀 테스트 작성 후 진행(test-generator) 3. 중단 중에서 고르게 한다.
- 데이터를 바꾸거나(INSERT·UPDATE·DELETE·DDL) 되돌리기 어려운 변경인데, 그 전제를 소스로 확인하지 못했다.
- 요청을 두 가지 이상으로 해석할 수 있고, 어느 쪽이냐에 따라 결과 화면·데이터가 달라진다.

조회 전용·화면 표시처럼 되돌리기 쉬운 변경에서 소스만으로 확정 못 한 사실(예: DB 뷰가 컬럼을 노출하는지)은 묻지 않는다. 권장안으로 진행하고 최종 보고의 `확인하지 못한 사실`에 "무엇을 어디서 확인하면 되는지"와 함께 남긴다.

---

## Phase 2: 변경 적용

Phase 1 결과를 보여 준 뒤 요청대로 어시스턴트가 Edit/Write로 바로 적용한다. 사용자가 이미 diff를 작성해 두었으면 그것을 대상으로 한다. 사용자 입력을 기다리지 않는다.

적용 후 변경 파일 목록 수집 (git diff 또는 작업 추적).

변경 시 `_workspace/reports/pattern_selection.json`의 선택 프로필과 `reference_files`를 먼저 읽는다. 현재 파일의 레거시 패턴을 유지해야 하는 최소 수정과 신규 권장 패턴 적용을 구분하며, 요청 범위 밖의 전체 현대화는 하지 않는다.

구현 방식이 둘 이상이면 **전제를 소스로 확인할 수 있는 쪽**을 고른다. 영향 분석이 "소스만으로 확정 불가"로 남긴 전제(예: DB 뷰가 컬럼을 노출하는지)에 기대는 방식은, 확인된 대안(예: 컬럼이 있음을 소스로 확인한 원본 테이블을 서브쿼리)이 없을 때만 쓴다. 실측: 같은 요청에서 뷰 컬럼을 그대로 쓴 실행은 "없으면 두 화면이 ORA-00904로 멈춤"으로 HOLD 됐고, 원본 테이블을 서브쿼리한 실행은 그 위험이 없었다.

---

## Phase 3: 사후 패턴·실행·안전성 평가

**순서.** `normal`은 3-1 → 3-2 → 3-3 차례로 한다. `small`은 3-2(검증 명령·정적 대조, 1분 안팎)를 먼저 하고, **3-1과 3-3을 한 메시지에 두 Agent 호출로 함께 부른다**(동시에 돈다). 둘 다 "바뀐 코드를 보고 판정"하는 일이라 서로 기다릴 이유가 작다. 이때 change-safety 프롬프트의 패턴 적합성 자리에는 `병렬 합산`을 넣고, 두 결과를 오케스트레이터가 합친다.

| pattern-conformance | 최종 결정 |
|---|---|
| CONFORM | change-safety 결정 그대로 |
| HOLD | 지적된 차이를 고치고 3-1을 한 번 재검증한다. 고치며 코드가 바뀌었으면 3-2를 다시 실행하고, 바뀐 줄이 3-3 근거에 닿으면 3-3도 다시 부른다. 그래도 HOLD면 최소 HOLD |
| FAIL | 고친 뒤 3-1·3-3 재실행. 그래도 FAIL이면 STOP |

모든 호출 프롬프트에 `맥락: _workspace/reports/context_<slug>.md`를 넣는다.

### 3-1. 패턴 적합성 검증

`pattern-conformance` 에이전트를 호출한다.

네임스페이스를 지정한 호출은 에이전트 지침이 자동으로 로드되므로 프롬프트에 절차를 인라인하지 않고 인자만 전달한다. 플러그인 네임스페이스 지정을 지원하지 않는 호스트에서는 `general-purpose`로 폴백하되 프롬프트에 해당 `agents/<이름>.md`의 지침을 읽고 그대로 따르라고 명시한다.

```
Agent(
  subagent_type="ax-navi:pattern-conformance",
  description="변경 코드 패턴 적합성 검증",
  prompt="<변경 파일: [목록]. 맥락: _workspace/reports/context_<slug>.md. 선택 결과: _workspace/reports/pattern_selection.json. 출력: _workspace/reports/pattern_conformance_<slug>.md>",
  model="sonnet"
)
```

FAIL이면 수정 후 재검증한다. HOLD이면 지적된 차이를 기준 파일 원문에 맞춰 고치고 한 번 재검증한다. 그래도 HOLD면 그 사유를 보고에 남기고 HOLD로 끝낸다.

### 3-2. 검증 명령 실행

먼저 결정론적 감지기로 프로젝트의 검증 명령 후보를 확보한다(부작용 없음).

```powershell
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/verify-target.mjs" detect --root "[프로젝트 루트 절대 경로]" --target "[변경 대상 상대 경로]"
```

`detected` 목록(lint/typecheck/test/build)을 사용자에게 보여주고, 변경 범위에 해당하는 가장 작은 명령을 골라 실제 실행한다.

- 바뀐 파일 종류를 검사하지 않는 명령은 이 변경의 검증이 아니다(예: JSP·쿼리 XML만 바뀌었는데 Java 컴파일). 해당하는 명령이 없으면 `검증 수단 없음`이다.
- 명령의 실행 파일이 이 환경에 없으면 `run`이 실행하지 않고 `overall: "unavailable"`(exit 3, `missing_tool`)을 돌려준다. 코드 결함이 아니다. 실패가 아니라 `검증 수단 없음(환경: <도구> 없음)`으로 적는다.
- 검증 수단이 없으면 에이전트가 직접 할 수 있는 **정적 대조**를 한다. 예: SQL SELECT 목록 순서 ↔ 화면의 `getString(n)`·컬럼 매핑, 같은 SQL·화면을 쓰는 다른 파일, 태그 짝·colspan 수. 결과를 `정적 대조` 항목으로 change-safety에 넘긴다. 사람에게 육안 대조를 맡기지 않는다.

```powershell
node "${CLAUDE_PLUGIN_ROOT}/agents/lib/verify-target.mjs" run --root "[프로젝트 루트 절대 경로]" --cmd "[detected에서 고른 명령]"
```

`run`은 성공 시 요약만, 실패 시 `fail_lines`(명령당 상한)만 돌려준다 — 코드 전체를 다시 LLM에 넣지 않는다. 반환된 `commands[].cmd`·`exit`·`fail_lines`와 `overall`을 그대로 change-safety 입력에 넘긴다. `detected`가 비어 있으면(`count: 0`) 자동 검증이 없다는 뜻이다. PASS로 적지 않고 `검증 수단 없음`으로 적는다 — 위험 변경이 아니면 원문 확인 근거로 진행한다(Phase 4 GO 조건). 실행할 수 없거나 assertion까지 도달하지 못한 검사도 PASS로 간주하지 않는다.

### 3-3. 변경 안전성 평가

`change-safety` 에이전트 호출:

```
Agent(
  subagent_type="ax-navi:change-safety",
  description="변경 안전성 평가",
  prompt="<변경 파일: [목록]. mode: [감지된 모드]. 맥락: _workspace/reports/context_<slug>.md. impact 리포트: _workspace/reports/impact_<slug>.md. 어댑터: check-adapter-coverage 결과 JSON(READ면 원문 확인 목록은 맥락 파일). 패턴 적합성: _workspace/reports/pattern_conformance_<slug>.md (small 병렬이면 '병렬 합산'). 검증 결과: verify-target run의 commands(cmd·exit·fail_lines)와 overall, 검증 수단이 없으면 그 사유와 맥락 파일 `## 변경 내역`의 정적 대조. 출력: _workspace/reports/safety_<slug>.md>",
  model="sonnet"
)
```

---

## Phase 4: 결정 + 후속 조치

`_workspace/reports/safety_<slug>.md` 읽고 사용자에게 보고:

```
변경 안전성 평가 완료

차원별 점수:
| 회귀 | 컨벤션 | 사이드이펙트 | 롤백 | 보안 | 테스트 |
|------|--------|-----------|------|------|--------|
| X    | X      | X         | X    | X    | X      |

종합 위험도: X/10
즉시 STOP 트리거: [있음/없음]

패턴 적합성: [CONFORM / HOLD / FAIL] · 기준: [프로필 id 또는 이웃 파일 경로]
원문 확인: [읽은 파일 — 어댑터 READ일 때]
검증 증거: [명령·exit / 검증 수단 없음(사유) + 정적 대조 / UNVERIFIED]
확인하지 못한 사실: [없음 또는 목록 — 무엇을 어디서 확인하면 되는지]
결정: [GO / HOLD / STOP]

[GO]
권장 다음 액션:
- commit 메시지: [권고]
- 추가 권고:
  - doc-syncer 호출 ("문서 동기화") — 문서 영향 점검
  - (production mode) 단계적 배포
배포 후 확인 권장: [있으면 — GO 조건은 아님]

[HOLD]
보완 필요 항목:
1. [차원]: [구체 액션]
2. ...
보완 후 다시 호출하세요: "이 변경 다시 평가해줘"
(재인덱싱으로 wiki가 stale이면) wiki 갱신: "위키 다시 만들어줘"

[STOP]
사유: [...]
대안:
- [...]
권장: 변경 철회 또는 재설계

전체 리포트: _workspace/reports/safety_<slug>.md
```

GO는 `어댑터 FULL 또는 READ(원문 확인 완료) + 패턴 CONFORM + (검증 명령 exit 0, 또는 검증 수단 없음 + 정적 대조) + change-safety GO`일 때다. 검증 수단 없음으로 GO를 내는 것은 DB 스키마 DDL·트랜잭션 경계·인증/인가·공통 모듈 변경이 아닐 때만이다. 어댑터가 READ인데 원문을 읽지 않았거나, UNSUPPORTED이거나, 바뀐 파일을 검사하는 실행 가능한 명령을 실행하지 않았으면 HOLD(`UNVERIFIED`)로 보고한다. 배포 뒤에야 확인할 수 있는 것(실제 DB 값, 화면 표시)은 `배포 후 확인 권장`으로 따로 적되 GO 조건으로 삼지 않는다. Phase 0에서 이웃 파일을 기준으로 삼은 경우도 다른 조건이 충족되면 GO이며, 보고에 `기준: 이웃 파일 [경로]`를 남긴다.

## Phase 5: 인덱스·위키 증분 갱신

GO 후 변경된 코드가 다음 작업과 인수인계 위키에 반영되도록 기본 실행한다.

1. `node "${CLAUDE_PLUGIN_ROOT}/agents/lib/build-index.mjs" --root "[프로젝트 루트]" --mode incremental`
2. API·SQL·호출 관계가 바뀌었으면 관련 인덱스가 실제 변경 파일을 포함하는지 `query-index.mjs`로 확인한다(예: `callees --id <변경한 메서드>`가 새 호출을 반영하는지).
3. `generate-wiki`를 재실행한다 — 자동 후속 갱신 호출이므로 generate-wiki Phase 0의 덮어쓰기 Y/N 질문은 생략하고 바로 백업 후 재생성한다(generate-wiki SKILL.md의 "예외 — 자동 후속 갱신 호출" 참조).
4. 생성된 wiki의 분석 커밋·시각과 현재 HEAD가 맞는지 보고한다.
5. 이 시스템의 wiki가 중앙 허브에 발행된 이력이 있으면(프로젝트 루트 `.env`에 `WIKI_DB_ENGINE` 등 wiki DB 설정 존재) "허브 발행본도 갱신할까요?"를 1회 물어본다. 기본은 갱신하지 않음이며, 사용자가 원하면 `publish-wiki` 스킬로 위임한다.

갱신 실패는 코드 변경을 되돌리는 사유는 아니지만 `지식 모델 stale` WARN으로 명확히 남기고 재실행 명령을 안내한다.

---

## 자동 후속 (옵션)

GO 결정 시 추가 선택 작업:
- 사용자 명시 요청 있으면 → test-generator 자동 호출 (영향 코드 회귀 테스트 추가)
- 사용자 명시 요청 있으면 → doc-syncer 자동 호출 (문서 동기화)

test-generator·doc-syncer는 기본 OFF지만 Phase 3의 실제 테스트 실행과 Phase 5의 인덱스·wiki 갱신은 기본 ON이다.
