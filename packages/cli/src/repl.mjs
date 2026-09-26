/*
 * 대화형 모드.
 *
 * 자연어가 기본이고 슬래시 명령은 명시적 경로다 — 브리프 §5의 구조 그대로다.
 * 라우팅은 아직 규칙 기반이다. 의도 분류를 LLM에 맡기면 질문 한 번마다 호출이
 * 하나 더 붙는데, MVP에서 그 비용을 정당화할 근거가 없다.
 */
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { indexStaleness } from "../../indexer/index.mjs";
import {
  latestSession,
  listSessions,
  loadAllAgents,
  loadAllSkills,
  appendMessage,
  loadSession,
  newSessionId,
  saveSession,
  toTitle,
} from "../../core/src/index.mjs";
import { AGENTS_DIR, REPO_ROOT, SKILLS_DIR, createHostElicitor, interruptTurn, setPanelMode, takeFolded, sessionMode, sessionModel, setLineReader, setSessionMode, setSessionModel, setTypingProbe, ui } from "./runtime.mjs";
import { block, readStack, renderBanner, row } from "./banner.mjs";
import { buildCommands, firstSentence, menuItems, renderCommandMenu } from "./completion.mjs";
import { clipToWidth, visibleLength } from "./width.mjs";
import { attachAutocomplete } from "./autocomplete.mjs";
import { selectProvider } from "./provider.mjs";
import { executeAgent } from "./execute.mjs";
import { cmdIndex, runSkill } from "./commands.mjs";
import { discoverRoots } from "../../core/src/index.mjs";
import { allTasks, runningCount, startTask, stopAllTasks, stopTask } from "./tasks.mjs";
import { openViewer } from "./viewer.mjs";
import { elapsed } from "./activity.mjs";
import { checkForUpdate } from "./upgrade.mjs";
import { renderStatus } from "./status.mjs";
import { estimateTokens } from "../../core/src/index.mjs";
import { createNaviPersona } from "./persona.mjs";
import { createTypeahead } from "./typeahead.mjs";
import { createLineBurst } from "./line-burst.mjs";
import { renderReplay, replayFrame } from "./replay.mjs";
import { claudeTranscriptPath, renderClaudeSession } from "./session-replay.mjs";
import { DEFAULT_MODE, MODES, modeOf, nextMode } from "./mode.mjs";

