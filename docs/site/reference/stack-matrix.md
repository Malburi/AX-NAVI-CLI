# 지원 스택 매트릭스

AX Navi가 자동 탐지하는 스택과 각 스택에서 기대할 수 있는 분석 깊이, 경계 QA 항목, 마이그레이션 시나리오를 한 곳에 모았습니다. 저장소 `docs/stack-matrix.md`와 `agents/lib/adapters/registry.mjs`의 어댑터 레벨을 기준으로 재구성했습니다. 분석 깊이는 문서 상의 기대치이고, 실제 변경 안전성 판정은 인덱서의 어댑터 커버리지(`FULL`/`PARTIAL`/`UNSUPPORTED`)가 결정합니다.

## 두 종류의 "깊이"를 구분하기

| 구분 | 값 | 어디에 기록 | 무엇을 결정 |
|------|-----|-------------|-------------|
| 분석 깊이 | `HIGH`·`MEDIUM`·`LOW` | 이 문서(스택별 기대치) | analyzer가 얼마나 자동 분석·컨벤션 추출을 할 수 있는지 |
| 어댑터 커버리지 | `FULL`·`PARTIAL`·`UNSUPPORTED`, 전체 상태 `FULL`·`PARTIAL`·`WARN` | `_meta.json`의 `adapter_coverage` | `safe-modify`·`scaffold-feature`·`change-safety`의 GO/HOLD |

| 분석 깊이 | 의미 |
|-----------|------|
| `HIGH` | 결정적 어댑터 범위는 자동 분석·컨벤션 추출 가능. 동적 런타임 동작은 별도 검증 |
| `MEDIUM` | 핵심 구조는 추출하지만 일부 파일·shape가 PARTIAL. 실제 빌드·UI/통합 시나리오 전까지 HOLD |
| `LOW` | 발견·구조 파악 중심. 자동 코드 변경 금지, 전문 어댑터 또는 수동 분석 필요 |

## 어댑터 커버리지 (확장자 기준)

`agents/lib/adapters/registry.mjs`에 등록된 결정적 어댑터입니다. 여기 없는 확장자는 `UNSUPPORTED`(discovery-only)로 취급됩니다.

| 어댑터 | 확장자 | 레벨 |
|--------|--------|------|
| Java/Kotlin/Spring | `.java` `.kt` `.kts` | `FULL` |
| .NET/C# | `.cs` | `FULL` |
| .NET project metadata | `.csproj` `.vbproj` `.fsproj` `.resx` `.config` | `PARTIAL` |
| JavaScript/TypeScript/Vue/React | `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.mts` `.cts` `.vue` | `FULL` |
| Nexacro | `.xjs` | `FULL` |
| Nexacro Form | `.xfdl` | `PARTIAL` |
| Python | `.py` | `FULL` (Django·Flask 엔드포인트가 있으면 `PARTIAL`) |
| Go | `.go` | `FULL` |
| SQL/DDL | `.sql` | `FULL` |
| JSP/Struts/WebForms/markup | `.xml` `.jsp` `.jspx` `.tag` `.asp` `.aspx` `.ascx` `.ashx` `.asmx` `.xaml` `.cshtml` `.vbhtml` `.razor` `.html` `.htm` | `PARTIAL` |

WinForms `.Designer.cs`와 DevExpress 컴포넌트는 `.cs`가 `FULL`이어도 개별 파일이 `PARTIAL`로 표시됩니다. 변경 대상이 `PARTIAL`이나 `UNSUPPORTED`면 change-safety는 명시적 수동 검증 전까지 최소 `HOLD`이고, 어댑터 판정 자체가 없으면 `UNVERIFIED/HOLD`입니다. 대상별 판정은 `check-adapter-coverage.mjs --target <파일>`로 확인할 수 있습니다.

## 탐지 시그니처와 분석 깊이

### Java 계열

