/*
 * 현대화 레시피 규칙 — Java 8 → 17/21, javax → jakarta, Oracle → PostgreSQL.
 *
 * 규칙은 줄 단위 정규식이다. fix 가 있으면 '자동'(의미가 같은 기계적 치환), 없으면 '수동'(사람이 판단해야 함 + 안내).
 * 자동은 확실히 같은 뜻인 것만 둔다 — 예: NVL → COALESCE 는 자동, ROWNUM → LIMIT 은 쿼리 모양에 따라 달라 수동.
 * DECODE·NVL2·INSTR 은 한 줄에서 닫히는 호출만 자동(sqlconv.mjs), 나머지는 수동 — --draft 로 AI 초안을 받을 수 있다.
 * fileFix 는 여러 줄을 함께 봐야 하는 것(Maven 의존성 블록 등) — 줄 수를 바꾸지 않고 그 자리에서 고친다.
 */
import { decodeToCase, instrToStrpos, nvl2ToCase, rewriteCalls } from "./sqlconv.mjs";

/**
 * @typedef {{
 *   id: string, recipe: string, title: string,
 *   files: RegExp, pattern: RegExp,
 *   fix?: (line: string, ctx: FixCtx) => string,
 *   fileFix?: (lines: string[], ctx: FixCtx) => { line: number, before: string, after: string }[],
 *   partial?: boolean,
 *   guide: string,
 *   sqlOnly?: boolean,
 * }} Rule
 * @typedef {{ target: number, file: string, boot: string }} FixCtx
 */

const JAVA = /\.java$/i;
const JAVA_ISH = /\.(java|jsp|jspf|tag|xml|properties|ya?ml)$/i;
const BUILD = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|gradle\.properties)$/i;
const SQL_FILE = /\.(sql|ddl|pkb|pks|prc|fnc|trg)$/i;
const SQL_HOST = /\.(xml|sql|ddl|java)$/i;

/** jakarta 로 옮겨 간 Java EE 패키지 — JDK 에 남은 javax(crypto·net·sql·naming·xml.parsers·annotation.processing·transaction.xa …)는 건드리지 않는다 */
const EE = "(servlet|persistence|validation|ws\\.rs|inject|mail|xml\\.bind|ejb|faces|websocket|json|jws|enterprise|el|batch|jms|resource|interceptor|decorator|security\\.enterprise|security\\.auth\\.message|security\\.jacc)";
const EE_RE = new RegExp(`\\bjavax\\.(?=${EE}\\b)`, "g");
const TX_RE = /\bjavax\.(?=transaction\.(?!xa\b))/g;
const ANN_RE = /\bjavax\.(?=annotation\.(PostConstruct|PreDestroy|Resource|Resources|Generated|Priority|ManagedBean|security\.)\b)/g;

