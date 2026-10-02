/*
 * 소스 쓰기 판정 — 도구가 프로젝트 소스를 바꾸는지 실행 전에 가린다.
 *
 * 왜 필요한가. v1 의 승인 게이트는 Edit·Write 도구에만 걸려 있었다. 실측(실제 레거시 벤치 C-R2-1):
 * 모델이 Edit 대신 `python -c "open(...,'w')…"` 로 24곳을 고쳤고, 자동 모드 판정기는 그 명령을
 * 묻지 않고 통과시켰다. 승인 창은 한 번도 뜨지 않았고 EUC-KR 보존 훅도 거치지 않았다.
 * 지침("Edit 로만 고쳐라")은 지켜지지 않을 수 있다 — 그래서 셸 명령까지 사실로 판정한다.
 *
 * 판정은 보수적이다. 쓰는 대상을 알 수 없는 쓰기(인터프리터 인라인 코드, 남이 쓴 스크립트,
 * 작업 트리를 바꾸는 git 명령)는 "소스일 수 있음" 으로 본다. 대상을 아는 쓰기는 경로로 가린다:
 *   source   — 프로젝트(여럿이면 그중 하나) 안의 소스. 묻는다
 *   exempt   — 프로젝트 안이지만 axnavi 산출물·빌드 결과(_workspace/, .axnavi/, target/ …). 묻지 않는다
 *   temp     — 임시 폴더. 묻지 않는다
 *   foreign  — 어느 프로젝트에도 속하지 않는 그 밖의 곳(홈 · 시스템 폴더 · 등록 안 된 저장소). 묻는다
 *
 * 이 파일은 의존성이 없다. claude -p 연결은 이 파일을 훅 명령으로 돌린다(맨 아래).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/* ───────────────────────── 셸 명령 자르기 ───────────────────────── */

/**
 * @typedef {object} Segment
 * @property {string[]} words       명령과 인자 (따옴표 벗김)
 * @property {string[]} redirects   `>`·`>>` 로 쓰는 파일
 * @property {string} heredoc       `<<EOF` 본문 (명령의 입력)
 */

/**
 * 셸 명령을 따옴표를 존중하며 `&&`·`||`·`;`·`|`·`&`·줄바꿈 단위로 자른다.
 * 따옴표 밖의 파일 리다이렉트·명령 치환이 있으면 `risky` 로 알린다.
 * @param {string} command
 * @returns {{ segments: Segment[], risky: boolean }}
 */
