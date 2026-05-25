import fs from "node:fs";

export interface OcrResult {
  ok: boolean;
  text?: string;
  pages?: number;
  error?: string;
  /** Install hint shown when the optional OCR dependencies are missing. */
  hint?: string;
}

const MISSING_HINT =
  "OCR is optional — enable it with: npm i -g tesseract.js @napi-rs/canvas (or set DEEPSEEK_OCR=off to skip OCR).";

/** OCR is attempted by default; disable with DEEPSEEK_OCR=off|0|false|no. */
export function ocrEnabled(): boolean {
  const v = (process.env.DEEPSEEK_OCR ?? "").toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

function ocrLangs(): string {
  return process.env.DEEPSEEK_OCR_LANGS || "eng+chi_sim";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTesseract(): Promise<any | null> {
  try {
    // String-typed specifier: optional dep, resolved at runtime (not build time).
    const mod: any = await import("tesseract.js" as string);
    // tesseract.js is CJS — under ESM interop the API may live on `.default`.
    return typeof mod?.recognize === "function" ? mod : (mod?.default ?? mod);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recognize(tesseract: any, bytes: Uint8Array): Promise<string> {
  const { data } = await tesseract.recognize(Buffer.from(bytes), ocrLangs());
  return (data?.text ?? "").trim();
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "\n…[truncated]", truncated: true };
}

/** OCR a standalone image file (PNG/JPG/…). */
export async function ocrImageFile(absPath: string, maxChars = 50_000): Promise<OcrResult> {
  const tesseract = await loadTesseract();
  if (!tesseract) return { ok: false, error: "tesseract.js not installed", hint: MISSING_HINT };
  try {
    const raw = await recognize(tesseract, new Uint8Array(fs.readFileSync(absPath)));
    if (!raw) return { ok: false, error: "no text recognized in image" };
    const { text } = truncate(raw, maxChars);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message, hint: MISSING_HINT };
  }
}

/**
 * OCR a scanned PDF: rasterize each page (unpdf + @napi-rs/canvas) then recognize.
 * Both heavy deps are optional and lazily imported; a clear hint is returned if
 * they're missing so the base install stays lean.
 */
export async function ocrPdf(
  absPath: string,
  maxChars = 50_000,
  maxPages = 20,
  onPage?: (page: number, total: number) => void,
): Promise<OcrResult> {
  const tesseract = await loadTesseract();
  if (!tesseract) return { ok: false, error: "tesseract.js not installed", hint: MISSING_HINT };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unpdf: any;
  const canvasImport = () => import("@napi-rs/canvas" as string);
  try {
    unpdf = await import("unpdf");
    await canvasImport(); // probe: @napi-rs/canvas must be present to rasterize
  } catch {
    return { ok: false, error: "@napi-rs/canvas not installed (needed to rasterize PDF pages)", hint: MISSING_HINT };
  }

  try {
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(fs.readFileSync(absPath)));
    const total = Math.min(pdf.numPages ?? 1, maxPages);
    const parts: string[] = [];
    for (let i = 1; i <= total; i++) {
      onPage?.(i, total);
      const png = await unpdf.renderPageAsImage(pdf, i, { canvasImport, scale: 2 });
      const pageText = await recognize(tesseract, new Uint8Array(png));
      if (pageText) parts.push(`--- Page ${i} ---\n${pageText}`);
    }
    const merged = parts.join("\n\n").trim();
    if (!merged) return { ok: false, error: "OCR produced no text" };
    const { text } = truncate(merged, maxChars);
    return { ok: true, text, pages: total };
  } catch (err) {
    return { ok: false, error: (err as Error).message, hint: MISSING_HINT };
  }
}
