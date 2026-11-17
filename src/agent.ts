import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs, streamText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { createChat, deleteChat, getChat, insertMessage, messageCount, recentMessages, titleFrom } from "./db.ts";
import type { RecalledMessage } from "./db.ts";
import { decidePrior, NO_PRIOR } from "./prior.ts";
import type { PriorDecision } from "./prior.ts";
import { recall } from "./tools/recall.ts";
import { webSearch } from "./tools/search.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

const instructions = `You are a chat agent with a memory of this conversation and a way to read the live web.

Write the reply in Markdown: paragraphs, lists when you are enumerating, and fenced code when you show code. When a sentence uses a web page, link that page in the sentence as [title](url). Use only URLs the tool returned.

Start the reply with one line and nothing else on it: Context: chat if the answer uses a recent message, Context: earlier if it uses an earlier turn and not a recent message, Context: both if it uses both, or Context: none if it uses neither. That line is removed before the reader sees the reply. Do not mention it again.

A Sources section is appended only for pages you were given and for earlier messages you actually used. Do not write that section yourself. If you used neither, there is no Sources section. Do not invent facts, numbers, or links. If a page could not be read, say so.

A past statement is allowed only when those words are in the recent messages or in the earlier turns given to you. If those earlier turns say nothing was found, say that it was not found. Never invent, reconstruct, or guess what was said.

The recent messages are already in the conversation. Earlier turns, when a question needs them, are included above. Use them when they answer the question. If a factual answer is not in those messages, call web_search before you answer.

Call web_search when the answer depends on the live web. Pass a focused query, or a url when a specific page should be read.

When something said earlier has to be compared with the web now, state what was said from the messages you were given, then call web_search and compare.

If the messages already answer the question, do not call a tool.`;

