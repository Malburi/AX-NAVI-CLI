/*
 * 조직 설정(플랫폼 배포본) — HNIX AX 플랫폼 "AX-NAVI 조직 설정"에서 관리자가 배포한 묶음.
 *
 * `axnavi org pull`(시작할 때 10분 간격으로 자동)이 받아 ~/.axnavi/org/ 에 둔다. 여기서는 그 폴더를
 * 읽고 쓰기만 한다(네트워크는 cli/src/org.mjs). 반영 지점:
 *   policy.json   인증 경로 정책 — 허용 경로는 좁히기만, 선호·게이트웨이는 PC 공용 정책이 비워 둔 때만
 *   mcp.json      조직 MCP 서버 — 관리자가 배포한 것이라 저장소 mcp.json 과 달리 따로 허용하지 않아도 쓴다
 *   templates/    SDLC 양식 — 프로젝트 > AXNAVI_TEMPLATES_DIR > 조직 배포본 > 내장
 *   rules/        코딩 규칙 — 에이전트 지침의 <조직 규칙> 블록, IDE 전역 규칙(~/.roo/rules/axnavi-org-*.md)
 *   skills/       IDE 스킬(~/.roo/skills/<이름>) — CLI 스킬은 에이전트 묶음이라 아직 배포 대상이 아니다
 *   modes/        IDE 사용자 정의 모드(<slug>.json) — IDE 전역 custom_modes.yaml 에 넣는다(ide-modes.mjs)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { installIdeModes } from "./ide-modes.mjs";

const PATH_RE = /^(policy\.json|mcp\.json|templates\/[a-z0-9-]{1,40}\.md|rules\/[A-Za-z0-9가-힣_-]{1,60}\.md|skills\/[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80}){0,3}|modes\/[a-z0-9][a-z0-9-]{0,47}\.json)$/;
const RULES_LIMIT = 24_000;
const IDE_RULE_PREFIX = "axnavi-org-";

/**
 * @typedef {{ hash: string, profiles: { name: string, version: number }[], files: Record<string, string> }} OrgBundle
 * @typedef {{ hash: string | null, profiles: { name: string, version: number }[], files: string[], ideRules: string[], ideSkills: string[], ideModes: string[], fetchedAt: string | null, server: string | null }} OrgState
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function orgDir(env = process.env) {
  // ${변수} 치환용으로 좁힌 env 가 들어와도 프로세스 설정(시험·사내 배포 위치)을 따른다
  return env["AXNAVI_ORG_DIR"] || process.env["AXNAVI_ORG_DIR"] || join(homedir(), ".axnavi", "org");
}

/** IDE(AX-NAVI IDE·Roo 계열) 전역 폴더 — 끄려면 AXNAVI_ORG_IDE=0 @param {NodeJS.ProcessEnv} [env] */
export function ideRooDir(env = process.env) {
  if ((env["AXNAVI_ORG_IDE"] ?? process.env["AXNAVI_ORG_IDE"]) === "0") return null;
  return env["AXNAVI_IDE_ROO_DIR"] || process.env["AXNAVI_IDE_ROO_DIR"] || join(homedir(), ".roo");
}

/** @param {NodeJS.ProcessEnv} [env] @returns {OrgState} */
export function readOrgState(env = process.env) {
  const empty = { hash: null, profiles: [], files: [], ideRules: [], ideSkills: [], ideModes: [], fetchedAt: null, server: null };
  try {
    return { ...empty, ...JSON.parse(readFileSync(join(orgDir(env), ".state.json"), "utf8")) };
  } catch {
    return empty;
  }
}

/** @param {string} p */
export const isOrgPath = (p) => PATH_RE.test(p) && !p.includes("..");

/** @param {string} base @param {string} rel */
function under(base, rel) {
  const full = join(base, ...rel.split("/"));
  if (!full.startsWith(base + sep) && full !== base) throw new Error(`경로가 폴더 밖을 가리킵니다: ${rel}`);
  return full;
}

/**
 * 배포본을 ~/.axnavi/org 에 깔고, IDE 전역 폴더에 규칙·스킬을 놓는다.
 * 지난번에 깔았던 것 중 이번에 없는 것은 지운다 — 우리가 깐 것만(목록은 .state.json).
 * @param {OrgBundle} bundle @param {{ env?: NodeJS.ProcessEnv, server?: string | null, now?: Date }} [opts]
 * @returns {{ written: number, removed: number, ideRules: number, ideSkills: number, ideModes: number, modeNotes: string[], skipped: string[] }}
 */
