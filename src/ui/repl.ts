import { execSync } from "node:child_process";
import readline from "node:readline";
import type { Agent, GenerationInputController } from "../agent.js";
import type { Config } from "../config.js";
import { isCommand, runCommand, suggestCommands } from "../commands.js";
import { ui, chalk } from "./render.js";
import { loadSession, saveSession } from "../session.js";
import { appendProjectMemory } from "../project.js";
import { extractDraggedPaths } from "../attachments.js";
import path from "node:path";
import { mcpStatus } from "../mcp.js";

interface CommandSuggestion {
  value: string;
  usage: string;
  description: string;
}

interface PromptRenderState {
  line: string;
  cursor: number;
  promptText: string;
  suggestionRows: string[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function lastLineWidth(text: string): number {
  const plain = stripAnsi(text);
  return displayWidth(plain.slice(plain.lastIndexOf("\n") + 1));
}

function physicalRows(text: string, cols: number): number {
  const plain = stripAnsi(text);
  if (!plain) return 0;
  return plain
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / cols)), 0);
}

function commandSuggestions(line: string, cwd: string): CommandSuggestion[] {
  const trimmedStart = line.trimStart();
  if (!trimmedStart.startsWith("/")) return [];

  const query = trimmedStart.slice(1);
  const commands = suggestCommands(query, { limit: 8, cwd });
  return commands.map((command) => ({
    value: command.usage.split(" ")[0],
    usage: command.usage,
    description: command.description,
  }));
}

function commandSuggestionRows(suggestions: CommandSuggestion[], selectedIndex: number): string[] {
  return suggestions.map((suggestion, index) => {
    const usage = suggestion.usage.padEnd(14);
    const selected = index === selectedIndex;
    const left = selected ? chalk.cyan(usage) : chalk.dim(usage);
    const description = selected ? chalk.white(suggestion.description) : chalk.dim(suggestion.description);
    return "  " + left + " " + description;
  });
}

interface RenderGeometry {
  /** Total physical terminal rows the rendered block occupies. */
  rows: number;
  /** Physical row (0-based from the top of the block) where the input cursor sits. */
  cursorRow: number;
}

const EMPTY_GEOMETRY: RenderGeometry = { rows: 0, cursorRow: 0 };

class QueuedInputController implements GenerationInputController {
  private line = "";
  private cursor = 0;
  private geom: RenderGeometry = { ...EMPTY_GEOMETRY };
  private active = false;
  private repaintTimer: ReturnType<typeof setImmediate> | null = null;
  private animationTimer: NodeJS.Timeout | null = null;
  private frame = 0;
  private status = "Working";

  constructor(private readonly queue: string[]) {}

  start(): void {
    if (this.active || !process.stdout.isTTY) return;
    this.active = true;
    this.animationTimer = setInterval(() => {
      this.frame++;
      this.repaint();
    }, 250);
    this.repaint();
  }

  stop(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
    if (this.repaintTimer) {
      clearImmediate(this.repaintTimer);
      this.repaintTimer = null;
    }
    if (this.active) {
      clearRendered(this.geom);
      this.geom = { ...EMPTY_GEOMETRY };
      this.active = false;
    }
  }

  takeDraft(): string {
    const draft = this.line;
    this.line = "";
    this.cursor = 0;
    return draft;
  }

  beforeOutput(): void {
    if (!this.active) return;
    if (this.repaintTimer) {
      clearImmediate(this.repaintTimer);
      this.repaintTimer = null;
    }
    clearRendered(this.geom);
    this.geom = { ...EMPTY_GEOMETRY };
  }

  afterOutput(): void {
    if (!this.active) return;
    this.repaint();
  }

  setStatus(status: string): void {
    this.status = status;
    this.repaint();
  }

