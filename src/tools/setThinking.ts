import type { ThinkingMode } from "../config.js";
import type { Tool } from "./types.js";

function normalize(raw: string): ThinkingMode | null {
  const v = raw.trim().toLowerCase();
  if (["off", "hide", "none", "disable", "false"].includes(v)) return "off";
  if (["collapsed", "short", "fold"].includes(v)) return "collapsed";
  if (["full", "on", "show", "all", "enable", "true"].includes(v)) return "full";
  return null;
}

export const setThinkingTool: Tool = {
  name: "set_thinking",
  description:
    "Show or hide your own reasoning/thinking trace in the terminal. Call this ONLY when the user " +
    "explicitly asks to turn the thinking/reasoning display on or off (e.g. \"关闭思考\", \"显示你的思考\", " +
    "\"hide your thinking\", \"show reasoning\"). mode: off = hide, full = show everything, collapsed = show first lines.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "off (hide), full/on (show all), or collapsed (show first lines).",
      },
    },
    required: ["mode"],
  },
  preview(args) {
    return `set thinking display: ${String(args.mode)}`;
  },
  async run(args, ctx) {
    const mode = normalize(String(args.mode ?? ""));
    if (!mode) {
      return { content: `Invalid mode '${String(args.mode)}'. Use off, collapsed, or full.`, isError: true };
    }
    if (!ctx.setThinkingMode) {
      return { content: "Thinking display cannot be changed in this context.", isError: true };
    }
    ctx.setThinkingMode(mode);
    const label = mode === "off" ? "hidden" : mode === "collapsed" ? "collapsed (first lines)" : "full";
    return {
      content: `Thinking display is now ${label}. This takes effect on the next reply.`,
      summary: `thinking display → ${mode}`,
    };
  },
};