export function installOrgBundle(bundle, opts = {}) {
  const env = opts.env ?? process.env;
  const dir = orgDir(env);
  const prev = readOrgState(env);
  /** @type {string[]} */
  const skipped = [];
  const files = Object.entries(bundle.files ?? {}).filter(([p, body]) => {
    const ok = isOrgPath(p) && typeof body === "string";
    if (!ok) skipped.push(p);
    return ok;
  });
  mkdirSync(dir, { recursive: true });
  let removed = 0;
  const now = new Set(files.map(([p]) => p));
  for (const p of prev.files) {
    if (now.has(p) || !isOrgPath(p)) continue;
    rmSync(under(dir, p), { force: true });
    removed += 1;
  }
  for (const [p, body] of files) {
    const full = under(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }

  // IDE — 규칙은 axnavi-org- 접두사 파일로, 스킬은 폴더째. 사용자가 만든 것은 건드리지 않는다
  const roo = ideRooDir(env);
  /** @type {string[]} */
  const ideRules = [];
  /** @type {string[]} */
  const ideSkills = [];
  if (roo) {
    const rulesDir = join(roo, "rules");
    for (const name of prev.ideRules) if (/^axnavi-org-[^/\\]+\.md$/.test(name)) rmSync(join(rulesDir, name), { force: true });
    for (const name of prev.ideSkills) if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && !files.some(([p]) => p.startsWith(`skills/${name}/`))) rmSync(join(roo, "skills", name), { recursive: true, force: true });
    for (const [p, body] of files) {
      if (p.startsWith("rules/")) {
        const name = `${IDE_RULE_PREFIX}${p.slice("rules/".length)}`;
        mkdirSync(rulesDir, { recursive: true });
        writeFileSync(join(rulesDir, name), body, "utf8");
        ideRules.push(name);
      } else if (p.startsWith("skills/")) {
        const skill = p.split("/")[1];
        const full = under(join(roo, "skills"), p.slice("skills/".length));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body, "utf8");
        if (skill && !ideSkills.includes(skill)) ideSkills.push(skill);
      }
    }
  }
  // IDE 사용자 정의 모드 — 전역 custom_modes.yaml 에(사용자가 만든 같은 slug 가 있으면 그쪽을 둔다)
  /** @type {string[]} */
  let ideModes = prev.ideModes ?? [];
  /** @type {string[]} */
  const modeNotes = [];
  const modeFiles = files.filter(([p]) => p.startsWith("modes/")).map(([p, body]) => ({ slug: p.slice("modes/".length, -".json".length), body }));
  if (modeFiles.length || ideModes.length) {
    const m = installIdeModes(modeFiles, ideModes, env);
    if (m.error) modeNotes.push(m.error);
    else if (m.file) ideModes = m.installed;
    if (m.kept.length) modeNotes.push(`같은 이름의 사용자 모드가 있어 조직 모드를 넣지 않음: ${m.kept.join(", ")}`);
    if (m.invalid.length) modeNotes.push(`형식이 맞지 않는 모드: ${m.invalid.join(", ")}`);
  }
  /** @type {OrgState} */
  const state = { hash: bundle.hash ?? null, profiles: bundle.profiles ?? [], files: [...now], ideRules, ideSkills, ideModes, fetchedAt: (opts.now ?? new Date()).toISOString(), server: opts.server ?? null };
  writeFileSync(join(dir, ".state.json"), JSON.stringify(state, null, 2), "utf8");
  return { written: files.length, removed, ideRules: ideRules.length, ideSkills: ideSkills.length, ideModes: ideModes.length, modeNotes, skipped };
}

/** 받은 시각만 새로 적는다(304 — 바뀐 것 없음) @param {NodeJS.ProcessEnv} [env] @param {Date} [now] */
export function touchOrgState(env = process.env, now = new Date()) {
  const s = readOrgState(env);
  if (!s.hash) return;
  writeFileSync(join(orgDir(env), ".state.json"), JSON.stringify({ ...s, fetchedAt: now.toISOString() }, null, 2), "utf8");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function orgPolicyPath(env = process.env) {
  const p = join(orgDir(env), "policy.json");
  return existsSync(p) ? p : null;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function orgMcpPath(env = process.env) {
  const p = join(orgDir(env), "mcp.json");
  return existsSync(p) ? p : null;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function orgTemplatesDir(env = process.env) {
  const p = join(orgDir(env), "templates");
  return existsSync(p) ? p : null;
}

/**
 * 에이전트 지침에 붙일 조직 규칙 — 이름 순으로 이어 붙이고 너무 길면 자른다.
 * @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function orgRulesText(env = process.env) {
  const dir = join(orgDir(env), "rules");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  if (!names.length) return null;
  let text = names.map((n) => readFileSync(join(dir, n), "utf8").trim()).filter(Boolean).join("\n\n");
  if (!text) return null;
  if (text.length > RULES_LIMIT) text = `${text.slice(0, RULES_LIMIT)}\n… (조직 규칙이 길어 잘랐습니다)`;
  return ["<조직 규칙>", "조직(HNIX AX 플랫폼)이 배포한 규칙이다. 프로젝트 지침과 함께 지킨다.", text, "</조직 규칙>"].join("\n");
}
