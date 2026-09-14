/*
 * 대화형 모드.
 *
 * 자연어가 기본이고 슬래시 명령은 명시적 경로다 — 브리프 §5의 구조 그대로다.
 * 라우팅은 아직 규칙 기반이다. 의도 분류를 LLM에 맡기면 질문 한 번마다 호출이
 * 하나 더 붙는데, MVP에서 그 비용을 정당화할 근거가 없다.
 */
import { createInterface } from "node:readline/promises";
import { basename } from "node:path";
import { indexStaleness } from "@ax-navi/indexer";
import { loadAllAgents, loadAllSkills } from "@ax-navi/core";
import { AGENTS_DIR, REPO_ROOT, SKILLS_DIR, ui } from "./runtime.mjs";
import { block, readStack, renderBanner, row } from "./banner.mjs";
import { buildCommands, menuItems, renderCommandMenu } from "./completion.mjs";
import { attachAutocomplete } from "./autocomplete.mjs";
import { selectProvider } from "./provider.mjs";
import { executeAgent } from "./execute.mjs";
import { cmdIndex, runSkill } from "./commands.mjs";

/** 자연어 → 에이전트. 확실할 때만 라우팅하고, 애매하면 기본값으로 둔다. */
const ROUTES = [
  { agent: "impact-analyzer", re: /영향|impact|어디까지|파급/ },
  { agent: "logic-tracer", re: /흐름|어떻게 (돼|되나|동작)|trace|처리 과정/ },
  { agent: "sql-reviewer", re: /\bSELECT\b|\bUPDATE\b|\bINSERT\b|쿼리|SQL/i },
  { agent: "legacy-decoder", re: /무슨 코드|뭐하는|역공학|해석해/ },
  { agent: "feature-finder", re: /어디 ?있|찾아|위치|where/ },
];

/**
 * @param {import("@ax-navi/core").ProjectPaths} paths
 * @param {import("@ax-navi/core").ProjectState} state
 * @param {string} [version]
 * @returns {Promise<number>}
 */
export async function startRepl(paths, state, version = "0.1.0-alpha.0") {
  process.stdout.write(renderBanner(version));

  // 명령 목록과 자동완성에 쓰려고 시작할 때 한 번만 읽는다.
  const agentEnv = { pluginRoot: REPO_ROOT, projectRoot: paths.root };
  const [agents, skills] = await Promise.all([loadAllAgents(AGENTS_DIR, agentEnv), loadAllSkills(SKILLS_DIR)]);
  const commands = buildCommands(skills);
  const agentNames = agents.map((a) => a.name);
  const skillByName = new Map(skills.map((s) => [s.name, s]));

  process.stdout.write(block(statusLines(paths, state)));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Tab은 아래 자동완성 메뉴가 처리한다. readline 기본 completer가 끼어들면
    // 후보를 제멋대로 채워 넣으므로 빈 결과를 돌려 비활성화한다.
    completer: (/** @type {string} */ line) => /** @type {[string[], string]} */ ([[], line]),
  });

  const PROMPT = `${ui.cyan("AX-NAVI")} ${ui.dim(">")} `;

  const menu = process.stdin.isTTY
    ? attachAutocomplete({
        rl,
        input: process.stdin,
        output: process.stdout,
        source: (line) => menuItems(line, { commands, agentNames }),
        ui,
      })
    : null;

  let code = 0;

  for (;;) {
    let line;
    try {
      line = (await rl.question(PROMPT)).trim();
    } catch {
      break; // Ctrl+C / EOF
    }
    menu?.close();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    try {
      if (line.startsWith("/")) {
        code = await handleSlash({ paths, line, commands, skillByName });
      } else {
        const agent = route(line);
        process.stderr.write(ui.dim(`  라우팅 → ${agent}\n`));
        code = await executeAgent({ root: paths.root, agentName: agent, prompt: line });
      }
    } catch (error) {
      process.stderr.write(`${ui.red("실패")}: ${/** @type {Error} */ (error).message}\n`);
      code = 1;
    }
  }

  menu?.dispose();
  rl.close();
  return code;
}

/**
 * @param {import("@ax-navi/core").ProjectPaths} paths
 * @param {import("@ax-navi/core").ProjectState} state
 * @returns {string[]}
 */
