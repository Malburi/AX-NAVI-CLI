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
import { join } from "node:path";
import { AGENTS_DIR, REPO_ROOT, createAuditSink, createElicitor, createProgressSink, debug, ui } from "./runtime.mjs";

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} [args.agentName]        agents/<이름>.md 를 읽어 실행자로 쓴다
 * @param {import("@ax-navi/core").AgentDefinition} [args.agent]  미리 만든 실행자 (오케스트레이터 등)
 * @param {string} args.prompt
 * @param {import("@ax-navi/core").Conversation} [args.conversation]  주면 대화를 이어간다
 * @param {import("./provider.mjs").ProviderName} [args.providerName]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function executeAgent({ root, agentName, agent: preset, prompt, conversation, providerName, signal }) {
  /*
   * Provider를 먼저 고른다.
   *
   * 키가 없어도 claude CLI가 있으면 구독으로 돌아간다 — 이 분기가 있어야
   * API 키를 못 받는 환경에서도 에이전트 경로를 쓸 수 있다.
   */
  const paths = resolveProjectPaths(root);
  const elicitor = createElicitor();

  /*
   * 위임 실행이 사용자에게 되묻고 우리 인덱스를 쓸 수 있게 MCP 브리지를 띄운다.
   * 이게 없으면 "물을 수단이 없다"고 가정하고 기본값으로 넘어간다(실측).
   */
  const bridge = await startMcpBridge({ paths, elicitor });

  const picked = selectProvider({
    ...(providerName ? { provider: providerName } : {}),
    cwd: root,
    mcp: { configPath: bridge.configPath, env: bridge.env },
  });
  if ("error" in picked) {
    process.stderr.write(`${picked.error}\n`);
    await bridge.dispose();
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
  const controller = new AbortController();
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

  const startedAt = Date.now();
  let failed = false;
  let toolErrors = 0;
  /** @type {{ input: number, output: number, cacheRead: number, costUsd: number | null }} */
  const totals = { input: 0, output: 0, cacheRead: 0, costUsd: null };

  try {
    for await (const event of runAgent({ provider, agent, registry, gateway, ctx, userPrompt: prompt, ...(conversation ? { conversation } : {}) })) {
      if (event.type === "text") process.stdout.write(event.text ?? "");
      else if (event.type === "compacted") {
        // 컨텍스트를 줄였다는 사실은 숨기지 않는다 — 답이 앞 내용을 잊은 이유가 될 수 있다.
        process.stderr.write(`${ui.yellow("  ⤵ ")}${ui.dim(event.reason ?? "")}\n`);
      } else if (event.type === "delegated") {
        /*
         * 통제 주체가 옮겨간 사실은 시작 화면의 Runtime 줄이 이미 밝히고 있다.
         * 호출마다 되풀이하면 그건 공지가 아니라 소음이다.
         */
        debug(`${ui.yellow("  ! ")}${ui.dim(event.reason ?? "")}\n`);
      } else if (event.type === "tool_call") {
        process.stderr.write(`\n${ui.cyan(`  → ${event.tool}`)} ${ui.dim(summarize(event.input))}\n`);
      } else if (event.type === "tool_result") {
        const head = (event.result ?? "").split("\n")[0] ?? "";
        const mark = event.isError ? ui.red("  ✗") : ui.green("  ←");
        process.stderr.write(`${mark} ${ui.dim(head.slice(0, 160))}\n`);
        /*
         * 도구 실패 하나를 실행 전체의 실패로 보지 않는다.
         * 에이전트는 잘못된 경로로 grep했다가 고쳐 다시 부르는 식으로 스스로 복구한다 —
         * 그걸 실패로 세면 정상적으로 끝난 작업이 exit 1로 나간다(실측으로 확인).
         * 최종 판정은 아래 error 이벤트와 종료 사유로만 한다.
         */
        if (event.isError) toolErrors += 1;
      } else if (event.type === "usage" && event.usage) {
        totals.input += event.usage.inputTokens;
        totals.output += event.usage.outputTokens;
        totals.cacheRead += event.usage.cacheReadTokens;
        // 비용은 Provider가 실제로 줄 때만 표시한다. 추정치를 지어내지 않는다.
        if (typeof event.usage.costUsd === "number") {
          totals.costUsd = (totals.costUsd ?? 0) + event.usage.costUsd;
        }
      } else if (event.type === "error") {
        process.stderr.write(`\n${ui.red(`  오류: ${event.reason}`)}\n`);
        failed = true;
      } else if (event.type === "done") {
        // 상한 도달·거절 같은 비정상 종료를 성공으로 보고하지 않는다.
        if (event.reason && !["end_turn", "stop_sequence"].includes(event.reason)) {
          process.stderr.write(`\n${ui.yellow(`  종료 사유: ${event.reason}`)}\n`);
        }
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    await bridge.dispose();
    await audit.flush();
  }

  process.stdout.write("\n");

  /*
   * 마무리 한 줄.
   *
   * 사용자가 매번 알고 싶은 것은 "얼마나 걸렸고 얼마 들었나"뿐이다.
   * 토큰 내역·감사기록 경로는 필요할 때만 --verbose 로 본다.
   */
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const cost = totals.costUsd === null ? "" : ` · $${totals.costUsd.toFixed(4)}`;
  const recovered = toolErrors ? ` · 도구 실패 ${toolErrors}건(복구됨)` : "";
  const asked = bridge.askedCount() ? ` · 질문 ${bridge.askedCount()}회` : "";
  process.stderr.write(ui.dim(`  ${seconds}s${cost}${recovered}${asked}\n`));
  debug(
    ui.dim(
      `  토큰 in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead}` +
        ` · 감사기록 ${audit.file}\n`,
    ),
  );
  return failed ? 1 : 0;
}

/** @param {unknown} input */
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  const parts = Object.entries(input)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .slice(0, 3);
  return parts.join(" ");
}
