export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  /** Text fed back to the model as the tool result. */
  content: string;
  /** Short human-readable line shown in the terminal. */
  summary?: string;
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
