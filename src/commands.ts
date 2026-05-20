import fs from "node:fs";
import { execSync } from "node:child_process";
import { select } from "@inquirer/prompts";
import type { Agent } from "./agent.js";
import {
  MODELS,
  findModel,
  saveConfig,
  configPath,
  normalizeThinkingMode,
  type Config,
  type ThinkingMode,
} from "./config.js";
import { findProjectRoot, loadProjectMemory, projectMemoryTarget } from "./project.js";
import {
  createSkillTemplate,
  findSkillCommand,
  globalSkillDir,
  loadSkillCommands,
  projectSkillDir,
  renderSkillPrompt,
} from "./skills.js";
import {
  installPlugin,
  listPlugins,
  marketplaceSource,
  pluginSkillCount,
  pluginsDir,
  removePlugin,
  resolveInstallSource,
  scaffoldPlugin,
  searchMarketplace,
  setPluginEnabled,
  updatePlugin,
} from "./plugins.js";
import { ALL_TOOLS, clearExternalTools, registerExternalTools } from "./tools/index.js";
import { ui, chalk } from "./ui/render.js";
import { saveSession, loadSession, deleteSession } from "./session.js";
import { createHooksTemplate, hooksPath, loadHooks } from "./hooks.js";
import { claudeMcpPath, createMcpTemplate, globalMcpPath, loadMcpTools, mcpStatus, projectMcpPath } from "./mcp.js";

export interface CommandResult {
  exit?: boolean;
}

export interface CommandContext {
  agent: Agent & { listModels(): Promise<{ id: string }[]> };
  config: Config;
}

export interface CommandInfo {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "help", aliases: ["?"], usage: "/help", description: "show this help" },
  { name: "model", usage: "/model", description: "choose a model with arrow keys" },
  { name: "models", usage: "/models", description: "fetch and list available DeepSeek models" },
  { name: "skills", usage: "/skills", description: "list custom skill commands" },
  { name: "skill-new", usage: "/skill-new <name>", description: "create a project skill template" },
  { name: "plugin", aliases: ["plugins"], usage: "/plugin <list|search|install|new|remove|...>", description: "install and manage plugins" },
  { name: "mcp", usage: "/mcp <list|init|reload>", description: "manage MCP stdio servers and tools" },
  { name: "hooks", usage: "/hooks [init|list]", description: "manage tool-use shell hooks" },
  { name: "init", usage: "/init", description: "create DEEPSEEK.md project instructions" },
  { name: "memory", usage: "/memory", description: "show loaded project instruction files" },
  { name: "tools", usage: "/tools", description: "list available tools" },
  { name: "todos", aliases: ["todo"], usage: "/todos", description: "show the current task list" },
  { name: "thinking", usage: "/thinking [on|off|collapsed|full]", description: "toggle/set the reasoning trace display (bare = on/off)" },
  { name: "config", usage: "/config", description: "show current configuration" },
  { name: "review", usage: "/review [ref]", description: "review local git changes (or a diff against <ref>)" },
  { name: "task", usage: "/task <prompt>", description: "run an isolated subagent-style task" },
  { name: "doctor", usage: "/doctor", description: "check environment and configuration health" },
  { name: "usage", usage: "/usage", description: "show token usage for this session" },
  { name: "compress", usage: "/compress", description: "compress conversation context into a durable summary" },
  { name: "save", usage: "/save", description: "save current session to disk" },
  { name: "resume", usage: "/resume", description: "restore saved session for this project" },
  { name: "clear", usage: "/clear", description: "clear conversation history and saved session" },
  {
    name: "exit",
    aliases: ["quit", "q"],
    usage: "/exit",
    description: "quit (auto-saves session; exit/quit/q also work)",
  },
];

const BARE_COMMANDS = new Set(["exit", "quit", "q"]);

function commandNames(command: CommandInfo): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

function scoreMatch(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (c === q) return 100;
  if (c.startsWith(q)) return 90 - (c.length - q.length);
  if (c.includes(q)) return 70 - c.indexOf(q);

  let qi = 0;
  for (const char of c) {
    if (char === q[qi]) qi++;
    if (qi === q.length) return 50 - (c.length - q.length);
  }

  const distance = editDistance(q, c);
  const maxDistance = Math.max(1, Math.floor(Math.max(q.length, c.length) * 0.4));
  if (distance <= maxDistance) return 45 - distance * 5;

  return 0;
}

