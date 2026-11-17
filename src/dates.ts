export type Period = { start: Date; end: Date };

export type ResolveResult = Period | { error: string };

export function isPeriod(result: ResolveResult): result is Period {
  return "start" in result;
}

export function periodFromCivil(startText: string, endText: string, timeZone: string, phrase: string): ResolveResult {
  const start = parseCivilDate(startText);
  const end = parseCivilDate(endText);
  if (!start || !end || !isRealDay(start) || !isRealDay(end)) return { error: unrecognized(phrase) };
  const period = { start: utcFromZoned(start, timeZone), end: utcFromZoned(end, timeZone) };
  if (period.end.getTime() <= period.start.getTime()) return { error: unrecognized(phrase) };
  return period;
}

export function civilMidnight(text: string, timeZone: string): { date: Date } | { error: string } {
  const civil = parseCivilDate(text);
  if (!civil || !isRealDay(civil)) return { error: unrecognized(text) };
  return { date: utcFromZoned(civil, timeZone) };
}

function unrecognized(phrase: string): string {
  return `Could not resolve "${phrase.trim()}" as a date.`;
}

type Civil = { year: number; month: number; day: number };

function parseCivilDate(value: string): Civil | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isRealDay(civil: Civil): boolean {
  return civil.month >= 1 && civil.month <= 12 && civil.day >= 1 && civil.day <= daysInMonth(civil.year, civil.month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(civil: Civil, days: number): Civil {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function utcFromZoned(civil: Civil, timeZone: string): Date {
  const desired = Date.UTC(civil.year, civil.month - 1, civil.day, 0, 0, 0);
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = zonedParts(new Date(instant), timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const delta = shownUtc - desired;
    if (delta === 0) return new Date(instant);
    instant -= delta;
  }
  return new Date(instant);
}

function zonedParts(date: Date, timeZone: string): Civil & { hour: number; minute: number; second: number } {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let year = Number(bag.year);
  let month = Number(bag.month);
  let day = Number(bag.day);
  let hour = Number(bag.hour);
  if (hour === 24) {
    hour = 0;
    const next = addDays({ year, month, day }, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return { year, month, day, hour, minute: Number(bag.minute), second: Number(bag.second) };
}
