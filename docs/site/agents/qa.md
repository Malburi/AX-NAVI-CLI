# qa

생성된 하네스의 경계면을 교차 비교하는 에이전트다. writer의 주장(스킬 패턴·컨벤션)이 실제 코드와 인덱스에 일치하는지 양방향 Set 연산으로 검증해 누락(MISSING)·고아(ORPHAN)·죽은(DEAD) 항목을 찾는다. validator의 구조 검사나 harness-evaluator의 표본 품질 평가와 달리 "양쪽이 일치하는가"를 본다. 검증과 리포트만 하며 자동 수정은 하지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 3.6 "선택 작업 안내"에서 사용자가 `경계 QA`를 고르면 Phase 3.7에서 온디맨드로 실행된다. 자동 후속 실행이 아니다.
- validator 신뢰도가 50 미만이면 사용자가 선택해도 "구조 검증 실패로 QA 미실행" 한 줄로 끝난다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다.

## 하는 일

1. Step 1에서 `_workspace/01_analyzer_report.md`를 읽고 검출 스택을 확인한다.
2. Step 2에서 스택별 boundary 4개를 정의한다. Java EE/Struts, Spring Boot, Express/Nest, FastAPI, Next.js, Vue 2/3, React, ASP.NET Core, WinForms, Nexacro 등 변형 표가 있다.
3. Step 3에서 `03_validator_report.md`의 신뢰도가 50 미만이면 스킵한다.
4. Boundary 1~4를 스택별로 실행한다. Struts 예시는 Struts XML ↔ Service ↔ Bean, Service ↔ Query XML(SQL ID 양방향), 스킬 주장 ↔ 실제 코드 샘플, JSP forward ↔ 실제 JSP 파일이다.
5. Boundary 5(인덱스 vs 코드)는 `validator_mechanical.json`의 check 7b 결과를 재사용하고 실패 좌표의 경계 shape만 확인한다. 7b가 없을 때만 정렬 후 균등 간격으로 최대 10개 엣지를 표본화한다. 무작위 표본은 금지다.
6. Boundary 6(워크플로우 스킬 ↔ 인덱스 의존성)은 `qa_boundary6.py`를 qa가 직접 실행하고 결과를 삽입한다. 이전 실행의 `_workspace/qa_boundary6.md`가 있으면 재실행하지 않는다.
7. analyzer 리포트에 "LegacyStaticJS" 분류가 있으면 Boundary 7(Client JS 커버리지)을 이어서 실행한다. `client_pattern.md` 부재는 FAIL, `client_index.json` 부재는 WARN이다.
8. boundary별 결과를 `_workspace/04_qa_report.md`에 append하고(early termination 없음), 종합 권고를 우선순위별로 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `_workspace/01_analyzer_report.md`, `02_writer_files.md`, `03_validator_report.md`, `validator_mechanical.json`, `.claude/patterns/pattern_profile.json`, 인덱스(`query-index.mjs` 질의로만), `_workspace/qa_boundary6.md`(있으면) |
| 씀 | `_workspace/04_qa_report.md`, `_workspace/qa_boundary6.md`(스크립트가 생성) |

인덱스 원본 JSON은 Read로 열지 않고 `summary`로 규모를 본 뒤 `symbol`·`callers`·`callees`·`trace`·`sql`·`table`·`endpoint`·`transaction`·`dead` 질의로 필요한 줄만 가져온다. 응답의 `truncated > 0`이면 잘린 목록이므로 DEAD/ORPHAN을 단정하지 않는다.

## 판정·출력 형식

리포트는 `=== QA REPORT (Integration Boundary) ===`로 시작한다.

- `## Boundary 1~4` — 누락·고아·UNKNOWN 항목 목록, 각 항목에 `file:line` 근거
- `## Boundary 3` — 컨벤션 매칭률 `일치 규칙 수/검증 가능 규칙 수`, 근거 없는 서술은 UNVERIFIABLE로 별도 표기
- `## Boundary 5` — 샘플 10개 일치율, 80% 미만이면 analyzer incremental 재실행 권고
- `## Boundary 6` — analyze-impact·review-sql·plan-migration 의존 인덱스 존재/누락
- `## 종합 권고` — 🔴 HIGH(런타임 오류 가능), 🟡 MEDIUM(정확도 저하), 🟢 LOW(정리 후보)
- `## 스킬 수정 권고`, `## 인덱스 재생성 권고`

동적 조합 SQL ID처럼 억지로 일치시킬 수 없는 것은 UNKNOWN에 둔다. `J-F`(고아 JSP 후보)는 include/tag 참조를 확인하기 전 삭제 대상으로 확정하지 않는다.

## 원칙

- 존재 확인이 아니라 경계면 교차 비교다. 양쪽을 동시에 읽고 Set 연산으로 mismatch를 찾는다.
- Incremental 실행이다. boundary별로 결과를 append하고 중간에 멈추지 않는다.
- 인덱스가 있으면 grep보다 질의 도구를 우선한다.
- validator와 역할을 나눈다. validator는 파일 존재·frontmatter·경로·보안·인덱스 무결성을, qa는 레이어 간 식별자 일치·shape 일치·orphan/dead 참조를 본다.

## 관련 문서

- [게이트](/concepts/gates.md)
- [harness-init](/skills/harness-init.md)
- [validator](/agents/validator.md)
- [harness-evaluator](/agents/harness-evaluator.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