function preferModel(a: string, b: string): number {
  const score = (id: string) => {
    const normalized = id.toLowerCase();
    if (normalized.includes("v4") && normalized.includes("pro")) return 100;
    if (normalized.includes("pro")) return 90;
    if (normalized.includes("v4") && normalized.includes("flash")) return 80;
    if (normalized.includes("flash")) return 70;
    if (normalized.includes("deepseek")) return 50;
    return 0;
  };

  return score(b) - score(a) || a.localeCompare(b);
}

function labelForModel(id: string): string {
  const known = findModel(id);
  if (known) return known.label;
  return id;
}

function descriptionForModel(id: string): string {
  const known = findModel(id);
  if (known) return known.description;
  return id.includes("deepseek") ? "Available from DeepSeek API" : "Available model";
}

async function listAvailableModelIds(ctx: CommandContext): Promise<{ ids: string[]; source: string }> {
  try {
    const apiModels = await ctx.agent.listModels();
    const ids = apiModels
      .map((model) => model.id)
      .filter((id) => id.toLowerCase().includes("deepseek"))
      .sort(preferModel);

    if (ids.length > 0) return { ids, source: "DeepSeek API" };
  } catch (err) {
    ui.warn(`Could not fetch models from API: ${(err as Error).message}`);
  }

  return { ids: MODELS.map((model) => model.id).sort(preferModel), source: "local fallback" };
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function allCommands(cwd?: string): CommandInfo[] {
  const skills = cwd
    ? loadSkillCommands(cwd).map((skill) => ({
        name: skill.name,
        usage: skill.usage,
        description: `${skill.description} (${skill.scope} skill)`,
      }))
    : [];
  return [...COMMANDS, ...skills];
}

interface CommandSuggestionOptions {
  limit?: number;
  cwd?: string;
}

export function suggestCommands(query: string, options: CommandSuggestionOptions = {}): CommandInfo[] {
  const { limit = 6, cwd } = options;
  const normalized = query.trim().replace(/^\//, "");
  return allCommands(cwd).map((command) => ({
    command,
    score: Math.max(...commandNames(command).map((name) => scoreMatch(normalized, name))),
  }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
    .slice(0, limit)
    .map((match) => match.command);
}

export function suggestModels(query: string, limit = 6): string[] {
  const normalized = query.trim();
  const aliases: Record<string, string> = {
    pro: "deepseek-v4-pro",
    flash: "deepseek-v4-flash",
    v4pro: "deepseek-v4-pro",
    v4flash: "deepseek-v4-flash",
  };
  const candidates = [...MODELS.map((model) => model.id), ...Object.keys(aliases)];

  return candidates
    .map((candidate) => ({ candidate, score: scoreMatch(normalized, candidate) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .map((match) => aliases[match.candidate] ?? match.candidate)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, limit);
}

function parseCommand(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("/")) return trimmed.slice(1);
  if (BARE_COMMANDS.has(trimmed.toLowerCase())) return trimmed;
  return null;
}

/** Returns true if the input was handled as a slash command. */
export function isCommand(input: string): boolean {
  return parseCommand(input) !== null;
}

export async function runCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const commandText = parseCommand(input);
  if (commandText === null) return {};

  if (!commandText.trim()) {
    printHelp();
    return {};
  }

  const [cmd, ...rest] = commandText.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case "help":
    case "?":
      printHelp();
      return {};

    case "exit":
    case "quit":
    case "q":
      return { exit: true };

    case "clear":
      ctx.agent.reset();
      deleteSession(ctx.agent.getCwd());
      console.clear();
      ui.success("Conversation cleared.");
      return {};

    case "save":
      saveSession(ctx.agent.getCwd(), ctx.agent.getSession());
      ui.success(`Session saved (${ctx.agent.messageCount()} messages).`);
      return {};

    case "resume": {
      const data = loadSession(ctx.agent.getCwd());
      if (!data || (data.messages.length <= 1 && !data.contextSummary)) {
        ui.warn("No saved session found for this project.");
        return {};
      }
      ctx.agent.restoreSession(data);
      ui.success(`Session restored (${ctx.agent.messageCount()} messages${ctx.agent.getContextSummary() ? ", compressed context active" : ""}).`);
      return {};
    }

    case "review":
      await handleReview(rest.join(" ").trim(), ctx);
      return {};

    case "doctor":
      handleDoctor(ctx);
      return {};

    case "task":
      await handleTask(rest.join(" ").trim(), ctx);
      return {};

    case "usage":
      if (ctx.agent.totalUsage.totalTokens > 0) {
        ui.usage(ctx.agent.totalUsage);
      } else {
        ui.info("No token usage recorded yet.");
      }
      return {};

    case "compress":
      await handleCompress(ctx);
      return {};

    case "model":
      await handleModel(ctx);
      return {};

    case "models":
      await printModels(ctx);
      return {};

    case "skills":
      printSkills(ctx);
      return {};

    case "skill-new":
      handleSkillNew(rest.join(" ").trim(), ctx);
      return {};

    case "plugin":
    case "plugins":
      await handlePlugin(rest);
      return {};

    case "mcp":
      await handleMcp(rest, ctx);
      return {};

    case "hooks":
      handleHooks(rest[0] ?? "list", ctx);
      return {};

    case "init":
      await handleInit(ctx);
      return {};

    case "memory":
      printMemory(ctx);
      return {};

    case "tools":
      printTools();
      return {};

    case "todos":
    case "todo":
      printTodos(ctx);
      return {};

    case "thinking":
      handleThinking(rest.join(" ").trim(), ctx);
      return {};

    case "config":
      printConfig(ctx.config);
      return {};

    default:
      if (await runSkillCommand(cmd, rest.join(" ").trim(), ctx)) return {};
      printUnknownCommand(cmd, ctx);
      return {};
  }
}

async function runSkillCommand(cmd: string, arg: string, ctx: CommandContext): Promise<boolean> {
  const skill = findSkillCommand(ctx.agent.getCwd(), cmd);
  if (!skill) return false;

  const prompt = renderSkillPrompt(skill, arg, ctx.agent.getCwd());
  await ctx.agent.run(prompt);
  return true;
}

async function handleCompress(ctx: CommandContext): Promise<void> {
  try {
    const result = await ctx.agent.compressContext("manual");
    if (!result.compressed) {
      ui.info("No conversation history to compress yet.");
      if (result.summary) {
        ui.info("A compressed summary is already active.");
      }
      return;
    }

    saveSession(ctx.agent.getCwd(), ctx.agent.getSession());
    ui.success(
      `Context compressed: ${result.messagesBefore} messages, ~${result.estimatedTokensBefore.toLocaleString()} tokens -> ${result.summaryChars.toLocaleString()} chars summary.`,
    );
    ui.info("The summary is now pinned into the next requests and saved with this project session.");
    ui.divider();
    console.log(chalk.bold("Compressed context summary"));
    console.log(chalk.dim(result.summary));
    ui.divider();
  } catch (err) {
    ui.error(`Could not compress context: ${(err as Error).message}`);
  }
}

function printUnknownCommand(cmd: string, ctx: CommandContext): void {
  ui.warn(`Unknown command: /${cmd}.`);
  const suggestions = suggestCommands(cmd, { limit: 4, cwd: ctx.agent.getCwd() });
  if (suggestions.length === 0) {
    ui.info("Type /help for the command list.");
    return;
  }

  ui.info("Did you mean:");
  for (const command of suggestions) {
    console.log(`  ${chalk.cyan(command.usage.padEnd(14))} ${chalk.dim(command.description)}`);
  }
}

function buildInitPrompt(root: string, target: string, exists: boolean): string {
  return [
    `${exists ? "Review and update" : "Create"} the project instruction file at ${target}.`,
    `Project root: ${root}`,
    "",
    "Investigate the project FIRST using your tools, then write the file. Steps:",
    "1. Use glob to list top-level files and key directories; identify the project type.",
    "2. Read the most informative files only — package.json / pyproject.toml / go.mod / pom.xml / build.gradle / Cargo.toml, README.*, primary config and entry-point files. Use grep to locate scripts, frameworks, and conventions.",
    "3. Determine: what the project does, its tech stack and language(s), how the code is organized, the EXACT build/run/test/lint commands, and important conventions or caveats.",
    `4. Write ${target} with write_file using concise Markdown and these sections:`,
    "     # <Project name> — one to three sentences on what it does",
    "     ## Tech stack",
    "     ## Project structure  (key directories/files and their roles)",
    "     ## Commands  (exact build/run/test/lint commands taken from the project config)",
    "     ## Conventions & notes  (patterns to follow, gotchas, things to avoid)",
    "",
    "Rules: base everything on files you actually read — do NOT invent commands or features. Omit anything you cannot verify. Keep it under ~150 lines. End with a one-line summary of what you captured.",
  ].join("\n");
}

async function handleInit(ctx: CommandContext): Promise<void> {
  const root = findProjectRoot(ctx.agent.getCwd());
  const target = projectMemoryTarget(ctx.agent.getCwd());
  const exists = fs.existsSync(target);

  if (exists) {
    ui.warn(`${target} already exists — the agent will review the project and update it.`);
  } else {
    ui.info(`Analyzing the project to generate ${target} …`);
  }
  ui.info("You'll be asked to approve the file write.");

  await ctx.agent.run(buildInitPrompt(root, target, exists));

  // Pull the freshly written DEEPSEEK.md into the active system prompt.
  ctx.agent.reloadProjectContext();
  if (fs.existsSync(target)) {
    ui.success("Project context reloaded — DEEPSEEK.md is now part of this session.");
  }
}

function printMemory(ctx: CommandContext): void {
  const memory = loadProjectMemory(ctx.agent.getCwd());

  console.log();
  console.log(`  ${chalk.dim("project root:")} ${memory.root}`);
  if (memory.files.length === 0) {
    console.log(`  ${chalk.yellow("no project instruction files found")}`);
    console.log(`  ${chalk.dim("run /init to create DEEPSEEK.md")}`);
    console.log();
    return;
  }

  console.log(`  ${chalk.dim("loaded memory:")}`);
  for (const file of memory.files) {
    console.log(`  - ${file}`);
  }
  console.log();
}

function printSkills(ctx: CommandContext): void {
  const skills = loadSkillCommands(ctx.agent.getCwd());

  console.log();
  console.log(`  ${chalk.dim("project skills:")} ${projectSkillDir(ctx.agent.getCwd())}`);
  console.log(`  ${chalk.dim("global skills: ")} ${globalSkillDir()}`);
  if (skills.length === 0) {
    console.log(`  ${chalk.yellow("no custom skills found")}`);
    console.log(`  ${chalk.dim("run /skill-new <name> to create one")}`);
    console.log();
    return;
  }

  for (const skill of skills) {
    const origin = skill.plugin ? `plugin:${skill.plugin}` : skill.scope;
    console.log(`  ${chalk.cyan(skill.usage.padEnd(16))} ${chalk.dim(skill.description)}`);
    console.log(`  ${chalk.dim(`  ${origin}: ${skill.source}`)}`);
  }
  console.log();
}

function handleSkillNew(name: string, ctx: CommandContext): void {
  if (!name) {
    ui.warn("Usage: /skill-new <name>");
    return;
  }

  try {
    const result = createSkillTemplate(ctx.agent.getCwd(), name);
    if (result.created) {
      ui.success(`Created skill template: ${result.path}`);
    } else {
      ui.warn(`Skill already exists: ${result.path}`);
    }
    ui.info("Edit the file, then type / to see the new command.");
  } catch (err) {
    ui.error(`Could not create skill: ${(err as Error).message}`);
  }
}

async function handleMcp(args: string[], ctx: CommandContext): Promise<void> {
  const action = (args[0] ?? "list").toLowerCase();
  if (action === "init" || action === "add") {
    const scope = args[1] === "global" ? "global" : "project";
    const result = createMcpTemplate(ctx.agent.getCwd(), scope);
    if (result.created) ui.success(`Created MCP config: ${result.path}`);
    else ui.warn(`MCP config already exists: ${result.path}`);
    ui.info("Edit the config and run /mcp reload. Tool names will appear as mcp__server__tool.");
    ui.info("DeepSeek CLI also reads Claude-compatible .mcp.json files with mcpServers.");
    return;
  }

  if (action === "reload") {
    clearExternalTools();
    const loaded = await loadMcpTools(ctx.agent.getCwd());
    registerExternalTools(loaded.tools);
    ui.success(`Loaded ${loaded.infos.length} MCP tool${loaded.infos.length === 1 ? "" : "s"}.`);
    for (const error of loaded.errors) ui.warn(`MCP: ${error}`);
    return;
  }

  const status = mcpStatus();
  console.log();
  console.log(`  ${chalk.dim("project config:")} ${projectMcpPath(ctx.agent.getCwd())}`);
  console.log(`  ${chalk.dim("claude compat:")} ${claudeMcpPath(ctx.agent.getCwd())}`);
  console.log(`  ${chalk.dim("global config: ")} ${globalMcpPath()}`);
  if (status.infos.length === 0) {
    console.log(`  ${chalk.yellow("no MCP tools loaded")}`);
    console.log(`  ${chalk.dim("run /mcp init, edit the config, then /mcp reload")}`);
  } else {
    for (const info of status.infos) {
      console.log(`  ${chalk.cyan(info.toolName.padEnd(30))} ${chalk.dim(`${info.serverName}.${info.remoteName}`)}`);
      if (info.description) console.log(`     ${chalk.dim(info.description)}`);
    }
  }
  for (const error of status.errors) console.log(`  ${chalk.red("error:")} ${error}`);
  console.log();
}

function handleHooks(action: string, ctx: CommandContext): void {
  const normalized = action.toLowerCase();
  if (normalized === "init") {
    const result = createHooksTemplate(ctx.agent.getCwd());
    if (result.created) ui.success(`Created hooks config: ${result.path}`);
    else ui.warn(`Hooks config already exists: ${result.path}`);
    return;
  }

  const config = loadHooks(ctx.agent.getCwd());
  console.log();
  console.log(`  ${chalk.dim("hooks:")} ${hooksPath(ctx.agent.getCwd())}`);
  const pre = config.preToolUse ?? [];
  const post = config.postToolUse ?? [];
  if (pre.length === 0 && post.length === 0) {
    console.log(`  ${chalk.yellow("no hooks configured")}`);
    console.log(`  ${chalk.dim("run /hooks init to create .deepseek/hooks.json")}`);
    console.log();
    return;
  }
  for (const [label, hooks] of [["preToolUse", pre], ["postToolUse", post]] as const) {
    console.log(`  ${chalk.bold(label)}`);
    for (const hook of hooks) console.log(`  - ${chalk.cyan(hook.command)} ${chalk.dim(hook.continueOnError ? "(continue on error)" : "")}`);
  }
  console.log();
}

async function handlePlugin(args: string[]): Promise<void> {
  const action = (args[0] ?? "list").toLowerCase();
  const rest = args.slice(1);

  switch (action) {
    case "list":
    case "ls":
      printPlugins();
      return;
    case "search":
    case "find":
      await handlePluginSearch(rest.join(" ").trim());
      return;
    case "new":
    case "create":
    case "scaffold":
      handlePluginNew(rest[0]);
      return;
    case "install":
    case "add":
      await handlePluginInstall(rest.join(" ").trim());
      return;
    case "remove":
    case "uninstall":
    case "rm":
      handlePluginRemove(rest[0]);
      return;
    case "enable":
      handlePluginToggle(rest[0], true);
      return;
    case "disable":
      handlePluginToggle(rest[0], false);
      return;
    case "update":
    case "upgrade":
      handlePluginUpdate(rest[0]);
      return;
    default:
      ui.warn(`Unknown /plugin action: ${action}`);
      ui.info(
        "Usage: /plugin <list | search [query] | new <name> | install <name|src> | remove <name> | enable <name> | disable <name> | update <name>>",
      );
  }
}

async function handleReview(ref: string, ctx: CommandContext): Promise<void> {
  const cwd = ctx.agent.getCwd();
  const target = ref || "HEAD";

  let diff = "";
  try {
    diff = execSync(`git diff ${target}`, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!diff.trim() && target === "HEAD") {
      // Fall back to staged changes if the working tree is clean.
      diff = execSync("git diff --cached", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    }
  } catch {
    ui.error("Not a git repository, or git is unavailable.");
    return;
  }

  if (!diff.trim()) {
    ui.info("No changes to review.");
    return;
  }

  const MAX = 60_000;
  const clipped = diff.length > MAX ? diff.slice(0, MAX) + "\n…[diff truncated]" : diff;
  const prompt = [
    `Review the following git diff (\`git diff ${target}\`).`,
    "Focus on bugs, security issues, edge cases, and maintainability. Be concise and actionable;",
    "group findings by severity and reference file:line where possible. If it looks good, say so.",
    "",
    "```diff",
    clipped,
    "```",
  ].join("\n");

  await ctx.agent.run(prompt);
}

async function handleTask(prompt: string, ctx: CommandContext): Promise<void> {
  if (!prompt) {
    ui.warn("Usage: /task <prompt>");
    return;
  }
  ui.info("Running isolated task context; main conversation history will be preserved.");
  await ctx.agent.runIsolated([
    "Run this as a focused subagent task. Work independently, use tools as needed, and report concise findings/results.",
    "Do not assume access to the parent conversation beyond project memory, compressed context, and this prompt.",
    "",
    prompt,
  ].join("\n"));
}

function checkCommand(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

function handleDoctor(ctx: CommandContext): void {
  const ok = (b: boolean) => (b ? chalk.green("✓") : chalk.red("✗"));
  const warn = chalk.yellow("!");

  console.log();
  console.log(chalk.bold("  Environment"));
  console.log(`  ${chalk.green("✓")} node ${process.version}`);
  const git = checkCommand("git --version");
  console.log(`  ${git ? chalk.green("✓") : chalk.red("✗")} git ${git ? chalk.dim(git.replace("git version ", "")) : chalk.dim("not found")}`);
  const rg = checkCommand("rg --version");
  console.log(`  ${rg ? chalk.green("✓") : warn} ripgrep ${rg ? chalk.dim(rg.replace("ripgrep ", "")) : chalk.dim("not found (falls back to JS search)")}`);

  console.log();
  console.log(chalk.bold("  Configuration"));
  console.log(`  ${ok(Boolean(ctx.config.apiKey))} API key ${ctx.config.apiKey ? chalk.dim(ctx.config.apiKeyFromEnv ? "(from env)" : "(stored)") : chalk.red("missing — set DEEPSEEK_API_KEY")}`);
  console.log(`  ${chalk.green("✓")} model ${chalk.dim(ctx.config.model)}`);
  console.log(`  ${chalk.green("✓")} baseURL ${chalk.dim(ctx.config.baseURL)}`);
  console.log(`  ${chalk.green("✓")} thinking ${chalk.dim(ctx.config.thinkingMode ?? "off")}`);
  console.log(`  ${chalk.green("✓")} config ${chalk.dim(configPath())}`);

  console.log();
  console.log(chalk.bold("  Project"));
  const memory = loadProjectMemory(ctx.agent.getCwd());
  console.log(`  ${memory.files.length > 0 ? chalk.green("✓") : warn} project memory ${memory.files.length > 0 ? chalk.dim(`${memory.files.length} file(s)`) : chalk.dim("none — run /init")}`);
  const plugins = listPlugins();
  console.log(`  ${chalk.green("✓")} plugins ${chalk.dim(`${plugins.length} installed`)}`);
  const skills = loadSkillCommands(ctx.agent.getCwd());
  console.log(`  ${chalk.green("✓")} skills ${chalk.dim(`${skills.length} available`)}`);
  console.log(`  ${marketplaceSource() ? chalk.green("✓") : warn} marketplace ${marketplaceSource() ? chalk.dim(marketplaceSource() ?? "") : chalk.dim("not configured (DEEPSEEK_PLUGIN_REGISTRY)")}`);
  console.log();
}

function handlePluginNew(name?: string): void {
  if (!name) {
    ui.warn("Usage: /plugin new <name>");
    return;
  }
  try {
    const result = scaffoldPlugin(name);
    ui.success(`Created plugin '${result.name}' at ${result.dir}.`);
    ui.info(`Sample skill: ${result.skillFile} — invoke it with /${result.name}`);
    ui.info("Edit plugin.json and add more skill .md files; type / to see new commands.");
  } catch (err) {
    ui.error(`Could not create plugin: ${(err as Error).message}`);
  }
}

async function handlePluginSearch(query: string): Promise<void> {
  const src = marketplaceSource();
  if (!src) {
    ui.warn("No plugin marketplace configured.");
    ui.info("Point DEEPSEEK_PLUGIN_REGISTRY at an index.json (URL or local path), e.g.:");
    ui.info("  export DEEPSEEK_PLUGIN_REGISTRY=https://example.com/plugins/index.json");
    return;
  }

  ui.info(`Searching marketplace (${src}) …`);
  let results;
  try {
    results = await searchMarketplace(query);
  } catch (err) {
    ui.error((err as Error).message);
    return;
  }

  if (results.length === 0) {
    ui.warn(query ? `No plugins match "${query}".` : "The marketplace is empty.");
    return;
  }

  console.log();
  for (const entry of results) {
    const ver = entry.version ? chalk.dim(` v${entry.version}`) : "";
    console.log(`  ${chalk.bold(entry.name)}${ver}`);
    if (entry.description) console.log(`     ${chalk.dim(entry.description)}`);
    console.log(`     ${chalk.dim(`install: /plugin install ${entry.name}`)}`);
  }
  console.log();
}

async function handlePluginInstall(arg: string): Promise<void> {
  if (!arg) {
    ui.warn("Usage: /plugin install <name | git-url | local-path>");
    return;
  }

  let resolved;
  try {
    resolved = await resolveInstallSource(arg);
  } catch (err) {
    ui.error((err as Error).message);
    return;
  }

  ui.info(`Installing plugin from ${resolved.source}${resolved.via === "marketplace" ? " (marketplace)" : ""} …`);
  try {
    const { plugin, skillCount } = installPlugin(resolved.source);
    ui.success(`Installed ${plugin.name}@${plugin.version} (${skillCount} skill${skillCount === 1 ? "" : "s"}).`);
    if (skillCount > 0) ui.info("New skills are now available — type / to see them.");
  } catch (err) {
    ui.error(`Install failed: ${(err as Error).message}`);
  }
}

function printPlugins(): void {
  const plugins = listPlugins();
  console.log();
  console.log(`  ${chalk.dim("plugins dir:")} ${pluginsDir()}`);
  if (plugins.length === 0) {
    console.log(`  ${chalk.yellow("no plugins installed")}`);
    console.log(`  ${chalk.dim("install one with /plugin install <git-url | local-path>")}`);
    console.log();
    return;
  }

  for (const plugin of plugins) {
    const state = plugin.enabled ? chalk.green("●") : chalk.dim("○ (disabled)");
    const count = pluginSkillCount(plugin.name);
    console.log(
      `  ${state} ${chalk.bold(plugin.name)} ${chalk.dim(`v${plugin.version}`)} ${chalk.dim(`· ${count} skill${count === 1 ? "" : "s"}`)}`,
    );
    console.log(`     ${chalk.dim(plugin.description)}`);
    console.log(`     ${chalk.dim(`source: ${plugin.source}`)}`);
  }
  console.log();
}

function handlePluginRemove(name?: string): void {
  if (!name) {
    ui.warn("Usage: /plugin remove <name>");
    return;
  }
  if (removePlugin(name)) ui.success(`Removed plugin '${name}'.`);
  else ui.warn(`Plugin '${name}' is not installed.`);
}

function handlePluginToggle(name: string | undefined, enabled: boolean): void {
  if (!name) {
    ui.warn(`Usage: /plugin ${enabled ? "enable" : "disable"} <name>`);
    return;
  }
  if (setPluginEnabled(name, enabled)) ui.success(`Plugin '${name}' ${enabled ? "enabled" : "disabled"}.`);
  else ui.warn(`Plugin '${name}' is not installed.`);
}

function handlePluginUpdate(name?: string): void {
  if (!name) {
    ui.warn("Usage: /plugin update <name>");
    return;
  }
  const result = updatePlugin(name);
  if (result.updated) ui.success(result.message);
  else ui.warn(result.message);
}

async function handleModel(ctx: CommandContext): Promise<void> {
  const { ids, source } = await listAvailableModelIds(ctx);
  const target = await select({
    message: `Select a model (${source})`,
    default: ids.includes(ctx.config.model) ? ctx.config.model : ids[0],
    choices: ids.map((id) => ({
      name: `${labelForModel(id)}${id === ctx.config.model ? chalk.dim(" (current)") : ""}`,
      value: id,
      description: descriptionForModel(id),
    })),
  });

  ctx.config.model = target;
  ctx.agent.setModel(target);
  ui.success(`Model set to ${chalk.green(target)}.`);
  try {
    saveConfig(ctx.config);
  } catch (err) {
    ui.warn(`Could not save config: ${(err as Error).message}`);
    ui.info("Model changed for this session only.");
  }
}

function handleThinking(arg: string, ctx: CommandContext): void {
  const current: ThinkingMode = ctx.config.thinkingMode ?? "off";

  let next: ThinkingMode;
  if (arg.trim() === "") {
    // bare /thinking toggles on/off (collapsed reachable via /thinking collapsed)
    next = current === "off" ? "full" : "off";
  } else {
    const parsed = normalizeThinkingMode(arg);
    if (!parsed) {
      ui.warn("Usage: /thinking [on | off | collapsed | full]");
      return;
    }
    next = parsed;
  }

  ctx.config.thinkingMode = next;
  ctx.agent.setThinkingMode(next);
  const label = next === "off" ? "off (hidden)" : next === "collapsed" ? "collapsed (first lines)" : "full";
  ui.success(`Thinking display: ${chalk.green(label)}.`);
  try {
    saveConfig(ctx.config);
  } catch (err) {
    ui.warn(`Could not save config: ${(err as Error).message}`);
    ui.info("Preference applied for this session only.");
  }
}

function printHelp(): void {
  console.log();
  ui.info("Commands:");
  for (const command of allCommands()) {
    console.log(`  ${chalk.cyan(command.usage.padEnd(14))} ${chalk.dim(command.description)}`);
  }
  console.log();
  ui.info("Tips:");
  ui.info("  - End a line with \\ to continue typing on the next line.");
  ui.info("  - The agent reads files, runs commands, and edits code for you.");
  console.log();
}

async function printModels(ctx: CommandContext): Promise<void> {
  const { ids, source } = await listAvailableModelIds(ctx);

  console.log();
  console.log(`  ${chalk.dim("source:")} ${source}`);
  for (const id of ids) {
    const marker = id === ctx.config.model ? chalk.green(" ●") : "  ";
    console.log(`${marker} ${chalk.bold(id)}`);
    console.log(`     ${chalk.dim(descriptionForModel(id))}`);
  }
  console.log();
}

function printTodos(ctx: CommandContext): void {
  console.log();
  console.log(chalk.bold("  Todos"));
  console.log(chalk.dim(ctx.agent.getTodos()).replace(/^/gm, "  "));
  console.log();
}

function printTools(): void {
  console.log();
  for (const t of ALL_TOOLS) {
    const flag = t.needsApproval ? chalk.yellow(" [needs approval]") : "";
    console.log(`  ${chalk.cyan(t.name)}${flag}`);
    console.log(`     ${chalk.dim(t.description.split(". ")[0])}`);
  }
  console.log();
}

function printConfig(config: Config): void {
  console.log();
  console.log(`  ${chalk.dim("model:   ")} ${config.model}`);
  console.log(`  ${chalk.dim("baseURL: ")} ${config.baseURL}`);
  console.log(
    `  ${chalk.dim("api key: ")} ${config.apiKey ? chalk.green("set") + (config.apiKeyFromEnv ? chalk.dim(" (from env)") : "") : chalk.red("missing")}`,
  );
  console.log(
    `  ${chalk.dim("thinking:")} ${(config.thinkingMode ?? "off") === "off" ? chalk.yellow("off") : chalk.green(config.thinkingMode)}`,
  );
  console.log(`  ${chalk.dim("config:  ")} ${configPath()}`);
  console.log();
}
