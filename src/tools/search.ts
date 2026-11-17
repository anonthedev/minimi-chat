import Exa from "exa-js";
import { Firecrawl } from "firecrawl";

const RESULT_LIMIT = 5;
const HIGHLIGHT_ENOUGH = 500;
const PAGE_CHARS = 8_000;
const HIGHLIGHT_CHARS = 1_000;

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "is", "are",
  "what", "how", "why", "when", "where", "who", "did", "do", "does", "i", "we",
  "you", "me", "my", "our", "about", "with", "from", "that", "this",
]);

type Hit = { url: string; title: string; highlights: string };

export async function webSearch(input: { query?: string; url?: string }): Promise<unknown> {
  const query = input.query?.trim() ?? "";
  const url = input.url?.trim() ?? "";
  if (!query && !url) return { error: "Provide a query or a url." };
  if (url && !isHttpUrl(url)) return { error: "url must be an http or https address." };

  if (url) {
    const page = await readPage(url);
    return { results: [], page };
  }

  let hits: Hit[];
  try {
    hits = await searchWeb(query);
  } catch (error) {
    return { error: messageOf(error) };
  }
  if (hits.length === 0) return { results: [], error: "No pages found." };

  const ranked = hits
    .map((hit) => ({ hit, score: scoreHit(query, hit) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0].hit;
  const results = ranked.map(({ hit }) => hit);
  if (best.highlights.length >= HIGHLIGHT_ENOUGH) return { results };

  const page = await readPage(best.url);
  return { results, page };
}

async function searchWeb(query: string): Promise<Hit[]> {
  const exa = new Exa(process.env.EXA_API_KEY);
  const response = await exa.search(query, {
    numResults: RESULT_LIMIT,
    type: "auto",
    contents: { highlights: true },
  });
  const hits: Hit[] = [];
  for (const result of response.results) {
    if (!result.url) continue;
    const highlights = (result.highlights ?? []).join("\n").slice(0, HIGHLIGHT_CHARS);
    hits.push({ url: result.url, title: result.title ?? "", highlights });
  }
  return hits;
}

async function readPage(url: string): Promise<{ url: string; text: string } | { url: string; error: string }> {
  const scraped = await scrape(url);
  if (scraped) return { url, text: scraped };
  const fresh = await readFresh(url);
  if (fresh) return { url, text: fresh };
  return { url, error: "This page could not be read." };
}

async function scrape(url: string): Promise<string | null> {
  try {
    const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
    const document = await firecrawl.scrape(url, { formats: ["markdown"] });
    return usable(document.markdown);
  } catch {
    return null;
  }
}

async function readFresh(url: string): Promise<string | null> {
  try {
    const exa = new Exa(process.env.EXA_API_KEY);
    const response = await exa.getContents([url], { text: true, maxAgeHours: 0 });
    const text = response.results.find((result) => result.url === url)?.text ?? response.results[0]?.text;
    return usable(text);
  } catch {
    return null;
  }
}

function usable(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length < 80) return null;
  if (/just a moment|enable javascript|access denied|captcha|are you a robot/i.test(trimmed.slice(0, 600))) {
    return null;
  }
  return trimmed.slice(0, PAGE_CHARS);
}

function scoreHit(query: string, hit: Hit): number {
  const wanted = tokens(query);
  const found = tokens(`${hit.title} ${hit.highlights} ${hit.url}`);
  let score = 0;
  for (const token of wanted) if (found.has(token)) score += 1;
  if (/\b(best|roundup|listicle)\b|\btop\s+\d+/i.test(`${hit.title} ${hit.url}`)) score -= 2;
  return score;
}

function tokens(value: string): Set<string> {
  const found = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(found.filter((token) => token.length > 2 && !STOP.has(token)));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Search failed.";
}
