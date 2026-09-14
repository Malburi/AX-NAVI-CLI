/*
 * 에이전트 한 번 실행하고 터미널에 흘려보내는 공통 경로.
 * ask / agent run / skill run이 전부 여기로 모인다.
 */
import {
  createDefaultRegistry,
  loadAgent,
  resolveProjectPaths,
  runAgent,
  ToolGateway,
} from "@ax-navi/core";
import { selectProvider } from "./provider.mjs";
import { join } from "node:path";
import { AGENTS_DIR, REPO_ROOT, createAuditSink, createElicitor, createProgressSink, ui } from "./runtime.mjs";

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.agentName
 * @param {string} args.prompt
 * @param {import("./provider.mjs").ProviderName} [args.providerName]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function executeAgent({ root, agentName, prompt, providerName, signal }) {
  /*
   * Provider를 먼저 고른다.
   *
   * 키가 없어도 claude CLI가 있으면 구독으로 돌아간다 — 이 분기가 있어야
   * API 키를 못 받는 환경에서도 에이전트 경로를 쓸 수 있다.
   */
  const picked = selectProvider({
    ...(providerName ? { provider: providerName } : {}),
    cwd: root,
  });
  if ("error" in picked) {
    process.stderr.write(`${picked.error}\n`);
    return 1;
  }

  const paths = resolveProjectPaths(root);
  const agent = await loadAgent(join(AGENTS_DIR, `${agentName}.md`), {
    pluginRoot: REPO_ROOT,
    projectRoot: paths.root,
  });

  for (const warning of agent.warnings) process.stderr.write(ui.dim(`  ! ${warning}\n`));

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
    elicitor: createElicitor(),
    progress: createProgressSink(),
    signal: controller.signal,
  };

  const provider = picked.provider;
  const allowed = registry.definitionsFor(agent.role).map((d) => d.name);
  process.stderr.write(ui.dim(`  provider=${picked.note}\n`));
  process.stderr.write(`${ui.dim(`  agent=${agent.name} tier=${agent.tier} tools=${allowed.join(",")}`)}\n\n`);

  let failed = false;
  let toolErrors = 0;
  /** @type {{ input: number, output: number, cacheRead: number, costUsd: number | null }} */
  const totals = { input: 0, output: 0, cacheRead: 0, costUsd: null };

  try {
    for await (const event of runAgent({ provider, agent, registry, gateway, ctx, userPrompt: prompt })) {
      if (event.type === "text") process.stdout.write(event.text ?? "");
      else if (event.type === "delegated") {
        // 통제 주체가 옮겨간 사실을 조용히 넘기지 않는다.
        process.stderr.write(`${ui.yellow("  ! ")}${ui.dim(event.reason ?? "")}\n`);
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
    await audit.flush();
  }

  process.stdout.write("\n");
  const cost = totals.costUsd === null ? "" : `  ·  $${totals.costUsd.toFixed(4)}`;
  const recovered = toolErrors ? `  ·  도구 실패 ${toolErrors}건(복구됨)` : "";
  process.stderr.write(
    ui.dim(
      `\n  토큰 in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead}${cost}${recovered}` +
        `  ·  감사기록 ${audit.file}\n`,
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
