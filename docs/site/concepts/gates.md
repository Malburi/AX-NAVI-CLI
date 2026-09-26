# 판정과 게이트

AX Navi의 코드 작업은 "수정 → 곧장 commit → 운영 사고" 사이클을 끊기 위해 여러 게이트를 거친다. 각 게이트는 근거 있는 판정값을 내고, 스킬은 그 값이 조건을 충족할 때만 다음 단계로 간다. 이 문서는 어떤 판정이 있는지, 값이 무엇을 뜻하는지, HOLD나 STOP이 나왔을 때 사용자가 무엇을 해야 하는지 정리한다.

## 게이트 한눈에

| 게이트 | 담당 | 판정값 | 쓰이는 곳 |
|------|------|------|------|
| 인덱스 신선도 | `build-index.mjs --check-stale` | exit 0 / 1 | 모든 작업 시작 |
| 어댑터 커버리지 | `check-adapter-coverage.mjs` | FULL/GO, PARTIAL/READ, UNSUPPORTED/HOLD | `safe-modify`, `scaffold-feature`, cross-repo |
| 변경 영향도 | `impact-analyzer` | 위험도 0~10, LOW/MEDIUM/HIGH/CRITICAL | `analyze-impact`, `safe-modify` |
| 패턴 적합성 | `pattern-conformance` | CONFORM / HOLD / FAIL | `safe-modify`, `scaffold-feature`, cross-repo |
| 실행 증거 | `verify-target.mjs run` | `overall` pass/fail, exit 0/2 | `safe-modify`, `scaffold-feature`, `vibe` |
| 변경 안전성 | `change-safety` | GO / HOLD / STOP | `safe-modify`, `scaffold-feature`, cross-repo |
| SQL 리뷰 | `sql-reviewer` | 위험도 0~10, GO/HOLD/STOP | `review-sql` |

`vibe`는 영향·독립 리뷰 에이전트를 생략하지만 패턴 선택과 최소 실행 검증은 유지한다.

## 변경 영향도 — impact-analyzer

수정 대상이 주어지면 인덱스를 질의해 직접 호출자, 간접 영향 노드, 외부 통신, 트랜잭션 경계, DB 스키마, 인증 경로, 환경 분기, 파트너 프로젝트 영향을 추적하고 점수를 낸다.

```text
기본 점수 1
+ 직접 호출자 수 × 0.2 (최대 +3)
+ 간접 영향 노드 수 × 0.05 (최대 +2)
+ 외부 통신 영향 +2, 트랜잭션 경계 영향 +1, DB 스키마 영향 +2
+ 인증/인가 경로 포함 +2, 환경 분기 포함 +1, 파트너 프로젝트 영향 +1
- 테스트 커버리지 비율 × 2
최종: min(10, 반올림)
```

| 점수 | 등급 | 권고 |
|------|------|------|
| 1~3 | LOW | 즉시 진행 가능 |
| 4~6 | MEDIUM | 영향 파일 단위 테스트 권고 |
| 7~8 | HIGH | 회귀 테스트 + 사전 코드 리뷰 필수 |
| 9~10 | CRITICAL | 외부 시스템 조율 + 단계별 배포 + 롤백 계획 필수 |

정적 분석 한계로 리플렉션·동적 바인딩·외부 트리거는 누락될 수 있으므로 결과에 +1~2를 고려하라는 문구가 리포트에 붙는다. `safe-modify`는 이 결과를 보여주고 진행 여부를 사용자에게 묻는다. CRITICAL이면 사전 회귀 테스트 작성(test-generator) 옵션을 권장한다. 리포트는 `_workspace/reports/impact_<slug>.md`에 남는다.

## 어댑터 커버리지 — PARTIAL·UNSUPPORTED일 때

변경 대상 파일마다 `check-adapter-coverage.mjs`를 먼저 실행한다. 결과는 `_meta.json`의 `adapter_coverage`에서 파생된다.

