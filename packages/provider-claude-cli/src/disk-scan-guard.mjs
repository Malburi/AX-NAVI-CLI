/*
 * 디스크 전체를 뒤지는 셸 명령을 실행 전에 막는다 — PreToolUse(Bash · PowerShell).
 *
 * 실측(/modify 데모 녹화 세 번 모두): 전자정부 검증 어노테이션의 구현을 보려고
 * `find / -iname "*.jar" | xargs … unzip -l … | grep EgovLengthCheck` 를 돌려 120초 제한에 걸렸다.
 * 매번 2분을 버렸고, 이 프로젝트와 무관한 PC 전체 폴더를 훑었다. "탐색은 프로젝트 루트 안에서만" 지침
 * (SEARCH_SCOPE_RULE)을 넣은 뒤에도 나왔다 — 지침은 지켜지지 않을 수 있어 여기서 사실로 막는다.
 *
 * 막는 것은 검색 명령에 **디스크 루트**(`/`, `/c`, `C:\`)가 인자로 붙은 모양뿐이다. `find .`·`find src`·
 * `find ~/.m2 -name x.jar` 처럼 경로를 좁힌 검색은 그대로 둔다. 판정은 문자열만 본다 — 디스크를 건드리지 않는다.
 *
 * SDK 연결은 diskScanDecision 을 함수로 부르고, claude -p 연결은 이 파일을 훅 명령으로 돌린다(stdin 의 훅 JSON).
 */
import { pathToFileURL } from "node:url";

/** 디스크 루트 — `/`, `/*`, git bash 드라이브 `/c` · `/c/`, `C:` · `C:\` · `C:/`, `C:\*` */
const ROOT = /^(?:\/\*?|\/[a-zA-Z]\/?\*?|[a-zA-Z]:(?:[\\/]\*?)?)$/;

/** @param {string} segment */
function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

/**
 * 디스크 전체를 뒤지는 명령이면 그 조각을, 아니면 null.
 * @param {string} command
 * @returns {string | null}
 */
export function diskWideScan(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const words = tokens(segment.trim());
    if (!words.length) continue;
    const program = (words[0] ?? "").split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, "") ?? "";
    const args = words.slice(1);
    const root = args.some((a) => ROOT.test(a));
    if (!root) continue;
    const flag = (/** @type {RegExp} */ re) => args.some((a) => re.test(a));
    const scans =
      ["find", "fd", "rg", "ag", "tree", "du"].includes(program) ||
      (["grep", "egrep", "fgrep"].includes(program) && flag(/^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/)) ||
      (program === "ls" && flag(/^-[a-zA-Z]*R[a-zA-Z]*$|^--recursive$|^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i)) ||
      (program === "dir" && flag(/^\/s$/i)) ||
      (["get-childitem", "gci"].includes(program) && flag(/^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i)) ||
      (program === "where" && flag(/^\/r$/i));
    if (scans) return segment.trim();
  }
  return null;
}

export const DISK_SCAN_MESSAGE =
  "axnavi: 디스크 전체를 뒤지는 명령은 실행하지 않았다. 프로젝트 루트 안에서 찾거나, 찾을 경로를 좁혀서(예: ~/.m2 의 특정 라이브러리) 다시 해라. " +
  "프레임워크 · 라이브러리(jar) 안의 클래스는 저장소 밖이라 '확인하지 못함'으로 보고한다.";

/**
 * PreToolUse 결정. 막을 명령이 아니면 빈 객체(그대로 진행).
 * @param {any} toolInput  Bash · PowerShell 의 tool_input
 */
export function diskScanDecision(toolInput) {
  const hit = diskWideScan(typeof toolInput?.command === "string" ? toolInput.command : "");
  if (!hit) return {};
  return {
    hookSpecificOutput: {
      hookEventName: /** @type {const} */ ("PreToolUse"),
      permissionDecision: /** @type {const} */ ("deny"),
      permissionDecisionReason: `${DISK_SCAN_MESSAGE} (막은 명령: ${hit.slice(0, 120)})`,
    },
  };
}

/* 훅 명령으로 돌 때 — stdin 의 훅 JSON 을 읽어 결정을 쓴다. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let event = {};
    try { event = JSON.parse(raw || "{}"); } catch { return; }
    const decision = diskScanDecision(/** @type {any} */ (event).tool_input);
    if (decision.hookSpecificOutput) process.stdout.write(JSON.stringify(decision));
  });
}
