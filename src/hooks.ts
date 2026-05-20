import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "./project.js";

export type HookEvent = "preToolUse" | "postToolUse" | "userPromptSubmit" | "sessionStart" | "stop";

/** Events whose hooks can abort the action when they fail (and continueOnError is not set). */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["preToolUse", "userPromptSubmit"]);

export interface HookSpec {
  command: string;
  timeoutMs?: number;
  continueOnError?: boolean;
}

export interface HookConfig {
  preToolUse?: HookSpec[];
  postToolUse?: HookSpec[];
  userPromptSubmit?: HookSpec[];
  sessionStart?: HookSpec[];
  stop?: HookSpec[];
}

export interface HookContext {
  toolName?: string;
  preview?: string;
  prompt?: string;
  status?: "success" | "error";
}

export interface HookRunResult {
  command: string;
  ok: boolean;
  output: string;
  blocking: boolean;
}

export function hooksPath(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".deepseek", "hooks.json");
}

export function createHooksTemplate(cwd: string): { path: string; created: boolean } {
  const file = hooksPath(cwd);
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const template: HookConfig = {
    preToolUse: [
      {
        command: "echo preToolUse:$DEEPSEEK_TOOL_NAME",
        timeoutMs: 10000,
        continueOnError: true,
      },
    ],
    postToolUse: [
      {
        command: "echo postToolUse:$DEEPSEEK_TOOL_NAME:$DEEPSEEK_TOOL_STATUS",
        timeoutMs: 10000,
        continueOnError: true,
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + "\n", "utf8");
  return { path: file, created: true };
}

const HOOK_EVENTS: HookEvent[] = ["preToolUse", "postToolUse", "userPromptSubmit", "sessionStart", "stop"];

export function loadHooks(cwd: string): HookConfig {
  const file = hooksPath(cwd);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HookConfig;
    const config: HookConfig = {};
    for (const event of HOOK_EVENTS) {
      const list = (parsed as Record<string, unknown>)[event];
      config[event] = Array.isArray(list) ? list.filter(isHookSpec) : [];
    }
    return config;
  } catch {
    return {};
  }
}

function isHookSpec(value: unknown): value is HookSpec {
  return !!value && typeof value === "object" && typeof (value as HookSpec).command === "string" && Boolean((value as HookSpec).command.trim());
}

export function runHooks(event: HookEvent, cwd: string, context: HookContext): HookRunResult[] {
  const config = loadHooks(cwd);
  const hooks = config[event] ?? [];
  const results: HookRunResult[] = [];

  for (const hook of hooks) {
    const command = hook.command.trim();
    const blocking = BLOCKING_EVENTS.has(event) && hook.continueOnError !== true;
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf8",
        shell: process.env.SHELL || "/bin/sh",
        timeout: Math.min(Math.max(hook.timeoutMs ?? 30000, 1000), 600000),
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          DEEPSEEK_HOOK_EVENT: event,
          DEEPSEEK_TOOL_NAME: context.toolName ?? "",
          DEEPSEEK_TOOL_PREVIEW: context.preview ?? "",
          DEEPSEEK_TOOL_STATUS: context.status ?? "",
          DEEPSEEK_PROMPT: context.prompt ?? "",
        },
      });
      results.push({ command, ok: true, output: output.trim(), blocking });
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const output = [e.stdout, e.stderr, e.message].filter(Boolean).map(String).join("\n").trim();
      results.push({ command, ok: false, output, blocking });
      if (blocking) break;
    }
  }

  return results;
}
