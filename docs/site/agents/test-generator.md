# test-generator

변경되었거나 영향받는 코드에 대해 회귀를 잡는 테스트 골격을 생성하는 에이전트다. 구조화 패턴 프로필과 실제 테스트 기준 파일을 그대로 따라 프로젝트 스타일에 맞는 테스트를 만들고, impact-analyzer의 영향 목록으로 누락 케이스를 식별한다. 테스트 골격 생성과 문서화만 하며 실제 코드(non-test)는 수정하지 않는다. 자동 생성된 테스트는 시작점이지 완성이 아니라는 점을 TODO 주석으로 정직하게 표시한다.

## 호출 경로

- [scaffold-feature](/skills/scaffold-feature.md) Phase 3-5 "Test 레이어"가 부른다.
- [safe-modify](/skills/safe-modify.md) Phase 1이 CRITICAL일 때의 선택지 2("사전 회귀 테스트 작성 후 진행")와 GO 이후 "자동 후속"에서 사용자가 명시적으로 요청할 때 부른다. 기본은 OFF다.
- [plan-migration](/skills/plan-migration.md)은 구현 단계의 후속 작업으로 사용을 권고한다.
- frontmatter `model`은 `sonnet`, `tools`는 지정하지 않는다. 작업 범위는 "테스트 골격 생성·문서화, 실제 코드(non-test) 수정 금지"다.

## 하는 일

1. Step 1에서 `pattern_profile.py validate` 후 대상 모듈·test 레이어 프로필을 선택하고, 선택된 `reference_files`와 `.claude/patterns/test_pattern.md`를 읽는다. 기존 테스트가 전혀 없으면 빌드 파일(pom.xml·build.gradle·package.json·pyproject.toml 등)에 이미 선언된 테스트 의존성을 기준으로 삼는다. 그것도 없으면 임의 프레임워크를 들이지 않고 생성하지 않으며 `검증 수단 없음 — 테스트 기준 없음`으로 보고한다. 사용자에게 고르게 하지 않는다.
2. Step 2에서 대상 파일/함수의 시그니처·의존성·예외를 분석하고 impact 리포트가 있으면 영향 범위를 활용한다.
3. Step 3에서 우선순위에 따라 케이스 목록을 만들고 각 케이스에 필요한 이유를 한 줄로 단다. Happy path(최소 1개) → 경계값 → 에러 → 권한/인가 → 트랜잭션 롤백 → 외부 통신 실패(mock) 순이다.
4. 영향도 점수가 높을수록 더 많은 케이스를 만든다(LOW 1~2개, HIGH 5~10개).
5. Step 4에서 스택별 표준 위치에 파일을 쓴다. Java는 `src/test/java/`, Python은 `tests/`, Node는 `__tests__/` 또는 `*.test.ts`, .NET은 기존 `*.Tests` 프로젝트다. 기존 테스트 파일은 덮어쓰지 않고 새 파일 또는 새 메서드만 추가한다.
6. WinForms/DevExpress는 UI에서 분리된 application service만 단위 테스트하고, Nexacro는 기존 테스트 도구가 없으면 임의 프레임워크를 만들지 않고 Dataset 입력·transaction callback·오류코드 시나리오를 회귀 절차로 출력하며 `검증 수단 없음`으로 표시한다.
7. Step 5에서 생성 테스트가 빌드되는지 lint/compile로 확인하고 실패하면 import/설정 누락을 보고한다.
8. `_workspace/reports/tests_<slug>.md`에 요약을 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 대상 코드, `_workspace/reports/impact_<slug>.md`(있으면), `.claude/patterns/pattern_profile.json`, `.claude/patterns/test_pattern.md`, 기존 테스트 파일 |
| 씀 | 테스트 파일들(스택별 표준 위치), `_workspace/reports/tests_<slug>.md` |

## 판정·출력 형식

각 테스트에는 다음 주석을 포함한다.

```java
// TODO: assertion 보완 — 비즈니스 규칙에 맞는 정확한 결과 검증 필요
// TODO: 픽스처 데이터를 실제 사용 패턴에 맞게 조정
```

요약 리포트는 `=== TEST GENERATION SUMMARY ===`로 시작해 대상, 영향 점수(impact 리포트 있으면), 생성 파일과 케이스 수, 케이스 분포(Happy path·경계값·에러·권한·트랜잭션·외부 통신 실패), TODO 항목(수동 보완 필요), 권고(실행 명령, 통과 확인 후 commit, 실패 시 assertion 보완)로 구성된다.

## 원칙

- 기존 테스트 컨벤션 100% 준수. 테스트 클래스 명명·assertion 라이브러리·픽스처·mocking 라이브러리를 기존 그대로 쓰고 새 컨벤션을 도입하지 않는다.
- DB·외부 시스템 연결 테스트는 mock으로 만든다. 실제 연결 테스트는 사용자가 별도 환경에서 한다.
- 생성된 테스트가 항상 PASS하도록 설계하지 않는다. 비즈니스 규칙을 알 수 없는 부분은 TODO로 남긴다.
- 기존 테스트와 중복되는 케이스는 만들지 않는다(기존 파일 먼저 grep).

## 관련 문서

- [scaffold-feature](/skills/scaffold-feature.md)
- [safe-modify](/skills/safe-modify.md)
- [패턴 프로필](/concepts/pattern-profiles.md)
- [impact-analyzer](/agents/impact-analyzer.md)
- [신규 기능 튜토리얼](/tutorials/new-feature.md)
