/*
 * 에이전트 한 번 실행하고 터미널에 흘려보내는 공통 경로.
 * ask / agent run / skill run이 전부 여기로 모인다.
 */
import {
  buildProjectContext,
  createDefaultRegistry,
  discoverRoots,
  indexAgeNote,
  loadAgent,
  resolveProjectPaths,
  runAgent,
  ToolGateway,
} from "../../core/src/index.mjs";
import { selectProvider } from "./provider.mjs";
import { startMcpBridge } from "./mcp/bridge.mjs";
import { createActivity, elapsed } from "./activity.mjs";
import { headline, renderCall } from "./transcript.mjs";
import { createMarkdown } from "./markdown.mjs";
import { clipToWidth, visibleLength } from "./width.mjs";
import { applyMode } from "./mode.mjs";
import { join } from "node:path";
import { closeTurn, openTurn, recordAgentEnd, recordAgentStart, recordLine } from "./record.mjs";
import { unwrittenClaims } from "./claims.mjs";
import { createApprover } from "./approval.mjs";
import { modelUnavailableHint } from "./models.mjs";

/*
 * "이번 세션 동안 묻지 않음" 기억. 턴마다 executeAgent 가 새로 불리므로 여기 둔다 —
 * 턴 안에 두면 매 질문마다 같은 허용을 다시 물어 플러그인과 달라진다.
 */
const sessionApprovals = new Set();
import { AGENTS_DIR, REPO_ROOT, beginTurn, createAuditSink, createHostElicitor, createProgressSink, endTurn, readTyping, rememberFolded, sessionMode, sessionModel, setPanelModeSink, debug, ui } from "./runtime.mjs";

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} [args.agentName]        agents/<이름>.md 를 읽어 실행자로 쓴다
 * @param {import("@ax-navi/core").AgentDefinition} [args.agent]  미리 만든 실행자 (오케스트레이터 등)
 * @param {string} args.prompt
 * @param {import("@ax-navi/core").Conversation} [args.conversation]  주면 대화를 이어간다
 * @param {(usd: number) => void} [args.onCost]  이번 실행의 비용을 호출부에 알린다
 * @param {(tokens: number) => void} [args.onContextSize]  이번 턴이 실제로 실어 보낸 컨텍스트 크기
 * @param {(name: string, request: string) => string} [args.onSkillRequest]  모델이 스킬 실행을 요청했을 때
 * @param {(text: string) => void} [args.onAnswer]  대화를 다시 여는 데 쓸 답변 본문
 * @param {() => number} [args.queuedCount]  대기 중인 입력 줄 수 (상태 표시에 쓴다)
 * @param {import("./provider.mjs").ProviderName} [args.providerName]
 * @param {AbortSignal} [args.signal]
 * @param {boolean} [args.background]  화면에 찍지 않고 기록에만 담는다 (동시에 도는 작업용)
 * @param {string} [args.title]        되짚기 목록에 뜰 이름. 없으면 요청 첫 줄을 쓴다
 * @returns {Promise<number>} 프로세스 종료 코드
 */
