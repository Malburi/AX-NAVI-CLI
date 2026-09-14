/*
 * AskUserQuestion / TaskUpdate — Claude Code 호스트 기능의 대체물.
 *
 * 둘 다 MVP에서 거의 쓰이지 않는다. 그런데도 1일차에 넣는 이유가 있다(계획 R7).
 * MVP가 검증하는 소비자는 읽기 전용 에이전트 하나뿐인데, 그 하나에만 맞춰 Gateway를
 * 만들면 나중에 harness-init(834줄, 승인 지점·작업 그래프·다중 에이전트)을 얹을 때
 * Gateway를 다시 설계해야 한다. 자리를 먼저 잡아 두는 비용이 훨씬 싸다.
 */

/** @typedef {import("../../../types/tools.js").ToolHandler} ToolHandler */

/** @type {ToolHandler} */
export const askUserQuestionTool = {
  definition: {
    name: "AskUserQuestion",
    // Claude Code에는 한 질문에 옵션 4개 상한이 있었고, 그 상한 때문에 5번째 선택지(허브형 1:N)가
    // 조용히 잘려나간 사고가 실제로 있었다(skills/harness-init/SKILL.md:38, 2026-07-30).
    // CLI에는 그 제약이 없으므로 옵션 수를 제한하지 않는다.
    description: "사용자에게 선택을 묻는다. 옵션 개수에 상한이 없다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        multiSelect: { type: "boolean" },
      },
    },
  },
  async run(input, ctx) {
    const answers = await ctx.elicitor.ask(
      input.question,
      input.options ?? [],
      input.multiSelect === undefined ? {} : { multiSelect: input.multiSelect },
    );
    return { content: answers.length ? answers.join(", ") : "(응답 없음)" };
  },
};

/** @type {ToolHandler} */
export const taskUpdateTool = {
  definition: {
    name: "TaskUpdate",
    description: "작업 진행 상태를 갱신한다. 기존 에이전트 지침이 부르던 자리를 받아 준다.",
    mutates: false,
    inputSchema: {
      type: "object",
      required: ["taskId", "status"],
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
        title: { type: "string" },
      },
    },
  },
  async run(input, ctx) {
    ctx.progress.update(input.taskId, input.status, input.title);
    return { content: `${input.taskId} → ${input.status}` };
  },
};