/** @type {Rule[]} */
export const RULES = [
  /* ---------------- javax → jakarta ---------------- */
  {
    id: "JK-001",
    recipe: "jakarta",
    title: "javax EE 패키지 → jakarta",
    files: JAVA_ISH,
    pattern: new RegExp(`\\bjavax\\.(${EE}\\b|transaction\\.(?!xa\\b)|annotation\\.(PostConstruct|PreDestroy|Resource|Resources|Generated|Priority|ManagedBean|security\\.))`),
    fix: (l) => l.replace(EE_RE, "jakarta.").replace(TX_RE, "jakarta.").replace(ANN_RE, "jakarta."),
    guide: "Jakarta EE 9+ 는 패키지 이름이 jakarta.* 다. JDK 에 남은 javax(crypto·net·sql·naming·xml.parsers 등)는 그대로 둔다.",
  },
  {
    id: "JK-002",
    recipe: "jakarta",
    title: "배치 서술자 네임스페이스 → jakartaee",
    files: /(^|\/)(web|persistence|beans|faces-config|ejb-jar|application|validation)\.xml$/i,
    pattern: /https?:\/\/(xmlns\.jcp\.org\/xml\/ns\/(javaee|persistence)|java\.sun\.com\/xml\/ns\/(javaee|persistence))/,
    fix: (l) => l.replace(/https?:\/\/(xmlns\.jcp\.org|java\.sun\.com)\/xml\/ns\/javaee/g, "https://jakarta.ee/xml/ns/jakartaee").replace(/https?:\/\/(xmlns\.jcp\.org|java\.sun\.com)\/xml\/ns\/persistence/g, "https://jakarta.ee/xml/ns/persistence"),
    guide: "네임스페이스를 바꾼 뒤 version 속성(web-app 6.0, persistence 3.1 등)과 스키마 위치도 맞춘다.",
  },
  {
    id: "JK-003",
    recipe: "jakarta",
    title: "javax 의존성 — jakarta 좌표로 바꿔야 함",
    files: BUILD,
    pattern: /(<groupId>\s*javax\.(servlet|persistence|validation|ws\.rs|inject|mail|xml\.bind|annotation|transaction)\s*<\/groupId>|['"]javax\.(servlet|persistence|validation|ws\.rs|inject|mail|xml\.bind|annotation|transaction):)/,
    guide: "예: javax.servlet:javax.servlet-api → jakarta.servlet:jakarta.servlet-api(6.x), javax.persistence → jakarta.persistence:jakarta.persistence-api(3.1). Spring 은 6.x(Boot 3.x), Hibernate 6.x, Tomcat 10.1+ 가 함께 필요하다.",
  },

  /* ---------------- Java 8 → 17/21 ---------------- */
  {
    id: "JV-001",
    recipe: "java",
    title: "빌드 대상 1.8 → 새 버전",
    files: BUILD,
    pattern: /(<(maven\.compiler\.(source|target|release)|java\.version|source|target|release)>\s*1\.8\s*<|(source|target)Compatibility\s*=\s*['"]?(1\.8|JavaVersion\.VERSION_1_8)['"]?)/,
    fix: (l, c) =>
      l
        .replace(/(<(maven\.compiler\.(source|target|release)|java\.version|source|target|release)>\s*)1\.8(\s*<)/g, `$1${c.target}$4`)
        .replace(/((source|target)Compatibility\s*=\s*)(['"]?)1\.8\3/g, `$1$3${c.target}$3`)
        .replace(/JavaVersion\.VERSION_1_8/g, `JavaVersion.VERSION_${c.target}`),
    guide: "컴파일러 플러그인은 3.8 이상, Surefire 2.22+ 가 필요하다. 가능하면 source/target 대신 release 를 쓴다.",
  },
  {
    id: "JV-002",
    recipe: "java",
    title: "박싱 생성자(new Integer 등) → valueOf",
    files: JAVA,
    pattern: /\bnew\s+(Integer|Long|Short|Byte|Double|Float|Boolean|Character)\s*\(/,
    fix: (l) => l.replace(/\bnew\s+(Integer|Long|Short|Byte|Double|Float|Boolean|Character)\s*\(/g, "$1.valueOf("),
    guide: "Java 9 부터 폐기 예정, 16 부터 경고. valueOf 는 캐시를 써 결과가 같다(== 비교에 기대던 코드는 원래 버그).",
  },
  {
    id: "JV-003",
    recipe: "java",
    title: "sun.misc.BASE64 → java.util.Base64",
    files: JAVA,
    pattern: /\bsun\.misc\.BASE64(En|De)coder\b|new\s+BASE64(En|De)coder\s*\(/,
    guide: "JDK 9 에서 제거. Base64.getEncoder().encodeToString(bytes) / Base64.getMimeDecoder().decode(str) 로 바꾼다(줄바꿈이 섞인 값은 MIME 디코더).",
  },
  {
    id: "JV-004",
    recipe: "java",
    title: "JDK 에서 빠진 javax.xml.bind·javax.activation·javax.annotation",
    files: JAVA,
    pattern: /\bimport\s+javax\.(xml\.bind|activation|xml\.ws|jws)\b/,
    guide: "JDK 11 에서 제거. 의존성을 추가한다(jakarta.xml.bind-api + 구현 glassfish jaxb-runtime). jakarta 레시피를 함께 돌리면 패키지 이름도 바뀐다.",
  },
  {
    id: "JV-005",
    recipe: "java",
    title: "Nashorn(자바스크립트 엔진) 사용",
    files: JAVA,
    pattern: /getEngineByName\s*\(\s*"(nashorn|javascript|js|JavaScript)"\s*\)|jdk\.nashorn\./,
    guide: "JDK 15 에서 제거. 독립 org.openjdk.nashorn:nashorn-core 를 넣거나 GraalJS 로 옮긴다. 엔진이 null 이면 NPE 로 죽는다.",
  },
  {
    id: "JV-006",
    recipe: "java",
    title: "finalize() 재정의",
    files: JAVA,
    pattern: /\b(protected|public)\s+void\s+finalize\s*\(\s*\)/,
    guide: "JDK 18 부터 제거 예정(JEP 421). try-with-resources(AutoCloseable)나 java.lang.ref.Cleaner 로 옮긴다.",
  },
  {
    id: "JV-007",
    recipe: "java",
    title: "Thread.stop·suspend·resume",
    files: JAVA,
    pattern: /\b\w*[Tt]hread\w*(\(\))?\s*\.\s*(stop|suspend|resume)\s*\(\s*\)/,
    guide: "JDK 20+ 에서 Thread.stop 은 UnsupportedOperationException. 인터럽트 플래그나 종료 신호 변수로 바꾼다(Thread 가 아닌 객체의 stop() 이면 무시).",
  },
  {
    id: "JV-008",
    recipe: "java",
    title: "SecurityManager 사용",
    files: JAVA,
    pattern: /\b(System\.(get|set)SecurityManager|extends\s+SecurityManager)\b/,
    guide: "JDK 17 에서 폐기 예정(JEP 411), 이후 동작하지 않는다. 권한 검사는 애플리케이션 로직·컨테이너 설정으로 옮긴다.",
  },
  {
    id: "JV-009",
    recipe: "java",
    title: "내부 API(sun.*·com.sun.*) 직접 사용",
    files: JAVA,
    pattern: /\bimport\s+(sun\.(?!misc\.BASE64)|com\.sun\.(image\.codec|net\.ssl\.internal|org\.apache))/,
    guide: "JDK 16 부터 강한 캡슐화로 기본 차단. 공개 API 로 바꾸거나(예: com.sun.image.codec.jpeg → javax.imageio) 마지막 수단으로 --add-opens 를 단다.",
  },
  {
    id: "JV-010",
    recipe: "java21",
    title: "URL(String)·Locale(String) 생성자",
    files: JAVA,
    pattern: /\bnew\s+(URL|Locale)\s*\(/,
    guide: "JDK 19·20 에서 폐기 예정. URI.create(s).toURL(), Locale.of(lang, country) 로 바꾼다.",
  },

  /* ---------------- Spring Boot 2 → 3 ---------------- */
  {
    id: "BT-001",
    recipe: "boot3",
    title: "Spring Boot 버전 2.x → 3.x",
    files: BUILD,
    pattern: /spring-boot-starter-parent|spring-boot\.version|org\.springframework\.boot['"]?\)?\s+version|spring-boot-gradle-plugin:2\.|springBootVersion\s*=|io\.spring\.dependency-management['"]?\)?\s+version\s+['"]1\.0\./,
    fileFix: (lines, c) => {
      /** @type {{ line: number, before: string, after: string }[]} */
      const out = [];
      const set = (/** @type {number} */ i, /** @type {string} */ after) => {
        const before = /** @type {string} */ (lines[i]);
        if (after !== before) {
          out.push({ line: i + 1, before, after });
          lines[i] = after;
        }
      };
      lines.forEach((l, i) => {
        // Maven 부모 — artifactId 다음 몇 줄 안의 version
        if (/<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>/.test(l)) {
          for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
            const v = /** @type {string} */ (lines[j]);
            if (/<\/parent>/.test(v)) break;
            if (/<version>\s*2\.\d+\.\d+[\w.-]*\s*<\/version>/.test(v)) set(j, v.replace(/(<version>\s*)2\.\d+\.\d+[\w.-]*(\s*<\/version>)/, `$1${c.boot}$2`));
          }
        }
        set(i, (lines[i] ?? "")
          .replace(/(<spring-boot\.version>\s*)2\.\d+\.\d+[\w.-]*(\s*<\/spring-boot\.version>)/, `$1${c.boot}$2`)
          .replace(/(id\s*\(?\s*['"]org\.springframework\.boot['"]\s*\)?\s+version\s+['"])2\.\d+\.\d+[\w.-]*(['"])/, `$1${c.boot}$2`)
          .replace(/(spring-boot-gradle-plugin:)2\.\d+\.\d+[\w.-]*/, `$1${c.boot}`)
          .replace(/(springBootVersion\s*=\s*['"])2\.\d+\.\d+[\w.-]*(['"])/, `$1${c.boot}$2`)
          .replace(/(id\s*\(?\s*['"]io\.spring\.dependency-management['"]\s*\)?\s+version\s+['"])1\.0\.[\w.-]+(['"])/, (_m, a, b) => `${a}1.1.7${b}`));
      });
      return out;
    },
    guide: "부모·플러그인 버전을 3.x 로 올린다(--boot 로 지정, 기본 3.5.0 — 최신 3.5.x 패치를 쓴다). Java 17 이상이 필요하다(java17 레시피 먼저). 버전이 속성 참조(${...})면 그 속성을 직접 고친다.",
  },
  {
    id: "BT-002",
    recipe: "boot3",
    title: "javax 의존성 좌표 → jakarta",
    files: BUILD,
    pattern: /javax\.(servlet|persistence|validation|annotation|xml\.bind|transaction|inject|mail|ws\.rs|websocket)/,
    fileFix: (lines) => {
      /** @type {{ line: number, before: string, after: string }[]} */
      const out = [];
      const set = (/** @type {number} */ i, /** @type {string} */ after) => {
        const before = /** @type {string} */ (lines[i]);
        if (after !== before) {
          out.push({ line: i + 1, before, after });
          lines[i] = after;
        }
      };
      // Gradle 문자열 좌표 'g:a[:v]'
      lines.forEach((l, i) => {
        set(i, l.replace(/(['"])(javax\.[\w.]+):([\w.-]+)(?::([\w.-]+))?\1/g, (m, q, g, a, v) => {
          const to = JAKARTA_COORDS[`${g}:${a}`];
          return to ? `${q}${to.g}:${to.a}${v ? `:${to.v}` : ""}${q}` : m;
        }));
      });
      // Maven <dependency> 블록
      for (let i = 0; i < lines.length; i++) {
        if (!/<dependency>/.test(/** @type {string} */ (lines[i]))) continue;
        let end = i;
        while (end < lines.length - 1 && end - i < 12 && !/<\/dependency>/.test(/** @type {string} */ (lines[end]))) end++;
        const block = lines.slice(i, end + 1).join("\n");
        const g = block.match(/<groupId>\s*([\w.-]+)\s*<\/groupId>/)?.[1];
        const a = block.match(/<artifactId>\s*([\w.-]+)\s*<\/artifactId>/)?.[1];
        const to = g && a ? JAKARTA_COORDS[`${g}:${a}`] : undefined;
        if (!to) continue;
        for (let j = i; j <= end; j++) {
          const l = /** @type {string} */ (lines[j]);
          set(j, l.replace(/(<groupId>\s*)[\w.-]+(\s*<\/groupId>)/, `$1${to.g}$2`).replace(/(<artifactId>\s*)[\w.-]+(\s*<\/artifactId>)/, `$1${to.a}$2`).replace(/(<version>\s*)\d[\w.-]*(\s*<\/version>)/, `$1${to.v}$2`));
        }
        i = end;
      }
      return out;
    },
    guide: "Jakarta EE 9+ 좌표로 바꾼다(예: javax.servlet-api → jakarta.servlet-api 6.0.0). Spring Boot 가 버전을 관리하면 version 을 지워도 된다. 표에 없는 javax 의존성은 JK-003(수동)에 남는다.",
  },
  {
    id: "BT-003",
    recipe: "boot3",
    title: "이름이 바뀐 설정 키(application.properties)",
    files: /(^|\/)application[\w-]*\.properties$/i,
    pattern: /^\s*(spring\.redis\.|spring\.data\.cassandra\.|server\.max-http-header-size|management\.metrics\.export\.\w+\.)/,
    fix: (l) =>
      l
        .replace(/^(\s*)spring\.redis\./, "$1spring.data.redis.")
        .replace(/^(\s*)spring\.data\.cassandra\./, "$1spring.cassandra.")
        .replace(/^(\s*)server\.max-http-header-size/, "$1server.max-http-request-header-size")
        .replace(/^(\s*)management\.metrics\.export\.(\w+)\./, "$1management.$2.metrics.export."),
    guide: "Boot 3.0 에서 바뀐 키. spring-boot-properties-migrator 를 잠시 넣고 기동하면 남은 것을 로그로 알려 준다.",
  },
  {
    id: "BT-004",
    recipe: "boot3",
    title: "이름이 바뀐 설정 키(application.yml)",
    files: /(^|\/)application[\w-]*\.ya?ml$/i,
    pattern: /^\s+(redis|cassandra):\s*$|^\s*max-http-header-size:|^\s+export:\s*$/,
    guide: "spring.redis → spring.data.redis, spring.data.cassandra → spring.cassandra, server.max-http-header-size → max-http-request-header-size, management.metrics.export.<x> → management.<x>.metrics.export. YAML 은 들여쓰기를 옮겨야 해서 수동.",
  },
  {
    id: "BT-005",
    recipe: "boot3",
    title: "WebSecurityConfigurerAdapter 제거(Spring Security 6)",
    files: JAVA,
    pattern: /\bWebSecurityConfigurerAdapter\b/,
    guide: "SecurityFilterChain 을 돌려주는 @Bean 메서드로 옮긴다. configure(AuthenticationManagerBuilder) 는 UserDetailsService·AuthenticationManager 빈으로.",
  },
  {
    id: "BT-006",
    recipe: "boot3",
    title: "antMatchers·authorizeRequests (Spring Security 6)",
    files: JAVA,
    pattern: /\.(antMatchers|mvcMatchers|regexMatchers|authorizeRequests)\s*\(/,
    guide: "requestMatchers(…)·authorizeHttpRequests(…) 로 바꾼다. 경로 일치 규칙이 조금 다르므로(끝 슬래시 등) 보안 테스트로 확인한다.",
  },
  {
    id: "BT-007",
    recipe: "boot3",
    title: "자동 구성 등록(spring.factories)",
    files: /(^|\/)META-INF\/spring\.factories$/,
    pattern: /EnableAutoConfiguration\s*=/,
    guide: "Boot 3 는 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports 에 한 줄에 하나씩 적는다(클래스에는 @AutoConfiguration).",
  },
  {
    id: "BT-008",
    recipe: "boot3",
    title: "Hibernate 버전별 방언 → 공통 방언(Hibernate 6)",
    files: /\.(properties|ya?ml|xml|java)$/i,
    pattern: /org\.hibernate\.dialect\.(Oracle\d+[a-z]?Dialect|PostgreSQL\d+Dialect|MySQL\d+\w*Dialect|SQLServer\d+Dialect|MariaDB\d+Dialect)\b/,
    fix: (l) =>
      l
        .replace(/org\.hibernate\.dialect\.Oracle\d+[a-z]?Dialect\b/g, "org.hibernate.dialect.OracleDialect")
        .replace(/org\.hibernate\.dialect\.PostgreSQL\d+Dialect\b/g, "org.hibernate.dialect.PostgreSQLDialect")
        .replace(/org\.hibernate\.dialect\.MySQL\d+\w*Dialect\b/g, "org.hibernate.dialect.MySQLDialect")
        .replace(/org\.hibernate\.dialect\.SQLServer\d+Dialect\b/g, "org.hibernate.dialect.SQLServerDialect")
        .replace(/org\.hibernate\.dialect\.MariaDB\d+Dialect\b/g, "org.hibernate.dialect.MariaDBDialect"),
    guide: "Hibernate 6 은 접속한 DB 버전을 보고 맞춘다 — 버전 붙은 방언은 폐기·이동됐다. 방언 설정 자체를 지워도 된다.",
  },
  {
    id: "BT-009",
    recipe: "boot3",
    title: "@Type(type=…)·@TypeDef (Hibernate 6)",
    files: JAVA,
    pattern: /@Type\s*\(\s*type\s*=|@TypeDefs?\s*\(/,
    guide: "Hibernate 6 은 @Type(값클래스.class)·@JdbcTypeCode·AttributeConverter 로 바뀌었다. hibernate-types 를 쓰면 hypersistence-utils 로.",
  },

  /* ---------------- Oracle → PostgreSQL ---------------- */
  { id: "PG-001", recipe: "oracle-pg", title: "NVL → COALESCE", files: SQL_HOST, sqlOnly: true, pattern: /\bNVL\s*\(/i, fix: (l) => l.replace(/\bNVL\s*\(/gi, "COALESCE("), guide: "인자 두 개의 NVL 은 COALESCE 와 같다. NVL2 는 CASE 로(수동)." },
  { id: "PG-002", recipe: "oracle-pg", title: "SYSDATE → LOCALTIMESTAMP", files: SQL_HOST, sqlOnly: true, pattern: /\bSYSDATE\b/i, fix: (l) => l.replace(/\bSYSDATE\b/gi, "LOCALTIMESTAMP"), guide: "SYSDATE 는 시간대 없는 현재 시각이다. 날짜만 쓰던 곳은 CURRENT_DATE 가 맞는지 확인한다(SYSDATE - 1 같은 날짜 산술은 interval 로)." },
  { id: "PG-003", recipe: "oracle-pg", title: "FROM DUAL 제거", files: SQL_HOST, sqlOnly: true, pattern: /\s+FROM\s+DUAL\b/i, fix: (l) => l.replace(/\s+FROM\s+DUAL\b/gi, ""), guide: "PostgreSQL 은 FROM 없는 SELECT 를 허용한다." },
  { id: "PG-004", recipe: "oracle-pg", title: "시퀀스 NEXTVAL·CURRVAL → nextval()", files: SQL_HOST, sqlOnly: true, pattern: /\b([A-Za-z_][\w$]*)\.(NEXTVAL|CURRVAL)\b/i, fix: (l) => l.replace(/\b([A-Za-z_][\w$]*)\.(NEXTVAL|CURRVAL)\b/gi, (_m, s, k) => `${String(k).toLowerCase()}('${String(s).toLowerCase()}')`), guide: "시퀀스 이름은 소문자로 만든다고 가정했다(따옴표로 만든 대문자 이름이면 '\"SEQ\"' 로)." },
  { id: "PG-005", recipe: "oracle-pg", title: "MINUS → EXCEPT", files: /\.(xml|sql|ddl)$/i, sqlOnly: true, pattern: /^\s*MINUS\s*$|\)\s*MINUS\s*\(|\bMINUS\s+SELECT\b/i, fix: (l) => l.replace(/\bMINUS\b/gi, "EXCEPT"), guide: "집합 차이는 EXCEPT. 중복 처리는 같다(EXCEPT ALL 과 구분)." },
  { id: "PG-006", recipe: "oracle-pg", title: "VARCHAR2·NUMBER(DDL) → VARCHAR·NUMERIC", files: SQL_FILE, pattern: /\b(VARCHAR2|NVARCHAR2|NUMBER)\b/i, fix: (l) => l.replace(/\bN?VARCHAR2\b/gi, "VARCHAR").replace(/\bNUMBER\b/gi, "NUMERIC"), guide: "VARCHAR2(n BYTE) 의 BYTE/CHAR 수식어는 지운다. 정수 키는 NUMERIC 대신 BIGINT 가 낫다(검토)." },
  { id: "PG-101", recipe: "oracle-pg", title: "ROWNUM", files: SQL_HOST, sqlOnly: true, pattern: /\bROWNUM\b/i, guide: "WHERE ROWNUM <= n 은 LIMIT n, 페이징(ROWNUM 이중 서브쿼리)은 LIMIT/OFFSET, 행 번호가 필요하면 ROW_NUMBER() OVER()." },
  { id: "PG-102", recipe: "oracle-pg", title: "DECODE → CASE", files: SQL_HOST, sqlOnly: true, partial: true, pattern: /\bDECODE\s*\(/i, fix: (l, c) => rewriteCalls(l, "DECODE", decodeToCase, { java: JAVA.test(c.file) }), guide: "한 줄에서 닫히는 DECODE 는 CASE 로 자동(찾는 값에 NULL·컬럼이 있으면 IS NULL·IS NOT DISTINCT FROM — DECODE 는 NULL = NULL 을 참으로 본다). 여러 줄에 걸친 것은 수동(--draft). 결과 값의 타입이 섞이면(숫자·문자) PostgreSQL 은 오류이므로 빌드·테스트로 확인한다." },
  { id: "PG-007", recipe: "oracle-pg", title: "NVL2 → CASE", files: SQL_HOST, sqlOnly: true, partial: true, pattern: /\bNVL2\s*\(/i, fix: (l, c) => rewriteCalls(l, "NVL2", nvl2ToCase, { java: JAVA.test(c.file) }), guide: "NVL2(a, b, c) = CASE WHEN a IS NOT NULL THEN b ELSE c END." },
  { id: "PG-008", recipe: "oracle-pg", title: "INSTR(인자 두 개) → strpos", files: SQL_HOST, sqlOnly: true, partial: true, pattern: /\bINSTR\s*\(/i, fix: (l, c) => rewriteCalls(l, "INSTR", instrToStrpos, { java: JAVA.test(c.file) }), guide: "인자 두 개의 INSTR 은 strpos 와 같다. 시작 위치·n번째가 있으면 수동(position·regexp_instr 또는 함수)." },
  { id: "PG-103", recipe: "oracle-pg", title: "(+) 외부 조인", files: SQL_HOST, sqlOnly: true, pattern: /\(\+\)/, guide: "LEFT/RIGHT OUTER JOIN … ON 으로 바꾼다. (+) 가 붙은 쪽이 NULL 이 허용되는 쪽이다." },
  { id: "PG-104", recipe: "oracle-pg", title: "CONNECT BY 계층 질의", files: SQL_HOST, sqlOnly: true, pattern: /\bCONNECT\s+BY\b|\bSTART\s+WITH\b/i, guide: "WITH RECURSIVE 로 바꾼다. LEVEL·SYS_CONNECT_BY_PATH·ORDER SIBLINGS BY 는 재귀 CTE 의 열로 직접 만든다." },
  { id: "PG-105", recipe: "oracle-pg", title: "MERGE INTO", files: SQL_HOST, sqlOnly: true, pattern: /\bMERGE\s+INTO\b/i, guide: "INSERT … ON CONFLICT (키) DO UPDATE 로 바꾼다(PostgreSQL 15+ 는 MERGE 도 지원하지만 문법이 조금 다르다)." },
  { id: "PG-106", recipe: "oracle-pg", title: "Oracle 전용 함수", files: SQL_HOST, sqlOnly: true, pattern: /\b(LISTAGG|ADD_MONTHS|MONTHS_BETWEEN|LAST_DAY|SYS_GUID|SUBSTRB|LENGTHB|TRUNC)\s*\(/i, guide: "LISTAGG → string_agg, ADD_MONTHS → + interval 'n month', SYS_GUID → gen_random_uuid(), TRUNC(날짜) → date_trunc. 바이트 함수는 octet_length 등으로." },
  { id: "PG-107", recipe: "oracle-pg", title: "옵티마이저 힌트 /*+ */", files: SQL_HOST, sqlOnly: true, pattern: /\/\*\+/, guide: "PostgreSQL 은 힌트를 무시한다(주석으로 남음). 성능은 실행 계획(EXPLAIN)으로 다시 본다." },
  { id: "PG-108", recipe: "oracle-pg", title: "TO_DATE·TO_NUMBER 형식", files: SQL_HOST, sqlOnly: true, pattern: /\bTO_(DATE|NUMBER)\s*\(/i, guide: "PostgreSQL 에도 있지만 TO_DATE 는 date(시각 버림)를 돌려준다 — 시각이 필요하면 to_timestamp. 형식 문자 'RR'·'FM' 등을 확인한다." },
];

/** javax → jakarta 의존성 좌표(Jakarta EE 10 기준 버전) */
const JAKARTA_COORDS = /** @type {Record<string, { g: string, a: string, v: string }>} */ ({
  "javax.servlet:javax.servlet-api": { g: "jakarta.servlet", a: "jakarta.servlet-api", v: "6.0.0" },
  "javax.persistence:javax.persistence-api": { g: "jakarta.persistence", a: "jakarta.persistence-api", v: "3.1.0" },
  "javax.validation:validation-api": { g: "jakarta.validation", a: "jakarta.validation-api", v: "3.0.2" },
  "javax.annotation:javax.annotation-api": { g: "jakarta.annotation", a: "jakarta.annotation-api", v: "2.1.1" },
  "javax.xml.bind:jaxb-api": { g: "jakarta.xml.bind", a: "jakarta.xml.bind-api", v: "4.0.2" },
  "javax.transaction:javax.transaction-api": { g: "jakarta.transaction", a: "jakarta.transaction-api", v: "2.0.1" },
  "javax.inject:javax.inject": { g: "jakarta.inject", a: "jakarta.inject-api", v: "2.0.1" },
  "javax.mail:javax.mail-api": { g: "jakarta.mail", a: "jakarta.mail-api", v: "2.1.3" },
  "javax.ws.rs:javax.ws.rs-api": { g: "jakarta.ws.rs", a: "jakarta.ws.rs-api", v: "3.1.0" },
  "javax.websocket:javax.websocket-api": { g: "jakarta.websocket", a: "jakarta.websocket-api", v: "2.1.1" },
});

export const RECIPES = {
  java17: { title: "Java 8 → 17", rules: ["java"], target: 17 },
  java21: { title: "Java 8 → 21", rules: ["java", "java21"], target: 21 },
  jakarta: { title: "javax → jakarta (Jakarta EE 9+)", rules: ["jakarta"], target: 0 },
  "oracle-pg": { title: "Oracle → PostgreSQL (SQL)", rules: ["oracle-pg"], target: 0 },
  boot3: { title: "Spring Boot 2 → 3 (javax → jakarta 포함)", rules: ["boot3", "jakarta"], target: 0 },
};

/** 자바 파일에서 SQL 규칙은 문자열 안(SQL 처럼 보이는 줄)에만 */
export function looksLikeSqlLine(/** @type {string} */ file, /** @type {string} */ line) {
  if (!/\.java$/i.test(file)) return true;
  return /"[^"]*\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|SET|VALUES|JOIN|MERGE|UNION|MINUS)\b/i.test(line);
}
