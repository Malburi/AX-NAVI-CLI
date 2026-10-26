/*
 * 결정론적 보안·부작용 규칙.
 *
 * 기준은 둘이다 — agents/analyzer.md Step 14.5(OWASP Top 10 매핑)와 agents/change-safety.md 의
 * "즉시 STOP 트리거". 같은 규칙을 diff 리뷰(axnavi review)와 전수 점검(axnavi scan security)이
 * 함께 쓴다. LLM 없이 돌기 때문에 CI 게이트로 쓸 수 있고, 같은 입력에는 항상 같은 답을 낸다.
 *
 * 정규식이 잡는 것은 "의심 지점"이다. 오탐을 줄이려고 규칙을 느슨하게 하지 않고,
 * 의도된 사용이면 그 줄(또는 바로 윗줄)에 `axnavi:allow <규칙ID> <사유>` 를 적어 억제한다.
 * 억제한 항목도 리포트에 남는다 — 조용히 사라지는 예외는 감사에서 문제가 된다.
 *
 * 시크릿 원문은 어디에도 옮기지 않는다(analyzer Step 14.5 "시크릿 원문 인용 금지"와 같은 이유).
 */

/**
 * @typedef {"critical" | "high" | "medium" | "low"} Severity
 * @typedef {"security" | "side_effect" | "rollback"} Dimension
 * @typedef {{
 *   id: string, title: string, dimension: Dimension, severity: Severity,
 *   stop?: boolean, owasp?: string | null, cwe?: string,
 *   files?: RegExp, pattern?: RegExp, match?: (text: string) => boolean, unless?: RegExp, removed?: boolean,
 *   stopWhen?: RegExp, redact?: boolean, inComments?: boolean, lookahead?: { lines: number, absent: RegExp },
 *   impact: string, fix: string, weight?: number,
 * }} Rule
 * @typedef {{
 *   rule: string, title: string, dimension: Dimension, severity: Severity, stop: boolean,
 *   owasp: string | null, cwe: string | null, file: string, line: number, side: "added" | "removed" | "current",
 *   snippet: string, impact: string, fix: string, suppressed?: string, suppressedInChange?: boolean,
 * }} Finding
 */

const SRC = /\.(java|kt|kts|scala|groovy|cs|py|go|rb|php|[cm]?[jt]sx?|jsp|jspf|vue)$/i;
const SQL_HOST = /\.(java|kt|kts|scala|groovy|cs|py|go|rb|php|[cm]?[jt]sx?|jsp|jspf)$/i;
/** SQL 매퍼만 — Ant build.xml·스프링 설정의 ${프로퍼티} 는 치환 구문이 아니다 */
const MAPPER = /(^|\/)(mappers?|query|queries|sqlmaps?|sql)\/.*\.xml$|(mapper|query|sqlmap|-sql|_sql)[^/]*\.xml$/i;

/*
 * SQL 결합 판정. 정규식 하나로는 대소문자 감도를 섞을 수 없어 함수로 둔다.
 * 문자열 리터럴이 식별자와 `+` 로 이어지고, 그 리터럴이 SQL 이면 결합으로 본다.
 * - SELECT…FROM · WHERE · INSERT INTO · UPDATE…SET · DELETE FROM · ORDER/GROUP BY 는 대소문자 무시
 * - AND · OR · IN · LIKE 는 대문자일 때만 — 영어 문장("request and response")을 SQL 로 오인했다(실측)
 * - HTML 조각('<tr>' + n)은 제외 — JSP 의 jQuery 화면 조립이 대부분이었다(실측)
 */
