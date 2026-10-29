/*
 * 현대화 레시피 규칙 — Java 8 → 17/21, javax → jakarta, Oracle → PostgreSQL.
 *
 * 규칙은 줄 단위 정규식이다. fix 가 있으면 '자동'(의미가 같은 기계적 치환), 없으면 '수동'(사람이 판단해야 함 + 안내).
 * 자동은 확실히 같은 뜻인 것만 둔다 — 예: NVL → COALESCE 는 자동, ROWNUM → LIMIT 은 쿼리 모양에 따라 달라 수동.
 */

/**
 * @typedef {{
 *   id: string, recipe: string, title: string,
 *   files: RegExp, pattern: RegExp,
 *   fix?: (line: string, ctx: { target: number }) => string,
 *   guide: string,
 *   sqlOnly?: boolean,
 * }} Rule
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

  /* ---------------- Oracle → PostgreSQL ---------------- */
  { id: "PG-001", recipe: "oracle-pg", title: "NVL → COALESCE", files: SQL_HOST, sqlOnly: true, pattern: /\bNVL\s*\(/i, fix: (l) => l.replace(/\bNVL\s*\(/gi, "COALESCE("), guide: "인자 두 개의 NVL 은 COALESCE 와 같다. NVL2 는 CASE 로(수동)." },
  { id: "PG-002", recipe: "oracle-pg", title: "SYSDATE → LOCALTIMESTAMP", files: SQL_HOST, sqlOnly: true, pattern: /\bSYSDATE\b/i, fix: (l) => l.replace(/\bSYSDATE\b/gi, "LOCALTIMESTAMP"), guide: "SYSDATE 는 시간대 없는 현재 시각이다. 날짜만 쓰던 곳은 CURRENT_DATE 가 맞는지 확인한다(SYSDATE - 1 같은 날짜 산술은 interval 로)." },
  { id: "PG-003", recipe: "oracle-pg", title: "FROM DUAL 제거", files: SQL_HOST, sqlOnly: true, pattern: /\s+FROM\s+DUAL\b/i, fix: (l) => l.replace(/\s+FROM\s+DUAL\b/gi, ""), guide: "PostgreSQL 은 FROM 없는 SELECT 를 허용한다." },
  { id: "PG-004", recipe: "oracle-pg", title: "시퀀스 NEXTVAL·CURRVAL → nextval()", files: SQL_HOST, sqlOnly: true, pattern: /\b([A-Za-z_][\w$]*)\.(NEXTVAL|CURRVAL)\b/i, fix: (l) => l.replace(/\b([A-Za-z_][\w$]*)\.(NEXTVAL|CURRVAL)\b/gi, (_m, s, k) => `${String(k).toLowerCase()}('${String(s).toLowerCase()}')`), guide: "시퀀스 이름은 소문자로 만든다고 가정했다(따옴표로 만든 대문자 이름이면 '\"SEQ\"' 로)." },
  { id: "PG-005", recipe: "oracle-pg", title: "MINUS → EXCEPT", files: /\.(xml|sql|ddl)$/i, sqlOnly: true, pattern: /^\s*MINUS\s*$|\)\s*MINUS\s*\(|\bMINUS\s+SELECT\b/i, fix: (l) => l.replace(/\bMINUS\b/gi, "EXCEPT"), guide: "집합 차이는 EXCEPT. 중복 처리는 같다(EXCEPT ALL 과 구분)." },
  { id: "PG-006", recipe: "oracle-pg", title: "VARCHAR2·NUMBER(DDL) → VARCHAR·NUMERIC", files: SQL_FILE, pattern: /\b(VARCHAR2|NVARCHAR2|NUMBER)\b/i, fix: (l) => l.replace(/\bN?VARCHAR2\b/gi, "VARCHAR").replace(/\bNUMBER\b/gi, "NUMERIC"), guide: "VARCHAR2(n BYTE) 의 BYTE/CHAR 수식어는 지운다. 정수 키는 NUMERIC 대신 BIGINT 가 낫다(검토)." },
  { id: "PG-101", recipe: "oracle-pg", title: "ROWNUM", files: SQL_HOST, sqlOnly: true, pattern: /\bROWNUM\b/i, guide: "WHERE ROWNUM <= n 은 LIMIT n, 페이징(ROWNUM 이중 서브쿼리)은 LIMIT/OFFSET, 행 번호가 필요하면 ROW_NUMBER() OVER()." },
  { id: "PG-102", recipe: "oracle-pg", title: "DECODE", files: SQL_HOST, sqlOnly: true, pattern: /\bDECODE\s*\(/i, guide: "CASE WHEN 으로 바꾼다. DECODE 는 NULL = NULL 을 참으로 본다 — CASE 에서는 IS NOT DISTINCT FROM 으로." },
  { id: "PG-103", recipe: "oracle-pg", title: "(+) 외부 조인", files: SQL_HOST, sqlOnly: true, pattern: /\(\+\)/, guide: "LEFT/RIGHT OUTER JOIN … ON 으로 바꾼다. (+) 가 붙은 쪽이 NULL 이 허용되는 쪽이다." },
  { id: "PG-104", recipe: "oracle-pg", title: "CONNECT BY 계층 질의", files: SQL_HOST, sqlOnly: true, pattern: /\bCONNECT\s+BY\b|\bSTART\s+WITH\b/i, guide: "WITH RECURSIVE 로 바꾼다. LEVEL·SYS_CONNECT_BY_PATH·ORDER SIBLINGS BY 는 재귀 CTE 의 열로 직접 만든다." },
  { id: "PG-105", recipe: "oracle-pg", title: "MERGE INTO", files: SQL_HOST, sqlOnly: true, pattern: /\bMERGE\s+INTO\b/i, guide: "INSERT … ON CONFLICT (키) DO UPDATE 로 바꾼다(PostgreSQL 15+ 는 MERGE 도 지원하지만 문법이 조금 다르다)." },
  { id: "PG-106", recipe: "oracle-pg", title: "Oracle 전용 함수", files: SQL_HOST, sqlOnly: true, pattern: /\b(NVL2|INSTR|LISTAGG|ADD_MONTHS|MONTHS_BETWEEN|LAST_DAY|SYS_GUID|SUBSTRB|LENGTHB|TRUNC)\s*\(/i, guide: "NVL2 → CASE, INSTR → strpos/position, LISTAGG → string_agg, ADD_MONTHS → + interval 'n month', SYS_GUID → gen_random_uuid(), TRUNC(날짜) → date_trunc. 바이트 함수는 octet_length 등으로." },
  { id: "PG-107", recipe: "oracle-pg", title: "옵티마이저 힌트 /*+ */", files: SQL_HOST, sqlOnly: true, pattern: /\/\*\+/, guide: "PostgreSQL 은 힌트를 무시한다(주석으로 남음). 성능은 실행 계획(EXPLAIN)으로 다시 본다." },
  { id: "PG-108", recipe: "oracle-pg", title: "TO_DATE·TO_NUMBER 형식", files: SQL_HOST, sqlOnly: true, pattern: /\bTO_(DATE|NUMBER)\s*\(/i, guide: "PostgreSQL 에도 있지만 TO_DATE 는 date(시각 버림)를 돌려준다 — 시각이 필요하면 to_timestamp. 형식 문자 'RR'·'FM' 등을 확인한다." },
];

export const RECIPES = {
  java17: { title: "Java 8 → 17", rules: ["java"], target: 17 },
  java21: { title: "Java 8 → 21", rules: ["java", "java21"], target: 21 },
  jakarta: { title: "javax → jakarta (Jakarta EE 9+)", rules: ["jakarta"], target: 0 },
  "oracle-pg": { title: "Oracle → PostgreSQL (SQL)", rules: ["oracle-pg"], target: 0 },
};

/** 자바 파일에서 SQL 규칙은 문자열 안(SQL 처럼 보이는 줄)에만 */
export function looksLikeSqlLine(/** @type {string} */ file, /** @type {string} */ line) {
  if (!/\.java$/i.test(file)) return true;
  return /"[^"]*\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|SET|VALUES|JOIN|MERGE|UNION|MINUS)\b/i.test(line);
}