| 판정 | 동작 |
|------|------|
| `FULL/GO` | 다음 단계 진행 가능 |
| `PARTIAL/READ` | 인덱스만으로 확정하지 않는다. 에이전트가 대상과 연결된 설정·화면·스크립트·SQL 원문을 직접 읽어 확인한 뒤 진행한다. 읽은 파일은 `원문 확인` 목록으로 보고에 남는다. 사람에게 수동 검증을 요구하지 않는다 |
| `UNSUPPORTED/HOLD` | 내용을 읽을 수 없는 형식이다. 지원되는 어댑터를 추가하기 전 변경 금지 |

여러 파일이면 가장 낮은 커버리지가 전체 변경의 커버리지다. `_meta.json`이 없거나 손상돼 있으면 크래시 대신 `HOLD`(`index_meta_missing` 등)로 강등하고 재인덱싱을 안내한다. change-safety도 어댑터 판정 자체가 없으면 `UNVERIFIED/HOLD`로 본다. JSP·WebForms·Nexacro Form·DevExpress Designer처럼 PARTIAL인 스택에서도 원문 확인 목록과 검증 결과가 갖춰지면 GO가 나온다. 원문을 읽지 않았으면 HOLD다.

## 패턴 적합성 — CONFORM / HOLD / FAIL

`pattern-conformance`는 변경 코드가 일반적인 모범 사례가 아니라 이 프로젝트·모듈의 실제 작성 방식을 따르는지 검증한다. 선택된 `reference_files`를 먼저 읽고 변경 파일을 레이어별로 같은 레이어의 기준 파일과 비교한다.

| 판정 | 조건 | 안전성 판정에 미치는 영향 |
|------|------|------|
| `CONFORM` | 필수 규칙을 모두 따르고 설명 가능한 차이만 있다 | 컨벤션 점수 0~2 |
| `HOLD` | 가장 가까운 기준 파일과도 다른 방식(트랜잭션·예외·인증·공통 모듈 호출)을 근거 없이 도입, 또는 비교할 기준 파일이 없음 | 최소 5점, 최종 최소 HOLD |
| `FAIL` | 모듈·레이어 오선택, 필수 규칙 위반, 안티패턴 복제, 근거 없는 일반 프레임워크 코드 | 10점, 최종 STOP |
| 리포트 없음 | 검증을 하지 않았거나 변경 파일 일부가 빠졌다 | 7점, 최종 HOLD |

각 위반은 `변경 파일:라인 → 기준 파일:라인 → 위반 규칙`으로 남는다. 상세는 [패턴 프로필과 적합성 게이트](/concepts/pattern-profiles.md)를 참조한다.

## 실행 증거 — verify-target.mjs

"테스트가 없어서 통과"는 PASS가 아니다. 검증 명령을 무엇으로 할지 매번 LLM이 정하면 임기응변으로 흐르고 명령 출력 전체가 컨텍스트로 흘러들기 때문에 결정론적 감지·실행 도구를 쓴다.

```bash
node "$CLAUDE_PLUGIN_ROOT/agents/lib/verify-target.mjs" detect --root <프로젝트 루트> --target <변경 대상>
node "$CLAUDE_PLUGIN_ROOT/agents/lib/verify-target.mjs" run --root <프로젝트 루트> --cmd "npm test"
```

- `detect`는 `package.json` scripts, `pom.xml`, `build.gradle`, `.csproj`/`.sln` 등 매니페스트에서 lint/typecheck/test/build 후보를 읽기만 한다(부작용 0). 무엇을 돌릴지 사용자에게 먼저 보이기 위한 것이다.
- `run`은 감지된 명령을 실행하고 성공이면 요약만, 실패면 `fail_lines`(명령당 기본 15줄 상한, `truncated` 명시)만 돌려준다. `overall`이 `pass`면 exit 0, 아니면 exit 2다.
- `detected`가 비어 있으면(`count: 0`) 자동 검증이 없다는 뜻이다. PASS로 적지 않고 `검증 수단 없음`으로 적는다. 위험 변경이 아니면 원문 확인 근거로 진행한다. 바뀐 파일 종류를 검사하지 않는 명령(JSP·XML 변경에 Java 컴파일 등)과 도구가 설치되지 않아 실행되지 않는 명령도 `검증 수단 없음`이다. 이때 에이전트가 SQL 컬럼 순서 ↔ 화면 매핑 같은 정적 대조를 직접 하고, 배포 뒤에야 알 수 있는 것은 `배포 후 확인 권장`으로 따로 적는다(GO 조건 아님). 실행할 수 없거나 assertion까지 도달하지 못한 검사도 PASS가 아니다.

