import fs from "node:fs";

export interface PdfExtractResult {
  ok: boolean;
  text?: string;
  pages?: number;
  truncated?: boolean;
  error?: string;
}

export function isPdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * Extract plain text from a PDF using unpdf (a pure-JS bundle of pdf.js — no
 * native dependencies). Imported lazily so it only loads when a PDF is opened.
 */
export async function extractPdfText(absPath: string, maxChars = 50_000): Promise<PdfExtractResult> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const data = new Uint8Array(fs.readFileSync(absPath));
    const pdf = await getDocumentProxy(data);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    let merged = (typeof text === "string" ? text : (text as unknown as string[]).join("\n\n")).trim();
    if (!merged) {
      return {
        ok: false,
        pages: totalPages,
        error: "no extractable text (the PDF is likely scanned images; OCR is not supported)",
      };
    }
    const truncated = merged.length > maxChars;
    if (truncated) merged = merged.slice(0, maxChars) + "\n…[truncated]";
    return { ok: true, text: merged, pages: totalPages, truncated };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Heuristic: does this file look like non-text binary? Reads a small prefix and
 * checks for NUL bytes (very rare in real text, ubiquitous in binary formats).
 */
export function isProbablyBinaryFile(absPath: string): boolean {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(8000);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      for (let i = 0; i < bytes; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
