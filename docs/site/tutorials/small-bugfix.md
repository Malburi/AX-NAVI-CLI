# 작은 버그 수정

`OrderService.cancel()`에서 NPE가 나서 null 체크 한 줄을 추가해야 한다. 작은 수정이지만 어디까지 영향이 가는지 확인하고, 적용 후 안전하다는 근거를 남긴 뒤 커밋하는 흐름을 익힌다.

- **소요 시간** — 15~30분. 영향 분석 수 분, 적용과 사후 평가 수 분, 나머지는 리포트 읽기와 커밋이다.
- **전제** — 하네스가 초기화돼 있고 `_workspace/index/`에 인덱스가 있다. 프로젝트에 실행 가능한 테스트나 빌드 명령이 하나 이상 있다.
- **이 튜토리얼이 다루는 스킬** — `analyze-impact`(`/impact`), `safe-modify`(`/modify`).

## 준비

수정 대상을 인덱스가 찾을 수 있는 형태로 정리해 둔다. 클래스·메서드 이름(`OrderService.cancel`), 파일 경로, SQL ID, 엔드포인트 중 하나면 된다. 이름이 모호하면 스킬이 1회만 확인 질문을 한다.

`analyze-impact`는 읽기 전용이고 `safe-modify`는 변경까지 진행한다. 작은 수정은 `safe-modify`만 써도 된다. 내부에서 사전 영향 분석을 수행하기 때문이다. 이 튜토리얼은 리포트 읽는 법을 익히기 위해 두 단계를 나눠 진행한다.

## 단계별 진행

### 1. 영향도 먼저 보기

```text
OrderService.cancel 영향도 분석해줘
```

`analyze-impact`가 인덱스 신선도를 `build-index.mjs --check-stale`로 확인하고(stale이면 incremental 재인덱싱), `impact-analyzer` 에이전트를 호출한다. 결과는 `_workspace/reports/impact_OrderService_cancel.md`에 저장된다.

화면 요약에서 다음을 읽는다.

| 항목 | 읽는 법 |
|---|---|
| 위험도 N/10 | 1~3 LOW는 즉시 진행 가능, 4~6 MEDIUM은 영향 파일 단위 테스트 권고, 7~8 HIGH는 회귀 테스트와 사전 리뷰 필수, 9~10 CRITICAL은 외부 조율과 롤백 계획 필수 |
| 직접 영향 | 변경 대상을 바로 호출하는 코드. 파일:라인과 심볼이 나열된다 |
| 간접 영향 | 호출 그래프를 3홉까지 거슬러 올라간 범위와 허브 메서드 |
| 영향받는 테스트 | 사후 평가에서 실행할 테스트 목록이다. 커버리지 데이터가 있으면 비율도 나온다 |
| 외부 통신·트랜잭션·DB 스키마·인증 | 하나라도 "있음"이면 위험도가 가산된 이유다 |

리포트 끝에는 항상 "정적 분석 한계로 리플렉션/동적 바인딩/외부 트리거는 누락될 수 있습니다"가 붙는다. 시나리오 예시처럼 LOW(3/10)에 영향 테스트 4개라면 바로 다음 단계로 간다.

### 2. 안전 변경 시작

```text
이 변경 안전하게 적용해줘. OrderService.cancel()에 order가 null이면 IllegalArgumentException을 던지는 체크 추가
```

`safe-modify`가 Phase 0에서 순서대로 준비한다.

1. 운영 모드 키워드 감지 — 이 요청에는 없으므로 `normal`이다.
2. 인덱스 신선도 확인과 필요 시 incremental 재인덱싱.
3. `check-adapter-coverage.mjs`로 변경 대상 파일의 어댑터 커버리지 확인 — `FULL`이면 그대로, `PARTIAL`이면 에이전트가 연결 파일 원문을 읽고(`원문 확인`) 진행하며, `UNSUPPORTED`일 때만 HOLD다.
4. `pattern_profile.py validate`와 `select`로 같은 모듈·레이어의 preferred 프로필과 실제 기준 파일 선택 — 결과는 `_workspace/reports/pattern_selection.json`에 남는다.
5. 확인한 파일과 사실을 `_workspace/reports/context_<slug>.md`에 적고 규모를 정한다. 파일 1개이고 API 계약·DB 스키마·트랜잭션·인증·공통 모듈 변경이 없으므로 `small`이다. 규모는 바뀌는 내용만으로 정하며 추측한 위험이나 이전 실행 기록으로 정하지 않는다.

