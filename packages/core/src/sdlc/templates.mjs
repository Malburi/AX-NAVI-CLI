/*
 * SDLC 산출물 양식 — 찾기·읽기·채우기·완성도 검사.
 *
 * 양식은 앞에서부터 먼저 찾은 것을 쓴다(조직 양식 주입 경로).
 *   1. <프로젝트>/.axnavi/templates/<kind>.md   — 프로젝트 전용
 *   2. $AXNAVI_TEMPLATES_DIR/<kind>.md         — 조직 공용(공유 폴더에 HNIX 표준 양식을 둔다)
 *   2'. ~/.axnavi/org/templates/<kind>.md     — 플랫폼이 배포한 조직 양식(axnavi org pull)
 *   3. agents/lib/sdlc/<kind>.md.template      — 내장 기본
 *
 * 양식 머리말(--- ... ---)의 required 에 적힌 절이 "작성 필수"다. 완성도는 LLM 없이 판정한다:
 * 그 절에서 주석·빈 줄·양식에 원래 있던 줄을 빼고도 남는 내용이 있으면 작성된 것으로 본다.
 */
import { orgTemplatesDir } from "../config/org.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 단계 순서 — 게이트는 앞 단계 검사를 모두 포함한다 */
export const PHASES = /** @type {const} */ (["req", "design", "dev", "test"]);
export const PHASE_LABEL = { req: "요구", design: "설계", dev: "개발", test: "테스트" };
/** 산출물 종류(ADR 제외 — ADR 은 결정마다 한 파일) */
export const SDLC_KINDS = /** @type {const} */ (["project", "srs", "sdd", "standards", "quality", "progress"]);

const BUILTIN_DIR = fileURLToPath(new URL("../../../../agents/lib/sdlc/", import.meta.url));

/**
 * @typedef {{ kind: string, title: string, phase: string, file: string, required: string[] }} TemplateMeta
 * @typedef {{ meta: TemplateMeta, body: string, source: string }} Template
 */

/**
 * @param {{ axnaviDir: string }} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dir: string, label: string }[]}
 */
export function templateDirs(paths, env = process.env) {
  /** @type {{ dir: string, label: string }[]} */
  const dirs = [{ dir: join(paths.axnaviDir, "templates"), label: "프로젝트" }];
  if (env.AXNAVI_TEMPLATES_DIR) dirs.push({ dir: env.AXNAVI_TEMPLATES_DIR, label: "조직" });
  const org = orgTemplatesDir(env);
  if (org) dirs.push({ dir: org, label: "조직 배포본" });
  dirs.push({ dir: BUILTIN_DIR, label: "내장" });
  return dirs;
}

/**
 * 머리말 파싱 — YAML 전체가 아니라 `키: 값` 한 줄 형식만 읽는다(배포본 의존성 0).
 * @param {string} text
 * @returns {{ meta: Record<string, string>, body: string }}
 */
