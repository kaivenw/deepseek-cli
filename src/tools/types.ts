import type { ThinkingMode } from "../config.js";
import type { TodoStore } from "../todo.js";

export interface ToolContext {
  cwd: string;
  /** Change how the assistant's reasoning trace is displayed (set by the agent). */
  setThinkingMode?(mode: ThinkingMode): void;
  /** Read the current reasoning-display mode. */
  getThinkingMode?(): ThinkingMode;
  /** Shared task list used by todo_read/todo_write. */
  todoStore?: TodoStore;
  /** Run an isolated sub-agent to completion and return its final answer. */
  runSubagent?(prompt: string, opts?: { tools?: string[] }): Promise<string>;
  /** Record a file's pre-change content into the active checkpoint (null = file did not exist). */
  recordFileBackup?(absPath: string, previousContent: string | null): void;
}

export interface ToolResult {
  /** Text fed back to the model as the tool result. */
  content: string;
  /** Short human-readable line shown in the terminal. */
  summary?: string;
  /** Optional multi-line block (e.g. a diff) the terminal renders under the summary. */
  display?: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the parameters object. */
  parameters: Record<string, unknown>;
  /** Whether running this tool needs user approval (write/exec side effects). */
  needsApproval: boolean;
  /** A one-line preview of what the call will do, shown in the approval prompt. */
  preview?(args: Record<string, unknown>, ctx: ToolContext): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