Phase 1에서 규모가 `small`이므로 오케스트레이터가 인덱스 질의(쓰는 곳·결과를 순서로 읽는 곳·트랜잭션 등)로 직접 영향을 확인하고 짧은 `impact_<slug>.md`를 쓴다. 1단계에서 만든 리포트를 포함해 이전 실행의 리포트는 재사용하지 않는다. 결과를 보여 준 뒤 묻지 않고 진행한다.

```text
영향도: 3/10 (LOW)
영향받는 테스트: 4개
확인하지 못한 사실: 없음
→ 변경 적용 후 안전성 평가까지 진행합니다.
```

질문은 CRITICAL이거나, 데이터 변경·되돌리기 어려운 변경의 전제를 확인하지 못했거나, 요청 해석이 갈릴 때만 나온다. CRITICAL이면 진행 / 사전 회귀 테스트 작성 후 진행 / 중단 중에서 고른다.

### 3. 변경 적용

Phase 2에서 어시스턴트가 자연어 설명을 Edit로 적용한다. 이때 외과적 변경 원칙이 적용된다. 요청된 null 체크만 추가하고 인접 코드·주석·포맷은 건드리지 않으며, 기존 dead code가 보여도 언급만 하고 삭제하지 않는다. 적용 전에 `pattern_selection.json`의 기준 파일을 읽어 그 파일의 예외 처리 방식을 따른다.

변경 파일 목록이 수집되면 Phase 3으로 넘어간다.

### 4. 사후 평가 세 단계

Phase 3은 세 가지 증거를 모은다. 규모 `small`이면 3-2를 먼저 하고 3-1과 3-3을 동시에 돌려 결과를 합친다.

| 단계 | 하는 일 | 산출물 |
|---|---|---|
| 3-1 패턴 적합성 | `pattern-conformance`가 변경 코드와 기준 파일을 교차 비교해 CONFORM/HOLD/FAIL 판정 | `_workspace/reports/pattern_conformance_<slug>.md` |
| 3-2 검증 명령 실행 | `verify-target.mjs detect`로 lint/typecheck/test/build 후보를 찾고, 변경 범위에 맞는 가장 작은 명령을 `run`으로 실제 실행 | 명령·exit code·`fail_lines` |
| 3-3 안전성 평가 | `change-safety`가 impact 리포트·패턴 판정·실행 결과를 받아 6차원 점수와 GO/HOLD/STOP 산출 | `_workspace/reports/safety_<slug>.md` |

3-2에서는 에이전트가 `detected` 목록에서 변경 범위에 맞는 가장 작은 명령을 골라 실행한다. 이 단계에서 영향 테스트 4개가 실행돼 PASS가 나와야 한다.

### 5. 안전성 리포트 읽기

Phase 4 보고는 다음 형태다.

```text
변경 안전성 평가 완료

차원별 점수:
| 회귀 | 컨벤션 | 사이드이펙트 | 롤백 | 보안 | 테스트 |
| 1    | 0      | 0         | 0    | 0    | 2      |

종합 위험도: 0.4/10
즉시 STOP 트리거: 없음

패턴 적합성: CONFORM
검증 증거: mvn -q test -Dtest=OrderServiceTest (exit 0)
결정: GO
```

읽는 요령은 다음과 같다.

- 6차원 점수는 0이 안전, 10이 위험이다. 종합 위험도는 보안에 2배 가중치를 준 평균이다.
- GO는 `어댑터 FULL 또는 READ(원문 확인) + 패턴 CONFORM + 필수 검증 exit 0 또는 검증 수단 없음 + 정적 대조 + change-safety GO`가 모두 충족될 때만 나온다. 위험 점수가 낮아도 적용할 수 있고 실행 가능한 검증 명령을 돌리지 않았으면 HOLD(`UNVERIFIED`)다.
- 즉시 STOP 트리거는 평문 비밀번호 추가, SQL 인젝션 패턴, 인증 우회, WHERE 없는 DELETE 같은 항목이다. 하나라도 있으면 점수와 무관하게 STOP이다.
- 전체 근거는 `_workspace/reports/safety_<slug>.md`의 차원별 표와 "영향 요약" 절에 있다.

### 6. 자동 갱신 확인과 커밋