const NL = String.fromCharCode(10);

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
  const navi = createNaviPersona({ agents, skills, pluginRoot: REPO_ROOT });

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

  /*
   * 프롬프트는 **readline 이 소유해야** 한다.
   *
   * 예전엔 process.stdout.write(PROMPT) 로 직접 찍었는데, 그러면 readline 은 그 존재를
   * 모른다. rl.getCursorPos() 가 프롬프트 10칸을 빼고 돌려주므로, 자동완성이 그 값으로
   * 커서를 되돌리면 프롬프트 안쪽으로 들어가 덮어쓴다 — 실측으로 `AX-NAVI > ` 에
   * /find 를 치면 `AX-find> /` 가 되고, 지우면 `>` 만 남았다.
   */
  /*
   * 프롬프트에 모드를 달아 둔다. 바꿈 때 한 번 알리고 말면 몇 턴 뒤에 잊어버린다 —
   * 읽기 전용인 줄 모르고 수정을 시키면 무엇도 안 된 이유를 모른다.
   */
  const applyPrompt = () => {
    const mode = modeOf(sessionMode());
    const head = mode.id === DEFAULT_MODE
      ? ui.cyan("AX-NAVI")
      : `${ui.cyan("AX-NAVI")} ${ui.yellow(`(${mode.label})`)}`;
    /*
     * 백그라운드로 도는 작업 수를 프롬프트에 단다.
     *
     * 화면에 안 찍기로 했으니 이 표시가 유일한 단서다. 없으면 띄워 놓고 잊어버리고,
     * 끝났는지 물어볼 자리도 없다.
     */
    const bg = runningCount();
    rl.setPrompt(`${head}${bg ? ` ${ui.dim(`[⠿ ${bg}]`)}` : ""} ${ui.dim(">")} `);
  };
  applyPrompt();

  /*
   * 새 판이 나왔는지 본다.
   *
   * 플러그인은 마켓플레이스가 갱신해 줬지만 npm 전역 설치는 아무도 안 알려 준다 —
   * 그러면 몇 달 전 판을 계속 쓰면서 이미 고친 버그를 다시 겪는다.
   * 시작을 막지 않는다. 늦게 오면 그때 한 줄 끼워 넣고 프롬프트를 다시 그린다.
   */
  checkForUpdate(version, (latest) => {
    process.stdout.write(
      `${NL}  ${ui.yellow("새 판")} ${ui.dim(`${version} → ${latest} · axnavi upgrade`)}${NL}`,
    );
    rl.prompt(true);
  });

  /**
   * 이어서 열 때 지난 대화를 되살린다.
   *
   * 이게 없으면 "이어서 시작 · 2턴" 한 줄만 뜨고 화면은 비어 있다.
   * 무엇을 이어가는지 알 수 없으니 결국 앞 질문을 다시 쓰게 된다.
   * @param {import("@ax-navi/core").SessionRecord} record
   * @returns {boolean} 실제로 보여 준 것이 있는지
   */
  const showReplay = (record) => {
    /*
     * Claude 가 남긴 전체 기록이 있으면 그것을 그린다 — 도구 호출까지 Claude Code /resume 과 같게.
     * 없으면(API 키 경로 등) 우리가 쌓은 질문·답 글자로 대신한다.
     */
    const sessionId = record.conversation?.providerSessionId;
    const full = sessionId
      ? renderClaudeSession({ path: claudeTranscriptPath(record.root ?? paths.root, sessionId), root: record.root ?? paths.root, width: process.stdout.columns ?? 100, ui })
      : null;
    if (full && full.length) {
      const { head, tail } = replayFrame({ title: record.title ?? "", turns: record.turns, width: process.stdout.columns ?? 100, ui });
      process.stdout.write([""].concat(head, full, tail, "").join(NL) + NL);
      return true;
    }
    const messages = record.messages ?? [];
    if (!messages.length) {
      /*
       * 되살릴 게 없는 것과 고장난 것은 화면에서 같아 보인다. 이유를 밝힌다.
       * 기록을 쌓기 시작하기 전에 만든 세션은 상태만 남아 있다 —
       * 대화 자체는 Provider 쪽에 남아 있어 **이어지긴 한다**. 그 둘을 같이 말해야
       * 사용자가 쓸데없이 앞 질문을 다시 쓰지 않는다.
       */
      process.stdout.write(
        `  ${ui.dim("지난 내용을 되살리지 못합니다 — 기록을 남기기 전에 만든 대화입니다. 대화는 그대로 이어집니다.")}${NL}`,
      );
      return false;
    }
    const width = process.stdout.columns ?? 100;
    const { head, tail } = replayFrame({ title: record.title ?? "", turns: record.turns, width, ui });
    const body = renderReplay({ messages, width, ui });
    process.stdout.write([""].concat(head, body, tail, "").join(NL) + NL);
    return true;
  };

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

  /**
   * 들어온 한 줄을 기다리는 쪽에 준다.
   * readline 이 읽은 것과 턴 중에 우리가 직접 받은 것이 같은 길로 들어와야 한다.
   * @param {string} raw
   */
  const deliver = (raw) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(raw);
    } else {
      queued.push(raw);
    }
  };

  // 붙여넣은 여러 줄은 한 메시지다(line-burst.mjs). 파이프 입력은 줄마다 명령이라 합치지 않는다.
  const burst = createLineBurst(deliver, { enabled: Boolean(process.stdin.isTTY) });
  rl.on("line", (line) => burst.push(line));
  rl.on("close", () => {
    burst.flush();
    closed = true;
    waiter?.(null);
    waiter = null;
  });

  /** 이 대화에 쓴 누적 비용. */
  /** 인격이 부르기로 한 스킬. 턴이 끝나면 이어서 실행한다. @type {{ name: string, request: string } | null} */
  let pendingSkill = null;

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
   * 작업 중에 뜨는 질문(AskUserQuestion)도 이 큐로 읽는다.
   *
   * 여기서 readline 을 따로 열면 두 인터페이스가 stdin 을 두고 경쟁해서, 질문은
   * 화면에 떠 있는데 무엇을 눌러도 이 큐로 흘러들어가 선택이 되지 않는다(실측).
   * 질문을 기다리는 동안 메인 루프는 executeAgent 를 await 중이라 큐는 비어 있다.
   */
  setLineReader(nextLine);

  /*
   * 중단 — Ctrl+C 또는 ESC.
   *
   * 예전엔 execute.mjs 가 process.on("SIGINT") 만 걸었는데, REPL 안에서는 그게
   * 전혀 불리지 않는다. TTY 에서 readline 이 Ctrl+C 바이트를 먼저 가로채서
   * 자기 close() 로 처리하고 프로세스 시그널을 올리지 않기 때문이다. 그래서
   * 중단을 눌러도 도는 턴이 끝까지 갔다(실측). 여기서 직접 받아 끊는다.
   */
  let exitArmed = false;

  /*
   * 모드 돌리기.
   *
   * 프롬프트에서도, 턴이 도는 중에도 동작해야 한다. 턴 중에는 readline 을 물러나게
   * 하고 키를 직접 받는데, 그때 Shift+Tab 을 그냥 버렸다(실측: 안 먹힌다).
   * 도는 턴에는 적용되지 않지만 다음 턴부터 바뀜다 — 그 사실은 판이 보여 준다.
   */
  const cycleMode = () => {
    setSessionMode(nextMode(sessionMode()));
    return modeOf(sessionMode());
  };

  /** @param {"Ctrl+C" | "ESC"} how */
  const interrupt = (how) => {
    if (!interruptTurn()) return false;
    /*
     * 질문을 기다리던 중이었다면 그 약속도 풀어 준다.
     * 안 그러면 elicitor 가 영원히 기다려 턴이 끝나지 않는다.
     */
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
    process.stdout.write(`\n${ui.yellow(`  ⛔ 중단 (${how})`)}\n`);
    return true;
  };

  /*
   * 턴이 도는 동안 readline 을 물러나게 하고 키를 직접 받는다.
   *
   * 안 그러면 방향키가 난장판을 만든다 — 위·아래는 히스토리를 불러내 프롬프트를
   * 다시 그리고(실측: `> /harness-init` 이 누를 때마다 쌏아졌다), 좌·우도 입력 줄을
   * 다시 그린다. 그 자리엔 이미 스트리밍 출력이 흐르고 있으니 섞여 버린다.
   *
   * 대신 치는 글을 상태 표시 줄에 보여 준다 — 그 줄은 우리가 온전히 통제하는 한 줄이라
   * 다툴 커서가 없다.
   */
  /** @type {{ text: () => string } | null} 턴 중에만 산다. */
  let reader = null;
  setTypingProbe(() => ({ text: reader?.text() ?? "", queued: queued.length }));

  /** @returns {() => void} 되돌리는 함수 */
  const captureKeys = () => {
    if (!process.stdin.isTTY) return () => {};
    const typeahead = createTypeahead({ onLine: (line) => burst.push(line), onInterrupt: interrupt });
    reader = typeahead;

    const saved = /** @type {Function[]} */ (process.stdin.listeners("keypress"));
    for (const fn of saved) process.stdin.off("keypress", /** @type {any} */ (fn));
    /**
     * @param {string | undefined} ch
     * @param {{ name?: string, ctrl?: boolean, meta?: boolean } | undefined} key
     */
    const onKey = (/** @type {string | undefined} */ ch, /** @type {any} */ key) => {
      // 도는 중에도 모드를 바꿀 수 있어야 한다. 적용은 다음 턴부터다.
      // 턴 중에도 동일하게 — 치던 글이 없을 때만 받는다.
      if (key?.name === "tab" && (key.shift || !typeahead.text())) {
        setPanelMode(cycleMode().label);
        return;
      }
      typeahead.handle(ch, key);
    };
    process.stdin.on("keypress", onKey);

    return () => {
      process.stdin.off("keypress", onKey);
      for (const fn of saved) process.stdin.on("keypress", /** @type {any} */ (fn));
      reader = null;
      // 끝날 때 치던 중이었다면 버리지 않고 프롬프트에 돌려준다.
      const leftover = typeahead.take();
      if (leftover) rl.write(leftover);
    };
  };

  rl.on("SIGINT", () => {
    if (interrupt("Ctrl+C")) return;
    // 도는 게 없을 때 — 친 줄이 있으면 지우고, 빈 줄에서 두 번이면 나간다.
    if (rl.line) {
      rl.write(null, { ctrl: true, name: "u" });
      exitArmed = false;
      return;
    }
    if (exitArmed) {
      rl.close();
      return;
    }
    exitArmed = true;
    process.stdout.write(`\n${ui.dim("  한 번 더 Ctrl+C 를 누르면 나간다 (또는 /exit)")}\n`);
    rl.prompt();
  });

  /*
   * ESC 는 keypress 로만 온다 — 줄이 아니라 line 이벤트가 안 난다.
   * 도는 턴이 없을 때는 건드리지 않는다 — 자동완성 메뉴가 ESC 를 쓰기 때문이다.
   */
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (/** @type {string} */ _ch, /** @type {{ name?: string, shift?: boolean, ctrl?: boolean }} */ key) => {
      if (key?.name === "escape") return interrupt("ESC");
      /*
       * Shift+Tab 으로 모드를 돌린다.
       * 자동완성 메뉴가 떠 있을 때는 그쪽이 Tab 을 쓴다 — 둠 다 가져가면 후보 이동과
       * 모드 변경이 동시에 일어난다.
       */
      /*
       * Ctrl+O — 방금 접은 결과를 펼쳐 보인다.
       *
       * Claude Code 처럼 그 자리에서 펼치지는 못한다 — 기록을 흘려보내는 구조라
       * 지나간 줄을 다시 그릴 수 없다. 대신 아래에 덧붙인다.
       */
      if (key?.ctrl && key.name === "o") {
        const item = takeFolded();
        if (!item) {
          process.stdout.write(`${NL}  ${ui.dim("펼쳐 볼 것이 없다.")}${NL}`);
        } else {
          const body = item.text.split(NL).map((l) => `  ${ui.dim(l)}`).join(NL);
          process.stdout.write(`${NL}  ${ui.cyan("⎿")} ${ui.bold(item.label)} ${ui.dim("전문")}${NL}${body}${NL}`);
        }
        rl.prompt();
        return;
      }

      /*
       * 모드 돌리기 — Shift+Tab, 그리고 빈 줄에서의 Tab.
       *
       * Windows 콘솔은 Shift+Tab 을 그냥 ^I 로 보낸다(실측: axnavi keys 에서
       * `tab 바이트: ^I`, shift 표시 없음). 그러면 우리쪽에서 둘을 가를 수가 없다.
       *
       * 그래서 빈 줄의 Tab 도 받는다. 거기서 Tab 은 원래 하는 일이 없고(메뉴가
       * 떠 있을 때만 후보 이동에 쓰인다), 친 글이 있으면 건드리지 않으므로
       * 놓칠 입력도 없다.
       */
      if (key?.name === "tab" && !menu?.isOpen() && (key.shift || !rl.line)) {
        cycleMode();
        applyPrompt();
        /*
         * 같은 자리에서 다시 그린다. 예전에는 안내 한 줄을 찍고 새 줄에 프롬프트를 그려서
         * 누를 때마다 두 줄씩 쌓였다(실측). prompt(true) 는 친 글과 커서를 그대로 두고
         * 프롬프트 줄만 다시 그린다 — 입력이 여러 줄로 접혀 있어도 그 줄들을 지우고 다시 쓴다.
         * 모드 이름은 프롬프트의 (계획)·(빠름) 표시로 보이고, 설명은 /mode 가 보여 준다.
         */
        rl.prompt(true);
      }
    });
  }

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
  /**
   * @typedef {object} Thread
   * @property {string} id
   * @property {string} agent
   * @property {number} turns
   * @property {string} [title]
   * @property {string} [createdAt]
   * @property {import("@ax-navi/core").Conversation} conversation
   * @property {import("@ax-navi/core").SessionMessage[]} [messages]  이어서 열 때 되살릴 대화
   */
  /** @type {Thread | null} */
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
        messages: record.messages ?? [],
      };
      // 되살렸으면 프레임 머리말이 이미 같은 걸 말한다. 두 번 적지 않는다.
      if (!showReplay(record)) {
        process.stdout.write(
          `  ${ui.green("이어서 시작")}  ${ui.dim(`${record.agent} · ${record.turns}턴 · ${record.title}`)}\n\n`,
        );
      }
    } else {
      process.stdout.write(`  ${ui.yellow("이어갈 세션이 없습니다")} ${ui.dim("— 새 대화로 시작한다.")}\n\n`);
    }
  }

  /** @param {string} agentName @param {string} firstLine @returns {Thread} */
  const threadFor = (agentName, firstLine) => {
    /*
     * 역할이 바뀌어도 **대화는 끊지 않는다.**
     *
     * 예전에는 라우팅된 역할이 달라지면 대화를 새로 열었다. 그런데 사용자에게는
     * "수강승인 로직 찾아줘"(feature-finder) 다음의 "계속 해줘"(axnavi) 가 한 흐름이다.
     * 역할이 다르다고 끊으면 뒤 턴에 앞의 일이 통째로 없다 — 실측으로 "이전 대화 맥락이
     * 없어서 계속이 어떤 작업을 가리키는지 확인이 필요합니다" 가 나왔다.
     *
     * 위임 경로에서 대화를 들고 있는 것은 claude 세션이고, 역할은 매 턴 지침으로
     * 다시 얹힌다. 그래서 역할이 달라져도 같은 세션에 이어 붙이는 데 문제가 없다.
     * 일부러 끊고 싶으면 /new 가 있다.
     */
    if (thread && thread.agent !== agentName) thread.agent = agentName;
    if (!thread) {
      thread = {
        id: newSessionId(),
        agent: agentName,
        turns: 0,
        conversation: { turns: [] },
        messages: [],
        title: toTitle(firstLine),
        createdAt: new Date().toISOString(),
      };
    }
    const live = /** @type {Thread} */ (thread);
    live.turns += 1;
    return live;
  };

  /**
   * 스킬 실행을 얹을 대화를 준다.
   *
   * **에이전트가 달라도 같은 대화를 쓴다.** 보통은 역할이 바뀌면 대화를 새로 여는데,
   * 스킬은 그러면 안 된다 — 사용자에게 `/find` 로 한참 조사한 것과 그다음 "계속 해줘" 는
   * 한 흐름이다. 둘로 갈라 놓으면 뒤 턴에 앞의 일이 아예 없다(실측: "이전 대화 맥락이
   * 없어서 계속이 어떤 작업을 가리키는지 확인이 필요합니다").
   *
   * @param {string} label  대화가 없을 때 붙일 제목
   * @returns {{ conversation: import("@ax-navi/core").Conversation, onAnswer: (text: string) => void }}
   */
  const skillContext = (label) => {
    if (!thread) {
      thread = {
        id: newSessionId(),
        agent: DEFAULT_AGENT,
        turns: 0,
        conversation: { turns: [] },
        messages: [],
        title: toTitle(label),
        createdAt: new Date().toISOString(),
      };
    }
    const live = /** @type {Thread} */ (thread);
    live.turns += 1;
    return {
      conversation: live.conversation,
      onAnswer: (text) => {
        live.messages = appendMessage(appendMessage(live.messages ?? [], "user", label), "assistant", text);
      },
    };
  };

  /**
   * 백그라운드로 한 건 띄운다.
   *
   * **자기 대화를 준다.** 지금 대화에 얹으면 안 된다 — 위임 경로는 claude 세션을
   * `--resume <id>` 로 이어 붙이는데, 같은 세션에 두 턴을 동시에 태우면 둘째가
   * 낡은 바탕에서 출발하고 끝난 뒤 세션 id 를 서로 덮어써 대화가 갈라진다.
   *
   * 화면에도 안 찍는다. 전경 턴과 터미널 바닥을 두고 다투면 둘 다 못 읽는 화면이 된다.
   * 진행은 프롬프트 옆 개수로, 내용은 /log 로 본다.
   *
   * @param {string} request
   * @returns {import("./tasks.mjs").BackgroundTask}
   */
  const startBackground = (request) => {
    const agent = route(request);
    return startTask({
      title: request.length > 48 ? `${request.slice(0, 47)}…` : request,
      run: (signal) => executeAgent({
        root: paths.root,
        ...(agent === DEFAULT_AGENT ? { agent: navi } : { agentName: agent }),
        prompt: request,
        conversation: { turns: [] },
        onCost: (usd) => { sessionCost += usd; },
        background: true,
        title: request,
        signal,
      }),
      onDone: (task) => {
        /*
         * 끝났음을 그 자리에서 알린다. 프롬프트 위에 한 줄 끼워 넣고 프롬프트를 다시 그린다 —
         * 안 그리면 사용자가 치던 줄이 알림에 먹혀 어디까지 썼는지 사라진다.
         */
        const mark = task.status === "done" ? ui.green("●") : ui.red("●");
        const took = elapsed((task.endedAt ?? Date.now()) - task.startedAt);
        process.stdout.write(
          `${NL}  ${mark} ${ui.dim(`백그라운드 #${task.id} 끝남 · ${took} — /log 로 확인`)}${NL}`,
        );
        applyPrompt();
        rl.prompt(true);
      },
    });
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
        messages: thread.messages ?? [],
      });
    } catch {
      // 세션 저장 실패가 대화를 끊을 이유는 아니다.
    }
  };

  let code = 0;

  for (;;) {
    // 큐에 이미 쌓여 있으면 프롬프트를 다시 그리지 않는다 — 붙여넣기가 어지러워진다.
    if (!queued.length) rl.prompt();
    const raw = await nextLine();
    if (raw === null) break; // Ctrl+C / EOF
    const line = raw.trim();
    exitArmed = false;
    menu?.close();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    // 턴이 도는 동안에는 readline 을 물러나게 한다 — 방향키가 프롬프트를 다시 그려 화면을 어지른다.
    const release = captureKeys();
    try {
      if (line.startsWith("/")) {
        code = await handleSlash({
          paths, line, commands, skillByName,
          onReset: () => { thread = null; },
          onModeChange: applyPrompt,
          onBackground: startBackground,
          onSkillContext: skillContext,
          onResume: (record) => {
            thread = {
              id: record.id,
              agent: record.agent,
              turns: record.turns,
              title: record.title,
              createdAt: record.createdAt,
              conversation: record.conversation,
              messages: record.messages ?? [],
            };
            if (!showReplay(record)) {
              process.stdout.write(
                `  ${ui.green("이어서 시작")}  ${ui.dim(`${record.agent} · ${record.turns}턴 · ${record.title}`)}${NL}`,
              );
            }
          },
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
          /*
           * 주고받은 말을 쌓아 둔다. 위임 경로는 대화를 claude 가 들고 있어
           * conversation.turns 가 비어 있으므로, 되살릴 내용은 우리가 따로 가지고 있어야 한다.
           */
          /*
           * 자연어 요청을 스킬로 이어 준다.
           *
           * 인격은 이전에 "`/harness-init` 을 실행하세요" 라고 안내만 했다(실측).
           * 알아보는데 실행할 수단이 없어서였다. 지금은 부를 수 있고,
           * 여기서 그 요청을 받아 턴이 끝난 뒤 실행한다 — LLM 턴 안에서 또 한 번
           * 도는 것보다 확실하고, 출력도 섞이지 않는다.
           */
          onSkillRequest: (name, request) => {
            const wanted = name.replace(/^\//, "").trim();
            if (!skillByName.has(wanted)) {
              return `그런 스킬이 없다: ${wanted}. 쓸 수 있는 것: ${[...skillByName.keys()].join(", ")}`;
            }
            pendingSkill = { name: wanted, request: request || line };
            // 모델에게 주는 지시는 도구 설명에 있다. 여기서는 짧게 끝낸다 — 모델이 이걸 따라 적을 수 있다.
            return "시작한다.";
          },
          onAnswer: (text) => {
            t.messages = appendMessage(appendMessage(t.messages ?? [], "user", line), "assistant", text);
          },
          queuedCount: () => queued.length,
        });
        /*
         * 인격이 스킬을 부르기로 했으면 이어서 실행한다.
         * 사용자가 부탁한 일을 끝까지 해주는 것이 한 번의 입력에 대한 답이다.
         */
        if (pendingSkill) {
          const { name, request } = pendingSkill;
          pendingSkill = null;
          code = await runSkill(paths.root, name, request, undefined, skillContext(`/${name} ${request}`.trim()));
        }
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
    } finally {
      release();
    }
  }

  menu?.dispose();
  /*
   * 남은 백그라운드 작업을 끊는다.
   * 안 끊으면 claude 자식 프로세스가 살아 있어 CLI 가 안 끝난다 — 화면은 나갔는데
   * 셸이 안 돌아오는 상태가 된다.
   */
  const left = runningCount();
  if (left) process.stdout.write(`  ${ui.dim(`백그라운드 ${left}건을 멈춥니다.`)}${NL}`);
  stopAllTasks();
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
    /*
     * 선 자리에 인덱스가 없다고 바로 "없음"이라 하지 않는다.
     *
     * 실측: 부모 폴더에서 띄웠더니 "없음"이 떴는데 정작 인덱스는 하위 두 저장소에
     * 멀쩡히 있었다. 사용자는 그걸 모른 채 grep 으로 내려앉은 답을 받았다.
     */
    const found = discoverRoots(paths.root).roots;
    if (found.length) {
      lines.push(row("Index", `${ui.green("Ready")}  ${ui.dim(`저장소 ${found.length}개`)}`));
      for (const r of found) {
        const tag = r.hasPair ? ui.dim("  ← 페어") : "";
        lines.push(row("", `${ui.cyan(r.name)}  ${ui.dim(`${r.files.toLocaleString()} files · tier ${r.tier}`)}${tag}`));
      }
    } else {
      lines.push(row("Index", `${ui.yellow("없음")}  ${ui.dim("— /index build 로 만드세요 (LLM·API 키 불필요)")}`));
    }
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
    `  ${ui.dim("자연어로 물어보세요.")}   ${ui.cyan("/")} ${ui.dim("명령 목록")}   ${ui.dim("Tab 자동완성")}   ${ui.cyan("Shift+Tab")} ${ui.dim("모드")}   ${ui.cyan("Ctrl+O")} ${ui.dim("펼치기")}   ${ui.cyan("/exit")} ${ui.dim("종료")}`,
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
 * @param {(request: string) => import("./tasks.mjs").BackgroundTask} [args.onBackground]  백그라운드로 띄운다
 * @param {(request: string) => { conversation: import("@ax-navi/core").Conversation, onAnswer: (text: string) => void }} [args.onSkillContext]  스킬을 얹을 대화
 * @param {Map<string, { name: string }>} args.skillByName
 * @param {() => void} [args.onReset]
 * @param {(record: import("@ax-navi/core").SessionRecord) => void} [args.onResume]
 * @param {() => void} [args.onModeChange]  프롬프트를 다시 그리게 한다
 * @param {() => ({ id: string, agent: string, turns: number, sessionId?: string } | null)} [args.onContext]
 * @returns {Promise<number>}
 */
async function handleSlash({ paths, line, commands, skillByName, onReset, onResume, onModeChange, onContext, onBackground, onSkillContext }) {
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
      process.stdout.write(`  ${ui.dim("새 대화를 시작합니다.")}\n`);
      return 0;

    case "model": {
      /*
       * 세션 동안 모델을 바꾼다. frontmatter 선언을 덮어쓴는다.
       *
       * 기본은 에이전트마다 다르다 — analyzer 는 sonnet, 어떤 것은 opus 를 선언한다.
       * 그걸 한 줄로 묶어 버리지 않고 "선언대로"를 골라 둘 수 있게 둔다.
       */
      const wanted = (rest[0] ?? "").toLowerCase();
      if (wanted) {
        const pickTier = wanted === "기본" || wanted === "auto" || wanted === "default"
          ? null
          : MODEL_CHOICES.find((m) => m.id === wanted)?.tier;
        if (pickTier === undefined) {
          process.stderr.write(`  ${ui.yellow("모르는 모델입니다")} ${ui.dim(`— ${wanted} (${MODEL_CHOICES.map((m) => m.id).join(", ")}, 기본)`)}${NL}`);
          return 2;
        }
        setSessionModel(pickTier);
        process.stdout.write(`  ${ui.green("모델")} ${ui.dim(describeModel())}${NL}`);
        return 0;
      }

      const labels = [
        `기본 — 에이전트가 선언한 모델을 따릅니다`,
        ...MODEL_CHOICES.map((m) => `${m.id} — ${m.hint}`),
      ];
      const [picked] = await createHostElicitor().ask("어느 모델로 돌릴까요?", labels, {});
      if (!picked) return 0;
      const at = labels.indexOf(picked);
      setSessionModel(at <= 0 ? null : /** @type {any} */ (MODEL_CHOICES[at - 1]).tier);
      process.stdout.write(`  ${ui.green("모델")} ${ui.dim(describeModel())}${NL}`);
      return 0;
    }

    case "mode": {
      /*
       * 이름으로도 바꿀 수 있게 해 둔다.
       * Shift+Tab 은 터미널이 먼저 가로채면 Node 까지 오지 않는다 — 그럴 때
       * 모드를 바꿀 길이 아예 없어지면 계획 모드를 못 쓴다.
       */
      const wanted = (rest[0] ?? "").trim();
      if (wanted) {
        const hit = MODES.find((m) => m.id === wanted || m.label === wanted);
        if (!hit) {
          process.stderr.write(`  ${ui.yellow("모르는 모드입니다")} ${ui.dim(`— ${wanted} (${MODES.map((m) => m.label).join(", ")})`)}${NL}`);
          return 2;
        }
        setSessionMode(hit.id);
        onModeChange?.();
        process.stdout.write(`  ${ui.yellow(hit.label)}  ${ui.dim(hit.hint)}${NL}`);
        return 0;
      }

      const mode = modeOf(sessionMode());
      const lines = MODES.map((m) => `  ${m.id === mode.id ? ui.cyan("❯") : " "} ${ui.cyan(m.label.padEnd(8))} ${ui.dim(m.hint)}${m.caveat ? ui.dim(`  (${m.caveat})`) : ""}`);
      process.stdout.write(`${lines.join(NL)}${NL}  ${ui.dim("Shift+Tab 으로 돌리거나 /mode <이름> 으로 바로 지정한다.")}${NL}`);
      return 0;
    }

    case "resume": {
      /*
       * 나갔다 --resume 으로 다시 켜야 되는 걸 없앤다.
       * id 를 적어 주면 그걸 열고, 안 적으면 최근 것들을 방향키로 고르게 한다.
       */
      const wanted = rest[0];
      if (wanted) {
        const record = await loadSession(paths, wanted);
        if (!record) {
          process.stderr.write(`  ${ui.yellow("그런 세션이 없습니다")} ${ui.dim(`— ${wanted} (/sessions 로 확인)`)}${NL}`);
          return 2;
        }
        onResume?.(record);
        return 0;
      }

      const records = await listSessions(paths, 20);
      if (!records.length) {
        process.stdout.write(`  ${ui.dim("저장된 세션 없음.")}${NL}`);
        return 0;
      }
      // 어느 대화였는지는 제목으로 기억한다. id 는 곴들이라 뒤에 흐리게 둔다.
      const labels = records.map((r) => `${r.title || "(제목 없음)"}  · ${r.agent} · ${r.turns}턴 · ${r.id}`);
      const [picked] = await createHostElicitor().ask("어느 대화로 돌아갈까요?", labels, {});
      if (!picked) return 0;
      const record = records[labels.indexOf(picked)];
      if (record) onResume?.(record);
      return 0;
    }

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
      out.push(`  ${ui.dim("/resume 으로 바로 돌아간다. 밖에서는 axnavi --resume <id> · --continue 는 가장 최근 것.")}`);
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
        : ui.dim("없음 — 이번 턴이 끝나면 잡힙니다");
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

    case "bg": {
      /*
       * 백그라운드로 돌린다.
       *
       * 화면에는 찍지 않는다 — 전경 턴과 같은 터미널 바닥을 두고 다투면 둘 다 못 읽는
       * 화면이 된다. 진행은 프롬프트 옆 개수로, 내용은 /log 로 본다.
       */
      if (!argText) {
        process.stderr.write(`  ${ui.yellow("무엇을 돌릴지 적어 주세요")} ${ui.dim("— /bg 결제 모듈 전체 훑어줘")}${NL}`);
        return 2;
      }
      if (!onBackground) return 2;
      const task = onBackground(argText);
      onModeChange?.();
      process.stdout.write(
        `  ${ui.green("백그라운드")} ${ui.dim(`#${task.id} — ${task.title}`)}${NL}` +
          `  ${ui.dim("도는 동안 계속 대화하셔도 됩니다. /tasks 로 상태, /log 로 내용을 봅니다.")}${NL}`,
      );
      return 0;
    }

    case "tasks": {
      if (rest[0] === "stop") {
        const id = Number(rest[1]);
        const stopped = Number.isFinite(id) && stopTask(id);
        process.stdout.write(
          stopped
            ? `  ${ui.green("멈췄습니다")} ${ui.dim(`#${id}`)}${NL}`
            : `  ${ui.yellow("그 번호로 도는 작업이 없습니다")} ${ui.dim(`— ${rest[1] ?? ""}`)}${NL}`,
        );
        return stopped ? 0 : 2;
      }
      const list = allTasks();
      if (!list.length) {
        process.stdout.write(`  ${ui.dim("백그라운드 작업이 없습니다. /bg <요청> 으로 띄웁니다.")}${NL}`);
        return 0;
      }
      process.stdout.write("\n");
      for (const t of list) {
        const mark = t.status === "running" ? ui.yellow("◍") : t.status === "done" ? ui.green("●") : ui.red("●");
        const took = elapsed((t.endedAt ?? Date.now()) - t.startedAt);
        process.stdout.write(`  ${mark} ${ui.dim(`#${t.id}`)} ${t.title}  ${ui.dim(took)}${NL}`);
      }
      process.stdout.write(`\n  ${ui.dim("내용은 /log · 멈추려면 /tasks stop <번호>")}${NL}`);
      return 0;
    }

    case "log": {
      /*
       * 지나간 작업을 되짚는다.
       *
       * 흘러가는 기록 위에서 제자리 펼치기는 불가능하다 — 그 아래 줄을 전부 다시
       * 그려야 하는데 스크롤백은 우리 것이 아니다. 대신 딴 장(대체 화면 버퍼)을
       * 펴고, 나올 때 원래 기록을 그대로 되돌린다.
       */
      if (!process.stdout.isTTY) {
        process.stderr.write(`  ${ui.yellow("터미널에서만 쓸 수 있습니다")}${NL}`);
        return 2;
      }
      await openViewer({ input: process.stdin, output: process.stdout, ui });
      return 0;
    }

    // `/` 만 치고 엔터 — 목록을 보여 준다. "알 수 없는 명령"으로 내쫓지 않는다.
    case "":
    case "help":
      process.stdout.write(renderCommandMenu(commands, ui));
      return 0;

    /*
     * 목록에는 무엇을 하는지가 먼저 보여야 한다. 예전에는 이름 옆에 쓰는 에이전트·도구만 찍어
     * "스킬 설명이 안 되어 있다" 는 지적을 받았다. 설명 한 줄을 넣고, 에이전트는 자리가 남을 때만 흐리게 붙인다.
     */
    case "agents": {
      const agents = await loadAllAgents(AGENTS_DIR, { pluginRoot: REPO_ROOT, projectRoot: paths.root });
      const width = process.stdout.columns ?? 100;
      process.stdout.write("\n");
      for (const a of agents) {
        const summary = fitLine(firstSentence(a.description, 200), Math.max(20, width - 36));
        process.stdout.write(`  ${ui.cyan(a.name.padEnd(22))} ${ui.dim(a.tier.padEnd(9))} ${summary}\n`);
      }
      process.stdout.write("\n");
      return 0;
    }

    case "skills": {
      const skills = await loadAllSkills(SKILLS_DIR);
      const width = process.stdout.columns ?? 100;
      process.stdout.write("\n");
      for (const s of skills.filter((x) => !x.delegatesTo)) {
        const room = Math.max(20, width - 27);
        const summary = fitLine(firstSentence(s.description, 200), room);
        const left = room - visibleLength(summary) - 3;
        const agents = s.agents.length && left >= 12 ? ui.dim(` · ${clipToWidth(s.agents.join(","), left)}`) : "";
        process.stdout.write(`  ${ui.cyan(s.name.padEnd(22))} ${summary}${agents}\n`);
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
      /*
       * 스킬도 지금 대화 위에서 돈다.
       *
       * 예전에는 한 번 쓰고 버리는 실행이라, /find 로 한참 조사한 뒤 "계속 해줘" 라고 하면
       * 앞의 일이 대화에 없어서 무엇을 이어갈지 모른다고 답했다(실측). 사용자에게는
       * 한 흐름인데 우리만 둘로 갈라 놓고 있었다.
       */
      if (skillByName.has(cmd)) return runSkill(paths.root, cmd, argText, undefined, onSkillContext?.(`/${cmd} ${argText}`.trim()) ?? {});

      const near = commands
        .map((c) => c.name)
        .filter((n) => n.startsWith(cmd.slice(0, 3)))
        .slice(0, 5);
      process.stderr.write(
        `알 수 없는 명령: ${ui.cyan(`/${cmd}`)}\n` +
          (near.length ? `  ${ui.dim(`혹시: ${near.map((n) => `/${n}`).join("  ")}`)}\n` : "") +
          `  ${ui.dim("/ 를 치면 전체 목록이 나옵니다.")}\n`,
      );
      return 2;
    }
  }
}

/*
 * 골라 쓸 수 있는 모델.
 *
 * Core 는 등급(ModelTier)만 안다 — 실제 모델 id 로의 변환은 Provider 가 한다.
 * 그 경계를 여기서 깨지 않도록 이름은 보여 주되 넘기는 것은 등급이다.
 */
/** @type {ReadonlyArray<{ id: string, tier: import("@ax-navi/core").ModelTier, hint: string }>} */
const MODEL_CHOICES = [
  { id: "haiku", tier: "fast", hint: "빠르고 싸다. 간단한 조회·요약" },
  { id: "sonnet", tier: "standard", hint: "기본값. 일상 작업" },
  { id: "opus", tier: "deep", hint: "깊게 본다. 분석·설계·마이그레이션" },
];

/** @returns {string} */
/**
 * 한 줄에 맞게 자르고, 잘랐으면 … 를 붙인다. 말이 끊긴 채로 끝나면 설명이 덜 쓰인 것처럼 보인다.
 * @param {string} text
 * @param {number} max  보이는 칸 수
 */
function fitLine(text, max) {
  return visibleLength(text) <= max ? text : `${clipToWidth(text, max - 1)}…`;
}

function describeModel() {
  const tier = sessionModel();
  if (!tier) return "기본 — 에이전트 선언을 따릅니다";
  const hit = MODEL_CHOICES.find((m) => m.tier === tier);
  return `${hit?.id ?? tier} — ${hit?.hint ?? ""}`;
}