| 스택 | 탐지 시그니처 | 분석 깊이 |
|------|---------------|-----------|
| Maven / Gradle Java | `pom.xml`, `build.gradle`, `build.gradle.kts` | HIGH |
| Spring Boot 2/3 | `pom.xml` + `spring-boot-starter-*` | HIGH |
| Spring Framework 3~4 | `spring-*` (no boot) | MEDIUM |
| Struts 1.x | `struts-core` 또는 `WEB-INF/struts-config.xml` | MEDIUM (XML→Action→forward 교차 QA 필요) |
| Struts 2.x | `struts2-core` | MEDIUM |
| Java EE Web / EJB 2.x | `WEB-INF/web.xml`, `ejb-jar.xml` | MEDIUM / LOW |
| MyBatis | `mybatis-spring`, `mybatis-config.xml`, `*Mapper.xml` | HIGH |
| iBatis | `ibatis-sqlmap`, `sqlmap-config.xml` | MEDIUM (마이그레이션 대상) |
| JPA / Hibernate | `spring-data-jpa`, `hibernate-*`, `persistence.xml` | HIGH |
| 전자정부 표준프레임워크 | `org.egovframe`, `egovframework.*` | MEDIUM |
| JSP/JSTL | `*.jsp`, `WEB-INF/jsp/*` | MEDIUM |

### Node.js·프런트엔드

| 스택 | 탐지 시그니처 | 분석 깊이 |
|------|---------------|-----------|
| Express / NestJS / Next.js | `express`, `@nestjs/core`, `next` + `next.config.*` | HIGH |
| Fastify / Koa | `fastify`, `koa` | MEDIUM |
| TypeORM / Prisma | `typeorm`, `prisma` + `schema.prisma` | HIGH |
| Sequelize / Mongoose | `sequelize`, `mongoose` | MEDIUM |
| Vue 3 / Nuxt 3 / Pinia / Vue Router / Vite | `vue@^3`, `*.vue`, `nuxt@^3`, `pinia`, `vue-router`, `vite.config.*` | HIGH |
| Vue 2 / Nuxt 2 / Vuex / Vue CLI | `vue@^2`, `nuxt@^2`, `vuex`, `vue.config.js` | MEDIUM (마이그레이션 대상) |
| React | `react`, `react-dom`, `*.jsx`/`*.tsx` | HIGH (런타임 동적 route는 수동 검증) |
| Angular 15+ | `@angular/core`, `angular.json` | HIGH |
| AngularJS 1.x | `angular@^1`, `ng-app` | LOW |
| Svelte / SvelteKit | `svelte`, `@sveltejs/kit` | MEDIUM |

### Python·.NET·Nexacro

| 스택 | 탐지 시그니처 | 분석 깊이 |
|------|---------------|-----------|
| FastAPI / Django / SQLAlchemy / Pydantic | requirements·pyproject의 패키지명 | HIGH |
| Flask / psycopg | `flask`, `psycopg` | MEDIUM |
| .NET Framework 2~4 | `*.csproj` + `<TargetFramework>net4*` | MEDIUM (마이그레이션 대상) |
| .NET Core / 5+ | `<TargetFramework>net*`·`netcoreapp*` | MEDIUM (`.cs` FULL, 프로젝트 메타데이터 PARTIAL) |
| ASP.NET Core / Entity Framework | `Microsoft.AspNetCore.*`, `ControllerBase`, `EntityFrameworkCore` | HIGH |
| Classic ASP.NET MVC | `System.Web.Mvc` | MEDIUM |
| WinForms / DevExpress WinForms | `System.Windows.Forms`, `*.Designer.cs`, `DevExpress.*` | MEDIUM (Designer·Grid는 수동 검증) |
| Nexacro XJS | `*.xjs`, `this.transaction()` | HIGH |
| Nexacro XFDL | `*.xfdl`, `<FDL>` | MEDIUM |

### 데이터베이스·기타

