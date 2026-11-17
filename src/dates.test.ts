import assert from "node:assert/strict";
import test from "node:test";
import { civilMidnight, isPeriod, periodFromCivil } from "./dates.ts";

const zone = "Asia/Kolkata";

test("a civil date is midnight in the timezone", () => {
  const result = civilMidnight("2026-11-11", zone);
  assert.equal("date" in result, true);
  if (!("date" in result)) throw new Error("unreachable");
  assert.equal(result.date.toISOString(), "2026-11-10T18:30:00.000Z");
});

test("an impossible day is an error", () => {
  assert.equal("error" in civilMidnight("2026-11-31", zone), true);
});

test("a range is half-open and a reversed pair is an error", () => {
  const period = periodFromCivil("2026-11-09", "2026-11-16", zone, "this week");
  assert.equal(isPeriod(period), true);
  if (!isPeriod(period)) throw new Error("unreachable");
  assert.equal(period.start.toISOString(), "2026-11-08T18:30:00.000Z");
  assert.equal(period.end.toISOString(), "2026-11-15T18:30:00.000Z");
  assert.equal(isPeriod(periodFromCivil("2026-11-16", "2026-11-09", zone, "this week")), false);
});
