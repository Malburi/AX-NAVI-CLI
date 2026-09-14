/*
 * 에이전트 한 번 실행하고 터미널에 흘려보내는 공통 경로.
 * ask / agent run / skill run이 전부 여기로 모인다.
 */
import {
  buildProjectContext,
  createDefaultRegistry,
  indexAgeNote,
  loadAgent,
  resolveProjectPaths,
  runAgent,
  ToolGateway,
} from "@ax-navi/core";
import { selectProvider } from "./provider.mjs";
import { startMcpBridge } from "./mcp/bridge.mjs";
import { createActivity, elapsed } from "./activity.mjs";
import { renderCall } from "./transcript.mjs";
import { join } from "node:path";
import { AGENTS_DIR, REPO_ROOT, beginTurn, createAuditSink, createHostElicitor, createProgressSink, endTurn, readTyping, debug, ui } from "./runtime.mjs";

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} [args.agentName]        agents/<이름>.md 를 읽어 실행자로 쓴다
 * @param {import("@ax-navi/core").AgentDefinition} [args.agent]  미리 만든 실행자 (오케스트레이터 등)
 * @param {string} args.prompt
 * @param {import("@ax-navi/core").Conversation} [args.conversation]  주면 대화를 이어간다
 * @param {(usd: number) => void} [args.onCost]  이번 실행의 비용을 호출부에 알린다
 * @param {(tokens: number) => void} [args.onContextSize]  이번 턴이 실제로 실어 보낸 컨텍스트 크기
 * @param {(text: string) => void} [args.onAnswer]  대화를 다시 여는 데 쓸 답변 본문
 * @param {() => number} [args.queuedCount]  대기 중인 입력 줄 수 (상태 표시에 쓴다)
 * @param {import("./provider.mjs").ProviderName} [args.providerName]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function executeAgent({ root, agentName, agent: preset, prompt, conversation, onCost, onContextSize, onAnswer, queuedCount, providerName, signal }) {
  /*
   * Provider를 먼저 고른다.
   *
   * 키가 없어도 claude CLI가 있으면 구독으로 돌아간다 — 이 분기가 있어야
   * API 키를 못 받는 환경에서도 에이전트 경로를 쓸 수 있다.
   */
  const paths = resolveProjectPaths(root);

  /*
   * 상태 표시를 먼저 만든다 — 질문이 뜰 때 이 줄을 걷어야 하기 때문이다.
   * 안 걷으면 회전자가 질문 위에 덮어써서 무엇을 묻는지 안 보인다.
   */
  const activity = createActivity({ output: process.stdout, ui });

  /*
   * 질문 통로. 상태 표시를 걷었다 되살리며 묻는다 —
   * 안 걷으면 회전자가 질문지 위에 덮어써서 선택지가 안 보인다.
   */
  const baseElicitor = createHostElicitor();
  /** @type {import("@ax-navi/core").Elicitor} */
  const elicitor = {
    async ask(question, options, opts) {
      activity.suspend();
      try {
        return await baseElicitor.ask(question, options, opts ?? {});
      } finally {
        activity.resume();
      }
    },
  };

  /*
   * 위임 실행이 사용자에게 되묻고 우리 인덱스를 쓸 수 있게 MCP 브리지를 띄운다.
   * 이게 없으면 "물을 수단이 없다"고 가정하고 기본값으로 넘어간다(실측).
   */
  const bridge = await startMcpBridge({ paths, elicitor });
  try {
    return await runWithBridge();
  } finally {
    /*
     * 브리지는 로컬 소켓 서버라 닫지 않으면 이벤트 루프가 살아 있어 프로세스가 끝나지 않는다.
     * 예전에는 이 정리가 실행 루프 안쪽 finally 에만 있어서, 그 앞에서 예외가 나면
     * (예: 없는 에이전트 파일) 오류만 찍고 CLI가 영영 안 끝났다(실측).
     */
    await bridge.dispose();
  }

  async function runWithBridge() {
    const picked = selectProvider({
      ...(providerName ? { provider: providerName } : {}),
      cwd: root,
      mcp: { configPath: bridge.configPath, env: bridge.env },
    });
    if ("error" in picked) {
      process.stderr.write(`${picked.error}\n`);
      return 1;
  }

  /*
   * 실행자는 두 가지로 온다.
   *   agentName  — agents/<이름>.md 를 읽는다 (일반 경로)
   *   agent      — 호출부가 만들어 넘긴다 (오케스트레이터 스킬처럼 대응하는 .md 가 없을 때)
   */
  if (!preset && !agentName) throw new Error("agentName 또는 agent 중 하나는 필요하다");
  let agent = preset
    ?? (await loadAgent(join(AGENTS_DIR, `${agentName}.md`), { pluginRoot: REPO_ROOT, projectRoot: paths.root }));

  // 경로 치환 같은 내부 적응 기록은 사용자가 볼 것이 아니다.
  for (const warning of agent.warnings ?? []) debug(ui.dim(`  ! ${warning}\n`));

  const registry = createDefaultRegistry();
  const gateway = new ToolGateway(registry);
  const audit = createAuditSink(paths);
  /*
   * 취소 손잡이를 전역에 등록한다 — REPL 이 Ctrl+C / ESC 로 여기를 끊을 수 있어야 한다.
   *
   * process.on("SIGINT") 만으로는 REPL 안에서 아무 일도 일어나지 않는다. readline 이
   * TTY 에서  을 가로채 자기 close() 로 처리하고 프로세스 시그널을 올리지 않기
   * 때문이다(실측: 중단해도 턴이 끝까지 돌았다). 단발 실행에는 여전히 필요하므로 둘 다 건다.
   */
  const controller = beginTurn();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  /** @type {import("@ax-navi/core").ToolContext} */
  const ctx = {
    paths,
    allowedRoots: [paths.root],
    role: agent.role,
    audit,
    elicitor,
    progress: createProgressSink(),
    signal: controller.signal,
  };

  /*
   * 프로젝트 컨텍스트를 첫 턴에만 얹는다.
   *
   * 이어가는 턴에는 이미 대화에 남아 있어 다시 실을 이유가 없다.
   * 위임 경로는 claude 가 CLAUDE.md 를 스스로 읽으므로 본문 중복을 피한다 —
   * 대신 인덱스 사실은 그쪽이 모르므로 항상 싣는다.
   */
  const provider = picked.provider;
  const isFirstTurn = !conversation
    || (conversation.turns.length <= 1 && !conversation.providerSessionId);
  if (isFirstTurn) {
    const projectContext = buildProjectContext({
      paths,
      includeClaudeMd: !provider.capabilities.ownsAgentLoop,
    });
    const ageNote = indexAgeNote(paths);
    agent = {
      ...agent,
      systemPrompt: [agent.systemPrompt, "", projectContext, ...(ageNote ? [ageNote] : [])].join("\n"),
    };
  }

  const allowed = registry.definitionsFor(agent.role).map((d) => d.name);
  debug(ui.dim(`  provider=${picked.note}\n`));
  debug(ui.dim(`  agent=${agent.name} tier=${agent.tier} tools=${allowed.join(",")}\n`));

  /*
   * 출력과 상태 표시.
   *
   * 상태 표시는 한 줄 제자리 갱신이라, 무언가를 찍기 전에 그 줄을 지우고 찍은 뒤 되살린다.
   * 스트리밍 텍스트는 줄 단위로 모아 내보낸다 — 토큰마다 화면을 건드리면 깜빡인다.
   */
  /** 결과를 기다리는 호출들. @type {Map<string, { tool: string, input: unknown, parentId?: string }>} */
  const pending = new Map();

  /** 지금 도는 서브에이전트들. @type {Map<string, { label: string, startedAt: number, tools: number }>} */
  const subagents = new Map();
  const NEWLINE = String.fromCharCode(10);

  /** @param {string} text */
  const emit = (text) => {
    activity.suspend();
    process.stdout.write(`${text}\n`);
    activity.resume();
  };

  /*
   * 본문 버퍼를 둘로 나눈다 — 오케스트레이터와 서브에이전트.
   *
   * 하나로 쓰면 서브에이전트가 내놓는 글이 부모의 문장 한가운데 끼어든다.
   * 실측으로 "clean, compile, ...clean, compile, ..." 처럼 두 글이 붙어 나왔다.
   */
  /** @type {Map<string, string>} */
  const buffers = new Map();

  /**
   * @param {string} chunk
   * @param {string} [parentId]  서브에이전트가 낸 글이면 그 Task 호출 id
   */
  const emitText = (chunk, parentId) => {
    const key = parentId ?? "";
    let buf = (buffers.get(key) ?? "") + chunk;
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE)) {
      writeText(buf.slice(0, nl), parentId);
      buf = buf.slice(nl + 1);
    }
    buffers.set(key, buf);
  };

  /**
   * @param {string} line
   * @param {string} [parentId]
   */
  const writeText = (line, parentId) => {
    // 서브에이전트가 한 말은 들여서 흐리게 — 부모가 한 말과 섞이면 누가 한 말인지 모른다.
    emit(parentId ? `${ui.dim("│")} ${ui.dim(line)}` : line);
  };

  /** @param {string} [parentId] 주면 그 버퍼만, 안 주면 전부 비운다. */
  const flushText = (parentId) => {
    for (const [key, buf] of buffers) {
      if (parentId !== undefined && key !== parentId) continue;
      if (buf) writeText(buf, key || undefined);
      buffers.set(key, "");
    }
  };

  /** 이번 턴에서 사용자가 본 답. 세션에 쌓아 두면 다음에 이어 열 때 되살릴 수 있다. */
  let answer = "";

  const startedAt = Date.now();
  let failed = false;
  let toolErrors = 0;
  /** @type {{ input: number, output: number, cacheRead: number, costUsd: number | null }} */
  const totals = { input: 0, output: 0, cacheRead: 0, costUsd: null };

  activity.start(agent.name);
  /** 대기 입력이 늘면 상태줄에 반영한다 — 사라진 게 아니라 줄 섰다는 신호다. */
  const queueWatch = setInterval(() => {
    const typed = readTyping();
    activity.set({ queued: queuedCount?.() ?? typed.queued, typing: typed.text });
  }, 200);
  queueWatch.unref?.();

  try {
    for await (const event of runAgent({ provider, agent, registry, gateway, ctx, userPrompt: prompt, ...(conversation ? { conversation } : {}) })) {
      if (event.type === "text") {
        // 서브에이전트가 한 말은 말고 오케스트레이터 본인의 답만 모은다 — 그게 사용자가 본 답이다.
        if (!event.parentId) answer += event.text ?? "";
        emitText(event.text ?? "", event.parentId);
      }
      else if (event.type === "compacted") {
        // 컨텍스트를 줄였다는 사실은 숨기지 않는다 — 답이 앞 내용을 잊은 이유가 될 수 있다.
        emit(`${ui.yellow("  ⤵ ")}${ui.dim(event.reason ?? "")}`);
      } else if (event.type === "delegated") {
        /*
         * 통제 주체가 옮겨간 사실은 시작 화면의 Runtime 줄이 이미 밝히고 있다.
         * 호출마다 되풀이하면 그건 공지가 아니라 소음이다.
         */
        debug(`${ui.yellow("  ! ")}${ui.dim(event.reason ?? "")}\n`);
      } else if (event.type === "tool_call") {
        // 자기 버퍼만 비운다 — 서브에이전트 도구 호출이 부모의 문장을 끊으면 안 된다.
        flushText(event.parentId ?? "");
        const tool = toolLabel(event.tool ?? "");
        const id = event.id ?? `익명${pending.size}`;

        /*
         * Task 는 그 자체가 담짜다 — 머리를 바로 찍고, 안에서 나는 일을 들여 보인다.
         * 결과까지 들고 있으면 서브에이전트가 몇 분을 도는 동안 화면이 깜깜해진다.
         */
        if (SUBAGENT_TOOLS.has(tool)) {
          const label = describeTask(event.input);
          subagents.set(id, { label, startedAt: Date.now(), tools: 0 });
          activity.set({ subagent: label, tool: "" });
          emit(`${ui.cyan("●")} ${ui.bold(`Task(${label})`)}`);
          continue;
        }

        const parent = event.parentId ? subagents.get(event.parentId) : undefined;
        if (parent) parent.tools += 1;
        activity.set({ tool, subagent: parent ? parent.label : "" });
        /*
         * 바로 찍지 않고 결과가 올 때까지 든다.
         *
         * claude 는 도구를 병렬로 돌린다. 호출 대여섯 개가 먼저 쌏아지고 결과가 뒤늫게
         * 따라오니, 오는 대로 흘리면 어느 결과가 어느 호출의 것인지 모른다(실측).
         * 지금 무엇이 도는지는 상태 표시 줄이 보여 주므로 기다리는 동안 깜깜하지 않다.
         */
        pending.set(id, { tool, input: event.input, parentId: event.parentId });
      } else if (event.type === "tool_result") {
        const key = event.id ?? [...pending.keys()][0];

        // 서브에이전트가 끝났다 — 무엇을 얼마나 했는지 한 줄로 닫는다.
        const done = key === undefined ? undefined : subagents.get(key);
        if (done && key !== undefined) {
          // 서브에이전트가 마지막에 한 말을 먼저 비운다. 닫는 줄 뒤에 나오면 블록 밖으로 샐다.
          flushText(key);
          subagents.delete(key);
          activity.set({ subagent: "" });
          emit(`  ${ui.dim("⎿")} ${ui.dim(`끝남 · 도구 ${done.tools}회 · ${elapsed(Date.now() - done.startedAt)}`)}`);
          if (event.isError) toolErrors += 1;
          continue;
        }

        const call = key === undefined ? undefined : pending.get(key);
        if (key !== undefined) pending.delete(key);
        emit(
          renderCall({
            tool: call?.tool ?? toolLabel(event.tool ?? ""),
            input: call?.input,
            result: event.result ?? "",
            isError: event.isError === true,
            root: paths.root,
            depth: (call?.parentId ?? event.parentId) ? 1 : 0,
            width: process.stdout.columns ?? 100,
            ui,
          }).join("\n"),
        );
        /*
         * 도구 실패 하나를 실행 전체의 실패로 보지 않는다.
         * 에이전트는 잘못된 경로로 grep 했다가 고쳌 다시 부르는 식으로 스스로 복구한다 —
         * 그걸 실패로 세면 정상적으로 끝난 작업이 exit 1 로 나간다(실측으로 확인).
         * 최종 판정은 아래 error 이벤트와 종료 사유로만 한다.
         */
        if (event.isError) toolErrors += 1;
      } else if (event.type === "usage" && event.usage) {
        totals.input += event.usage.inputTokens;
        totals.output += event.usage.outputTokens;
        totals.cacheRead += event.usage.cacheReadTokens;
        activity.bump(event.usage.outputTokens);
        /*
         * 위임 경로에서는 대화를 그쪽이 들고 있어 우리 turns 가 비어 있다 —
         * 그대로 두면 상태줄이 늘 "Ctx 0" 이라 쓸모가 없다.
         * 실제로 실어 보낸 양이 곳 컨텍스트 크기다.
         * 캐시 **생성**량까지 더해야 한다 — 첫 턴은 읽을 캐시가 없어 전부 생성으로 잡힌다.
         * 그걸 빼면 26k 를 실어 보내고도 "Ctx 2" 가 된다(실측).
         */
        onContextSize?.(
          event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens,
        );
        // 비용은 Provider가 실제로 줄 때만 표시한다. 추정치를 지어내지 않는다.
        if (typeof event.usage.costUsd === "number") {
          totals.costUsd = (totals.costUsd ?? 0) + event.usage.costUsd;
          onCost?.(event.usage.costUsd);
        }
      } else if (event.type === "error") {
        flushText();
        emit(ui.red(`  오류: ${event.reason}`));
        failed = true;
      } else if (event.type === "done") {
        // 상한 도달·거절 같은 비정상 종료를 성공으로 보고하지 않는다.
        if (event.reason && !["end_turn", "stop_sequence"].includes(event.reason)) {
          emit(ui.yellow(`  종료 사유: ${event.reason}`));
        }
      }
    }
  } finally {
    flushText();
    /*
     * 짝을 못 찾은 호출은 그대로 밝힌다. 중단하면 결과가 오지 않는데,
     * 조용히 버리면 무엇을 하다 멈컴는지가 기록에서 사라진다.
     */
    for (const [, call] of pending) {
      emit(
        renderCall({
          tool: call.tool, input: call.input, pending: true,
          root: paths.root, width: process.stdout.columns ?? 100, ui,
        }).join("\n"),
      );
    }
    pending.clear();
    clearInterval(queueWatch);
    activity.stop();
    process.off("SIGINT", onSigint);
    endTurn(controller);
    onAnswer?.(answer);
    await audit.flush();
  }

  /*
   * 마무리 한 줄.
   *
   * 사용자가 매번 알고 싶은 것은 "얼마나 걸렸고 얼마 들었나"뿐이다.
   * 토큰 내역·감사기록 경로는 필요할 때만 --verbose 로 본다.
   */
  const seconds = elapsed(Date.now() - startedAt);
  const cost = totals.costUsd === null ? "" : ` · $${totals.costUsd.toFixed(4)}`;
  const recovered = toolErrors ? ` · 도구 실패 ${toolErrors}건(복구됨)` : "";
  const asked = bridge.askedCount() ? ` · 질문 ${bridge.askedCount()}회` : "";
  /*
   * 중단은 실패가 아니라 사용자의 결정이다. 다만 **끝난 것처럼 보이면 안 된다** —
   * 여기까지의 산출물은 절차 중간이라 불완전하기 때문이다. 그 사실을 그대로 적는다.
   */
  process.stderr.write(
    controller.signal.aborted
      ? `${ui.yellow("  ⛔ 중단됨")} ${ui.dim(`— 여기까지만 진행됐다 · ${seconds}${cost}${asked}`)}\n`
      : ui.dim(`  ${seconds}${cost}${recovered}${asked}\n`),
  );
  debug(
    ui.dim(
      `  토큰 in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead}` +
        ` · 감사기록 ${audit.file}\n`,
    ),
  );
  if (controller.signal.aborted) return 130; // 관례: 128 + SIGINT(2)
  return failed ? 1 : 0;
  }
}

