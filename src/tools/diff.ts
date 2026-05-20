import { structuredPatch } from "diff";

const MAX_DIFF_LINES = 80;

/**
 * Produce a compact unified diff (hunks only) between two strings, or undefined
 * if they are identical. Lines are prefixed with +/-/space; hunks with @@.
 * The caller is responsible for colouring.
 */
export function makeDiff(label: string, oldStr: string, newStr: string): string | undefined {
  if (oldStr === newStr) return undefined;

  const patch = structuredPatch(label, label, oldStr, newStr, "", "", { context: 2 });
  const out: string[] = [];
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) out.push(line);
  }
  if (out.length === 0) return undefined;

  if (out.length > MAX_DIFF_LINES) {
    const omitted = out.length - MAX_DIFF_LINES;
    return out.slice(0, MAX_DIFF_LINES).join("\n") + `\n…(${omitted} more diff lines)`;
  }
  return out.join("\n");
}
