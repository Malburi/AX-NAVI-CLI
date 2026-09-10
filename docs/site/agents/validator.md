# validator

writer가 생성한 하네스 파일과 인덱스를 검증하는 harness-init Phase 2-3 에이전트다. 파일 존재·트리거 품질·경로 정합성·보안 위험·인덱스 무결성·전역 워크플로우 스킬 등록 여부를 11개 항목으로 검사해 신뢰도 점수 0~100과 항목별 PASS/WARN/FAIL을 `_workspace/03_validator_report.md`에 쓴다. 검증과 리포트만 하며 자동 수정·삭제·보안 위험 자동 처리를 하지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 2-4가 부른다. 그 직전 Phase 2-3.5에서 pipeline-runner가 `validator_checks.py`·`validate-harness.mjs`·`pattern_profile.py validate`를 기계 실행해 둔다.
- frontmatter `model`은 `sonnet`, `tools`는 `Read, Grep, Glob, Bash, Write`다. `Edit`가 없어 소스 파일을 제자리에서 수정하지 않으며 Write는 리포트 작성에만 쓴다.

## 하는 일

1. `_workspace/validator_mechanical.json`을 먼저 읽는다. 체크 1,2,3,4,6,7,8,9는 file-exists·JSON-parse·regex-grep만으로 판정되므로 스크립트 결과의 `report_fragments`를 재검증 없이 그대로 전사한다.
2. 체크 11(인덱스 스키마 검증)도 `validator_schema.json`을 그대로 옮긴다. `code === "PLUGIN_INDEX_CONTRACT"` 항목은 감점하지 않고 "플러그인 인덱스 계약 결함 — 프로젝트·analyzer 문제 아님"으로 별도 표기한다.
3. LLM이 직접 판단하는 몫은 체크 5(누락 레이어 탐지)와 체크 10 중 스크립트가 `check10_undecided`로 남긴 patterns/ 파일의 SKELETON/FILLED 확정뿐이다.
4. 체크 5는 분석 리포트의 모든 레이어가 scaffolder.md·patterns/에 반영됐는지, 클라이언트 자원이 있으면 `client_pattern.md`가 있는지, AJAX가 trace.md에, 트랜잭션 경계가 `service_pattern.md`에 반영됐는지 본다.
5. 체크 10b는 `pattern_profile_validation.json`을 읽어 `valid: true`이고 프로필 1개 이상이면 PASS, 파일 없음이면 WARN, `valid: false`면 FAIL로 판정하고 errors를 원문 그대로 보고한다.
6. writer가 상충 패턴을 병기했으면 분석 리포트와 실제 코드를 교차 비교해 우선 패턴을 권고한다. 자동 적용은 하지 않는다.
7. `validator_mechanical.json`이 없으면(스크립트 실패) 폴백으로 11개 항목을 직접 검증한다.
8. 기계 차감(`mechanical_deduction`)에 직접 판단한 차감만 더해 최종 신뢰도를 계산하고 리포트를 쓴다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | `_workspace/01_analyzer_report.md`, `_workspace/02_writer_files.md`, `_workspace/validator_mechanical.json`, `_workspace/validator_schema.json`(있으면), `_workspace/pattern_profile_validation.json`(있으면), `_workspace/index/*.json`, 생성된 하네스 파일들 |
| 씀 | `_workspace/03_validator_report.md` |

## 판정·출력 형식

11개 항목은 다음과 같다.

| 번호 | 항목 | 비고 |
|------|------|------|
| 1 | 파일 존재 및 완성도 | CLAUDE.md·trace·scaffolder·find-logic·domain-expert·patterns/ |
| 2 | 워크플로우 스킬 등록 확인 | analyze-impact·safe-modify·scaffold-feature·vibe 미등록은 FAIL, plan-migration·review-sql은 조건부 WARN |
| 3 | 스킬 트리거 품질 | description 100자·한국어 3개·영어 2개·스택 키워드 1개, `model` 필드 누락은 FAIL |
| 4 | 프로젝트 파일 교차 검증 | 존재하지 않는 경로는 FAIL |
| 5 | 누락 레이어 탐지 | LLM 판단 |
| 6 | 보안 위험 확인 | 패스워드·API 키·DB 접속 문자열·내부 IP·내부 도메인 정규식, 리포트만 |
| 7 | 인덱스 무결성 | call_graph·symbols 존재, `_meta` 9개 필드, 참조 무결성, 7b 내용 스팟체크(일치율 80% 미만 FAIL) |
| 8 | 폐지 | 항상 PASS |
| 9 | 변경 이력 기록 | 누락 시 WARN |
| 10 / 10b | patterns/ 스켈레톤 vs 본문 / 구조화 패턴 프로필 | 프로필 FAIL은 -10 |
| 11 | 인덱스 스키마 검증 | `docs/index-schema/*.json` 대조 형태 검증 |

신뢰도 산식은 기본 100에서 FAIL당 -10, WARN당 -3, 보안 위험 1건당 -15(최대 -45), 인덱스 무결성 FAIL -15, 스키마 FAIL -15, 변경 이력 누락 -5를 뺀 값이다. 80~100은 바로 커밋 가능, 60~79는 경미한 보완 후 사용, 50~59는 주요 항목 보완 필요, 0~49는 QA 미실행 대상이다. 리포트는 `=== VALIDATOR REPORT ===`로 시작해 `## 1~6. 기본 검증`부터 `## 11.`까지, `🔒 보안 확인 필요`, `📌 수동 확인 필요`, `## 신뢰도 점수`, `## qa 실행 가능 여부`로 끝난다.

## 원칙

- 이미 기계가 계산한 체크를 다시 세지 않는다. 전사만 한다.
- 보안 위험은 `[PASSWORD]`·`[API_KEY]` 같은 플레이스홀더 교체를 권고하되 자동 수정은 절대 하지 않는다.
- QA는 자동 후속 실행되지 않는다. 사용자가 Phase 3.6 메뉴에서 고를 때만 Phase 3.7에서 실행되며, 실행 가능 임계는 신뢰도 50이다.
- 실제 근거 파일이 없는 패턴 프로필을 정상 컨벤션으로 승인하지 않는다.

## 관련 문서

- [게이트](/concepts/gates.md)
- [harness-init](/skills/harness-init.md)
- [qa](/agents/qa.md)
- [harness-evaluator](/agents/harness-evaluator.md)
- [인덱스 명세](/reference/index-spec.md)