export function splitShell(command) {
  /** @type {Segment[]} */
  const segments = [{ words: [], redirects: [], heredoc: "" }];
  let word = "";
  let quote = "";
  let risky = false;
  let redirectNext = false;
  const current = () => /** @type {Segment} */ (segments.at(-1));
  const endWord = () => {
    if (word) {
      if (redirectNext) current().redirects.push(word);
      else current().words.push(word);
      redirectNext = false;
    }
    word = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const n = command[i + 1];
    if (c === undefined) break;
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
     * 명령으로 읽으면 승인 창에 `Bash(python3, import, with, …)` 가 뜬다. 본문은 따로 들고 간다.
     */
    if (c === "<" && n === "<" && command[i + 2] !== "<") {
      const spec = command.slice(i + 2).match(/^-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
      const lineEnd = command.indexOf("\n", i);
      if (spec && lineEnd >= 0) {
        const delim = spec[2];
        const lines = command.slice(lineEnd + 1).split("\n");
        let offset = lineEnd + 1;
        /** @type {string[]} */
        const body = [];
        for (const line of lines) {
          offset += line.length + 1;
          if (line.trim() === delim) break;
          body.push(line);
        }
        endWord();
        /* `<<EOF` 와 줄끝 사이에 남은 말(`> out.txt` 등)은 그대로 읽어야 한다. */
        const restOfLine = command.slice(i + 2 + (spec[0]?.length ?? 0), lineEnd);
        const inner = splitShell(restOfLine);
        for (const seg of inner.segments) {
          current().words.push(...seg.words);
          current().redirects.push(...seg.redirects);
        }
        if (inner.risky) risky = true;
        current().heredoc += body.join("\n");
        i = offset - 2; // 다음 반복에서 본문 끝 줄바꿈부터 이어 읽는다
        continue;
      }
    }
    if (c === "`" || (c === "$" && n === "(") || (c === "<" && n === "(")) { risky = true; word += c; continue; }
    if (c === ">") {
      /* `2>&1`·`>&2`·`>/dev/null`·`2>/dev/null` 은 파일을 쓰지 않는다. */
      const rest = command.slice(i + 1).replace(/^>/, "").trimStart();
      const toNull = /^\/dev\/null\b/.test(rest) || /^NUL\b/i.test(rest) || /^\$null\b/i.test(rest);
      if (word && /^\d+$/.test(word)) word = ""; // `2>` 의 파일 서술자 번호
      endWord();
      if (n === "&") { i += 2; continue; }
      if (toNull) {
        const m = /** @type {RegExpMatchArray} */ (rest.match(/^(\/dev\/null|NUL|\$null)/i));
        i = command.indexOf(m[0], i) + m[0].length - 1;
        continue;
      }
      risky = true;
      if (n === ">") i += 1;
      redirectNext = true;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      endWord();
      redirectNext = false;
      if ((c === "&" || c === "|") && n === c) i += 1;
      const last = current();
      if (last.words.length || last.redirects.length || last.heredoc) segments.push({ words: [], redirects: [], heredoc: "" });
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
  }
  endWord();
  if (quote) risky = true;
  return { segments: segments.filter((s) => s.words.length || s.redirects.length), risky };
}

/* ───────────────────────── 쓰기 탐지 ───────────────────────── */

/** 인라인 코드·스크립트 본문이 파일을 쓰거나 다른 프로그램을 돌릴 수 있는 흔적. */
const CODE_WRITES = [
  /\bopen\s*\([^,)]*,\s*['"][rbt]*[wax+][rwxabt+]*['"]/, // python open(path, 'w')
  /\bmode\s*=\s*['"][rbt]*[wax+]/,
  /\b(?:io|codecs)\.open\s*\(/,
  /\.write_(?:text|bytes)\s*\(/,
  /\bshutil\.(?:copy\w*|move|rmtree)\b/,
  /\bos\.(?:remove|rename|replace|unlink|rmdir|removedirs|makedirs|mkdir|system|popen|truncate)\b/,
  /\bsubprocess\b|\bos\.exec\w*\b|\bpty\.spawn\b/,
  /\.(?:unlink|rename|rmdir|touch|mkdir)\s*\(/,
  /\bfileinput\b[^\n]*inplace/,
  /\b(?:writeFile|appendFile|createWriteStream|copyFile|cpSync|rmSync|renameSync|unlinkSync|truncateSync|mkdirSync|writeSync|openSync)\w*/,
  /\bfs\.(?:write|rm|cp|rename|unlink|truncate|mkdir|open)\w*\b/,
  /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFile\w*\b/,
  /\bFile\.(?:write|open|delete|rename)\b|\bFileUtils\b/, // ruby
  /\bopen\s*\(\s*(?:my\s+)?\$?\w+\s*,\s*['"]?\+?[>]/, // perl open(FH, '>file')
];

/** PowerShell 에서 파일을 쓰는 표현. */
const PS_WRITES = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content|Tee-Object|Export-\w+|Start-Process|Invoke-Expression|iex)\b|\[(?:System\.)?IO\.File\]|WriteAll(?:Text|Bytes|Lines)|AppendAll(?:Text|Lines)|(?:^|[^-\w&])>{1,2}\s*(?!\$null|&)/i;

/** @param {string} code */
const codeWrites = (code) => CODE_WRITES.some((re) => re.test(code));

const INTERPRETERS = new Set(["python", "python3", "py", "node", "perl", "ruby", "php", "deno", "bun"]);
const POWERSHELL = new Set(["powershell", "pwsh"]);
const GIT_WORKTREE = new Set(["apply", "checkout", "switch", "restore", "reset", "stash", "merge", "rebase", "cherry-pick", "revert", "am", "pull", "clean", "mv", "rm"]);

/**
 * @typedef {object} ShellWrites
 * @property {string[]} targets   쓰는 파일(절대경로). glob 은 고정 부분까지만
 * @property {string[]} unknown   대상을 알 수 없는 쓰기 설명 ("python -c 인라인 코드" 등)
 */

/** @param {string} word */
const programOf = (word) => (word.replace(/\\/g, "/").split("/").at(-1) ?? "").toLowerCase().replace(/\.exe$/, "");

/** @param {string[]} args @returns {string[]} */
const positional = (args) => args.filter((a) => !a.startsWith("-"));

/**
 * 경로 문자열을 절대경로로. 변수·홈을 풀 수 없으면 null.
 * @param {string} raw
 * @param {string} cwd
 * @returns {string | null}
 */
function toPath(raw, cwd) {
  let p = raw.trim();
  if (!p) return null;
  if (/^(?:\$TMPDIR|\$TMP|\$TEMP|\$\{TMPDIR\}|\$env:TEMP|\$env:TMP|%TEMP%|%TMP%)(?=[\\/]|$)/i.test(p)) p = p.replace(/^[^\\/]+/, tmpdir());
  if (p.startsWith("~")) return null;
  if (/[$%]/.test(p)) return null;
  /* Git Bash 의 `/c/Users/…` 는 `C:/Users/…` 다. */
  p = p.replace(/^\/([a-zA-Z])\//, "$1:/");
  /* glob 은 고정 부분까지만 본다 — `src/**\/*.java` → `src`. */
  const wild = p.search(/[*?[{]/);
  if (wild >= 0) p = p.slice(0, wild).replace(/[^\\/]*$/, "") || ".";
  return resolve(cwd, p);
}

/**
 * 셸 명령이 파일을 쓰는지.
 * @param {string} command
 * @param {{ cwd: string, pluginRoot?: string, powershell?: boolean }} opts
 * @returns {ShellWrites}
 */
export function shellWrites(command, opts) {
  /** @type {ShellWrites} */
  const out = { targets: [], unknown: [] };
  if (opts.powershell) {
    psWrites(command, opts.cwd, out);
    return out;
  }
  let cwd = opts.cwd;
  const pluginLib = opts.pluginRoot ? resolve(opts.pluginRoot, "agents", "lib") + sep : "";
  /** @param {string} raw */
  const target = (raw) => {
    const p = toPath(raw, cwd);
    if (p) out.targets.push(p);
    else out.unknown.push(`경로를 풀 수 없는 쓰기 대상 ${raw}`);
  };
  for (const seg of splitShell(command).segments) {
    for (const r of seg.redirects) target(r);
    let at = 0;
    const w = seg.words;
    while (at < w.length && /^[A-Za-z_]\w*=/.test(w[at] ?? "")) at += 1;
    while (["do", "then", "else", "elif", "if", "while", "until", "!", "{", "sudo", "nohup", "time", "command", "exec"].includes(w[at] ?? "")) at += 1;
    if (at >= w.length) continue;
    const prog = programOf(w[at] ?? "");
    const args = w.slice(at + 1);
    const pos = positional(args);
    segmentWrites(prog, args, pos, seg, { cwd, pluginLib, target, out });
    if ((prog === "cd" || prog === "pushd") && pos[0]) {
      const next = toPath(pos[0], cwd);
      if (next) cwd = next;
    }
  }
  return out;
}

/**
 * @param {string} prog
 * @param {string[]} args
 * @param {string[]} pos
 * @param {Segment} seg
 * @param {{ cwd: string, pluginLib: string, target: (raw: string) => void, out: ShellWrites }} ctx
 */
function segmentWrites(prog, args, pos, seg, ctx) {
  const { target, out } = ctx;
  const valueOf = (/** @type {string[]} */ flags) => {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? "";
      for (const f of flags) {
        if (a === f && args[i + 1]) return args[i + 1];
        if (f.startsWith("--") && a.startsWith(`${f}=`)) return a.slice(f.length + 1);
        if (!f.startsWith("--") && a.startsWith(f) && a.length > f.length) return a.slice(f.length);
      }
    }
    return null;
  };
  switch (prog) {
    case "tee":
      for (const p of pos) target(p);
      return;
    case "sed": {
      const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
      const hasE = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"));
      const script = hasE ? args.filter((_, i) => ["-e", "--expression"].includes(args[i - 1] ?? "")).join(";") : (pos[0] ?? "");
      if (/(?:^|[;}\s/])w\s+\S|\/[gpiImMe0-9]*w\s+\S|(?:^|;)\s*e\b/.test(script)) out.unknown.push("sed 의 w·e 명령");
      if (inPlace) for (const p of hasE ? pos : pos.slice(1)) target(p);
      return;
    }
    case "perl":
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a))) { for (const p of pos.slice(1)) target(p); return; }
      break;
    case "sort": {
      const o = valueOf(["-o", "--output"]);
      if (o) target(o);
      return;
    }
    case "uniq":
      if (pos.length >= 2) target(/** @type {string} */ (pos[1]));
      return;
    case "tree": {
      const o = valueOf(["-o"]);
      if (o) target(o);
      return;
    }
    case "date":
      if (args.some((a) => a === "-s" || a.startsWith("--set"))) out.unknown.push("시스템 시각 변경");
      return;
    case "cp": case "mv": case "install": case "ln": case "rsync": case "copy": case "move": case "xcopy": case "robocopy": {
      const t = valueOf(["-t", "--target-directory"]);
      if (t) target(t);
      else if (pos.length >= 2) target(/** @type {string} */ (pos.at(-1)));
      else out.unknown.push(`${prog} 대상`);
      if (prog === "mv" || prog === "move") for (const p of pos.slice(0, -1)) target(p);
      return;
    }
    case "rm": case "rmdir": case "unlink": case "del": case "erase": case "truncate": case "touch": case "mkdir": case "chmod": case "chown": case "shred":
      for (const p of prog === "chmod" || prog === "chown" ? pos.slice(1) : pos) target(p);
      return;
    case "dd": {
      const of = args.find((a) => a.startsWith("of="));
      if (of) target(of.slice(3));
      return;
    }
    case "patch":
      out.unknown.push("patch 적용");
      return;
    case "git": {
      const rest = [...args];
      while (rest.length && (rest[0] ?? "").startsWith("-")) rest.splice(0, ["-C", "-c", "--git-dir", "--work-tree"].includes(rest[0] ?? "") ? 2 : 1);
      const sub = rest[0] ?? "";
      if (GIT_WORKTREE.has(sub) && !(sub === "stash" && ["list", "show"].includes(rest[1] ?? ""))) out.unknown.push(`git ${sub} (작업 트리 변경)`);
      return;
    }
    case "awk": case "gawk":
      if (args.some((a) => /system\s*\(|print[^|]*>|printf[^|]*>/.test(a))) out.unknown.push("awk 의 파일 출력·system");
      return;
    case "xargs": {
      let i = 0;
      while (i < args.length && (args[i] ?? "").startsWith("-")) i += ["-I", "-n", "-P", "-L", "-d", "-s", "-E"].includes(args[i] ?? "") ? 2 : 1;
      if (i < args.length) {
        const inner = args.slice(i);
        const p = programOf(inner[0] ?? "");
        if (["rm", "mv", "cp", "sed", "tee", "touch", "chmod", "perl", "truncate"].includes(p)) out.unknown.push(`xargs ${p} (대상이 입력으로 정해짐)`);
        else segmentWrites(p, inner.slice(1), positional(inner.slice(1)), { words: inner, redirects: [], heredoc: "" }, ctx);
      }
      return;
    }
    case "cmd":
      if (/\b(?:del|erase|copy|move|ren|rename|mklink|xcopy|robocopy|rd|rmdir|md|mkdir)\b|>/i.test(args.join(" "))) out.unknown.push("cmd /c 의 파일 변경");
      return;
    case "find":
      if (args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(a))) out.unknown.push("find 의 -delete·-exec");
      return;
    default:
      break;
  }
  if (POWERSHELL.has(prog)) {
    const idx = args.findIndex((a) => /^-(?:c|command|e|ec|encodedcommand|f|file)$/i.test(a));
    const flag = idx >= 0 ? (args[idx] ?? "").toLowerCase() : "";
    if (/^-(?:e|ec|encodedcommand)$/.test(flag)) { out.unknown.push("powershell 인코딩된 명령"); return; }
    if (/^-(?:f|file)$/.test(flag)) { scriptWrites(args[idx + 1] ?? "", ctx, "powershell 스크립트", true); return; }
    const code = idx >= 0 ? args.slice(idx + 1).join(" ") : args.join(" ");
    psWrites(code, ctx.cwd, out);
    return;
  }
  if (INTERPRETERS.has(prog) || /^python3?\.\d+$/.test(prog)) {
    /* -c / -e / -E / -r 는 인라인 코드다. */
    const inlineAt = args.findIndex((a) => ["-c", "-e", "-E", "-r", "--eval", "-p", "--print"].includes(a));
    if (inlineAt >= 0) {
      if (codeWrites(args.slice(inlineAt + 1).join(" "))) out.unknown.push(`${prog} 인라인 코드의 파일 쓰기`);
      return;
    }
    const script = args.find((a) => !a.startsWith("-") && a !== "-m");
    if (!script || script === "-") {
      if (seg.heredoc ? codeWrites(seg.heredoc) : true) out.unknown.push(`${prog} 표준입력 코드`);
      return;
    }
    if (args.includes("-m")) {
      /* `python -m pip install` 등 — 소스 쓰기로 보지 않는다. 모듈 실행은 승인기가 따로 묻는다. */
      return;
    }
    scriptWrites(script, ctx, `${prog} 스크립트`, false);
  }
}

/**
 * 스크립트 파일을 돌린다. axnavi 자신의 스크립트(agents/lib)는 산출물을 _workspace 에만 쓴다.
 * 남의 스크립트는 본문을 읽어 쓰기 흔적이 있으면 "대상 모름" 이다.
 * @param {string} raw
 * @param {{ cwd: string, pluginLib: string, out: ShellWrites }} ctx
 * @param {string} label
 * @param {boolean} powershell
 */
function scriptWrites(raw, ctx, label, powershell) {
  const p = toPath(raw.replace(/^\$(?:env:)?\{?CLAUDE_PLUGIN_ROOT\}?/, ctx.pluginLib ? resolve(ctx.pluginLib, "..", "..") : "$CLAUDE_PLUGIN_ROOT"), ctx.cwd);
  /* 경로를 resolve 로 정규화한 뒤 비교한다 — `agents/lib/../../x.py` 는 우리 스크립트가 아니다. */
  if (p && ctx.pluginLib && p.toLowerCase().startsWith(ctx.pluginLib.toLowerCase())) return;
  if (!p || !existsSync(p)) { ctx.out.unknown.push(`${label} ${raw}`); return; }
  let text = "";
  try {
    if (statSync(p).size > 2 * 1024 * 1024) { ctx.out.unknown.push(`${label} ${raw}`); return; }
    text = readFileSync(p, "utf8");
  } catch {
    ctx.out.unknown.push(`${label} ${raw}`);
    return;
  }
  if (powershell ? PS_WRITES.test(text) : codeWrites(text)) ctx.out.unknown.push(`${label} ${raw} 의 파일 쓰기`);
}

/**
 * PowerShell 코드의 쓰기. `-Path`·`-FilePath`·`-LiteralPath`·`-Destination` 값을 대상으로 잡는다.
 * @param {string} code
 * @param {string} cwd
 * @param {ShellWrites} out
 */
function psWrites(code, cwd, out) {
  if (!PS_WRITES.test(code)) return;
  const found = [...code.matchAll(/-(?:Path|FilePath|LiteralPath|Destination)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/gi)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const redirects = [...code.matchAll(/(?:^|[^-\w&])>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "").filter((r) => !/^\$null$/i.test(r));
  /* Set-Content x.txt 처럼 위치 인자로 준 경로. */
  const positionalTargets = [...code.matchAll(/\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Clear-Content)\s+(?!-)(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  const all = [...found, ...redirects, ...positionalTargets];
  const unresolved = /WriteAll|AppendAll|\[(?:System\.)?IO\.File\]|Start-Process|Invoke-Expression|\biex\b|Export-|Tee-Object/i.test(code);
  if (!all.length || unresolved) out.unknown.push("PowerShell 의 파일 쓰기");
  for (const raw of all) {
    const p = toPath(raw, cwd);
    if (p) out.targets.push(p);
    else out.unknown.push(`경로를 풀 수 없는 쓰기 대상 ${raw}`);
  }
}

/* ───────────────────────── 경로 분류 ───────────────────────── */

/**
 * 프로젝트 안이지만 묻지 않는 곳. axnavi 산출물과 빌드 결과물이다.
 * `.claude/` 는 통째로 빼지 않는다 — settings·hooks 는 권한과 실행을 바꾸므로 묻는다(v1 우회 경로).
 * skills·agents·commands 는 harness-init 이 쓰는 지침 문서라 뺀다.
 */
const EXEMPT_DIRS = ["_workspace", ".axnavi", "node_modules", "target", "build", "dist", ".gradle"];
const EXEMPT_CLAUDE = ["skills", "agents", "commands"];
const EXEMPT_ROOT_FILES = ["claude.md", "agents.md"];

/**
 * @typedef {"source" | "exempt" | "temp" | "foreign"} TargetKind
 */

/**
 * @param {string} path   절대경로
 * @param {string[]} roots  프로젝트 루트들(절대경로)
 * @returns {{ kind: TargetKind, root: string | null }}
 */
export function classifyTarget(path, roots) {
  const abs = resolve(path);
  for (const root of roots) {
    const rel = relative(resolve(root), abs);
    if (rel === "" ) return { kind: "source", root };
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const first = (parts[0] ?? "").toLowerCase();
    if (parts.length === 1 && EXEMPT_ROOT_FILES.includes(first)) return { kind: "exempt", root };
    if (EXEMPT_DIRS.includes(first)) return { kind: "exempt", root };
    if (first === ".claude" && EXEMPT_CLAUDE.includes((parts[1] ?? "").toLowerCase())) return { kind: "exempt", root };
    return { kind: "source", root };
  }
  const tmp = relative(resolve(tmpdir()), abs);
  if (tmp !== "" && !tmp.startsWith("..") && !isAbsolute(tmp)) return { kind: "temp", root: null };
  return { kind: "foreign", root: null };
}

/* ───────────────────────── 판정 ───────────────────────── */

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * @typedef {object} SourceWrite
 * @property {Array<{ path: string, root: string }>} files   쓰는 소스 파일(root 가 "" 이면 저장소 밖)
 * @property {string[]} unknown                             대상을 알 수 없는 쓰기
 * @property {string} via                                   "edit" | "shell"
 */

/**
 * 이 도구 호출이 프로젝트 소스를 바꾸는가. 아니면 null.
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {{ cwd: string, roots: string[], pluginRoot?: string }} opts
 * @returns {SourceWrite | null}
 */
export function sourceWrite(tool, input, opts) {
  const roots = opts.roots.length ? opts.roots : [opts.cwd];
  if (EDIT_TOOLS.has(tool)) {
    const raw = typeof input["file_path"] === "string" ? input["file_path"] : typeof input["notebook_path"] === "string" ? input["notebook_path"] : "";
    if (!raw) return null;
    const hit = classifyTarget(resolve(opts.cwd, raw), roots);
    return hit.kind === "source" || hit.kind === "foreign" ? { files: [{ path: resolve(opts.cwd, raw), root: hit.root ?? "" }], unknown: [], via: "edit" } : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input["command"] === "string" ? input["command"] : "";
    if (!command.trim()) return null;
    const writes = shellWrites(command, { cwd: opts.cwd, ...(opts.pluginRoot ? { pluginRoot: opts.pluginRoot } : {}), powershell: tool === "PowerShell" });
    /** @type {Array<{ path: string, root: string }>} */
    const files = [];
    for (const t of writes.targets) {
      const hit = classifyTarget(t, roots);
      if (hit.kind === "source" || hit.kind === "foreign") files.push({ path: t, root: hit.root ?? "" });
    }
    if (!files.length && !writes.unknown.length) return null;
    return { files, unknown: writes.unknown, via: "shell" };
  }
  return null;
}

/**
 * 승인 창·감사에 쓸 한 줄.
 * @param {SourceWrite} w
 * @param {string} cwd
 */
export function describeSourceWrite(w, cwd) {
  const names = w.files.map((f) => relative(cwd, f.path) || f.path).slice(0, 4);
  const more = w.files.length > 4 ? ` 외 ${w.files.length - 4}` : "";
  const parts = [];
  if (names.length) parts.push(`${names.join(", ")}${more}`);
  if (w.unknown.length) parts.push(`대상 확인 불가: ${w.unknown.slice(0, 2).join(", ")}`);
  return parts.join(" · ");
}

export const SHELL_WRITE_REASON =
  "axnavi: 셸 명령으로 프로젝트 소스를 바꾸려 한다 — 사람의 승인이 필요하다. 소스 수정은 Edit 도구로 하는 것이 원칙이다(바뀌는 줄을 보여 주고 레거시 인코딩을 지킨다).";

/**
 * PreToolUse 훅 결정. 소스를 바꾸지 않으면 빈 객체.
 * `mode` 가 "plan" 이면 거부, 그 밖에는 사람에게 묻는다("ask").
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {{ cwd: string, roots: string[], pluginRoot?: string, mode?: string }} opts
 */
export function writeGuardDecision(tool, input, opts) {
  const w = sourceWrite(tool, input ?? {}, opts);
  if (!w) return {};
  const what = describeSourceWrite(w, opts.cwd);
  const deny = opts.mode === "plan";
  return {
    hookSpecificOutput: {
      hookEventName: /** @type {const} */ ("PreToolUse"),
      permissionDecision: /** @type {"ask" | "deny"} */ (deny ? "deny" : "ask"),
      permissionDecisionReason: deny
        ? `axnavi: 계획 모드에서는 소스를 바꾸지 않는다 (${what}).`
        : `${w.via === "shell" ? SHELL_WRITE_REASON : "axnavi: 프로젝트 소스 수정 — 사람의 승인이 필요하다."} (${what})`,
    },
  };
}

/*
 * 훅 명령으로 돌 때 — stdin 의 훅 JSON 을 읽어 결정을 쓴다. 루트 목록은 AXNAVI_SOURCE_ROOTS(JSON 배열).
 * AXNAVI_WRITE_GUARD=1 일 때만 판정한다 — 가드를 끈 모드(빠름 · 전부승인)와 axnavi 밖에서는 아무것도 하지 않는다.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env["AXNAVI_WRITE_GUARD"] === "1") {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    /** @type {any} */
    let event = {};
    try { event = JSON.parse(raw || "{}"); } catch { return; }
    /** @type {string[]} */
    let roots = [];
    try { roots = JSON.parse(process.env["AXNAVI_SOURCE_ROOTS"] || "[]"); } catch { roots = []; }
    const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
    const decision = writeGuardDecision(String(event.tool_name ?? ""), event.tool_input ?? {}, {
      cwd,
      roots,
      ...(process.env["AXNAVI_PLUGIN_ROOT"] ? { pluginRoot: process.env["AXNAVI_PLUGIN_ROOT"] } : {}),
      ...(process.env["AXNAVI_MODE"] ? { mode: process.env["AXNAVI_MODE"] } : {}),
    });
    if (decision.hookSpecificOutput) process.stdout.write(JSON.stringify(decision));
  });
}
