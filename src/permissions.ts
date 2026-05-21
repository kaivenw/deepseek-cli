import { select } from "@inquirer/prompts";
import { chalk } from "./ui/render.js";

export type PermissionDecision = "approve" | "always" | "deny";

/** Permission modes, cycled with Shift+Tab (like Claude Code). */
export type PermissionMode = "default" | "acceptEdits" | "plan";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "accept edits";
    case "plan":
      return "plan mode";
    default:
      return "normal";
  }
}

/** Tools considered "edits" that auto-accept mode approves automatically. */
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

export interface PermissionManager {
  /** Returns true if the tool may run without prompting (session allow / --yes). */
  isAllowed(toolName: string): boolean;
  /** Decide how a side-effecting tool should be handled under the current mode. */
  evaluate(toolName: string): "allow" | "deny" | "ask";
  /** Prompt the user to approve a single tool invocation. */
  request(toolName: string, previewLine: string): Promise<PermissionDecision>;
  /** Mark a tool as always-allowed for the rest of the session. */
  allowForSession(toolName: string): void;
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  /** Advance to the next mode and return it. */
  cycleMode(): PermissionMode;
}

export function createPermissionManager(opts: {
  /** Skip all prompts (e.g. --yes / dangerous auto-approve). */
  autoApprove: boolean;
  /** Tools persisted as always-allow in config. */
  preApproved: string[];
}): PermissionManager {
  const sessionAllow = new Set<string>(opts.preApproved);
  let mode: PermissionMode = "default";

  const isAllowed = (toolName: string): boolean => opts.autoApprove || sessionAllow.has(toolName);

  return {
    isAllowed,
    evaluate(toolName) {
      if (isAllowed(toolName)) return "allow";
      if (mode === "plan") return "deny";
      if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return "allow";
      return "ask";
    },
    allowForSession(toolName) {
      sessionAllow.add(toolName);
    },
    getMode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
    cycleMode() {
      mode = PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
      return mode;
    },
    async request(toolName, previewLine) {
      console.log();
      console.log(chalk.yellow("  ⚠ Permission required") + chalk.dim(` — ${toolName}`));
      console.log("  " + chalk.white(previewLine));

      const decision = await select<PermissionDecision>({
        message: "Allow this action?",
        choices: [
          { name: "Yes, once", value: "approve" },
          { name: `Yes, and don't ask again for ${toolName} this session`, value: "always" },
          { name: "No, and tell the model what to do differently", value: "deny" },
        ],
      });
      if (decision === "always") sessionAllow.add(toolName);
      return decision;
    },
  };
}
