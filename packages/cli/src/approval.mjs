/*
 * 도구 사용 승인 — 플러그인에서 Claude Code 가 하던 "허용할까요?" 를 CLI 가 한다.
 *
 * 왜 필요한가. 위임 실행은 `claude -p` 인데, -p 모드에는 승인해 줄 사람이 없어서
 * 승인이 필요한 도구는 곧 거부된다. 개발 PC 는 개인 설정이 `defaultMode: auto` 라
 * 드러나지 않았다. 기본 설정인 PC 로 흉내 내 보니 Write 가 거부되고 파일이 안 생겼다
 * (실측). 동료 PC 에서는 harness-init 이 아무것도 못 쓰고 끝난다는 뜻이다.
 *
 * 허용 목록을 고정하는 대신 **물어본다.** 플러그인과 같은 경험이어야 하고, 무엇을
 * 허용할지는 역할이 아니라 그 순간의 사람이 정하는 일이기 때문이다.
 * claude 는 `--permission-prompt-tool` 로 이 판단을 MCP 도구에 넘긴다. 받는 것은
 * `{ tool_name, input, tool_use_id }`, 돌려줄 것은 allow/deny 두 모양이다(실측).
 *
 * 읽기 도구는 여기까지 오지 않는다 — claude 가 묻지 않고 허용하는 것만 빼고 온다.
 * 그래서 이 모듈은 "쓰기·실행" 만 다룬다고 봐도 된다.
 */

import { readFileSync } from "node:fs";
import { diffPreview } from "./diff.mjs";

/** @typedef {import("./diff.mjs").PreviewLine} PreviewLine */

/** 파일을 바꾸는 도구. 한 묶음으로 "이번 세션 허용" 을 건다 — Claude Code 도 그렇다. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** 화면 한 줄에 싣는 명령 길이 상한. 넘으면 자른다. */
const MAX_DETAIL = 160;

/**
 * @typedef {{ behavior: "allow", updatedInput: Record<string, unknown> }
 *         | { behavior: "deny", message: string }} Decision
 */

