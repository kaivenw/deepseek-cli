import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "./types.js";

const MAX_RESULTS = 200;

let ripgrepAvailable: boolean | undefined;
function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== undefined) return Promise.resolve(ripgrepAvailable);
  return new Promise((resolve) => {
    execFile("rg", ["--version"], (err) => {
      ripgrepAvailable = !err;
      resolve(ripgrepAvailable);
    });
  });
}

function runRipgrep(
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  ignoreCase: boolean,
): Promise<string> {
  const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", "50"];
  if (ignoreCase) rgArgs.push("-i");
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push(pattern, searchPath);
  return new Promise((resolve) => {
    execFile("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 }, (_err, stdout) => {
      resolve(stdout || "");
    });
  });
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);

function jsGrep(
  pattern: string,
  searchPath: string,
  ignoreCase: boolean,
): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : undefined);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : undefined);
  }
  const results: string[] = [];

  const walk = (dir: string) => {
    if (results.length >= MAX_RESULTS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        let content: string;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(`${full}:${i + 1}:${lines[i].slice(0, 300)}`);
            if (results.length >= MAX_RESULTS) return;
          }
        }
      }
    }
  };

  const stat = fs.existsSync(searchPath) ? fs.statSync(searchPath) : null;
  if (stat?.isFile()) {
    const content = fs.readFileSync(searchPath, "utf8").split("\n");
    content.forEach((line, i) => {
      if (re.test(line)) results.push(`${searchPath}:${i + 1}:${line.slice(0, 300)}`);
    });
  } else {
    walk(searchPath);
  }
  return results.join("\n");
}

export const grepTool: Tool = {
  name: "search_text",
  description:
    "Search file contents for a regular expression pattern. Returns matching lines with file:line:content. " +
    "Uses ripgrep when available. Skips node_modules/.git/dist by default. " +
    "Use this to find where a symbol, string, or pattern appears in the codebase.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: {
        type: "string",
        description: "Directory or file to search (optional, defaults to working directory).",
      },
      glob: {
        type: "string",
        description: "Filter files by glob, e.g. '*.ts' (optional, ripgrep only).",
      },
      ignore_case: { type: "boolean", description: "Case-insensitive search (optional)." },
    },
    required: ["pattern"],
  },
  preview(args) {
    return `search /${String(args.pattern)}/`;
  },
  async run(args, ctx: ToolContext) {
    const pattern = String(args.pattern);
    const rel = args.path ? String(args.path) : ".";
    const searchPath = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
    const glob = args.glob ? String(args.glob) : undefined;
    const ignoreCase = Boolean(args.ignore_case);

    let output: string;
    if (await hasRipgrep()) {
      output = await runRipgrep(pattern, searchPath, glob, ignoreCase);
    } else {
      output = jsGrep(pattern, searchPath, ignoreCase);
    }

    const lines = output.trim() ? output.trim().split("\n") : [];
    if (lines.length === 0) {
      return { content: `No matches for /${pattern}/.`, summary: `search /${pattern}/: 0 matches` };
    }
    const shown = lines.slice(0, MAX_RESULTS);
    const truncated = lines.length > MAX_RESULTS ? `\n…[${lines.length - MAX_RESULTS} more matches]` : "";
    return {
      content: shown.join("\n") + truncated,
      summary: `search /${pattern}/: ${lines.length} match(es)`,
    };
  },
};
