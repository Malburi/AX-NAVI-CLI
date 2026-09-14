/*
 * 서브커맨드 구현.
 *
 * 인자 파싱을 직접 하는 것은 이 저장소의 기존 방식과 같다(agents/lib/*.mjs의 parseArgs).
 * 의존성을 하나 줄이는 값이 프레임워크의 편의보다 크다 — 배포 대상이 폐쇄망이다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  buildIndex,
  indexStaleness,
  INDEXER_VERSION,
  resolveIndexDir,
} from "@ax-navi/indexer";
import {
  inspectProject,
  loadAllAgents,
  loadAllSkills,
  resolveSkill,
  resolveProjectPaths,
} from "@ax-navi/core";
import { AGENTS_DIR, REPO_ROOT, SKILLS_DIR, ui } from "./runtime.mjs";
import { executeAgent } from "./execute.mjs";

const AGENT_ENV = { pluginRoot: REPO_ROOT, projectRoot: process.cwd() };

/* ---------- init ---------- */

/**
 * `.axnavi/`만 만든다. `_workspace/`는 건드리지 않는다 — 플러그인과 공유하는 상태라
 * CLI가 함부로 손대면 양쪽이 어긋난다(결정 D-B).
 * @param {string} root
 */
export async function cmdInit(root) {
  const paths = resolveProjectPaths(root);
  const state = inspectProject(paths);
  if (state.initialized) {
    process.stdout.write(`${ui.yellow("이미 초기화됨")} — ${paths.configPath}\n`);
    return 0;
  }
  await mkdir(paths.axnaviDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  const yaml = [
    "# AX-NAVI CLI 설정",
    "version: 1",
    `created_at: ${new Date().toISOString()}`,
    "provider: anthropic",
    "",
    "# 런타임 상태는 _workspace/ 에 그대로 둔다 (Claude Code 플러그인과 공유).",
    "# .axnavi/ 는 CLI 설정·세션·로그 전용이다.",
    "workspace_dir: _workspace",
    "index_dir: _workspace/index",
    "",
  ].join("\n");
  await writeFile(paths.configPath, yaml, "utf8");
  await writeFile(
    join(paths.axnaviDir, ".gitignore"),
    ["sessions/", "logs/", "*.tmp-*", ""].join("\n"),
    "utf8",
  );

  process.stdout.write(`${ui.green("생성")} ${paths.configPath}\n`);
  if (state.hasPluginHarness) {
    process.stdout.write(ui.dim("  기존 플러그인 하네스(CLAUDE.md + .claude/)를 발견했다 — 그대로 둔다.\n"));
  }
  if (!state.hasIndex) {
    process.stdout.write(ui.dim("  다음: axnavi index build\n"));
  }
  return 0;
}

/* ---------- doctor ---------- */

/** @param {string} root */
export async function cmdDoctor(root) {
  const paths = resolveProjectPaths(root);
  const state = inspectProject(paths);
  /** @type {Array<[boolean | "warn", string, string]>} */
  const rows = [];

  const nodeOk = Number(process.versions.node.split(".")[0]) >= 18;
  rows.push([nodeOk, "Node", `${process.version}${nodeOk ? "" : " (18 이상 필요)"}`]);

  // python3가 깨진 셰임인 환경이 실재한다 — 이름을 고정하지 않고 실제로 실행해 확인한다.
  const python = probePython();
  rows.push([
    python ? true : "warn",
    "Python",
    python ? `${python.bin} ${python.version}` : "없음 — wiki·validator 계열은 Phase 2라 MVP에는 영향 없음",
  ]);

  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  rows.push([git.status === 0, "git", (git.stdout || "").trim() || "없음"]);

  const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
  rows.push([
    hasKey ? true : "warn",
    "API 키",
    hasKey ? "설정됨" : "미설정 — index 계열은 동작하고, ask/agent/skill은 키가 필요하다",
  ]);

  rows.push([state.initialized ? true : "warn", "CLI 설정", state.initialized ? paths.configPath : "없음 — axnavi init"]);

  if (state.hasIndex) {
    const st = indexStaleness(paths.root);
    // reason 문자열을 그대로 보여준다. exit code로 뭉개면 "왜"가 사라진다.
    rows.push([st.stale ? "warn" : true, "인덱스", `${st.stale ? "갱신 필요" : "최신"} — ${st.reason}`]);
  } else {
    rows.push(["warn", "인덱스", `없음 — axnavi index build (${paths.indexDir})`]);
  }

  rows.push([true, "인덱서", `v${INDEXER_VERSION}`]);
  rows.push([true, "에이전트", `${(await loadAllAgents(AGENTS_DIR, AGENT_ENV)).length}개`]);
  rows.push([true, "스킬", `${(await loadAllSkills(SKILLS_DIR)).length}개`]);

  process.stdout.write(`\n${ui.bold("진단")}  ${ui.dim(paths.root)}\n\n`);
  for (const [ok, label, detail] of rows) {
    const mark = ok === true ? ui.green("✓") : ok === "warn" ? ui.yellow("!") : ui.red("✗");
    process.stdout.write(`  ${mark} ${label.padEnd(10)} ${ui.dim(detail)}\n`);
  }
  process.stdout.write("\n");
  return rows.some(([ok]) => ok === false) ? 1 : 0;
}

function probePython() {
  for (const bin of ["python3", "python", "py"]) {
    try {
      const out = spawnSync(bin, ["--version"], { encoding: "utf8" });
      const text = `${out.stdout || ""}${out.stderr || ""}`.trim();
      // Windows Store 셰임은 exit 49에 "Python "만 출력한다 — 버전 숫자까지 확인해야 한다.
      if (out.status === 0 && /Python\s+3/.test(text)) return { bin, version: text.replace(/^Python\s+/, "") };
    } catch {
      /* 다음 후보로 */
    }
  }
  return null;
}

/* ---------- index ---------- */

/**
 * @param {string} root
 * @param {string} sub
 * @param {{ tier?: string, indexDir?: string }} opts
 */
export async function cmdIndex(root, sub, opts) {
  const paths = resolveProjectPaths(root, opts.indexDir);
  const indexDir = resolveIndexDir(paths.root, opts.indexDir);

  if (sub === "status") {
    if (!existsSync(join(indexDir, "_meta.json"))) {
      process.stdout.write(`${ui.yellow("인덱스 없음")} — ${indexDir}\n  axnavi index build\n`);
      return 1;
    }
    const st = indexStaleness(paths.root, opts.indexDir);
    process.stdout.write(
      `${st.stale ? ui.yellow("갱신 필요") : ui.green("최신")}  ${st.reason}\n` +
        ui.dim(`  경로 ${indexDir}\n  지문 ${st.fingerprint ?? "-"}\n`),
    );
    return st.stale ? 1 : 0;
  }

  if (sub !== "build" && sub !== "refresh") {
    process.stderr.write(`알 수 없는 하위 명령: index ${sub} (build | status | refresh)\n`);
    return 2;
  }

  const mode = sub === "refresh" ? "incremental" : "init";
  process.stdout.write(`${ui.dim(`인덱싱 (${mode}, LLM 미사용)`)}  ${paths.root}\n`);
  const started = Date.now();
  const result = buildIndex({
    root: paths.root,
    mode,
    tier: /** @type {any} */ (opts.tier ?? "Auto"),
    ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  process.stdout.write(
    `${ui.green("완료")} ${seconds}s  파일 ${result.files}개 · tier ${result.tier} · 인덱스 ${result.indexes.length}종` +
      (result.unresolved ? ` · 미해결 ${result.unresolved}건` : "") +
      `\n${ui.dim(`  ${indexDir}\n`)}`,
  );
  return 0;
}

/* ---------- agent ---------- */

/**
 * @param {string} root
 * @param {string[]} argv
 */
export async function cmdAgent(root, argv) {
  const sub = argv[0] ?? "list";
  if (sub === "list") {
    const agents = await loadAllAgents(AGENTS_DIR, AGENT_ENV);
    process.stdout.write(`\n${ui.bold(`에이전트 ${agents.length}개`)}\n\n`);
    for (const a of agents) {
      const tools = a.role.allowedTools ? a.role.allowedTools.filter((t) => t !== "TaskUpdate").join(",") : "(전체)";
      process.stdout.write(
        `  ${ui.cyan(a.name.padEnd(22))} ${ui.dim(a.tier.padEnd(9))} ${ui.dim(tools)}\n` +
          `  ${" ".repeat(22)} ${ui.dim(a.description.slice(0, 96))}\n`,
      );
    }
    process.stdout.write("\n");
    return 0;
  }
  if (sub === "run") {
    const name = argv[1];
    const prompt = argv.slice(2).join(" ");
    if (!name || !prompt) {
      process.stderr.write("사용법: axnavi agent run <이름> <요청>\n");
      return 2;
    }
    if (!existsSync(join(AGENTS_DIR, `${name}.md`))) {
      process.stderr.write(`그런 에이전트가 없다: ${name} (axnavi agent list)\n`);
      return 2;
    }
    return executeAgent({ root, agentName: name, prompt });
  }
  process.stderr.write(`알 수 없는 하위 명령: agent ${sub} (list | run)\n`);
  return 2;
}

/* ---------- skill ---------- */

/**
 * @param {string} root
 * @param {string[]} argv
 */
export async function cmdSkill(root, argv) {
  const sub = argv[0] ?? "list";
  if (sub === "list") {
    const skills = await loadAllSkills(SKILLS_DIR);
    const real = skills.filter((s) => !s.delegatesTo);
    const alias = skills.filter((s) => s.delegatesTo);
    process.stdout.write(`\n${ui.bold(`스킬 ${real.length}개`)}${ui.dim(` (+ 별칭 ${alias.length})`)}\n\n`);
    for (const s of real) {
      process.stdout.write(
        `  ${ui.cyan(s.name.padEnd(22))} ${ui.dim(s.agents.join(",") || "-")}\n` +
          `  ${" ".repeat(22)} ${ui.dim(s.description.slice(0, 96))}\n`,
      );
    }
    if (alias.length) {
      process.stdout.write(`\n  ${ui.dim("별칭: " + alias.map((a) => `${a.name}→${a.delegatesTo}`).join("  "))}\n`);
    }
    process.stdout.write("\n");
    return 0;
  }
  if (sub === "run") {
    const name = argv[1];
    const prompt = argv.slice(2).join(" ");
    if (!name) {
      process.stderr.write("사용법: axnavi skill run <이름> <요청>\n");
      return 2;
    }
    return runSkill(root, name, prompt);
  }
  process.stderr.write(`알 수 없는 하위 명령: skill ${sub} (list | run)\n`);
  return 2;
}

/**
 * 스킬 하나를 실행한다.
 *
 * MVP에는 서브에이전트 팬아웃이 없으므로, 스킬이 지목한 에이전트를 실행자로 삼고
 * SKILL.md 본문을 절차 지시로 앞에 붙인다. 스킬이 에이전트를 지목하지 않으면
 * 임의로 고르지 않고 사유를 밝히고 멈춘다.
 * @param {string} root
 * @param {string} name
 * @param {string} prompt
 */
export async function runSkill(root, name, prompt) {
  if (!existsSync(join(SKILLS_DIR, name, "SKILL.md"))) {
    process.stderr.write(`그런 스킬이 없다: ${name} (axnavi skill list)\n`);
    return 2;
  }
  const { skill, via } = await resolveSkill(SKILLS_DIR, name);
  if (via.length) process.stderr.write(ui.dim(`  별칭 ${via.join(" → ")} → ${skill.name}\n`));

  const agentName = skill.agents[0];
  if (!agentName) {
    process.stderr.write(
      `${ui.red("실행할 수 없다")} — 스킬 '${skill.name}'은 담당 에이전트를 지목하지 않는다.\n` +
        ui.dim("  이 스킬은 결정론적 스크립트나 다중 에이전트가 필요하다. MVP 범위 밖이다.\n"),
    );
    return 2;
  }
  if (skill.agents.length > 1) {
    process.stderr.write(
      ui.yellow(`  ! 스킬이 에이전트 ${skill.agents.length}개를 지목한다 (${skill.agents.join(", ")}).`) +
        ui.dim(` MVP는 첫 번째(${agentName})만 실행한다.\n`),
    );
  }

  const instruction =
    `다음은 스킬 '${skill.name}'의 절차다. 이 절차를 따라 사용자의 요청을 처리하라.\n` +
    `절차에 이 런타임에 없는 기능이 나오면 건너뛰고, 그 사실을 결과에 밝혀라.\n\n` +
    skill.body;

  return executeAgent({ root, agentName, prompt: prompt || "(요청 없음)", extraInstruction: instruction });
}
