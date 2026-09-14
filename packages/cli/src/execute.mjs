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
import { AnthropicProvider } from "@ax-navi/provider-anthropic";
import { join } from "node:path";
import { AGENTS_DIR, REPO_ROOT, createAuditSink, createElicitor, createProgressSink, ui } from "./runtime.mjs";

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.agentName
 * @param {string} args.prompt
 * @param {string} [args.extraInstruction]  스킬 절차처럼 앞에 덧붙일 지시
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function executeAgent({ root, agentName, prompt, extraInstruction, signal }) {
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

  const provider = new AnthropicProvider();
  const allowed = registry.definitionsFor(agent.role).map((d) => d.name);
  process.stderr.write(
    `${ui.dim(`  agent=${agent.name} tier=${agent.tier} tools=${allowed.join(",")}`)}\n\n`,
  );

  const userPrompt = extraInstruction ? `${extraInstruction}\n\n---\n\n${prompt}` : prompt;

  let failed = false;
  /** @type {{ input: number, output: number, cacheRead: number }} */
  const totals = { input: 0, output: 0, cacheRead: 0 };

  try {
    for await (const event of runAgent({ provider, agent, registry, gateway, ctx, userPrompt })) {
      if (event.type === "text") process.stdout.write(event.text ?? "");
      else if (event.type === "tool_call") {
        process.stderr.write(`\n${ui.cyan(`  → ${event.tool}`)} ${ui.dim(summarize(event.input))}\n`);
      } else if (event.type === "tool_result") {
        const head = (event.result ?? "").split("\n")[0] ?? "";
        const mark = event.isError ? ui.red("  ✗") : ui.green("  ←");
        process.stderr.write(`${mark} ${ui.dim(head.slice(0, 160))}\n`);
        if (event.isError) failed = true;
      } else if (event.type === "usage" && event.usage) {
        totals.input += event.usage.inputTokens;
        totals.output += event.usage.outputTokens;
        totals.cacheRead += event.usage.cacheReadTokens;
      } else if (event.type === "error") {
        process.stderr.write(`\n${ui.red(`  오류: ${event.reason}`)}\n`);
        failed = true;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    await audit.flush();
  }

  process.stdout.write("\n");
  process.stderr.write(
    ui.dim(
      `\n  토큰 in=${totals.input} out=${totals.output} cache_read=${totals.cacheRead}` +
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
