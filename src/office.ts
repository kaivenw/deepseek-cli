import fs from "node:fs";
import { decodeXmlEntities, collectTagText } from "./xml.js";

export interface OfficeExtractResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  error?: string;
}

export function isPptx(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pptx");
}

export function isXlsx(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".xlsx");
}

/** Numeric suffix of a path like ".../slide12.xml" → 12 (for stable ordering). */
function numberIn(name: string): number {
  const m = name.match(/(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "\n…[truncated]", truncated: true };
}

/**
 * Extract text from a PowerPoint (.pptx). Slides live in ppt/slides/slideN.xml;
 * each text run is an <a:t> element. Imported lazily so fflate only loads on use.
 */
export async function extractPptxText(absPath: string, maxChars = 50_000): Promise<OfficeExtractResult> {
  try {
    const { unzipSync, strFromU8 } = await import("fflate");
    const data = new Uint8Array(fs.readFileSync(absPath));
    const files = unzipSync(data, { filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
    const names = Object.keys(files).sort((a, b) => numberIn(a) - numberIn(b));
    if (names.length === 0) return { ok: false, error: "no slides found (not a standard .pptx?)" };

    const parts: string[] = [];
    names.forEach((name, i) => {
      const runs = collectTagText(strFromU8(files[name]), "t").map((s) => s.trim()).filter(Boolean);
      if (runs.length > 0) parts.push(`--- Slide ${i + 1} ---\n${runs.join("\n")}`);
    });
    if (parts.length === 0) return { ok: false, error: "no extractable text (slides may be images only)" };

    const { text, truncated } = clamp(parts.join("\n\n"), maxChars);
    return { ok: true, text, truncated };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Parse xl/sharedStrings.xml into an ordered array of cell strings. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // An <si> may contain multiple <t> runs (rich text); concatenate them.
    out.push(collectTagText(m[1], "t").join(""));
  }
  return out;
}

/** Flatten one worksheet's rows into tab/newline separated text. */
function sheetToText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] || "";
      const inner = cellMatch[2] || "";
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const idx = Number(collectTagText(inner, "v")[0] ?? "");
        value = shared[idx] ?? "";
      } else if (type === "inlineStr") {
        value = collectTagText(inner, "t").join("");
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = v != null ? decodeXmlEntities(v) : "";
      }
      cells.push(value);
    }
    // Trim trailing empty cells so rows aren't padded with tabs.
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length > 0) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/**
 * Extract text from an Excel workbook (.xlsx). Cell strings are deduped in
 * xl/sharedStrings.xml and referenced by index from each xl/worksheets/sheetN.xml.
 */
export async function extractXlsxText(absPath: string, maxChars = 50_000): Promise<OfficeExtractResult> {
  try {
    const { unzipSync, strFromU8 } = await import("fflate");
    const data = new Uint8Array(fs.readFileSync(absPath));
    const files = unzipSync(data, {
      filter: (f) => f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
    });
    const shared = files["xl/sharedStrings.xml"] ? parseSharedStrings(strFromU8(files["xl/sharedStrings.xml"])) : [];
    const sheetNames = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => numberIn(a) - numberIn(b));
    if (sheetNames.length === 0) return { ok: false, error: "no worksheets found (not a standard .xlsx?)" };

    const parts: string[] = [];
    sheetNames.forEach((name, i) => {
      const body = sheetToText(strFromU8(files[name]), shared);
      if (body.trim()) parts.push(`--- Sheet ${i + 1} ---\n${body}`);
    });
    if (parts.length === 0) return { ok: false, error: "no extractable text (the workbook may be empty)" };

    const { text, truncated } = clamp(parts.join("\n\n"), maxChars);
    return { ok: true, text, truncated };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