export async function executeAgent({ root, agentName, agent: preset, prompt, conversation, onCost, onContextSize, onAnswer, onSkillRequest, queuedCount, providerName, signal, background = false, title }) {
  /*
   * Provider를 먼저 고른다.
   *
   * 키가 없어도 claude CLI가 있으면 구독으로 돌아간다 — 이 분기가 있어야
   * API 키를 못 받는 환경에서도 에이전트 경로를 쓸 수 있다.
   */
  const paths = resolveProjectPaths(root);

  /*
   * 인덱스를 가진 저장소를 찾는다.
   *
   * 선 자리에 인덱스가 있으면 아무것도 하지 않는다 — 단일 저장소 동작은 그대로다.
   * 부모 폴더에서 띄웠을 때만 한 단계 아래를 훑는다. 실측으로 그 경우 인덱스를
   * 통째로 잃고 grep 으로 내려앉았다.
   */
  const discovery = discoverRoots(root);
  const multiRoot = discovery.roots.length > 1;

  /*
   * 상태 표시를 먼저 만든다 — 질문이 뜰 때 이 줄을 걷어야 하기 때문이다.
   * 안 걷으면 회전자가 질문 위에 덮어써서 무엇을 묻는지 안 보인다.
   */
  /*
   * 백그라운드 작업은 화면 바닥 판을 만들지 않는다.
   * 전경 턴과 판을 나눠 가지면 둘이 같은 줄을 서로 덮어써서 화면이 깨진다.
   */
  const activity = background
    ? { start() {}, set() {}, bump() {}, suspend() {}, resume() {}, stop() {} }
    : createActivity({ output: process.stdout, ui });

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
  /*
   * 도구 사용 승인. 누가 무엇을 허용·거부했는지는 감사 기록에 남긴다 —
   * 조직에 배포하는 도구에서 "누가 이 파일을 쓰게 했나" 는 나중에 반드시 묻는 질문이다.
   */
  const approvalAudit = createAuditSink(paths);
  const approver = createApprover({
    ask: (question, options, opts) => elicitor.ask(question, options, opts),
    always: sessionApprovals,
    pluginRoot: REPO_ROOT,
    trustAll: () => sessionMode() === "trust",
    onDecision: ({ tool, input, allowed, how }) => {
      approvalAudit.record({
        at: new Date().toISOString(),
        role: agentName ?? preset?.name ?? "?",
        tool,
        input,
        outcome: allowed ? "ok" : "denied",
        reason: `승인: ${how}`,
        durationMs: 0,
      });
    },
  });
  const bridge = await startMcpBridge({
    paths,
    elicitor,
    onApprove: (tool, input) => approver.decide(tool, input),
    ...(onSkillRequest ? { onSkill: onSkillRequest } : {}),
  });
  try {
    return await runWithBridge();
  } finally {
    /*
     * 브리지는 로컬 소켓 서버라 닫지 않으면 이벤트 루프가 살아 있어 프로세스가 끝나지 않는다.
     * 예전에는 이 정리가 실행 루프 안쪽 finally 에만 있어서, 그 앞에서 예외가 나면
     * (예: 없는 에이전트 파일) 오류만 찍고 CLI가 영영 안 끝났다(실측).
     */
    await bridge.dispose();
    await approvalAudit.flush();
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
    // 실행 경로를 판에 밝힌다 — 구독인지 API 키인지가 비용과 기능을 가른다.
    activity.set({ runtime: picked.short.split(" · ")[0] ?? picked.provider.id });

  /*
   * 실행자는 두 가지로 온다.
   *   agentName  — agents/<이름>.md 를 읽는다 (일반 경로)
   *   agent      — 호출부가 만들어 넘긴다 (오케스트레이터 스킬처럼 대응하는 .md 가 없을 때)
   */
  if (!preset && !agentName) throw new Error("agentName 또는 agent 중 하나는 필요하다");
  let agent = preset
    ?? (await loadAgent(join(AGENTS_DIR, `${agentName}.md`), { pluginRoot: REPO_ROOT, projectRoot: paths.root }));

  /*
   * 저장소가 여럿이면 위임을 연다.
   *
   * loadAgent 는 allowDelegation 을 채우지 않는다 — frontmatter 에도 없다. 그래서
   * 저장소 전체에서 이 플래그를 켜는 곳이 오케스트레이터 한 곳뿐이었고, /find 같은
   * 단일 에이전트 스킬은 서브에이전트를 못 띄웠다. 같은 질문을 플러그인에 던지면
   * 호스트가 저장소별로 하나씩 띄워 병렬로 훑는다.
   *
   * 다만 **여럿일 때만** 연다. 단일 저장소에서 위임을 열면 얻는 것 없이 시간과 비용만
   * 몇 배가 된다(실측: 단일 3분 43초 · $0.59 대 병렬 17분 11초).
   *
   * frontmatter 를 고치지 않는 이유는 그것이 플러그인과 공유하는 자산이고, 위임 여부가
   * **실행 환경의 성질**이지 역할의 성질이 아니기 때문이다.
   */
  if (multiRoot && !agent.allowDelegation) agent = { ...agent, allowDelegation: true };

  // 경로 치환 같은 내부 적응 기록은 사용자가 볼 것이 아니다.
  for (const warning of agent.warnings ?? []) debug(ui.dim(`  ! ${warning}\n`));

  const registry = createDefaultRegistry();
  const gateway = new ToolGateway(registry);
  const audit = createAuditSink(paths);
  /*
   * 취소 손잡이를 전역에 등록한다 — REPL 이 Ctrl+C / ESC 로 여기를 끊을 수 있어야 한다.
   *
   * process.on("SIGINT") 만으로는 REPL 안에서 아무 일도 일어나지 않는다. readline 이
   * TTY 에서 Ctrl+C 을 가로채 자기 close() 로 처리하고 프로세스 시그널을 올리지 않기
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
      roots: discovery.roots,
    });
    const ageNote = indexAgeNote(paths);
    agent = {
      ...agent,
      systemPrompt: [agent.systemPrompt, "", projectContext, ...(ageNote ? [ageNote] : [])].join("\n"),
    };
  }

  const allowed = registry.definitionsFor(agent.role).map((d) => d.name);
  debug(ui.dim(`  provider=${picked.note}\n`));

  /*
   * 세션 선택을 여기서 한 번에 얽는다.
   * 모드는 역할·지침을 고치고, 모델은 frontmatter 선언을 덮어쓴다.
   */
  agent = applyMode(agent, sessionMode());
  const chosenModel = sessionModel();
  if (chosenModel) agent = { ...agent, tier: chosenModel };

  debug(ui.dim(`  agent=${agent.name} tier=${agent.tier} tools=${allowed.join(",")}\n`));

  /*
   * 출력과 상태 표시.
   *
   * 상태 표시는 한 줄 제자리 갱신이라, 무언가를 찍기 전에 그 줄을 지우고 찍은 뒤 되살린다.
   * 스트리밍 텍스트는 줄 단위로 모아 내보낸다 — 토큰마다 화면을 건드리면 깜빡인다.
   */
  /** 결과를 기다리는 호출들. @type {Map<string, { tool: string, input: unknown, parentId?: string }>} */
  const pending = new Map();

  /**
   * 지금 도는 서브에이전트들.
   *
   * produced/lastAt 을 함께 든다 — **끝났는지는 알 수 없지만 무엇을 냈는지는 안다.**
   * 비동기로 뜬 에이전트는 완료를 알리는 이벤트가 없다. 우리가 받는 것은 그 에이전트에
   * 귀속된 글과 도구 호출뿐이다. 그래서 끝났다/못 끝났다를 단정하지 않고 관측한 것만 적는다.
   *
   * @type {Map<string, { label: string, startedAt: number, tools: number, produced: number, lastAt: number, tail: string[], async?: boolean }>}
   */
  const subagents = new Map();

  /*
   * 제자리 갱신을 쓸 수 있는 실행인가.
   *
   * 판이 없는 곳(파이프·백그라운드 작업)에서는 블록을 그릴 자리가 없다. 그때는
   * 예전처럼 전부 기록으로 흘려보낸다 — 안 그러면 아무것도 안 보인다.
   */
  const liveUi = !background && Boolean(process.stdout.isTTY);

  /** 꼬리로 들고 있을 줄 수. 판이 보여 주는 것보다 조금 넉넉히 둔다. */
  const TAIL_KEEP = 6;

  /**
   * 열린 블록을 판에 반영한다.
   *
   * 화면 바닥은 우리가 소유하고 매 프레임 다시 그린다. 그래서 **도는 동안의 잡음은
   * 거기에 두고, 끝나면 한 줄 요약만 기록으로 올린다.** 지나간 줄을 되돌릴 수 없다는
   * 제약은 그대로지만, 아직 안 지나간 줄은 얼마든지 고쳐 그릴 수 있다.
   */
  /**
   * 살아 있는 블록에 한 줄 얹는다. 앞쪽은 버린다 — 지금 무엇을 하는지가 중요하다.
   * @param {string} key
   * @param {string} line
   */
  const pushTail = (key, line) => {
    const who = subagents.get(key);
    if (!who) return;
    who.tail.push(line);
    if (who.tail.length > TAIL_KEEP) who.tail.splice(0, who.tail.length - TAIL_KEEP);
    who.produced += 1;
    who.lastAt = Date.now();
  };

  const pushBlocks = () => {
    activity.set({
      blocks: [...subagents.values()].map((b) => ({
        label: b.label, tools: b.tools, startedAt: b.startedAt, tail: b.tail,
      })),
    });
  };

  /**
   * 판 오른쪽에 지금 도는 서브에이전트를 알린다.
   *
   * 여럿이 동시에 돈다 — 실측으로 두 개가 한 턴에 같이 떴다. 마지막 것만 보여 주면
   * 나머지가 도는지 멈춼는지 알 수 없으므로 개수를 함께 적는다.
   */
  const showRunning = () => {
    const names = [...subagents.values()].map((s) => s.label);
    if (!names.length) return activity.set({ subagent: "" });
    activity.set({ subagent: names.length === 1 ? String(names[0]) : `${names[0]} 외 ${names.length - 1}` });
  };

  /**
   * 아직 열려 있는 서브에이전트 블록을 닫는다.
   * @param {string} key
   */
  /**
   * 서브에이전트 블록을 닫는다.
   *
   * `finished` 를 구분하는 이유 — 턴이 끝날 때 아직 열려 있는 블록도 닫아야 화면이
   * 정리되는데, 예전에는 그때도 "끝남"이라고 찍었다. 그건 거짓말이었다. 실측으로
   * 화면에는 `B-A · analyzer 끝남` 이 찍혔는데 바로 아래 모델이 "백그라운드에서
   * 돌고 있다"고 말했다. 사용자는 끝난 줄 알고 결과를 찾는다.
   *
   * @param {string} key
   * @param {boolean} finished  실제로 결과를 받고 끝났는가
   */
  const closeSubagent = (key, finished) => {
    const done = subagents.get(key);
    if (!done) return;
    // 서브에이전트가 마지막에 한 말을 먼저 비운다. 닫는 줄 뒤에 나오면 블록 밖으로 샌다.
    flushText(key);
    subagents.delete(key);
    showRunning();
    pushBlocks();
    recordAgentEnd(turn, key, done.tools);
    const took = elapsed(Date.now() - done.startedAt);
    /*
     * 세 가지를 구분한다.
     *
     *   finished       결과를 담은 도구 응답을 받았다 — 확실히 끝났다.
     *   produced > 0   글이나 도구 호출을 냈다. 끝났는지는 모르지만 일은 했다.
     *   produced = 0   한 마디도 못 받았다. 이건 문제다.
     *
     * 가운데를 "끝남"이라 부르면 거짓이고, "결과를 못 받았다"고 불러도 거짓이다.
     * 실측으로 둘 다 겪었다 — 21건이 정상 완료됐는데 전부 "못 받았다"로 찍혔다.
     * 그래서 단정하지 않고 관측한 것만 적는다.
     */
    if (finished) {
      emit(`  ${ui.dim("⎿")} ${ui.dim(`${done.label} 끝남 · 도구 ${done.tools}회 · ${took}`)}`, key);
    } else if (done.produced > 0) {
      const idle = elapsed(Date.now() - done.lastAt);
      emit(`  ${ui.dim("⎿")} ${ui.dim(`${done.label} · 도구 ${done.tools}회 · 마지막 출력 ${idle} 전`)}`, key);
    } else {
      emit(
        `  ${ui.dim("⎿")} ${ui.yellow(`${done.label} — 출력 없이 턴이 끝났습니다`)} ${ui.dim(`· ${took}`)}`,
        key,
      );
    }
  };
  const NEWLINE = String.fromCharCode(10);

  /*
   * 이 턴의 기록.
   *
   * 화면이 흘러가 버리면 되짚을 수 없어서 남긴다 — 서브에이전트 블록은 특히 그렇다.
   * 백그라운드 작업은 화면에 안 찍고 여기에만 담긴다.
   */
  const turn = openTurn({ title: title ?? String(prompt.split(NEWLINE)[0] ?? ""), background });

  /**
   * 한 줄 내보낸다.
   *
   * **찍는 것과 남기는 것을 한 자리에서** 한다. 두 곳으로 나누면 한쪽만 고쳐져
   * 화면과 기록이 갈라지고, 그러면 되짚기가 "봤던 것"을 못 보여 준다.
   *
   * @param {string} text
   * @param {string} [owner]  서브에이전트가 낸 줄이면 그 Task 호출 id
   */
  const emit = (text, owner) => {
    recordLine(turn, text, owner);
    if (background) return;
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

  /** 답변의 마크다운을 터미널 서식으로. 울타리가 줄을 넘어 이어지므로 한 개를 계속 쓴다. */
  const markdown = createMarkdown({ ui, width: (process.stdout.columns ?? 100) - 2 });

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
    if (parentId) {
      const who = subagents.get(parentId);
      if (who) {
        who.produced += 1;
        who.lastAt = Date.now();
      }
      /*
       * **한 줄은 한 줄로 끝낸다.**
       *
       * 서브에이전트가 내놓는 문단은 길다 — 실측으로 174칸짜리 한 줄이 폭 120 터미널에서
       * 두 줄로 접혔다. 에이전트 스물 몇이 동시에 말하면 접힌 줄들이 서로 엉켜 누가 한
       * 말인지 사라진다. 잘라서라도 한 줄에 두면 `│` 세로줄이 일정하게 서서 읽힌다.
       * 전문은 어차피 기록에 남고 /log 로 펼쳐 볼 수 있다.
       */
      const room = Math.max(20, (process.stdout.columns ?? 100) - 6);
      const clipped = visibleLength(line) > room ? `${clipToWidth(line, room - 1)}…` : line;
      /*
       * 살아 있는 화면에서는 **기록에 남기지 않는다.**
       *
       * 서브에이전트의 중간 서술은 도는 동안에만 쓸모가 있다. 스물 몇이 동시에 말하면
       * 그게 그대로 스크롤백이 되어 정작 결론을 밀어낸다(실측). 판에 보여 주고,
       * 끝나면 한 줄 요약만 올린다. 전문은 기록(record)에 그대로 들어가 /log 로 본다.
       */
      recordLine(turn, `${ui.dim("│")} ${ui.dim(clipped)}`, parentId);
      if (!liveUi) return emit(`${ui.dim("│")} ${ui.dim(clipped)}`, parentId);
      pushTail(parentId, clipped);
      pushBlocks();
      return;
    }
    /*
     * 본문은 마크다운으로 온다. 그대로 흘리면 `**강조**` 가 기호째 보인다(실측).
     * 두 칸 들여쓰는 것은 도구 기록(● 줄)과 말을 가르기 위해서다.
     */
    // 표는 모았다 한꺼번에 나오므로 한 줄이 여러 줄이 될 수 있고, 빈 배열일 수도 있다.
    for (const out of markdown.line(line)) emit(out ? `  ${out}` : "");
  };

  /** @param {string} [parentId] 주면 그 버퍼만, 안 주면 전부 비운다. */
  const flushText = (parentId) => {
    for (const [key, buf] of buffers) {
      if (parentId !== undefined && key !== parentId) continue;
      if (buf) writeText(buf, key || undefined);
      buffers.set(key, "");
    }
    // 답이 표로 끝나는 경우가 흔하다. 모아 둔 표를 흘리지 않는다.
    for (const out of markdown.flush()) emit(out ? `  ${out}` : "");
  };

  /** 이번 턴에서 사용자가 본 답. 세션에 쌓아 두면 다음에 이어 열 때 되살릴 수 있다. */
  let answer = "";

  const startedAt = Date.now();
  let failed = false;
  let toolErrors = 0;
  /** @type {{ input: number, output: number, cacheRead: number, costUsd: number | null }} */
  const totals = { input: 0, output: 0, cacheRead: 0, costUsd: null };

  activity.start(agent.name);
  /*
   * 무엇으로 도는지를 판에 밝힌다.
   * 이게 없으면 모델을 바꿔 놓고도 지금 어느 것으로 도는지 확인할 길이 없다.
   */
  activity.set({ model: agent.tier });
  // 턴 중에 Shift+Tab 을 누르면 판이 바로 바뀝다.
  setPanelModeSink((label) => activity.set({ mode: label }));
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
          subagents.set(id, { label, startedAt: Date.now(), tools: 0, produced: 0, lastAt: Date.now(), tail: [] });
          activity.set({ tool: "" });
          showRunning();
          pushBlocks();
          recordAgentStart(turn, id, label);
          emit(`${ui.cyan("●")} ${ui.bold(`Task(${label})`)}`, id);
          continue;
        }

        const parent = event.parentId ? subagents.get(event.parentId) : undefined;
        if (parent) {
          parent.tools += 1;
          parent.produced += 1;
          parent.lastAt = Date.now();
        }
        activity.set({ tool });
        showRunning();
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

        const done = key === undefined ? undefined : subagents.get(key);
        if (done && key !== undefined) {
          /*
           * 비동기로 뜬 서브에이전트는 **결과가 곧바로 온다.**
           *
           *   [result] Async agent launched successfully. … agentId: …
           *
           * 이건 "끝났다"가 아니라 "띄웠다"다. 이걸 종료로 읽고 블록을 닫으면, 잠시 뒤
           * 실제로 오는 서브에이전트의 말이 닫힌 블록 밖으로 떨어져 누가 한 말인지
           * 사라진다(실측: 두 에이전트가 동시에 돌 때 둘 다 그랬다).
           * 그래서 열어 둔 채 표시만 바꾸고, 닫는 것은 턴이 끝날 때 한다.
           *
           * 본문은 찍지 않는다 — claude 가 내부 메타데이터라고 명시한 내용이다.
           */
          if (/Async agent launched/i.test(String(event.result ?? ""))) {
            done.async = true;
            emit(`  ${ui.dim("⎿")} ${ui.dim("백그라운드에서 실행 중")}`, key);
            continue;
          }
          // 동기로 끝난 경우 — 무엇을 얼마나 했는지 한 줄로 닫는다.
          closeSubagent(key, true);
          if (event.isError) toolErrors += 1;
          continue;
        }

        const call = key === undefined ? undefined : pending.get(key);
        if (key !== undefined) pending.delete(key);
        /*
         * 접힌 결과의 전문을 들고 있는다 — Ctrl+O 로 풀어 볼 수 있게.
         * 없으면 나머지를 보려고 도구를 다시 돌려야 하고, 그건 돈이 드는 일이다.
         */
        const full = event.result ?? "";
        if (full.split(NEWLINE).length > 4) {
          rememberFolded(`${call?.tool ?? toolLabel(event.tool ?? "")}`, full);
        }
        const owner = call?.parentId ?? event.parentId;
        const toolFor = call?.tool ?? toolLabel(event.tool ?? "");
        const block = renderCall({
          tool: toolFor,
          input: call?.input,
          result: event.result ?? "",
          isError: event.isError === true,
          root: paths.root,
          depth: owner ? 1 : 0,
          width: process.stdout.columns ?? 100,
          ui,
        }).join("\n");
        /*
         * 서브에이전트가 부른 도구도 판에 둔다.
         *
         * 스물 몇이 동시에 도구를 굴리면 그 호출들이 그대로 스크롤백이 된다 —
         * 도는 동안만 보이면 되는 것들이다. 기록에는 남으니 /log 로 되짚을 수 있다.
         */
        if (owner && liveUi && subagents.has(owner)) {
          recordLine(turn, block, owner);
          pushTail(owner, headline(toolFor, call?.input, { root: paths.root }));
          pushBlocks();
        } else {
          emit(block, owner);
        }
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
        activity.set({
          contextTokens: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens,
        });
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
        // 모델을 못 쓰는 환경이면 무엇을 설정하면 되는지까지 알려 준다. 오류만 보면 막힌다.
        for (const line of modelUnavailableHint(event.reason ?? "") ?? []) emit(ui.dim(line));
        failed = true;
      } else if (event.type === "done") {
        /*
         * 아직 열려 있는 서브에이전트.
         *
         * 백그라운드로 뜬 것은 자기 종료 이벤트가 없어서 여기서 닫아야 화면이 정리된다.
         * 다만 **끝났다고 말하지 않는다.** 결과를 못 받은 채 턴이 끝난 것이고,
         * 그러면 사용자는 그것을 이어서 확인할 방법이 필요하다.
         */
        const open = [...subagents.keys()];
        /*
         * 경고는 **한 마디도 못 받은 것**에만 낸다.
         *
         * 예전에는 열려 있던 것 전부를 세서 알렸다. 비동기 에이전트는 완료 이벤트가
         * 없어 언제나 열린 채로 끝나므로, 정상 완료한 21건이 전부 경고로 찍혔다(실측).
         * 경고가 늘 뜨면 경고가 아니다.
         */
        const silent = open.filter((k) => (subagents.get(k)?.produced ?? 0) === 0);
        /*
         * 많으면 한 줄로 갈무리한다.
         *
         * 비동기 에이전트는 완료 이벤트가 없어 전부 여기서 닫힌다. 스물 몇 개가 열려
         * 있으면 닫는 줄만 스물 몇 줄이 한꺼번에 쏟아져, 정작 마지막에 읽어야 할
         * 요약을 밀어낸다(실측). 몇 개까지는 하나씩 적고, 그보다 많으면 세어서 적는다.
         */
        const ROSTER_MAX = 6;
        if (open.length > ROSTER_MAX) {
          for (const key of open) {
            const who = subagents.get(key);
            if (who) recordAgentEnd(turn, key, who.tools);
            flushText(key);
            subagents.delete(key);
          }
          showRunning();
          const worked = open.length - silent.length;
          emit(
            `  ${ui.dim("⎿")} ${ui.dim(`서브에이전트 ${open.length}건 — 출력 받음 ${worked}`)}` +
              (silent.length ? ui.yellow(` · 출력 없음 ${silent.length}`) : "") +
              ui.dim(` · 자세히는 /log`),
          );
        } else {
          for (const key of open) closeSubagent(key, false);
        }
        if (silent.length) {
          emit(
            ui.yellow(`  서브에이전트 ${silent.length}건이 아무 출력 없이 턴이 끝났습니다.`) +
              ui.dim(` 이어서 물어보시면 그 결과를 받아 계속합니다 — /log 로 지금까지 낸 말을 볼 수 있습니다.`),
          );
        }
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
    // 기록을 닫아 둔다 — 안 닫으면 되짚기 화면에서 영영 "도는 중"으로 보인다.
    closeTurn(turn, toolErrors > 0 ? "failed" : "done");
    clearInterval(queueWatch);
    activity.stop();
    process.off("SIGINT", onSigint);
    setPanelModeSink(null);
    endTurn(controller);
    /*
     * 답이 약속한 산출물이 실제로 쓰였는지 본다.
     *
     * 실측: 서브에이전트가 "전체 상세: <server>/_workspace/reports/found_video-subtitle.md"
     * 라고 끝냈는데 그 파일을 쓰지 않았다. 앞선 실행이 남긴 같은 이름의 파일을 읽고
     * "확인했다"로 갈음한 것이다. 사용자는 새 리포트인 줄 알고 옛 내용을 본다.
     */
    const claimRoots = discovery.roots.map((r) => r.paths.root).concat(paths.root);
    const promised = unwrittenClaims(answer, claimRoots, startedAt);
    if (promised.length) {
      emit(
        ui.yellow(`  약속한 산출물 ${promised.length}건이 이번 실행에서 쓰이지 않았습니다.`) +
          ui.dim(` ${promised.join(", ")}`),
      );
    }
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
