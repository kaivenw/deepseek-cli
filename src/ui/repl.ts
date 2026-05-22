import { execSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import type { Agent, GenerationInputController } from "../agent.js";
import { maskKey, type Config } from "../config.js";
import { isCommand, runCommand, suggestCommands } from "../commands.js";
import { ui, chalk } from "./render.js";
import { loadSession, saveSession } from "../session.js";
import { loadHistory, saveHistory } from "../history.js";
import { appendProjectMemory } from "../project.js";
import { extractDraggedPaths } from "../attachments.js";
import path from "node:path";
import { mcpStatus } from "../mcp.js";
import { permissionModeLabel } from "../permissions.js";

/** Lets the input editor display & cycle the permission mode via Shift+Tab. */
interface ModeController {
  /** Display label for the current mode, or "" when in the default/normal mode. */
  label(): string;
  /** Advance to the next permission mode. */
  cycle(): void;
}

type CompletionKind = "command" | "file" | "none";

interface Completion {
  /** Display label, e.g. "/model" or "@src/app.ts". */
  label: string;
  /** Secondary description (commands only). */
  detail: string;
  /** Text spliced into the line in place of [start, end). */
  replacement: string;
  start: number;
  end: number;
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

// --- File index for @-mention completion (bounded, cached) ---
const FILE_INDEX_TTL_MS = 5000;
const FILE_INDEX_CAP = 8000;
const FILE_INDEX_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".idea", ".cache", "coverage",
]);
let fileIndexCache: { cwd: string; files: string[]; time: number } | null = null;

function indexProjectFiles(cwd: string): string[] {
  const now = Date.now();
  if (fileIndexCache && fileIndexCache.cwd === cwd && now - fileIndexCache.time < FILE_INDEX_TTL_MS) {
    return fileIndexCache.files;
  }
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (files.length >= FILE_INDEX_CAP) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= FILE_INDEX_CAP) return;
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!FILE_INDEX_IGNORE.has(entry.name)) walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  walk(cwd, "");
  fileIndexCache = { cwd, files, time: now };
  return files;
}

export function fuzzyFileMatch(files: string[], query: string, limit: number): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 120 - base.length;
    else if (lower.startsWith(q)) score = 100 - lower.length;
    else if (base.includes(q)) score = 80 - base.indexOf(q);
    else if (lower.includes(q)) score = 60 - lower.indexOf(q);
    else {
      let qi = 0;
      for (const ch of lower) {
        if (ch === q[qi]) qi++;
        if (qi === q.length) break;
      }
      if (qi === q.length) score = 30 - (lower.length - q.length);
    }
    if (score > -1) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  return scored.slice(0, limit).map((s) => s.file);
}

/** The @-mention token under the cursor, or null. */
export function atTokenRange(line: string, cursor: number): { start: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(line[start - 1])) start--;
  const token = line.slice(start, cursor);
  if (!token.startsWith("@")) return null;
  return { start, query: token.slice(1) };
}

/** Completions for the current line: slash commands, or @-mention files. */
export function getCompletions(line: string, cursor: number, cwd: string): { kind: CompletionKind; items: Completion[] } {
  const trimmedStart = line.trimStart();
  if (trimmedStart.startsWith("/")) {
    const commands = suggestCommands(trimmedStart.slice(1), { limit: 8, cwd });
    return {
      kind: "command",
      items: commands.map((c) => ({
        label: c.usage,
        detail: c.description,
        replacement: c.usage.split(" ")[0],
        start: 0,
        end: line.length,
      })),
    };
  }
  const at = atTokenRange(line, cursor);
  if (at) {
    const files = fuzzyFileMatch(indexProjectFiles(cwd), at.query, 8);
    if (files.length > 0) {
      return {
        kind: "file",
        items: files.map((f) => ({
          label: "@" + f,
          detail: "",
          replacement: "@" + f + " ",
          start: at.start,
          end: cursor,
        })),
      };
    }
  }
  return { kind: "none", items: [] };
}

