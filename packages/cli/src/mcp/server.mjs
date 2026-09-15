#!/usr/bin/env node
/*
 * AX-NAVI MCP 서버 — 위임 실행이 CLI의 기능을 빌려 쓰는 통로.
 *
 * 이 파일은 CLI 프로세스가 아니라 위임된 claude 프로세스의 자식으로 뜬다.
 * stdio는 MCP 프로토콜이 쓰고, 사람에게 물어야 할 때는 환경변수로 받은 소켓
 * (AXNAVI_ELICIT_ADDR)으로 CLI에게 넘긴다 — 터미널은 CLI가 쥐고 있기 때문이다.
 *
 * 노출하는 도구는 최소로 유지한다. 위임 실행은 이미 claude Code의 내장 도구를
 * 갖고 있으므로, 여기서는 **그쪽에 없는 것만** 채운다.
 *   AskUserQuestion — -p 모드에는 되물을 수단이 없다
 *   QueryIndex      — 우리 결정론적 인덱스는 claude가 모른다
 */
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

const NEWLINE = String.fromCharCode(10);
import { COMMANDS } from "@ax-navi/indexer";

const ELICIT_ADDR = process.env["AXNAVI_ELICIT_ADDR"] ?? "";
const PROJECT_ROOT = process.env["AXNAVI_PROJECT_ROOT"] ?? process.cwd();
const INDEX_DIR = process.env["AXNAVI_INDEX_DIR"] ?? "";

/* ---------- CLI 로 질문 넘기기 ---------- */

/** @type {import("node:net").Socket | null} */
let socket = null;
/** @type {Map<string, (answers: string[]) => void>} */
const waiting = new Map();
let buffer = "";

function ensureSocket() {
  if (socket || !ELICIT_ADDR) return socket;
  socket = connect(ELICIT_ADDR);
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const res = JSON.parse(line);
        waiting.get(res.id)?.(res.answers ?? []);
        waiting.delete(res.id);
      } catch {
        /* 깨진 줄은 버린다 */
      }
    }
  });
  socket.on("error", () => {
    // 연결이 끊기면 대기 중인 질문을 빈 답으로 깨운다 — 영원히 매달리지 않게.
    for (const resolve of waiting.values()) resolve([]);
    waiting.clear();
    socket = null;
  });
  return socket;
}

/**
 * @param {string} question
 * @param {string[]} options
 * @param {boolean} multiSelect
 * @param {string} [header]
 * @returns {Promise<string[]>}
 */
function askUser(question, options, multiSelect, header) {
  return request({ question, options, multiSelect, header });
}

/**
 * 호스트에 한 건 묻고 답을 기다린다. 질문도 스킬 요청도 같은 통로를 쓴다.
 * @param {Record<string, unknown>} payload
 * @returns {Promise<string[]>}
 */
function request(payload) {
  const sock = ensureSocket();
  if (!sock) return Promise.resolve([]);
  const id = randomUUID();
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    sock.write(`${JSON.stringify({ id, ...payload })}${NEWLINE}`);
  });
}

/* ---------- 도구 ---------- */

const TOOLS = [
  {
    name: "AskUserQuestion",
    description:
      "사용자에게 직접 물어본다. 되물을 수 없다고 가정하고 기본값으로 진행하지 말고, " +
      "절차가 사용자 확인을 요구하면 이 도구를 써라. 옵션 개수에 상한이 없다.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "한국어로 쓴다" },
        header: { type: "string", description: "짧은 주제 말말 (예: '프로젝트 구성', '배치 구현'). 질문에 다시 적지 마라." },
        options: { type: "array", items: { type: "string" }, description: "선택지. '제목 — 설명' 꼴로 쓰면 제목과 설명을 갈라 보여 준다. 비우면 자유 입력" },
        multiSelect: { type: "boolean", description: "복수 선택 허용" },
      },
    },
  },
  {
    name: "Skill",
    description:
      "AX-NAVI 의 전용 워크플로를 실행한다. 사용자가 그 일을 부탁하면 명령을 " +
      "안내하지 말고 이 도구를 부르면 된다. 접수되면 덧붙이지 말고 끝내라.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "스킬 이름. 예: harness-init, safe-modify, find-feature" },
        request: { type: "string", description: "사용자의 요청을 그대로. 없으면 빈 문자열" },
      },
    },
  },
  {
    name: "QueryIndex",
    description:
      "AX-NAVI 결정론적 인덱스에 질의한다. 인덱스 JSON을 직접 열지 말고 이 도구를 써라 " +
      "(대형 레거시에서 sql_usage.json은 143MB까지 커진다). " +
      "명령: summary, search, symbol, callers, callees, trace, sql, table, endpoint, transaction, schema, dead. " +
      "업무 용어로 찾을 때는 search 를 먼저 쓴다 — 나머지 명령은 코드 식별자·파일명으로만 걸려서 한글 용어가 안 맞는다(실측: symbol '로그인' 0건, search '로그인' 384건).",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        file: { type: "string" },
        table: { type: "string" },
        path: { type: "string" },
        q: { type: "string", description: "찾을 말 (search) — 한글 업무 용어도 된다" },
        kind: { type: "string", description: "search 종류 좁히기" },
        depth: { type: "integer" },
        limit: { type: "integer" },
      },
    },
  },
];

/**
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Promise<{ text: string, isError?: boolean }>}
 */
async function callTool(name, args) {
  if (name === "AskUserQuestion") {
    const answers = await askUser(args.question ?? "", args.options ?? [], args.multiSelect === true, args.header ?? "");
    if (!answers.length) {
      return { text: "(사용자가 응답하지 않았다. 임의로 진행하지 말고 무엇을 가정했는지 밝혀라.)" };
    }
    return { text: answers.join(", ") };
  }

  if (name === "Skill") {
    const [answer] = await request({ kind: "skill", name: args.name ?? "", request: args.request ?? "" });
    return { text: answer ?? "응답이 없다." };
  }

  if (name === "QueryIndex") {
    const handler = /** @type {Record<string, (a: any) => unknown>} */ (COMMANDS)[args.command];
    if (!handler) return { text: `지원하지 않는 명령: ${args.command}`, isError: true };
    try {
      /** @type {Record<string, unknown>} */
      const query = { root: PROJECT_ROOT, ...(INDEX_DIR ? { indexDir: INDEX_DIR } : {}) };
      for (const key of ["id", "name", "file", "table", "path", "depth", "limit", "q", "kind"]) {
        if (args[key] !== undefined) query[key] = args[key];
      }
      return { text: JSON.stringify(handler(query), null, 2) };
    } catch (error) {
      const missing = /** @type {{ missingIndex?: string }} */ (error).missingIndex;
      if (missing) return { text: `인덱스가 없다 (${missing}). 먼저 인덱싱하라.`, isError: true };
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  return { text: `알 수 없는 도구: ${name}`, isError: true };
}

/* ---------- JSON-RPC (stdio) ---------- */

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return;
  }

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "axnavi", version: "0.1.0" },
      },
    });
    return;
  }

  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
    return;
  }

  if (req.method === "tools/call") {
    const { text: body, isError } = await callTool(req.params?.name ?? "", req.params?.arguments ?? {});
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) },
    });
    return;
  }

  // notifications에는 응답하지 않는다. 그 외 요청은 빈 결과로 닫는다.
  if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, result: {} });
});
