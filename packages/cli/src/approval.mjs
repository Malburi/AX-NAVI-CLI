/*
 * 도구 사용 승인 — 플러그인에서 Claude Code 가 하던 "허용할까요?" 를 CLI 가 한다.
 *
 * 왜 필요한가. 위임 실행은 `claude -p` 인데, -p 모드에는 승인해 줄 사람이 없어서
 * 승인이 필요한 도구는 곧 거부된다. 개발 PC 는 개인 설정이 `defaultMode: auto` 라
 * 드러나지 않았다. 기본 설정인 PC 로 흉내 내 보니 Write 가 거부되고 파일이 안 생겼다
 * (실측). 동료 PC 에서는 harness-init 이 아무것도 못 쓰고 끝난다는 뜻이다.
 *
 * 허용 목록을 고정하는 대신 **물어본다.** 플러그인과 같은 경험이어야 하고, 무엇을
 * 허용할지는 역할이 아니라 그 순간의 사람이 정하는 일이기 때문이다.
 * claude 는 `--permission-prompt-tool` 로 이 판단을 MCP 도구에 넘긴다. 받는 것은
 * `{ tool_name, input, tool_use_id }`, 돌려줄 것은 allow/deny 두 모양이다(실측).
 *
 * 읽기 도구는 여기까지 오지 않는다 — claude 가 묻지 않고 허용하는 것만 빼고 온다.
 * 그래서 이 모듈은 "쓰기·실행" 만 다룬다고 봐도 된다.
 */

import { readFileSync } from "node:fs";
import { diffPreview } from "./diff.mjs";

/** @typedef {import("./diff.mjs").PreviewLine} PreviewLine */

/** 파일을 바꾸는 도구. 한 묶음으로 "이번 세션 허용" 을 건다 — Claude Code 도 그렇다. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** 화면 한 줄에 싣는 명령 길이 상한. 넘으면 자른다. */
const MAX_DETAIL = 160;

/**
 * @typedef {{ behavior: "allow", updatedInput: Record<string, unknown> }
 *         | { behavior: "deny", message: string }} Decision
 */

/**
 * "이번 세션 동안 묻지 않음" 을 무엇 단위로 기억할지.
 *
 * Bash 를 도구 이름 하나로 묶으면 `npm test` 를 허용한 순간 `rm -rf` 까지 열린다.
 * 첫 단어(명령 이름)로 묶는다. 파일 수정은 한 묶음이다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function approvalKey(tool, input) {
  if (EDIT_TOOLS.has(tool)) return "파일 수정";
  if (tool === "Bash") {
    const command = typeof input["command"] === "string" ? input["command"].trim() : "";
    const { names } = analyzeBash(command);
    return names.length ? `Bash(${names.join(", ")})` : "Bash";
  }
  return tool;
}

/*
 * 묻지 않아도 되는 셸 명령.
 *
 * 승인 창이 너무 잦으면 사람은 읽지 않고 "예"를 누른다 — 그러면 승인이 형식이 된다.
 * 아무것도 바꾸지 않는 명령과 axnavi 자신의 스크립트는 묻지 않는다(감사 기록에는 남긴다).
 * 판단은 보수적이다. 따옴표 밖 리다이렉트(`>`)·명령 치환(`$(…)`·백틱)·`xargs` 같은
 * "무엇이든 될 수 있는" 형태가 섞이면 읽기 전용으로 보지 않는다.
 */
const READ_ONLY = new Set([
  "ls", "dir", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "echo", "printf", "pwd",
  "which", "where", "type", "stat", "file", "du", "df", "sort", "uniq", "cut", "tr", "sed", "awk", "basename",
  "dirname", "realpath", "readlink", "date", "true", "test", "[", "cd", "tree", "diff", "cmp", "column", "nl",
  "md5sum", "sha1sum", "sha256sum", "jq",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "describe", "blame", "grep", "cat-file", "ls-tree", "shortlog", "reflog", "rev-list"]);
const SCRIPT_RUNNERS = new Set(["node", "node.exe", "python", "python3", "python.exe", "py"]);

/**
 * 셸 명령을 따옴표를 존중하며 `&&`·`||`·`;`·`|`·`&`·줄바꿈 단위로 자른다.
 * 따옴표 밖의 파일 리다이렉트·명령 치환이 있으면 `risky` 로 알린다.
 * @param {string} command
 * @returns {{ segments: string[][], risky: boolean }}
 */
