/*
 * Grep — 내용 검색.
 *
 * ripgrep이 있으면 쓰고, 없으면 Node로 직접 훑는다. ITO 현장은 폐쇄망이 흔해서
 * 외부 바이너리를 전제하지 않는다. 어느 쪽을 썼는지는 결과에 밝힌다.
 */
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isWithin } from "../../config/paths.mjs";

/** @typedef {import("../../../types/tools.js").ToolHandler} ToolHandler */

const MAX_HITS = 200;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "out", "bin", "obj",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage",
]);

/** @type {boolean | null} */
let rgAvailable = null;
function hasRipgrep() {
  if (rgAvailable === null) {
    try {
      rgAvailable = spawnSync("rg", ["--version"], { encoding: "utf8" }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

/**
 * @param {string} base
 * @param {RegExp} re
 * @param {string | undefined} glob
 * @param {string[]} hits
 * @returns {Promise<void>}
 */
async function nodeGrep(base, re, glob, hits) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  const suffix = glob ? glob.replace(/^\*+/, "") : null;
  for (const entry of entries) {
    if (hits.length >= MAX_HITS) return;
    const full = join(base, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await nodeGrep(full, re, glob, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    if (suffix && !entry.name.endsWith(suffix)) continue;
    let text;
    try {
      text = await readFile(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i += 1) {
      const line = lines[i] ?? "";
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${full}:${i + 1}:${line.trim().slice(0, 300)}`);
    }
  }
}

/** @type {ToolHandler} */
export const grepTool = {
  definition: {
    name: "Grep",
    description: "정규식으로 파일 내용을 검색한다. 결과는 `파일:줄:내용` 형식이며 상한이 걸린다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "정규식" },
        path: { type: "string", description: "검색 시작 경로 (기본: 프로젝트 루트)" },
        glob: { type: "string", description: "파일 필터 (예: *.java)" },
        "-i": { type: "boolean", description: "대소문자 무시" },
      },
    },
  },
  async run(input, ctx) {
    const base = resolve(ctx.paths.root, input.path ?? ".");
    if (!isWithin(ctx.allowedRoots, base)) {
      return { content: `프로젝트 루트 밖의 경로다: ${base}`, isError: true };
    }

    if (hasRipgrep()) {
      const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "20"];
      if (input["-i"]) args.push("-i");
      if (input.glob) args.push("--glob", input.glob);
      args.push(input.pattern, base);
      const out = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      // rg: 0=찾음, 1=없음, 2 이상=오류. 1을 실패로 보면 "결과 없음"이 오류가 된다.
      if ((out.status ?? 2) >= 2) {
        return { content: `검색 실패(rg): ${out.stderr?.trim() || "알 수 없는 오류"}`, isError: true };
      }
      const lines = (out.stdout || "").split("\n").filter(Boolean);
      if (!lines.length) return { content: `일치 없음: ${input.pattern}` };
      const capped = lines.slice(0, MAX_HITS);
      const more = lines.length > capped.length ? `\n... (${lines.length - capped.length}건 더, 잘림)` : "";
      return { content: capped.join("\n") + more };
    }

    let re;
    try {
      re = new RegExp(input.pattern, input["-i"] ? "i" : "");
    } catch (error) {
      return { content: `정규식이 올바르지 않다: ${/** @type {Error} */ (error).message}`, isError: true };
    }
    /** @type {string[]} */
    const hits = [];
    await nodeGrep(base, re, input.glob, hits);
    if (!hits.length) return { content: `일치 없음: ${input.pattern} (ripgrep 없이 Node 검색)` };
    const more = hits.length >= MAX_HITS ? `\n... (상한 ${MAX_HITS}건에서 잘림)` : "";
    return { content: hits.join("\n") + more };
  },
};
