# pattern-extractor

프로젝트 코드에서 모듈·레이어별 컨벤션(네이밍·구조·예외 처리·로깅·트랜잭션·검증 등)을 실제 샘플 기반으로 추출해 `.claude/patterns/*.md` 본문과 기계 검증용 `pattern_profile.json`을 만드는 에이전트다. "기존 코드와 같은 스타일"을 추측이 아닌 출현 빈도라는 통계적 근거로 정의하고, 같은 저장소 안의 현재 권장(`preferred`)·레거시(`legacy`)·안티패턴(`anti_pattern`)을 분리한다. 패턴 추출·문서화만 하며 실제 코드를 수정하지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 2-3이 부른다. `skills_builder.py`가 Phase 2-2.3에서 만든 패턴 스켈레톤을 입력으로 받으며, 분리 저장소에서는 레인 간 병렬 실행이 가능하다.
- 결과는 [scaffold-feature](/skills/scaffold-feature.md)·[safe-modify](/skills/safe-modify.md)·[pattern-conformance](/agents/pattern-conformance.md)·[test-generator](/agents/test-generator.md)가 소비한다.
- frontmatter `model`은 `sonnet`, `tools`는 지정하지 않는다. 작업 범위는 "패턴 추출·문서화만, 실제 코드 수정·삭제 금지"다.

## 하는 일

1. Step 1에서 `.claude/patterns/` 하위 스켈레톤을 모두 읽어 "추출 대상" 섹션의 작업 목록을 확보한다.
2. Step 2에서 레이어당 최소 5개·최대 20개 샘플을 모으되 개수보다 크기를 먼저 본다. 레이어당 총 256KB, 개별 128KB 이내로 제한하고 예산이 모자라면 파일 수 대신 파일당 읽는 범위를 줄인다. `_analysis_input.json`의 `evidence.representative_files`에서 출발하면 예산 계산을 반복하지 않아도 된다.
3. 저장소를 한 덩어리로 집계하지 않고 모듈·워크스페이스·기술 세대별로 군집화한 뒤, 군집마다 실제 호출되고 데드 코드가 아닌 대표 파일 1~3개를 `reference_files`로 고른다.
4. Step 3에서 항목별 출현 빈도를 재고 가장 높은 것을 표준으로 삼는다. 80% 미만이면 주요·부 패턴을 함께, 50% 미만이면 "일관되지 않음"을 기록한다.
5. Step 4에서 보안 위험·성능 문제·유지보수 어려움을 안티패턴으로 표시한다. 빈도가 높아도 `preferred`로 승격하지 않는다.
6. Step 5에서 패턴 파일마다 권장 패턴(빈도·근거 샘플 `파일:라인`)·안티패턴·신규 코드 작성 가이드·부 패턴 절을 채운다.
7. Step 6에서 `pattern_profile.json`을 만들고 `pattern_profile.py validate`를 실행한다. 실패하면 1회 수정 후 재검증하고, 두 번째도 실패하면 미검증 상태를 명시해 "신규 스캐폴딩 사용 가능"으로 보고하지 않는다.
8. Step 7에서 `pattern_tally.py`로 집계 표(`05b_pattern_tally.md`)를 기계 생성하고 그대로 `05_patterns_extracted.md`에 삽입한 뒤 "## 권고" 문단만 직접 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `.claude/patterns/*.md`(스켈레톤), `_workspace/01_analyzer_report.md`, `_workspace/index/*.json`, `_workspace/index/_analysis_input.json`, `client_index.json`(LegacyStaticJS일 때) |
| 씀 | `.claude/patterns/*.md` 본문, `.claude/patterns/pattern_profile.json`, `_workspace/05_patterns_extracted.md`, `_workspace/05b_pattern_tally.md`(스크립트가 생성) |

## 판정·출력 형식

패턴 파일 헤더는 `추출 시각`·`샘플 파일 수`·`신뢰도 HIGH/MEDIUM/LOW`(빈도 일관성 기준)를 적는다. 프로필 JSON의 핵심 계약은 다음과 같다.

```json
{
  "version": 1,
  "profiles": [{
    "id": "education-service-current",
    "status": "preferred",
    "confidence": "HIGH",
    "samples_analyzed": 8,
    "scope": {"module": "education", "layer": "service", "stack": "Spring", "path_prefixes": ["..."]},
    "reference_files": [{"path": "...", "reason": "동일 모듈의 현재 대표 구현"}],
    "rules": {"dependency_injection": "constructor", "transaction_location": "service"}
  }],
  "conflicts": []
}
```

`preferred` 프로필은 실제 존재하는 `reference_files`와 비어 있지 않은 `rules`가 필수다. 충돌하는 패턴은 한쪽을 고르지 않고 `conflicts`에 범위와 선택 필요 이유를 남긴다. 코드 원문은 JSON에 복사하지 않는다.

## 원칙

- 추출과 강요를 구분한다. 추출된 패턴은 "가장 빈도 높은 패턴"이지 "이상적인 패턴"이 아니며, 통계적 사실과 권장/비권장 판단을 분리해 표기한다.
- 빈도 일관성이 낮을 때 HIGH라고 표기하지 않는다. 신규 개발자가 잘못된 패턴을 따르게 만들지 않기 위함이다.
- 데드 코드 후보나 마이그레이션 대상 모듈은 샘플에서 제외하거나 별도 표시한다. 사라질 코드의 패턴을 신규 코드에 강요하지 않는다.
- Client JS 레이어는 analyzer 리포트에 "LegacyStaticJS" 분류가 있을 때만 실행하고 Modern SPA에서는 스킵한다.

## 관련 문서

- [패턴 프로필](/concepts/pattern-profiles.md)
- [harness-init](/skills/harness-init.md)
- [pattern-conformance](/agents/pattern-conformance.md)
- [scaffold-feature](/skills/scaffold-feature.md)
- [writer](/agents/writer.md)
