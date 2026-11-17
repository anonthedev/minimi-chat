import { civilMidnight } from "../dates.ts";
import { RECALL_LIMIT, recallMessages } from "../db.ts";

export type RecallInput = {
  start?: string;
  end?: string;
  query?: string;
  error?: string;
  before_id?: number;
};

export function recall(
  input: RecallInput,
  chatId: number,
  timeZone = process.env.TIMEZONE || "Asia/Kolkata",
): unknown {
  const bounds = boundsFrom(input, timeZone);
  if ("error" in bounds) return { error: bounds.error };

  const messages = recallMessages({
    skipChatId: !bounds.start && !bounds.end && !input.query?.trim() && input.before_id === undefined ? chatId : null,
    start: bounds.start,
    end: bounds.end,
    query: input.query?.trim() || null,
    beforeId: input.before_id ?? null,
  });
  const oldest = messages[0];
  return {
    messages,
    next_before_id: messages.length === RECALL_LIMIT && oldest ? oldest.id : null,
  };
}

function boundsFrom(
  input: RecallInput,
  timeZone: string,
): { start: Date | null; end: Date | null } | { error: string } {
  if (input.error) return { error: input.error };
  const start = input.start ? civilMidnight(input.start, timeZone) : null;
  if (start && "error" in start) return start;
  const end = input.end ? civilMidnight(input.end, timeZone) : null;
  if (end && "error" in end) return end;
  const startDate = start && "date" in start ? start.date : null;
  const endDate = end && "date" in end ? end.date : null;
  if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
    return { error: `Could not resolve "${input.start} .. ${input.end}" as a time.` };
  }
  return { start: startDate, end: endDate };
}
