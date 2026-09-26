/*
 * 이어서 열 때 지난 대화를 **전부** 다시 그린다 — Claude Code 의 /resume 처럼.
 *
 * axnavi 가 따로 쌓는 기록은 사용자 질문과 최종 답 글자뿐이라, 도구를 무엇에 썼는지가 사라졌고
 * 마지막 몇 마디만 줄여 보여 줬다. 실측: 마지막 턴들이 붙여넣기 조각("빈 구분선", "대기 중")이던
 * 세션을 열자 앞에서 무슨 일을 했는지 전혀 알 수 없었다.
 *
 * 대화 전체는 Claude 가 이미 남긴다 — ~/.claude/projects/<작업 폴더>/<세션 id>.jsonl. Claude Code 의
 * /resume 도 이 파일을 읽는다. 그것을 지금 화면과 같은 모양(질문 ›, 답 마크다운, 도구 ● 한 줄과 결과
 * 요약)으로 그린다. 이미 끝난 예전 세션도 그대로 되살아난다.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flattenToolContent } from "../../provider-claude-cli/src/index.mjs";
import { createMarkdown } from "./markdown.mjs";
import { renderCall } from "./transcript.mjs";
import { clipToWidth, wrapToWidth } from "./width.mjs";

/**
 * Claude 가 세션 기록을 두는 곳. 폴더 이름은 작업 폴더 경로의 영숫자 아닌 글자를 '-' 로 바꾼 것이다.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string} [home]
 */
export function claudeTranscriptPath(cwd, sessionId, home = homedir()) {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/*
 * 사용자 메시지에서 사람이 쓴 부분만 남긴다. axnavi 가 앞에 붙인 도구 안내·역할 지침·응답 방식은 걷고,
 * 스킬 실행 지시(절차 본문 수십 KB)는 "/스킬 요청" 한 줄로 줄인다.
 */
const PREAMBLE = /<(쓸 수 있는 도구|역할 지침|응답 방식)>[\s\S]*?<\/\1>/g;

/** @param {string} raw @returns {string | null} */
export function humanText(raw) {
  const text = String(raw).replace(PREAMBLE, "").trim();
  if (!text) return null;
  // 시스템이 끼워 넣은 알림은 사람 말이 아니다.
  if (/^<(system-reminder|task-notification|command-name|local-command)/.test(text)) return null;
  const skill = text.match(/<스킬 절차:\s*([^>\s]+)\s*>/)?.[1] ?? text.match(/^##\s*절차:\s*(\S+)/m)?.[1];
  if (skill) {
    const request = text.match(/^#\s*요청\s*\r?\n+([^\n]+)/m)?.[1]
      ?? text.match(/사용자가 덧붙인 조건:\s*([^\n]+)/)?.[1]
      ?? "";
    return `/${skill}${request ? ` ${request.trim()}` : ""}`;
  }
  return text;
}

/**
 * @param {string} path
 * @returns {Array<any>}
 */
function readEntries(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} args.path   Claude 세션 기록 파일
 * @param {string} args.root   프로젝트 루트 — 도구 인자의 경로를 짧게 줄일 때 쓴다
 * @param {number} args.width
 * @param {any} args.ui
 * @returns {string[] | null}  기록 파일이 없으면 null
 */
export function renderClaudeSession({ path, root, width, ui }) {
  if (!existsSync(path)) return null;
  const cap = Math.max(20, width - 1);
  const markdown = createMarkdown({ ui, width: width - 2 });
  /** @type {Map<string, { tool: string, input: unknown }>} */
  const pending = new Map();
  /** @type {string[]} */
  const out = [];
  const flushMarkdown = () => { for (const l of markdown.flush()) out.push(l ? `  ${l}` : ""); };

  for (const entry of readEntries(path)) {
    if (entry.isMeta) continue;
    if (entry.isCompactSummary) {
      flushMarkdown();
      out.push(clipToWidth(ui.dim("  ⤵ 여기서 대화가 압축됐습니다 — 앞 내용은 요약으로 이어집니다"), cap));
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const call = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          flushMarkdown();
          out.push(...renderCall({
            tool: call?.tool ?? "(도구)", input: call?.input, result: flattenToolContent(block.content),
            isError: block.is_error === true, root, width, ui,
          }));
        } else if (block.type === "text") {
          const text = humanText(block.text);
          if (!text) continue;
          flushMarkdown();
          out.push("");
          wrapToWidth(text, cap - 2).forEach((line, i) => out.push(clipToWidth(`${i === 0 ? ui.cyan("›") : " "} ${ui.bold(line)}`, cap)));
        }
      }
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          for (const line of String(block.text).split(/\r?\n/)) for (const l of markdown.line(line)) out.push(l ? `  ${l}` : "");
        } else if (block.type === "tool_use") {
          flushMarkdown();
          pending.set(block.id, { tool: String(block.name).replace(/^mcp__axnavi__/, ""), input: block.input });
        }
      }
    }
  }
  flushMarkdown();
  // 결과를 받지 못하고 끝난 호출(중단 등)도 밝힌다.
  for (const [, call] of pending) out.push(...renderCall({ tool: call.tool, input: call.input, pending: true, root, width, ui }));
  while (out.length && out[0] === "") out.shift();
  return out;
}
