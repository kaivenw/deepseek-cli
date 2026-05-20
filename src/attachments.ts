import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Strip surrounding quotes and unescape backslash-escapes from a shell-style token. */
function unquote(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  return token.replace(/\\(.)/g, "$1");
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Detect file paths dropped/dragged into the prompt (terminals insert the
 * absolute path as text, with spaces backslash-escaped or the whole path quoted).
 * Only absolute paths that point to existing files are treated as attachments,
 * so normal text and slash commands are left untouched.
 */
export function extractDraggedPaths(input: string, _cwd: string): { paths: string[]; text: string } {
  const tokenRe = /'[^']*'|"[^"]*"|(?:\\.|\S)+/g;
  const paths: string[] = [];
  const ranges: Array<[number, number]> = [];

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(input)) !== null) {
    const value = expandHome(unquote(match[0]));
    if (!path.isAbsolute(value)) continue;
    try {
      if (fs.statSync(value).isFile()) {
        paths.push(value);
        ranges.push([match.index, match.index + match[0].length]);
      }
    } catch {
      // Not an accessible file — ignore.
    }
  }

  if (paths.length === 0) return { paths: [], text: input };

  let text = "";
  let last = 0;
  for (const [start, end] of ranges) {
    text += input.slice(last, start);
    last = end;
  }
  text += input.slice(last);

  return { paths, text: text.replace(/\s+/g, " ").trim() };
}
