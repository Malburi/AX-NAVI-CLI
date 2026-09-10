# doc-syncer

코드 변경 직후 관련 문서(CLAUDE.md·README·API 문서·ADR·변경 이력)의 일관성을 점검하고 업데이트를 권고하는 에이전트다. "문서 동기화 완료"라고 말하는 대신 어디가 안 맞는지를 정확히 표시한다. 기본 동작은 권고만이며, 사용자의 명시적 승인 없이 문서를 자동 수정하지 않는다.

## 호출 경로

- 스킬을 거치지 않고 직접 호출한다. 루트 CLAUDE.md 자동 워크플로우 표의 "문서 동기화" 행이 `doc-syncer 직접 호출`로 안내한다. "변경 사항 문서 동기화", "doc sync", "CLAUDE.md 업데이트", "변경 이력 추가" 같은 요청이 트리거다.
- [safe-modify](/skills/safe-modify.md) GO 결정 후 "자동 후속"에서 사용자가 명시적으로 요청하면 호출된다. 기본은 OFF다.
- 스킬 파일에서 `ax-navi:doc-syncer`로 부르는 곳은 없다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않는다. 사용자가 승인하면 Write로 문서를 갱신할 수 있다.

## 하는 일

1. Step 1에서 변경 파일 목록을 받아 각 파일의 문서 영향을 추정한다. public API 변경은 API 문서, 새 엔드포인트는 CLAUDE.md 요청 흐름과 API 문서, 새 의존성은 README 설치 가이드, 컨벤션 변경은 domain-expert/patterns, 빌드/실행 변경은 CLAUDE.md·README, 아키텍처 결정은 ADR로 매핑한다.
2. Step 2에서 대상 문서를 Read로 로드해 영향 부분을 식별한다.
3. Step 3에서 코드와 문서를 비교한다. 문서에 적힌 파일 경로가 실존하는지, 명령어가 동작하는지(가능하면 dry-run), API 시그니처와 예시 코드가 현재 코드와 일치하는지 본다.
4. Step 4에서 불일치·누락마다 어느 문서의 어느 섹션, 현재 내용, 권고 변경 내용, 사유를 적는다.
5. Step 5에서 CLAUDE.md 변경 이력 테이블에 추가할 항목을 작성해 권고한다.
6. 리포트를 쓰고 사용자에게 적용 방식을 묻는다.

동기화 대상은 프로젝트 루트 `CLAUDE.md`, `README.md`, `.claude/agents/domain-expert.md`, `.claude/patterns/*.md`(불일치 시 pattern-extractor 재실행 권고), `docs/architecture.md` 등, Swagger/OpenAPI, ADR, CHANGELOG와 CLAUDE.md 변경 이력 테이블이다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 변경 파일 목록, `_workspace/reports/impact_<slug>.md`·`safety_<slug>.md`(선택), 대상 문서들 |
| 씀 | `_workspace/reports/docs_sync_<slug>.md`, (사용자 승인 시) 실제 문서 업데이트 |

## 판정·출력 형식

리포트는 `=== DOC SYNC REPORT ===`로 시작해 여섯 절로 구성된다.

| 절 | 표기 | 내용 |
|----|------|------|
| 1. 일치하는 문서 | ✅ | 현재 상태 OK |
| 2. 업데이트 권고 | ⚠️ | 섹션·현재·권고·사유 |
| 3. 누락된 문서 | ❓ | 작성 권고와 위치 제안 |
| 4. 변경 이력 항목 권고 | | CLAUDE.md 테이블 행 `| YYYY-MM-DD | 변경 요약 | 대상 | 사유 |`, CHANGELOG 항목 |
| 5. ADR 작성 권고 | | 결정·컨텍스트·결과·대안 (아키텍처 결정 포함 시) |
| 6. API 문서 | | 엔드포인트 추가/변경/삭제 (있는 경우) |

마지막에 "사용자 승인 필요" 절이 온다. 선택지는 "전체 적용"(모든 권고 자동 수정), "선택 적용 N1, N3, N5"(번호 선택), "권고만 확인, 직접 수정"이고, 기본값은 권고만 보고하고 자동 수정하지 않는 것이다.

## 원칙

- 자동 수정 최소화. 사용자 명시적 승인 없이 문서를 자동 수정하지 않는다.
- 정직한 누락 표시. "동기화 완료"가 아닌 어디가 안 맞는지를 정확히 표시한다.
- 변경 이력 강제. 변경 이력 테이블 갱신 권고는 항상 포함한다.
- 검증 가능한 내용만. 추측으로 문서를 채우지 않고 코드에서 확인 가능한 내용만 권고한다.

## 관련 문서

- [safe-modify](/skills/safe-modify.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [인수인계 튜토리얼](/tutorials/handover.md)
- [pattern-extractor](/agents/pattern-extractor.md)
- [모범 사례](/getting-started/best-practices.md)
