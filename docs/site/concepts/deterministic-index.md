# 결정론적 인덱스

AX Navi는 코드베이스의 사실(심볼·호출 관계·SQL·트랜잭션·외부 통신·스키마)을 LLM에게 읽혀서 뽑지 않는다. `agents/lib/build-index.mjs`가 소스를 전수 파싱해 `_workspace/index/`에 JSON으로 기록하고, 하나로 결정할 수 없는 관계만 analyzer에게 넘긴다. 이 문서는 그 인덱스가 왜 스크립트로 만들어지는지, 어떤 파일이 생기며, 어떻게 갱신·조회하는지 설명한다.

## 왜 LLM 대신 스크립트가 전수 파싱하는가

LLM에게 "이 프로젝트의 호출 그래프를 만들어라"고 하면 세 가지 문제가 생긴다. 대형 코드베이스를 전부 읽을 수 없어 샘플링하게 되고, 읽지 못한 부분은 추측으로 채우며, 같은 입력에 매번 다른 결과가 나온다. 결정론적 인덱서는 이를 뒤집는다.

- 언어별 구문과 프레임워크에서 확실하게 추출할 수 있는 사실만 기록한다. 후보가 하나로 좁혀지지 않는 호출은 엣지를 만들지 않고 `_unresolved.jsonl`로 넘긴다. 그래서 dangling 엣지가 구조적으로 생기지 않는다.
- Node 18 이상만 있으면 npm 의존성 0으로 실행되며 LLM 토큰을 쓰지 않는다. 파일 수천 개 규모 레거시도 수십 초 안에 끝난다.
- 모든 레코드에 `origin`(`deterministic-indexer`·`ai-enrichment`·`analyzer-fallback`)과 `confidence`가 붙어 어디서 온 사실인지 구분된다.
- 같은 소스에서 같은 결과가 나오므로 팀원이 각자 재생성해도 diff가 없고, `source_root`가 `.`이라 PC 간 이식된다.

인덱서가 없는 환경(node 18 미만)에서는 스택별 Python 추출기가 `symbols`·`call_graph`만 만들고, 그것도 실패하면 analyzer가 전부 작성한다. 어느 순위로 실행됐는지는 `_workspace/00_stack_precheck.json`의 `indexer` 키와 Phase 3 보고의 `indexer_rank`에 남는다.

## 생성 파일 12종

해당 사실이 있는 것만 생성된다. DB를 쓰지 않는 프로젝트에는 `sql_usage`·`schema`가 없다.

| 파일 | 한 줄 설명 |
|------|------|
| `symbols.json` | 모든 클래스·메서드·함수의 위치와 시그니처 |
| `call_graph.json` | 호출·주입·상속 관계 그래프(`nodes`·`edges`) |
| `sql_usage.json` | 어떤 SQL ID를 어디서 실행하는지, 테이블·컬럼 best-effort 파싱 |
| `schema.json` | 테이블·컬럼·PK·FK·인덱스 정의 |
| `transactions.json` | 트랜잭션 경계와 그 안의 메서드·외부 호출 |
| `external_io.json` | HTTP·MQ·파일·외부 DB 등 외부 통신 지점 |
| `env_branches.json` | 프로파일·환경 변수에 따라 갈리는 코드·설정 |
| `api_contract.json` | 서버 엔드포인트, 클라이언트 호출처, 둘의 매칭과 드리프트 |
| `dead_code.json` | in-degree 0 메서드·미참조 SQL ID·도달 불가 JSP 후보(확정 아님) |
| `ui_flow.json` | 화면 이벤트와 서버 호출 흐름(현재 Nexacro XFDL/XJS) |
| `data_flow.json` | 엔드포인트 → 호출 경로 → SQL → 테이블을 조인한 체인 |
| `client_index.json` | 빌드 도구 없는 레거시 정적 JS의 JS↔JSP 매핑과 jQuery 버전 |

`owasp_top10.json`은 판단이 필요해 인덱서가 아니라 analyzer가 작성한다. 각 파일의 필드 정의는 [인덱스 스펙](/reference/index-spec.md)에 있다.

## 제어 파일

