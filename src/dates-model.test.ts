import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPeriod } from "./dates.ts";
import { interpretRange } from "./dates-model.ts";
import { decidePrior } from "./prior.ts";

const zone = "Asia/Kolkata";
const wednesday = new Date("2026-11-11T06:30:00Z");
const monday = new Date("2026-11-09T06:30:00Z");
const february = new Date("2026-02-01T06:30:00Z");
const tuesday = new Date("2026-11-17T06:30:00Z");

test("a model range becomes midnight instants in the timezone", () => {
  const model = interpretRange({ start: "2026-11-09", end: "2026-11-16", error: null }, zone, "this week");
  assert.equal(isPeriod(model), true);
  if (!isPeriod(model)) throw new Error("unreachable");
  assert.equal(model.start.toISOString(), "2026-11-08T18:30:00.000Z");
  assert.equal(model.end.toISOString(), "2026-11-15T18:30:00.000Z");
});

test("a timestamp prefix is read as the civil date", () => {
  const model = interpretRange(
    { start: "2026-11-10T00:00:00+05:30", end: "2026-11-11T00:00:00+05:30", error: "" },
    zone,
    "yesterday",
  );
  assert.equal(isPeriod(model), true);
  if (!isPeriod(model)) throw new Error("unreachable");
  assert.equal(model.start.toISOString(), "2026-11-09T18:30:00.000Z");
});

test("an error, a missing date, a reversed range, or an impossible day is rejected", () => {
  assert.equal(isPeriod(interpretRange({ start: null, end: null, error: "not a time" }, zone, "whenever")), false);
  assert.equal(isPeriod(interpretRange({ start: "2026-11-11", end: null, error: null }, zone, "today")), false);
  assert.equal(isPeriod(interpretRange({ start: "2026-11-16", end: "2026-11-09", error: null }, zone, "this week")), false);
  assert.equal(isPeriod(interpretRange({ start: "2026-11-31", end: "2026-12-01", error: null }, zone, "31 November 2026")), false);
});

const phrases: Array<{ phrase: string; now: Date; start: string | null; end: string | null }> = [
  { phrase: "3 November", now: wednesday, start: "2026-11-03", end: "2026-11-04" },
  { phrase: "November 3", now: wednesday, start: "2026-11-03", end: "2026-11-04" },
  { phrase: "3 November", now: february, start: "2025-11-03", end: "2025-11-04" },
  { phrase: "2026-11-03", now: february, start: "2026-11-03", end: "2026-11-04" },
  { phrase: "3/11/2026", now: wednesday, start: "2026-11-03", end: "2026-11-04" },
  { phrase: "today", now: wednesday, start: "2026-11-11", end: "2026-11-12" },
  { phrase: "yesterday", now: wednesday, start: "2026-11-10", end: "2026-11-11" },
  { phrase: "tomorrow", now: wednesday, start: "2026-11-12", end: "2026-11-13" },
  { phrase: "2 days ago", now: wednesday, start: "2026-11-09", end: "2026-11-10" },
  { phrase: "Monday", now: wednesday, start: "2026-11-09", end: "2026-11-10" },
  { phrase: "last Monday", now: wednesday, start: "2026-11-09", end: "2026-11-10" },
  { phrase: "Monday", now: monday, start: "2026-11-09", end: "2026-11-10" },
  { phrase: "last Monday", now: monday, start: "2026-11-02", end: "2026-11-03" },
  { phrase: "this week", now: wednesday, start: "2026-11-09", end: "2026-11-16" },
  { phrase: "last week", now: wednesday, start: "2026-11-02", end: "2026-11-09" },
  { phrase: "1 week ago", now: wednesday, start: "2026-11-02", end: "2026-11-09" },
  { phrase: "March", now: wednesday, start: "2026-03-01", end: "2026-04-01" },
  { phrase: "March", now: february, start: "2025-03-01", end: "2025-04-01" },
  { phrase: "whenever", now: wednesday, start: null, end: null },
  { phrase: "31 November 2026", now: wednesday, start: null, end: null },
  { phrase: "last Tuesday", now: tuesday, start: "2026-11-10", end: "2026-11-11" },
  { phrase: "last Tu-4esdya", now: tuesday, start: "2026-11-10", end: "2026-11-11" },
  { phrase: "yestarday", now: wednesday, start: "2026-11-10", end: "2026-11-11" },
  { phrase: "last Mondy", now: monday, start: "2026-11-02", end: "2026-11-03" },
];

describe("gemini-2.5-flash date ranges", { concurrency: 4 }, () => {
  for (const item of phrases) {
    const when = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(item.now);
    test(`${JSON.stringify(item.phrase)} on ${when}`, { timeout: 45_000 }, async () => {
      const expected = { start: item.start, end: item.end };
      const ask = () => decidePrior({ message: `What did we say ${item.phrase}?`, history: [], now: item.now, timeZone: zone });
      let decision = await ask();
      if (!matches(decision, expected)) {
        console.log(`retry ${JSON.stringify(item.phrase)}: ${JSON.stringify(decision)}`);
        decision = await ask();
      }
      assert.equal(matches(decision, expected), true, JSON.stringify(decision));
    });
  }
});

function matches(decision: { answer: string; start?: string; end?: string }, expected: { start: string | null; end: string | null }): boolean {
  if (!expected.start || !expected.end) return !(decision.answer === "recall" && decision.start && decision.end);
  return decision.answer === "recall" && decision.start === expected.start && decision.end === expected.end;
}