const SQL_STRONG = /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+[\w.]+\s+SET|DELETE\s+FROM|WHERE|ORDER\s+BY|GROUP\s+BY)\b/i;
const SQL_UPPER = /(^|[^\w])(AND|OR|IN|LIKE|SET|VALUES)\b/;
const CONCAT = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\+\s*[A-Za-z_$(]|[A-Za-z_$\])][\w$.]*\s*\+\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
function sqlConcat(/** @type {string} */ text) {
  for (const m of text.matchAll(CONCAT)) {
    const lit = (m[1] ?? m[2] ?? "").slice(1, -1);
    if (/<\/?[a-z][\w-]*[\s>]/i.test(lit)) continue;
    if (SQL_STRONG.test(lit) || (SQL_UPPER.test(lit) && /[=<>]|\(|'/.test(lit))) return true;
  }
  return /\bf["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*\{[^}]+\}|`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^`]*\$\{[^}]+\}[^`]*`|\b(SELECT|UPDATE|DELETE|INSERT)\b[^"']*["']\s*%\s*\(?[A-Za-z_]/i.test(text);
}
const SQL_FILE = /\.(sql|ddl|xml|pc|pkb|pks|prc|fnc|trg)$/i;

/** @type {Rule[]} */
export const RULES = [
  /* ---------------- 즉시 STOP — change-safety 의 트리거와 1:1 ---------------- */
  {
    id: "SEC-SECRET",
    title: "비밀번호·키 평문 하드코딩",
    dimension: "security", severity: "critical", stop: true, owasp: "A02:2021", cwe: "CWE-798",
    inComments: true, // 주석 안의 키도 유출이다
    pattern: /\b(pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{6,}["']/i,
    unless: /["']\s*(\$\{|<|%|\{\{)|(changeme|change_me|your[_-]|example|sample|dummy|placeholder|xxxx|\*{3,})/i,
    redact: true,
    impact: "저장소를 볼 수 있는 누구나 운영 자격 증명을 얻는다. 이력에 남아 커밋을 되돌려도 노출은 끝나지 않는다.",
    fix: "환경변수·시크릿 저장소(Vault, Jasypt 등)로 옮기고, 이미 커밋된 값은 즉시 교체한다.",
  },
  {
    id: "SEC-PRIVATE-KEY",
    title: "개인키 원문 포함",
    dimension: "security", severity: "critical", stop: true, owasp: "A02:2021", cwe: "CWE-321",
    inComments: true, // 주석 안의 키도 유출이다
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    redact: true,
    impact: "서명·암호화 키가 유출되면 위조·복호화가 가능해진다.",
    fix: "키 파일을 저장소에서 제거하고 키를 재발급한다. 배포 시 시크릿으로 주입한다.",
  },
  {
    id: "SEC-CLOUD-KEY",
    title: "클라우드 액세스 키 포함",
    dimension: "security", severity: "critical", stop: true, owasp: "A02:2021", cwe: "CWE-798",
    inComments: true, // 주석 안의 키도 유출이다
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
    redact: true,
    impact: "외부 클라우드·API 계정이 도용될 수 있다(과금·데이터 유출).",
    fix: "키를 폐기·재발급하고 시크릿 저장소로 옮긴다.",
  },
  {
    id: "SEC-SQLI-CONCAT",
    title: "SQL 문자열 결합(인젝션 가능)",
    dimension: "security", severity: "critical", stop: true, owasp: "A03:2021", cwe: "CWE-89",
    files: SQL_HOST,
    match: sqlConcat,
    // 로그 문장 안의 "delete from " + path 같은 것은 SQL 이 아니다(실측)
    unless: /(\blog|\bLOG|[lL]ogger(\(\))?|\bconsole)\s*\.\s*(trace|debug|info|warn|error|log)\s*\(|System\.(out|err)\.print|\bprint(ln)?\s*\(/,
    impact: "외부 입력이 쿼리에 그대로 들어가면 데이터 조회·변조·삭제가 가능하다.",
    fix: "PreparedStatement·바인드 변수(#{}, ?, :name)로 바꾼다. 컬럼·정렬처럼 바인딩이 안 되는 값은 허용 목록으로 검증한다.",
  },
  {
    id: "SEC-SQLI-MYBATIS",
    title: "MyBatis/iBatis ${} 직접 치환",
    dimension: "security", severity: "high", stop: true, owasp: "A03:2021", cwe: "CWE-89",
    files: MAPPER,
    pattern: /\$\{[^}]+\}|\$[A-Za-z_][\w.]*\$/,
    unless: /\$\{\s*_databaseId\s*\}|<!--/,
    impact: "#{} 와 달리 값이 SQL 문장에 그대로 들어간다. 사용자 입력이 닿으면 인젝션이 된다.",
    fix: "#{} 로 바꾼다. 정렬 컬럼 등 불가피하면 서버에서 허용 목록 검증 후 `axnavi:allow SEC-SQLI-MYBATIS <검증 위치>` 를 남긴다.",
  },
  {
    id: "SEC-DATA-LOSS",
    title: "데이터 손실 가능 DDL/DML",
    dimension: "rollback", severity: "critical", stop: true, owasp: null, cwe: "CWE-1188",
    files: SQL_FILE,
    pattern: /\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|SEQUENCE)\b|\bTRUNCATE\s+(TABLE\s+)?\w|\bALTER\s+TABLE\s+[\w.]+\s+DROP\b/i,
    impact: "되돌릴 수 없는 데이터·구조 삭제다. 코드 롤백으로 복구되지 않는다.",
    fix: "백업·복구 절차와 다운 마이그레이션을 함께 제출한다.",
  },
  {
    id: "SEC-DELETE-ALL",
    title: "WHERE 없는 DELETE",
    dimension: "rollback", severity: "critical", stop: true, owasp: null, cwe: "CWE-1188",
    files: SQL_FILE,
    pattern: /\bDELETE\s+FROM\s+[\w.]+\s*(;|<\/|"|'|$)/i,
    // 매퍼 XML 은 WHERE 를 다음 줄에 쓴다 — 뒤 몇 줄에 WHERE 가 있으면 전체 삭제가 아니다(실측 264건 오탐)
    lookahead: { lines: 6, absent: /\bWHERE\b|<where\b|<include\b|<dynamic\b/i },
    impact: "테이블 전체 행이 삭제된다.",
    fix: "WHERE 조건을 둔다. 전체 삭제가 의도라면 백업과 함께 axnavi:allow 로 사유를 남긴다.",
  },
  {
    id: "SEC-AUTH-REMOVED",
    title: "인가 검사 제거",
    dimension: "security", severity: "critical", stop: true, owasp: "A01:2021", cwe: "CWE-862",
    removed: true,
    files: SRC,
    pattern: /@(PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b|\b(hasRole|hasAuthority|isAuthenticated|checkPermission|checkAuth|isAdmin)\s*\(/,
    impact: "권한 없는 사용자가 기능에 접근할 수 있다.",
    fix: "같은 검사를 다른 위치로 옮겼다면 그 위치를 함께 커밋하고, 의도된 제거면 승인 근거를 남긴다.",
  },
  {
    id: "SEC-CMD-EXEC",
    title: "OS 명령 실행",
    dimension: "security", severity: "high", owasp: "A03:2021", cwe: "CWE-78",
    files: SRC,
    pattern: /Runtime\.getRuntime\(\)\.exec\(|new\s+ProcessBuilder\(|\bchild_process\b|\bexecSync\(|\bspawnSync?\(|\bos\.system\(|\bsubprocess\.(run|call|Popen|check_output)\(.*shell\s*=\s*True|Process\.Start\(/,
    stopWhen: /\+\s*[A-Za-z_$]|\$\{|\bf["']|%\s*\(|\.format\(/,
    impact: "입력이 명령줄에 섞이면 서버에서 임의 명령이 실행된다.",
    fix: "명령과 인자를 배열로 분리해 넘기고, 입력은 허용 목록으로 검증한다.",
  },

  /* ---------------- 보안 — HOLD 대상 ---------------- */
  {
    id: "SEC-AUTH-OPEN",
    title: "인증 없이 열어 둔 경로",
    dimension: "security", severity: "high", owasp: "A01:2021", cwe: "CWE-306",
    files: SRC,
    pattern: /anyRequest\(\)\s*\.\s*permitAll\(\)|["']\/\*\*["']\s*\)\s*\.\s*permitAll\(\)|@PermitAll\b|\.anonymous\(\)/,
    impact: "보호돼야 할 경로가 비인증 사용자에게 열릴 수 있다.",
    fix: "공개해야 하는 경로만 좁게 지정한다.",
  },
  {
    id: "SEC-CSRF-OFF",
    title: "CSRF 보호 해제",
    dimension: "security", severity: "medium", owasp: "A05:2021", cwe: "CWE-352",
    files: SRC,
    pattern: /csrf\(\)\s*\.\s*disable\(\)|csrf\s*\(\s*[\w\s]*->\s*[\w\s]*\.disable\(\)|csrf_exempt|@CsrfExempt/,
    impact: "세션 기반 화면이면 사용자가 모르는 사이 요청이 위조될 수 있다.",
    fix: "토큰 기반 API 에만 해제하고, 세션 화면은 CSRF 토큰을 유지한다.",
  },
  {
    id: "SEC-CORS-ANY",
    title: "CORS 전체 허용",
    dimension: "security", severity: "medium", owasp: "A05:2021", cwe: "CWE-942",
    pattern: /allowedOrigins?\(\s*["']\*["']|Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|@CrossOrigin\s*(\(\s*(origins\s*=\s*)?["']\*["']\s*\)|$)|origin\s*:\s*["']\*["']/,
    impact: "다른 사이트의 스크립트가 사용자 권한으로 API 를 호출할 수 있다.",
    fix: "허용 출처를 명시한다.",
  },
  {
    id: "SEC-XSS",
    title: "HTML 직접 삽입(XSS 가능)",
    dimension: "security", severity: "medium", owasp: "A03:2021", cwe: "CWE-79",
    pattern: /\.innerHTML\s*=|\bv-html\s*=|dangerouslySetInnerHTML|document\.write\(|<%=\s*request\.getParameter|\$\{param\.[\w]+\}|\|\s*safe\b/,
    impact: "입력값이 이스케이프 없이 화면에 들어가면 스크립트가 실행된다.",
    fix: "textContent·템플릿 바인딩을 쓰거나, 서버·클라이언트에서 이스케이프한다(c:out, escapeXml).",
  },
  {
    id: "SEC-WEAK-CRYPTO",
    title: "약한 암호·해시",
    dimension: "security", severity: "medium", owasp: "A02:2021", cwe: "CWE-327",
    pattern: /getInstance\(\s*["'](MD5|SHA-?1|DES|DESede|RC4)["']|\/ECB\/|hashlib\.(md5|sha1)\(|createHash\(\s*["'](md5|sha1)["']|new\s+(MD5|SHA1)CryptoServiceProvider/i,
    impact: "충돌·역산이 가능한 알고리즘이라 비밀번호·무결성 보호가 되지 않는다.",
    fix: "비밀번호는 bcrypt/PBKDF2/Argon2, 무결성은 SHA-256 이상, 암호화는 AES-GCM 을 쓴다.",
  },
  {
    id: "SEC-TLS-OFF",
    title: "TLS 검증 해제",
    dimension: "security", severity: "high", owasp: "A02:2021", cwe: "CWE-295",
    pattern: /TrustAll|ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|ServerCertificateValidationCallback\s*=.*true/,
    impact: "중간자가 통신을 가로채도 알아채지 못한다.",
    fix: "사내 CA 를 신뢰 저장소에 등록하고 검증을 유지한다.",
  },
  {
    id: "SEC-DESERIALIZE",
    title: "안전하지 않은 역직렬화",
    dimension: "security", severity: "high", owasp: "A08:2021", cwe: "CWE-502",
    pattern: /new\s+ObjectInputStream\(|\bpickle\.loads?\(|\byaml\.load\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)|\bXMLDecoder\(|BinaryFormatter\(\)|enableDefaultTyping\(/,
    impact: "외부 데이터를 역직렬화하면 원격 코드 실행으로 이어질 수 있다.",
    fix: "JSON 등 데이터 전용 형식을 쓰거나 허용 클래스 목록(ObjectInputFilter)을 둔다.",
  },
  {
    id: "SEC-LOG-SECRET",
    title: "민감정보 로그 출력",
    dimension: "security", severity: "medium", owasp: "A09:2021", cwe: "CWE-532",
    pattern: /\b(log(ger)?|LOG|logger)\s*\.\s*(trace|debug|info|warn|error)\s*\(.*\b(pass(word|wd)?|pwd|token|secret|jumin|rrn|ssn|주민|카드번호|cardNo)\b|System\.out\.print(ln)?\(.*\b(pass(word|wd)?|pwd|token|jumin|주민)\b/i,
    impact: "로그 파일을 통해 비밀번호·개인정보가 유출된다(개인정보보호법 위반 소지).",
    fix: "민감 필드는 로그에서 빼거나 마스킹한다.",
  },
  {
    id: "SEC-DEBUG",
    title: "디버그·스택트레이스 노출",
    dimension: "security", severity: "low", owasp: "A05:2021", cwe: "CWE-209",
    pattern: /\.printStackTrace\(\)|\bdebug\s*[:=]\s*true\b|\bDEBUG\s*=\s*True\b|<customErrors\s+mode\s*=\s*["']Off["']/,
    impact: "오류 화면·로그로 내부 구조가 드러난다.",
    fix: "로거로 기록하고 사용자에게는 일반 메시지를 보인다.",
  },
  {
    id: "SEC-HTTP-PLAIN",
    title: "평문 HTTP 주소",
    dimension: "security", severity: "low", owasp: "A02:2021", cwe: "CWE-319",
    unless: /xmlns(:\w+)?\s*=|<!DOCTYPE|schemaLocation|\.dtd["']|\.xsd["']/,
    pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{|www\.w3\.org|java\.sun\.com|xmlns|schemas?\.|struts\.apache|www\.springframework|mybatis\.org|ibatis\.apache|jakarta\.ee|xml\.org)[^"']+["']/,
    impact: "전송 중 데이터가 노출·변조될 수 있다.",
    fix: "HTTPS 를 쓰거나 내부망 주소라는 근거를 남긴다.",
  },

  /* ---------------- 사이드 이펙트 — change-safety 차원 3 ---------------- */
  {
    id: "SE-TX",
    title: "트랜잭션 경계 변경",
    dimension: "side_effect", severity: "medium", weight: 3,
    files: SRC,
    pattern: /@Transactional\b|TransactionTemplate|\.setAutoCommit\(|\b(commit|rollback)\s*\(\s*\)/,
    impact: "커밋·롤백 범위가 바뀌어 부분 반영·락 대기가 생길 수 있다.",
    fix: "전파 속성과 롤백 대상 예외를 확인하고, 호출 경로의 기존 트랜잭션과 겹치는지 본다.",
  },
  {
    id: "SE-ASYNC",
    title: "비동기·스케줄 도입",
    dimension: "side_effect", severity: "low", weight: 2,
    files: SRC,
    pattern: /@Async\b|@Scheduled\b|@EnableScheduling|\bnew\s+Thread\(|Executors\.new|setInterval\(|\bcron\s*[:=]/,
    impact: "요청 흐름 밖에서 실행돼 예외·중복 실행이 잘 드러나지 않는다.",
    fix: "중복 실행 방지(락)와 실패 시 재처리·알림 경로를 둔다.",
  },
  {
    id: "SE-EXTERNAL",
    title: "외부 통신 추가",
    dimension: "side_effect", severity: "low", weight: 2,
    files: SRC,
    pattern: /\bRestTemplate\b|\bWebClient\b|HttpURLConnection|\bHttpClient\b|\bOkHttpClient\b|\baxios\.|\bfetch\(|\brequests\.(get|post|put|delete)\(|FeignClient|KafkaTemplate|RabbitTemplate|JmsTemplate|@KafkaListener|@RabbitListener/,
    impact: "외부 시스템 장애·지연이 이 기능으로 번진다.",
    fix: "타임아웃·재시도·장애 시 대체 동작을 정한다.",
  },
  {
    id: "SE-ENV-BRANCH",
    title: "환경별 분기",
    dimension: "side_effect", severity: "medium", weight: 3,
    files: SRC,
    pattern: /@Profile\(|System\.getenv\(|process\.env\.|os\.environ|spring\.profiles|["'](prod|production|real|운영)["']/i,
    impact: "운영에서만 다르게 도는 코드는 개발·검증 환경에서 확인되지 않는다.",
    fix: "운영 분기를 검증할 방법(설정 주입 테스트 등)을 함께 제출한다.",
  },

  /* ---------------- 롤백 — DB 스키마 ---------------- */
  {
    id: "RB-SCHEMA",
    title: "DB 스키마 변경",
    dimension: "rollback", severity: "medium", weight: 6,
    files: SQL_FILE,
    pattern: /\b(CREATE|ALTER)\s+(TABLE|INDEX|VIEW|SEQUENCE|TRIGGER|PROCEDURE|FUNCTION|PACKAGE)\b|\bADD\s+(COLUMN|CONSTRAINT)\b|\bMODIFY\s*\(/i,
    impact: "코드만 되돌려서는 원상복구되지 않는다.",
    fix: "다운 마이그레이션(원복 DDL)과 적용 순서(DB 먼저/코드 먼저)를 함께 적는다.",
  },
];

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
export const severityRank = (/** @type {Severity} */ s) => SEVERITY_RANK[s] ?? 0;

const ALLOW = /axnavi:allow\s+([A-Z0-9-]+(?:\s*,\s*[A-Z0-9-]+)*)(?:\s+(.+?))?\s*(?:\*\/|-->|$)/;

/** `axnavi:allow SEC-XSS 서버에서 이스케이프` → { ids, reason } */
export function parseAllow(/** @type {string} */ text) {
  const m = ALLOW.exec(text);
  if (!m) return null;
  return { ids: (m[1] ?? "").split(/\s*,\s*/), reason: (m[2] ?? "").trim() || "사유 없음" };
}

/** 시크릿 이름 뒤 따옴표 없는 값 — `db.password=abc`, `apiKey: abc` (.properties·YAML) */
const SECRET_ASSIGN = /(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]*\s*[:=]\s*)(?!["'])([^\s,;)]{2,})/gi;

/** 시크릿이 들어 있을 수 있는 줄은 값을 가린다 — 앞 글자도 보이지 않게(리포트·CI 산출물·MR 노트로 퍼지므로) */
export function redact(/** @type {string} */ text) {
  return text
    .replace(/(["'])[^"'\n]+\1/g, "$1***$1")
    .replace(/-----BEGIN[^-]+-----.*/, "-----BEGIN … PRIVATE KEY----- (생략)")
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1****************")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(SECRET_ASSIGN, "$1***");
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|<!--|--\s|#(?!\{))/;

/** 뒤 N 줄 안에 absent 패턴이 있는가 — 파일 전체가 있으면 그걸, 없으면 diff 로 받은 줄만 본다 */
function hasAhead(/** @type {number} */ line, /** @type {{ lines: number, absent: RegExp }} */ la, /** @type {string[] | null} */ fileLines, /** @type {Map<number, string>} */ byLine) {
  for (let k = 0; k <= la.lines; k += 1) {
    const t = fileLines ? fileLines[line - 1 + k] : byLine.get(line + k);
    if (t !== undefined && la.absent.test(k === 0 ? t.replace(/^[\s\S]*?\bDELETE\s+FROM\s+[\w.]+/i, "") : t)) return true;
  }
  return false;
}

const clip = (/** @type {string} */ s) => {
  const t = s.trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

/**
 * 한 파일의 줄들에 규칙을 적용한다.
 * @param {string} file
 * @param {{ line: number, text: string }[]} lines  판정 대상 줄(추가된 줄 또는 파일 전체)
 * @param {{ side: "added" | "removed" | "current", context?: Map<number, string>, rules?: Rule[], fileLines?: string[] | null }} opts
 *        context: 억제 주석을 찾을 때 볼 줄(바로 윗줄). 없으면 lines 자체에서 찾는다.
 *        fileLines: 파일 전체(1번 줄 = 인덱스 0) — 뒤따르는 줄을 봐야 하는 규칙(WHERE 없는 DELETE)에 쓴다.
 * @returns {Finding[]}
 */
export function applyRules(file, lines, opts) {
  /** @type {Finding[]} */
  const out = [];
  const rules = (opts.rules ?? RULES).filter((r) => (opts.side === "removed" ? r.removed : !r.removed) && (!r.files || r.files.test(file)));
  if (!rules.length) return out;
  const byLine = opts.context ?? new Map(lines.map((l) => [l.line, l.text]));
  // 리뷰 대상 변경에서 추가된 줄 — 같은 변경에서 넣은 억제 주석은 판정을 낮추지 못하게 따로 표시한다
  const addedLines = opts.side === "added" ? new Set(lines.map((l) => l.line)) : null;
  for (const { line, text } of lines) {
    if (text.length > 2000) continue; // 압축된 번들·한 줄짜리 데이터는 규칙 대상이 아니다
    const commented = COMMENT_LINE.test(text);
    for (const r of rules) {
      if (commented && !r.inComments) continue; // 주석 처리된 코드는 동작하지 않는다
      if (!(r.match ? r.match(text) : r.pattern?.test(text))) continue;
      if (r.unless?.test(text)) continue;
      if (r.lookahead && hasAhead(line, r.lookahead, opts.fileLines ?? null, byLine)) continue;
      const sameLine = parseAllow(text);
      const allow = sameLine ?? parseAllow(byLine.get(line - 1) ?? "");
      const allowAddedNow = Boolean(addedLines && allow && (sameLine || addedLines.has(line - 1)));
      const stop = Boolean(r.stop) || Boolean(r.stopWhen?.test(text));
      out.push({
        rule: r.id,
        title: r.title,
        dimension: r.dimension,
        severity: stop && r.severity === "high" ? "critical" : r.severity,
        stop,
        owasp: r.owasp ?? null,
        cwe: r.cwe ?? null,
        file,
        line,
        side: opts.side,
        snippet: clip(r.redact ? redact(text) : text),
        impact: r.impact,
        fix: r.fix,
        ...(allow && allow.ids.includes(r.id) ? { suppressed: allow.reason, ...(allowAddedNow ? { suppressedInChange: true } : {}) } : {}),
      });
    }
  }
  return out;
}

export const ruleById = new Map(RULES.map((r) => [r.id, r]));
