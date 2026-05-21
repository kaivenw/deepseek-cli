import { execSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { DeepSeekClient, type ChatMessage, type ListedModel, type ToolCall, type Usage } from "./client.js";
import { getTool, toOpenAITools, type ToolContext } from "./tools/index.js";
import { findModel, saveConfig, type Config, type ThinkingMode } from "./config.js";
import type { PermissionManager } from "./permissions.js";
import { formatProjectMemoryForPrompt } from "./project.js";
import { ui, chalk, Spinner } from "./ui/render.js";
import { TodoStore, type TodoItem } from "./todo.js";
import { runHooks } from "./hooks.js";
import type OpenAI from "openai";

const MAX_TOOL_ITERATIONS = 25;
const FILE_MENTION_RE = /(^|\s)@([^\s@]+)/g;
const MAX_MENTION_CHARS = 50_000;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHECKPOINTS = 50;

interface Checkpoint {
  id: number;
  label: string;
  time: string;
  messages: ChatMessage[];
  contextSummary: string | null;
  /** Original file contents captured before edits this turn (null = file did not exist). */
  backups: Map<string, string | null>;
}

export interface CheckpointInfo {
  index: number;
  label: string;
  time: string;
  files: number;
}

export interface RunOptions {
  /** Absolute file paths to attach (e.g. dragged into the terminal). */
  attachments?: string[];
  /** Optional live input collector used by the REPL while a model response is streaming. */
  generationInput?: GenerationInputController;
}

export interface GenerationInputController {
  start(): void;
  stop(): void;
  handleKeypress(str: string, key: KeypressKey): void;
  beforeOutput?(): void;
  afterOutput?(): void;
  setStatus?(status: string): void;
}

type UserContent = string | OpenAI.Chat.Completions.ChatCompletionContentPart[];

/** Expand `@path` mentions in user input by appending the referenced file contents. */
function expandFileMentions(input: string, cwd: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  FILE_MENTION_RE.lastIndex = 0;
  while ((match = FILE_MENTION_RE.exec(input)) !== null) {
    const rel = match[2];
    if (seen.has(rel)) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    try {
      if (!fs.statSync(abs).isFile()) continue;
      let content = fs.readFileSync(abs, "utf8");
      if (content.length > MAX_MENTION_CHARS) content = content.slice(0, MAX_MENTION_CHARS) + "\n…[truncated]";
      seen.add(rel);
      blocks.push(`### @${rel}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      // Not a readable file — leave the @token in place as plain text.
    }
  }
  if (blocks.length === 0) return input;
  return `${input}\n\n--- Referenced files ---\n${blocks.join("\n\n")}`;
}
const COLLAPSED_REASONING_LINES = 6;
const AUTO_COMPRESS_ESTIMATED_TOKEN_LIMIT = 48_000;
const AUTO_COMPRESS_MESSAGE_LIMIT = 80;
const COMPRESSION_INPUT_CHAR_LIMIT = 160_000;

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
}

type RawInput = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

const COMPRESSION_SYSTEM_PROMPT = [
  "You are compressing the context of an agentic coding CLI conversation.",
  "Create a concise but complete continuity summary for the next assistant turn.",
  "Focus on user goals, decisions, constraints, important files, commands/tests run, changes made, unresolved issues, and next steps.",
  "Preserve exact file paths, command names, model names, and behavioral requirements when they matter.",
  "Do not include secrets, API keys, tokens, or credentials. If a secret was discussed, only say that it is configured or must remain private.",
  "Use the conversation's main language. If the user primarily writes Chinese, write the summary in Chinese.",
].join("\n");

// DeepSeek pricing per 1M tokens (USD).
const PRICING: Record<string, { input: number; output: number }> = {
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
};

export function estimateCost(model: string, usage: Usage): string {
  const price = PRICING[model] ?? PRICING["deepseek-v4-pro"];
  // We can't separate input/output from streaming easily, so use blended average.
  const blended = (price.input + price.output) / 2;
  const cost = (usage.totalTokens / 1_000_000) * blended;
  return `$${cost.toFixed(4)}`;
}

function roleOf(message: ChatMessage): string {
  return String((message as { role?: unknown }).role ?? "unknown");
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageContentToText(message: ChatMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        if (p.type === "text") return p.text ?? "";
        if (p.type === "image_url") return "[image]";
        return "";
      })
      .join(" ");
  }
  return valueToText(content);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLength = Math.floor(maxChars * 0.65);
  const tailLength = Math.floor(maxChars * 0.25);
  const omitted = text.length - headLength - tailLength;
  return [
    text.slice(0, headLength),
    `\n...[truncated ${omitted.toLocaleString()} chars]...\n`,
    text.slice(-tailLength),
  ].join("");
}

function formatToolCalls(message: ChatMessage): string {
  const toolCalls = (message as { tool_calls?: ToolCall[] }).tool_calls ?? [];
  if (toolCalls.length === 0) return "";
  return toolCalls
    .map((call, index) => {
      const args = truncateText(call.function.arguments || "{}", 2_000);
      return `tool_call[${index}]: ${call.function.name}(${args})`;
    })
    .join("\n");
}

function formatMessageForCompression(message: ChatMessage, index: number): string {
  const role = roleOf(message);
  const toolCallId = valueToText((message as { tool_call_id?: unknown }).tool_call_id);
  const content = messageContentToText(message) || "(no text content)";
  const toolCalls = formatToolCalls(message);
  const parts = [
    `### ${index + 1}. ${role}`,
    toolCallId ? `tool_call_id: ${toolCallId}` : "",
    truncateText(content, 8_000),
    toolCalls ? `Tool calls:\n${toolCalls}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function buildCompressionInput(contextSummary: string | null, messages: ChatMessage[]): string {
  const header = contextSummary
    ? ["Existing compressed summary:", truncateText(contextSummary, 24_000)].join("\n")
    : "";
  const formatted = messages.map(formatMessageForCompression);
  const selected: string[] = [];
  let usedChars = header.length;
  let omittedMessages = 0;

  for (let index = formatted.length - 1; index >= 0; index--) {
    const next = formatted[index];
    if (usedChars + next.length + 2 > COMPRESSION_INPUT_CHAR_LIMIT) {
      omittedMessages = index + 1;
      break;
    }
    selected.unshift(next);
    usedChars += next.length + 2;
  }

  const omittedNote = omittedMessages > 0
    ? `[${omittedMessages} older messages omitted because the transcript was too large. Preserve continuity from the existing compressed summary when available.]`
    : "";

  return [
    header,
    omittedNote,
    "Conversation transcript to compress:",
    ...selected,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderHookRuns(results: ReturnType<typeof runHooks>): string {
  return results
    .map((result) => {
      const state = result.ok ? "ok" : result.blocking ? "blocked" : "failed";
      const output = result.output ? `\n${truncateText(result.output, 4_000)}` : "";
      return `hook ${state}: ${result.command}${output}`;
    })
    .join("\n");
}

function getGitContext(cwd: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execSync("git status --short", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const lines: string[] = [`Git repository: ${root}`, `Current branch: ${branch}`];
    if (status) {
      const statusLines = status.split("\n").slice(0, 30);
      lines.push(`Git status (first 30 lines):\n${statusLines.join("\n")}`);
    } else {
      lines.push("Working tree is clean.");
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function systemPrompt(cwd: string, contextSummary: string | null = null): string {
  const projectMemory = formatProjectMemoryForPrompt(cwd);
  const gitContext = getGitContext(cwd);
  const today = new Date().toISOString().slice(0, 10);
  const platform = `${process.platform} (${process.arch})`;
  const shell = process.env.SHELL || "unknown";

  return [
    "You are DeepSeek Code Agent, a local coding assistant running in the user's current project directory.",
    "",
    "Use the provided tools to inspect files, search code, edit files, and run shell commands.",
    "Before editing, inspect the relevant files. Keep changes focused and explain what changed.",
    "Prefer search_text over broad file reads. Never assume file contents you have not read.",
    "Use todo_write to track multi-step tasks: create a short list before substantial work, keep exactly one item in_progress, and mark items completed as you finish them.",
    "",
    "The local CLI will ask the user before running shell commands or writing files unless they start it with --yes.",
    "If the user asks to show or hide your reasoning/thinking (e.g. \"关闭思考\"/\"显示思考\"/\"hide your thinking\"), call the set_thinking tool.",
    "",
    `Working directory: ${cwd}`,
    `Today's date: ${today}`,
    `Platform: ${platform}`,
    `Shell: ${shell}`,
    gitContext ? `\n${gitContext}` : "",
    projectMemory ? `\n${projectMemory}` : "",
    contextSummary
      ? `\nCompressed conversation context (authoritative summary of earlier turns):\n${contextSummary}`
      : "",
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

export interface SessionData {
  messages: ChatMessage[];
  totalUsage: Usage;
  contextSummary?: string | null;
  compressedAt?: string | null;
  todos?: TodoItem[];
}

export interface CompressResult {
  compressed: boolean;
  reason: "manual" | "auto";
  messagesBefore: number;
  messagesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  summary: string;
  summaryChars: number;
}

export class Agent {
  private messages: ChatMessage[];
  private client: DeepSeekClient;
  private contextSummary: string | null = null;
  private compressedAt: string | null = null;
  private todoStore = new TodoStore();
  private subagentDepth = 0;
  private checkpoints: Checkpoint[] = [];
  private checkpointSeq = 0;
  private suppressCheckpoint = false;
  totalUsage: Usage;

  constructor(
    private config: Config,
    private permissions: PermissionManager,
    private ctx: ToolContext,
  ) {
    this.client = new DeepSeekClient(config);
    // Let tools (e.g. set_thinking) change session settings and persist them.
    const toolCtx: ToolContext = { ...ctx };
    toolCtx.setThinkingMode = (mode: ThinkingMode) => {
      this.config.thinkingMode = mode;
      this.config.thinkingModeConfigured = true;
      try {
        saveConfig(this.config);
      } catch {
        // Persisting is best-effort; the in-session change still applies.
      }
    };
    toolCtx.getThinkingMode = () => this.config.thinkingMode ?? "off";
    toolCtx.todoStore = this.todoStore;
    toolCtx.runSubagent = (prompt, opts) => this.runSubagent(prompt, opts ?? {});
    toolCtx.recordFileBackup = (absPath, previous) => this.recordFileBackup(absPath, previous);
    this.ctx = toolCtx;
    this.messages = [];
    this.refreshSystemPrompt();
    this.totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  getModel(): string {
    return this.config.model;
  }

  setThinkingMode(mode: ThinkingMode): void {
    this.config.thinkingMode = mode;
    this.config.thinkingModeConfigured = true;
  }

  getThinkingMode(): ThinkingMode {
    return this.config.thinkingMode ?? "off";
  }

  getCwd(): string {
    return this.ctx.cwd;
  }

  async listModels(): Promise<ListedModel[]> {
    return this.client.listModels();
  }

  private refreshSystemPrompt(): void {
    const nonSystemMessages = this.messages.filter((message) => roleOf(message) !== "system");
    this.messages = [
      { role: "system", content: systemPrompt(this.ctx.cwd, this.contextSummary) },
      ...nonSystemMessages,
    ];
  }

  /** Rebuild the system prompt in place (e.g. after DEEPSEEK.md changes), keeping history. */
  reloadProjectContext(): void {
    this.refreshSystemPrompt();
  }

  /** Drop conversation history and compressed context, but keep the system prompt. */
  reset(): void {
    this.contextSummary = null;
    this.compressedAt = null;
    this.messages = [];
    this.checkpoints = [];
    this.refreshSystemPrompt();
    this.totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  messageCount(): number {
    return this.messages.filter((m) => m.role !== "system").length;
  }

  /** Export current session for persistence. */
  getSession(): SessionData {
    return {
      messages: [...this.messages],
      totalUsage: { ...this.totalUsage },
      contextSummary: this.contextSummary,
      compressedAt: this.compressedAt,
      todos: this.todoStore.list(),
    };
  }

  /** Restore a previously saved session. */
  restoreSession(data: SessionData): void {
    // Keep the system prompt fresh but restore the rest.
    this.contextSummary = data.contextSummary ?? null;
    this.compressedAt = data.compressedAt ?? null;
    this.todoStore.replace(Array.isArray(data.todos) ? data.todos : []);
    this.messages = [
      { role: "system", content: systemPrompt(this.ctx.cwd, this.contextSummary) },
      ...data.messages.filter((m) => roleOf(m) !== "system"),
    ];
    this.checkpoints = [];
    this.totalUsage = { ...data.totalUsage };
    this.sanitizeHistory();
  }

  getContextSummary(): string | null {
    return this.contextSummary;
  }

  getTodos(): string {
    return this.todoStore.formatForModel();
  }

  private estimatedContextTokens(extraUserInput = ""): number {
    const serialized = this.messages
      .map((message, index) => formatMessageForCompression(message, index))
      .join("\n\n");
    return estimateTokensFromText(serialized + extraUserInput);
  }

  private shouldAutoCompress(extraUserInput: string): boolean {
    if (this.messageCount() === 0) return false;
    return (
      this.messageCount() >= AUTO_COMPRESS_MESSAGE_LIMIT ||
      this.estimatedContextTokens(extraUserInput) >= AUTO_COMPRESS_ESTIMATED_TOKEN_LIMIT
    );
  }

  async compressContext(reason: "manual" | "auto" = "manual"): Promise<CompressResult> {
    const sourceMessages = this.messages.filter((message) => roleOf(message) !== "system");
    const messagesBefore = sourceMessages.length;
    const estimatedTokensBefore = this.estimatedContextTokens();

    if (sourceMessages.length === 0) {
      return {
        compressed: false,
        reason,
        messagesBefore,
        messagesAfter: 0,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        summary: this.contextSummary ?? "",
        summaryChars: this.contextSummary?.length ?? 0,
      };
    }

    const compressionInput = buildCompressionInput(this.contextSummary, sourceMessages);
    const promptMessages: ChatMessage[] = [
      { role: "system", content: COMPRESSION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "Compress this DeepSeek CLI session into a durable continuation summary.",
          "The next assistant turn will rely on this summary instead of the full transcript.",
          "Return only the summary, with clear bullets or short sections.",
          "",
          compressionInput,
        ].join("\n"),
      },
    ];

    const spinner = new Spinner(reason === "auto" ? "auto-compressing context…" : "compressing context…");
    spinner.start();
    try {
      const turn = await this.client.stream(promptMessages, [], this.config.model);
      if (turn.usage) {
        this.totalUsage.promptTokens += turn.usage.promptTokens;
        this.totalUsage.completionTokens += turn.usage.completionTokens;
        this.totalUsage.totalTokens += turn.usage.totalTokens;
      }

      const summary = turn.content.trim();
      if (!summary) throw new Error("model returned an empty compression summary");

      this.contextSummary = summary;
      this.compressedAt = new Date().toISOString();
      this.messages = [];
      this.refreshSystemPrompt();

      return {
        compressed: true,
        reason,
        messagesBefore,
        messagesAfter: this.messageCount(),
        estimatedTokensBefore,
        estimatedTokensAfter: this.estimatedContextTokens(),
        summary,
        summaryChars: summary.length,
      };
    } finally {
      spinner.stop();
    }
  }

  private listenForGenerationAbort(controller: AbortController, generationInput?: GenerationInputController): () => void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return () => undefined;

    const input = process.stdin as RawInput;
    const wasRaw = Boolean(input.isRaw);
    const onKeypress = (_str: string, key: KeypressKey = {}) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        controller.abort();
        return;
      }
      generationInput?.handleKeypress(_str, key);
    };

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKeypress);
    input.resume();
    generationInput?.start();

    return () => {
      input.off("keypress", onKeypress);
      if (!wasRaw) input.setRawMode?.(false);
      generationInput?.stop();
    };
  }

  private listenForQueuedInput(generationInput?: GenerationInputController): () => void {
    if (!generationInput || !process.stdin.isTTY || !process.stdout.isTTY) return () => undefined;

    const input = process.stdin as RawInput;
    const wasRaw = Boolean(input.isRaw);
    const onKeypress = (str: string, key: KeypressKey = {}) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return;
      generationInput.handleKeypress(str, key);
    };

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKeypress);
    input.resume();
    generationInput.start();

    return () => {
      input.off("keypress", onKeypress);
      if (!wasRaw) input.setRawMode?.(false);
      generationInput.stop();
    };
  }

  async runIsolated(userInput: string, options: RunOptions = {}): Promise<void> {
    const savedMessages = this.messages;
    this.messages = [];
    this.suppressCheckpoint = true;
    this.refreshSystemPrompt();
    try {
      await this.run(userInput, options);
    } finally {
      this.suppressCheckpoint = false;
      this.messages = savedMessages;
      this.refreshSystemPrompt();
    }
  }

  /** Build a user message content, attaching files (text inline, images as image_url). */
  private buildUserContent(text: string, attachments: string[]): { content: UserContent; estimate: string } {
    let textContent = text;
    const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
    const visionSupported =
      findModel(this.config.model)?.supportsVision === true ||
      ["1", "true", "on", "yes"].includes((process.env.DEEPSEEK_VISION ?? "").toLowerCase());

    for (const file of attachments) {
      const ext = path.extname(file).toLowerCase();
      try {
        if (IMAGE_EXT.has(ext)) {
          // DeepSeek chat models are text-only; only send images to vision models.
          if (!visionSupported) {
            const kb = (() => { try { return Math.round(fs.statSync(file).size / 1024); } catch { return 0; } })();
            ui.warn(`Image ${path.basename(file)} not sent: model '${this.config.model}' has no vision support.`);
            textContent += `\n\n[Attached image ${path.basename(file)} (${kb} KB) was not sent because the current model cannot view images.]`;
            continue;
          }
          const size = fs.statSync(file).size;
          if (size > MAX_IMAGE_BYTES) {
            textContent += `\n\n[image ${path.basename(file)} skipped: ${(size / 1e6).toFixed(1)}MB exceeds 5MB]`;
            continue;
          }
          const b64 = fs.readFileSync(file).toString("base64");
          const mime = ext === ".jpg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : `image/${ext.slice(1)}`;
          imageParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
        } else {
          let body = fs.readFileSync(file, "utf8");
          if (body.length > MAX_MENTION_CHARS) body = body.slice(0, MAX_MENTION_CHARS) + "\n…[truncated]";
          textContent += `\n\n--- Attached file: ${file} ---\n\`\`\`\n${body}\n\`\`\``;
        }
      } catch (err) {
        textContent += `\n\n[could not read attachment ${path.basename(file)}: ${(err as Error).message}]`;
      }
    }

    if (imageParts.length === 0) {
      return { content: textContent, estimate: textContent };
    }
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: textContent || "(see attached image)" },
      ...imageParts,
    ];
    return { content: parts, estimate: `${textContent} [${imageParts.length} image(s)]` };
  }

  async run(userInput: string, options: RunOptions = {}): Promise<void> {
    // Snapshot before a genuine top-level turn (not sub-agents or isolated runs).
    if (this.subagentDepth === 0 && !this.suppressCheckpoint) {
      this.createCheckpoint(userInput);
    }

    if (!this.runLifecycleHooks("userPromptSubmit", { prompt: userInput })) {
      ui.warn("Prompt blocked by a userPromptSubmit hook.");
      return;
    }

    const text = expandFileMentions(userInput, this.ctx.cwd);
    const { content, estimate } = this.buildUserContent(text, options.attachments ?? []);

    if (this.shouldAutoCompress(estimate)) {
      ui.warn(`Context is large (~${this.estimatedContextTokens(estimate).toLocaleString()} estimated tokens); compressing before continuing.`);
      try {
        const result = await this.compressContext("auto");
        if (result.compressed) {
          ui.success(
            `Context compressed: ${result.messagesBefore} messages -> ${result.summaryChars.toLocaleString()} chars summary.`,
          );
        }
      } catch (err) {
        ui.warn(`Auto-compress failed: ${(err as Error).message}`);
      }
    }

    this.messages.push({ role: "user", content });

    // Guard against invalid history (e.g. an older saved session containing an
    // assistant message with neither content nor tool_calls), which the API rejects.
    this.sanitizeHistory();

    const supportsTools = findModel(this.config.model)?.supportsTools !== false;
    const tools = supportsTools ? toOpenAITools() : [];

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let textStarted = false;
      let reasoningStarted = false;
      const thinkingMode = this.config.thinkingMode ?? "off";
      let reasoningLines = 1;
      let reasoningCut = false;
      const spinner = new Spinner("thinking…");
      options.generationInput?.setStatus?.(iter === 0 ? "Thinking" : "Continuing");
      if (!options.generationInput) spinner.start();

      // Reasoning is always captured for the API contract (see client.stream);
      // these callbacks only control how/whether it is displayed.
      const printReasoning = (delta: string) => {
        if (!reasoningStarted) {
          options.generationInput?.stop();
          spinner.stop();
          process.stdout.write(chalk.dim.italic("\n  [thinking] "));
          reasoningStarted = true;
        }
        if (thinkingMode === "full") {
          process.stdout.write(chalk.dim.italic(delta.replace(/\n/g, "\n  ")));
          return;
        }
        // collapsed: show only the first few lines, then stop printing the rest.
        if (reasoningCut) return;
        const segments = delta.split("\n");
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) {
            reasoningLines++;
            if (reasoningLines > COLLAPSED_REASONING_LINES) {
              process.stdout.write(chalk.dim.italic(" …"));
              reasoningCut = true;
              return;
            }
            process.stdout.write("\n  ");
          }
          if (segments[i]) process.stdout.write(chalk.dim.italic(segments[i]));
        }
      };

      const abortController = new AbortController();
      const stopAbortListener = this.listenForGenerationAbort(abortController, options.generationInput);
      let turn;
      try {
        turn = await this.client.stream(this.messages, tools, this.config.model, {
          onReasoning: thinkingMode === "off" ? undefined : printReasoning,
          onText: (delta) => {
            if (!textStarted) {
              options.generationInput?.stop();
              spinner.stop();
              if (reasoningStarted) process.stdout.write("\n");
              ui.assistantLabel();
              textStarted = true;
            }
            process.stdout.write(delta);
          },
        }, { signal: abortController.signal });
      } catch (err) {
        spinner.stop();
        stopAbortListener();
        if (abortController.signal.aborted) {
          this.stripReasoningContent();
          ui.warn("\nInterrupted.");
          return;
        }
        throw err;
      } finally {
        stopAbortListener();
      }

      spinner.stop();
      if (textStarted) process.stdout.write("\n");

      // Track usage if available.
      if (turn.usage) {
        this.totalUsage.promptTokens += turn.usage.promptTokens;
        this.totalUsage.completionTokens += turn.usage.completionTokens;
        this.totalUsage.totalTokens += turn.usage.totalTokens;
      }

      // Record the assistant message (content + any tool calls). In DeepSeek
      // "thinking" mode, the reasoning_content that produced a tool call MUST be
      // sent back together with the tool_calls or the next request fails with
      // 400 ("reasoning_content ... must be passed back"). We attach it here and
      // strip it once the turn concludes (see below) so stale reasoning is never
      // resent on later user turns — the other half of DeepSeek's contract.
      const hasContent = typeof turn.content === "string" && turn.content.length > 0;
      const hasToolCalls = turn.toolCalls.length > 0;

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: hasContent ? turn.content : null,
      };
      if (hasToolCalls) {
        assistantMsg.tool_calls = turn.toolCalls;
        if (turn.reasoning) {
          (assistantMsg as { reasoning_content?: string }).reasoning_content = turn.reasoning;
        }
      }
      // DeepSeek rejects assistant messages that have neither content nor
      // tool_calls.  When both are missing (e.g. all streamed tool_calls were
      // stripped because they lacked a function name), fall back to a sensible
      // empty string so the message stays valid for future turns.
      if (!assistantMsg.content && !(assistantMsg as { tool_calls?: unknown }).tool_calls) {
        assistantMsg.content = "";
      }
      this.messages.push(assistantMsg);

      if (turn.toolCalls.length === 0) {
        // Final answer reached: drop reasoning_content kept for in-flight tool calls.
        this.stripReasoningContent();
        this.runLifecycleHooks("stop", {});
        // Show usage after final answer.
        if (this.totalUsage.totalTokens > 0) {
          ui.usage(this.totalUsage, this.config.model);
        }
        return;
      }

      // Execute each requested tool call and feed results back.
      for (const call of turn.toolCalls) {
        const result = await this.executeToolCall(call, options.generationInput);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }

    this.stripReasoningContent();
    ui.warn(`\nStopped after ${MAX_TOOL_ITERATIONS} tool iterations.`);
  }

  /**
   * Remove reasoning_content from stored messages. DeepSeek thinking mode requires
   * reasoning_content to accompany tool_calls during an active tool chain, but it
   * must not be resent on subsequent user turns once the turn has concluded.
   */
  /**
   * Ensure every assistant message has content or tool_calls. DeepSeek rejects
   * assistant messages where both are missing (can happen with sessions saved by
   * older builds or after edits/compression). Such messages are normalised to "".
   */
  private sanitizeHistory(): void {
    for (const message of this.messages) {
      const msg = message as { role?: string; content?: unknown; tool_calls?: unknown };
      if (msg.role !== "assistant") continue;
      const hasContent =
        (typeof msg.content === "string" && msg.content.length > 0) ||
        (Array.isArray(msg.content) && msg.content.length > 0);
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (!hasContent && !hasToolCalls) {
        msg.content = "";
        if (msg.tool_calls !== undefined) delete msg.tool_calls;
      }
    }
  }

  private stripReasoningContent(): void {
    for (const message of this.messages) {
      const withReasoning = message as { reasoning_content?: string };
      if (withReasoning.reasoning_content !== undefined) {
        delete withReasoning.reasoning_content;
      }
    }
  }

  /** Run lifecycle hooks (sessionStart / userPromptSubmit / stop). Returns false if blocked. */
  private runLifecycleHooks(event: "sessionStart" | "userPromptSubmit" | "stop", context: { prompt?: string }): boolean {
    const results = runHooks(event, this.ctx.cwd, context);
    for (const hook of results) {
      if (hook.output || !hook.ok) ui.toolResult(`hook(${event}): ${hook.command}`, !hook.ok);
    }
    return !results.some((hook) => !hook.ok && hook.blocking);
  }

  /** Fire sessionStart hooks (call once when a session begins). */
  sessionStart(): void {
    this.runLifecycleHooks("sessionStart", {});
  }

  /** Snapshot the conversation before a turn so it can be rewound later. */
  private createCheckpoint(label: string): void {
    this.checkpoints.push({
      id: ++this.checkpointSeq,
      label: label.replace(/\s+/g, " ").trim().slice(0, 60) || "(turn)",
      time: new Date().toISOString(),
      messages: this.messages.slice(),
      contextSummary: this.contextSummary,
      backups: new Map(),
    });
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
  }

  /** Record a file's pre-change content into the most recent checkpoint (first touch only). */
  private recordFileBackup(absPath: string, previous: string | null): void {
    const active = this.checkpoints[this.checkpoints.length - 1];
    if (active && !active.backups.has(absPath)) active.backups.set(absPath, previous);
  }

  listCheckpoints(): CheckpointInfo[] {
    return this.checkpoints.map((c, index) => ({
      index,
      label: c.label,
      time: c.time,
      files: c.backups.size,
    }));
  }

  /**
   * Rewind to checkpoint `index`: restore files edited since then (deleting ones
   * that were created), reset the conversation to that point, and drop later checkpoints.
   */
  rewindTo(index: number): { ok: boolean; restoredFiles: number; messages: number } {
    if (index < 0 || index >= this.checkpoints.length) {
      return { ok: false, restoredFiles: 0, messages: this.messageCount() };
    }
    // Restore newest → target so the target's (oldest) backup wins for each path.
    const seen = new Set<string>();
    for (let i = this.checkpoints.length - 1; i >= index; i--) {
      for (const [filePath, content] of this.checkpoints[i].backups) {
        seen.add(filePath);
        try {
          if (content === null) {
            if (fs.existsSync(filePath)) fs.rmSync(filePath);
          } else {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf8");
          }
        } catch {
          // Best-effort restore; keep going.
        }
      }
    }

    const target = this.checkpoints[index];
    this.messages = target.messages.slice();
    this.contextSummary = target.contextSummary;
    this.checkpoints = this.checkpoints.slice(0, index);
    this.stripReasoningContent();
    return { ok: true, restoredFiles: seen.size, messages: this.messageCount() };
  }

  /**
   * Run an isolated sub-agent to completion and return its final answer.
   * The sub-agent has a fresh conversation, the standard tools (minus `task`,
   * to prevent runaway recursion), and shares the parent's usage accounting.
   */
  async runSubagent(prompt: string, opts: { tools?: string[] } = {}): Promise<string> {
    if (this.subagentDepth >= 2) {
      return "Sub-agent depth limit reached; refusing to nest further.";
    }
    this.subagentDepth++;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          systemPrompt(this.ctx.cwd, this.contextSummary) +
          "\n\nYou are a sub-agent handling a delegated, self-contained task. Work autonomously with the available tools and finish with a concise final answer for the calling agent.",
      },
      { role: "user", content: prompt },
    ];

    // Sub-agents never receive the task tool; honor an optional allowlist.
    let tools = toOpenAITools().filter((t) => t.function.name !== "task");
    if (opts.tools && opts.tools.length > 0) {
      const allow = new Set(opts.tools);
      tools = tools.filter((t) => allow.has(t.function.name));
    }

    ui.info(chalk.dim("  ↳ sub-agent started"));
    try {
      let finalText = "";
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const turn = await this.client.stream(messages, tools, this.config.model);
        if (turn.usage) {
          this.totalUsage.promptTokens += turn.usage.promptTokens;
          this.totalUsage.completionTokens += turn.usage.completionTokens;
          this.totalUsage.totalTokens += turn.usage.totalTokens;
        }

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: turn.content || (turn.toolCalls.length > 0 ? null : ""),
        };
        if (turn.toolCalls.length > 0) {
          assistantMsg.tool_calls = turn.toolCalls;
          if (turn.reasoning) (assistantMsg as { reasoning_content?: string }).reasoning_content = turn.reasoning;
        }
        messages.push(assistantMsg);

        if (turn.toolCalls.length === 0) {
          finalText = turn.content;
          break;
        }
        for (const call of turn.toolCalls) {
          const result = await this.executeToolCall(call);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
      ui.info(chalk.dim("  ↳ sub-agent done"));
      return finalText || "(sub-agent produced no final answer)";
    } finally {
      this.subagentDepth--;
    }
  }

  private async executeToolCall(
    call: ToolCall,
    generationInput?: GenerationInputController,
  ): Promise<string> {
    const tool = getTool(call.function.name);
    if (!tool) {
      ui.toolResult(`unknown tool: ${call.function.name}`, true);
      return `Error: tool '${call.function.name}' does not exist.`;
    }

    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      ui.toolResult(`${tool.name}: invalid arguments`, true);
      return `Error: could not parse arguments as JSON: ${call.function.arguments}`;
    }

    const preview = tool.preview ? tool.preview(args, this.ctx) : tool.name;
    generationInput?.setStatus?.(`Running ${tool.name}`);
    generationInput?.beforeOutput?.();
    ui.toolCall(preview);
    generationInput?.afterOutput?.();

    // Permission gate for side-effecting tools.
    if (tool.needsApproval && !this.permissions.isAllowed(tool.name)) {
      generationInput?.beforeOutput?.();
      const decision = await this.permissions.request(tool.name, preview);
      generationInput?.afterOutput?.();
      if (decision === "deny") {
        generationInput?.beforeOutput?.();
        ui.toolResult("denied by user", true);
        generationInput?.afterOutput?.();
        return "User denied permission to run this tool. Do not retry; ask the user how to proceed or try a different approach.";
      }
    }

    const stopQueuedInput = this.listenForQueuedInput(generationInput);
    try {
      const preHooks = runHooks("preToolUse", this.ctx.cwd, { toolName: tool.name, preview });
      for (const hook of preHooks) {
        generationInput?.beforeOutput?.();
        ui.toolResult(`hook: ${hook.command}`, !hook.ok);
        generationInput?.afterOutput?.();
      }
      const blockingHook = preHooks.find((hook) => !hook.ok && hook.blocking);
      if (blockingHook) {
        stopQueuedInput();
        return `Tool blocked by preToolUse hook.\n${renderHookRuns(preHooks)}`;
      }

      const result = await tool.run(args, this.ctx);
      stopQueuedInput();
      generationInput?.beforeOutput?.();
      ui.toolResult(result.summary ?? tool.name, Boolean(result.isError));
      if (result.display) ui.diff(result.display);
      generationInput?.afterOutput?.();

      const postHooks = runHooks("postToolUse", this.ctx.cwd, {
        toolName: tool.name,
        preview,
        status: result.isError ? "error" : "success",
      });
      for (const hook of postHooks) {
        generationInput?.beforeOutput?.();
        ui.toolResult(`hook: ${hook.command}`, !hook.ok);
        generationInput?.afterOutput?.();
      }

      const hookText = [renderHookRuns(preHooks), renderHookRuns(postHooks)].filter(Boolean).join("\n");
      return hookText ? `${result.content}\n\nHook results:\n${hookText}` : result.content;
    } catch (err) {
      stopQueuedInput();
      const msg = err instanceof Error ? err.message : String(err);
      generationInput?.beforeOutput?.();
      ui.toolResult(`${tool.name}: ${msg}`, true);
      generationInput?.afterOutput?.();
      return `Error running ${tool.name}: ${msg}`;
    }
  }
}