스킬은 `commands[].cmd`·`exit`·`fail_lines`와 `overall`을 그대로 change-safety 입력에 넘긴다. 필수 검증이 exit 0이 아니면 GO는 나올 수 없다.

## 변경 안전성 — GO / HOLD / STOP

`change-safety`는 commit·merge 전 마지막 게이트다. impact 리포트, pattern-conformance 판정, 실행 증거, 어댑터 커버리지를 받아 여섯 차원을 0~10으로 채점한다.

| 차원 | 보는 것 |
|------|------|
| 회귀 위험 | 변경 라인·파일 수, 영향받는 테스트 수, 커버리지 |
| 컨벤션 일치도 | pattern-conformance 판정을 점수로 반영(재판정하지 않음) |
| 사이드 이펙트 | 새 외부 통신·트랜잭션 경계·비동기·환경 분기·인증 우회 가능성 |
| 롤백 가능성 | 코드만인지, DB 스키마·외부 API·데이터 변환이 포함되는지 |
| 보안 영향 | 입력 직접 삽입, 인증 우회, 평문 비밀, 검증 누락, CORS/CSRF 약화 |
| 테스트 적정성 | 신규 테스트 추가 여부, 영향 테스트 PASS 여부(실행 결과 필수) |

종합 위험도는 `(회귀 + 컨벤션 + 사이드이펙트 + 롤백 + 보안 × 2 + 테스트) / 7`이며, 결정 로직과 하드 게이트는 다음과 같다. 정확한 점수 체계는 `agents/change-safety.md`에서 확인한다.

| 결정 | 조건 |
|------|------|
| `GO` | 종합 < 3, 보안 < 5, pattern-conformance CONFORM, 필수 검증 exit 0, 어댑터 FULL |
| `HOLD` | 종합 3~6, 또는 보안 5~7, 또는 pattern-conformance HOLD, 또는 있는 검증 명령 미실행(`UNVERIFIED`), 또는 어댑터 UNSUPPORTED, 또는 PARTIAL인데 원문 확인 없음, 또는 검증 수단이 없는 위험 변경(DB 스키마·트랜잭션·인증·공통 모듈) |
| `STOP` | 종합 > 6, 또는 보안 ≥ 8, 또는 pattern-conformance FAIL, 또는 필수 검증 실패, 또는 즉시 STOP 트리거 |

즉시 STOP 트리거는 평문 비밀번호·API 키 추가, SQL 인젝션 가능 패턴, 인증·인가 우회 코드, 데이터 손실 가능 변경(TRUNCATE·DROP·WHERE 없는 DELETE), 검증 없는 운영 전용 분기다. 한 항목이라도 발견되면 점수와 무관하게 STOP이다.

사용자 문장에서 감지한 모드가 가중치를 바꾼다. "운영 패치"는 보안 가중치를 두 배로, "긴급 핫픽스"는 작은 변경만 GO로, "레거시 손보기"는 컨벤션 가중치를 절반으로, "고객 데모 직전"은 외부 시스템 영향을 두 배로 본다. 리포트는 `_workspace/reports/safety_<slug>.md`에 남는다.

## SQL 리뷰 — 위험도 0~10과 세 갈래 결과

`sql-reviewer`는 SQL 텍스트·SQL ID·DDL·diff를 받아 사용처, 인덱스 활용, N+1, 인젝션, 트랜잭션, 락, 대량 처리, DDL 영향, 스키마 의존성, 성능을 검토한다. SQL을 실행하지 않고 실 DB에 접근하지 않는다.

| 가산 항목 | 점수 |
|------|------|
| SQL 인젝션 위험 | +5 |
| WHERE 없는 UPDATE/DELETE, DROP/TRUNCATE | +10 (즉시 STOP) |
| 트랜잭션 안 외부 통신 | +4 |
| N+1 확정 / 가능 | +3 / +1 |
| 인덱스 미사용 가능 | +2 |
| DDL 데이터 손실 가능 | +5 |
| 대량 처리(full scan) | +2 |
| 큰 테이블(1M+ rows) DDL | +3 |

