/*
 * CLI 런타임 조립.
 *
 * Core는 "누가 묻고, 어디에 기록하고, 어떻게 보여줄지"를 모른다 — 전부 인터페이스로만 받는다.
 * 이 파일이 그 구멍을 터미널 구현으로 메운다. 다른 프런트엔드(IDE 확장, 서버 모드)를 붙일 때
 * 갈아끼우는 지점도 여기다.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {import("@ax-navi/core").AuditRecord} AuditRecord */
/** @typedef {import("@ax-navi/core").ProjectPaths} ProjectPaths */

/** 이 저장소 루트. CLI가 설치된 위치에서 agents/·skills/를 찾는다 — 환경변수가 필요 없는 이유다. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const AGENTS_DIR = join(REPO_ROOT, "agents");
export const SKILLS_DIR = join(REPO_ROOT, "skills");

/* ---------- 출력 ---------- */

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
/** @param {string} code @param {string} text */
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);

export const ui = {
  /** @param {string} s */ dim: (s) => paint("2", s),
  /** @param {string} s */ bold: (s) => paint("1", s),
  /** @param {string} s */ cyan: (s) => paint("36", s),
  /** @param {string} s */ green: (s) => paint("32", s),
  /** @param {string} s */ yellow: (s) => paint("33", s),
  /** @param {string} s */ red: (s) => paint("31", s),
};

export const BANNER = `
${ui.cyan("╔══════════════════════════════════════════╗")}
${ui.cyan("║")}            ${ui.bold("AX-NAVI CLI")}                   ${ui.cyan("║")}
${ui.cyan("║")}   ${ui.dim("Enterprise AI Development Navigator")}    ${ui.cyan("║")}
${ui.cyan("╚══════════════════════════════════════════╝")}`;

/* ---------- 감사 기록 ---------- */

/**
 * 감사 기록은 JSONL로 남긴다. 어떤 역할이 어떤 도구를 어떤 입력으로 불렀고
 * 허용됐는지 거부됐는지가 한 줄에 들어간다(브리프 §12).
 * @param {ProjectPaths} paths
 */
export function createAuditSink(paths) {
  const file = join(paths.logsDir, "audit.jsonl");
  /** @type {Promise<unknown>} */
  let chain = mkdir(paths.logsDir, { recursive: true });
  return {
    /** @param {AuditRecord} entry */
    record(entry) {
      // 입력에 비밀값이 섞일 수 있으므로 길이를 자르고 통째로 남기지 않는다.
      const safe = { ...entry, input: redact(entry.input) };
      chain = chain
        .then(() => appendFile(file, `${JSON.stringify(safe)}\n`, "utf8"))
        .catch(() => undefined);
    },
    flush: () => chain,
    file,
  };
}

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|credential)/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…(잘림)` : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "***" : redact(v);
  }
  return out;
}

/* ---------- 사용자 질의 ---------- */

/**
 * Claude Code의 AskUserQuestion 자리. 그쪽에 있던 옵션 4개 상한은 여기 없다.
 * 비대화형(파이프 입력 등)에서는 묻지 않고 사유를 돌려준다 — 멈춰 서서 매달리지 않는다.
 */
export function createElicitor() {
  return {
    /**
     * @param {string} question
     * @param {readonly string[]} options
     * @param {{ multiSelect?: boolean }} [opts]
     * @returns {Promise<string[]>}
     */
    async ask(question, options, opts = {}) {
      if (!process.stdin.isTTY) return [];
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        process.stdout.write(`\n${ui.yellow("?")} ${ui.bold(question)}\n`);
        if (!options.length) {
          const free = await rl.question(ui.dim("  > "));
          return free.trim() ? [free.trim()] : [];
        }
        options.forEach((opt, i) => process.stdout.write(`  ${ui.cyan(String(i + 1))}. ${opt}\n`));
        const hint = opts.multiSelect ? "번호(쉼표로 여러 개)" : "번호";
        const answer = (await rl.question(ui.dim(`  ${hint} > `))).trim();
        if (!answer) return [];
        const picked = answer
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
          .map((n) => /** @type {string} */ (options[n - 1]));
        // 번호로 안 읽히면 자유 입력으로 취급한다.
        return picked.length ? picked : [answer];
      } finally {
        rl.close();
      }
    },
  };
}

/* ---------- 진행 표시 ---------- */

export function createProgressSink() {
  return {
    /**
     * @param {string} taskId
     * @param {"pending" | "in_progress" | "completed" | "failed"} status
     * @param {string} [title]
     */
    update(taskId, status, title) {
      const mark = { pending: "·", in_progress: "▶", completed: "✓", failed: "✗" }[status];
      const color = status === "failed" ? ui.red : status === "completed" ? ui.green : ui.dim;
      process.stderr.write(`${color(`  ${mark} ${taskId}${title ? ` · ${title}` : ""}`)}\n`);
    },
  };
}
