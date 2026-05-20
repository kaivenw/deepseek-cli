import { select } from "@inquirer/prompts";
import { chalk } from "./ui/render.js";

export type PermissionDecision = "approve" | "always" | "deny";

export interface PermissionManager {
  /** Returns true if the tool may run without prompting. */
  isAllowed(toolName: string): boolean;
  /** Prompt the user to approve a single tool invocation. */
  request(toolName: string, previewLine: string): Promise<PermissionDecision>;
  /** Mark a tool as always-allowed for the rest of the session. */
  allowForSession(toolName: string): void;
}

export function createPermissionManager(opts: {
  /** Skip all prompts (e.g. --yes / dangerous auto-approve). */
  autoApprove: boolean;
  /** Tools persisted as always-allow in config. */
  preApproved: string[];
}): PermissionManager {
  const sessionAllow = new Set<string>(opts.preApproved);

  return {
    isAllowed(toolName) {
      return opts.autoApprove || sessionAllow.has(toolName);
    },
    allowForSession(toolName) {
      sessionAllow.add(toolName);
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
