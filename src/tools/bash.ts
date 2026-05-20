import { exec, type ExecException } from "node:child_process";
import type { Tool } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command in the working directory and return its stdout/stderr. " +
    "Use for running builds, tests, git, and other shell tasks. Avoid destructive commands.",
  needsApproval: true,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds (optional, default ${DEFAULT_TIMEOUT}, max 600000).`,
      },
    },
    required: ["command"],
  },
  preview(args) {
    return String(args.command);
  },
  run(args, ctx) {
    const command = String(args.command);
    const timeout = Math.min(Number(args.timeout) || DEFAULT_TIMEOUT, 600_000);

    return new Promise((resolve) => {
      exec(
        command,
        { cwd: ctx.cwd, timeout, maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" },
        (error, stdout, stderr) => {
          let out = "";
          if (stdout) out += stdout;
          if (stderr) out += (out ? "\n" : "") + stderr;
          out = out.trim();

          if (out.length > MAX_OUTPUT) {
            out = out.slice(0, MAX_OUTPUT) + `\n…[output truncated, ${out.length} chars total]`;
          }

          const execErr = error as ExecException | null;
          const exitCode = execErr && typeof execErr.code === "number" ? execErr.code : 0;
          const timedOut = Boolean(execErr && execErr.signal === "SIGTERM");

          if (timedOut) {
            resolve({
              content: `Command timed out after ${timeout}ms.\n${out}`,
              summary: `$ ${command} (timed out)`,
              isError: true,
            });
            return;
          }

          const header = exitCode === 0 ? "" : `[exit code ${exitCode}]\n`;
          resolve({
            content: (header + out).trim() || "(no output)",
            summary: `$ ${command}`,
            isError: exitCode !== 0,
          });
        },
      );
    });
  },
};
