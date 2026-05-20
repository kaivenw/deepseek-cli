#!/usr/bin/env node
import { Command } from "commander";
import { confirm, password } from "@inquirer/prompts";
import { loadConfig, saveConfig, findModel, normalizeThinkingMode, type Config } from "./config.js";
import { Agent } from "./agent.js";
import { createPermissionManager } from "./permissions.js";
import { startRepl } from "./ui/repl.js";
import { loadSession, saveSession } from "./session.js";
import { ui, chalk } from "./ui/render.js";
import { loadMcpTools, shutdownMcp } from "./mcp.js";
import { clearExternalTools, registerExternalTools } from "./tools/index.js";

interface CliOptions {
  model?: string;
  print?: boolean;
  yes?: boolean;
  apiKey?: string;
  thinking?: string;
  showThinking?: boolean;
  hideThinking?: boolean;
  /** Commander stores --continue under this property name. */
  continue?: boolean;
  resume?: boolean;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function ensureApiKey(config: Config): Promise<boolean> {
  if (config.apiKey) return true;

  if (!process.stdin.isTTY) {
    ui.error("No DeepSeek API key found.");
    ui.info("Set DEEPSEEK_API_KEY, or run interactively to enter one.");
    return false;
  }

  ui.warn("No DeepSeek API key found.");
  ui.info("Get one at https://platform.deepseek.com/api_keys");
  const key = await password({ message: "Enter your DeepSeek API key:", mask: "*" });
  if (!key.trim()) {
    ui.error("No key entered.");
    return false;
  }
  config.apiKey = key.trim();

  const save = await confirm({
    message: "Save this key to ~/.deepseek-cli/config.json?",
    default: true,
  });
  if (save) {
    saveConfig(config);
    ui.success("Saved.");
  }
  return true;
}

process.once("exit", () => shutdownMcp());

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("deepseek")
    .description("An agentic coding CLI for DeepSeek models")
    .version("0.1.0")
    .argument("[prompt...]", "run a one-shot prompt instead of the interactive REPL")
    .option("-m, --model <model>", "model to use (e.g. deepseek-v4-pro, deepseek-v4-flash)")
    .option("-p, --print", "print mode: run the prompt once and exit")
    .option("--api-key <key>", "DeepSeek API key (overrides config/env)")
    .option("-y, --yes", "auto-approve all tool actions (use with care)")
    .option("--thinking <mode>", "reasoning display: off | collapsed | full (overrides config)")
    .option("--show-thinking", "alias for --thinking full")
    .option("--hide-thinking", "alias for --thinking off")
    .option("--continue", "continue the saved session for this project before running the prompt")
    .option("--resume", "alias for --continue")
    .allowExcessArguments(true);

  program.parse();
  const opts = program.opts<CliOptions>();
  const promptArgs = program.args;

  const config = loadConfig();
  if (opts.apiKey) {
    config.apiKey = opts.apiKey;
    config.apiKeyFromEnv = true; // treat CLI-provided key as ephemeral
  }
  if (opts.model) {
    config.model = opts.model;
    if (!findModel(opts.model) && !opts.model.startsWith("deepseek")) {
      ui.warn(`Note: '${opts.model}' is not a recognized DeepSeek model.`);
    }
  }
  // Per-run override of the thinking-display preference (not persisted).
  const thinkingOverride =
    normalizeThinkingMode(opts.thinking) ??
    (opts.hideThinking ? "off" : opts.showThinking ? "full" : undefined);
  if (thinkingOverride) config.thinkingMode = thinkingOverride;

  if (!(await ensureApiKey(config))) {
    process.exit(1);
  }

  const ctx = { cwd: process.cwd() };
  const permissions = createPermissionManager({
    autoApprove: Boolean(opts.yes),
    preApproved: config.alwaysAllow,
  });
  clearExternalTools();
  const mcp = await loadMcpTools(process.cwd());
  registerExternalTools(mcp.tools);
  for (const error of mcp.errors) ui.warn(`MCP: ${error}`);

  const agent = new Agent(config, permissions, ctx);
  const shouldContinue = Boolean(opts.continue || opts.resume);
  if (shouldContinue) {
    const session = loadSession(process.cwd());
    if (session && (session.messages.length > 1 || session.contextSummary)) {
      agent.restoreSession(session);
      ui.info(`Continuing saved session (${agent.messageCount()} messages${agent.getContextSummary() ? ", compressed context active" : ""}).`);
    } else {
      ui.warn("No saved session found for this project; starting fresh.");
    }
  }

  // One-shot when args/-p are given, or when stdin is piped (not a TTY).
  let prompt = promptArgs.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) {
    prompt = (await readStdin()).trim();
  }
  const oneShot = opts.print || prompt.length > 0;

  if (oneShot) {
    if (!prompt) {
      ui.error("No prompt provided for print mode.");
      process.exit(1);
    }
    try {
      await agent.run(prompt);
      saveSession(process.cwd(), agent.getSession());
      process.exit(0);
    } catch (err) {
      ui.error(`\nError: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  await startRepl(agent, config);
  process.exit(0);
}

main().catch((err) => {
  if (err?.name === "ExitPromptError") {
    console.log(chalk.dim("\nGoodbye."));
    process.exit(0);
  }
  ui.error(`Fatal: ${err?.message ?? err}`);
  process.exit(1);
});
