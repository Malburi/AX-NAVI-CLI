# 패턴 프로필과 적합성 게이트

AX Navi의 패턴 기능은 코딩 컨벤션을 문서로만 남기지 않는다. 프로젝트의 모듈·레이어·기술 세대별로 실제 기준 파일을 지정하고, 신규 작성과 기존 코드 수정이 그 기준을 따르는지 스크립트와 에이전트가 검증한다. 이 문서는 구조화 패턴 프로필이 어떤 문제를 풀고, 무엇을 만들며, 코드 작업에서 어떻게 게이트로 동작하는지 사용자 관점에서 설명한다.

## 해결하려는 문제

ITO 프로젝트에는 같은 저장소 안에 현재 표준, 유지 중인 레거시, 더 이상 복제하면 안 되는 안티패턴이 함께 존재한다. 단순 다수결로 패턴을 뽑으면 오래된 코드가 많다는 이유만으로 레거시 방식이 신규 코드의 표준이 된다. 예를 들어 필드 주입 코드가 200개, 생성자 주입 코드가 30개인 모듈에서 "많이 보이는 쪽"을 따르면 새 코드가 다시 필드 주입으로 작성된다.

구조화 프로필은 이 셋을 상태로 분리한다.

| 상태 | 의미 | 신규 코드 적용 |
|------|------|------|
| `preferred` | 현재 모듈에서 따라야 할 기준 | 적용한다 |
| `legacy` | 기존 유지보수 시 이해해야 하는 과거 방식 | 신규 코드에는 적용하지 않는다. 기존 레거시 파일을 최소 수정할 때만 참고한다 |
| `anti_pattern` | 보안·성능·유지보수상 피해야 하는 방식 | 빈도가 높아도 복제하지 않는다 |

## 생성 산출물

`harness-init`의 pattern-extractor(Phase 2-3)가 두 종류의 산출물을 함께 만든다.

| 파일 | 대상 | 내용 |
|------|------|------|
| `.claude/patterns/*.md` | 사람 | 레이어별 상세 패턴, 빈도, 예시, 안티패턴. 스켈레톤 헤더는 `skills_builder.py`가 조립하고 본문은 pattern-extractor가 채운다 |
| `.claude/patterns/pattern_profile.json` | 도구 | 검증·선택에 쓰는 프로필. 범위(scope), 실제 기준 파일(reference_files), 규칙(rules) |

프로필 한 항목은 다음처럼 생긴다.

```json
{
  "id": "education-service-current",
  "status": "preferred",
  "confidence": "HIGH",
  "samples_analyzed": 8,
  "scope": {
    "module": "education",
    "layer": "service",
    "stack": "Spring",
    "path_prefixes": ["src/main/java/com/example/education"]
  },
  "reference_files": [
    {
      "path": "src/main/java/com/example/education/EducationApplyService.java",
      "reason": "동일 모듈의 현재 대표 구현"
    }
  ],
  "rules": {
    "dependency_injection": "constructor",
    "transaction_location": "service",
    "exception_type": "BizException"
  }
}
```

`scope`는 이 프로필이 적용되는 범위다. 같은 저장소라도 `education` 모듈의 service 레이어와 `payment` 모듈의 service 레이어가 다른 프로필을 가질 수 있다. `confidence`는 표본 수와 일관성에서 나온 신뢰도(`HIGH`·`MEDIUM`·`LOW`)다.

## 근거 파일(reference_files)이 강제되는 이유

프로필의 `rules`는 "생성자 주입을 쓴다"처럼 요약된 문장이다. 요약만 있으면 두 가지가 무너진다. 첫째, 검증기가 규칙이 실제 코드와 일치하는지 확인할 방법이 없어 LLM이 임의로 만든 규칙이 그대로 표준이 된다. 둘째, 코드를 생성하는 쪽이 규칙을 해석해 일반적인 프레임워크 코드를 쓰게 되어 이 프로젝트 고유의 방식(예외 타입, 응답 래퍼, 로깅 위치)이 빠진다.

그래서 프로필은 실제 기준 파일을 반드시 가리켜야 한다.

- `pattern_profile.py validate`는 프로젝트 밖 경로나 존재하지 않는 기준 파일을 실패로 처리한다.
- `scaffold-feature`와 `safe-modify`는 코드를 쓰기 전에 선택된 프로필의 `reference_files`를 실제로 읽는다. 규칙을 외워서 쓰는 것이 아니라 기준 파일을 보고 따른다.
- pattern-conformance는 기준 파일을 먼저 읽어 프로필의 `rules`가 근거 코드와 일치하는지 확인한 뒤에 변경 코드를 비교한다. 위반은 `변경 파일:라인 → 기준 파일:라인 → 위반 규칙` 형식으로 남는다.
- Markdown 패턴 설명과 구조화 프로필이 충돌하면 실제 근거 파일을 확인하고 HOLD로 올린다.

근거 파일이 있어야 "왜 이렇게 써야 하는가"에 프로젝트의 실제 코드로 답할 수 있다.

## 검증 — pattern_profile.py validate

프로필은 생성 직후(`harness-init` 2-3.5 `verify` 블록)와 코드 작업 시작 시(`safe-modify` Phase 0 등) 검증한다.

```bash
python "$CLAUDE_PLUGIN_ROOT/agents/lib/pattern_profile.py" validate --root <프로젝트 루트>
```

검증기는 다음을 실패로 처리한다.

