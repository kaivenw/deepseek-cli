import type { Tool } from "./types.js";

const MAX_CHARS = 20_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content (HTML is stripped to readable text). " +
    "Use for reading documentation or pages the user links to.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch (http/https)." },
    },
    required: ["url"],
  },
  preview(args) {
    return `fetch ${String(args.url)}`;
  },
  async run(args) {
    const url = String(args.url);
    if (!/^https?:\/\//i.test(url)) {
      return { content: "Error: url must start with http:// or https://", isError: true };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "deepseek-cli/0.1 (+https://github.com)" },
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { content: `Error: HTTP ${res.status} ${res.statusText} for ${url}`, isError: true };
      }
      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();
      const text = contentType.includes("html") ? htmlToText(body) : body;
      const clipped =
        text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…[content truncated]" : text;

      return { content: clipped || "(empty response)", summary: `Fetched ${url}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error fetching ${url}: ${msg}`, isError: true };
    }
  },
};
