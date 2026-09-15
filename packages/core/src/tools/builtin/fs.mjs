/*
 * 파일 도구 — Read / Write / Glob.
 *
 * 이름을 Claude Code 내장 도구와 똑같이 맞춘 것은 의도적이다(결정 D4).
 * agents/*.md 19종 중 13종이 `tools: Read, Grep, Glob, Bash, Write`를 그대로 선언하고
 * 본문도 그 이름으로 쓰여 있어서, 이름만 맞추면 프롬프트 본문을 한 글자도 고치지 않아도 된다.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isWithin } from "../../config/paths.mjs";

/** @typedef {import("../../../types/tools.js").ToolHandler} ToolHandler */
/** @typedef {import("../../../types/tools.js").ToolContext} ToolContext */

const MAX_READ_BYTES = 256 * 1024;
const MAX_GLOB_HITS = 2000;
const MAX_GLOB_REPORTED = 200;

/**
 * @param {ToolContext} ctx
 * @param {string} target
 * @returns {string}
 */
function guardPath(ctx, target) {
  const abs = resolve(target);
  if (!isWithin(ctx.allowedRoots, abs)) throw new Error(`프로젝트 루트 밖의 경로다: ${abs}`);
  return abs;
}

/** @type {ToolHandler} */
export const readTool = {
  definition: {
    name: "Read",
    description: "파일을 읽는다. 줄 번호가 붙어 돌아온다. 큰 파일은 offset/limit으로 잘라 읽는다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "절대경로 또는 프로젝트 루트 기준 상대경로" },
        offset: { type: "integer", description: "시작 줄 (1부터)" },
        limit: { type: "integer", description: "읽을 줄 수" },
      },
    },
  },
  async run(input, ctx) {
    const abs = guardPath(ctx, resolve(ctx.paths.root, input.file_path));
    const info = await stat(abs);
    if (info.size > MAX_READ_BYTES && !input.limit) {
      return {
        content: `파일이 큽니다 (${info.size} bytes > ${MAX_READ_BYTES}). offset/limit으로 나눠 읽으세요.`,
        isError: true,
      };
    }
    const text = await readFile(abs, "utf8");
    const lines = text.split("\n");
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const end = input.limit ? start + input.limit : lines.length;
    const numbered = lines.slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join("\n");
    const suffix = end < lines.length ? `\n... (${lines.length - end}줄 더 있음)` : "";
    return { content: numbered + suffix };
  },
};

/** @type {ToolHandler} */
export const writeTool = {
  definition: {
    name: "Write",
    description: "파일을 쓴다. 이미 있으면 덮어쓴다. 상위 디렉터리는 자동 생성된다.",
    mutates: true,
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      properties: { file_path: { type: "string" }, content: { type: "string" } },
    },
  },
  async run(input, ctx) {
    const abs = guardPath(ctx, resolve(ctx.paths.root, input.file_path));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, "utf8");
    return { content: `기록함: ${relative(ctx.paths.root, abs)} (${Buffer.byteLength(input.content, "utf8")} bytes)` };
  },
};

/*
 * 부분 수정.
 *
 * Write만 있으면 한 줄을 고치려고 파일 전체를 다시 써야 한다. 큰 파일일수록 토큰이 들고,
 * 더 나쁜 것은 모델이 기억으로 재구성한 나머지가 조용히 달라질 수 있다는 점이다.
 * 바꿀 자리를 명시하는 편이 안전하다.
 *
 * 예전에는 이 도구가 아예 없었다. 그래서 `tools:` 선언이 없는 에이전트 6종(analyzer·
 * writer·api-bridge·pattern-extractor·test-generator·pipeline-runner)과 오케스트레이터가
 * 플러그인 때는 가지고 있던 수단을 잃었다(실측: "No such tool available: Edit").
 *
 * 소스를 고치지 않는 13종은 frontmatter에 Edit을 적지 않았으므로 그대로 제외된다 —
 * allowedTools가 그 역할을 한다. 여기서 할 일은 도구를 존재하게 만드는 것뿐이다.
 */
/** @type {ToolHandler} */
export const editTool = {
  definition: {
    name: "Edit",
    description:
      "파일의 한 대목만 바꾼다. old_string은 파일 안에서 유일해야 한다 — " +
      "여러 군데 있으면 주변 문맥을 더 붙여 유일하게 만들거나 replace_all을 써라.",
    mutates: true,
    inputSchema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string", description: "바꿀 대목. 공백과 줄바꿈까지 그대로" },
        new_string: { type: "string", description: "바꿀 내용. 지우려면 빈 문자열" },
        replace_all: { type: "boolean", description: "모두 바꿀지 여부" },
      },
    },
  },
  async run(input, ctx) {
    const abs = guardPath(ctx, resolve(ctx.paths.root, input.file_path));
    const shown = relative(ctx.paths.root, abs);
    const before = await readFile(abs, "utf8");

    if (input.old_string === input.new_string) {
      return { content: "바꿀 것과 바뀔 것이 같다.", isError: true };
    }

    /*
     * 못 찾았거나 여러 군데면 **실패로 돌려준다.**
     * 조용히 성공한 척하면 모델은 고쳤다고 믿고 다음 단계로 간다.
     */
    const hits = countOccurrences(before, input.old_string);
    if (hits === 0) {
      return { content: `그 대목을 ${shown} 에서 찾지 못했다. Read로 지금 내용을 확인하라.`, isError: true };
    }
    if (hits > 1 && input.replace_all !== true) {
      return {
        content: `그 대목이 ${shown} 에 ${hits}군데 있다. 주변 문맥을 더 붙여 유일하게 만들거나 replace_all을 써라.`,
        isError: true,
      };
    }

    const after = input.replace_all === true
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string);
    await writeFile(abs, after, "utf8");
    return { content: `고쳐씀: ${shown} (${hits}군데)` };
  },
};

/**
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/* 의존성을 늘리지 않으려고 최소 글롭을 직접 만든다. **, *, ? 만 지원한다. */
/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += "(?:.*)";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c !== undefined && "\^$+.()|{}[]".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp(`^${out}$`, "i");
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "out", "bin", "obj",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage", "_workspace",
]);

/**
 * @param {string} dir
 * @param {string} rootDir
 * @param {string[]} hits
 * @returns {Promise<void>}
 */
async function walk(dir, rootDir, hits) {
  if (hits.length >= MAX_GLOB_HITS) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (hits.length >= MAX_GLOB_HITS) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, rootDir, hits);
    } else if (entry.isFile()) {
      hits.push(relative(rootDir, full).split(sep).join("/"));
    }
  }
}

/** @type {ToolHandler} */
export const globTool = {
  definition: {
    name: "Glob",
    description: "글롭 패턴으로 파일을 찾는다 (예: **/*.java). 벤더·빌드 디렉터리는 제외된다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "검색 시작 디렉터리 (기본: 프로젝트 루트)" },
      },
    },
  },
  async run(input, ctx) {
    const base = guardPath(ctx, resolve(ctx.paths.root, input.path ?? "."));
    /** @type {string[]} */
    const all = [];
    await walk(base, base, all);
    const re = globToRegExp(input.pattern);
    const matched = all.filter((rel) => re.test(rel) || re.test(rel.split("/").at(-1) ?? ""));
    if (!matched.length) return { content: `일치하는 파일 없음: ${input.pattern}` };
    const capped = matched.slice(0, MAX_GLOB_REPORTED);
    const more = matched.length > capped.length ? `\n... (${matched.length - capped.length}건 더, 잘림)` : "";
    return { content: capped.join("\n") + more };
  },
};
