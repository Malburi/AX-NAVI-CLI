import { basename, extname } from "node:path";

/*
 * 워크플로우와 에이전트는 기술 중립으로 유지하고, 소스 해석 차이는 이 레지스트리에 모은다.
 * level은 "파일을 읽을 수 있음"이 아니라 유지보수 판단에 필요한 구조를 얼마나
 * 결정적으로 추출하는지를 뜻한다. PARTIAL 대상 변경은 에이전트가 원문을 직접 읽어 확인하는 READ 대상이다(assessTargetCoverage).
 */
export const ADAPTERS = [
  { id: "jvm", label: "Java/Kotlin/Spring", extensions: [".java", ".kt", ".kts"], level: "FULL" },
  { id: "dotnet", label: ".NET/C#", extensions: [".cs"], level: "FULL" },
  { id: "dotnet-project", label: ".NET project metadata", extensions: [".csproj", ".vbproj", ".fsproj", ".resx", ".config", ".repx"], level: "PARTIAL" },
  { id: "javascript", label: "JavaScript/TypeScript/Vue/React", extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"], level: "FULL" },
  { id: "nexacro", label: "Nexacro", extensions: [".xjs"], level: "FULL" },
  { id: "nexacro-form", label: "Nexacro Form", extensions: [".xfdl"], level: "PARTIAL" },
  { id: "python", label: "Python", extensions: [".py"], level: "FULL" },
  { id: "go", label: "Go", extensions: [".go"], level: "FULL" },
  { id: "sql", label: "SQL/DDL", extensions: [".sql"], level: "FULL" },
  /* 정규식 기반이라 오버로드·동적 SQL(EXECUTE IMMEDIATE 변수)·중첩 로컬 프로시저는 근사다. 변경은 READ(원문 확인). */
  { id: "plsql", label: "Oracle PL/SQL", extensions: [".pks", ".pkb", ".pck", ".spc", ".bdy", ".prc", ".fnc", ".trg", ".pls"], level: "PARTIAL" },
  /* C 함수·호출과 EXEC SQL 정적 SQL. 매크로·함수 포인터·전처리 분기는 해석하지 않는다. 변경은 READ(원문 확인). */
  { id: "proc", label: "Oracle Pro*C", extensions: [".pc"], level: "PARTIAL" },
  /* .pbl은 바이너리라 못 읽는다. 소스 관리용 텍스트 내보내기(윈도·사용자 객체·함수·메뉴·앱·DataWindow)만 본다. */
  { id: "powerbuilder", label: "PowerBuilder (텍스트 내보내기)", extensions: [".srw", ".sru", ".srf", ".srm", ".sra", ".srd"], level: "PARTIAL" },
  { id: "legacy-web", label: "JSP/Struts/WebForms/markup", extensions: [".xml", ".jsp", ".jspx", ".jspf", ".tag", ".asp", ".aspx", ".ascx", ".master", ".ashx", ".asmx", ".xaml", ".cshtml", ".vbhtml", ".razor", ".html", ".htm"], level: "PARTIAL" },
];

const EXTENSION_RULES = new Map(ADAPTERS.flatMap((adapter) => adapter.extensions.map((extension) => [extension, adapter])));

export const ADAPTER_SOURCE_EXTENSIONS = new Set(ADAPTERS.flatMap((adapter) => adapter.extensions));
export const ADAPTER_DISCOVERY_ONLY_EXTENSIONS = new Set([
  ".sln", ".suo", ".fmb", ".mmb", ".olb", ".pbl", ".pbw", ".rpt",
  ".frm", ".vbp", ".bas", ".cls",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".swift", ".dart", ".scala", ".groovy", ".fs", ".fsx",
]);

export function adapterForPath(rel) {
  return EXTENSION_RULES.get(extname(rel).toLowerCase()) || null;
}

export function detectAdapters(rel, text = "") {
  const result = new Set();
  const base = adapterForPath(rel);
  if (base) result.add(base.id);
  if (/\b(?:System\.Windows\.Forms|Application\.Run|InitializeComponent)\b/.test(text)) result.add("winforms");
  if (/\bDevExpress\./.test(text)) result.add("devexpress");
  if (/\b(?:WebApplication\.CreateBuilder|ControllerBase|Microsoft\.AspNetCore)\b/.test(text)) result.add("aspnet-core");
  if (/\b(?:nexacro\.|this\.transaction\s*\()|<FDL\b|<Form\b/i.test(text) && /\.(?:xfdl|xjs)$/i.test(rel)) result.add("nexacro");
  if (/\bReact\b|from\s+["']react["']|\.(?:jsx|tsx)$/i.test(rel)) result.add("react");
  if (/<template\b|\bdefineComponent\b|\.(?:vue)$/i.test(rel)) result.add("vue");
  if (/struts|<action\b/i.test(text)) result.add("struts");
  if (/\.sql$/i.test(rel) && /\bcreate\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:package|procedure|function|trigger)\b/i.test(text)) result.add("plsql");
  return [...result];
}

export function buildAdapterCoverage(facts, unsupportedFiles) {
  const extensions = new Map();
  const active = new Map();
  const partialTargets = [];
  for (const fact of facts) {
    const extension = extname(fact.rel).toLowerCase() || basename(fact.rel);
    const adapter = adapterForPath(fact.rel);
    let level = adapter?.level || "PARTIAL";
    if (extension === ".py" && fact.endpoints?.some((item) => ["django", "flask"].includes(item.framework))) level = "PARTIAL";
    const current = extensions.get(extension) || { extension, level, files: 0, adapter: adapter?.id || "generic" };
    current.files += 1;
    if (level !== "FULL") current.level = "PARTIAL";
    extensions.set(extension, current);
    for (const id of fact.adapters || []) active.set(id, (active.get(id) || 0) + 1);
    /* .sql 확장자는 FULL(DDL)이지만 안에 PL/SQL 프로그램 단위가 있으면 그 파일은 PL/SQL과 같은 PARTIAL이다. */
    if ((fact.adapters || []).includes("plsql") && /\.sql$/i.test(fact.rel)) {
      partialTargets.push({ path: fact.rel, level: "PARTIAL", reason: "PL/SQL program units (regex-based)" });
    }
    if ((fact.adapters || []).includes("devexpress") || /\.Designer\.cs$/i.test(fact.rel)) {
      partialTargets.push({ path: fact.rel, level: "PARTIAL", reason: (fact.adapters || []).includes("devexpress") ? "DevExpress designer/component semantics" : "generated WinForms Designer semantics" });
    }
  }
  const values = [...extensions.values()];
  const extensionPartialFiles = values.filter((item) => item.level === "PARTIAL").reduce((sum, item) => sum + item.files, 0);
  const extraPartialFiles = partialTargets.filter((target) => !values.some((item) => item.extension === extname(target.path).toLowerCase() && item.level === "PARTIAL")).length;
  const partialFiles = extensionPartialFiles + extraPartialFiles;
  const fullFiles = values.filter((item) => item.level === "FULL").reduce((sum, item) => sum + item.files, 0) - extraPartialFiles;
  return {
    status: unsupportedFiles.length ? "WARN" : partialFiles ? "PARTIAL" : "FULL",
    decision: unsupportedFiles.length ? "HOLD" : partialFiles ? "READ" : "GO",
    full_files: fullFiles,
    partial_files: partialFiles,
    unsupported_files: unsupportedFiles,
    partial_targets: partialTargets,
    extensions: values.sort((left, right) => left.extension.localeCompare(right.extension)),
    active_adapters: [...active.entries()].map(([id, files]) => ({ id, files })).sort((left, right) => left.id.localeCompare(right.id)),
    rule: "PARTIAL 대상은 인덱스만으로 확정하지 않고 에이전트가 원문을 읽어 확인한 뒤 진행(READ), unsupported 대상은 HOLD",
  };
}

/*
 * 판정은 셋이다.
 *   GO    FULL — 인덱스의 관계로 확정할 수 있다.
 *   READ  PARTIAL — 인덱스만으로 확정하지 않는다. 에이전트가 대상과 연결 파일 원문을 직접 읽어 확인하고 진행한다.
 *   HOLD  UNSUPPORTED — 읽을 수 없는 형식이다.
 * 예전에는 PARTIAL 도 사람의 수동 검증 전까지 HOLD 였다. JSP·XML 이 대부분인 레거시에서는 수정의 78%가
 * 사람 확인에서 멈췄다(실측 eduLms). 빈칸은 사람이 아니라 원문을 읽는 에이전트가 메운다.
 */
const READ_GUIDANCE = "인덱스만으로 확정하지 말고 대상 파일과 연결된 설정·화면·스크립트·SQL 원문을 직접 읽어 변경 지점과 호출 관계를 확인한 뒤 진행한다.";

export function assessTargetCoverage(coverage, targetPath) {
  const normalizedTarget = String(targetPath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const extension = extname(normalizedTarget).toLowerCase();
  const entry = (coverage?.extensions || []).find((item) => item.extension === extension);
  if ((coverage?.unsupported_files || []).includes(normalizedTarget)) return { decision: "HOLD", level: "UNSUPPORTED", reason: "discovery-only 파일" };
  const target = (coverage?.partial_targets || []).find((item) => item.path === normalizedTarget);
  if (target) return { decision: "READ", level: "PARTIAL", reason: target.reason, guidance: READ_GUIDANCE };
  if (!entry) return { decision: "HOLD", level: "UNSUPPORTED", reason: `인덱싱되지 않은 확장자: ${extension || "(없음)"}` };
  if (entry.level !== "FULL") return { decision: "READ", level: entry.level, reason: "부분 어댑터 — 원문 확인으로 보강", guidance: READ_GUIDANCE };
  return { decision: "GO", level: "FULL", reason: "결정적 어댑터 적용" };
}
