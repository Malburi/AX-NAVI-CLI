/*
 * 대화형 모드.
 *
 * 자연어가 기본이고 슬래시 명령은 명시적 경로다 — 브리프 §5의 구조 그대로다.
 * 라우팅은 아직 규칙 기반이다. 의도 분류를 LLM에 맡기면 질문 한 번마다 호출이
 * 하나 더 붙는데, MVP에서 그 비용을 정당화할 근거가 없다.
 */
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { indexStaleness } from "@ax-navi/indexer";
import {
  latestSession,
  listSessions,
  loadAllAgents,
  loadAllSkills,
  loadSession,
  newSessionId,
  saveSession,
  toTitle,
} from "@ax-navi/core";
import { AGENTS_DIR, REPO_ROOT, SKILLS_DIR, ui } from "./runtime.mjs";
import { block, readStack, renderBanner, row } from "./banner.mjs";
import { buildCommands, menuItems, renderCommandMenu } from "./completion.mjs";
import { attachAutocomplete } from "./autocomplete.mjs";
import { selectProvider } from "./provider.mjs";
import { executeAgent } from "./execute.mjs";
import { cmdIndex, runSkill } from "./commands.mjs";
import { renderStatus } from "./status.mjs";
import { estimateTokens } from "@ax-navi/core";
import { createNaviPersona } from "./persona.mjs";

/*
 * 자연어 → 전문 역할.
 *
 * 매칭되지 않으면 AX-NAVI 본인이 받는다. 예전에는 기본값이 feature-finder 였는데
 * 그러면 "넌 뭐야?" 같은 일반 질문까지 코드 검색 전문가가 받아서 자기를
 * "AX-NAVI의 feature-finder 에이전트"라고 소개했다(실측). 사용자가 부른 것은
 * AX-NAVI지 그 안의 역할이 아니다.
 *
 * 그래서 규칙을 **확실할 때만 걸리도록** 좁게 쓴다. 애매하면 넘기지 않는다.
 */
const ROUTES = [
  { agent: "impact-analyzer", re: /영향도|영향 ?범위|어디까지 영향|파급/ },
  { agent: "logic-tracer", re: /처리 ?흐름|흐름 ?추적|어떻게 (돌아가|처리되|동작하)/ },
  { agent: "sql-reviewer", re: /\bSELECT\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|쿼리 ?(리뷰|점검)|SQL ?(리뷰|점검)/i },
  { agent: "legacy-decoder", re: /역공학|레거시 ?해석|이 ?프로시저 ?(뭐|무슨)/ },
  { agent: "feature-finder", re: /어디 ?(있|에 ?있)|위치 ?(찾|알려)|관련 ?코드 ?찾/ },
];

/** 라우팅에 안 걸리면 AX-NAVI 본인이 받는다. */
const DEFAULT_AGENT = "axnavi";

