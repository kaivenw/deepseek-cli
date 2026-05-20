import { glob } from "glob";
import path from "node:path";
import type { Tool } from "./types.js";

const MAX_RESULTS = 300;

export const globTool: Tool = {
  name: "list_files",
  description:
    "List files in a directory matching a glob pattern (e.g. 'src/**/*.ts'). Returns matching paths sorted by " +
    "most recently modified. Skips node_modules and .git. Use this to discover project structure and locate files.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'." },
      path: {
        type: "string",
        description: "Base directory to search from (optional, defaults to working directory).",
      },
    },
    required: ["pattern"],
  },
  preview(args) {
    return `list ${String(args.pattern)}`;
  },
  async run(args, ctx) {
    const pattern = String(args.pattern);
    const rel = args.path ? String(args.path) : ".";
    const base = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);

    const matches = await glob(pattern, {
      cwd: base,
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      stat: true,
      withFileTypes: true,
    });

    matches.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    const paths = matches.map((m) => m.fullpath());

    if (paths.length === 0) {
      return { content: `No files match ${pattern}.`, summary: `list ${pattern}: 0 files` };
    }
    const shown = paths.slice(0, MAX_RESULTS);
    const truncated = paths.length > MAX_RESULTS ? `\n…[${paths.length - MAX_RESULTS} more]` : "";
    return {
      content: shown.join("\n") + truncated,
      summary: `list ${pattern}: ${paths.length} file(s)`,
    };
  },
};
