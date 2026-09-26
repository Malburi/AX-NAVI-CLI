#!/usr/bin/env node
/*
 * axnavi 진입점.
 *
 * 명령 하나가 곧 사용자와의 계약이므로, 알 수 없는 인자를 조용히 무시하지 않고 멈춘다.
 * 기존 agents/lib/*.mjs의 parseArgs가 하던 방식과 같다.
 */
import { readFileSync } from "node:fs";
import { inspectProject, resolveProjectPaths } from "../../core/src/index.mjs";
import { cmdAgent, cmdDoctor, cmdIndex, cmdInit, cmdSkill } from "./commands.mjs";
import { cmdKeys } from "./keys.mjs";
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

  axnavi agent list               에이전트 목록
  axnavi agent run <이름> <요청>   에이전트 직접 실행
  axnavi skill list               스킬 목록
  axnavi skill run <이름> <요청>   스킬 실행

${ui.bold("옵션")}
  --root <경로>       프로젝트 루트 (기본: 현재 폴더)
  --index-dir <경로>  인덱스 위치 (기본: <root>/_workspace/index)
  --tier <등급>       Auto | Standard | Full
  --provider <이름>   auto | agent-sdk | claude-cli | anthropic
                      auto(기본): API 키와 SDK 가 있으면 anthropic, 없으면 agent-sdk(구독),
                      SDK 가 없으면(폐쇄망 설치) claude-cli
  -c, --continue      마지막 대화를 이어서 시작
  --resume <id>       특정 대화를 이어서 시작 (/sessions 로 id 확인)
  --verbose           내부 진단 출력 (도구 목록·토큰 내역·감사기록 경로)
  -h, --help          도움말
  -v, --version       버전
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ root: string, indexDir?: string, tier?: string, provider?: import("./provider.mjs").ProviderName, continueLatest?: boolean, resumeId?: string, help?: boolean, version?: boolean, rest: string[] }} */
  const out = { root: process.cwd(), rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i] ?? out.root;
    else if (arg === "--index-dir") out.indexDir = argv[++i];
    else if (arg === "--tier") out.tier = argv[++i];
    else if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "auto" && value !== "anthropic" && value !== "claude-cli" && value !== "agent-sdk") {
        throw new Error(`--provider 값이 올바르지 않습니다: ${value} (auto | anthropic | claude-cli | agent-sdk)`);
      }
      out.provider = value;
    }
    // runtime.mjs가 process.argv에서 직접 읽는다. 여기서는 "알 수 없는 옵션"으로 막히지만 않으면 된다.
    else if (arg === "-c" || arg === "--continue") out.continueLatest = true;
    else if (arg === "--resume") out.resumeId = argv[++i];
    else if (arg === "--verbose") { /* no-op */ }
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