0~3은 LOW(GO), 4~6은 MEDIUM(HOLD), 7~9는 HIGH(STOP, 재설계 권고), 10은 CRITICAL(즉시 STOP)이다.

리포트의 결과 절은 세 갈래로 나뉜다. 실 DB 없이 판정할 수 없는 것을 확정 사실처럼 쓰지 않기 위한 분리다.

| 절 | 담는 것 | 예 |
|------|------|------|
| 확정 발견 | 코드·인덱스에서 직접 읽혀 확정된 문제. 항목마다 근거 위치를 붙인다 | `${}` 직접 치환이 `OrderMapper.xml:88`에 있다 |
| 조건부 권고 | 실 DB의 실행 계획·인덱스 통계·데이터 분포를 봐야 결론이 나는 항목. 무엇을 확인해야 하는지 함께 적는다 | 인덱스를 안 탈 수 있다, EXPLAIN으로 확인 |
| 수정안 SQL | 결과 집합과 부수 효과가 바뀌지 않는다고 확신할 때만 작성한다. 확신이 없으면 "생략 — 사유" 한 줄만 남기고 조건부 권고로 돌린다 | 인덱스 leading column 순서에 맞춘 WHERE 재배열 |

"발견만" 요청이면 조건부 권고·수정안 절은 "요청에 따라 생략"으로 채운다. 리포트는 `_workspace/reports/sql_review_<slug>.md`에 남는다.

## 자동 수정은 하지 않는다

모든 판정 에이전트는 리포트만 쓰고 코드를 고치지 않는다. `change-safety`·`pattern-conformance`·`sql-reviewer`·`impact-analyzer`는 frontmatter의 `tools:`에서 `Edit` 계열을 제외해 구조적으로 소스를 건드릴 수 없다. HOLD나 STOP이 나와도 Claude가 알아서 우회 코드를 넣거나 판정을 낮추는 일은 없으며, 판정을 무시하는 방법은 의도적으로 제공하지 않는다. 판단은 항상 사람이 한다.

## HOLD가 나왔을 때 할 일

HOLD는 "진행 불가"가 아니라 "보완 후 재평가"다. 리포트의 보완 필요 항목이 우선순위 순으로 나열되므로 위에서부터 처리한다.

1. `_workspace/reports/safety_<slug>.md`에서 어느 차원의 점수가 높은지, 어떤 하드 게이트에 걸렸는지 확인한다.
2. `UNVERIFIED`면 `verify-target.mjs detect` 결과에서 명령을 골라 실제로 실행한다. 자동 검증이 없는 프로젝트면 `검증 수단 없음`으로 기록한다.
3. 어댑터 PARTIAL이면 대상과 연결 파일 원문을 읽고 `원문 확인` 목록을 첨부한다. UNSUPPORTED면 어댑터를 먼저 추가한다.
4. pattern-conformance HOLD면 리포트의 "필요한 조치"를 보고 의도적 차이인지 결정한다. 의도적이면 그 결정을 명시하고, 아니면 기준 파일에 맞춰 고친다.
5. 패턴 프로필이 없으면 이웃 파일을 기준으로 진행한다(`기준: 이웃 파일`). 더 정확한 기준이 필요하면 `"패턴 추출해줘"`로 프로필을 만든다.
6. 보완 후 `"이 변경 다시 평가해줘"`로 change-safety를 재실행한다.

## STOP이 나왔을 때 할 일

STOP은 현재 방식으로는 진행하지 않는다는 뜻이다. 리포트의 사유와 대안(다른 접근, 단계적 분할, 사전 작업)을 읽고 변경을 철회하거나 재설계한다. 즉시 STOP 트리거(평문 비밀, 인젝션 패턴, WHERE 없는 DELETE 등)는 코드를 고치는 것 외에 통과 방법이 없다. STOP 판정을 우회하는 옵션은 제공되지 않으므로 대안을 논의하는 것이 다음 단계다.

## 관련 문서

- [safe-modify](/skills/safe-modify.md)
- [review-sql](/skills/review-sql.md)
- [analyze-impact](/skills/analyze-impact.md)
- [패턴 프로필과 적합성 게이트](/concepts/pattern-profiles.md)
- [에이전트 목록](/agents/README.md)
