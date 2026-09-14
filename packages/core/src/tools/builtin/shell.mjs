/*
 * Bash — 셸 실행.
 *
 * 읽기 전용 역할에도 이 도구를 주는 것이 기존 규약이다(13개 에이전트가
 * `tools: Read, Grep, Glob, Bash, Write`를 선언하면서 Edit만 뺐다). 그래서 mutates는
 * false로 두되 차단 목록으로 파괴적 명령을 막는다. "읽기 전용 역할"이라는 말이
 * 셸을 못 쓴다는 뜻은 아니지만, 저장소를 지워도 된다는 뜻은 더더욱 아니다.
 */
import { spawn } from "node:child_process";

/** @typedef {import("../../../types/tools.js").ToolHandler} ToolHandler */

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;

/* 되돌릴 수 없거나 저장소 밖으로 나가는 명령. 판단이 애매하면 막는 쪽을 택한다. */
const DENY_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: "재귀·강제 삭제" },
  { re: /\bRemove-Item\b[^|]*-Recurse/i, why: "재귀 삭제" },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--)/, why: "되돌릴 수 없는 git 조작" },
  { re: /\bgit\s+commit\b/, why: "커밋은 사용자 승인 경로로만" },
  { re: /\b(shutdown|reboot|mkfs|diskpart|format)\b/i, why: "시스템 조작" },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b/i, why: "외부 전송 — 컨텍스트 유출 위험" },
  { re: /\bnpm\s+(publish|login)\b/, why: "배포·인증" },
  { re: /dd\s+if=/, why: "디스크 직접 쓰기" },
];

/** @type {ToolHandler} */
export const bashTool = {
  definition: {
    name: "Bash",
    description:
      "셸 명령을 실행한다. 파괴적·외부 전송 명령은 차단된다. 빌드·테스트·git 조회 같은 확인 용도로 쓴다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        timeout: { type: "integer", description: `밀리초, 기본 ${TIMEOUT_MS}` },
      },
    },
  },
  run(input, ctx) {
    for (const { re, why } of DENY_PATTERNS) {
      if (re.test(input.command)) {
        return Promise.resolve({ content: `차단된 명령이다 (${why}): ${input.command}`, isError: true });
      }
    }

    return new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: true,
        cwd: ctx.paths.root,
        // 한국어 출력이 cp949로 깨지지 않게 한다 — agents/lib의 Python 스크립트들과 같은 정책.
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let out = "";
      let err = "";
      let settled = false;
      /** @param {string} content @param {boolean} [isError] */
      const finish = (content, isError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise(isError === undefined ? { content } : { content, isError });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(`시간 초과 (${input.timeout ?? TIMEOUT_MS}ms). 부분 출력:\n${out}${err}`, true);
      }, input.timeout ?? TIMEOUT_MS);
      const onAbort = () => { child.kill(); finish("취소됨", true); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => { out += chunk.toString(); });
      child.stderr.on("data", (chunk) => { err += chunk.toString(); });
      child.on("error", (error) => finish(`실행 실패: ${error.message}`, true));
      child.on("close", (code) => {
        const body = `${out}${err ? `\n[stderr]\n${err}` : ""}`.trim();
        const clipped = body.length > MAX_OUTPUT ? `${body.slice(0, MAX_OUTPUT)}\n... (출력이 잘렸다)` : body;
        // exit code를 항상 밝힌다 — 실패를 성공으로 보고하지 않기 위해.
        finish(`exit=${code}\n${clipped || "(출력 없음)"}`, code !== 0);
      });
    });
  },
};