| 파일 | 한 줄 설명 |
|------|------|
| `_meta.json` | 전역 매니페스트. tier·복잡도·어댑터 커버리지·생성된 인덱스 목록·소스 지문·인코딩·제외 요약·AI 보강 결과 |
| `_analysis_input.json` | analyzer가 읽는 상한 있는 요약(허브·진입점·모듈·대표 파일·테스트·배포 인벤토리)과 계약(`analyzer_contract`) |
| `_unresolved.jsonl` | 이름 해석을 확정하지 못한 관계 전부. 후보 2개 이상은 판정 대상, 0~1개는 `no_candidates: true` 감사 기록 |
| `_unresolved_groups.json` | 판정 대상을 같은 표현식·후보 조합으로 묶은 그룹. analyzer는 이 파일을 기준으로 판정한다 |

`_ai_patch.json`은 인덱서가 아니라 analyzer가 쓰는 파일이며 아래 "미해결 관계와 그룹 판정"에서 다룬다.

## 제외 규칙 — 벤더·미니파이·테스트

서드파티 라이브러리와 미니파이 번들을 인덱싱하면 그래프가 쓸모없어진다. 실측(xu25-client)에서는 ckeditor·jquery-ui·smarteditor를 전부 인덱싱해 노드 34,674개 중 80%가 고아가 되고 데드코드 31,572건이 거짓양성으로 나왔다. 판정은 세 층이다.

| 층 | 신호 | 예 |
|------|------|------|
| 디렉터리 이름 | 라이브러리 배포 디렉터리 | `ckeditor/`, `jquery-ui/`, `fck_editor/`, `bootstrap/` |
| 파일명 | 미니파이·번들 접미사, 버전이 박힌 이름 | `*.min.js`, `*.bundle.js`, `jquery-1.5.2.js` |
| 파일 내용 | 앞 64KB의 줄당 평균 길이 250자 이상(20KB 이상 파일만) | 손으로 쓴 JS는 보통 30~60자 |

파일명 접두사로는 판정하지 않는다. `jquery.add.js`가 실제로는 배너 슬라이더 업무 코드였던 사례가 있어 라이브러리 이름을 접두사로 쓴 프로젝트 파일을 자르지 않는다.

테스트 파일도 같은 이유로 제외한다. `test`·`tests`·`__tests__`·`spec`·`specs` 디렉터리(세그먼트 완전 일치만)와 `*Test.java`·`*_test.go`·`test_*.py`·`*.test.ts`·`*Tests.cs`처럼 빌드 도구가 강제하는 규약만 잡는다. 업무 코드와 동일하게 노드·엣지가 되어 `call_graph.json`을 부풀리지만 호출 그래프 분석에는 의미가 없기 때문이다.

제외 결과는 `_meta.json`의 `excluded_sources`에 남는다. `count`, `by_reason`(vendor-path·vendor-filename·vendor-versioned·minified·test-path·test-filename), `bytes`, 파일 목록 최대 100건이다. `_workspace/indexer-config.json`에 `"vendor_exclude": false` 또는 `"test_exclude": false`를 두면 각 제외를 끌 수 있다.

## DDL이 없을 때 — SQL에서 스키마 유도

`schema.json`은 원래 `.sql` DDL의 `CREATE TABLE` 파싱이나 라이브 DB 접속에서만 만들어졌다. 쿼리를 전부 MyBatis·iBatis XML에 두고 DDL을 저장소에 두지 않는 레거시에서는 `tables: []`가 되어 DB가 없는 것처럼 보였다.

이제 DDL이 하나도 없으면 `sql_usage.json`의 `tables`를 집계해 스키마를 유도한다. `_meta.source`가 `derived-from-sql`이고 각 테이블은 `origin: "derived-from-sql"`·`confidence: "MEDIUM"`·`usage_count`·`source_sqls`(최대 10개)를 갖는다. 컬럼은 알 수 없으므로 빈 배열이며 지어내지 않는다. DDL이 있으면 종전대로 DDL이 우선이다. 실측(xu25-server)에서는 `.sql` 0개, SQL 5,348건에서 테이블 603개가 유도됐다.

## 미해결 관계와 그룹 판정

인덱서는 후보가 둘 이상인 호출을 곧바로 넘기지 않고 `same_file` → `same_package` → `same_workspace` 순으로 스코프를 좁혀 정확히 하나로 줄어들 때만 확정한다(`confidence: "MEDIUM"`, `resolved_by` 기록). 끝까지 하나로 줄지 않으면 `_unresolved.jsonl`에 후보 목록과 함께 남긴다.

레거시에서는 같은 애매함이 수백 곳에서 반복된다. 실측에서 판정 대상 2,380건이 실제로는 고유 패턴 185개였고 한 패턴이 872곳에서 반복됐다. 그래서 인덱서는 `(kind, 표현식, candidates)` 조합으로 묶은 `_unresolved_groups.json`을 함께 만들고, 판정은 다음 흐름으로 진행된다.

