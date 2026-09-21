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
import { pythonInfo } from "../../../agents/lib/python-bin.mjs";
import {
  buildIndex,
  indexStaleness,
  INDEXER_VERSION,
  resolveIndexDir,
} from "../../indexer/index.mjs";
import {
  inspectProject,
  loadAllAgents,
  loadAllSkills,
  resolveSkill,
  resolveProjectPaths,
} from "../../core/src/index.mjs";
import { AGENTS_DIR, REPO_ROOT, SKILLS_DIR, ui } from "./runtime.mjs";
import { selectProvider } from "./provider.mjs";
import { executeAgent } from "./execute.mjs";
import { firstSentence } from "./completion.mjs";
import { renderSkillHeader } from "./transcript.mjs";
import { compareVersions, readVersion, resolveLatestTag, runUpgrade } from "./upgrade.mjs";

const NEWLINE = String.fromCharCode(10);


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

  /*
   * 인증은 둘 중 하나만 있으면 된다. "API 키가 없다"만 보여 주면
   * 구독으로 돌릴 수 있다는 사실을 놓치게 된다.
   */
  const picked = selectProvider({ cwd: paths.root });
  rows.push(["error" in picked ? false : true, "실행 경로", "error" in picked ? "없음 — 아래 안내 참조" : picked.note]);

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
  // 실행 경로가 없으면 무엇을 하면 되는지까지 알려 준다.
  if ("error" in picked) process.stdout.write(`${picked.error}\n\n`);
  return rows.some(([ok]) => ok === false) ? 1 : 0;
}

/*
 * 파이썬 탐지는 agents/lib/python-bin.mjs 한 곳에만 둔다.
 *
 * 여기에 같은 로직을 한 벌 더 갖고 있었고, 그 사본에는 Store 별칭 방어가 빠져 있었다.
 * 그래서 `axnavi doctor`가 회사 PC에서 출력 한 줄 없이 죽었다(AssignProcessToJobObject).
 * 두 벌을 두면 한쪽만 고쳐진다 — 그 일이 실제로 일어났다.
 */
const probePython = pythonInfo;

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
 * @param {import("./provider.mjs").ProviderName} [providerName]
 */
export async function cmdAgent(root, argv, providerName) {
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
    return executeAgent({ root, agentName: name, prompt, ...(providerName ? { providerName } : {}) });
  }
  process.stderr.write(`알 수 없는 하위 명령: agent ${sub} (list | run)\n`);
  return 2;
}

/* ---------- skill ---------- */

/**
 * @param {string} root
 * @param {string[]} argv
 * @param {import("./provider.mjs").ProviderName} [providerName]
 */