function completionRows(items: Completion[], selectedIndex: number): string[] {
  return items.map((item, index) => {
    const selected = index === selectedIndex;
    const label = (selected ? chalk.cyan : chalk.dim)(item.label.padEnd(14));
    const detail = item.detail ? " " + (selected ? chalk.white : chalk.dim)(item.detail) : "";
    return "  " + label + detail;
  });
}

interface RenderGeometry {
  /** Total physical terminal rows the rendered block occupies. */
  rows: number;
  /** Physical row (0-based from the top of the block) where the input cursor sits. */
  cursorRow: number;
}

const EMPTY_GEOMETRY: RenderGeometry = { rows: 0, cursorRow: 0 };

export class QueuedInputController implements GenerationInputController {
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
    // INVARIANT: while the controller is active, nothing else may write to stdout
    // outside of beforeOutput()/afterOutput(). The agent only starts the controller
    // during the idle wait and tool awaits, and stops it before streaming reasoning
    // /answer text — so this animation timer never interleaves with other output.
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

  /**
   * Esc with queued messages (Claude Code v2.1): move the most recent queued
   * message back into the input instead of interrupting. Returns true if it
   * consumed the Esc (so the caller should NOT interrupt); false if nothing was
   * queued (caller interrupts).
   */
  handleEscape(): boolean {
    if (!this.active || this.queue.length === 0) return false;
    this.editLastQueued();
    return true;
  }

