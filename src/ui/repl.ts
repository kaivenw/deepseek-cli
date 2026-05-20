import { execSync } from "node:child_process";
import readline from "node:readline";
import type { Agent } from "../agent.js";
import type { Config } from "../config.js";
import { isCommand, runCommand, suggestCommands } from "../commands.js";
import { ui, chalk } from "./render.js";
import { loadSession, saveSession } from "../session.js";
import { appendProjectMemory } from "../project.js";
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

function clearRenderedBlock(renderedRows: number): void {
  if (renderedRows <= 0) return;
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
}

function renderPrompt(state: PromptRenderState, previousRows: number): number {
  clearRenderedBlock(previousRows);

  process.stdout.write(state.promptText + state.line);
  for (const row of state.suggestionRows) {
    process.stdout.write("\n" + row);
  }

  const renderedRows = 1 + state.suggestionRows.length;
  if (state.suggestionRows.length > 0) {
    readline.moveCursor(process.stdout, 0, -state.suggestionRows.length);
  }
  readline.cursorTo(process.stdout, lastLineWidth(state.promptText) + displayWidth(state.line.slice(0, state.cursor)));
  return renderedRows;
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

function readInteractiveLine(promptText: string, history: string[], cwd: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return fallbackAsk(promptText, history);
  }

  return new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let renderedRows = 0;
    let settled = false;
    let historyIndex = history.length;
    let draftLine = "";
    let selectedSuggestion = 0;
    const wasRaw = process.stdin.isRaw;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      process.stdin.off("keypress", onKeypress);
      if (!wasRaw) process.stdin.setRawMode(false);
      clearRenderedBlock(renderedRows);
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
      const suggestions = currentSuggestions();
      if (selectedSuggestion >= suggestions.length) selectedSuggestion = Math.max(0, suggestions.length - 1);
      renderedRows = renderPrompt(
        {
          line,
          cursor,
          promptText,
          suggestionRows: commandSuggestionRows(suggestions, selectedSuggestion),
        },
        renderedRows,
      );
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
      if (str && str >= " " && str !== "\x7f") {
        line = line.slice(0, cursor) + str + line.slice(cursor);
        cursor += str.length;
        historyIndex = history.length;
        selectedSuggestion = 0;
        repaint();
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
async function readMultiline(history: string[]): Promise<string | null> {
  const lines: string[] = [];
  let first = true;

  while (true) {
    if (first) process.stdout.write("\n");
    const promptText = first
      ? chalk.bold.green("› ")
      : chalk.dim("... ");
    const line = await readInteractiveLine(promptText, first ? history : [], process.cwd());
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

  const history: string[] = [];

  while (true) {
    let input: string | null;
    try {
      input = await readMultiline(history);
    } catch (err) {
      if (isAbortError(err)) {
        console.log();
        continue;
      }
      throw err;
    }

    if (input === null) {
      saveSession(process.cwd(), agent.getSession());
      console.log(chalk.dim("\nGoodbye."));
      return;
    }

    if (!input) continue;

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
      continue;
    }

    // Quick memory: #note appends to DEEPSEEK.md.
    if (input.trim().startsWith("#")) {
      const note = input.trim().slice(1).trim();
      if (!note) {
        ui.warn("Usage: #<note to remember>");
        continue;
      }
      try {
        const file = appendProjectMemory(process.cwd(), note);
        agent.reloadProjectContext();
        ui.success(`Added to project memory (${file}).`);
      } catch (err) {
        ui.error(`Could not write memory: ${(err as Error).message}`);
      }
      continue;
    }

    if (isCommand(input)) {
      try {
        const result = await runCommand(input, { agent, config });
        if (result.exit) {
          saveSession(process.cwd(), agent.getSession());
          console.log(chalk.dim("Goodbye."));
          return;
        }
      } catch (err) {
        if (!isAbortError(err)) ui.error(`Command error: ${(err as Error).message}`);
      }
      continue;
    }

    try {
      await agent.run(input);
      saveSession(process.cwd(), agent.getSession());
    } catch (err) {
      if (isAbortError(err)) {
        ui.warn("\nInterrupted.");
        continue;
      }
      ui.error(`\nError: ${(err as Error).message}`);
    }
  }
}