function statusLines(paths, state) {
  /** @type {string[]} */
  const lines = [];
  lines.push(row("Project", `${ui.bold(basename(paths.root))}  ${ui.dim(paths.root)}`));

  const stack = state.hasIndex ? readStack(paths.indexDir) : null;
  if (stack) {
    lines.push(row("Stack", `${stack.stack}  ${ui.dim(`· ${stack.files} files · tier ${stack.tier}`)}`));
  }

  if (state.hasIndex) {
    const st = indexStaleness(paths.root);
    lines.push(
      row("Index", st.stale ? `${ui.yellow("갱신 필요")}  ${ui.dim(st.reason)}` : `${ui.green("Ready")}  ${ui.dim(st.reason)}`),
    );
  } else {
    lines.push(row("Index", `${ui.yellow("없음")}  ${ui.dim("— /index build 로 만드세요 (LLM·API 키 불필요)")}`));
  }

  /*
   * 실행 경로를 실제로 확인해서 보여 준다.
   * 예전에는 여기서 ANTHROPIC_API_KEY만 보고 "키 미설정 — /index 외 명령은 실패한다"고
   * 썼는데, claude 구독으로 도는 경우에는 그게 거짓말이다.
   */
  const picked = selectProvider({ cwd: paths.root });
  if ("error" in picked) {
    lines.push(row("Runtime", `${ui.red("없음")}  ${ui.dim("— 아래 안내 참고")}`));
  } else {
    const [head, ...tail] = picked.short.split(" · ");
    lines.push(row("Runtime", `${ui.green(head ?? "")}  ${ui.dim(tail.join(" · "))}`));
  }

  if (state.hasPluginHarness) {
    lines.push(row("Harness", `${ui.green("플러그인 하네스 감지됨")}  ${ui.dim("· CLAUDE.md + .claude/")}`));
  }

  lines.push("");
  if ("error" in picked) {
    lines.push(picked.error);
    lines.push("");
  }
  lines.push(
    `  ${ui.dim("자연어로 물어보세요.")}   ${ui.cyan("/")} ${ui.dim("명령 목록")}   ${ui.dim("Tab 자동완성")}   ${ui.cyan("/exit")} ${ui.dim("종료")}`,
  );
  lines.push("");
  return lines;
}

/** @param {string} input */
function route(input) {
  for (const { agent, re } of ROUTES) {
    if (re.test(input)) return agent;
  }
  return "feature-finder";
}

/**
 * @param {object} args
 * @param {import("@ax-navi/core").ProjectPaths} args.paths
 * @param {string} args.line
 * @param {import("./completion.mjs").SlashCommand[]} args.commands
 * @param {Map<string, { name: string }>} args.skillByName
 * @returns {Promise<number>}
 */
async function handleSlash({ paths, line, commands, skillByName }) {
  const spaceAt = line.indexOf(" ");
  const cmd = spaceAt === -1 ? line.slice(1) : line.slice(1, spaceAt);
  const argText = spaceAt === -1 ? "" : line.slice(spaceAt + 1).trim();
  const rest = argText ? argText.split(/\s+/) : [];

  switch (cmd) {
    // `/` 만 치고 엔터 — 목록을 보여 준다. "알 수 없는 명령"으로 내쫓지 않는다.
    case "":
    case "help":
      process.stdout.write(renderCommandMenu(commands, ui));
      return 0;

    case "agents": {
      const agents = await loadAllAgents(AGENTS_DIR, { pluginRoot: REPO_ROOT, projectRoot: paths.root });
      process.stdout.write("\n");
      for (const a of agents) {
        const tools = a.role.allowedTools ? a.role.allowedTools.filter((t) => t !== "TaskUpdate").join(",") : "(전체)";
        process.stdout.write(`  ${ui.cyan(a.name.padEnd(22))} ${ui.dim(a.tier.padEnd(9))} ${ui.dim(tools)}\n`);
      }
      process.stdout.write("\n");
      return 0;
    }

    case "skills": {
      const skills = await loadAllSkills(SKILLS_DIR);
      process.stdout.write("\n");
      for (const s of skills.filter((x) => !x.delegatesTo)) {
        process.stdout.write(`  ${ui.cyan(s.name.padEnd(22))} ${ui.dim(s.agents.join(",") || "-")}\n`);
      }
      const alias = skills.filter((s) => s.delegatesTo);
      if (alias.length) {
        process.stdout.write(`\n  ${ui.dim(`별칭: ${alias.map((a) => `/${a.name}→${a.delegatesTo}`).join("  ")}`)}\n`);
      }
      process.stdout.write("\n");
      return 0;
    }

    case "agent": {
      const name = rest[0];
      const prompt = rest.slice(1).join(" ");
      if (!name || !prompt) {
        process.stderr.write(`사용법: /agent <이름> <요청>   ${ui.dim("(Tab 으로 이름 자동완성)")}\n`);
        return 2;
      }
      return executeAgent({ root: paths.root, agentName: name, prompt });
    }

    case "index":
      return cmdIndex(paths.root, rest[0] ?? "status", {});

    case "status": {
      const st = indexStaleness(paths.root);
      process.stdout.write(
        `\n  ${ui.dim("Project")}  ${paths.root}\n  ${ui.dim("Index")}    ${st.stale ? ui.yellow(st.reason) : ui.green(st.reason)}\n\n`,
      );
      return 0;
    }

    default: {
      // 스킬 이름이면 그대로 실행한다 — 원래 플러그인의 /modify·/impact 와 같은 감각.
      if (skillByName.has(cmd)) return runSkill(paths.root, cmd, argText);

      const near = commands
        .map((c) => c.name)
        .filter((n) => n.startsWith(cmd.slice(0, 3)))
        .slice(0, 5);
      process.stderr.write(
        `알 수 없는 명령: ${ui.cyan(`/${cmd}`)}\n` +
          (near.length ? `  ${ui.dim(`혹시: ${near.map((n) => `/${n}`).join("  ")}`)}\n` : "") +
          `  ${ui.dim("/ 를 치면 전체 목록이 나온다.")}\n`,
      );
      return 2;
    }
  }
}