GO 판정 뒤 Phase 5가 기본으로 실행된다. `build-index.mjs --mode incremental`로 인덱스를 갱신하고, `_workspace/wiki/`가 있으면 `generate-wiki`를 질문 없이 재실행한다. 갱신 실패는 코드를 되돌릴 사유는 아니지만 `지식 모델 stale` WARN으로 남는다.

커밋은 사용자가 직접 한다. 하네스는 커밋을 자동 실행하지 않는다.

```bash
git add src/main/java/.../OrderService.java
git commit -m "OrderService.cancel: null 주문 방어 체크 추가"
```

리포트의 "commit 메시지 권고"를 참고하되 한 문장으로 설명되는 단위만 담는다. 문서 영향이 있을 것 같으면 "문서 동기화"로 `doc-syncer`를 호출해 `_workspace/reports/docs_sync_<slug>.md`의 권고를 본다.

## 결과 확인

- `_workspace/reports/impact_OrderService_cancel.md` — 위험도와 영향 테스트 목록.
- `_workspace/reports/pattern_selection.json` — 어떤 기준 파일을 따랐는지.
- `_workspace/reports/pattern_conformance_<slug>.md` — CONFORM 판정과 근거.
- `_workspace/reports/safety_<slug>.md` — GO 판정, 6차원 점수, 실행한 검증 명령.
- 갱신된 `_workspace/index/` 와 `_workspace/wiki/`.

## 막혔을 때

- **HOLD(`UNVERIFIED`)가 나왔다** — 바뀐 파일을 검사하고 이 환경에서 실행 가능한 테스트·빌드 명령을 돌리지 않은 경우다. 적용할 명령이 없거나 도구가 설치되지 않았으면 `검증 수단 없음` + 정적 대조로 적히며 UNVERIFIED가 아니다. 다만 DB 스키마·트랜잭션·인증·공통 모듈 같은 위험 변경은 검증 수단이 없으면 HOLD다. `test-generator`로 회귀 테스트를 만든 뒤 "이 변경 다시 평가해줘"로 재평가한다.
- **보고에 `기준: 이웃 파일`이 있다** — `pattern_profile.json`이 없어 대상 파일과 같은 폴더의 파일을 기준으로 삼았다는 뜻이다. 그대로 진행되며, 더 정확한 기준을 원하면 "패턴 추출해줘"로 프로필을 만든다.
- **에이전트가 "백그라운드로 실행했습니다"만 말하고 끝났다** — no-op이다. `safe-modify`는 산출물 파일이 실제로 생겼는지 확인한다. 리포트 본문만 돌려줬으면 그 본문을 파일로 저장하고, 파일도 본문도 없으면 1회 재호출한다. 재시도도 실패하면 멈추고 알려 주므로 지시를 내린다.
- **인덱스가 stale이라는 경고가 나온다** — `analyze-impact`와 `safe-modify`는 stale이면 자동으로 incremental 재인덱싱을 시도한다. 대형 모노레포에서 시간 초과로 건너뛰면 리포트에 `지식 모델 stale`이 명시되니 그 구간은 소스를 직접 확인한다.
- **패턴 적합성이 HOLD다** — 가장 가까운 기준 파일과도 다른 트랜잭션·예외·인증 방식을 근거 없이 넣었다는 뜻이다. 에이전트가 한 번 고쳐 재검증하고, 그래도 HOLD면 리포트의 "필요한 조치"에 기준 파일:라인이 적힌다.
- **그냥 빨리 고치고 싶다** — "알아서 해줘"로 `vibe`를 쓸 수 있지만 영향·안전 게이트가 빠진다. 3개 이상 파일, 트랜잭션 경계, DB 스키마, 외부 API 계약에 걸리면 어차피 `safe-modify`로 승격된다.

## 관련 문서

- [analyze-impact](/skills/analyze-impact.md) · [safe-modify](/skills/safe-modify.md) — 두 스킬의 Phase와 출력 형식.
- [change-safety](/agents/change-safety.md) — 6차원 평가와 결정 로직.
- [pattern-conformance](/agents/pattern-conformance.md) — CONFORM/HOLD/FAIL 판정 기준.
- [게이트](/concepts/gates.md) — GO/HOLD/STOP이 어떤 조건으로 결정되는지.
- [운영 핫픽스](/tutorials/hotfix.md) — 같은 흐름에 운영 모드 가중치가 붙는 경우.