- 중복 ID.
- 잘못된 상태(`preferred`·`legacy`·`anti_pattern` 외) 또는 잘못된 신뢰도.
- 프로젝트 밖을 가리키는 경로.
- 존재하지 않는 기준 파일.
- 규칙이 비어 있는 `preferred` 프로필.

결과는 `_workspace/pattern_profile_validation.json`에 기록되고 harness-init Phase 3 보고의 "구조화 프로필 검증: PASS / FAIL (preferred N개, 실제 기준 파일 N개)" 줄에 반영된다.

## 선택 — pattern_profile.py select

코드를 쓰기 전에 대상 경로·모듈·레이어를 넣어 가장 가까운 `preferred` 프로필을 고른다.

```bash
python "$CLAUDE_PLUGIN_ROOT/agents/lib/pattern_profile.py" select \
  --root <프로젝트 루트> \
  --target src/main/java/com/example/education \
  --module education \
  --layer service
```

경로 일치가 가장 큰 가중치를 가지며 이어서 모듈·레이어·신뢰도를 반영한다. 결과는 `_workspace/reports/pattern_selection.json`에 남고, 이후 코드 작성과 pattern-conformance가 같은 파일을 읽는다. 선택 결과가 기록으로 남기 때문에 "어느 기준을 따랐는가"를 나중에 추적할 수 있다.

## 코드 작업 게이트

`safe-modify`·`scaffold-feature`·`cross-repo-modify`·`cross-repo-scaffold`는 같은 흐름을 사용한다.

```mermaid
flowchart LR
    A["프로필 검증"] --> B["대상별 패턴 선택"]
    B --> C["실제 기준 파일 확인"]
    C --> D["코드 작성·수정"]
    D --> E["패턴 적합성 판정"]
    E --> F["테스트·빌드·린트"]
    F --> G["안전성 판정"]
    G --> H["인덱스·wiki 갱신"]
```

패턴 적합성 판정은 `pattern-conformance` 에이전트가 담당한다. 변경 diff, `pattern_selection.json`, 선택된 `reference_files`, 관련 `.claude/patterns/*.md`를 교차 비교해 파일 위치·명명·구조와 의존성 방향·예외·로깅·트랜잭션·테스트 작성 방식을 각각 판정한다.

| 판정 | 조건 | 이후 동작 |
|------|------|------|
| `CONFORM` | 적용 가능한 필수 규칙을 모두 따르고 기준 파일과 설명 가능한 차이만 있다 | 다음 게이트로 진행 |
| `HOLD` | 패턴 충돌, `LOW` 신뢰도, 표본 부족, 사용자 결정이 필요한 의도적 차이 | 사용자 결정 전 GO로 진행하지 않는다 |
| `FAIL` | 모듈·레이어를 잘못 선택했거나 필수 규칙 위반, 안티패턴 복제, 근거 없는 일반 프레임워크 코드 사용 | 수정 후 재검증, 안전성 판정은 STOP |

점수만으로 판정하지 않고 각 위반에 근거 위치를 남긴다. 패턴끼리 충돌하거나 표본이 부족하면 임의로 하나를 고르지 않고 HOLD로 판정한다. 프로젝트 전체에서 많이 보인다는 이유로 현재 모듈의 기준을 덮어쓰지 않는다.

최종 GO에는 다음 증거가 모두 필요하다.

- pattern-conformance가 `CONFORM`.
- 프로젝트의 필수 테스트·빌드·린트 명령이 exit 0.
- change-safety가 `GO`.

검증을 실행하지 못한 상태는 `UNVERIFIED`이며 최소 HOLD다. 패턴 적합성 FAIL 또는 필수 검증 실패는 STOP이다. 판정 체계 전체는 [판정과 게이트](/concepts/gates.md)에서 다룬다.

## 프로필이 없을 때

`pattern_profile.json`이 없으면 `safe-modify`는 Markdown 패턴과 동일 모듈의 유사 코드로 폴백할 수 있지만 리포트에 `구조화 패턴 미검증`을 표시하고 자동 GO를 내지 않는다. 진행하려면 "패턴 근거가 없는 상태로 적용할까요?"에 사용자가 명시적으로 답해야 한다. 신규 파일 생성이 포함된 변경은 폴백하지 않고 pattern-extractor를 먼저 실행한다.

프로필을 만들거나 다시 뽑으려면 다음 문장을 쓴다.

| 상황 | 요청 |
|------|------|
| 패턴이 아직 없다 | `"패턴 추출해줘"` |
| 하네스는 있는데 패턴만 다시 뽑고 싶다 | `"패턴만 다시"` (부분 재실행, 나머지 산출물은 재사용) |
| 코드가 크게 바뀌었다 | `"하네스 업데이트해줘"` |

## wiki 반영

`generate-wiki`가 만드는 `patterns.md`는 구조화 프로필을 먼저 표로 보여준다. 각 프로필의 상태, 모듈·레이어, 신뢰도, 실제 기준 파일을 확인한 뒤 같은 페이지에서 상세 Markdown 패턴을 볼 수 있다. wiki가 코드 이해 문서이면서 신규 작업의 컨벤션 근거 역할도 하게 되고, 인수인계 때 "이 모듈은 어떤 방식으로 써야 하는가"를 코드 예시와 함께 넘길 수 있다.

## 관련 문서

- [scaffold-feature](/skills/scaffold-feature.md)
- [safe-modify](/skills/safe-modify.md)
- [판정과 게이트](/concepts/gates.md)
- [하네스가 만드는 것](/concepts/harness-outputs.md)
- [에이전트 목록](/agents/README.md)