export async function respond(input: {
  message: string;
  chatId: number | null;
  onChat: (chat: { id: number; title: string }) => void;
  onStatus: (tool: string) => void;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const existing = input.chatId === null ? null : getChat(input.chatId);
  if (input.chatId !== null && !existing) throw new Error("That chat was not found.");
  const created = !existing;
  const chat = existing ?? createChat(titleFrom(input.message));
  if (created) console.log(`chat ${chat.id} created "${chat.title}"`);
  input.onChat({ id: chat.id, title: chat.title });
  console.log(`chat ${chat.id} user: ${oneLine(input.message)}`);

  const recent = recentMessages(chat.id);
  const history: ModelMessage[] = recent.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  input.onStatus("Checking earlier turns");
  let earlier: { note: string; messages: RecalledMessage[] } = { note: "", messages: [] };
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  let text = "";
  let usedTool = false;
  const context = { raw: "", decided: false, recent: false, earlier: false };
  const sources: string[] = [];
  const seen = new Set<string>();
  try {
    const prior = await decidePrior({ message: input.message, history: recent, signal: input.signal });
    earlier = earlierTurns(prior, chat.id, new Set(recent.map((message) => message.id)));
    console.log(`chat ${chat.id} prior: ${formatPrior(prior, earlier)}`);
    const result = streamText({
      model: openrouter.chat(process.env.OPENROUTER_MODEL || DEFAULT_MODEL),
      instructions: earlier.note ? `${instructions}\n\n${earlier.note}` : instructions,
      messages: [...history, { role: "user", content: input.message }],
      stopWhen: stepCountIs(8),
      abortSignal: input.signal,
      tools: {
        web_search: tool({
          description: "Search the live web, or read one URL. Returns highlights and, when those are thin, the text of one page.",
          inputSchema: z.object({
            query: z.string().optional().describe("What to look up."),
            url: z.string().optional().describe("A page to read directly."),
          }),
          execute: async (args) => webSearch(args),
        }),
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === "tool-input-start") input.onStatus(part.toolName);
      if (part.type === "tool-call") {
        usedTool = true;
        console.log(`tool ${part.toolName} ${formatArgs(part.toolName, part.input)}`);
      }
      if (part.type === "tool-result" && !part.preliminary) {
        console.log(`tool ${part.toolName} ${formatResult(part.toolName, part.output)}`);
        collectSources(part.toolName, part.output, seen, sources);
      }
      if (part.type === "tool-error") {
        usedTool = true;
        console.log(`tool ${part.toolName} failed: ${part.error instanceof Error ? part.error.message : "The tool failed."}`);
      }
      if (part.type === "text-delta") {
        const piece = readContextMarker(context, part.text);
        if (piece) {
          text += piece;
          input.onDelta(piece);
        }
      }
      if (part.type === "error") throw part.error;
    }
  } catch (error) {
    if (created && messageCount(chat.id) === 0) deleteChat(chat.id);
    throw error;
  }

  if (!context.decided && context.raw) {
    text += context.raw;
    input.onDelta(context.raw);
  }
  if (!usedTool) console.log(`chat ${chat.id} no tools`);
  const usedRecent = context.recent && history.length > 0;
  const usedEarlier = context.earlier && earlier.messages.length > 0;
  console.log(`chat ${chat.id} context: ${contextLabel(usedRecent, usedEarlier)}`);

  if (text.trim()) {
    const extra = sourceSection(sources, usedRecent, usedEarlier ? earlier.messages : []);
    text += extra;
    if (extra) input.onDelta(extra);
  }

  const createdAt = new Date();
  insertMessage(chat.id, "user", input.message, createdAt);
  if (text.trim()) insertMessage(chat.id, "assistant", text, createdAt);
  console.log(`chat ${chat.id} assistant: ${oneLine(text)}`);
  return text;
}

function oneLine(value: string, max = 160): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max).trimEnd()}…`;
}

function formatArgs(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  if (name === "web_search") {
    if (typeof input.url === "string" && input.url.trim()) return `url=${input.url.trim()}`;
    if (typeof input.query === "string") return `query=${JSON.stringify(input.query)}`;
  }
  return JSON.stringify(input);
}

function formatResult(name: string, output: unknown): string {
  if (!isRecord(output)) return "done";
  if (typeof output.error === "string") return `error: ${oneLine(output.error, 120)}`;
  if (name === "web_search") {
    const count = Array.isArray(output.results) ? output.results.length : 0;
    const page = isRecord(output.page) ? output.page : null;
    if (page && typeof page.error === "string") return `${count} pages, unread`;
    if (page && typeof page.url === "string" && typeof page.text === "string") return `${count} pages, read ${hostOf(page.url)}`;
    return `${count} pages`;
  }
  return "done";
}

function readContextMarker(
  state: { raw: string; decided: boolean; recent: boolean; earlier: boolean },
  chunk: string,
): string {
  if (state.decided) return chunk;
  state.raw += chunk;
  const newline = state.raw.indexOf("\n");
  const head = newline === -1 ? state.raw : state.raw.slice(0, newline);
  const match = head.match(/^\s*context:\s*(chat|earlier|both|none)\.?\s*(.*)$/i);
  if (match) {
    state.decided = true;
    const which = match[1].toLowerCase();
    state.recent = which === "chat" || which === "both";
    state.earlier = which === "earlier" || which === "both";
    const tail = newline === -1 ? "" : state.raw.slice(newline + 1);
    state.raw = "";
    return `${match[2]}${match[2] && tail ? "\n" : ""}${tail}`.replace(/^\n/, "");
  }
  if (newline !== -1 || state.raw.trim().length > 32) {
    state.decided = true;
    const held = state.raw;
    state.raw = "";
    return held;
  }
  return "";
}

function sourceSection(lines: string[], usedRecent: boolean, earlier: RecalledMessage[]): string {
  const items = [...lines];
  const seen = new Set<string>();
  for (const message of earlier) addChatSource(message, seen, items);
  if (usedRecent) items.push("- Recent messages in this chat");
  if (items.length === 0) return "";
  return `\n\n### Sources\n\n${items.join("\n")}\n`;
}

