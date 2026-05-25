import fs from "node:fs";
import { ocrEnabled, ocrPdf } from "./ocr.js";

export interface PdfExtractResult {
  ok: boolean;
  text?: string;
  pages?: number;
  truncated?: boolean;
  /** True when the text came from OCR (scanned PDF) rather than the text layer. */
  ocr?: boolean;
  error?: string;
}

export interface PdfExtractOptions {
  /** Run OCR when the PDF has no text layer. Defaults to ocrEnabled(). */
  ocr?: boolean;
  /** Progress callback during OCR (slow). */
  onOcrPage?: (page: number, total: number) => void;
}

export function isPdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * Extract plain text from a PDF using unpdf (a pure-JS bundle of pdf.js — no
 * native dependencies). Imported lazily so it only loads when a PDF is opened.
 * Scanned PDFs (no text layer) fall back to OCR when enabled.
 */
export async function extractPdfText(
  absPath: string,
  maxChars = 50_000,
  opts: PdfExtractOptions = {},
): Promise<PdfExtractResult> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const data = new Uint8Array(fs.readFileSync(absPath));
    const pdf = await getDocumentProxy(data);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    let merged = (typeof text === "string" ? text : (text as unknown as string[]).join("\n\n")).trim();
    if (!merged) {
      // No text layer → likely scanned. Try OCR if enabled.
      if (opts.ocr ?? ocrEnabled()) {
        const result = await ocrPdf(absPath, maxChars, 20, opts.onOcrPage);
        if (result.ok) {
          return { ok: true, text: result.text, pages: result.pages ?? totalPages, ocr: true };
        }
        return {
          ok: false,
          pages: totalPages,
          error: `scanned PDF — OCR failed: ${result.error}${result.hint ? ` (${result.hint})` : ""}`,
        };
      }
      return {
        ok: false,
        pages: totalPages,
        error: "no extractable text (likely scanned; OCR disabled via DEEPSEEK_OCR)",
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