1. analyzer가 그룹마다 대표 사례(`occurrences[0]`) 한 곳만 열어 후보 중 무엇이 맞는지 판정한다.
2. 판정이 일관되면 `{"op":"resolve_group","group_id":"...","to":"<후보 id>","type":"call","evidence":"..."}` 한 건만 `_workspace/index/_ai_patch.json`에 낸다. 문맥에 따라 판정이 갈리는 그룹은 표본을 더 보거나 위치별 `add_edge`로 나눈다.
3. `build-index.mjs --apply-ai-patch`가 그룹의 모든 발생 위치로 엣지를 확장하고 병합한다. 없는 노드·없는 그룹·후보 밖 대상은 사유와 함께 거부되며, 병합 결과는 `_meta.json`의 `ai_enrichment`에 남는다.

이 방식으로 그룹핑 도입 전 163분이던 견적이 27분으로 줄었다. 그래프에는 여전히 발생 위치 수만큼 엣지가 들어가므로 정확도와 감사 가능성은 그대로고 LLM 판정 횟수만 준다.

analyzer가 `call_graph.json`을 직접 고치지 않고 패치로 내는 이유는 재인덱싱이다. `--mode incremental`은 소스에서 그래프를 다시 만들기 때문에 손으로 덧붙인 엣지는 다음 갱신에서 에러 없이 사라진다. 패치는 파일을 쓰기 전에 다시 병합되고 데드 코드도 그에 맞춰 재계산된다. 같은 패치 파일에 엔드포인트·외부 통신 설명(`set_endpoint_description`·`set_communication_description`), 노드·엣지 주석(`set_node_note`·`set_edge_note`), 데이터 흐름 주석(`set_flow_note`), 클라이언트 해설(`set_client_index_narrative`)도 함께 들어간다.

## 신선도 확인과 증분 갱신

```bash
node "$CLAUDE_PLUGIN_ROOT/agents/lib/build-index.mjs" --root <프로젝트 루트> --check-stale
```

`--check-stale`은 LLM 없이 재인덱싱 필요 여부만 판정한다. exit 0이면 최신, exit 1이면 재인덱싱이 필요하며 `reason`에 이유가 실린다.

| `reason` | 의미 | 권장 모드 |
|------|------|------|
| `인덱스 없음` | `_meta.json`이 없다 | `--mode init` |
| `인덱서 버전 변경 (a → b)` | 플러그인이 갱신됐다 | `--mode incremental` |
| `지문 없는 구버전 인덱스` | `source_fingerprint`가 없는 옛 인덱스다 | `--mode incremental` |
| `소스가 변경됨` | 소스 지문이 인덱스와 다르다 | `--mode incremental` |

모드는 `init`·`incremental`·`feature-scoped` 셋이다. 파일별 해시 캐시는 두지 않으므로 `incremental`도 매번 전체를 재추출한다. 추출 결과가 원본 소스보다 훨씬 커서 캐시 직렬화가 재추출보다 비쌌기 때문이다(소스 96MB → facts 459MB, 32초 → 46초). `incremental`이 `init`과 다른 점은 기존 `_ai_patch.json`을 보존해 다시 병합한다는 것이다. `safe-modify`는 Phase 0에서 `--check-stale`을 먼저 실행하고 GO 후 Phase 5에서 `--mode incremental`을 기본 실행한다.

## 대형 인덱스는 query-index.mjs로 조회한다

실측한 대형 레거시 인덱스는 `sql_usage.json` 143MB, `dead_code.json` 38MB, `call_graph.json` 36MB, `symbols.json` 26MB였다. "호출자 5개만 알고 싶다"에 143MB를 여는 것은 성립하지 않는다.

```bash
node "$CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs" summary --root <프로젝트 루트>
node "$CLAUDE_PLUGIN_ROOT/agents/lib/query-index.mjs" callers --id OrderService.cancel --root <프로젝트 루트>
```

| 명령 | 질문 |
|------|------|
| `summary` | 인덱스 규모는 얼마인가, 무엇을 열지 정하기 전에 본다 |
| `symbol` | 이 클래스·메서드는 어디 있나 |
| `callers` / `callees` | 누가 부르고 무엇을 부르나 |
| `trace` | 진입점에서 출발하는 호출 경로(깊이 지정) |
| `sql` / `table` | 이 SQL ID·테이블을 어디서 쓰나 |
| `schema` | 테이블 정의와 참조하는 FK |
| `endpoint` / `transaction` | 엔드포인트·트랜잭션 경계 조회 |
| `dead` | 데드 코드 후보 페이지 조회 |

