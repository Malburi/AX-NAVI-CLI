/*
 * 프로젝트 컨텍스트.
 *
 * 에이전트에게 "여기가 어떤 프로젝트인지"를 먼저 알려 준다. 이게 없으면 매 대화가
 * 프로젝트 루트가 어딘지 묻는 것부터 시작한다(실측: "대상 프로젝트 루트 경로도
 * 함께 주시면 탐색을 시작하겠습니다").
 *
 * 크기를 엄격히 제한하는 것이 핵심이다. 컨텍스트는 공짜가 아니고, 이 블록은 모든
 * 대화의 첫머리에 붙는다. 그래서 **인덱스가 이미 계산해 둔 사실**만 담는다 —
 * 파일을 훑어 요약하는 일은 하지 않는다. 그건 에이전트가 도구로 할 일이다.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @typedef {import("../../types/paths.js").ProjectPaths} ProjectPaths */

/** CLAUDE.md 를 통째로 싣지 않는다. 앞부분이 대개 핵심이고 뒤는 변경 이력이다. */
const CLAUDE_MD_LIMIT = 4000;

/**
 * @param {string} path
 * @param {number} limit
 * @returns {string | null}
 */
function readCapped(path, limit) {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    return text.length > limit ? `${text.slice(0, limit)}\n\n(… 이하 생략. 필요하면 직접 읽어라.)` : text;
  } catch {
    return null;
  }
}

/**
 * 인덱스 메타에서 프로젝트 사실을 뽑는다. 없으면 조용히 건너뛴다.
 * @param {string} indexDir
 */
function indexFacts(indexDir) {
  try {
    const meta = JSON.parse(readFileSync(join(indexDir, "_meta.json"), "utf8"));
    const adapters = new Map();
    for (const entry of meta?.adapter_coverage?.extensions ?? []) {
      if (!entry?.adapter || entry.adapter === "generic") continue;
      adapters.set(entry.adapter, (adapters.get(entry.adapter) ?? 0) + (entry.files ?? 0));
    }
    return {
      files: meta?.files_total ?? 0,
      tier: meta?.tier ?? "-",
      layout: meta?.init_layout ?? "single-root",
      stacks: [...adapters.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      generatedAt: meta?.generated_at ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {ProjectPaths} args.paths
 * @param {boolean} [args.includeClaudeMd]  위임 경로는 claude가 스스로 읽으므로 중복을 피한다
 * @returns {string}
 */
export function buildProjectContext({ paths, includeClaudeMd = true }) {
  /** @type {string[]} */
  const lines = ["<프로젝트>", `루트: ${paths.root}`];

  const facts = indexFacts(paths.indexDir);
  if (facts) {
    lines.push(`인덱스: 있음 · 파일 ${facts.files}개 · tier ${facts.tier} · 구성 ${facts.layout}`);
    if (facts.stacks.length) lines.push(`스택: ${facts.stacks.join(", ")}`);
    lines.push(
      `인덱스 질의는 QueryIndex 도구를 써라. 원본 JSON(${paths.indexDir})을 직접 열지 마라 — 대형 레거시에서는 수십 MB다.`,
    );
  } else {
    lines.push("인덱스: 없음 — 구조 파악이 필요하면 사용자에게 `axnavi index build` 를 권하라.");
  }

  if (existsSync(paths.pairConfigPath)) {
    lines.push(`페어 설정: ${paths.pairConfigPath} (분리 저장소 연동)`);
  }

  const claudeMdPath = join(paths.root, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    if (includeClaudeMd) {
      const body = readCapped(claudeMdPath, CLAUDE_MD_LIMIT);
      if (body) {
        lines.push("", "<프로젝트 가이드 — CLAUDE.md>", body.trim(), "</프로젝트 가이드>");
      }
    } else {
      // 위임 경로에서는 claude가 CLAUDE.md를 자동으로 읽는다. 두 번 실으면 낭비다.
      lines.push("프로젝트 가이드: CLAUDE.md 있음");
    }
  }

  lines.push("</프로젝트>");
  return lines.join("\n");
}

/**
 * 인덱스가 소스보다 오래됐는지 한 줄로. 오래됐으면 에이전트가 그걸 알고 답해야 한다.
 * @param {ProjectPaths} paths
 * @returns {string | null}
 */
export function indexAgeNote(paths) {
  try {
    const metaPath = join(paths.indexDir, "_meta.json");
    if (!existsSync(metaPath)) return null;
    const days = (Date.now() - statSync(metaPath).mtimeMs) / 86_400_000;
    if (days < 7) return null;
    return `인덱스가 ${Math.floor(days)}일 전 것이다. 결과가 최신 소스와 다를 수 있음을 밝혀라.`;
  } catch {
    return null;
  }
}
