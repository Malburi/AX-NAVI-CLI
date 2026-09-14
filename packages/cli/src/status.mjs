/*
 * 상태줄.
 *
 * 한 줄에 담을 것을 고르는 기준은 "지금 결정을 바꿀 수 있는 정보"다.
 *   실행 경로  — 구독으로 도는지 키로 도는지. 비용 체계가 다르다
 *   컨텍스트   — 얼마나 찼는지. 압축이 임박하면 /new 를 쓸지 판단하게 된다
 *   git        — 어느 브랜치에서 무엇을 건드리고 있는지
 *   턴·비용    — 이 대화에 얼마를 썼는지
 *
 * git 조회는 매번 하지 않는다. 프로세스를 띄우는 비용이 한 줄 그리는 값보다 크다.
 */
import { spawnSync } from "node:child_process";

/** @typedef {{ branch: string, added: number, removed: number } | null} GitInfo */

/** @type {{ at: number, root: string, info: GitInfo }} */
let cache = { at: 0, root: "", info: null };
const TTL_MS = 5_000;

/**
 * @param {string} root
 * @returns {GitInfo}
 */
export function gitInfo(root) {
  const now = Date.now();
  if (cache.root === root && now - cache.at < TTL_MS) return cache.info;

  /** @type {GitInfo} */
  let info = null;
  try {
    const branch = spawnSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (branch.status === 0) {
      const stat = spawnSync("git", ["-C", root, "diff", "--shortstat"], {
        encoding: "utf8",
        windowsHide: true,
      });
      // "3 files changed, 153 insertions(+), 16 deletions(-)"
      const text = stat.stdout ?? "";
      const added = Number(/(\d+) insertion/.exec(text)?.[1] ?? 0);
      const removed = Number(/(\d+) deletion/.exec(text)?.[1] ?? 0);
      info = { branch: (branch.stdout || "").trim(), added, removed };
    }
  } catch {
    info = null;
  }

  cache = { at: now, root, info };
  return info;
}

/**
 * @param {number} n
 * @returns {string}
 */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.runtime          실행 경로 짧은 이름
 * @param {number} args.contextTokens    현재 대화의 추정 토큰
 * @param {number} args.maxTokens        압축이 걸리는 지점
 * @param {number} args.turns
 * @param {number | null} args.costUsd
 * @param {number} args.queued           처리 대기 중인 입력 줄 수
 * @param {{ dim: (s: string) => string, cyan: (s: string) => string, green: (s: string) => string, yellow: (s: string) => string }} args.ui
 * @param {number} [args.width]
 * @returns {string}
 */
export function renderStatus({ root, runtime, contextTokens, maxTokens, turns, costUsd, queued, ui, width = 100 }) {
  /** @type {string[]} */
  const parts = [];

  parts.push(ui.cyan(runtime));

  // 컨텍스트가 차오르면 색으로 알린다 — 숫자만 보면 언제 위험한지 알 수 없다.
  const ratio = maxTokens > 0 ? contextTokens / maxTokens : 0;
  const ctx = `Ctx ${compact(contextTokens)}`;
  parts.push(ratio > 0.85 ? ui.yellow(ctx) : ui.dim(ctx));

  if (turns > 0) parts.push(ui.dim(`${turns}턴`));
  if (costUsd !== null) parts.push(ui.dim(`$${costUsd.toFixed(4)}`));

  const git = gitInfo(root);
  if (git) {
    const diff = git.added || git.removed ? ` ${ui.green(`+${git.added}`)}${ui.dim(",")}${ui.yellow(`-${git.removed}`)}` : "";
    parts.push(`${ui.dim("⎇")} ${git.branch}${diff}`);
  }

  // 작업 중에 친 입력이 있으면 사라진 게 아니라 줄 서 있다는 것을 보여 준다.
  if (queued > 0) parts.push(ui.yellow(`⌨ ${queued}건 대기`));

  const line = parts.join(ui.dim(" · "));
  const rule = ui.dim("─".repeat(Math.max(0, width - visibleLength(line) - 3)));
  return `${ui.dim("─")} ${line} ${rule}`;
}

/**
 * ANSI 이스케이프를 뺀 표시 길이. 색을 넣은 채로 세면 줄이 밀린다.
 * @param {string} s
 * @returns {number}
 */
function visibleLength(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "").length;
}