/**
 * "이번 세션 동안 묻지 않음" 을 무엇 단위로 기억할지.
 *
 * Bash 를 도구 이름 하나로 묶으면 `npm test` 를 허용한 순간 `rm -rf` 까지 열린다.
 * 첫 단어(명령 이름)로 묶는다. 파일 수정은 한 묶음이다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function approvalKey(tool, input) {
  if (EDIT_TOOLS.has(tool)) return "파일 수정";
  if (tool === "Bash") {
    const command = typeof input["command"] === "string" ? input["command"].trim() : "";
    const head = command.split(/\s+/)[0] ?? "";
    return head ? `Bash(${head})` : "Bash";
  }
  return tool;
}

/**
 * 무엇을 하려는지 한 줄로.
 *
 * 사람이 판단할 재료는 "어느 파일" 과 "무슨 명령" 이다. 입력 JSON 을 통째로 보여
 * 주면 긴 content 에 묻혀 정작 경로가 안 보인다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function describeToolUse(tool, input) {
  const pick = (/** @type {string} */ key) => (typeof input[key] === "string" ? String(input[key]) : "");
  let detail = "";
  if (EDIT_TOOLS.has(tool)) detail = pick("file_path") || pick("notebook_path");
  else if (tool === "Bash") detail = pick("command");
  else if (tool === "WebFetch") detail = pick("url");
  else if (tool === "WebSearch") detail = pick("query");
  else {
    try {
      detail = JSON.stringify(input);
    } catch {
      detail = "";
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL - 1)}…`;
  return detail ? `${tool}  ${detail}` : tool;
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** @param {string} text */
const normalize = (text) => text.replace(/\r\n?/g, "\n");

/**
 * 승인 전에 보여 줄 미리보기 — 무엇이 바뀌는지.
 *
 * 경로만 보고 "예" 를 누르게 하면 승인이 형식이 된다. 플러그인에서는 Claude Code 가
 * 바뀌는 줄을 빨강·초록으로 보여 줬다. 같은 재료를 만든다. 그리는 것은 선택 창의 일이다.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {(path: string) => string | null} [readText]  파일 읽기 (시험에서 바꿔 끼운다)
 * @returns {PreviewLine[]}
 */
export function previewToolUse(tool, input, readText = readTextOrNull) {
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
  const path = str(input["file_path"]) || str(input["notebook_path"]);
  const raw = path ? readText(path) : null;
  const current = raw === null ? null : normalize(raw);

  /**
   * 바꿀 조각이 파일의 몇 번째 줄에서 시작하는지. 못 찾으면 번호 없이 보여 준다 —
   * 틀린 번호는 번호가 없는 것보다 나쁘다.
   * @param {string} fragment
   * @returns {number | null}
   */
  const lineOf = (fragment) => {
    if (current === null || !fragment) return null;
    const at = current.indexOf(normalize(fragment));
    if (at === -1) return null;
    return current.slice(0, at).split("\n").length;
  };
  /** @param {PreviewLine[]} lines */
  const unnumbered = (lines) => lines.map(({ no: _no, ...rest }) => rest);
  /** @param {number} added @param {number} removed */
  const tally = (added, removed) =>
    [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");

  if (tool === "Edit") {
    const oldText = str(input["old_string"]);
    const start = lineOf(oldText);
    const { lines, added, removed } = diffPreview(oldText, str(input["new_string"]), start ?? 1);
    /** @type {PreviewLine[]} */
    const notes = [{ kind: "note", text: tally(added, removed) || "바뀌는 줄 없음" }];
    if (input["replace_all"] === true && current !== null && oldText) {
      const count = current.split(normalize(oldText)).length - 1;
      if (count > 1) notes.push({ kind: "note", text: `같은 내용 ${count}곳을 모두 바꿉니다` });
    }
    if (current !== null && oldText && start === null) {
      notes.push({ kind: "note", text: "파일에서 바꿀 부분을 찾지 못했습니다 — 실행하면 실패합니다" });
    }
    return [...notes, ...(start === null ? unnumbered(lines) : lines)];
  }

  if (tool === "MultiEdit") {
    const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
    /** @type {PreviewLine[]} */
    const out = [{ kind: "note", text: `편집 ${edits.length}건` }];
    edits.forEach((edit, i) => {
      const e = edit && typeof edit === "object" ? /** @type {Record<string, unknown>} */ (edit) : {};
      const oldText = str(e["old_string"]);
      const start = lineOf(oldText);
      const { lines } = diffPreview(oldText, str(e["new_string"]), start ?? 1);
      if (i > 0) out.push({ kind: "gap", text: "⋯" });
      out.push(...(start === null ? unnumbered(lines) : lines));
    });
    return out;
  }

  if (tool === "Write") {
    const content = str(input["content"]);
    if (current === null) {
      const { lines, added } = diffPreview("", content);
      return [{ kind: "note", text: `새 파일 · ${added}줄` }, ...lines];
    }
    if (current === normalize(content)) return [{ kind: "note", text: "지금 파일과 내용이 같습니다" }];
    const { lines, added, removed } = diffPreview(current, content);
    return [{ kind: "note", text: `덮어쓰기 · ${tally(added, removed)}` }, ...lines];
  }

  if (tool === "NotebookEdit") {
    const { lines } = diffPreview("", str(input["new_source"]));
    return [{ kind: "note", text: `셀 ${str(input["edit_mode"]) || "replace"}` }, ...unnumbered(lines)];
  }

  /*
   * Bash — 한 줄 요약에 다 안 들어가는 명령은 전체를 보여 준다.
   * 여러 줄 스크립트의 셋째 줄에 무엇이 있는지 모르고 허용하게 하면 안 된다.
   */
  if (tool === "Bash") {
    const command = str(input["command"]);
    if (command.length <= MAX_DETAIL && !/[\r\n]/.test(command)) return [];
    return normalize(command).split("\n").map((text) => ({ kind: /** @type {const} */ ("ctx"), text }));
  }
  return [];
}

/**
 * @typedef {object} Approver
 * @property {(tool: string, input: Record<string, unknown>) => Promise<Decision>} decide
 * @property {() => string[]} remembered   이번 세션에 "묻지 않음" 으로 둔 것들
 */

/**
 * @param {object} args
 * @param {(question: string, options: string[], opts: { header?: string, preview?: PreviewLine[] }) => Promise<string[]>} args.ask
 *        실제로 사람에게 묻는 함수. 답이 없으면 빈 배열
 * @param {(entry: { tool: string, input: Record<string, unknown>, allowed: boolean, how: string }) => void} [args.onDecision]
 *        허용·거부를 기록에 남긴다
 * @param {Set<string>} [args.always]  "이번 세션 동안 묻지 않음" 기억. 턴을 넘어 살아야 해서 호출부가 쥔다
 * @param {(path: string) => string | null} [args.readText]  미리보기용 파일 읽기
 * @returns {Approver}
 */
export function createApprover({ ask, onDecision, always = new Set(), readText = readTextOrNull }) {
  return {
    remembered: () => [...always],
    async decide(tool, input) {
      const safeInput = input && typeof input === "object" ? input : {};
      const key = approvalKey(tool, safeInput);
      const what = describeToolUse(tool, safeInput);

      if (always.has(key)) {
        onDecision?.({ tool, input: safeInput, allowed: true, how: "세션 허용" });
        return { behavior: "allow", updatedInput: safeInput };
      }

      const YES = "예";
      const ALWAYS = `예, 이번 세션 동안 ${key}은(는) 묻지 않음`;
      const NO = "아니오";
      /** @type {string[]} */
      let answers = [];
      try {
        const preview = previewToolUse(tool, safeInput, readText);
        answers = await ask(`${what}\n실행할까요?`, [YES, ALWAYS, NO], {
          header: "권한",
          ...(preview.length ? { preview } : {}),
        });
      } catch {
        answers = [];
      }
      const picked = answers[0] ?? "";

      if (picked === YES || picked === ALWAYS) {
        if (picked === ALWAYS) always.add(key);
        onDecision?.({ tool, input: safeInput, allowed: true, how: picked === ALWAYS ? "허용(이후 묻지 않음)" : "허용" });
        return { behavior: "allow", updatedInput: safeInput };
      }
      /*
       * 답이 없으면 거부다. 묻지도 못했는데 허용하면 이 모듈이 있는 이유가 없다.
       * 모델에게는 사람이 막았다는 사실을 그대로 알린다 — 그래야 우회하려고
       * 같은 일을 다른 도구로 다시 시도하지 않는다.
       */
      onDecision?.({ tool, input: safeInput, allowed: false, how: picked === NO ? "거부" : "응답 없음" });
      return {
        behavior: "deny",
        message: picked === NO
          ? "사용자가 이 작업을 거부했습니다. 같은 일을 다른 도구로 우회하지 말고, 거부된 사실을 결과에 적으세요."
          : "승인할 사람이 없는 실행이라 거부됐습니다. 우회하지 말고, 하지 못한 일을 결과에 적으세요.",
      };
    },
  };
}
