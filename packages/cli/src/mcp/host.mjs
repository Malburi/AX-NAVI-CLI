/*
 * 위임 실행이 사용자에게 되묻는 통로 — CLI 쪽 끝.
 *
 * 문제는 이렇다. 오케스트레이터 절차는 사용자에게 물어야 하는 지점이 있는데
 * (harness-init Phase -1의 프로젝트 구성 확인 같은), 위임 실행은 별도 프로세스이고
 * 그 프로세스에는 터미널이 없다. 물을 수단이 없으니 기본값을 가정하고 넘어간다 —
 * 실측에서 "AskUserQuestion이 없어 단일 프로젝트로 가정합니다"가 그 결과였다.
 *
 * 터미널을 쥐고 있는 것은 CLI다. 그래서 CLI가 로컬 소켓을 열고, 위임 프로세스 쪽
 * MCP 서버가 거기로 질문을 보내면 CLI가 사람에게 묻고 답을 돌려준다.
 *
 * 소켓을 쓰는 이유 — MCP 서버는 stdio를 프로토콜에 쓰고 있어 거기에 터미널을 겹칠 수 없고,
 * 자식 프로세스가 부모의 TTY를 직접 여는 방식은 윈도우에서 지저분하다.
 */
import { createServer } from "node:net";

const NEWLINE = String.fromCharCode(10);
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** @typedef {import("@ax-navi/core").Elicitor} Elicitor */

/** 윈도우는 named pipe, 그 외는 소켓 파일. net 모듈이 둘 다 같은 API로 다룬다. */
function makeAddress() {
  const id = `axnavi-${process.pid}-${randomBytes(4).toString("hex")}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

/**
 * @typedef {object} ElicitHost
 * @property {string} address           MCP 서버에 넘길 소켓 주소
 * @property {() => Promise<void>} close
 * @property {number} asked             실제로 물어본 횟수 (보고용)
 */

/**
 * 질문 중계 서버를 연다.
 *
 * @param {object} args
 * @param {Elicitor} args.elicitor              실제로 사람에게 묻는 구현 (터미널)
 * @param {(text: string) => void} [args.onNotice]  사용자에게 보여 줄 안내
 * @param {(name: string, request: string) => string} [args.onSkill]  스킬 실행 요청을 받아 답을 돌려준다
 * @param {(tool: string, input: Record<string, unknown>) => Promise<unknown>} [args.onApprove]  도구 사용 승인
 * @returns {Promise<ElicitHost>}
 */
export async function startElicitHost({ elicitor, onNotice, onSkill, onApprove }) {
  const address = makeAddress();
  const state = { asked: 0 };

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      // 한 줄에 요청 하나. 줄바꿈이 프레임 경계다.
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;

        /** @type {{ id: string, kind?: string, question: string, options?: string[], multiSelect?: boolean, header?: string, name?: string, request?: string, tool?: string, input?: Record<string, unknown> }} */
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }

        /*
         * 스킬 실행 요청은 여기서 돌리지 않는다 — 접수만 하고 돌아간다.
         * 여기서 돌리면 LLM 턴 안에서 또 다른 LLM 턴을 돌리는 꼴이 되고,
         * 출력이 섞여 무엇이 어느 실행의 것인지 구분되지 않는다.
         */
        if (req.kind === "skill") {
          const answer = onSkill?.(req.name ?? "", req.request ?? "")
            ?? "스킬을 실행할 수 없는 경로다.";
          socket.write(`${JSON.stringify({ id: req.id, answers: [answer] })}${NEWLINE}`);
          continue;
        }

        /*
         * 도구 사용 승인. 판단기가 없으면 거부한다 — 서버 쪽도 답이 없으면 거부하지만,
         * 여기서 분명히 돌려주는 편이 기다리는 시간이 없다.
         */
        if (req.kind === "approve") {
          /** @type {unknown} */
          let decision = { behavior: "deny", message: "이 실행에는 승인 창이 없습니다." };
          try {
            if (onApprove) decision = await onApprove(req.tool ?? "", req.input ?? {});
          } catch (error) {
            decision = { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
          }
          socket.write(`${JSON.stringify({ id: req.id, answers: [JSON.stringify(decision)] })}${NEWLINE}`);
          continue;
        }

        try {
          onNotice?.(req.question);
          state.asked += 1;
          const answers = await elicitor.ask(
            req.question,
            req.options ?? [],
            {
              ...(req.multiSelect === undefined ? {} : { multiSelect: req.multiSelect }),
              ...(req.header ? { header: req.header } : {}),
            },
          );
          /*
           * 빈 답이면 왜 비었는지 함께 보낸다 — 사람이 Esc 로 건너뛴 것과 답할 사람이 없는 실행은
           * 다르게 다뤄야 한다(뒤의 것은 기본값으로 넘어가지 않고 멈춘다. mcp/answers.mjs 참고).
           */
          const reason = answers.length ? undefined : elicitor.canAsk?.() === false ? "no_one" : "skipped";
          socket.write(`${JSON.stringify({ id: req.id, answers, ...(reason ? { reason } : {}) })}\n`);
        } catch (error) {
          // 질문이 실패했다고 위임 실행을 멈추게 하지는 않는다. 사유를 답으로 돌려준다.
          const message = error instanceof Error ? error.message : String(error);
          socket.write(`${JSON.stringify({ id: req.id, answers: [], reason: "error", error: message })}\n`);
        }
      }
    });
    socket.on("error", () => { /* 위임 프로세스가 먼저 죽는 경우 — 무시 */ });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => resolve(undefined));
  });

  return {
    address,
    get asked() {
      return state.asked;
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