| 스택 | 탐지 시그니처 | 분석 깊이 |
|------|---------------|-----------|
| Oracle PL/SQL | `*.pks`·`*.pkb`·`*.pck`·`*.prc`·`*.fnc`·`*.trg`, `.sql` 안의 `CREATE PROCEDURE`·`PACKAGE`·`TRIGGER` | MEDIUM (패키지·프로시저·함수·트리거 심볼, 호출 관계, 본문 정적 SQL, Java `{call}`·MyBatis CALLABLE 연결. 동적 SQL 변수·오버로드·중첩 프로시저는 근사, 변경은 HOLD) |
| Oracle Pro*C | `*.pc` (`EXEC SQL`) | MEDIUM (C 함수·호출, EXEC SQL 정적 SQL·커서, `EXEC SQL EXECUTE BEGIN ... END-EXEC`·`CALL`의 PL/SQL 프로시저 연결. 매크로·함수 포인터·전처리 분기는 해석하지 않음, 변경은 HOLD. 일반 `.c`는 discovery-only) |
| Oracle / PostgreSQL / MySQL·MariaDB | `ojdbc*`, `postgresql-*`·`pg`, `mysql-connector-*`·`mysql2` | HIGH |
| SQL Server / Tibero / MongoDB / Redis | `mssql-jdbc`, `tibero-jdbc`, `mongoose`, `jedis` 등 | MEDIUM |
| Altibase | `altibase-jdbc` | LOW |
| Go | `go.mod` | MEDIUM |
| Rust / PHP·Laravel / Ruby on Rails | `Cargo.toml`, `composer.json`, `Gemfile` | LOW (Rust는 discovery-only, 변경 자동화 금지) |
| COBOL / ABAP / Oracle Forms / Classic VB | `*.cbl`, `*.abap`, `*.fmb`, `*.vbp` | LOW (legacy-decoder 적용) |

## QA Boundary 매트릭스

qa 에이전트의 Boundary 1~4는 스택별로 정의되고, Boundary 5(인덱스 ↔ 코드)·6(워크플로우 스킬 ↔ 인덱스 의존성)은 모든 스택 공통입니다. Boundary 7(Legacy Static JS 커버리지)은 analyzer가 `LegacyStaticJS`로 분류한 경우에만 실행됩니다.

| 스택 | Boundary 1 | Boundary 2 | Boundary 3 | Boundary 4 |
|------|------------|------------|------------|------------|
| Java EE / Struts | Struts XML ↔ Service ↔ Bean | Service ↔ Query XML 양방향 | 스킬 주장 ↔ 코드 | forward ↔ JSP |
| Spring Boot | `@RequestMapping` ↔ 프론트 호출 | `@Entity` ↔ DTO shape | `@Repository` ↔ 호출 위치 | 트랜잭션 전파 ↔ Service 호출 그래프 |
| Express / NestJS | route path ↔ 클라이언트 fetch | 응답 shape ↔ 프론트 타입 | middleware 체인 | DTO ↔ ORM 모델 |
| FastAPI | `@router` path ↔ 클라이언트 호출 | Pydantic ↔ ORM 필드 | DI 그래프 | status code ↔ 응답 schema |
| Next.js | `app/[route]` ↔ `href` | API 응답 shape ↔ `fetchJson<T>` | 서버 컴포넌트 fetch ↔ 클라이언트 hook | status 전이 |
| Vue 3 / Nuxt 3 | router 경로 ↔ `<NuxtLink>`/`router.push` | `defineProps` 타입 ↔ API 응답 | Pinia action ↔ 컴포넌트 호출 | composable 의존 그래프 |
| Vue 2 / Nuxt 2 | `routes.js` ↔ `<router-link>` | Options API `props` ↔ API 응답 | Vuex action ↔ dispatch | mixin ↔ 사용 컴포넌트 |
| .NET Core MVC | `[Route]` ↔ 호출 | EF Entity ↔ DTO | Repository ↔ 호출 위치 | DbContext ↔ Migration |
| WinForms / DevExpress | Designer ↔ partial Form | event ↔ handler | handler ↔ service | binding/Grid column ↔ DTO |
| Nexacro | component event ↔ handler | Dataset ↔ 서버 shape | transaction ↔ endpoint | callback ↔ output Dataset |

## 마이그레이션 시나리오 매트릭스

`migration-planner`가 사전 정의한 변환 시나리오입니다. 위험도는 LOW(1~2주 PoC), MEDIUM(1~3개월, 모듈 단위), HIGH(3~12개월, Phase 분리 + canary 필수), EXTREME(6개월 이상, 사실상 재작성) 네 단계입니다.

