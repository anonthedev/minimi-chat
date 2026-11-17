import { periodFromCivil } from "./dates.ts";
import type { ResolveResult } from "./dates.ts";

export function interpretRange(
  output: { start?: string | null; end?: string | null; error?: string | null },
  timeZone: string,
  phrase: string,
): ResolveResult {
  const error = output.error?.trim();
  if (error) return { error };
  const start = leadingDate(output.start);
  const end = leadingDate(output.end);
  if (!start || !end) return { error: `Could not resolve "${phrase.trim()}" as a time.` };
  return periodFromCivil(start, end, timeZone, phrase);
}

export function timeContext(now: Date, timeZone: string): string {
  return `Now: ${dayText(now, timeZone)} in ${timeZone}.

Days:
${dayLines(now, timeZone)}

Month starts:
${monthLines(now, timeZone)}`;
}

function leadingDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

type Civil = { year: number; month: number; day: number };

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function dayLines(now: Date, timeZone: string): string {
  const today = civilOf(now, timeZone);
  const todayIso = iso(today);
  const lines: string[] = [];
  for (let delta = -28; delta <= 14; delta += 1) {
    const day = shiftDays(today, delta);
    const text = `${weekdayName(day)} ${iso(day)}`;
    lines.push(iso(day) === todayIso ? `${text} today` : text);
  }
  return lines.join("\n");
}

function monthLines(now: Date, timeZone: string): string {
  const today = civilOf(now, timeZone);
  const started: string[] = [];
  const future: string[] = [];
  for (let delta = -14; delta <= 2; delta += 1) {
    const month = shiftMonths(today.year, today.month, delta);
    const next = shiftMonths(month.year, month.month, 1);
    const line = `${MONTH_NAMES[month.month - 1]} ${iso({ year: month.year, month: month.month, day: 1 })} .. ${iso({ year: next.year, month: next.month, day: 1 })}`;
    const hasStarted = month.year < today.year || (month.year === today.year && month.month <= today.month);
    (hasStarted ? started : future).push(line);
  }
  return `Already started:\n${started.join("\n")}\nNot started:\n${future.join("\n")}`;
}

function civilOf(now: Date, timeZone: string): Civil {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return { year: Number(bag.year), month: Number(bag.month), day: Number(bag.day) };
}

function shiftDays(civil: Civil, days: number): Civil {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function shiftMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(index / 12);
  return { year: nextYear, month: index - nextYear * 12 + 1 };
}

function iso(civil: Civil): string {
  return `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
}

function weekdayName(civil: Civil): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(
    new Date(Date.UTC(civil.year, civil.month - 1, civil.day)),
  );
}

function dayText(now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return `${weekday} ${day} (${now.toISOString()})`;
}
