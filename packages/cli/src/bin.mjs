#!/usr/bin/env node
/*
 * axnavi 진입점.
 *
 * 명령 하나가 곧 사용자와의 계약이므로, 알 수 없는 인자를 조용히 무시하지 않고 멈춘다.
 * 기존 agents/lib/*.mjs의 parseArgs가 하던 방식과 같다.
 */
import { readFileSync } from "node:fs";
import { inspectProject, resolveProjectPaths } from "../../core/src/index.mjs";
import { cmdAdr, cmdAgent, cmdDoc, cmdDoctor, cmdGate, cmdIndex, cmdInit, cmdMcp, cmdModernize, cmdReview, cmdTest, cmdCoverage, cmdScan, cmdSkill } from "./commands.mjs";
import { cmdKeys } from "./keys.mjs";
import { autoPullOrg, cmdOrg } from "./org.mjs";
import { executeAgent } from "./execute.mjs";
import { startRepl } from "./repl.mjs";
import { cmdUpgrade } from "./commands.mjs";
import { readVersion } from "./upgrade.mjs";
import { ui } from "./runtime.mjs";
import { renderBanner } from "./banner.mjs";

/*
 * 버전은 package.json 이 유일한 출처다.
 *
 * 소스에 적어 두었더니 npm 이 설치한 번호와 갈라졌다(실측: 배포본 0.1.0-alpha.1 인데
 * --version 은 alpha.0 을 말했다). 버그 제보를 받을 때 어느 번호인지 몰라지는 것은
 * 배포된 도구에서 치명적이다.
 */
const VERSION = readVersion();

