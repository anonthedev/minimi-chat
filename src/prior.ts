import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import { timeContext } from "./dates-model.ts";
import type { StoredMessage } from "./db.ts";

export const NO_PRIOR = "Needs no prior information";
const DEFAULT_PRIOR_MODEL = "google/gemini-2.5-flash";

const decisionSchema = z.object({
  answer: z.string().describe(`Exactly "${NO_PRIOR}", or "recall" when older turns are needed.`),
  start: z.string().nullable().optional().describe("Inclusive civil date, YYYY-MM-DD. Empty when the question names no start."),
  end: z.string().nullable().optional().describe("Exclusive civil date, YYYY-MM-DD. Empty when the question names no end."),
  query: z.string().nullable().optional().describe("A few keywords for the topic. Not a full sentence."),
  error: z.string().nullable().optional().describe("Set when the named time cannot exist. Empty otherwise."),
});

export type PriorDecision =
  | { answer: typeof NO_PRIOR }
  | { answer: "recall"; start?: string; end?: string; query?: string; error?: string };

const instructions = `You decide whether a question needs messages saved before the recent turns, and the time range to search.

Set answer to exactly "${NO_PRIOR}" when the question does not refer to an earlier conversation, a time, or a past claim. Leave start, end, query, and error empty.

Set answer to "recall" when it does. Pass query as a few keywords for the topic, not the whole sentence. A follow-up such as "is that still true?" is "recall" with query only: take the topic from the recent turns, and leave start and end empty. Do not copy a timestamp from the recent turns.

When the question itself names a time, set start and end to the half-open range in the given timezone, as YYYY-MM-DD. start is inclusive and end is exclusive. Copy weekdays and relative days from the day list. Do not calculate a weekday yourself.
A named day, weekday, week, or month always sets both start and end. A single day ends on the next civil day. A week starts on Monday and ends on the next Monday in the day list. "this week" is the Monday-to-Monday span that contains today. "last week" and "N weeks ago" are the whole earlier Monday-to-Monday spans in the day list.
"last <weekday>" is the most recent past weekday in the list and is never today. A bare weekday includes today when today is that day, and that range is still filled in: today through the next civil day.
A date with no year uses the latest year of that month under "Already started", then that day of the month. A date that already names its year is that year, even when the day is not in the list. A numeric date such as 3/11/2026 is day/month/year.
A month name is copied from "Already started": use the latest year of that month, and copy both dates on that line. A line under "Not started" is never the answer. When now is in February, March is the March line under "Already started".
Leave end empty only when the question says since, after, or from, and names no end. Leave start empty only when it says until or before, and names no start.
If the named time cannot exist, set error and leave start and end empty. A misspelled weekday is still that weekday.`;

export function interpretPrior(value: {
  answer?: string | null;
  start?: string | null;
  end?: string | null;
  query?: string | null;
  error?: string | null;
}): PriorDecision {
  const query = clean(value.query);
  const error = clean(value.error);
  const start = civil(value.start);
  const end = civil(value.end);
  const asksForRecall = value.answer?.trim().toLowerCase() !== NO_PRIOR.toLowerCase();
  if (!asksForRecall || (!start && !end && !query && !error)) return { answer: NO_PRIOR };
  if (error) return { answer: "recall", error };
  return {
    answer: "recall",
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(query ? { query } : {}),
  };
}

export async function decidePrior(input: {
  message: string;
  history: StoredMessage[];
  now?: Date;
  timeZone?: string;
  signal?: AbortSignal;
}): Promise<PriorDecision> {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone || process.env.TIMEZONE || "Asia/Kolkata";
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  const result = await generateText({
    model: openrouter.chat(process.env.OPENROUTER_PRIOR_MODEL || DEFAULT_PRIOR_MODEL),
    output: Output.object({ schema: decisionSchema, name: "prior" }),
    instructions,
    prompt: promptFor(input.message, input.history, now, timeZone),
    abortSignal: input.signal,
  });
  return interpretPrior(result.output);
}

function promptFor(message: string, history: StoredMessage[], now: Date, timeZone: string): string {
  const recent = history
    .map((turn) => `[${turn.created_at}] ${turn.role}: ${turn.content.replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
  const window = recent ? `Recent turns:\n${recent}\n\n` : "";
  return `${timeContext(now, timeZone)}\n\n${window}Question:\n${message}`;
}

function clean(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function civil(value: string | null | undefined): string | undefined {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}
