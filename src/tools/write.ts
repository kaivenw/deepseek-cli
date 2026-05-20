import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";

export const writeTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file, creating it (and parent directories) or overwriting it entirely. " +
    "Prefer edit_file for modifying existing files.",
  needsApproval: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (absolute or relative to the working directory).",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
    required: ["path", "content"],
  },
  preview(args, ctx) {
    const rel = String(args.path);
    const abs = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
    const exists = fs.existsSync(abs);
    const lines = String(args.content ?? "").split("\n").length;
    return `${exists ? "overwrite" : "create"} ${rel} (${lines} lines)`;
  },
  async run(args, ctx) {
    const rel = String(args.path);
    const content = String(args.content ?? "");
    const abs = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);

    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");

    return {
      content: `${existed ? "Overwrote" : "Created"} ${rel} (${content.split("\n").length} lines).`,
      summary: `${existed ? "Overwrote" : "Created"} ${rel}`,
    };
  },
};