const HELP = `${renderBanner(VERSION)}

${ui.bold("사용법")}
  axnavi                          대화형 모드
  axnavi --continue               마지막 대화를 이어서
  axnavi --resume <세션id>         특정 대화를 이어서
  axnavi ask <요청>               한 번 묻고 답받기 (읽기 전용)
  axnavi init                     .axnavi/ 설정 생성
  axnavi doctor                   실행 환경 진단
  axnavi keys                     키 진단 (Shift+Tab 이 안 먹을 때)
  axnavi upgrade [태그]           최신 판(또는 지정한 판)으로 올리기

  axnavi index build              결정론적 인덱싱 (LLM·API 키 불필요)
  axnavi index status             인덱스 신선도
  axnavi index refresh            증분 갱신
  axnavi index coverage [경로]    커버리지 진단서 (LLM 불필요, 기본 _workspace/reports/coverage.md)

  axnavi review [--diff A..B]     변경 리뷰 GO/HOLD/STOP (LLM 불필요, 종료 코드 0/3/4)
      [--staged] [--verify "<명령>"] [--tests-passed] [--format md|json] [--out <파일>]
  axnavi scan security [경로...]  저장소 보안 점검 (OWASP·CWE, LLM 불필요)
      [--format md|json] [--out <파일>] [--fail-on critical|high|medium|low]

  axnavi doc new <종류|all>       SDLC 산출물 양식 만들기 (docs/sdlc/, 인덱스로 자동 항목 채움)
      종류: project · srs · sdd · standards · quality · progress   [--force]
  axnavi doc list                 산출물 현황 (필수 절 작성·승인 상태)
  axnavi adr new "<제목>"          아키텍처 결정 기록 (docs/adr/NNNN-제목.md) [--status 제안|채택|폐기|대체됨]
  axnavi adr list                 ADR 목록
  axnavi modernize <레시피> [경로...]  현대화 레시피 — java17 · java21 · jakarta · oracle-pg (LLM 불필요, 종료 코드 0/3/4)
      [--apply] [--force] [--verify "<빌드·테스트 명령>"] [--format md|json] [--out <파일>]
  axnavi test plan --spec <명세.json> [--framework junit5|vitest]   PMS-X 구현 명세 → SR 테스트 계획
  axnavi test scaffold <SR> [--out <파일>]  테스트 골격(케이스마다 @Disabled/it.todo — 있는 파일엔 없는 케이스만)
  axnavi test status [SR] [--junit <폴더>]  테스트 결과로 진행 상태(작성 필요·실패·통과, 종료 코드 0/3/4)
  axnavi coverage [--jacoco <xml>] [--lcov <info>] [--diff A..B|--staged] [--min <%>]
                                  커버리지 — 전체와 바뀐 줄, 기준 미달이면 HOLD(3)
  axnavi gate <req|design|dev|test>  단계 게이트 GO/HOLD/STOP (LLM 불필요, 종료 코드 0/3/4)
      [--diff A..B] [--staged] [--skip-review] [--record] [--format md|json] [--out <파일>]

  axnavi mcp [list|trust|untrust]  저장소 .axnavi/mcp.json 확인·허용 (허용 전에는 쓰지 않음)
  axnavi org [pull|status]        조직 설정(플랫폼 배포본) 받기·상태 — 규칙·양식·MCP·정책, IDE 규칙·스킬
                                  (HNIX_AX_SERVER·HNIX_AX_KEY 가 있으면 시작할 때 10분 간격으로 자동)

  axnavi agent list               에이전트 목록
  axnavi agent run <이름> <요청>   에이전트 직접 실행
  axnavi skill list               스킬 목록
  axnavi skill run <이름> <요청>   스킬 실행

${ui.bold("옵션")}
  --root <경로>       프로젝트 루트 (기본: 현재 폴더)
  --index-dir <경로>  인덱스 위치 (기본: <root>/_workspace/index)
  --tier <등급>       Auto | Standard | Full
  --provider <이름>   auto | agent-sdk | claude-cli | anthropic | openai
                      auto(기본): API 키 → 구독 로그인(본인 claude) → 사내 게이트웨이 순으로
                      쓸 수 있는 것을 고른다. 요금제(Pro·Max·Team·Enterprise)는 상관없다
                      openai: AXNAVI_OPENAI_BASE_URL 의 OpenAI 호환 게이트웨이(HNIX AX·로컬 모델)
                      대화형 모드에서는 AXNAVI_PROVIDER=openai 로 고른다
${ui.bold("환경변수")}
  AXNAVI_AUTH         subscription | key | gateway — 여러 개를 가졌을 때 먼저 쓸 경로(과금 선택)
  AXNAVI_POLICY_FILE  조직 정책 파일 위치(기본: %ProgramData%\\axnavi\\policy.json, /etc/axnavi/policy.json)
  -c, --continue      마지막 대화를 이어서 시작
  --resume <id>       특정 대화를 이어서 시작 (/sessions 로 id 확인)
  --verbose           내부 진단 출력 (도구 목록·토큰 내역·감사기록 경로)
  -h, --help          도움말
  -v, --version       버전
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ root: string, indexDir?: string, tier?: string, provider?: import("./provider.mjs").ProviderName, continueLatest?: boolean, resumeId?: string, help?: boolean, version?: boolean, diff?: string, staged?: boolean, format?: string, out?: string, verify?: string, testsPassed?: boolean, failOn?: string, force?: boolean, record?: boolean, yes?: boolean, skipReview?: boolean, status?: string, apply?: boolean, spec?: string, framework?: string, junit?: string, jacoco?: string, lcov?: string, min?: number, rest: string[] }} */
  const out = { root: process.cwd(), rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i] ?? out.root;
    else if (arg === "--index-dir") out.indexDir = argv[++i];
    else if (arg === "--tier") out.tier = argv[++i];
    else if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "auto" && value !== "anthropic" && value !== "claude-cli" && value !== "agent-sdk" && value !== "openai") {
        throw new Error(`--provider 값이 올바르지 않습니다: ${value} (auto | anthropic | claude-cli | agent-sdk | openai)`);
      }
      out.provider = value;
    }
    // runtime.mjs가 process.argv에서 직접 읽는다. 여기서는 "알 수 없는 옵션"으로 막히지만 않으면 된다.
    else if (arg === "-c" || arg === "--continue") out.continueLatest = true;
    else if (arg === "--resume") out.resumeId = argv[++i];
    else if (arg === "--verbose") { /* no-op */ }
    // review · scan 전용
    else if (arg === "--diff") out.diff = argv[++i];
    else if (arg === "--staged") out.staged = true;
    else if (arg === "--format") {
      const value = argv[++i];
      if (value !== "md" && value !== "json") throw new Error(`--format 값이 올바르지 않습니다: ${value} (md | json)`);
      out.format = value;
    }
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--verify") out.verify = argv[++i];
    else if (arg === "--tests-passed") out.testsPassed = true;
    else if (arg === "--fail-on") out.failOn = argv[++i];
    // doc · adr · gate 전용
    else if (arg === "--force") out.force = true;
    else if (arg === "--record") out.record = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--skip-review") out.skipReview = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--spec") out.spec = argv[++i];
    else if (arg === "--framework") out.framework = argv[++i];
    else if (arg === "--junit") out.junit = argv[++i];
    else if (arg === "--jacoco") out.jacoco = argv[++i];
    else if (arg === "--lcov") out.lcov = argv[++i];
    else if (arg === "--min") {
      const v = Number(argv[++i]);
      if (!(v >= 0 && v <= 100)) throw new Error("--min 은 0~100 입니다.");
      out.min = v;
    }
    else if (arg === "--status") out.status = argv[++i];
    else if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "-v" || arg === "--version") out.version = true;
    else if (arg !== undefined && arg.startsWith("--")) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (arg !== undefined) out.rest.push(arg);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${ui.red(/** @type {Error} */ (error).message)}\n  axnavi --help\n`);
    return 2;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const [command, ...rest] = args.rest;

  // 조직 설정은 대화·에이전트 실행 전에만 자동으로 받는다(리뷰·게이트·인덱스는 결정론적이어야 해서 건드리지 않는다)
  if (!command || command === "ask" || command === "agent" || command === "skill") await autoPullOrg();

  if (!command) {
    const paths = resolveProjectPaths(args.root);
    return startRepl(paths, inspectProject(paths), VERSION, {
      ...(args.continueLatest ? { continueLatest: true } : {}),
      ...(args.resumeId ? { resumeId: args.resumeId } : {}),
    });
  }

  switch (command) {
    case "init":
      return cmdInit(args.root);
    case "keys":
      return cmdKeys();
    case "doctor":
      return cmdDoctor(args.root);
    case "upgrade":
      return cmdUpgrade(rest[0]);
    case "index":
      return cmdIndex(args.root, rest[0] ?? "status", {
        ...(args.tier ? { tier: args.tier } : {}),
        ...(args.indexDir ? { indexDir: args.indexDir } : {}),
        ...(rest[1] ? { out: rest[1] } : {}),
      });
    case "review":
      return cmdReview(args.root, {
        ...(args.diff ? { range: args.diff } : {}),
        ...(args.staged ? { staged: true } : {}),
        ...(args.format ? { format: args.format } : {}),
        ...(args.out ? { out: args.out } : {}),
        ...(args.verify ? { verify: args.verify } : {}),
        ...(args.testsPassed ? { testsPassed: true } : {}),
        ...(args.indexDir ? { indexDir: args.indexDir } : {}),
      });
    case "scan":
      return cmdScan(args.root, {
        kind: rest[0] ?? "security",
        paths: rest.slice(1),
        ...(args.format ? { format: args.format } : {}),
        ...(args.out ? { out: args.out } : {}),
        ...(args.failOn ? { failOn: args.failOn } : {}),
      });
    case "doc":
      return cmdDoc(args.root, rest, { ...(args.force ? { force: true } : {}), ...(args.indexDir ? { indexDir: args.indexDir } : {}) });
    case "adr":
      return cmdAdr(args.root, rest, { ...(args.status ? { status: args.status } : {}) });
    case "gate":
      return cmdGate(args.root, rest[0], {
        ...(args.diff ? { range: args.diff } : {}),
        ...(args.staged ? { staged: true } : {}),
        ...(args.skipReview ? { skipReview: true } : {}),
        ...(args.record ? { record: true } : {}),
        ...(args.format ? { format: args.format } : {}),
        ...(args.out ? { out: args.out } : {}),
        ...(args.indexDir ? { indexDir: args.indexDir } : {}),
      });
    case "test":
      return cmdTest(args.root, rest[0] ?? "status", {
        ...(rest[1] ? { sr: rest[1] } : {}),
        ...(args.spec ? { spec: args.spec } : {}),
        ...(args.framework ? { framework: args.framework } : {}),
        ...(args.junit ? { junit: args.junit } : {}),
        ...(args.out ? { out: args.out } : {}),
        ...(args.format ? { format: args.format } : {}),
      });
    case "coverage":
      return cmdCoverage(args.root, {
        ...(args.jacoco ? { jacoco: args.jacoco } : {}),
        ...(args.lcov ? { lcov: args.lcov } : {}),
        ...(args.diff ? { range: args.diff } : {}),
        ...(args.staged ? { staged: true } : {}),
        ...(args.min !== undefined ? { min: args.min } : {}),
        ...(args.format ? { format: args.format } : {}),
        ...(args.out ? { out: args.out } : {}),
      });
    case "modernize":
      return cmdModernize(args.root, {
        recipe: rest[0] ?? "",
        paths: rest.slice(1),
        ...(args.apply ? { apply: true } : {}),
        ...(args.force ? { force: true } : {}),
        ...(args.verify ? { verify: args.verify } : {}),
        ...(args.format ? { format: args.format } : {}),
        ...(args.out ? { out: args.out } : {}),
      });
    case "org":
      return cmdOrg(rest[0] ?? "status", { version: VERSION });
    case "mcp":
      return cmdMcp(args.root, rest[0] ?? "list", { ...(args.yes ? { yes: true } : {}) });
    case "agent":
      return cmdAgent(args.root, rest, args.provider);
    case "skill":
      return cmdSkill(args.root, rest, args.provider);
    case "ask": {
      const prompt = rest.join(" ");
      if (!prompt) {
        process.stderr.write("사용법: axnavi ask <요청>\n");
        return 2;
      }
      // 기본 실행자는 feature-finder다 — 인덱스가 없어도 grep 전략으로 답할 수 있어
      // 첫 실행에서 막히지 않는다(agents/feature-finder.md의 전략 2~4).
      return executeAgent({
        root: args.root,
        agentName: "feature-finder",
        prompt,
        ...(args.provider ? { providerName: args.provider } : {}),
      });
    }
    default:
      process.stderr.write(`${ui.red(`알 수 없는 명령: ${command}`)}\n  axnavi --help\n`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${ui.red("실패")}: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });


