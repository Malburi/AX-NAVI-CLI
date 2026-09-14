/*
 * 대화형 모드.
 *
 * 자연어가 기본이고 슬래시 명령은 명시적 경로다 — 브리프 §5의 구조 그대로다.
 * 라우팅은 아직 규칙 기반이다. 의도 분류를 LLM에 맡기면 질문 한 번마다 호출이
 * 하나 더 붙는데, MVP에서 그 비용을 정당화할 근거가 없다.
 */
import { createInterface } from "node:readline/promises";
import { indexStaleness } from "@ax-navi/indexer";
import { loadAllAgents, loadAllSkills } from "@ax-navi/core";
import { AGENTS_DIR, BANNER, REPO_ROOT, SKILLS_DIR, ui } from "./runtime.mjs";
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
 * @returns {Promise<number>}
 */
export async function startRepl(paths, state) {
  process.stdout.write(`${BANNER}\n\n`);
  process.stdout.write(`  ${ui.dim("Project")}  ${paths.root}\n`);

  if (state.hasIndex) {
    const st = indexStaleness(paths.root);
    process.stdout.write(`  ${ui.dim("Index")}    ${st.stale ? ui.yellow(st.reason) : ui.green("Ready")}\n`);
  } else {
    process.stdout.write(`  ${ui.dim("Index")}    ${ui.yellow("없음")} ${ui.dim("— /index build")}\n`);
  }
  if (state.hasPluginHarness) {
    process.stdout.write(`  ${ui.dim("Harness")}  ${ui.green("플러그인 하네스 감지됨")}\n`);
  }
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    process.stdout.write(`  ${ui.yellow("!")}        ${ui.dim("API 키 미설정 — /index 외 명령은 실패한다")}\n`);
  }
  process.stdout.write(`\n  ${ui.dim("/help 로 명령 목록, Ctrl+C 로 종료")}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code = 0;

  for (;;) {
    let line;
    try {
      line = (await rl.question(`${ui.cyan("AX-NAVI")} ${ui.dim(">")} `)).trim();
    } catch {
      break; // Ctrl+C / EOF
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    try {
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        code = await handleSlash(paths, cmd ?? "", rest);
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

  rl.close();
  return code;
}

/** @param {string} input */
function route(input) {
  for (const { agent, re } of ROUTES) {
    if (re.test(input)) return agent;
  }
  return "feature-finder";
}

/**
 * @param {import("@ax-navi/core").ProjectPaths} paths
 * @param {string} cmd
 * @param {string[]} rest
 * @returns {Promise<number>}
 */
async function handleSlash(paths, cmd, rest) {
  switch (cmd) {
    case "help":
      process.stdout.write(
        `\n  ${ui.bold("명령")}\n` +
          `    /agents                에이전트 목록\n` +
          `    /agent <이름> <요청>    에이전트 직접 실행\n` +
          `    /skills                스킬 목록\n` +
          `    /skill <이름> <요청>    스킬 실행\n` +
          `    /index [build|status]  인덱스\n` +
          `    /status                현재 상태\n` +
          `    /exit                  종료\n\n` +
          `  ${ui.dim("슬래시 없이 그냥 물으면 요청 내용으로 에이전트를 고른다.")}\n\n`,
      );
      return 0;
    case "agents": {
      const agents = await loadAllAgents(AGENTS_DIR, { pluginRoot: REPO_ROOT, projectRoot: paths.root });
      process.stdout.write("\n");
      for (const a of agents) {
        process.stdout.write(`  ${ui.cyan(a.name.padEnd(22))} ${ui.dim(a.tier)}\n`);
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
      process.stdout.write("\n");
      return 0;
    }
    case "agent": {
      const name = rest[0];
      const prompt = rest.slice(1).join(" ");
      if (!name || !prompt) {
        process.stderr.write("사용법: /agent <이름> <요청>\n");
        return 2;
      }
      return executeAgent({ root: paths.root, agentName: name, prompt });
    }
    case "skill": {
      const name = rest[0];
      if (!name) {
        process.stderr.write("사용법: /skill <이름> <요청>\n");
        return 2;
      }
      return runSkill(paths.root, name, rest.slice(1).join(" "));
    }
    case "index":
      return cmdIndex(paths.root, rest[0] ?? "status", {});
    case "status": {
      const st = indexStaleness(paths.root);
      process.stdout.write(
        `\n  ${ui.dim("Project")}  ${paths.root}\n` +
          `  ${ui.dim("Index")}    ${st.stale ? ui.yellow(st.reason) : ui.green(st.reason)}\n\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`알 수 없는 명령: /${cmd} — /help\n`);
      return 2;
  }
}
