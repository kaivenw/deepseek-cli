import type { Tool } from "./types.js";

export const taskTool: Tool = {
  name: "task",
  description:
    "Delegate a self-contained sub-task to an isolated sub-agent that has its own fresh context and the " +
    "standard tools (read_file, search_text, list_files, edit_file, bash, etc.). Returns the sub-agent's " +
    "final answer. Use it for focused research or multi-step work you want handled separately so it does " +
    "not clutter the main conversation. Provide a complete, standalone prompt — the sub-agent cannot see " +
    "this conversation.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The complete, standalone task for the sub-agent (it has no other context).",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional allowlist of tool names the sub-agent may use (defaults to all except 'task').",
      },
    },
    required: ["prompt"],
  },
  preview(args) {
    return `task: ${String(args.prompt ?? "").slice(0, 80)}`;
  },
  async run(args, ctx) {
    if (!ctx.runSubagent) {
      return { content: "Sub-agent execution is not available in this context.", isError: true };
    }
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
      return { content: "task requires a non-empty 'prompt'.", isError: true };
    }
    const tools = Array.isArray(args.tools) ? args.tools.map(String) : undefined;
    const answer = await ctx.runSubagent(prompt, tools ? { tools } : undefined);
    return { content: answer, summary: "task complete" };
  },
};
