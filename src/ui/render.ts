import chalk from "chalk";
import type { Usage } from "../client.js";

export const ui = {
  banner(model: string, cwd: string, sessionMsg?: string): void {
    const title = chalk.bold.cyan("DeepSeek CLI");
    console.log();
    console.log(`  ${title} ${chalk.dim("· an agentic coding assistant")}`);
    console.log(`  ${chalk.dim("model:")} ${chalk.green(model)}`);
    console.log(`  ${chalk.dim("cwd:  ")} ${chalk.dim(cwd)}`);
    if (sessionMsg) console.log(`  ${chalk.dim(sessionMsg)}`);
    console.log(`  ${chalk.dim("type /help for commands, exit to quit")}`);
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
