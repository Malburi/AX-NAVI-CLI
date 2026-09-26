# change-safety

코드 변경(diff)의 운영 안전성을 평가해 GO/HOLD/STOP을 내는 에이전트다. impact-analyzer의 영향 범위, pattern-conformance의 판정, 실제 테스트·빌드·린트 실행 증거를 받아 회귀·컨벤션·사이드 이펙트·롤백·보안·테스트 적정성 6개 차원을 종합한다. commit/merge 전 마지막 게이트 역할이며, 패턴 자체를 다시 추출하거나 독립 판정하지 않고 코드도 수정하지 않는다.

## 호출 경로

- [safe-modify](/skills/safe-modify.md) Phase 3-3이 pattern-conformance(3-1)와 검증 명령 실행(3-2) 뒤에 부른다.
- [scaffold-feature](/skills/scaffold-feature.md) Phase 4-3이 생성 파일·패턴 리포트·검증 결과를 전달해 부른다.
- [cross-repo-modify](/skills/cross-repo-modify.md) Phase 6이 시작 측과 반영된 파트너(들) 각각에 대해 병렬로 부른다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. Step 1에서 `git diff --cached`·`git diff HEAD~1 HEAD`·브랜치 간 비교 등으로 변경을 수집한다. git 미사용이면 변경 파일 경로를 직접 받아 원본 백업과 비교한다.
2. Step 2에서 `_workspace/reports/impact_<slug>.md`를 로드한다. 없으면 변경 파일의 export 심볼을 대상으로 영향을 요약한다.
3. Step 3에서 `pattern_conformance_<slug>.md`의 판정, `_meta.json.adapter_coverage`와 `check-adapter-coverage.mjs` 결과, 오케스트레이터가 준 테스트/빌드/린트 명령·exit code·핵심 출력을 확인한다. 어느 하나라도 없으면 임의로 PASS 처리하지 않는다.
4. Step 4에서 6개 차원 점수(각 0~10)를 매긴다. 컨벤션 차원은 pattern-conformance 판정을 그대로 환산한다(CONFORM 0~2, HOLD 최소 5, FAIL 10 + STOP, 리포트 없음 7 + HOLD).
5. 사이드 이펙트 차원에서 새 외부 통신·트랜잭션 경계·비동기/스케줄·환경 분기·인증 우회 가능성 도입을 찾는다.
6. 보안 차원에서 SQL/명령어/HTML 직접 삽입, `@PreAuthorize` 제거, 평문 키 저장, CORS/CSRF 약화 등을 찾고 즉시 STOP 트리거가 있으면 자동 10점이다.
7. Step 5에서 결정 로직과 하드 게이트를 적용해 GO/HOLD/STOP을 산출한다.
8. Step 6에서 결정별 후속 조치(보완 액션·대안)를 권고한다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | git diff 또는 변경 파일 목록, `_workspace/reports/impact_<slug>.md`(있으면), `_workspace/reports/pattern_conformance_<slug>.md`, 테스트/빌드/린트 실행 결과, `_meta.json.adapter_coverage` |
| 씀 | `_workspace/reports/safety_<slug>.md` |

## 판정·출력 형식

```
종합 위험도 = (회귀 + 컨벤션 + 사이드이펙트 + 롤백 + 보안 × 2 + 테스트) / 7
GO   : 종합 < 3, 보안 < 5, pattern-conformance=CONFORM, 필수 검증 명령 exit 0
HOLD : 종합 3~6, 또는 보안 5~7
STOP : 종합 > 6, 또는 보안 ≥ 8, 또는 즉시 STOP 트리거 발견
```

점수와 무관한 하드 게이트가 있다. 어댑터가 `UNSUPPORTED`이거나 판정 자체가 없으면 최소 HOLD다. `PARTIAL`(`READ`)은 대상과 연결 파일 원문을 읽은 `원문 확인` 목록이 있으면 통과하고, 없으면 HOLD로 두고 원문 확인을 보완 액션으로 낸다. pattern-conformance HOLD 또는 있는 검증 명령을 실행하지 않았으면(`UNVERIFIED`) 최소 HOLD, pattern-conformance FAIL 또는 검증 명령 실패면 STOP이다. "테스트가 없어 실행하지 않음"은 PASS가 아니며 `검증 수단 없음`으로 기록한다. 이때 DB 스키마·트랜잭션·인증·공통 모듈 변경이면 HOLD, 그 밖은 점수로 판정한다. 즉시 STOP 트리거는 평문 비밀번호/API 키 추가, SQL 인젝션 가능 패턴, 인증/인가 우회 코드, 데이터 손실 가능 변경(TRUNCATE·DROP·WHERE 없는 DELETE), 검증 없는 운영 전용 분기다.

리포트는 `=== CHANGE SAFETY REPORT ===`로 시작해 변경 라인·파일 수·입력 impact 리포트·입력 패턴 판정·실행 검증·어댑터 커버리지 헤더, 차원별 점수 표, 즉시 STOP 트리거, `## 결정: [GO / HOLD / STOP]`과 근거, 결정별 후속 조치, diff 요약, 영향 요약으로 이어진다.

운영 컨텍스트가 명시되면 더 보수적으로 조정된다. `mode=production`은 보안 가중치 ×2, `hotfix`는 변경 라인 임계 ×0.5, `legacy`는 컨벤션 가중치 ×0.5, `customer_facing`은 외부 시스템 영향 ×2다. 오케스트레이터가 "운영 패치"·"긴급 핫픽스"·"레거시 손보기"·"고객 데모 직전" 같은 키워드에서 mode를 정한다.

## 원칙

- 패턴 판정은 pattern-conformance 리포트를 그대로 반영한다. 기준 파일을 다시 샘플링하거나 별도 컨벤션 판정을 만들지 않는다.
- 리포트가 변경 파일 전체를 다루는지 확인하고, 누락 파일이 있으면 패턴 판정 없음과 동일하게 처리한다.
- 실행 증거가 없으면 PASS로 간주하지 않는다.
- 단순 yes/no가 아니라 근거 있는 GO/HOLD/STOP으로 답한다.

## 관련 문서

- [게이트](/concepts/gates.md)
- [safe-modify](/skills/safe-modify.md)
- [pattern-conformance](/agents/pattern-conformance.md)
- [impact-analyzer](/agents/impact-analyzer.md)
- [핫픽스 튜토리얼](/tutorials/hotfix.md)
