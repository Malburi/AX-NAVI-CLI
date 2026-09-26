# safe-modify

코드 변경을 사전 영향 분석 → 적용 → 사후 안전성 평가 순으로 안전하게 수행하는 오케스트레이터다. 변경을 적용하기 전·중·후 모두에 안전 게이트를 두어 ITO/SI에서 "수정 → 곧장 commit → 운영 사고"의 사이클을 끊는 것이 목적이며, "수정해줘"·"고쳐줘" 같은 범용 수정 요청도 기본적으로 이 스킬을 탄다.

## 언제 쓰는가

| 구분 | 트리거 문구 |
|------|-------------|
| 한국어 | "안전하게 수정", "회귀 위험 없이 변경", "이 변경 안전한가?", "변경 전 체크", "이 패치 적용해도 돼?", "운영 패치 검토", "긴급 핫픽스", "이 수정 GO/NO-GO?", "변경 리뷰" |
| 영어 | "safe modify" |
| 범용 문구 (기본 경로) | "수정해줘", "고쳐줘", "개선해줘", "버그 잡아줘", "이거 바꿔줘" |
| 축약 호출 | "안전수정 [내용]" |
| 슬래시 호출 | `/ax-navi:safe-modify`, 별칭 `/modify [내용]` |
| 자동 트리거 | 없다. 범용 수정 요청이 기본 경로로 라우팅될 뿐이다. |

게이트 없이 바로 하려면 [vibe](/skills/vibe.md) 스킬("알아서 해줘")을 명시적으로 부른다. `/modify`는 `ax-navi:safe-modify`로 위임하는 별칭이며 뒤에 쓴 내용 전부를 그대로 전달한다.

## 실행 흐름

| 단계 | 하는 일 | 호출 에이전트·스크립트 | 사용자 개입 |
|------|---------|------------------------|-------------|
| Phase 0 | 운영 모드 키워드 감지, 인덱스 신선도 확인, 어댑터 커버리지 게이트, 패턴 프로필 검증·선택. | `build-index.mjs --check-stale`, `check-adapter-coverage.mjs`, `pattern_profile.py validate/select` | 재인덱싱 건너뛰기를 원하면 알린다. |
| Phase 1 | 사전 영향 분석. [analyze-impact](/skills/analyze-impact.md) 절차 그대로 실행해 `impact_<slug>.md`를 만들고 진행 여부를 묻는다. | [impact-analyzer](/agents/impact-analyzer.md) | **1. 변경 적용 후 안전성 평가까지 진행 / 2. 사전 회귀 테스트 작성 후 진행 / 3. 중단** 중 선택한다. CRITICAL이면 옵션 2를 권장한다. |
| Phase 2 | 변경 적용. 사용자가 직접 작성하거나 자연어 설명을 어시스턴트가 Edit/Write로 적용한다. `pattern_selection.json`의 선택 프로필과 `reference_files`를 먼저 읽는다. | Edit/Write | 변경 내용을 설명하거나 직접 작성한다. |
| Phase 3-1 | 패턴 적합성 검증. FAIL이면 수정 후 재검증, HOLD면 사용자 결정 전 GO로 진행하지 않는다. | [pattern-conformance](/agents/pattern-conformance.md) | HOLD 시 의도적 차이인지 결정한다. |
| Phase 3-2 | 검증 명령 실행. `detect`로 lint/typecheck/test/build 후보를 확보하고, 변경 범위에 맞는 가장 작은 명령을 `run`으로 실제 실행한다. | `verify-target.mjs detect/run` | `detected` 목록을 보고 고른다. |
| Phase 3-3 | 변경 안전성 평가. 변경 파일·mode·impact 리포트·패턴 적합성·검증 결과를 넘긴다. | [change-safety](/agents/change-safety.md) | 없음 |
| Phase 4 | 결정 + 후속 조치. 차원별 점수, 종합 위험도, 패턴 적합성, 검증 증거, 결정(GO/HOLD/STOP)을 보고한다. | 리포트 읽기 | HOLD면 보완 후 "이 변경 다시 평가해줘"로 재호출한다. |
| Phase 5 | 인덱스·위키 증분 갱신. GO 후 기본 실행한다. | `build-index.mjs --mode incremental`, [generate-wiki](/skills/generate-wiki.md) | 허브 발행 이력이 있으면 "허브 발행본도 갱신할까요?"를 1회 묻는다. 기본은 갱신하지 않음이다. |

### Phase 0 운영 모드

| 키워드 | mode | change-safety 가중치 조정 |
|--------|------|---------------------------|
| "운영 패치", "프로덕션", "운영 배포" | production | 보안 가중치 ×2, 즉시 STOP 임계값 하향 |
| "긴급 핫픽스", "장애 대응" | hotfix | 변경 라인 수 임계 ×0.5(작은 변경만 GO) |
| "레거시 손보기", "옛날 코드" | legacy | 컨벤션 가중치 ×0.5 |
| "고객 데모", "데모 직전" | customer_facing | 외부 시스템 영향 가중치 ×2 |
| (없음) | normal | 기본 |

