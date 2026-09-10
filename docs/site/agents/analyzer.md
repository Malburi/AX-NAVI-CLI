# analyzer

코드베이스를 체계적으로 탐색해 후속 작업에 필요한 정보를 뽑아내는 심층 분석 에이전트다. 기술 스택·아키텍처 레이어·요청 흐름(Phase A)에 더해 의존성 그래프·데이터 흐름·트랜잭션 경계·외부 통신·비동기/스케줄·설정 분기·인증 경로·데드 코드(Phase B)까지 추출하고, 결과를 `_workspace/01_analyzer_report.md`와 `_workspace/index/*.json`으로 남긴다. 탐색·분석·인덱싱만 하며 하네스 파일이나 코드를 수정·삭제하지 않는다.

## 호출 경로

- [harness-init](/skills/harness-init.md) Phase 2-1(`T-A`)이 `mode: init`으로 부른다. Standard Tier는 Phase A와 스택에 해당하는 Phase B만, Full Tier는 Phase B 전체를 실행한다.
- harness-init Phase 4의 인덱스 무결성 게이트와 PARTIAL 점수의 `fix_target`은 `mode: targeted`로 다시 부른다. 이때는 지목된 항목만 고치고 리포트를 재작성하지 않는다.
- 업데이트·인덱스 리프레시 경로는 `mode: incremental`로 변경 파일만 재분석한다.
- 스킬 파일에서 `ax-navi:analyzer`로 직접 호출하는 곳은 harness-init뿐이다. 본문의 "실행 우선순위 가이드" 표는 analyze-impact·safe-modify·plan-migration 등 컨텍스트별로 어떤 Phase까지 필요한지 정의한다.
- frontmatter `model`은 `claude-sonnet-5`, `tools`는 지정하지 않아 기본 도구 세트를 쓴다. 본문의 작업 범위가 "하네스 파일·코드 수정·삭제 금지"를 명시한다.

## 하는 일

1. Step 0.5에서 `_workspace/pair_config.md`를 확인해 파트너 연동(1:1 또는 1:N) 여부를 리포트 헤더에 기록한다.
2. Step 1~2에서 루트 파일(`pom.xml`·`package.json`·`*.csproj` 등)로 스택을 1차 분류하고 Java·Node·프런트엔드·Python·.NET별 상세 탐지를 한다.
3. Step 3~7에서 아키텍처 레이어·요청 흐름·클라이언트 자원·코드 컨벤션·빌드/실행 명령을 정리한다. Step 5는 LegacyStaticJS 환경의 JS↔JSP 매핑을 강화 탐지한다.
4. Step 8에서 호출·임포트·DI 그래프를 만든다. 기계 인덱스(`_meta.json`)가 있으면 재작성하지 않고 `_analysis_input.json`·`_unresolved.jsonl`을 읽어 `_ai_patch.json`만 출력한다.
5. Step 9~11에서 데이터 흐름 체인의 의미 노트, 트랜잭션 경계, 외부 통신의 업무 설명을 보강한다.
6. Step 12~14에서 비동기·스케줄·이벤트와 설정 의존 분기, 인증·인가 경로를 식별한다.
7. Step 14.5에서 OWASP Top 10 카테고리에 앞선 Step 결과를 매핑해 `owasp_top10.json`을 쓴다.
8. Step 15.5에서 REST API 계약(`api_contract.json`)의 엔드포인트 설명을 채우고, Step 15에서 in-degree 0 심볼 등 데드 코드 후보를 표시한다.
9. Phase C에서 인덱스 파일별 크기 한도와 `_meta` 규칙을 지켜 출력하고, Phase D(선택)에서 DDL 또는 라이브 DB로 스키마 스냅샷을 만든다.
10. 리포트를 쓸 때 Section B/D 집계는 직접 쓰지 않고 `[SECTION_B_INDEX_SUMMARY_INSERT]` 마커를 남겨 `analyzer_index_summary.py`가 기계 조립하게 한다.

## 입력과 산출물

| 구분 | 파일 |
|------|------|
| 읽음 | 프로젝트 소스 전체, `_workspace/00_init_scope.md`, `_workspace/pair_config.md`(있으면), `_workspace/index/_meta.json`·`_analysis_input.json`·`_unresolved.jsonl`(기계 인덱스가 있을 때) |
| 씀 | `_workspace/01_analyzer_report.md`, `_workspace/index/_ai_patch.json`(기계 인덱스 있을 때), `_workspace/index/*.json`(기계 인덱스 없을 때 직접 작성), `owasp_top10.json`, `schema.json`(라이브 DB 접속 시) |

## 판정·출력 형식

리포트는 `=== HARNESS ANALYSIS REPORT ===`로 시작하며 다음 절을 가진다.

- 업무 개요 · 업무별 흐름 · 업무 규칙 · 분석 미확인
- A. 프로젝트 기본 정보 · 아키텍처 레이어 · 요청 흐름 · 코드 컨벤션 · 데이터 접근 패턴 · 클라이언트 자원 · 빌드/실행 명령
- B. 비동기/스케줄/이벤트 · 인증/인가 경로 (프로즈 직접 작성)
- `[SECTION_B_INDEX_SUMMARY_INSERT]` (의존성 그래프·트랜잭션·외부 통신·환경 분기·데드코드·OWASP·DB 스키마·테스트/배포 모델을 기계 삽입)
- 탐지 신뢰도 — 스택 탐지·아키텍처 패턴·의존성 그래프 완전성·컨벤션 추출을 각각 HIGH/MEDIUM/LOW로 표기
- 보완 권장 (자동 탐지 불가)

실행 모드는 `init`·`incremental`·`feature-scoped`·`targeted` 네 가지다. `incremental`은 변경·삭제 파일을 끝점으로 갖는 call_graph 엣지를 먼저 제거한 뒤 재수집해 stale 엣지를 막는다.

## 원칙

- 기계 인덱스가 만든 파일은 재작성하지 않고 `_ai_patch.json` 오퍼레이션으로만 보강한다. 직접 고치면 재인덱싱 때 사라진다.
- `targeted` 모드에서 근거를 찾지 못한 관계는 지어내지 않고 "미해소"로 반환한다. 게이트를 통과시키려고 없는 엣지를 만들면 인덱스가 조용히 틀려진다.
- 전체 재분석이 필요하다고 판단해도 스스로 승격하지 않고 판단만 반환한다. 승격은 오케스트레이터가 결정한다.
- 코드에서 확인된 사실과 추론을 구분하고, 근거 없는 업무 의미는 미확인으로 남긴다.
- 샘플링했으면 `_meta.sampled: true`와 `confidence: low`를 표기한다.

## 관련 문서

- [harness-init](/skills/harness-init.md)
- [결정론적 인덱스](/concepts/deterministic-index.md)
- [하네스 산출물](/concepts/harness-outputs.md)
- [Tier와 비용](/getting-started/tier-and-cost.md)
- [인덱스 명세](/reference/index-spec.md)