function splitShell(command) {
  /** @type {string[][]} */
  const segments = [[]];
  let word = "";
  let quote = "";
  let risky = false;
  const endWord = () => { if (word) segments.at(-1)?.push(word); word = ""; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const n = command[i + 1];
    if (quote) {
      if (c === quote) quote = "";
      /* bash: 큰따옴표 안의 `\` 는 $ ` " \ 줄바꿈 앞에서만 이스케이프다 — 그 밖은 글자다("C:\Users\…" 경로). */
      else if (c === "\\" && quote === "\"" && n && "$`\"\\\n".includes(n)) { word += n; i += 1; }
      else {
        if (quote === "\"" && (c === "`" || (c === "$" && n === "("))) risky = true;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; continue; }
    /*
     * heredoc(`python3 - <<'EOF' … EOF`). 본문은 명령이 아니라 그 명령의 입력이다 — 줄마다 잘라
     * 명령으로 읽으면 승인 창에 `Bash(python3, import, with, …)` 가 뜬다. 본문을 건너뛰고,
     * 판단은 heredoc 을 받는 명령(`python3 -` → 묻는다, `cat` → 읽기 전용)으로 한다.
     */
    if (c === "<" && n === "<" && command[i + 2] !== "<") {
      const spec = command.slice(i + 2).match(/^-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
      const lineEnd = command.indexOf("\n", i);
      if (spec && lineEnd >= 0) {
        const delim = spec[2];
        const lines = command.slice(lineEnd + 1).split("\n");
        let offset = lineEnd + 1;
        for (const line of lines) {
          offset += line.length + 1;
          if (line.trim() === delim) break;
        }
        endWord();
        i = offset - 2; // 다음 반복에서 본문 끝 줄바꿈부터 이어 읽는다
        continue;
      }
    }
    if (c === "`" || (c === "$" && n === "(") || (c === "<" && n === "(")) { risky = true; word += c; continue; }
    if (c === ">") {
      /* `2>&1`·`>&2`·`>/dev/null`·`2>/dev/null` 은 파일을 쓰지 않는다. */
      const rest = command.slice(i + 1).replace(/^>/, "").trimStart();
      if (!(n === "&" || /^\/dev\/null\b/.test(rest) || /^NUL\b/i.test(rest))) risky = true;
      if (/^\/dev\/null\b/.test(rest)) { i = command.indexOf("/dev/null", i) + "/dev/null".length - 1; }
      else if (n === "&") i += 2;
      endWord();
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      endWord();
      if ((c === "&" || c === "|") && n === c) i += 1;
      if (segments.at(-1)?.length) segments.push([]);
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
  }
  endWord();
  if (quote) risky = true;
  return { segments: segments.filter((s) => s.length), risky };
}

/**
 * 한 조각의 이름과 읽기 전용 여부.
 * @param {string[]} words
 * @param {string} pluginRoot
 * @returns {{ name: string, readOnly: boolean }}
 */
function classifySegment(words, pluginRoot) {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][\w]*=/.test(words[at] ?? "")) at += 1; // FOO=bar cmd
  /*
   * 셸 제어어. `for d in a b; do ls $d; done` 은 `for …`·`do ls $d`·`done` 조각으로 잘린다 —
   * 제어어 자체는 아무것도 바꾸지 않으니 떼고 나머지로 판단한다(실측 harness-init 명령의 흔한 모양).
   */
  while (["do", "then", "else", "elif", "if", "while", "until", "!", "{"].includes(words[at] ?? "")) at += 1;
  if (at >= words.length || ["for", "done", "fi", "esac", "}", "case"].includes(words[at] ?? "")) return { name: "", readOnly: true };
  const head = words[at] ?? "";
  const base = head.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  const args = words.slice(at + 1);
  if (base === "xargs") {
    /* `xargs grep -l x` 처럼 넘기는 명령이 읽기 전용이면 읽기 전용이다. 값 받는 옵션은 값까지 건너뛴다. */
    let i = 0;
    while (i < args.length && (args[i] ?? "").startsWith("-")) i += ["-I", "-n", "-P", "-L", "-d", "-s", "-E"].includes(args[i] ?? "") ? 2 : 1;
    return i < args.length ? classifySegment(args.slice(i), pluginRoot) : { name: "xargs", readOnly: false };
  }
  if (base === "git") {
    /* `git -C <경로> status` — -C·-c 의 값은 하위 명령이 아니다. */
    const rest = [...args];
    while (rest.length && (rest[0] ?? "").startsWith("-")) rest.splice(0, ["-C", "-c", "--git-dir", "--work-tree"].includes(rest[0] ?? "") ? 2 : 1);
    const sub = rest[0] ?? "";
    const readOnly = READ_ONLY_GIT.has(sub)
      || (sub === "branch" && args.every((arg) => arg === "branch" || ["--show-current", "-a", "-r", "--list", "-v", "-vv"].includes(arg)))
      || (sub === "remote" && args.every((arg) => arg === "remote" || arg === "-v"))
      || (sub === "config" && args.some((arg) => ["--get", "--list", "-l", "--get-all"].includes(arg)));
    return { name: sub ? `git ${sub}` : "git", readOnly };
  }
  if (SCRIPT_RUNNERS.has(base)) {
    /* axnavi 자신의 스크립트(인덱서·검증기). 제품의 일부라 묻지 않는다 — 산출물은 _workspace 에 쓴다. */
    /* Git Bash 는 `C:\…` 를 `/c/…` 로 쓴다 — 같은 경로로 맞춰 비교한다. */
    const unify = (/** @type {string} */ path) => path.replace(/\\/g, "/").replace(/^\/([a-zA-Z])\//, "$1:/");
    const script = unify(args.find((arg) => !arg.startsWith("-")) ?? "");
    const root = unify(pluginRoot).replace(/\/+$/, "").toLowerCase();
    const ours = /^\$(?:env:)?\{?CLAUDE_PLUGIN_ROOT\}?\/agents\/lib\//.test(script)
      || (root !== "" && script.toLowerCase().startsWith(`${root}/agents/lib/`));
    return { name: base.replace(/\.exe$/, ""), readOnly: ours && !args.some((arg) => arg === "-e" || arg === "-c" || arg === "--eval") };
  }
  if (!READ_ONLY.has(base)) return { name: base || head, readOnly: false };
  if (base === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(arg))) return { name: base, readOnly: false };
  if (base === "sed" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return { name: base, readOnly: false };
  if (base === "awk" && args.some((arg) => /system\s*\(|print[^|]*>/.test(arg))) return { name: base, readOnly: false };
  return { name: base, readOnly: true };
}

/**
 * 셸 명령 분석. `names` 는 묻어야 할(읽기 전용이 아닌) 조각의 이름, `readOnly` 는 전부 묻지 않아도 되는가.
 * @param {string} command
 * @param {string} [pluginRoot]
 * @returns {{ readOnly: boolean, names: string[] }}
 */
export function analyzeBash(command, pluginRoot = "") {
  const { segments, risky } = splitShell(command);
  if (!segments.length) return { readOnly: false, names: [] };
  const classified = segments.map((words) => classifySegment(words, pluginRoot));
  const names = [...new Set(classified.filter((item) => (item.readOnly === false || risky) && item.name).map((item) => item.name))];
  return { readOnly: !risky && classified.every((item) => item.readOnly), names };
}

/**
 * 무엇을 하려는지 한 줄로.
 *
 * 사람이 판단할 재료는 "어느 파일" 과 "무슨 명령" 이다. 입력 JSON 을 통째로 보여
 * 주면 긴 content 에 묻혀 정작 경로가 안 보인다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function describeToolUse(tool, input) {
  const pick = (/** @type {string} */ key) => (typeof input[key] === "string" ? String(input[key]) : "");
  let detail = "";
  if (EDIT_TOOLS.has(tool)) detail = pick("file_path") || pick("notebook_path");
  else if (tool === "Bash") detail = pick("command");
  else if (tool === "WebFetch") detail = pick("url");
  else if (tool === "WebSearch") detail = pick("query");
  else {
    try {
      detail = JSON.stringify(input);
    } catch {
      detail = "";
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL - 1)}…`;
  return detail ? `${tool}  ${detail}` : tool;
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** @param {string} text */
const normalize = (text) => text.replace(/\r\n?/g, "\n");

/**
 * 승인 전에 보여 줄 미리보기 — 무엇이 바뀌는지.
 *
 * 경로만 보고 "예" 를 누르게 하면 승인이 형식이 된다. 플러그인에서는 Claude Code 가
 * 바뀌는 줄을 빨강·초록으로 보여 줬다. 같은 재료를 만든다. 그리는 것은 선택 창의 일이다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {(path: string) => string | null} [readText]  파일 읽기 (시험에서 바꿔 끼운다)
 * @returns {PreviewLine[]}
 */
export function previewToolUse(tool, input, readText = readTextOrNull) {
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
  const path = str(input["file_path"]) || str(input["notebook_path"]);
  const raw = path ? readText(path) : null;
  const current = raw === null ? null : normalize(raw);

  /**
   * 바꿀 조각이 파일의 몇 번째 줄에서 시작하는지. 못 찾으면 번호 없이 보여 준다 —
   * 틀린 번호는 번호가 없는 것보다 나쁘다.
   * @param {string} fragment
   * @returns {number | null}
   */
  const lineOf = (fragment) => {
    if (current === null || !fragment) return null;
    const at = current.indexOf(normalize(fragment));
    if (at === -1) return null;
    return current.slice(0, at).split("\n").length;
  };
  /** @param {PreviewLine[]} lines */
  const unnumbered = (lines) => lines.map(({ no: _no, ...rest }) => rest);
  /** @param {number} added @param {number} removed */
  const tally = (added, removed) =>
    [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");

  if (tool === "Edit") {
    const oldText = str(input["old_string"]);
    const start = lineOf(oldText);
    const { lines, added, removed } = diffPreview(oldText, str(input["new_string"]), start ?? 1);
    /** @type {PreviewLine[]} */
    const notes = [{ kind: "note", text: tally(added, removed) || "바뀌는 줄 없음" }];
    if (input["replace_all"] === true && current !== null && oldText) {
      const count = current.split(normalize(oldText)).length - 1;
      if (count > 1) notes.push({ kind: "note", text: `같은 내용 ${count}곳을 모두 바꿉니다` });
    }
    if (current !== null && oldText && start === null) {
      notes.push({ kind: "note", text: "파일에서 바꿀 부분을 찾지 못했습니다 — 실행하면 실패합니다" });
    }
    return [...notes, ...(start === null ? unnumbered(lines) : lines)];
  }

  if (tool === "MultiEdit") {
    const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
    /** @type {PreviewLine[]} */
    const out = [{ kind: "note", text: `편집 ${edits.length}건` }];
    edits.forEach((edit, i) => {
      const e = edit && typeof edit === "object" ? /** @type {Record<string, unknown>} */ (edit) : {};
      const oldText = str(e["old_string"]);
      const start = lineOf(oldText);
      const { lines } = diffPreview(oldText, str(e["new_string"]), start ?? 1);
      if (i > 0) out.push({ kind: "gap", text: "⋯" });
      out.push(...(start === null ? unnumbered(lines) : lines));
    });
    return out;
  }

  if (tool === "Write") {
    const content = str(input["content"]);
    if (current === null) {
      const { lines, added } = diffPreview("", content);
      return [{ kind: "note", text: `새 파일 · ${added}줄` }, ...lines];
    }
    if (current === normalize(content)) return [{ kind: "note", text: "지금 파일과 내용이 같습니다" }];
    const { lines, added, removed } = diffPreview(current, content);
    return [{ kind: "note", text: `덮어쓰기 · ${tally(added, removed)}` }, ...lines];
  }

  if (tool === "NotebookEdit") {
    const { lines } = diffPreview("", str(input["new_source"]));
    return [{ kind: "note", text: `셀 ${str(input["edit_mode"]) || "replace"}` }, ...unnumbered(lines)];
  }

  /*
   * Bash — 한 줄 요약에 다 안 들어가는 명령은 전체를 보여 준다.
   * 여러 줄 스크립트의 셋째 줄에 무엇이 있는지 모르고 허용하게 하면 안 된다.
   */
  if (tool === "Bash") {
    const command = str(input["command"]);
    if (command.length <= MAX_DETAIL && !/[\r\n]/.test(command)) return [];
    return normalize(command).split("\n").map((text) => ({ kind: /** @type {const} */ ("ctx"), text }));
  }
  return [];
}

/**
 * @typedef {object} Approver
 * @property {(tool: string, input: Record<string, unknown>) => Promise<Decision>} decide
 * @property {() => string[]} remembered   이번 세션에 "묻지 않음" 으로 둔 것들
 */

/**
 * @param {object} args
 * @param {(question: string, options: string[], opts: { header?: string, preview?: PreviewLine[] }) => Promise<string[]>} args.ask
 *        실제로 사람에게 묻는 함수. 답이 없으면 빈 배열
 * @param {(entry: { tool: string, input: Record<string, unknown>, allowed: boolean, how: string }) => void} [args.onDecision]
 *        허용·거부를 기록에 남긴다
 * @param {Set<string>} [args.always]  "이번 세션 동안 묻지 않음" 기억. 턴을 넘어 살아야 해서 호출부가 쥔다
 * @param {(path: string) => string | null} [args.readText]  미리보기용 파일 읽기
 * @param {string} [args.pluginRoot]  axnavi 설치 루트 — 이 아래 agents/lib 스크립트는 묻지 않는다
 * @param {() => boolean} [args.trustAll]  "전부 승인" 모드인가 (/mode 전부승인)
 * @returns {Approver}
 */
export function createApprover({ ask, onDecision, always = new Set(), readText = readTextOrNull, pluginRoot = "", trustAll = () => false }) {
  /* "이번 세션 동안 모두 묻지 않음" 의 기억 표지. 도구 이름과 겹치지 않는 값이다. */
  const ALL = "*";
  /*
   * 한 번 거부된 뒤에는 셸 명령의 세션 허용을 다시 쓰지 않는다. 실측: `.claude/skills` 쓰기가
   * 거부되자 모델이 복사 스크립트를 _workspace 에 써서 `python3` 로 돌렸고, 앞서 받은
   * `Bash(python3)` 세션 허용으로 묻지 않고 지나갔다. 거부 뒤의 명령은 사람이 다시 본다.
   */
  let deniedOnce = false;
  return {
    remembered: () => [...always],
    async decide(tool, input) {
      const safeInput = input && typeof input === "object" ? input : {};
      const allow = (/** @type {string} */ how) => {
        onDecision?.({ tool, input: safeInput, allowed: true, how });
        return /** @type {Decision} */ ({ behavior: "allow", updatedInput: safeInput });
      };
      if (trustAll()) return allow("모드: 전부 승인");
      if (always.has(ALL)) return allow("세션 전체 허용");

      /*
       * 셸 명령은 조각별로 본다. 예전에는 첫 단어만 봐서 `ls …; cd .. && git push` 가
       * `Bash(ls)` 허용 하나로 통째로 지나갔다. 이제는 읽기 전용이 아닌 조각이 전부
       * 세션 허용돼 있어야 지나간다.
       */
      const bash = tool === "Bash" ? analyzeBash(typeof safeInput["command"] === "string" ? safeInput["command"] : "", pluginRoot) : null;
      if (bash?.readOnly) return allow("자동 허용(읽기 전용·axnavi 스크립트)");
      const keys = bash ? (bash.names.length ? bash.names.map((name) => `Bash(${name})`) : ["Bash"]) : [approvalKey(tool, safeInput)];
      if (keys.every((key) => always.has(key)) && !(bash && deniedOnce)) return allow("세션 허용");

      const key = bash ? `Bash(${bash.names.join(", ") || "?"})` : /** @type {string} */ (keys[0]);
      const what = describeToolUse(tool, safeInput);
      const YES = "예";
      const ALWAYS = `예, 이번 세션 동안 ${key}은(는) 묻지 않음`;
      const EVERYTHING = "예, 이번 세션 동안 모두 묻지 않음";
      const NO = "아니오";
      /** @type {string[]} */
      let answers = [];
      try {
        const preview = previewToolUse(tool, safeInput, readText);
        const again = bash && deniedOnce ? "\n(앞서 거부된 작업이 있어, 세션 허용된 명령도 다시 묻습니다.)" : "";
        answers = await ask(`${what}${again}\n실행할까요?`, [YES, ALWAYS, EVERYTHING, NO], {
          header: "권한",
          ...(preview.length ? { preview } : {}),
        });
      } catch {
        answers = [];
      }
      const picked = answers[0] ?? "";

      if (picked === EVERYTHING) {
        always.add(ALL);
        return allow("허용(이번 세션 동안 모두)");
      }
      if (picked === YES || picked === ALWAYS) {
        if (picked === ALWAYS) for (const each of keys) always.add(each);
        return allow(picked === ALWAYS ? "허용(이후 묻지 않음)" : "허용");
      }
      /*
       * 답이 없으면 거부다. 묻지도 못했는데 허용하면 이 모듈이 있는 이유가 없다.
       * 모델에게는 사람이 막았다는 사실을 그대로 알린다 — 그래야 우회하려고
       * 같은 일을 다른 도구로 다시 시도하지 않는다.
       */
      deniedOnce = true;
      onDecision?.({ tool, input: safeInput, allowed: false, how: picked === NO ? "거부" : "응답 없음" });
      return {
        behavior: "deny",
        message: picked === NO
          ? "사용자가 이 작업을 거부했습니다. 같은 일을 다른 도구로 우회하지 말고, 거부된 사실을 결과에 적으세요."
          : "승인할 사람이 없는 실행이라 거부됐습니다. 우회하지 말고, 하지 못한 일을 결과에 적으세요.",
      };
    },
  };
}