  private editLastQueued(): void {
    if (this.queue.length === 0) return;
    const last = this.queue.pop() ?? "";
    // Prepend any in-progress draft so nothing typed is lost.
    this.line = this.line ? `${last} ${this.line}` : last;
    this.cursor = this.line.length;
    this.repaint();
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  handleKeypress(str: string, key: readline.Key): void {
    if (!this.active) return;
    if (key.name === "paste-start" || key.name === "paste-end") return; // ignore paste markers
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
    // Up: pull the most recent queued message back into the input to edit it.
    if (key.name === "up") {
      this.editLastQueued();
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
    const loadingLine = `${chalk.hex("#f4b860")("*")} ${chalk.hex("#f4b860")(this.status + dots)}`;
    const queuedLines = this.queue.map(
      (msg, i) => "  " + chalk.dim(`⏳ ${i + 1}. ${this.truncate(msg, 64)}`),
    );
    const tipLine = this.queue.length > 0
      ? "  " + chalk.dim("enter queues · ↑ edit queued · esc un-queues · ctrl+c interrupts")
      : "  " + chalk.dim("enter queues next message · esc interrupts");
    const divider = chalk.dim("─".repeat(Math.min(process.stdout.columns || 60, 60)));
    const header = [loadingLine, ...queuedLines, tipLine, divider].join("\n");
    this.geom = renderPrompt(
      {
        line: this.line,
        cursor: this.cursor,
        promptText: `${header}\n${chalk.bold.green("› ")}`,
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

/**
 * Lay out the input content (which may contain "\n" from Shift+Enter or a
 * multi-line paste). Each logical line wraps independently across `cols`; the
 * first one starts after the prompt. Returns total physical rows and the
 * cursor's physical row/column within the content block.
 */
export function computeLayout(
  promptWidth: number,
  line: string,
  cols: number,
  cursor: number,
): { contentRows: number; cursorRow: number; cursorCol: number } {
  const segments = line.split("\n");
  let contentRows = 0;
  let cursorRow = 0;
  let cursorCol = promptWidth % cols;
  let idx = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startCol = i === 0 ? promptWidth : 0;
    const total = startCol + displayWidth(seg);
    const segRows = Math.max(1, Math.ceil((total === 0 ? 1 : total) / cols));
    const segStart = idx;
    const segEnd = idx + seg.length;
    if (cursor >= segStart && cursor <= segEnd) {
      const colOffset = startCol + displayWidth(seg.slice(0, cursor - segStart));
      cursorRow = contentRows + Math.min(segRows - 1, Math.floor(colOffset / cols));
      cursorCol = colOffset % cols;
    }
    contentRows += segRows;
    idx = segEnd + 1; // consume the "\n" separator
  }
  return { contentRows, cursorRow, cursorCol };
}

function renderPrompt(state: PromptRenderState, previous: RenderGeometry): RenderGeometry {
  clearRendered(previous);

  const cols = Math.max(1, process.stdout.columns || 80);
  process.stdout.write(state.promptText + state.line);
  for (const row of state.suggestionRows) {
    process.stdout.write("\n" + row);
  }

  // Account for the prompt+line wrapping across terminal columns and any
  // embedded newlines in the input.
  const promptPrefix = state.promptText.slice(0, Math.max(0, state.promptText.lastIndexOf("\n") + 1));
  const prefixRows = physicalRows(promptPrefix.endsWith("\n") ? promptPrefix.slice(0, -1) : promptPrefix, cols);
  const promptWidth = lastLineWidth(state.promptText);
  const { contentRows, cursorRow: contentCursorRow, cursorCol } = computeLayout(
    promptWidth,
    state.line,
    cols,
    state.cursor,
  );
  const totalRows = prefixRows + contentRows + state.suggestionRows.length;
  const cursorRow = prefixRows + contentCursorRow;

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

export function readInteractiveLine(promptText: string, history: string[], cwd: string, initialLine = "", modeProvider?: ModeController): Promise<string | null> {
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
    let ctrlCArmed = false;
    let escArmed = false;
    let hint = "";
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    let pasting = false;
    // Reverse history search (Ctrl+R) state.
    let searchMode = false;
    let searchQuery = "";
    let matchIdx = -1;
    let savedLine = "";
    let savedCursor = 0;
    const wasRaw = process.stdin.isRaw;

    const disarm = () => {
      ctrlCArmed = false;
      escArmed = false;
      hint = "";
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };
    const arm = (which: "ctrlc" | "esc", message: string) => {
      ctrlCArmed = which === "ctrlc";
      escArmed = which === "esc";
      hint = message;
      if (armTimer) clearTimeout(armTimer);
      armTimer = setTimeout(() => { disarm(); repaint(); }, 2500);
      repaint();
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (repaintTimer) { clearImmediate(repaintTimer); repaintTimer = null; }
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      process.stdin.off("keypress", onKeypress);
      if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l"); // disable bracketed paste
      if (!wasRaw) process.stdin.setRawMode(false);
      clearRendered(geom);
      process.stdout.write(promptText + (value ?? line) + "\n");
      resolve(value);
    };

    const completions = () => getCompletions(line, cursor, cwd);

    const applyCompletion = (item: Completion) => {
      line = line.slice(0, item.start) + item.replacement + line.slice(item.end);
      cursor = item.start + item.replacement.length;
      selectedSuggestion = 0;
      repaint();
    };

    const repaint = () => {
      if (repaintTimer) { clearImmediate(repaintTimer); repaintTimer = null; }
      let rows: string[] = [];
      if (searchMode) {
        const tag = matchIdx >= 0 ? "" : chalk.red("  (no match)");
        const q = searchQuery ? searchQuery : chalk.dim("type to search");
        rows.push(
          chalk.cyan("  ⌕ ") + chalk.dim("reverse-search: ") + q + tag +
            chalk.dim("   ^R older · ↵ accept · Esc cancel"),
        );
      } else {
        const { items } = completions();
        if (selectedSuggestion >= items.length) selectedSuggestion = Math.max(0, items.length - 1);
        rows = completionRows(items, selectedSuggestion);
        const modeLabel = modeProvider?.label() ?? "";
        if (modeLabel) rows.push(chalk.yellow("  ⏵⏵ " + modeLabel) + chalk.dim("  ·  shift+tab to cycle"));
        if (hint) rows.push(chalk.dim("  " + hint));
        // Idle hint bar: only when the line is empty and nothing else is showing.
        if (!hint && items.length === 0 && line.length === 0) {
          rows.push(chalk.dim("  ↵ send · ⌥↵ newline · / commands · @ files · ^R history · ^C exit"));
        }
      }
      geom = renderPrompt(
        {
          line,
          cursor,
          promptText,
          suggestionRows: rows,
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

    // --- word boundaries (for Ctrl/Alt word movement & deletion) ---
    const isWordChar = (c: string | undefined): boolean => !!c && !/\s/.test(c);
    const prevWord = (pos: number): number => {
      let i = pos;
      while (i > 0 && !isWordChar(line[i - 1])) i--;
      while (i > 0 && isWordChar(line[i - 1])) i--;
      return i;
    };
    const nextWord = (pos: number): number => {
      let i = pos;
      while (i < line.length && !isWordChar(line[i])) i++;
      while (i < line.length && isWordChar(line[i])) i++;
      return i;
    };

    // --- vertical cursor movement across logical lines (multi-line input) ---
    const moveVertical = (dir: -1 | 1): boolean => {
      if (!line.includes("\n")) return false;
      const lineStart = line.lastIndexOf("\n", cursor - 1) + 1;
      const col = cursor - lineStart;
      if (dir === -1) {
        if (lineStart === 0) return false; // already on the first line
        const prevStart = line.lastIndexOf("\n", lineStart - 2) + 1;
        const prevLen = lineStart - 1 - prevStart;
        cursor = prevStart + Math.min(col, prevLen);
      } else {
        const lineEnd = line.indexOf("\n", cursor);
        if (lineEnd === -1) return false; // already on the last line
        const nextStart = lineEnd + 1;
        let nextEnd = line.indexOf("\n", nextStart);
        if (nextEnd === -1) nextEnd = line.length;
        cursor = nextStart + Math.min(col, nextEnd - nextStart);
      }
      repaint();
      return true;
    };

    // --- reverse history search (Ctrl+R) ---
    const findMatch = (from: number): number => {
      const q = searchQuery.toLowerCase();
      for (let i = from; i >= 0; i--) {
        const entry = history[i];
        if (entry != null && entry.toLowerCase().includes(q)) return i;
      }
      return -1;
    };
    const enterSearch = (): void => {
      searchMode = true;
      searchQuery = "";
      savedLine = line;
      savedCursor = cursor;
      matchIdx = history.length - 1;
      repaint();
    };
    const refreshSearch = (): void => {
      matchIdx = findMatch(history.length - 1);
      if (matchIdx >= 0) { line = history[matchIdx]; cursor = line.length; }
      repaint();
    };
    const olderMatch = (): void => {
      if (matchIdx > 0) {
        const idx = findMatch(matchIdx - 1);
        if (idx >= 0) { matchIdx = idx; line = history[idx]; cursor = line.length; }
      }
      repaint();
    };
    const exitSearch = (keep: boolean): void => {
      searchMode = false;
      searchQuery = "";
      if (keep) historyIndex = history.length;
      else { line = savedLine; cursor = savedCursor; }
      selectedSuggestion = 0;
      repaint();
    };

    const onKeypress = (str: string, key: readline.Key) => {
      // Bracketed paste: insert literal text (incl. newlines) without firing keys.
      if (key.name === "paste-start") { pasting = true; return; }
      if (key.name === "paste-end") {
        pasting = false;
        historyIndex = history.length;
        selectedSuggestion = 0;
        scheduleRepaint();
        return;
      }
      if (pasting) {
        // Keep newlines (\n = 0x0a); drop CR and other control chars.
        const chunk = (str ?? "").replace(/\r/g, "").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
        if (chunk) {
          line = line.slice(0, cursor) + chunk + line.slice(cursor);
          cursor += chunk.length;
          scheduleRepaint();
        }
        return;
      }

      // Reverse-search sub-mode swallows most keys while active.
      if (searchMode) {
        if (key.ctrl && key.name === "r") { olderMatch(); return; }
        if ((key.ctrl && (key.name === "c" || key.name === "g")) || key.name === "escape") { exitSearch(false); return; }
        if (key.name === "return" || key.name === "enter") { exitSearch(true); return; }
        if (key.name === "backspace") { searchQuery = searchQuery.slice(0, -1); refreshSearch(); return; }
        if (["left", "right", "home", "end"].includes(key.name ?? "")) { exitSearch(true); return; }
        if (key.ctrl || key.meta) return;
        if (str) {
          const clean = str.replace(/[\x00-\x1f\x7f]/g, "");
          if (clean) { searchQuery += clean; refreshSearch(); }
        }
        return;
      }

      // Ctrl+C: clear a non-empty line; on an empty line, require a second press to exit.
      if (key.ctrl && key.name === "c") {
        if (line.length > 0) {
          line = "";
          cursor = 0;
          disarm();
          repaint();
          return;
        }
        if (ctrlCArmed) {
          disarm();
          finish(null);
          return;
        }
        arm("ctrlc", "press Ctrl+C again to exit");
        return;
      }
      // Esc: clear a non-empty line; on an empty line, double-Esc opens rewind.
      if (key.name === "escape" && !key.ctrl && !key.meta) {
        if (line.length > 0) {
          line = "";
          cursor = 0;
          disarm();
          repaint();
          return;
        }
        if (escArmed) {
          disarm();
          finish("/rewind");
          return;
        }
        arm("esc", "press Esc again to rewind / edit a previous step");
        return;
      }
      // Any other key cancels a pending Ctrl+C / Esc arming.
      if (ctrlCArmed || escArmed) disarm();
      // Ctrl+R: open reverse history search.
      if (key.ctrl && key.name === "r") {
        if (history.length > 0) enterSearch();
        return;
      }
      // Option/Alt/Shift + Enter: insert a newline instead of submitting.
      if ((key.name === "return" || key.name === "enter") && (key.meta || key.shift)) {
        line = line.slice(0, cursor) + "\n" + line.slice(cursor);
        cursor++;
        selectedSuggestion = 0;
        repaint();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const { kind, items } = completions();
        const item = items[selectedSuggestion];
        if (item) {
          applyCompletion(item);
          // File picks keep editing; command picks submit immediately.
          if (kind === "command") finish(line);
          return;
        }
        finish(line);
        return;
      }
      // Delete previous word: Ctrl+W or Alt/Meta+Backspace.
      if ((key.ctrl && key.name === "w") || (key.meta && key.name === "backspace")) {
        const start = prevWord(cursor);
        if (start < cursor) {
          line = line.slice(0, start) + line.slice(cursor);
          cursor = start;
          repaint();
        }
        return;
      }
      // Delete next word: Alt/Meta+Delete or Alt/Meta+d.
      if (key.meta && (key.name === "delete" || key.name === "d")) {
        const end = nextWord(cursor);
        if (end > cursor) {
          line = line.slice(0, cursor) + line.slice(end);
          repaint();
        }
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
      // Word-wise movement: Ctrl/Alt + arrows, Alt+b / Alt+f.
      if ((key.ctrl || key.meta) && key.name === "left") { cursor = prevWord(cursor); repaint(); return; }
      if ((key.ctrl || key.meta) && key.name === "right") { cursor = nextWord(cursor); repaint(); return; }
      if (key.meta && key.name === "b") { cursor = prevWord(cursor); repaint(); return; }
      if (key.meta && key.name === "f") { cursor = nextWord(cursor); repaint(); return; }
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
        const items = completions().items;
        if (items.length > 0) {
          selectedSuggestion = (selectedSuggestion - 1 + items.length) % items.length;
          repaint();
          return;
        }
        if (moveVertical(-1)) return; // multi-line: move cursor up a line first
        if (history.length === 0) return;
        if (historyIndex === history.length) draftLine = line;
        historyIndex = Math.max(0, historyIndex - 1);
        setLine(history[historyIndex] ?? "");
        return;
      }
      if (key.name === "down") {
        const items = completions().items;
        if (items.length > 0) {
          selectedSuggestion = (selectedSuggestion + 1) % items.length;
          repaint();
          return;
        }
        if (moveVertical(1)) return; // multi-line: move cursor down a line first
        if (history.length === 0) return;
        historyIndex = Math.min(history.length, historyIndex + 1);
        setLine(historyIndex === history.length ? draftLine : history[historyIndex] ?? "");
        return;
      }
      if (key.name === "tab" && key.shift) {
        if (modeProvider) {
          modeProvider.cycle();
          repaint();
        }
        return;
      }
      if (key.name === "tab") {
        const items = completions().items;
        if (items[selectedSuggestion]) applyCompletion(items[selectedSuggestion]);
        return;
      }
      // Emacs-style line editing.
      if (key.ctrl && key.name === "a") { cursor = 0; repaint(); return; }
      if (key.ctrl && key.name === "e") { cursor = line.length; repaint(); return; }
      if (key.ctrl && key.name === "u") {
        if (cursor > 0) { line = line.slice(cursor); cursor = 0; repaint(); }
        return;
      }
      if (key.ctrl && key.name === "k") {
        if (cursor < line.length) { line = line.slice(0, cursor); repaint(); }
        return;
      }
      if (key.ctrl && key.name === "d") {
        if (line.length === 0) { finish(null); return; } // EOF on empty line
        if (cursor < line.length) { line = line.slice(0, cursor) + line.slice(cursor + 1); repaint(); }
        return;
      }
      if (key.ctrl && key.name === "l") {
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback
        geom = { ...EMPTY_GEOMETRY };
        repaint();
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
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h"); // enable bracketed paste
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    repaint();
  });
}

/**
 * Read multi-line input. A trailing backslash continues onto the next line.
 * The continuation prompt is "... " to visually indicate more input is expected.
 */
async function readMultiline(history: string[], initialLine = "", modeProvider?: ModeController): Promise<string | null> {
  const lines: string[] = [];
  let first = true;

  while (true) {
    if (first) process.stdout.write("\n");
    const promptText = first
      ? chalk.bold.green("› ")
      : chalk.dim("... ");
    const line = await readInteractiveLine(promptText, first ? history : [], process.cwd(), first ? initialLine : "", modeProvider);
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
  const keyName = config.apiKeyFromEnv ? "env" : (config.activeApiKey ?? "default");
  ui.banner(config.model, process.cwd(), {
    sessionMsg: sessionRestored
      ? "session: restored (" + agent.messageCount() + " messages" + (agent.getContextSummary() ? ", compressed context active" : "") + ")"
      : undefined,
    mcpTools: mcp.infos.length,
    mcpErrors: mcp.errors.length,
    apiKeyLabel: config.apiKey ? keyName + " · " + maskKey(config.apiKey) : undefined,
  });

  agent.sessionStart();

  const history: string[] = loadHistory(process.cwd());
  const queuedInputs: string[] = [];
  const generationInput = new QueuedInputController(queuedInputs);
  let queuedDraft = "";

  const modeProvider: ModeController = {
    label: () => (agent.getPermissionMode() === "default" ? "" : permissionModeLabel(agent.getPermissionMode())),
    cycle: () => { agent.cyclePermissionMode(); },
  };

  const handleInput = async (input: string): Promise<boolean> => {
    if (!input) return true;

    // Add to history for arrow-key recall (full input, so multi-line drafts round-trip).
    const entry = input.trim();
    if (entry && history[history.length - 1] !== entry) {
      history.push(entry);
      saveHistory(process.cwd(), history);
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
        input = await readMultiline(history, queuedDraft, modeProvider);
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
