import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { makeDiff } from "./diff.js";

export const editTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file with new text. The old_string must appear exactly once " +
    "(include surrounding context to make it unique), unless replace_all is true.",
  needsApproval: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit (absolute or relative to the working directory).",
      },
      old_string: {
        type: "string",
        description: "The exact text to replace.",
      },
      new_string: {
        type: "string",
        description: "The replacement text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match (default false).",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  preview(args) {
    return `edit ${String(args.path)}`;
  },
  async run(args, ctx) {
    const rel = String(args.path);
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const replaceAll = Boolean(args.replace_all);
    const abs = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);

    if (!fs.existsSync(abs)) {
      return { content: `Error: file not found: ${rel}`, isError: true };
    }
    if (oldStr === newStr) {
      return { content: "Error: old_string and new_string are identical.", isError: true };
    }

    const original = fs.readFileSync(abs, "utf8");
    const count = original.split(oldStr).length - 1;

    if (count === 0) {
      return {
        content: `Error: old_string not found in ${rel}. Read the file again to get exact text.`,
        isError: true,
      };
    }
    if (count > 1 && !replaceAll) {
      return {
        content: `Error: old_string appears ${count} times in ${rel}. Add more context to make it unique, or set replace_all.`,
        isError: true,
      };
    }

    const updated = replaceAll
      ? original.split(oldStr).join(newStr)
      : original.replace(oldStr, newStr);
    ctx.recordFileBackup?.(abs, original);
    fs.writeFileSync(abs, updated, "utf8");

    const replacements = replaceAll ? count : 1;
    return {
      content: `Edited ${rel} (${replacements} replacement${replacements > 1 ? "s" : ""}).`,
      summary: `Edited ${rel}`,
      display: makeDiff(rel, original, updated),
    };
  },
};
