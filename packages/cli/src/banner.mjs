/*
 * 시작 화면.
 *
 * 박스로 전체를 감싸지 않는 이유가 있다. 한글은 터미널에서 두 칸을 차지하는데
 * 폰트와 터미널마다 계산이 달라, 한글이 들어간 줄에 오른쪽 테두리를 맞추면
 * 환경에 따라 어긋난다. 그래서 테두리는 ASCII 폭이 고정된 마스코트에만 두고,
 * 한글은 테두리 바깥 자유 영역에 흘린다 — 어디서 열어도 깨지지 않는다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ui } from "./runtime.mjs";

const C = (/** @type {string} */ code, /** @type {string} */ text) =>
  process.stdout.isTTY && !process.env["NO_COLOR"] ? `[${code}m${text}[0m` : text;

/** 굵은 청록 — 워드마크와 마스코트의 눈. */
const brand = (/** @type {string} */ s) => C("1;36", s);

/**
 * @param {string} version
 * @returns {string}
 */
export function renderBanner(version) {
  return [
    "",
    `  ${ui.cyan("╭─────────╮")}   ${brand("▄▀█ ▀▄▀   █▄░█ ▄▀█ █░█ █")}`,
    `  ${ui.cyan("│")} ${brand("◉")} ${ui.dim("───")} ${brand("◉")} ${ui.cyan("│")}   ${brand("█▀█ █░█   █░▀█ █▀█ ▀▄▀ █")}`,
    `  ${ui.cyan("│")}   ${ui.dim("▁▁▁")}   ${ui.cyan("│")}`,
    `  ${ui.cyan("╰──┬───┬──╯")}   ${ui.dim("ITO/SI 레거시 코드베이스를 위한 AI 개발 내비게이터")}`,
    `  ${ui.cyan("═══╧═══╧═══")}   ${ui.dim(`Enterprise AI Development Navigator · v${version}`)}`,
    "",
    "",
  ].join("\n");
}

/** 인덱서 어댑터 이름 → 사람이 읽는 스택 이름. */
const ADAPTER_LABEL = {
  jvm: "Java/Kotlin",
  javascript: "JavaScript/TS",
  python: "Python",
  dotnet: ".NET",
  sql: "SQL",
  "legacy-web": "Legacy Web",
  nexacro: "Nexacro",
  go: "Go",
};

/**
 * 인덱스에서 스택을 읽는다. 추측하지 않고 인덱서가 실제로 분류한 것만 쓴다.
 * @param {string} indexDir
 * @returns {{ stack: string, files: number, tier: string } | null}
 */
export function readStack(indexDir) {
  try {
    const meta = JSON.parse(readFileSync(join(indexDir, "_meta.json"), "utf8"));
    const extensions = meta?.adapter_coverage?.extensions ?? [];
    /** @type {Map<string, number>} */
    const byAdapter = new Map();
    for (const entry of extensions) {
      const name = entry?.adapter;
      if (!name || name === "generic") continue;
      byAdapter.set(name, (byAdapter.get(name) ?? 0) + (entry.files ?? 0));
    }
    const ranked = [...byAdapter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name]) => ADAPTER_LABEL[/** @type {keyof typeof ADAPTER_LABEL} */ (name)] ?? name);
    return {
      stack: ranked.length ? ranked.join(" · ") : "탐지된 스택 없음",
      files: meta?.files_total ?? 0,
      tier: meta?.tier ?? "-",
    };
  } catch {
    return null;
  }
}

/**
 * `라벨  값` 한 줄. 라벨 폭을 고정해 세로로 맞춘다.
 * @param {string} label
 * @param {string} value
 */
export function row(label, value) {
  return `  ${ui.dim(label.padEnd(9))} ${value}`;
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
export function block(lines) {
  return `${lines.join("\n")}\n`;
}