export function parseFrontMatter(text) {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

/**
 * @param {string} kind
 * @param {{ axnaviDir: string }} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Template}
 */
export function loadTemplate(kind, paths, env = process.env) {
  for (const { dir, label } of templateDirs(paths, env)) {
    const file = [join(dir, `${kind}.md`), join(dir, `${kind}.md.template`)].find((f) => existsSync(f));
    if (!file) continue;
    const { meta, body } = parseFrontMatter(readFileSync(file, "utf8"));
    // 조직 양식의 file: 로 docs/sdlc 밖(../, 절대 경로)에 쓰거나 덧붙이지 못하게 파일 이름만 받는다
    if (meta.file && !/^[^\\/:*?"<>|]+\.md$/.test(meta.file)) {
      throw new Error(`산출물 양식의 file 값이 올바르지 않습니다: ${meta.file} — docs/sdlc 안의 .md 파일 이름만 쓸 수 있습니다 (${file})`);
    }
    if (meta.file?.startsWith(".")) throw new Error(`산출물 양식의 file 값이 올바르지 않습니다: ${meta.file} (${file})`);
    return {
      meta: {
        kind,
        title: meta.title || kind,
        phase: meta.phase || "req",
        file: meta.file || `${kind}.md`,
        required: (meta.required ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      },
      body,
      source: `${label}: ${file}`,
    };
  }
  throw new Error(`산출물 양식을 찾지 못했습니다: ${kind}`);
}

/**
 * `{{키}}` 를 값으로 바꾼다. 값이 없는 키는 그대로 둔다 — 완성도 검사가 "채우지 못한 자리"로 알린다.
 * @param {string} body
 * @param {Record<string, string | number | undefined>} facts
 */
export function render(body, facts) {
  return body.replace(/\{\{(\w+)\}\}/g, (all, key) => (facts[key] === undefined ? all : String(facts[key])));
}

/**
 * `#` 제목 기준으로 절을 나눈다. 절의 본문은 다음 제목(수준 무관) 전까지다 —
 * 하위 절에 자동 수집한 참고 내용이 있어도 상위 절이 작성된 것으로 보이지 않게.
 * @param {string} markdown
 * @returns {Map<string, string>} 제목(번호·공백 정리) → 본문
 */
export function sections(markdown) {
  /** @type {Map<string, string>} */
  const out = new Map();
  let current = null;
  /** @type {string[]} */
  let buf = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) {
      if (current !== null && !out.has(current)) out.set(current, buf.join("\n"));
      current = headingKey(h[1] ?? "");
      buf = [];
    } else buf.push(line);
  }
  if (current !== null && !out.has(current)) out.set(current, buf.join("\n"));
  return out;
}

/**
 * "2. 기능 요구사항" → "기능 요구사항"
 * @param {string} title
 */
export function headingKey(title) {
  return title.replace(/^[\d.\s]+/, "").trim();
}

// 주석·빈 줄·표 구분선, "(…)" 한 줄짜리 안내(자동 항목이 비었을 때 넣는 문구),
// "확인 필요" 줄(답을 기다리는 질문)은 작성분이 아니다 — 질문만 남긴 절이 게이트를 통과하지 않게.
const meaningful = (/** @type {string} */ text) =>
  text.replace(/<!--[\s\S]*?-->/g, "").split("\n").map((l) => l.trim())
    .filter((l) => l && !/^\|?[\s|:-]*\|?$/.test(l) && !/^\(.*\)$/.test(l) && !/^([-*]\s*)?확인 필요/.test(l));

/**
 * 작성 필수 절 중 비었거나 양식 그대로인 절, 채우지 못한 {{자리}}, 문서 상태.
 * rendered(지금 사실로 채운 양식)를 주면 그 줄도 "원래 있던 줄"로 본다 — 자동 항목만으로는 작성된 것이 아니다.
 * @param {string} doc
 * @param {Template} template
 * @param {string} [rendered]
 * @returns {{ incomplete: string[], missingSections: string[], unresolved: string[], status: string | null }}
 */
export function inspectDocument(doc, template, rendered) {
  const docSections = sections(doc);
  const tplSections = sections(template.body);
  const renderedSections = rendered === undefined ? new Map() : sections(rendered);
  /** @type {string[]} */
  const incomplete = [];
  /** @type {string[]} */
  const missingSections = [];
  for (const name of template.meta.required) {
    const body = docSections.get(name);
    if (body === undefined) {
      missingSections.push(name);
      continue;
    }
    const original = new Set([...meaningful(tplSections.get(name) ?? ""), ...meaningful(renderedSections.get(name) ?? "")]);
    if (!meaningful(body).some((l) => !original.has(l))) incomplete.push(name);
  }
  const unresolved = [...new Set([...doc.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? ""))];
  const status = doc.match(/상태:\s*([^\s·|]+)/)?.[1] ?? null;
  return { incomplete, missingSections, unresolved, status };
}
