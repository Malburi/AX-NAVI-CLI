# api-bridge

백엔드와 프론트엔드가 별도 저장소(Type B)인 구조에서 두 프로젝트가 서로의 API 표면을 파악하도록 연결하는 크로스 리포 에이전트다. 백엔드 코드에서 `api_contract.json`을 추출하고, 프론트엔드 호출과 계약을 비교해 드리프트를 찾고, 신규 엔드포인트의 프론트엔드 서비스 스텁을 만들고, API 변경 시 파트너 영향을 확인하는 네 모드로 동작한다. 읽기·추출·생성만 하며 기존 코드를 수정하지 않는다.

## 호출 경로

| mode | 호출처 |
|------|--------|
| `extract` | [pair-init](/skills/pair-init.md) Phase 3, [cross-repo-scaffold](/skills/cross-repo-scaffold.md) Phase 4, harness-init Phase 4 게이트(`api_contract` 스키마 실패 시 재실행 — 본문 표 기준) |
| `validate` | pair-init Phase 4-A/4-B, cross-repo-scaffold Phase 6 "API 계약 정합성", [cross-repo-modify](/skills/cross-repo-modify.md) Phase 6 "API 드리프트 재검증" |
| `generate-stub` | cross-repo-scaffold Phase 5, 직접 호출("프론트엔드 서비스 스텁만 생성" — 루트 CLAUDE.md 표) |
| `check-impact` | cross-repo-modify Phase 2 "파트너(들) 영향 확인" |

impact-analyzer Step 8.5는 이 에이전트를 부르지 않고 파트너의 `api_drift_report.md`를 참조한다. frontmatter `model`은 `sonnet`, `tools`는 지정하지 않는다. 작업 범위는 "읽기·추출·생성만, 기존 코드 수정 금지"다.

## 하는 일

extract 모드는 다음 순서다.

1. Spring Boot(`@RestController`)·Struts XML·Express(`router.get`)·NestJS·FastAPI·Flask·Django REST·ASP.NET Core(`[ApiController]`) 패턴으로 컨트롤러 파일을 수집한다.
2. 각 파일에서 메서드·경로·핸들러·파일·라인·요청/응답 shape·인증 여부(`@PreAuthorize`·미들웨어·공개 경로 패턴)·역할을 추출하고 경로 변수(`{id}`·`:id`·`<int:id>`)를 정규화한다.
3. Request/Response DTO 파일을 읽어 필드를 `models`에 기록한다. 탐지가 어려우면 `"fields": "TODO: 수동 확인 필요"`로 표기한다.
4. `[백엔드 루트]/_workspace/index/api_contract.json`에 쓴다. 기존 파일이 있으면 `id` 기준으로 병합하고 인덱서가 놓친 항목만 `origin: "api-bridge"`로 추가한다.
5. `validate-harness.mjs --out _workspace/reports/api_contract_schema_check.json`으로 스스로 검증하고, FAIL이면 고쳐 1회 재검증한다. 2회차도 FAIL이면 메시지를 반환문에 그대로 적는다.

validate 모드는 파트너 `api_contract.json`을 로드하고, Axios·fetch·Angular HttpClient 호출을 수집해 URL을 정규화(`` `/api/orders/${id}` `` → `/api/orders/{id}`)한 뒤 비교해 드리프트 리포트를 쓴다. generate-stub 모드는 프론트엔드 스택(Vue 3 + Axios TS, Vue 2 JS, React + Axios, React Query, Angular HttpClient)별 템플릿으로 서비스 함수를 만들며 기존 유사 서비스 파일이 있으면 함수를 추가하고 없으면 도메인명 기반 새 파일을 만든다. check-impact 모드는 변경 엔드포인트를 계약에서 찾고 프론트엔드 루트를 grep해 호출 위치를 돌려준다.

## 입력과 산출물

| mode | 읽음 | 씀 |
|------|------|-----|
| extract | 백엔드 컨트롤러·DTO, 기존 `api_contract.json` | `[백엔드]/_workspace/index/api_contract.json`, `_workspace/reports/api_contract_schema_check.json` |
| validate | `pair_config.md`의 `partner_api_contract`, 프론트엔드 서비스 코드 | `[프론트엔드]/_workspace/reports/api_drift_report.md` |
| generate-stub | 계약 항목, 프론트엔드 패턴·analyzer 리포트 | 프론트엔드 서비스 파일(`orderService.ts`·`order.js` 등) |
| check-impact | `api_contract.json`, 프론트엔드 소스, `api_drift_report.md`(있으면) | 반환 메시지(파일 없음) |

## 판정·출력 형식

`api_contract.json`은 `docs/index-schema/api_contract.schema.json`을 따른다. 최상위 필수 키는 `_meta`·`endpoints`·`consumers`·`matches`·`unmatched_endpoints`·`unmatched_consumers`이고, `endpoints[]`는 `id`·`workspace`·`source`·`method`·`path`·`handler`·`file`·`line`이 필수다. `file`은 프로젝트 루트 기준 상대경로, `line`을 모르면 `null`, `confidence`는 HIGH/MEDIUM/LOW다.

드리프트 리포트(`=== API DRIFT REPORT ===`)의 불일치 유형은 다음과 같다.

| 유형 | 의미 | 심각도 |
|------|------|--------|
| MISSING_ENDPOINT | 프론트에서 호출하는데 백엔드에 없음 | 🔴 HIGH |
| METHOD_MISMATCH | 같은 경로인데 HTTP 메서드 다름 | 🔴 HIGH |
| PATH_MISMATCH | 유사 경로인데 변수 패턴 다름 | 🟡 MEDIUM |
| STALE_CALL | deprecated 엔드포인트 호출 | 🟡 MEDIUM |
| UNUSED_ENDPOINT | 백엔드에 있는데 프론트 호출 없음 | 🟢 LOW |

check-impact 반환은 impact-analyzer 리포트의 "## 파트너 프로젝트 영향" 섹션과 같은 형식(변경 엔드포인트·호출 위치·영향 컴포넌트 수·권고)이다.

## 원칙

- 덮어쓰지 않고 병합한다. 독자 구조로 쓰면 인덱서의 스키마 준수 파일을 덮어 `validate-harness.mjs`가 FAIL을 낸다.
- 필수 키를 빠뜨리지 않는다. 스키마에 없는 부가 정보(`roles`·`deprecated`·`models`)는 덧붙여도 되지만 필수 키를 대체하지 못한다.
- 쓰고 나서 스스로 검증한다. 검증을 건너뛰고 끝내는 것은 금지다. `--out` 기본값(`validator_schema.json`)은 harness-init 산출물이라 덮어쓰지 않는다.
- 깨진 한글(대체 문자 U+FFFD)은 선언 인코딩으로 다시 읽어 복구하고, 안 되면 필드를 생략한다. 계약에 남기면 wiki까지 전파된다.
- 엔드포인트 200개 이상이면 핵심 도메인 모듈을 우선하되 필수 키는 전부 채운다.

## 관련 문서

- [pair-init](/skills/pair-init.md)
- [cross-repo-scaffold](/skills/cross-repo-scaffold.md)
- [cross-repo-modify](/skills/cross-repo-modify.md)
- [페어 설정](/configuration/pair-config.md)
- [크로스 리포 기능 튜토리얼](/tutorials/cross-repo-feature.md)
