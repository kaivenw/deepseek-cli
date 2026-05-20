import type OpenAI from "openai";
import type { Tool } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { webSearchTool } from "./webSearch.js";
import { webFetchTool } from "./webFetch.js";

export type { Tool, ToolContext, ToolResult } from "./types.js";

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  webSearchTool,
  webFetchTool,
];

const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOL_MAP.get(name);
}

/** Convert our tool definitions into the OpenAI function-calling schema. */
export function toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return ALL_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