| 소스 → 타겟 | 매핑 템플릿 요약 | 위험도 |
|-------------|------------------|--------|
| Struts 1.x → Spring MVC/Boot | Action→Controller, ActionForm→DTO, struts-config.xml→`@RequestMapping` | HIGH |
| Struts 2.x → Spring Boot | `@Action`→`@RequestMapping`, interceptor→filter/aspect | MEDIUM |
| iBatis → MyBatis 3 | sqlmap→namespace, parameterClass→parameterType | MEDIUM |
| iBatis/MyBatis → JPA | XML 쿼리→JPQL/`@Query`, ResultMap→Entity | HIGH |
| EJB 2.x → Spring | Session Bean→`@Service`, Entity Bean→JPA, MDB→`@KafkaListener` | EXTREME |
| Spring 3~4 XML → Spring Boot 3 | applicationContext.xml→`@Configuration`+`@Bean` | MEDIUM |
| JSP scriptlet → Thymeleaf/React/Vue | `<%...%>`→template, taglib→directive | HIGH |
| Vue 2 → Vue 3 | Options API→`<script setup>`, `Vue.extend`→`defineComponent` | MEDIUM |
| Vuex → Pinia | mutations/actions→`defineStore` | MEDIUM |
| Nuxt 2 → Nuxt 3 | `asyncData/fetch`→`useAsyncData/useFetch`, Vuex→Pinia | HIGH |
| Vue CLI → Vite | `vue.config.js`→`vite.config.ts`, `VUE_APP_*`→`VITE_*` | LOW~MEDIUM |
| .NET Framework → .NET Core/8 | `web.config`→`appsettings.json`, `System.Web`→`Microsoft.AspNetCore.*` | HIGH |
| Oracle PL/SQL → Java/Service | 절차형→객체형, 패키지→서비스 클래스 | EXTREME |
| Oracle → PostgreSQL | 함수·타입·문법·시퀀스·힌트 차이 | HIGH |
| MySQL → MariaDB | 거의 호환, 일부 함수 차이 | LOW |
| jQuery → Vue/React | DOM 조작→컴포넌트, AJAX→fetch/axios | HIGH |
| AngularJS → Angular 15+ | 사실상 전면 재작성 | EXTREME |
| Java 8 → 17/21 | Records·Sealed·Pattern Matching, deprecated 제거 | LOW~MEDIUM |
| Python 2 → 3 | print·unicode·division·모듈 변경 | MEDIUM |
| Ant → Maven / Maven → Gradle | target→goal, pom.xml→build.gradle | MEDIUM |

## 신규 스택 추가 방법

플러그인 저장소를 수정할 수 있는 경우의 절차 요약입니다.

1. `agents/analyzer.md`의 Step 1~2 탐지 시그니처 표에 스택을 추가합니다.
2. 분석 깊이(HIGH/MEDIUM/LOW)를 정합니다.
3. `agents/qa.md`의 "스택별 boundary 검증 변형" 절에 Boundary 1~4 쌍을 정의합니다.
4. 필요하면 `agents/migration-planner.md`에 매핑 테이블 템플릿을 추가합니다.
5. 결정적 추출까지 지원하려면 `agents/lib/adapters/registry.mjs`에 확장자와 레벨을 등록하고 `build-index.mjs`에 추출 규칙을 더합니다.
6. 저장소 `docs/stack-matrix.md`를 갱신합니다.

특수 레거시 스택은 어댑터를 만들기 전이라도 `legacy-decoder`로 구조 분해와 의도 추정을 먼저 할 수 있습니다.

## 관련 문서

- [결정론적 인덱스](/concepts/deterministic-index.md)
- [판정과 게이트](/concepts/gates.md)
- [plan-migration](/skills/plan-migration.md)
- [qa](/agents/qa.md)
- [migration-planner](/agents/migration-planner.md)
- [legacy-decoder](/agents/legacy-decoder.md)
- [용어집](/reference/glossary.md)