응답은 항상 JSON 한 덩어리이고 기본 50건(최대 500건) 상한에 걸리며 `truncated`로 잘린 수를 밝힌다. 없는 인덱스를 물으면 빈 결과가 아니라 사유를 돌려준다. `truncated > 0`이면 `--limit`을 올려 다시 조회하고 실제 `total`을 근거로 써야 한다.

## 어댑터 커버리지

소스 해석 차이는 `agents/lib/adapters/registry.mjs`에 모여 있다. `level`은 파일을 읽을 수 있다는 뜻이 아니라 유지보수 판단에 필요한 구조를 얼마나 결정적으로 추출하는지를 뜻한다.

| 수준 | 어댑터 | 의미 |
|------|------|------|
| `FULL` | Java/Kotlin, C#, JavaScript/TypeScript/Vue/React, Nexacro XJS, Python, Go, SQL | 구조를 결정적으로 추출한다 |
| `PARTIAL` | .NET 프로젝트 메타(`.csproj`·`.config`), Nexacro Form(`.xfdl`), JSP/Struts/WebForms/markup, DevExpress·WinForms Designer, Django/Flask 엔드포인트 | 일부만 추출하므로 변경 전에 에이전트가 원문을 직접 읽어 확인한다(`READ`) |
| `UNSUPPORTED` | discovery-only 확장자(`.sln`·`.fmb`·`.pbl`·`.c`·`.cpp`·`.rs`·`.scala` 등), 레지스트리에 없는 확장자 | 존재만 기록하고 인덱싱하지 않는다 |

전체 요약은 `_meta.json`의 `adapter_coverage`에, 변경 대상별 판정은 다음 명령으로 얻는다.

```bash
node "$CLAUDE_PLUGIN_ROOT/agents/lib/check-adapter-coverage.mjs" --root <프로젝트 루트> --target src/main/webapp/order/list.jsp
```

결과는 `{target, decision, level, reason}` JSON이며 `FULL`이면 `GO`(exit 0), `PARTIAL`이면 `READ`(exit 0, 원문 확인 후 진행), `UNSUPPORTED`면 `HOLD`(exit 2)다. `_meta.json`이 없거나 손상돼 있어도 크래시 대신 `HOLD`로 강등한다. 변경 파일이 여럿이면 가장 낮은 커버리지가 전체 판정이 된다. 게이트에서의 동작은 [판정과 게이트](/concepts/gates.md)를 참조한다.

## 테스트·배포 인벤토리

`_analysis_input.json`의 `evidence.test_deploy_inventory`는 analyzer가 소스를 다시 훑지 않고도 "테스트 프레임워크가 무엇이고 어디에 테스트가 있으며 어떻게 배포되는가"를 알 수 있게 파일명과 매니페스트만 보고 만든 인벤토리다.

| 필드 | 내용 |
|------|------|
| `test_frameworks` | JUnit·TestNG·Mockito·pytest·Jest·Vitest·Cypress·Playwright·xUnit·NUnit 등과 근거 매니페스트 |
| `coverage_tools` | JaCoCo·Istanbul/nyc·pytest-cov·coverlet·SimpleCov |
| `test_file_count`, `test_dirs` | 제외 규칙에 걸린 테스트 파일 수와 위치(최대 20건) |
| `deploy.containers` / `ci` / `iac` / `app_servers` / `build_scripts` | Dockerfile·CI 설정·Terraform/Helm·`web.xml`·`Web.config`·`appsettings.json`·`build.xml`·`gradlew` 등 |
| `manifests_scanned` | 훑어본 매니페스트 수 |

내용 판단은 하지 않는다. 테스트가 실제로 실행되는지, CI가 통과하는지, 배포 경로가 동작하는지는 판정하지 않으며 `note`에 그 한계를 명시한다. test-generator가 기존 테스트 관행을 따르고 plan-migration이 배포 모델을 회귀 기준선으로 삼을 때 이 인벤토리를 쓴다.

## 관련 문서

- [인덱스 스펙](/reference/index-spec.md)
- [인덱서 설정](/configuration/indexer-config.md)
- [인덱스 갱신](/configuration/index-refresh.md)
- [컨텍스트와 토큰 관리](/concepts/context-and-tokens.md)
- [스택 매트릭스](/reference/stack-matrix.md)
