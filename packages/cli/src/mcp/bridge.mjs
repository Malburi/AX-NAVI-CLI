/*
 * MCP 브리지 조립 — 위임 실행에 AX-NAVI 도구를 붙여 준다.
 *
 * 위임 경로(claude CLI)는 자체 도구를 갖고 있지만 두 가지가 없다.
 *   - 사용자에게 되묻는 수단. `-p` 모드에는 터미널이 없어 "물을 수 없다"고 가정하고
 *     기본값으로 넘어간다(실측: harness-init이 프로젝트 구성을 안 묻고 단일로 단정).
 *   - 우리 결정론적 인덱스. claude는 그런 게 있는 줄 모른다.
 *
 * 그 둘을 MCP 서버로 채운다. 질문은 소켓을 타고 CLI로 올라와 터미널에서 처리된다.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startElicitHost } from "./host.mjs";
import { loadUserMcpServers } from "../../../core/src/index.mjs";

const SERVER_PATH = fileURLToPath(new URL("./server.mjs", import.meta.url));

/**
 * @typedef {object} McpBridge
 * @property {string} configPath                 `--mcp-config` 에 넘길 경로
 * @property {Record<string, string>} env        위임 프로세스에 실을 환경변수
 * @property {() => number} askedCount           실제로 사용자에게 물어본 횟수
 * @property {string[]} userServers              함께 올린 사용자 MCP 서버(.axnavi/mcp.json)
 * @property {string[]} warnings                 사용자 MCP 설정에서 뺀 서버와 이유
 * @property {() => Promise<void>} dispose
 */

/**
 * @param {object} args
 * @param {import("@ax-navi/core").ProjectPaths} args.paths
 * @param {import("@ax-navi/core").Elicitor} args.elicitor
 * @param {(name: string, request: string) => string | Promise<string>} [args.onSkill]  스킬 실행 요청
 * @param {(question: string) => void} [args.onAsk]
 * @param {(tool: string, input: Record<string, unknown>) => Promise<unknown>} [args.onApprove]  도구 사용 승인
 * @returns {Promise<McpBridge>}
 */
export async function startMcpBridge({ paths, elicitor, onAsk, onSkill, onApprove }) {
  // 사용자가 등록한 서버(.axnavi/mcp.json — PMS-X·Jira·HNIX AX 허브 등)를 같은 설정에 함께 올린다.
  // --strict-mcp-config 라 여기 없는 서버는 위임 실행에서 보이지 않는다.
  // 질문 통로(host)를 열기 전에 읽는다 — 여기서 실패해도 열린 통로가 프로세스를 붙잡지 않게.
  const user = loadUserMcpServers(paths);
  const host = await startElicitHost({
    elicitor,
    ...(onAsk ? { onNotice: onAsk } : {}),
    ...(onSkill ? { onSkill } : {}),
    ...(onApprove ? { onApprove } : {}),
  });

  const dir = await mkdtemp(join(tmpdir(), "axnavi-mcp-"));
  const configPath = join(dir, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          ...user.servers,
          // 서버 이름이 곧 도구 접두사가 된다 — mcp__axnavi__AskUserQuestion. 사용자 설정보다 뒤에 둬 덮어쓰지 못하게.
          axnavi: { command: process.execPath, args: [SERVER_PATH] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    configPath,
    env: {
      AXNAVI_ELICIT_ADDR: host.address,
      AXNAVI_PROJECT_ROOT: paths.root,
      AXNAVI_INDEX_DIR: paths.indexDir,
    },
    askedCount: () => host.asked,
    userServers: Object.keys(user.servers),
    warnings: user.warnings,
    // 임시 mcp.json 에는 풀린 키(Bearer 등)가 들어 있다 — 끝나면 지운다(10/25 리뷰 중간)
    dispose: async () => {
      await host.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
