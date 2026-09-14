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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startElicitHost } from "./host.mjs";

const SERVER_PATH = fileURLToPath(new URL("./server.mjs", import.meta.url));

/**
 * @typedef {object} McpBridge
 * @property {string} configPath                 `--mcp-config` 에 넘길 경로
 * @property {Record<string, string>} env        위임 프로세스에 실을 환경변수
 * @property {() => number} askedCount           실제로 사용자에게 물어본 횟수
 * @property {() => Promise<void>} dispose
 */

/**
 * @param {object} args
 * @param {import("@ax-navi/core").ProjectPaths} args.paths
 * @param {import("@ax-navi/core").Elicitor} args.elicitor
 * @param {(question: string) => void} [args.onAsk]
 * @returns {Promise<McpBridge>}
 */
export async function startMcpBridge({ paths, elicitor, onAsk }) {
  const host = await startElicitHost({
    elicitor,
    ...(onAsk ? { onNotice: onAsk } : {}),
  });

  const dir = await mkdtemp(join(tmpdir(), "axnavi-mcp-"));
  const configPath = join(dir, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          // 서버 이름이 곧 도구 접두사가 된다 — mcp__axnavi__AskUserQuestion.
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
    dispose: () => host.close(),
  };
}
