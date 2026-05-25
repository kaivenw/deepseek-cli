import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { isPdf, extractPdfText, isProbablyBinaryFile } from "../pdf.js";
import { isDocx, extractDocxText } from "../docx.js";

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

export const readTool: Tool = {
  name: "read_file",
  description:
    "Read a file from the local filesystem. Returns the contents with line numbers. " +
    "Use this before editing a file. Long files are truncated.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file (absolute, or relative to the working directory).",
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from (optional).",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to read (optional, default ${MAX_LINES}).`,
      },
    },
    required: ["path"],
  },
  preview(args) {
    return `read ${String(args.path)}`;
  },
  async run(args, ctx) {
    const rel = String(args.path);
    const abs = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);

    if (!fs.existsSync(abs)) {
      return { content: `Error: file not found: ${rel}`, isError: true };
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return { content: `Error: ${rel} is a directory, not a file.`, isError: true };
    }

    // PDFs are binary — extract their text instead of dumping raw bytes.
    if (isPdf(abs)) {
      const result = await extractPdfText(abs);
      if (!result.ok) {
        return { content: `Error: could not read PDF ${rel}: ${result.error}`, isError: true };
      }
      const header = `[Extracted text from PDF: ${rel} · ${result.pages} page(s)${result.truncated ? " · truncated" : ""}]\n\n`;
      return {
        content: header + result.text,
        summary: `Read PDF ${rel} (${result.pages} pages)`,
      };
    }

    // Word documents (.docx) are zipped XML — extract the body text.
    if (isDocx(abs)) {
      const result = await extractDocxText(abs);
      if (!result.ok) {
        return { content: `Error: could not read Word doc ${rel}: ${result.error}`, isError: true };
      }
      const header = `[Extracted text from Word doc: ${rel}${result.truncated ? " · truncated" : ""}]\n\n`;
      return {
        content: header + result.text,
        summary: `Read Word doc ${rel}`,
      };
    }

    // Guard other binary formats (.docx, .zip, images, …) from being dumped as mojibake.
    if (isProbablyBinaryFile(abs)) {
      return {
        content: `Error: ${rel} appears to be a binary file (${(stat.size / 1024).toFixed(0)} KB) and can't be read as text.`,
        isError: true,
      };
    }

    const raw = fs.readFileSync(abs, "utf8");
    // Drop the empty element a trailing newline produces so line counts are accurate.
    const allLines = raw.length === 0 ? [] : raw.replace(/\n$/, "").split("\n");
    const offset = args.offset ? Math.max(1, Number(args.offset)) : 1;
    const limit = args.limit ? Number(args.limit) : MAX_LINES;
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    const numbered = slice
      .map((line, i) => {
        const n = offset + i;
        const truncated =
          line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + " …[truncated]" : line;
        return `${String(n).padStart(6)}\t${truncated}`;
      })
      .join("\n");

    const more =
      offset - 1 + limit < allLines.length
        ? `\n\n[file has ${allLines.length} lines total; showing ${offset}-${offset + slice.length - 1}]`
        : "";

    return {
      content: numbered + more || "[empty file]",
      summary: `Read ${rel} (${slice.length} lines)`,
    };
  },
};
