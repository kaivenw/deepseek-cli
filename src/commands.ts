import { select } from "@inquirer/prompts";
import type { Agent } from "./agent.js";
import { MODELS, findModel, saveConfig, configPath, type Config } from "./config.js";
import { initProjectMemory, loadProjectMemory } from "./project.js";
import {
  createSkillTemplate,
  findSkillCommand,
  globalSkillDir,
  loadSkillCommands,
  projectSkillDir,
  renderSkillPrompt,
} from "./skills.js";
import { ALL_TOOLS } from "./tools/index.js";
import { ui, chalk } from "./ui/render.js";
import { saveSession, loadSession, deleteSession } from "./session.js";

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
  { name: "init", usage: "/init", description: "create DEEPSEEK.md project instructions" },
  { name: "memory", usage: "/memory", description: "show loaded project instruction files" },
  { name: "tools", usage: "/tools", description: "list available tools" },
  { name: "config", usage: "/config", description: "show current configuration" },
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

    case "init":
      handleInit(ctx);
      return {};

    case "memory":
      printMemory(ctx);
      return {};

    case "tools":
      printTools();
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

function handleInit(ctx: CommandContext): void {
  const result = initProjectMemory(ctx.agent.getCwd());

  if (result.created) {
    ui.success(result.message);
    ui.info(`Project memory: ${result.path}`);
    ctx.agent.reset();
    ui.info("Conversation reset so the new project instructions are active.");
    return;
  }

  ui.warn(result.message);
  ui.info(`Project memory: ${result.path}`);
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
    console.log(`  ${chalk.cyan(skill.usage.padEnd(16))} ${chalk.dim(skill.description)}`);
    console.log(`  ${chalk.dim(`  ${skill.scope}: ${skill.source}`)}`);
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
  console.log(`  ${chalk.dim("config:  ")} ${configPath()}`);
  console.log();
}
