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
import { resolve } from "node:path";
import { COMMANDS } from "../../../indexer/index.mjs";
import { isWithin } from "../../../core/src/index.mjs";
import { noAnswerText } from "./answers.mjs";

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
        waiting.get(res.id)?.(res);
        waiting.delete(res.id);
      } catch {
        /* 깨진 줄은 버린다 */
      }
    }
  });
  socket.on("error", () => {
    // 연결이 끊기면 대기 중인 질문을 빈 답으로 깨운다 — 영원히 매달리지 않게.
    for (const resolve of waiting.values()) resolve({ answers: [], reason: "error" });
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
  return requestFull({ question, options, multiSelect, header });
}

/**
 * 호스트에 한 건 묻고 응답 전체를 기다린다. 빈 답이면 `reason` 이 왜 비었는지 알려 준다
 * ("skipped" 사용자가 건너뜀 · "no_one" 답할 사람이 없는 실행 · "error" 통로 문제).
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ answers?: string[], reason?: string }>}
 */
function requestFull(payload) {
  const sock = ensureSocket();
  if (!sock) return Promise.resolve({ answers: [], reason: "error" });
  const id = randomUUID();
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    sock.write(`${JSON.stringify({ id, ...payload })}${NEWLINE}`);
  });
}

/**
 * 호스트에 한 건 묻고 답만 받는다. 승인·스킬 요청이 쓴다.
 * @param {Record<string, unknown>} payload
 * @returns {Promise<string[]>}
 */
async function request(payload) {
  return (await requestFull(payload)).answers ?? [];
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
    /*
     * 권한 확인 통로. claude 가 `--permission-prompt-tool` 로 부른다 — 모델이 부를 도구가 아니다.
     * 목록에 있어야 claude 가 찾을 수 있어서 올려 둔다.
     */
    name: "Approve",
    description: "권한 확인용 내부 도구다. 직접 부르지 마라.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "Skill",
    description:
      "AX-NAVI 의 전용 워크플로를 실행한다. 사용자가 그 일을 부탁하면 명령을 " +
      "안내하지 말고 이 도구를 부르면 된다. 접수되면 덧붙이지 말고 끝내라. " +
      "스킬을 수행하는 중에 부르면 그 스킬의 지침이 돌아온다 — 그때는 끝내지 말고 지침을 그대로 수행하라.",
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
      "명령: summary, search, symbol, callers, callees, trace, sql, table, column, endpoint, transaction, schema, dead. " +
      "column(name=컬럼명)은 그 DB 컬럼을 보여 주는 화면 그리드 열과 SQL 을 준다 — 컬럼 변경의 화면 영향. " +
      "업무 용어로 찾을 때는 search 를 먼저 쓴다 — 나머지 명령은 코드 식별자·파일명으로만 걸려서 한글 용어가 안 맞는다(실측: symbol '로그인' 0건, search '로그인' 384건). " +
      "한글 질의의 search 결과 맨 앞 features 는 용어가 화면 제목·파일 머리말·설명에 나온 위치로 매긴 기능 후보 순위다 — " +
      "코드명(MA00001)으로 된 시스템에서도 업무명으로 찾게 해 준다. 영문 키워드를 추측하기 전에 features 상위 폴더부터 확인한다.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        root: {
          type: "string",
          description:
            "질의할 저장소의 절대경로. 저장소가 여럿인 프로젝트에서만 쓴다 — 생략하면 기본 저장소를 본다.",
        },
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
  if (name === "Approve") {
    /*
     * 판단은 터미널을 쥔 CLI 가 한다. 여기서는 나르기만 한다.
     * 통로가 없거나 답이 깨졌으면 거부 — 묻지도 못했는데 허용하면 안 된다.
     */
    const [raw] = await request({ kind: "approve", tool: args.tool_name ?? "", input: args.input ?? {} });
    /** @type {{ behavior?: string, message?: string, updatedInput?: unknown }} */
    let decision = {};
    try {
      decision = JSON.parse(raw ?? "");
    } catch {
      decision = {};
    }
    if (decision.behavior !== "allow" && decision.behavior !== "deny") {
      decision = { behavior: "deny", message: "승인 통로에 닿지 못해 거부됐습니다. 우회하지 말고, 하지 못한 일을 결과에 적으세요." };
    }
    return { text: JSON.stringify(decision) };
  }

  if (name === "AskUserQuestion") {
    const res = await askUser(args.question ?? "", args.options ?? [], args.multiSelect === true, args.header ?? "");
    const answers = res.answers ?? [];
    if (!answers.length) return { text: noAnswerText(res.reason) };
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
      /*
       * 루트를 인자로 받는다.
       *
       * 예전에는 환경변수로 하나에 못 박혀 있어서, 저장소가 여럿인 프로젝트에서
       * 한쪽만 질의할 수 있었다. 실측으로 백엔드·프론트엔드가 각자 인덱스를 가진
       * 구조에서 이게 문제가 됐다.
       *
       * 받은 값은 **반드시 검사한다.** 그대로 쓰면 임의 경로의 JSON 을 읽는 통로가
       * 열린다. 허용 루트 안일 때만 쓰고, 벗어나면 조용히 기본값으로 돌린다 —
       * 여기서 던지면 정상적인 질의까지 막힌다.
       */
      const wanted = typeof args.root === "string" && args.root ? resolve(args.root) : null;
      const useRoot = wanted && isWithin([PROJECT_ROOT], wanted) ? wanted : PROJECT_ROOT;
      /** @type {Record<string, unknown>} */
      const query = useRoot === PROJECT_ROOT
        ? { root: PROJECT_ROOT, ...(INDEX_DIR ? { indexDir: INDEX_DIR } : {}) }
        // 다른 저장소를 짚었으면 그쪽의 기본 인덱스 경로를 쓴다. 우리 INDEX_DIR 은 남의 것이다.
        : { root: useRoot };
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
