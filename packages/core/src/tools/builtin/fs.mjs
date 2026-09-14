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
