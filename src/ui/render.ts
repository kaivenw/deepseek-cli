import chalk from "chalk";
import os from "node:os";
import type { Usage } from "../client.js";

interface BannerOptions {
  sessionMsg?: string;
  mcpTools?: number;
  mcpErrors?: number;
  /** Active API-key label (name + masked value), shown in the banner. */
  apiKeyLabel?: string;
}

const CLI_VERSION = "0.3.0";

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

function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return "";

  let out = "";
  let used = 0;
  const suffix = "...";
  const suffixWidth = displayWidth(suffix);
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth + suffixWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out + suffix;
}

function padEndDisplay(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function centerDisplay(text: string, width: number): string {
  const clipped = clip(text, width);
  const remaining = Math.max(0, width - displayWidth(clipped));
  const left = Math.floor(remaining / 2);
  return " ".repeat(left) + clipped + " ".repeat(remaining - left);
}

function panelLine(content: string, width: number): string {
  return chalk.hex("#f4b860")("│") + padEndDisplay(content, width) + chalk.hex("#f4b860")("│");
}

function twoColumnLine(left: string, right: string, leftWidth: number, rightWidth: number, width: number): string {
  return panelLine(padEndDisplay(left, leftWidth) + " " + chalk.dim("│") + " " + padEndDisplay(right, rightWidth), width);
}

function deepSeekLogo(): string[] {
  const cyan = chalk.hex("#28d4c3");
  const blue = chalk.hex("#38bdf8");
  const dark = chalk.hex("#0f766e");
  const eye = chalk.whiteBright;
  return [
    "       " + blue("▄████████▄") + "       ",
    "    " + blue("▄██") + cyan("▓▓▓▓▓▓▓▓") + blue("██▄") + "    ",
    "  " + blue("▄█") + cyan("▓▓  ") + eye("●") + cyan("    ") + eye("●") + cyan("  ▓▓") + blue("█▄") + "  ",
    "  " + blue("██") + cyan("▓▓     ▄▄     ▓▓") + blue("██") + " ",
    "  " + blue("██") + cyan("▓▓  ▄████▄   ▓▓") + blue("██") + " ",
    "   " + blue("▀█") + cyan("▓▓  ▀▄▄▀  ▓▓") + blue("█▀") + "   ",
    "     " + blue("▀██") + cyan("▓▓▓▓") + blue("██▀") + "      ",
    "        " + dark("██  ██") + "        ",
  ];
}

export const ui = {
  banner(model: string, cwd: string, sessionMsgOrOptions?: string | BannerOptions): void {
    const options: BannerOptions = typeof sessionMsgOrOptions === "string"
      ? { sessionMsg: sessionMsgOrOptions }
      : (sessionMsgOrOptions ?? {});
    const columns = process.stdout.columns || 100;
    const outerWidth = Math.min(Math.max(columns - 4, 76), 150);
    const innerWidth = outerWidth - 2;
    const accent = chalk.hex("#f4b860");
    const title = "─ DeepSeek CLI v" + CLI_VERSION + " ";
    const top = accent("╭" + title + "─".repeat(Math.max(0, innerWidth - displayWidth(title))) + "╮");
    const bottom = accent("╰" + "─".repeat(innerWidth) + "╯");
    const user = os.userInfo().username || "there";
    const mcpText = options.mcpTools && options.mcpTools > 0
      ? options.mcpTools + " tool" + (options.mcpTools === 1 ? "" : "s") + " loaded"
      : "/mcp init to add tools";
    const mcpErrorText = options.mcpErrors && options.mcpErrors > 0
      ? " · " + options.mcpErrors + " issue" + (options.mcpErrors === 1 ? "" : "s")
      : "";
    const sessionText = options.sessionMsg ?? "new session";
    const sessionLine = sessionText.startsWith("session:") ? sessionText : "session: " + sessionText;

    console.log();
    console.log(top);

    if (innerWidth >= 96) {
      const leftWidth = Math.floor((innerWidth - 3) * 0.49);
      const rightWidth = innerWidth - leftWidth - 3;
      const logo = deepSeekLogo();
      const leftLines = [
        "",
        centerDisplay(chalk.bold("Welcome back " + user + "!"), leftWidth),
        "",
        ...logo.map((line) => centerDisplay(line, leftWidth)),
        "",
        centerDisplay(chalk.green(model) + chalk.dim(" · agentic coding"), leftWidth),
        centerDisplay(chalk.dim(cwd), leftWidth),
      ];
      const rightLines = [
        "",
        chalk.bold.hex("#f4b860")("Tips for getting started"),
        "Run " + chalk.cyan("/init") + " to create project memory",
        "Type " + chalk.cyan("/") + " to browse and fuzzy-search commands",
        "Use " + chalk.cyan("@file") + " or " + chalk.cyan("drag a file in") + " to attach",
        "Use " + chalk.cyan("#note") + " to write memory quickly",
        "Use " + chalk.cyan("!cmd") + " for direct shell commands",
        "",
        chalk.bold.hex("#f4b860")("What's new"),
        chalk.cyan("/mcp") + " loads stdio MCP servers as tools",
        chalk.cyan("/model") + " chooses DeepSeek model with arrows",
        chalk.cyan("/skills") + " turns markdown prompts into commands",
        "",
        chalk.dim(sessionLine),
        chalk.dim("MCP:     ") + chalk.dim(mcpText + mcpErrorText),
        ...(options.apiKeyLabel ? [chalk.dim("API key: ") + chalk.dim(options.apiKeyLabel)] : []),
      ];
      const rows = Math.max(leftLines.length, rightLines.length);
      for (let i = 0; i < rows; i++) {
        twoColumnLine(leftLines[i] ?? "", rightLines[i] ?? "", leftWidth, rightWidth, innerWidth);
      }
    } else {
      const logo = deepSeekLogo();
      const lines = [
        "",
        centerDisplay(chalk.bold("Welcome back " + user + "!"), innerWidth),
        "",
        ...logo.map((line) => centerDisplay(line, innerWidth)),
        "",
        centerDisplay(chalk.green(model) + chalk.dim(" · agentic coding"), innerWidth),
        centerDisplay(chalk.dim(cwd), innerWidth),
        centerDisplay(chalk.dim(sessionLine), innerWidth),
        centerDisplay(chalk.dim("MCP: " + mcpText + mcpErrorText), innerWidth),
        ...(options.apiKeyLabel ? [centerDisplay(chalk.dim("API key: " + options.apiKeyLabel), innerWidth)] : []),
        "",
        "  " + accent.bold("Tips") + " " + chalk.dim("/init · / · @file · drag-in · #note · !cmd · /mcp"),
        "",
      ];
      for (const line of lines) console.log(panelLine(line, innerWidth));
    }

    console.log(bottom);
    console.log(chalk.dim("  Type " + chalk.cyan("/") + " for commands, " + chalk.cyan("/exit") + " to quit."));
    console.log();
  },

  /** A label for assistant output. */
  assistantLabel(): void {
    process.stdout.write(chalk.bold.magenta("\n● "));
  },

  toolCall(summary: string): void {
    console.log(chalk.blue("  ⚙ ") + chalk.cyan(summary));
  },

  toolResult(summary: string, isError: boolean): void {
    const icon = isError ? chalk.red("  ✗ ") : chalk.green("  ✓ ");
    console.log(icon + chalk.dim(summary));
  },

  /** Render a unified diff (lines prefixed with +/-/@@) with colour. */
  diff(text: string): void {
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) console.log(chalk.cyan("    " + line));
      else if (line.startsWith("+")) console.log(chalk.green("    " + line));
      else if (line.startsWith("-")) console.log(chalk.red("    " + line));
      else console.log(chalk.dim("    " + line));
    }
  },

  reasoning(text: string): void {
    console.log(chalk.dim.italic("\n  [thinking] " + text.trim().replace(/\n/g, "\n  ")));
  },

  usage(usage: Usage, model?: string): void {
    const prompt = `${usage.promptTokens.toLocaleString()} in`;
    const comp = `${usage.completionTokens.toLocaleString()} out`;
    let line = `  ⟐ tokens: ${prompt} · ${comp} · ${usage.totalTokens.toLocaleString()} total`;
    if (model) {
      // Estimate cost using DeepSeek pricing.
      const pricing: Record<string, { input: number; output: number }> = {
        "deepseek-v4-pro": { input: 0.435, output: 0.87 },
        "deepseek-v4-flash": { input: 0.14, output: 0.28 },
      };
      const p = pricing[model] ?? pricing["deepseek-v4-pro"];
      const blended = (p.input + p.output) / 2;
      const cost = (usage.totalTokens / 1_000_000) * blended;
      line += chalk.dim(` · ~$${cost.toFixed(4)}`);
    }
    console.log(chalk.dim(line));
  },

  info(msg: string): void {
    console.log(chalk.dim(msg));
  },

  success(msg: string): void {
    console.log(chalk.green(msg));
  },

  warn(msg: string): void {
    console.log(chalk.yellow(msg));
  },

  error(msg: string): void {
    console.log(chalk.red(msg));
  },

  divider(): void {
    console.log(chalk.dim("─".repeat(Math.min(process.stdout.columns || 60, 60))));
  },
};

/** Minimal terminal spinner shown while waiting for the first token. */
export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | null = null;
  private i = 0;

  constructor(private label: string) {}

  start(): void {
    if (!process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${chalk.magenta(this.frames[this.i])} ${chalk.dim(this.label)}`);
      this.i = (this.i + 1) % this.frames.length;
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // Clear the spinner line.
      process.stdout.write("\r" + " ".repeat((this.label.length + 4)) + "\r");
    }
  }
}

export { chalk };