export async function cmdSkill(root, argv, providerName) {
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
    return runSkill(root, name, prompt, providerName);
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
 * @param {import("./provider.mjs").ProviderName} [providerName]
 * @param {{ conversation?: import("@ax-navi/core").Conversation, onAnswer?: (text: string) => void }} [ctx]
 *   대화를 이어갈 자리. 주면 이 스킬 실행도 같은 대화에 얹힌다.
 */
export async function runSkill(root, name, prompt, providerName, ctx = {}) {
  if (!existsSync(join(SKILLS_DIR, name, "SKILL.md"))) {
    process.stderr.write(`그런 스킬이 없다: ${name} (axnavi skill list)\n`);
    return 2;
  }
  const { skill, via } = await resolveSkill(SKILLS_DIR, name);

  /*
   * 스킬이 돌기 시작했다는 것을 먼저 밝힌다.
   *
   * 자연어로 부르든 /find 로 부르든 같은 자리에서 같은 모양으로 나와야 한다 —
   * 예전에는 슬래시 경로에 아무 표시가 없어 무엇이 돌고 있는지 알 수 없었다.
   */
  process.stderr.write(
    renderSkillHeader({
      name: skill.name,
      description: firstSentence(skill.description, 120),
      via,
      width: process.stdout.columns ?? 100,
      ui,
    }).join(NEWLINE) + NEWLINE,
  );

  /*
   * 오케스트레이터 스킬은 실행자에게 넘기지 않는다.
   *
   * harness-init 같은 절차는 **스킬 본문 자체가 지휘자의 지침**이다. 이걸 pipeline-runner
   * 같은 개별 에이전트에게 넘기면 자기가 뭘 해야 하는지 모른다(실측으로 확인).
   * 그래서 지휘자 역할을 따로 만들어 본문을 그대로 시스템 프롬프트로 준다.
   *
   * 대신 서브에이전트를 띄울 수 있어야 한다 — 그게 절차의 본체이기 때문이다.
   * 그건 ownsAgentLoop Provider(claude CLI 위임)에서만 가능하다.
   */
  if (skill.isOrchestrator) {
    return runOrchestratorSkill(root, skill, prompt, providerName, ctx);
  }

  const agentName = skill.agents[0];
  if (!agentName) {
    /*
     * 세 번째 부류 — **에이전트도 위임도 없는 절차.**
     *
     * 로더는 두 가지만 구분했다. 에이전트를 지목한 스킬과 여럿을 지휘하는 스킬.
     * 그런데 generate-wiki·publish-wiki·harness-clean 은 둘 다 아니다. 스크립트를
     * 순서대로 돌리고 파일을 만들거나 지우는 절차이고, 본문 자체가 그 지침이다.
     * 전수 점검으로 확인했다 — 24종 중 6종이 여기서 "실행할 수 없다" 로 끝났다.
     *
     * 지휘자 경로와 같은 모양으로 돌리되 위임은 열지 않는다. 띄울 서브에이전트가
     * 없는 절차에 위임 도구를 쥐여 주면 부르려다 한 턴을 날린다.
     */
    const special = SPECIAL_SKILLS[skill.name];
    if (special) {
      process.stderr.write(special.text());
      return special.code;
    }
    return runProcedureSkill(root, skill, prompt, providerName, ctx);
  }

  if (!prompt) {
    // 요청 없이 스킬만 부르면 무엇을 해야 할지 알 수 없다. 지어내지 않고 사용법을 알린다.
    process.stderr.write(
      `${ui.yellow("요청이 비어 있다")} — /${name} 뒤에 무엇을 찾을지 쓰세요.\n` +
        ui.dim(`  예: /${name} 결제 승인 처리\n`),
    );
    return 2;
  }

  /*
   * 프롬프트 조립 순서가 결과를 좌우한다.
   *
   * 처음에는 SKILL.md 본문을 앞에 두고 사용자 요청을 뒤에 붙였는데, 그러면 모델이
   * 66줄짜리 절차 문서를 주된 내용으로 읽고 "이 스킬이 무엇인지" 설명해 버린다
   * (실측: `/find 이 시스템 뭐야` → 검색 대신 find-feature 스킬 소개).
   *
   * 게다가 SKILL.md는 *오케스트레이터용* 문서다 — `Agent(subagent_type=...)`로
   * 실행자를 부르는 절차가 적혀 있다. 그 실행자 본인에게 통째로 주면 자기를
   * 호출하라는 지시를 읽고 혼란에 빠진다.
   *
   * 그래서 사용자 요청을 맨 앞에 두고, 스킬 본문은 "산출물 규약 참고"로 격하한다.
   */
  const instruction = [
    `# 요청`,
    prompt,
    ``,
    `프로젝트 루트: ${resolveProjectPaths(root).root}`,
    ``,
    `---`,
    ``,
    `위 요청은 '${skill.name}' 스킬 경로로 들어왔다. 너는 그 스킬이 호출하는 실행자(${agentName})다.`,
    `아래는 그 스킬의 오케스트레이션 절차이며 **참고 자료**다.`,
    ``,
    `- 절차 자체를 설명하지 마라. 요청을 수행하라.`,
    `- 절차 중 네 역할에 해당하는 부분만 하고, 산출물 경로·형식 규약은 지켜라.`,
    `- 이 런타임에 없는 기능(서브에이전트 호출 등)은 네가 직접 수행하고, 그 사실만 짧게 밝혀라.`,
    ``,
    `<스킬 절차: ${skill.name}>`,
    skill.body,
    `</스킬 절차>`,
  ].join("\n");

  return executeAgent({
    root,
    agentName,
    prompt: instruction,
    /*
     * 스킬 실행도 **같은 대화에 얹는다.**
     *
     * 예전에는 한 번 쓰고 버리는 실행이었다. 그래서 /find 로 한참 조사한 뒤
     * "계속 해줘" 라고 하면 앞의 일이 대화에 없어서 무엇을 이어갈지 모른다고 답했다(실측).
     * 사용자에게는 한 흐름인데 우리만 둘로 갈라 놓고 있었다.
     */
    ...(ctx.conversation ? { conversation: ctx.conversation } : {}),
    ...(ctx.onAnswer ? { onAnswer: ctx.onAnswer } : {}),
    title: `/${skill.name} ${prompt}`.trim(),
    ...(providerName ? { providerName } : {}),
  });
}

/**
 * 오케스트레이터 스킬 실행.
 *
 * 스킬 본문을 지휘자의 시스템 프롬프트로 주고, 서브에이전트 호출을 허용한다.
 * 스킬 본문에는 이미 비-플러그인 호스트용 폴백이 문서화돼 있다 —
 * `general-purpose`로 폴백하며 "agents/<이름>.md의 지침을 읽고 그대로 따른다"를
 * 명시하라거나(harness-init/SKILL.md:239), TaskCreate가 없으면
 * `_workspace/00_pipeline_status.md` 체크리스트를 쓰라는 식이다.
 * 그 폴백을 타라고 지시해 주면 절차가 그대로 성립한다.
 *
 * @param {string} root
 * @param {import("@ax-navi/core").SkillDefinition} skill
 * @param {string} prompt
 * @param {import("./provider.mjs").ProviderName} [providerName]
 * @param {{ conversation?: import("@ax-navi/core").Conversation, onAnswer?: (text: string) => void }} [ctx]
 * @returns {Promise<number>}
 */
async function runOrchestratorSkill(root, skill, prompt, providerName, ctx = {}) {
  const picked = selectProvider({ ...(providerName ? { provider: providerName } : {}), cwd: root });
  if ("error" in picked) {
    process.stderr.write(`${picked.error}\n`);
    return 1;
  }
  if (!picked.provider.capabilities.ownsAgentLoop) {
    // 있는 척하지 않는다. 왜 안 되는지와 무엇을 하면 되는지를 같이 말한다.
    process.stderr.write(
      `${ui.red(`'${skill.name}'은 아직 이 실행 경로에서 돌릴 수 없다`)}\n` +
        ui.dim(`  이 스킬은 에이전트 ${skill.agents.length}종(${skill.agents.join(", ")})을 순서대로 지휘한다.\n`) +
        ui.dim("  서브에이전트 호출이 필요한데 anthropic Provider 경로에는 아직 그 기능이 없다.\n") +
        ui.dim("  대안: --provider claude-cli (구독 인증, claude CLI의 서브에이전트를 빌려 쓴다)\n"),
    );
    return 2;
  }



  const instruction = [
    `# 실행 지시`,
    ``,
    `아래 절차(${skill.name})를 **지금 이 프로젝트에 실제로 수행**하라. 절차를 설명하지 마라.`,
    `프로젝트 루트: ${resolveProjectPaths(root).root}`,
    prompt ? `사용자가 덧붙인 조건: ${prompt}` : `사용자가 덧붙인 조건: 없음`,
    ``,
    `## 이 런타임에서 위임하는 법`,
    ``,
    `- 절차에 적힌 \`ax-navi:<에이전트>\` 이름을 **그대로** 쓴다. 19종이 그대로 올라가 있다.`,
    `  → \`Task\`의 \`subagent_type\`에 \`ax-navi:analyzer\` 처럼 넣어라.`,
    `  → 절차 본문에 "플러그인이 없으면 general-purpose로 폴백하라"는 대목이 있어도 **따르지 마라.**`,
    `    그 폴백은 여기서 필요 없고, 쓰면 역할 지침 없이 도는 에이전트가 생긴다.`,
    `- 서브에이전트는 백그라운드로 뜨고 여러 개가 동시에 돈다.`,
    `  → 앞 단계의 산출물이 있어야 도는 단계는 **결과를 받고 나서** 다음으로 가라.`,
    `  → 서로 의존하지 않는 단계는 함께 띄워도 된다. 그게 이 경로의 이점이다.`,
    `- \`TaskCreate\`/\`TaskUpdate\`가 없다.`,
    `  → 절차에 적힌 대로 \`_workspace/00_pipeline_status.md\` 체크리스트로 진행 상황을 관리하라.`,
    `- 사용자에게 물어야 하면 \`mcp__axnavi__AskUserQuestion\` 도구를 써라.`,
    `  → 되물을 수 없다고 단정하고 기본값으로 넘어가지 마라. 그 도구가 실제 사용자에게 닿는다.`,
    `  → 다만 답이 비어 오면(무응답) 그때는 기본값으로 진행하고 무엇을 가정했는지 밝혀라.`,
    `- AX-NAVI 인덱스 질의는 \`mcp__axnavi__QueryIndex\` 도구를 쓸 수 있다.`,
    `- 스크립트 경로는 이미 절대경로로 치환돼 있다. 그대로 \`Bash\`로 실행하라.`,
    ``,
    `## 절차: ${skill.name}`,
    ``,
    skill.body,
  ].join("\n");

  /*
   * 지휘자 역할.
   *
   * frontmatter가 없는 자리라 도구를 직접 정한다. 하네스 파일을 만들어야 하므로
   * 쓰기가 필요하고, 서브에이전트도 띄워야 한다. 대신 이 사실을 화면에 밝힌다.
   */
  return executeAgent({
    root,
    prompt: instruction,
    agent: {
      name: `${skill.name}`,
      description: skill.description,
      // 절차는 프롬프트로 준다. 시스템 프롬프트는 역할 선언만 짧게.
      systemPrompt:
        "너는 AX-NAVI의 오케스트레이터다. 주어진 절차를 이 프로젝트에 실제로 수행한다.\n" +
        "사용자는 AX-NAVI CLI에서 너를 부르고 있다 — 쓰고 있지 않은 도구를 네 실행 환경이라고 말하지 마라.",
      tier: "standard",
      sourcePath: skill.sourcePath,
      warnings: [],
      allowDelegation: true,
      // 하네스 파일을 만들어야 하므로 쓰기가 필요하다. 이 사실은 화면에 드러난다.
      role: { name: skill.name, allowedTools: null, allowMutations: true },
    },
    // 오케스트레이터도 같은 대화에 얹는다. 중단하고 "계속 해줘" 가 통해야 한다.
    ...(ctx.conversation ? { conversation: ctx.conversation } : {}),
    ...(ctx.onAnswer ? { onAnswer: ctx.onAnswer } : {}),
    title: `/${skill.name} ${prompt}`.trim(),
    ...(providerName ? { providerName } : {}),
  });
}

/* ---------- upgrade ---------- */

/**
 * 새 판으로 올린다.
 *
 * 플러그인은 마켓플레이스가 갱신해 줬지만 npm 전역 설치는 그런 것이 없다.
 * 알려 주지 않으면 몇 달 전 판을 계속 쓰면서 이미 고친 버그를 다시 겪는다.
 *
 * 인자로 태그를 주면 그것으로, 안 주면 최신으로 간다.
 *
 * @param {string} [tag]
 * @returns {Promise<number>}
 */
export async function cmdUpgrade(tag) {
  const say = (/** @type {string} */ line) => process.stdout.write(`  ${line}${NEWLINE}`);
  const current = readVersion();

  if (tag) return runUpgrade(tag.startsWith("v") ? tag : `v${tag}`, say);

  const latest = await resolveLatestTag();
  if (!latest) {
    /*
     * 못 물어봤다고 멈추지 않는다. 폐쇄망에서는 확인 자체가 안 되는 것이 정상이고,
     * 그때도 손으로 올릴 길은 알려 줘야 한다.
     */
    process.stderr.write(
      `  ${ui.yellow("최신 판을 확인하지 못했다")} ${ui.dim("— 망이 막혀 있을 수 있다.")}${NEWLINE}` +
        `  ${ui.dim(`태그를 직접 지정할 수 있다:  axnavi upgrade v0.1.0-alpha.5`)}${NEWLINE}`,
    );
    return 1;
  }
  if (compareVersions(latest, current) <= 0) {
    say(`${ui.green("이미 최신")} ${ui.dim(`— ${current}`)}`);
    return 0;
  }
  say(`${ui.cyan(current)} ${ui.dim("→")} ${ui.cyan(latest)}`);
  return runUpgrade(latest, say);
}

/* ---------- 특수 취급 스킬 ---------- */

/*
 * 절차로 돌리면 안 되는 두 가지.
 *
 * 전수 점검에서 "실행 경로 없음" 으로 함께 잡혔지만 원인이 다르다. 하나는 이미
 * 다른 모양으로 구현돼 있고, 하나는 이 배포본에 없는 것을 요구한다. 둘 다 절차
 * 실행기에 넘기면 모델이 없는 것을 있다고 지어내거나 엉뚱한 파일을 만든다.
 */
/** @type {Record<string, { text: () => string, code: number }>} */
const SPECIAL_SKILLS = {
  /*
   * vibe 는 절차가 아니라 실행 정책이다(Phase 없이 규칙 6개 + 승격 조건 5개).
   * CLI 에서는 실행 모드로 옮겨 놓았으므로 그쪽을 알린다.
   */
  vibe: {
    code: 0,
    text: () =>
    `${ui.yellow("vibe 는 스킬이 아니라 실행 모드다")}${NEWLINE}` +
    ui.dim(`  이 CLI 에서는 모드로 옮겼다 — 도구가 아니라 절차에 관한 것이라서다.${NEWLINE}`) +
    ui.dim(`  대화형에서  /mode 빠름   (또는 빈 줄에서 Shift+Tab)${NEWLINE}`) +
    ui.dim(`  영향도·안전 게이트를 건너뛰되 스키마·API 계약·트랜잭션 경계 변경과${NEWLINE}`) +
      ui.dim(`  3개 이상 파일 수정은 그대로 멈춘다.${NEWLINE}`),
  },

  /*
   * wiki-hub 는 별도 프로젝트의 wiki-hub-serve 바이너리를 띄운다. 이 배포본에
   * 들어 있지 않고 받을 곳도 정해져 있지 않다. 없는 것을 있다고 말하지 않는다.
   */
  "wiki-hub": {
    code: 2,
    text: () =>
    `${ui.yellow("wiki-hub 는 이 배포본에서 돌지 않는다")}${NEWLINE}` +
    ui.dim(`  별도 프로젝트의 wiki-hub-serve 실행 파일이 필요한데 함께 배포되지 않는다.${NEWLINE}`) +
      ui.dim(`  지금 쓸 수 있는 것:  axnavi skill run generate-wiki   (폴더 wiki 생성)${NEWLINE}`),
  },
};

/**
 * 절차 스킬 실행 — 에이전트도 위임도 없는 부류.
 *
 * 지휘자 경로와 같은 모양이되 **위임을 열지 않는다.** 띄울 서브에이전트가 없는
 * 절차에 위임 도구를 쥐여 주면 부르려다 한 턴을 날린다(실측으로 그런 적이 있다).
 *
 * @param {string} root
 * @param {import("@ax-navi/core").SkillDefinition} skill
 * @param {string} prompt
 * @param {import("./provider.mjs").ProviderName} [providerName]
 * @param {{ conversation?: import("@ax-navi/core").Conversation, onAnswer?: (text: string) => void }} [ctx]
 * @returns {Promise<number>}
 */
async function runProcedureSkill(root, skill, prompt, providerName, ctx = {}) {
  const paths = resolveProjectPaths(root);
  const instruction = [
    `# 실행 지시`,
    ``,
    `아래 절차(${skill.name})를 **지금 이 프로젝트에 실제로 수행**하라. 절차를 설명하지 마라.`,
    `프로젝트 루트: ${paths.root}`,
    prompt ? `사용자가 덧붙인 조건: ${prompt}` : `사용자가 덧붙인 조건: 없음`,
    ``,
    `## 이 런타임에서의 실행 방법`,
    ``,
    `- 이 절차는 대부분 결정론적 스크립트 실행이다. 스크립트 경로는 이미 절대경로로`,
    `  치환돼 있으니 그대로 \`Bash\`로 실행하라.`,
    `- 파이썬은 \`python3\`을 먼저 시도하고 실패하면 \`python\`을 쓴다. 이름을 단정하지 마라.`,
    `- 서브에이전트는 띄울 수 없다. 절차에 위임이 적혀 있으면 네가 직접 그 일을 하라.`,
    `- 사용자에게 물어야 하면 \`mcp__axnavi__AskUserQuestion\` 도구를 써라.`,
    `- 스크립트가 실패하면 **성공으로 보고하지 마라.** 어느 명령이 어떤 오류로 실패했는지 그대로 알려라.`,
    ``,
    `## 절차: ${skill.name}`,
    ``,
    skill.body,
  ].join(NEWLINE);

  return executeAgent({
    root,
    prompt: instruction,
    agent: {
      name: skill.name,
      description: skill.description,
      systemPrompt:
        "너는 AX-NAVI의 절차 실행자다. 주어진 절차를 이 프로젝트에 실제로 수행한다.\n" +
        "사용자는 AX-NAVI CLI에서 너를 부르고 있다 — 쓰고 있지 않은 도구를 네 실행 환경이라고 말하지 마라.",
      tier: "standard",
      sourcePath: skill.sourcePath,
      warnings: [],
      // 파일을 만들거나 지우는 절차다. 이 사실은 화면에 드러난다.
      role: { name: skill.name, allowedTools: null, allowMutations: true },
    },
    ...(ctx.conversation ? { conversation: ctx.conversation } : {}),
    ...(ctx.onAnswer ? { onAnswer: ctx.onAnswer } : {}),
    title: `/${skill.name} ${prompt}`.trim(),
    ...(providerName ? { providerName } : {}),
  });
}