  handleKeypress(str: string, key: readline.Key): void {
    if (!this.active) return;
    if (key.name === "return" || key.name === "enter") {
      const submitted = this.line.trim();
      if (submitted) {
        this.queue.push(submitted);
        this.line = "";
        this.cursor = 0;
      }
      this.repaint();
      return;
    }
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor--;
        this.repaint();
      }
      return;
    }
    if (key.name === "delete") {
      if (this.cursor < this.line.length) {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this.repaint();
      }
      return;
    }
    if (key.name === "left") {
      if (this.cursor > 0) {
        this.cursor--;
        this.repaint();
      }
      return;
    }
    if (key.name === "right") {
      if (this.cursor < this.line.length) {
        this.cursor++;
        this.repaint();
      }
      return;
    }
    if (key.name === "home") {
      this.cursor = 0;
      this.repaint();
      return;
    }
    if (key.name === "end") {
      this.cursor = this.line.length;
      this.repaint();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (!str) return;

    const clean = str.replace(/[\x00-\x1f\x7f]/g, "");
    if (!clean) return;
    this.line = this.line.slice(0, this.cursor) + clean + this.line.slice(this.cursor);
    this.cursor += clean.length;
    this.scheduleRepaint();
  }

  private scheduleRepaint(): void {
    if (this.repaintTimer) return;
    this.repaintTimer = setImmediate(() => {
      this.repaintTimer = null;
      this.repaint();
    });
  }

  private repaint(): void {
    if (!this.active) return;
    const dots = ".".repeat((this.frame % 3) + 1);
    const queued = this.queue.length > 0 ? chalk.dim(`  queued ${this.queue.length}`) : "";
    const loadingLine = `${chalk.hex("#f4b860")("*")} ${chalk.hex("#f4b860")(this.status + dots)}${queued}`;
    const tipLine = "  " + chalk.dim("enter queues next message · esc interrupts");
    const divider = chalk.dim("─".repeat(Math.min(process.stdout.columns || 60, 60)));
    this.geom = renderPrompt(
      {
        line: this.line,
        cursor: this.cursor,
        promptText: `${loadingLine}\n${tipLine}\n${divider}\n${chalk.bold.green("› ")}`,
        suggestionRows: [],
      },
      this.geom,
    );
  }
}

/** Clear a previously rendered block, accounting for lines that wrapped across columns. */
function clearRendered(geom: RenderGeometry): void {
  if (geom.rows <= 0) return;
  // The cursor sits on geom.cursorRow; move up to the top of the block first.
  if (geom.cursorRow > 0) readline.moveCursor(process.stdout, 0, -geom.cursorRow);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
}

function renderPrompt(state: PromptRenderState, previous: RenderGeometry): RenderGeometry {
  clearRendered(previous);

  const cols = Math.max(1, process.stdout.columns || 80);
  process.stdout.write(state.promptText + state.line);
  for (const row of state.suggestionRows) {
    process.stdout.write("\n" + row);
  }

  // Account for the prompt+line wrapping across terminal columns.
  const promptPrefix = state.promptText.slice(0, Math.max(0, state.promptText.lastIndexOf("\n") + 1));
  const prefixRows = physicalRows(promptPrefix.endsWith("\n") ? promptPrefix.slice(0, -1) : promptPrefix, cols);
  const promptWidth = lastLineWidth(state.promptText);
  const contentWidth = promptWidth + displayWidth(state.line);
  const contentRows = Math.max(1, Math.ceil(contentWidth / cols));
  const totalRows = prefixRows + contentRows + state.suggestionRows.length;

  const cursorOffset = promptWidth + displayWidth(state.line.slice(0, state.cursor));
  const cursorRow = prefixRows + Math.min(contentRows - 1, Math.floor(cursorOffset / cols));
  const cursorCol = cursorOffset % cols;

  // After the writes the terminal cursor is on the last drawn row; bring it back
  // up to the input cursor's physical row, then to the right column.
  const up = totalRows - 1 - cursorRow;
  if (up > 0) readline.moveCursor(process.stdout, 0, -up);
  readline.cursorTo(process.stdout, cursorCol);

  return { rows: totalRows, cursorRow };
}

function fallbackAsk(promptText: string, history: string[]): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY,
    history,
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    rl.question(promptText, (answer) => {
      finish(answer);
      rl.close();
    });
    rl.on("close", () => finish(null));
  });
}

