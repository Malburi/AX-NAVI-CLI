/*
 * 아키텍처 결정 기록(ADR) — docs/adr/NNNN-<제목>.md. 번호는 폴더에서 가장 큰 번호 + 1.
 * doc-syncer 가 쓰던 위치·이름 규칙(`docs/adr/NNNN-[제목].md`)을 그대로 따른다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTemplate, render } from "./templates.mjs";

export const ADR_DIR = join("docs", "adr");
export const ADR_STATUSES = ["제안", "채택", "폐기", "대체됨"];

/**
 * @param {{ root: string }} paths
 * @returns {{ no: string, title: string, status: string, fileName: string, file: string }[]}
 */
export function listAdrs(paths) {
  const dir = join(paths.root, ADR_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort()
    .map((fileName) => {
      const file = join(dir, fileName);
      const text = readFileSync(file, "utf8");
      const no = fileName.slice(0, 4);
      const title = text.match(/^#\s+(?:ADR-\d+:\s*)?(.+?)\s*$/m)?.[1] ?? fileName.slice(5, -3);
      const status = text.match(/상태:\s*([^\s·|]+)/)?.[1] ?? "미상";
      return { no, title, status, fileName, file };
    });
}

/**
 * 파일 이름에 쓸 수 없는 글자만 걷어 낸다 — 한글 제목은 그대로 둔다
 * @param {string} title
 */
export function adrSlug(title) {
  return title.trim().replace(/[\\/:*?"<>|#]+/g, "").replace(/\s+/g, "-").slice(0, 60) || "결정";
}

/**
 * @param {{ root: string, axnaviDir: string }} paths
 * @param {string} title
 * @param {{ status?: string, context?: string, decision?: string, alternatives?: string, consequences?: string, now?: Date, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ no: string, file: string }}
 */
export function createAdr(paths, title, opts = {}) {
  const clean = title.trim();
  if (!clean) throw new Error("ADR 제목이 비었습니다.");
  const status = opts.status ?? "제안";
  if (!ADR_STATUSES.includes(status)) throw new Error(`ADR 상태가 올바르지 않습니다: ${status} (${ADR_STATUSES.join(" | ")})`);
  const existing = listAdrs(paths);
  const next = existing.reduce((max, a) => Math.max(max, Number(a.no)), 0) + 1;
  const no = String(next).padStart(4, "0");
  const dir = join(paths.root, ADR_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${no}-${adrSlug(clean)}.md`);
  const tpl = loadTemplate("adr", paths, opts.env ?? process.env);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(opts.now ?? new Date());
  const blank = (/** @type {string} */ hint) => `<!-- 작성: ${hint} -->`;
  writeFileSync(file, render(tpl.body, {
    no,
    title: clean,
    status,
    date,
    context: opts.context?.trim() || blank("결정이 필요했던 상황·제약·근거(인덱스 질의 결과, 요구사항 ID)"),
    decision: opts.decision?.trim() || blank("무엇을 하기로 했는가"),
    alternatives: opts.alternatives?.trim() || blank("검토한 대안과 고르지 않은 이유"),
    consequences: opts.consequences?.trim() || blank("좋아지는 점, 감수하는 점, 후속 작업"),
  }), "utf8");
  return { no, file };
}