/** @param {unknown} input */
/**
 * 화면에 쓸 도구 이름.
 *
 * 질문·인덱스 조회는 MCP 브리지를 타고 가느라 `mcp__axnavi__` 가 붙는데, 그건 우리
 * 내부 전송 경로 이름이지 사용자가 알아야 할 것이 아니다. 화면에서는 걷어낸다.
 * @param {string} name
 * @returns {string}
 */
function toolLabel(name) {
  return name.replace(/^mcp__axnavi__/, "");
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  const parts = Object.entries(input)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .slice(0, 3);
  return parts.join(" ");
}

/*
 * 서브에이전트를 띄우는 도구 이름.
 *
 * claude 2.1.259 는 도구 목록에 Task 로 알리면서 실제 호출은 Agent 로 보낸다(실측).
 * 한 쪽만 보면 서브에이전트 머리가 안 찍히고 안의 도구들만 떠돌아다니게 된다.
 */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/**
 * Task 호출을 부를 이름.
 *
 * subagent_type 은 이 런타임에서 항상 general-purpose 라 구분이 안 된다 —
 * 실제 역할은 description 에 들어 있다.
 * @param {unknown} input
 * @returns {string}
 */
function describeTask(input) {
  const args = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  for (const key of ["description", "subagent_type"]) {
    if (typeof args[key] === "string" && args[key]) return /** @type {string} */ (args[key]);
  }
  return "서브에이전트";
}
