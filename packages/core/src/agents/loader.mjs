/*
 * 에이전트 로더 + 프롬프트 shim.
 *
 * 기존 agents/*.md 19종을 **한 글자도 고치지 않고** 시스템 프롬프트로 쓰는 것이 목표다.
 * 플러그인을 병행 유지하기로 했으므로(결정 D-C) 그 파일들은 Claude Code도 계속 읽는다 —
 * 즉 무변경은 취향이 아니라 제약이다.
 *
 * 실측한 결합도는 낮다. analyzer.md 690줄 중 결합 지점은 6줄(약 0.9%)이고,
 * 도구 이름은 이미 Read/Grep/Glob/Bash/Write라 그대로 맞아떨어진다(결정 D4).
 * 그래서 재작성이 아니라 로딩 시점의 얇은 치환으로 끝난다.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { toTier } from "../llm/tier.mjs";

/** @typedef {import("../../types/llm.js").ModelTier} ModelTier */
/** @typedef {import("../../types/tools.js").RolePolicy} RolePolicy */

/**
 * @typedef {object} AgentDefinition
 * @property {string} name
 * @property {string} description
 * @property {ModelTier} tier
 * @property {string} systemPrompt   shim이 적용된 본문
 * @property {RolePolicy} role
 * @property {string} sourcePath
 * @property {string[]} warnings
 */

/** 부수효과를 내는 도구. frontmatter가 이 중 하나라도 선언하면 쓰기 역할로 본다. */
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * frontmatter를 읽는다. 이 저장소의 frontmatter는 전부 평평한 `key: value`라
 * 완전한 YAML 파서가 필요 없다 — 의존성을 늘리지 않으려고 최소 구현만 둔다.
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: normalized };
  const head = normalized.slice(3, end);
  const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1);
  /** @type {Record<string, string>} */
  const data = {};
  let currentKey = null;
  for (const rawLine of head.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (match && match[1]) {
      currentKey = match[1];
      data[currentKey] = (match[2] ?? "").trim();
    } else if (currentKey && /^\s/.test(rawLine)) {
      // description이 여러 줄로 접힌 경우를 이어 붙인다.
      data[currentKey] = `${data[currentKey] ?? ""} ${line.trim()}`.trim();
    }
  }
  return { data, body };
}

/**
 * Claude Code 전제를 걷어낸다.
 *
 * 치환이 아니라 "번역"이라는 점이 중요하다 — 지침을 지우면 에이전트가 무엇을 해야 하는지
 * 모르게 되므로, 같은 의도를 CLI에서 성립하는 문장으로 바꾼다.
 * @param {string} body
 * @param {{ pluginRoot: string, projectRoot: string }} env
 * @returns {{ prompt: string, warnings: string[] }}
 */
export function applyPromptShim(body, env) {
  /** @type {string[]} */
  const warnings = [];
  let out = body;

  // 1) 스크립트 경로 — CLI는 자기 설치 경로를 알고 있으므로 환경변수가 필요 없다.
  const pluginRootRefs = (out.match(/\$\{?env:CLAUDE_PLUGIN_ROOT\}?|\$\{?CLAUDE_PLUGIN_ROOT\}?/g) ?? []).length;
  if (pluginRootRefs) {
    out = out.replace(/\$env:CLAUDE_PLUGIN_ROOT|\$\{env:CLAUDE_PLUGIN_ROOT\}|\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, env.pluginRoot);
    warnings.push(`CLAUDE_PLUGIN_ROOT 참조 ${pluginRootRefs}곳을 실제 경로로 치환했다.`);
  }

  // 2) 파이썬 인터프리터 — python3가 깨진 셰임인 환경이 실재한다(이 머신이 그렇다:
  //    `python3 --version`이 "Python "만 출력하고 exit 49). 이름을 고정하지 않게 안내한다.
  if (/\bpython3?\s+["']?\S*\.py/.test(out)) {
    out += "\n\n> 실행 참고: 파이썬 인터프리터 이름(`python` / `python3`)을 하드코딩하지 마라." +
      " 어느 쪽이 동작하는지는 환경마다 다르다 — Bash 도구로 먼저 `--version`을 확인하고 성공한 이름을 써라.\n";
  }

  // 3) Claude Code 고유 도구 — TaskUpdate는 Gateway가 받아 주므로 그대로 두고,
  //    나머지(Agent/Task 생성, Skill 호출)는 이 런타임에 없다는 사실을 명시한다.
  const hostOnly = ["TaskCreate", "TaskStop", "Skill("].filter((token) => out.includes(token));
  if (hostOnly.length) {
    out += `\n\n> 실행 참고: 이 런타임에는 ${hostOnly.join(", ")}가 없다.` +
      " 해당 지시는 건너뛰고, 진행 상황은 `TaskUpdate` 도구로만 알려라.\n";
    warnings.push(`호스트 전용 기능 참조: ${hostOnly.join(", ")} — 안내문으로 무력화했다.`);
  }

  return { prompt: out, warnings };
}

/**
 * @param {string} filePath
 * @param {{ pluginRoot: string, projectRoot: string }} env
 * @returns {Promise<AgentDefinition>}
 */
export async function loadAgent(filePath, env) {
  const text = await readFile(filePath, "utf8");
  const { data, body } = parseFrontmatter(text);
  const name = data["name"] || basename(filePath, ".md");
  const { tier, warning } = toTier(data["model"]);
  const { prompt, warnings } = applyPromptShim(body, env);

  const declared = data["tools"]
    ? data["tools"].split(",").map((t) => t.trim()).filter(Boolean)
    : null;
  // frontmatter에 tools가 없으면 전체 허용 — 기존 규약 그대로다.
  // 선언이 있으면 그것이 곧 허용 목록이고, Gateway가 런타임에 강제한다.
  const allowMutations = declared ? declared.some((t) => MUTATING_TOOLS.has(t)) : true;

  return {
    name,
    description: data["description"] ?? "",
    tier,
    systemPrompt: prompt,
    sourcePath: filePath,
    warnings: warning ? [warning, ...warnings] : warnings,
    role: {
      name,
      allowedTools: declared ? [...declared, "TaskUpdate"] : null,
      allowMutations,
    },
  };
}

/**
 * @param {string} agentsDir
 * @param {{ pluginRoot: string, projectRoot: string }} env
 * @returns {Promise<AgentDefinition[]>}
 */
export async function loadAllAgents(agentsDir, env) {
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(agentsDir, e.name));
  const loaded = await Promise.all(files.map((f) => loadAgent(f, env)));
  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}
