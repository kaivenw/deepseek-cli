import type { Tool } from "./types.js";

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .trim();
}

/** Unwrap DuckDuckGo's redirect links to the real target URL. */
function unwrapDuckUrl(href: string): string {
  try {
    const u = href.startsWith("//") ? "https:" + href : href;
    const parsed = new URL(u, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

function parseDuckResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeEntities(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && hits.length < limit) {
    hits.push({
      url: unwrapDuckUrl(m[1]),
      title: decodeEntities(m[2]),
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return hits;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web and return a list of result titles, URLs, and snippets. " +
    "Follow up with web_fetch to read a specific result.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      limit: { type: "number", description: "Max results to return (optional, default 8)." },
    },
    required: ["query"],
  },
  preview(args) {
    return `search "${String(args.query)}"`;
  },
  async run(args) {
    const query = String(args.query);
    const limit = Math.min(Number(args.limit) || 8, 15);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { content: `Error: search returned HTTP ${res.status}`, isError: true };
      }
      const html = await res.text();
      const hits = parseDuckResults(html, limit);

      if (hits.length === 0) {
        return { content: `No results for "${query}".`, summary: `search "${query}": 0 results` };
      }
      const formatted = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
        .join("\n\n");
      return { content: formatted, summary: `search "${query}": ${hits.length} results` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error searching: ${msg}`, isError: true };
    }
  },
};