function readInteractiveLine(promptText: string, history: string[], cwd: string, initialLine = ""): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return fallbackAsk(promptText, history);
  }

  return new Promise((resolve) => {
    let line = initialLine;
    let cursor = initialLine.length;
    let geom: RenderGeometry = { ...EMPTY_GEOMETRY };
    let repaintTimer: ReturnType<typeof setImmediate> | null = null;
    let settled = false;
    let historyIndex = history.length;
    let draftLine = "";
    let selectedSuggestion = 0;
    const wasRaw = process.stdin.isRaw;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (repaintTimer) { clearImmediate(repaintTimer); repaintTimer = null; }
      process.stdin.off("keypress", onKeypress);
      if (!wasRaw) process.stdin.setRawMode(false);
      clearRendered(geom);
      process.stdout.write(promptText + (value ?? line) + "\n");
      resolve(value);
    };

    const currentSuggestions = () => commandSuggestions(line, cwd);

    const applySuggestion = () => {
      const suggestions = currentSuggestions();
      const suggestion = suggestions[selectedSuggestion];
      if (!suggestion) return false;
      setLine(suggestion.value);
      return true;
    };

    const repaint = () => {
      if (repaintTimer) { clearImmediate(repaintTimer); repaintTimer = null; }
      const suggestions = currentSuggestions();
      if (selectedSuggestion >= suggestions.length) selectedSuggestion = Math.max(0, suggestions.length - 1);
      geom = renderPrompt(
        {
          line,
          cursor,
          promptText,
          suggestionRows: commandSuggestionRows(suggestions, selectedSuggestion),
        },
        geom,
      );
    };

    // Coalesce a burst of inserts (paste / drag delivers many keypresses in one
    // synchronous tick) into a single repaint, so wrapped lines don't stack up.
    const scheduleRepaint = () => {
      if (repaintTimer) return;
      repaintTimer = setImmediate(() => {
        repaintTimer = null;
        repaint();
      });
    };

    const setLine = (next: string) => {
      line = next;
      cursor = line.length;
      selectedSuggestion = 0;
      repaint();
    };

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (currentSuggestions().length > 0 && applySuggestion()) {
          finish(line);
          return;
        }
        finish(line);
        return;
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor--;
          repaint();
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1);
          repaint();
        }
        return;
      }
      if (key.name === "left") {
        if (cursor > 0) {
          cursor--;
          repaint();
        }
        return;
      }
      if (key.name === "right") {
        if (cursor < line.length) {
          cursor++;
          repaint();
        }
        return;
      }
      if (key.name === "home") {
        cursor = 0;
        repaint();
        return;
      }
      if (key.name === "end") {
        cursor = line.length;
        repaint();
        return;
      }
      if (key.name === "up") {
        const suggestions = currentSuggestions();
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion - 1 + suggestions.length) % suggestions.length;
          repaint();
          return;
        }
        if (history.length === 0) return;
        if (historyIndex === history.length) draftLine = line;
        historyIndex = Math.max(0, historyIndex - 1);
        setLine(history[historyIndex] ?? "");
        return;
      }
      if (key.name === "down") {
        const suggestions = currentSuggestions();
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion + 1) % suggestions.length;
          repaint();
          return;
        }
        if (history.length === 0) return;
        historyIndex = Math.min(history.length, historyIndex + 1);
        setLine(historyIndex === history.length ? draftLine : history[historyIndex] ?? "");
        return;
      }
      if (key.name === "tab") {
        applySuggestion();
        return;
      }
      if (key.ctrl || key.meta) return;
      if (str) {
        // Strip control chars (newlines/tabs etc. from a paste or drag) before inserting.
        const clean = str.replace(/[\x00-\x1f\x7f]/g, "");
        if (clean) {
          line = line.slice(0, cursor) + clean + line.slice(cursor);
          cursor += clean.length;
          historyIndex = history.length;
          selectedSuggestion = 0;
          scheduleRepaint();
        }
      }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    repaint();
  });
}

/**
 * Read multi-line input. A trailing backslash continues onto the next line.
 * The continuation prompt is "... " to visually indicate more input is expected.
 */
async function readMultiline(history: string[], initialLine = ""): Promise<string | null> {
  const lines: string[] = [];
  let first = true;

  while (true) {
    if (first) process.stdout.write("\n");
    const promptText = first
      ? chalk.bold.green("› ")
      : chalk.dim("... ");
    const line = await readInteractiveLine(promptText, first ? history : [], process.cwd(), first ? initialLine : "");
    if (line === null) {
      return first ? null : lines.join("\n");
    }
    if (line.endsWith("\\") && !line.endsWith("\\\\")) {
      lines.push(line.slice(0, -1));
      first = false;
      continue;
    }
    lines.push(line);
    break;
  }

  const result = lines.join("\n");
  return result.trim() ? result.trim() : result;
}
/** Run a shell command directly and print output. */
function runShellCommand(command: string): void {
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (output.trim()) {
      console.log(output.trimEnd());
    }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    if (execErr.stdout) console.log(execErr.stdout.trimEnd());
    if (execErr.stderr) console.error(chalk.red(execErr.stderr.trimEnd()));
    if (!execErr.stdout && !execErr.stderr) {
      ui.error(execErr.message ?? String(err));
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "ExitPromptError" || err.name === "AbortPromptError")
  );
}