### Phase 0 어댑터 커버리지 게이트

| 판정 | 동작 |
|------|------|
| `FULL/GO` | 다음 단계 진행 가능. |
| `PARTIAL/READ` | 인덱스만으로 확정하지 않는다. 대상과 연결된 설정·화면·스크립트·SQL 원문을 직접 읽어 확인한 뒤 진행한다. 읽은 파일은 `원문 확인` 목록으로 보고에 남는다. |
| `UNSUPPORTED/HOLD` | 내용을 읽을 수 없는 형식이다. 지원되는 어댑터를 추가하기 전 변경 금지. |

여러 파일이면 가장 낮은 커버리지를 전체 변경의 커버리지로 사용한다. 패턴 프로필이 없으면 Markdown 패턴과 동일 모듈의 유사 코드로 폴백할 수 있지만 리포트에 `구조화 패턴 미검증`을 표시하고, 신규 파일 생성이 포함된 변경은 폴백하지 않고 pattern-extractor를 먼저 실행한다.

### Phase 4 결정 기준

| 결정 | 조건 |
|------|------|
| **GO** | `어댑터 FULL + 패턴 CONFORM + 필수 검증 exit 0 + change-safety GO`가 모두 충족될 때만. |
| **HOLD** | 있는 검증 명령을 실행하지 못했거나, 어댑터가 UNSUPPORTED이거나, PARTIAL인데 원문을 읽지 않았으면 HOLD(`UNVERIFIED`). 검증 수단이 아예 없으면 위험 변경(DB 스키마·트랜잭션·인증)일 때만 HOLD. `구조화 패턴 미검증` 폴백도 자동 GO 대상이 아니다. |
| **STOP** | pattern-conformance FAIL, 필수 검증 명령 실패, 또는 즉시 STOP 트리거(평문 비밀번호/API 키 추가, SQL 인젝션 가능 패턴, 인증/인가 우회, 데이터 손실 가능 변경, 운영 전용 분기 + 검증 없음). |

change-safety는 회귀 · 컨벤션 · 사이드이펙트 · 롤백 · 보안 · 테스트 6개 차원을 채점하고 `(회귀 + 컨벤션 + 사이드이펙트 + 롤백 + 보안 × 2 + 테스트) / 7`로 종합한다. GO는 종합 < 3이고 보안 점수 < 5일 때, HOLD는 종합 3~6 또는 보안 5~7, STOP은 종합 > 6 또는 보안 ≥ 8이다. `구조화 패턴 미검증` 상태에서 진행하려면 "패턴 근거가 없는 상태로 적용할까요?"를 명시적으로 확인받은 뒤에만 GO로 올린다.

## 입력과 산출물

| 구분 | 파일 | 내용 |
|------|------|------|
| 읽는 파일 | `_workspace/index/*.json` | `query-index.mjs`(symbol/callers/callees/trace/sql/table)로 위치·호출관계를 좁힌다. |
| 읽는 파일 | `_workspace/index/_meta.json` | 어댑터 커버리지 판정 근거 |
| 읽는 파일 | `.claude/patterns/pattern_profile.json`, `.claude/patterns/*.md` | 기준 패턴 선택과 폴백 |
| 읽는 파일 | `_workspace/wiki/` 존재 여부 | 재인덱싱 후 wiki stale 인지 |
| 읽는 파일 | 프로젝트 루트 `.env`의 `WIKI_DB_ENGINE` 등 | 허브 발행 이력 판단 |
| 쓰는 파일 | `_workspace/reports/impact_<slug>.md` | Phase 1 영향도 리포트 |
| 쓰는 파일 | `_workspace/reports/pattern_selection.json` | Phase 0 `pattern_profile.py select` 결과 |
| 쓰는 파일 | `_workspace/reports/pattern_conformance_<slug>.md` | Phase 3-1 패턴 적합성 판정 |
| 쓰는 파일 | `_workspace/reports/safety_<slug>.md` | Phase 3-3 안전성 리포트(GO/HOLD/STOP + 근거) |
| 쓰는 파일 | `_workspace/index/*.json`, `_workspace/wiki/` | Phase 5 증분 갱신 |
| 쓰는 파일 | 변경 대상 소스 파일 | Phase 2에서 사용자 요청 범위 안에서만 |

## 예시

