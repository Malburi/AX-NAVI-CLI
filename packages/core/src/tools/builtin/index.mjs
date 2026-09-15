/* 기본 도구 묶음. 이름은 기존 agents/*.md의 frontmatter `tools:`와 정확히 일치해야 한다. */
import { ToolRegistry } from "../gateway.mjs";
import { editTool, globTool, readTool, writeTool } from "./fs.mjs";
import { grepTool } from "./search.mjs";
import { bashTool } from "./shell.mjs";
import { queryIndexTool } from "./index-query.mjs";
import { askUserQuestionTool, taskUpdateTool } from "./interaction.mjs";

/** @returns {ToolRegistry} */
export function createDefaultRegistry() {
  return new ToolRegistry()
    .register(readTool)
    .register(grepTool)
    .register(globTool)
    .register(bashTool)
    .register(writeTool)
    .register(editTool)
    .register(queryIndexTool)
    .register(askUserQuestionTool)
    .register(taskUpdateTool);
}

export { readTool, writeTool, editTool, globTool, grepTool, bashTool, queryIndexTool, askUserQuestionTool, taskUpdateTool };