/** Returns true if input starts with "!" (shell escape). */
function isShellEscape(input: string): boolean {
  return /^![^!]/.test(input.trim());
}

export async function startRepl(agent: Agent, config: Config): Promise<void> {
  // Try restoring previous session.
  const prevSession = loadSession(process.cwd());
  let sessionRestored = false;
  if (prevSession && (prevSession.messages.length > 1 || prevSession.contextSummary)) {
    agent.restoreSession(prevSession);
    sessionRestored = true;
  }

  const mcp = mcpStatus();
  ui.banner(config.model, process.cwd(), {
    sessionMsg: sessionRestored
      ? "session: restored (" + agent.messageCount() + " messages" + (agent.getContextSummary() ? ", compressed context active" : "") + ")"
      : undefined,
    mcpTools: mcp.infos.length,
    mcpErrors: mcp.errors.length,
  });

  agent.sessionStart();

  const history: string[] = [];
  const queuedInputs: string[] = [];
  const generationInput = new QueuedInputController(queuedInputs);
  let queuedDraft = "";

  const handleInput = async (input: string): Promise<boolean> => {
    if (!input) return true;

    // Add to history for arrow-key recall.
    const firstLine = input.split("\n")[0].trim();
    if (firstLine && !history.includes(firstLine)) {
      history.push(firstLine);
    }

    // Shell escape: !command runs directly.
    if (isShellEscape(input)) {
      const command = input.trim().slice(1);
      ui.toolCall(`! ${command}`);
      runShellCommand(command);
      return true;
    }

    // Dragged-in files: a terminal inserts absolute paths as text. Detect them
    // (before the slash-command check, since paths start with "/") and attach.
    const dragged = extractDraggedPaths(input, process.cwd());
    if (dragged.paths.length > 0) {
      ui.info(`📎 attached: ${dragged.paths.map((p) => path.basename(p)).join(", ")}`);
      try {
        await agent.run(dragged.text, { attachments: dragged.paths, generationInput });
        saveSession(process.cwd(), agent.getSession());
      } catch (err) {
        if (isAbortError(err)) {
          ui.warn("\nInterrupted.");
        } else {
          ui.error(`\nError: ${(err as Error).message}`);
        }
      }
      return true;
    }

    // Quick memory: #note appends to DEEPSEEK.md.
    if (input.trim().startsWith("#")) {
      const note = input.trim().slice(1).trim();
      if (!note) {
        ui.warn("Usage: #<note to remember>");
        return true;
      }
      try {
        const file = appendProjectMemory(process.cwd(), note);
        agent.reloadProjectContext();
        ui.success(`Added to project memory (${file}).`);
      } catch (err) {
        ui.error(`Could not write memory: ${(err as Error).message}`);
      }
      return true;
    }

    if (isCommand(input)) {
      try {
        const result = await runCommand(input, { agent, config, generationInput });
        if (result.exit) {
          saveSession(process.cwd(), agent.getSession());
          console.log(chalk.dim("Goodbye."));
          return false;
        }
      } catch (err) {
        if (!isAbortError(err)) ui.error(`Command error: ${(err as Error).message}`);
      }
      return true;
    }

    try {
      await agent.run(input, { generationInput });
      saveSession(process.cwd(), agent.getSession());
    } catch (err) {
      if (isAbortError(err)) {
        ui.warn("\nInterrupted.");
        return true;
      }
      ui.error(`\nError: ${(err as Error).message}`);
    }

    return true;
  };

  while (true) {
    let input: string | null;
    if (queuedInputs.length > 0) {
      input = queuedInputs.shift() ?? "";
      process.stdout.write("\n" + chalk.bold.green("› ") + input + "\n");
    } else {
      queuedDraft = generationInput.takeDraft() || queuedDraft;
      try {
        input = await readMultiline(history, queuedDraft);
        queuedDraft = "";
      } catch (err) {
        if (isAbortError(err)) {
          console.log();
          continue;
        }
        throw err;
      }
    }

    if (input === null) {
      saveSession(process.cwd(), agent.getSession());
      console.log(chalk.dim("\nGoodbye."));
      return;
    }

    const keepGoing = await handleInput(input);
    if (!keepGoing) return;
  }
}