/**
 * @param {import("@ax-navi/core").ProjectPaths} paths
 * @param {import("@ax-navi/core").ProjectState} state
 * @param {string} [version]
 * @param {{ continueLatest?: boolean, resumeId?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function startRepl(paths, state, version = "0.1.0-alpha.0", opts = {}) {
  process.stdout.write(renderBanner(version));

  // 명령 목록과 자동완성에 쓰려고 시작할 때 한 번만 읽는다.
  const agentEnv = { pluginRoot: REPO_ROOT, projectRoot: paths.root };
  const [agents, skills] = await Promise.all([loadAllAgents(AGENTS_DIR, agentEnv), loadAllSkills(SKILLS_DIR)]);
  const commands = buildCommands(skills);
  const agentNames = agents.map((a) => a.name);
  const skillByName = new Map(skills.map((s) => [s.name, s]));
  // AX-NAVI 본인. 라우팅에 안 걸리는 모든 입력을 받는다.
  const navi = createNaviPersona({ agents, skills });

  const providerInfo = selectProvider({ cwd: paths.root });
  process.stdout.write(block(statusLines(paths, state, providerInfo)));

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

  /*
   * 입력을 직접 큐로 받는다.
   *
   * rl.question() 하나로 돌리면 **처리 중에 들어온 줄이 버려진다** — 대기 중인 질문이
   * 없을 때 오는 line 이벤트를 아무도 받지 않기 때문이다. 사람이 프롬프트를 기다렸다
   * 치는 동안엔 안 드러나지만, 여러 줄을 붙여넣거나 파이프로 먹이면 첫 줄만 실행되고
   * 나머지가 사라진다(실측). 큐에 쌓아 두면 순서대로 다 처리된다.
   */
  /** @type {string[]} */
  const queued = [];
  /** @type {((line: string | null) => void) | null} */
  let waiter = null;
  let closed = false;

  rl.on("line", (raw) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(raw);
    } else {
      queued.push(raw);
    }
  });
  rl.on("close", () => {
    closed = true;
    waiter?.(null);
    waiter = null;
  });

  /** 이 대화에 쓴 누적 비용. */
  let sessionCost = 0;
  /** 마지막 턴이 실제로 실어 보낸 컨텍스트 크기. 위임 경로는 우리가 turns 를 안 들고 있다. */
  let lastContextTokens = 0;


  /** @returns {Promise<string | null>} null이면 입력 끝. */
  const nextLine = () => {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => { waiter = resolve; });
  };

  /*
   * 대화 상태.
   *
   * 이게 없으면 매 입력이 새 대화라 "그거 수정하면 어디 영향가?" 에서 "그거"를 잃는다.
   * 에이전트가 바뀌면(라우팅이 다른 역할을 고르면) 대화를 새로 시작한다 —
   * 다른 역할의 대화를 이어 붙이면 지침이 섞인다.
   *
   * 턴 수는 따로 센다 — 위임 경로에서는 대화를 그쪽이 들고 있어
   * conversation.turns 가 비어 있기 때문이다.
   */
  /** @type {{ id: string, agent: string, turns: number, title?: string, createdAt?: string, conversation: import("@ax-navi/core").Conversation } | null} */
  let thread = null;

  /*
   * 이어서 시작하기.
   *
   * --continue 는 마지막 세션, --resume <id> 는 지정한 세션을 연다.
   * 없으면 조용히 새 대화로 시작한다 — 이어갈 게 없다고 실행을 막을 이유는 없다.
   */
  if (opts.resumeId || opts.continueLatest) {
    const record = opts.resumeId
      ? await loadSession(paths, opts.resumeId)
      : await latestSession(paths);
    if (record) {
      thread = {
        id: record.id,
        agent: record.agent,
        turns: record.turns,
        title: record.title,
        createdAt: record.createdAt,
        conversation: record.conversation,
      };
      process.stdout.write(
        `  ${ui.green("이어서 시작")}  ${ui.dim(`${record.agent} · ${record.turns}턴 · ${record.title}`)}\n\n`,
      );
    } else {
      process.stdout.write(`  ${ui.yellow("이어갈 세션이 없다")} ${ui.dim("— 새 대화로 시작한다.")}\n\n`);
    }
  }

  /** @param {string} agentName @param {string} firstLine */
  const threadFor = (agentName, firstLine) => {
    if (!thread || thread.agent !== agentName) {
      thread = {
        id: newSessionId(),
        agent: agentName,
        turns: 0,
        conversation: { turns: [] },
        title: toTitle(firstLine),
        createdAt: new Date().toISOString(),
      };
    }
    thread.turns += 1;
    return thread;
  };

  /** 한 턴이 끝날 때마다 저장한다 — 마지막에 한 번 저장하면 죽는 순간 전부 잃는다. */
  const persist = async () => {
    if (!thread) return;
    try {
      await saveSession(paths, {
        id: thread.id,
        root: paths.root,
        agent: thread.agent,
        turns: thread.turns,
        createdAt: thread.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: thread.title ?? "",
        conversation: thread.conversation,
      });
    } catch {
      // 세션 저장 실패가 대화를 끊을 이유는 아니다.
    }
  };

  let code = 0;

  for (;;) {
    // 큐에 이미 쌓여 있으면 프롬프트를 다시 그리지 않는다 — 붙여넣기가 어지러워진다.
    if (!queued.length) process.stdout.write(PROMPT);
    const raw = await nextLine();
    if (raw === null) break; // Ctrl+C / EOF
    const line = raw.trim();
    menu?.close();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    try {
      if (line.startsWith("/")) {
        code = await handleSlash({
          paths, line, commands, skillByName,
          onReset: () => { thread = null; },
          onContext: () => (thread
            ? {
                id: thread.id,
                agent: thread.agent,
                turns: thread.turns,
                sessionId: thread.conversation.providerSessionId,
              }
            : null),
        });
      } else {
        const agent = route(line);
        const t = threadFor(agent, line);
        process.stdout.write(ui.dim(`  ⋯ ${agent}${t.turns > 1 ? ` · ${t.turns}번째 턴` : ""}
`));
        code = await executeAgent({
          root: paths.root,
          // AX-NAVI 본인이면 내장 인격을, 전문 역할이면 agents/<이름>.md 를 쓴다.
          ...(agent === DEFAULT_AGENT ? { agent: navi } : { agentName: agent }),
          prompt: line,
          conversation: t.conversation,
          onCost: (usd) => { sessionCost += usd; },
          onContextSize: (n) => { lastContextTokens = n; },
          queuedCount: () => queued.length,
        });
        await persist();
        /*
         * 턴이 끝나면 상태를 한 줄 남긴다.
         *
         * 프롬프트에 붙박이로 달지 않는 이유는 Enter 가 커서를 한 줄 내려 우리 계산과
         * 어긋나기 때문이다(실측: 출력마다 상태줄이 쌓였다). 기록으로 흘려보내면
         * 그 다툼이 없고, 되돌아봐도 그 시점의 상태가 남아 있다.
         */
        process.stdout.write(
          `${renderStatus({
            root: paths.root,
            runtime: "error" in providerInfo ? "런타임 없음" : providerInfo.short.split(" · ")[0] ?? "",
            // 직접 경로는 우리가 turns 를 들고 있고, 위임 경로는 실제 사용량이 유일한 근거다.
            contextTokens: Math.max(estimateTokens(t.conversation.turns), lastContextTokens),
            maxTokens: 120_000,
            turns: t.turns,
            costUsd: sessionCost > 0 ? sessionCost : null,
            queued: queued.length,
            ui,
            width: process.stdout.columns ?? 100,
          })}
`,
        );
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
 * @param {ReturnType<typeof selectProvider>} picked
 * @returns {string[]}
 */
function statusLines(paths, state, picked) {
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
  return DEFAULT_AGENT;
}

/**
 * @param {object} args
 * @param {import("@ax-navi/core").ProjectPaths} args.paths
 * @param {string} args.line
 * @param {import("./completion.mjs").SlashCommand[]} args.commands
 * @param {Map<string, { name: string }>} args.skillByName
 * @param {() => void} [args.onReset]
 * @param {() => ({ id: string, agent: string, turns: number, sessionId?: string } | null)} [args.onContext]
 * @returns {Promise<number>}
 */
async function handleSlash({ paths, line, commands, skillByName, onReset, onContext }) {
  const spaceAt = line.indexOf(" ");
  const cmd = spaceAt === -1 ? line.slice(1) : line.slice(1, spaceAt);
  const argText = spaceAt === -1 ? "" : line.slice(spaceAt + 1).trim();
  const rest = argText ? argText.split(/\s+/) : [];

  switch (cmd) {
    case "new":
      /*
       * 대화를 끊는다. 주제가 바뀌었는데 앞 대화를 끌고 가면 비용만 늘고
       * 엉뚱한 맥락이 섞인다.
       */
      onReset?.();
      process.stdout.write(`  ${ui.dim("새 대화를 시작한다.")}\n`);
      return 0;

    case "sessions": {
      const records = await listSessions(paths, 10);
      if (!records.length) {
        process.stdout.write(`  ${ui.dim("저장된 세션 없음.")}\n`);
        return 0;
      }
      const out = [""];
      for (const r of records) {
        out.push(`  ${ui.cyan(r.id)}  ${ui.dim(`${r.agent} · ${r.turns}턴`)}`);
        out.push(`  ${" ".repeat(r.id.length)}  ${ui.dim(r.title || "(제목 없음)")}`);
      }
      out.push("");
      out.push(`  ${ui.dim("axnavi --resume <id> 로 이어서 시작한다. --continue 는 가장 최근 것.")}`);
      out.push("", "");
      process.stdout.write(out.join("\n"));
      return 0;
    }

    case "context": {
      const info = onContext?.();
      if (!info) {
        process.stdout.write(`  ${ui.dim("진행 중인 대화 없음. 뭐든 물어보면 시작된다.")}\n`);
        return 0;
      }
      const resume = info.sessionId
        ? `${ui.green("활성")} ${ui.dim(`(${info.sessionId.slice(0, 8)}…)`)}`
        : ui.dim("없음 — 이번 턴이 끝나면 잡힌다");
      process.stdout.write(
        [
          "",
          `  ${ui.dim("세션")}      ${info.id}`,
          `  ${ui.dim("에이전트")}  ${info.agent}`,
          `  ${ui.dim("턴")}        ${info.turns}`,
          `  ${ui.dim("이어가기")}  ${resume}`,
          "",
          `  ${ui.dim("/new 로 대화를 끊는다. 주제가 바뀌면 끊는 편이 싸다.")}`,
          "",
          "",
        ].join("\n"),
      );
      return 0;
    }

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