```text
사용자: OrderService.cancel에서 NPE 나. null 체크 추가해서 안전하게 수정해줘

하네스: 인덱스 신선도: stale:false. 어댑터 커버리지: FULL/GO.
        패턴 프로필 검증 PASS — order/service 레이어 preferred 프로필 선택 (기준 파일 2개).

        영향도: 3/10 (LOW)
        영향받는 테스트: 4개

        진행 옵션:
        1. 변경 적용 후 안전성 평가까지 진행
        2. 사전 회귀 테스트 작성 후 진행 (test-generator 호출)
        3. 중단
        선택?
사용자: 1

하네스: 변경 적용 완료 — OrderService.java 1개 파일, +3 / -0.
        패턴 적합성: CONFORM
        검증 명령: ./gradlew test --tests OrderServiceTest → exit 0

        변경 안전성 평가 완료
        | 회귀 | 컨벤션 | 사이드이펙트 | 롤백 | 보안 | 테스트 |
        | 1    | 0      | 0           | 0    | 0    | 2      |
        종합 위험도: 0.6/10
        즉시 STOP 트리거: 없음
        결정: GO

        권장 다음 액션:
        - commit 메시지: fix(order): null-guard cancel() when order is missing
        인덱스 incremental 갱신 완료 · wiki 재생성 완료 (HEAD 일치)
        전체 리포트: _workspace/reports/safety_OrderService_cancel.md
```

핫픽스 모드에서 HOLD가 나온 경우다.

```text
사용자: 긴급 핫픽스 — PaymentValidator.validate 우회 막아야 해. 이 변경 안전하게 적용해줘

하네스: mode: hotfix 감지. 영향도: 5/10 (MEDIUM) — 외부 결제 게이트웨이 호출 포함.
        ...
        결정: HOLD
        보완 필요 항목:
        1. 보안: 입력 검증 강화 패턴 추가 (보안 점수 6/10)
        2. 테스트: 우회 케이스 회귀 테스트 없음
        보완 후 다시 호출하세요: "이 변경 다시 평가해줘"
        _workspace/wiki/가 stale 상태입니다 — GO 후 Phase 5에서 갱신되므로 완료 뒤 generate-wiki를 재실행하세요.
```

## 원칙과 주의

- **외과적 변경 원칙이 모든 Phase에서 최우선이다.** 요청된 부분만 수정하고 인접 코드·주석·포맷을 "개선"하지 않는다. 내가 만든 orphan만 정리하며 기존 dead code는 언급하되 삭제하지 않는다. 변경된 모든 줄은 사용자 요청에 직접 연결되어야 하고, 리팩터링은 변경 후 별도 제안으로만 언급한다.
- **모델 고정.** 이 스킬과 영향 분석·패턴 검증·안전성 평가·선택적 테스트 생성/문서 동기화의 모든 Agent 호출 및 재시도는 `claude-sonnet-5`를 사용한다. `sonnet` 별칭이나 Opus 자동 승격을 사용하지 않는다.
- **변경 적용은 사용자가 진행 의사를 명시한 경우에만 한다.** Phase 1 결과를 보고 사용자가 옵션을 고르기 전에는 코드를 건드리지 않는다.
- **에이전트 호출 신뢰성.** 지시한 출력 파일이 실제로 디스크에 생성됐는지 확인하고, 없거나 대기·연기 응답이면 같은 에이전트를 1회 재호출한다. 재시도까지 실패하면 진행을 멈추고 알린다. 임의로 게이트를 건너뛰지 않는다.
- **잔여 백그라운드 에이전트 위생.** 이전에 방치된 에이전트가 뒤늦게 재개되어 `pattern_profile.json` 등을 덮어쓸 수 있으므로, 새 Phase 1·3-1·3-3 호출 전에 확인하고 남아 있으면 `TaskStop`으로 정리한다. 작업 범위 밖의 승인 요청은 승인하지 않는다.
- **인덱스만 믿고 결론 내리지 않는다.** 인덱스 결과는 반드시 실물과 대조하며, stale일 수 있는 구간에서는 특히 그렇다.
- **미실행은 PASS가 아니다.** `detected`가 비어 있으면(`count: 0`) PASS로 적지 않고 `검증 수단 없음`으로 적는다. 실행할 수 없거나 assertion까지 도달하지 못한 검사도 PASS가 아니다.
- **HOLD/STOP에서도 자동 수정하지 않는다.** 판단은 항상 사람이 한다. STOP이면 변경 철회 또는 재설계와 대안을 안내한다.
- **test-generator·doc-syncer는 기본 OFF다.** 사용자 명시 요청이 있을 때만 GO 후 자동 호출한다. Phase 3의 실제 테스트 실행과 Phase 5의 인덱스·wiki 갱신은 기본 ON이다.
- **갱신 실패는 코드 변경을 되돌리는 사유가 아니다.** `지식 모델 stale` WARN으로 명확히 남기고 재실행 명령을 안내한다.

## 관련 문서

- [게이트](/concepts/gates.md)
- [change-safety 에이전트](/agents/change-safety.md)
- [pattern-conformance 에이전트](/agents/pattern-conformance.md)
- [패턴 프로필](/concepts/pattern-profiles.md)
- [vibe](/skills/vibe.md)
- [튜토리얼: 핫픽스](/tutorials/hotfix.md)
