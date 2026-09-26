# pattern-conformance

신규·수정 코드가 일반적인 모범 사례가 아니라 해당 프로젝트·모듈의 실제 작성 방식을 따르는지 독립 검증하는 에이전트다. `pattern_profile.json`의 선택 결과, Markdown 패턴 문서, 실제 기준 파일(`reference_files`)과 변경 diff를 교차 비교해 CONFORM/HOLD/FAIL과 근거를 기록한다. 검토와 리포트만 하며 코드와 패턴 파일을 수정하지 않는다.

## 호출 경로

- [safe-modify](/skills/safe-modify.md) Phase 3-1 "패턴 적합성 검증"이 부른다.
- [scaffold-feature](/skills/scaffold-feature.md) Phase 4-1 "패턴 적합성 독립 검증"이 부른다.
- frontmatter description에 따르면 cross-repo 작업의 사후 패턴 게이트에서도 쓰인다. change-safety가 이 판정을 입력으로 받는다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. `_workspace/reports/pattern_selection.json`에서 선택 근거와 프로필 범위를 확인한다.
2. 선택된 `reference_files`를 실제로 읽고 프로필의 `rules`가 근거 코드와 일치하는지 먼저 확인한다.
3. 변경 파일을 레이어별로 나눠 같은 레이어의 기준 파일과 비교한다.
4. 파일 위치와 패키지·모듈 경계를 판정한다.
5. 클래스·함수·SQL ID·DTO 필드 명명을 판정한다.
6. Controller·Service·DAO·화면의 구조와 의존성 방향, 입력 검증·응답·예외·로깅·트랜잭션 처리, import·주석·포맷·테스트 작성 방식을 판정한다.
7. 프로필의 `legacy`·`anti_pattern`을 신규 코드가 복제했는지 확인한다.
8. 패턴끼리 충돌하거나 근거 표본이 부족하면 임의로 하나를 고르지 않고 HOLD로 판정한다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 변경 파일·diff, `_workspace/reports/pattern_selection.json`, `.claude/patterns/pattern_profile.json`, 선택된 `reference_files`, 관련 `.claude/patterns/*.md` |
| 씀 | `_workspace/reports/pattern_conformance_<slug>.md` |

## 판정·출력 형식

| 판정 | 조건 |
|------|------|
| CONFORM | 적용 가능한 필수 규칙을 모두 따르고 기준 파일과 설명 가능한 차이만 있음 |
| HOLD | 가장 가까운 기준 파일과도 다른 방식(트랜잭션·예외·인증·공통 모듈 호출)을 근거 없이 도입, 또는 비교할 기준 파일이 없음. 패턴 충돌·표본 부족은 HOLD가 아니라 가장 가까운 실제 파일(대상 자신 → 같은 폴더 → 같은 모듈)로 판정한다 |
| FAIL | 모듈/레이어를 잘못 선택했거나 필수 규칙 위반·안티패턴 복제·근거 없는 일반 프레임워크 코드 사용 |

점수만으로 판정하지 않는다. 각 위반은 `변경 파일:라인 → 기준 파일:라인 → 위반 규칙` 형식으로 근거를 남긴다.

```
=== PATTERN CONFORMANCE REPORT ===
변경 대상 · 선택 프로필 · 기준 파일
## 레이어별 결과 (레이어 | 프로필 | 판정 | 근거)
## 차이 (변경 위치 | 기준 위치 | 규칙 | 심각도 | 설명)
## 안티패턴 복제 확인
## 판정: [CONFORM / HOLD / FAIL]
## 필요한 조치
=== END REPORT ===
```

change-safety는 이 판정을 컨벤션 점수로 환산한다. CONFORM은 0~2점, HOLD는 최소 5점, FAIL은 10점과 최종 STOP, 리포트 없음은 7점과 최종 HOLD다.

## 원칙

- 프로젝트 전체에서 많이 보인다는 이유로 현재 모듈의 기준을 덮어쓰지 않는다.
- `legacy`는 기존 레거시 파일을 최소 수정할 때만 참고하며 신규 파일의 기본값으로 쓰지 않는다.
- `anti_pattern`은 빈도가 높아도 복제하지 않는다.
- Markdown 설명과 구조화 프로필이 충돌하면 실제 근거 파일을 확인하고 HOLD로 올린다.
- 검증하지 못한 항목을 일치로 간주하지 않는다.

## 관련 문서

- [패턴 프로필](/concepts/pattern-profiles.md)
- [게이트](/concepts/gates.md)
- [pattern-extractor](/agents/pattern-extractor.md)
- [change-safety](/agents/change-safety.md)
- [scaffold-feature](/skills/scaffold-feature.md)