function collectSources(toolName: string, output: unknown, seen: Set<string>, lines: string[]): void {
  if (!isRecord(output)) return;
  if (toolName === "web_search") {
    const results = Array.isArray(output.results) ? output.results : [];
    for (const result of results) addWebSource(result, seen, lines);
    addWebSource(output.page, seen, lines);
  }
}

function earlierTurns(
  prior: PriorDecision,
  chatId: number,
  recentIds: Set<number>,
): { note: string; messages: RecalledMessage[] } {
  if (prior.answer === NO_PRIOR) return { note: "", messages: [] };
  const found = recall(prior, chatId);
  if (isRecord(found) && typeof found.error === "string") {
    return { note: `Earlier turns: ${found.error}`, messages: [] };
  }
  const rows = isRecord(found) && Array.isArray(found.messages) ? found.messages.filter(isRecalled) : [];
  const older = rows.filter((message) => !recentIds.has(message.id));
  if (older.length === 0) {
    return rows.length === 0 ? { note: "Earlier turns: nothing was found.", messages: [] } : { note: "", messages: [] };
  }
  const lines = older.map((message) => {
    const who = message.role === "user" ? "You" : "Assistant";
    const where = message.chat_title.trim() ? `, in "${message.chat_title}"` : "";
    return `- ${who}, ${formatWhen(message.created_at)}${where}: ${message.content}`;
  });
  return { note: `Earlier turns:\n${lines.join("\n")}`, messages: older };
}

function formatPrior(prior: PriorDecision, earlier: { note: string; messages: RecalledMessage[] }): string {
  if (prior.answer === NO_PRIOR) return NO_PRIOR;
  const fields = ["start", "end", "query", "error"]
    .flatMap((key) => {
      const value = prior[key as "start" | "end" | "query" | "error"];
      return value ? [`${key}=${JSON.stringify(value)}`] : [];
    })
    .join(" ");
  const outcome = earlier.messages.length > 0 ? `${earlier.messages.length} messages` : earlier.note.replace(/^Earlier turns:\s*/, "");
  return `${fields} (${outcome})`;
}

function contextLabel(usedRecent: boolean, usedEarlier: boolean): string {
  if (usedRecent && usedEarlier) return "both";
  if (usedRecent) return "chat";
  if (usedEarlier) return "earlier";
  return "none";
}

function isRecalled(value: unknown): value is RecalledMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.chat_title === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    typeof value.created_at === "string"
  );
}

function addWebSource(value: unknown, seen: Set<string>, lines: string[]): void {
  if (!isRecord(value) || typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) return;
  if (typeof value.error === "string") return;
  if (seen.has(value.url)) return;
  seen.add(value.url);
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : hostOf(value.url);
  lines.push(`- [${cleanLabel(title)}](${value.url})`);
}

function addChatSource(value: unknown, seen: Set<string>, lines: string[]): void {
  if (!isRecord(value)) return;
  if (value.role !== "user" && value.role !== "assistant") return;
  if (typeof value.content !== "string" || typeof value.created_at !== "string") return;
  const key = `${value.role}:${value.created_at}:${value.content.slice(0, 80)}`;
  if (seen.has(key)) return;
  seen.add(key);
  const who = value.role === "user" ? "You" : "Assistant";
  const chat = typeof value.chat_title === "string" && value.chat_title.trim() ? cleanLabel(value.chat_title) : "";
  const where = chat ? `, in "${chat}"` : "";
  lines.push(`- ${who}, ${formatWhen(value.created_at)}${where}: ${excerpt(value.content)}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cleanLabel(title: string): string {
  return title.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
}

function excerpt(content: string): string {
  const line = content.replace(/[\[\]()*_`#]/g, "").replace(/\s+/g, " ").trim();
  if (line.length <= 96) return line;
  return `${line.slice(0, 96).trimEnd()}…`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.TIMEZONE || "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
