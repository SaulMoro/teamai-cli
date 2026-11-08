// ─── Usage limits ────────────────────────────────────────
//
//  A step whose tool stops on its usage limit (`usage_limited`) does not fail: the driver hands it back, launches nothing
//  more on that tool until the limit resets, and then runs it again. A tool's limit is that of the account it signs in
//  with, which the member's setup names: the tool's own sign-in, or an instance of it with a home of its own. So the
//  account is the tool or instance name a step launches, the same on every runtime of the driver, since each launches
//  that tool with the member's sign-in.
//
//  Unattended, the driver waits for the reset within a cap. Past the cap, or for a reset after it, the run moves on: a
//  fleet member takes the step, or the run is offered on teamai-reports as for a step only a person can take. A person
//  who attends is asked instead: wait for the reset, or offer the run to another machine.
//

/** How long an unattended run waits for a usage limit to reset: past a 5-hour window, short of a weekly limit. */
const WAIT_CAP_MS = 6 * 3_600_000;

/** The first wait for a limit whose tool gives no reset, doubled at each limit in a row up to the longest. */
const FIRST_TRY_MS = 60_000;
const LONGEST_TRY_MS = 30 * 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A wall clock in one time zone. */
interface Wall { year: number; month: number; day: number; hour: number; minute: number }

/** The wall clock at `at` in `zone`; undefined for a zone this runtime does not know. */
function wallAt(at: number, zone: string): Wall | undefined {
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at);
  } catch {
    return undefined;
  }

  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((each) => each.type === type)?.value);

  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
}

/** Minutes since the epoch of a wall clock, as if it were UTC: differences between two of one zone are real minutes. */
function wallMinutes({ year, month, day, hour, minute }: Wall): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

/** The hour of a 12- or 24-hour clock. */
function hourOf(hour: string, meridiem: string | undefined): number {
  const value = Number(hour) % 12;

  if (meridiem === undefined) return Number(hour);

  return meridiem.toLowerCase() === 'pm' ? value + 12 : value;
}

/**
 * The next instant after `now` whose wall clock in `zone` reads `hour:minute`, on `date` when given (a month and day,
 * and a year when the tool names one); undefined for an unknown zone.
 */
function nextWall({ now, zone, hour, minute, date }: { now: number; zone: string; hour: number; minute: number; date?: { month: number; day: number; year?: number } }): number | undefined {
  const current = wallAt(now, zone);

  if (!current) return undefined;
  const target: Wall = { year: date?.year ?? current.year, month: date?.month ?? current.month, day: date?.day ?? current.day, hour, minute };
  let ahead = wallMinutes(target) - wallMinutes(current);

  if (ahead <= 0 && date === undefined) ahead += 24 * 60;

  if (ahead <= 0 && date !== undefined && date.year === undefined) ahead = wallMinutes({ ...target, year: target.year + 1 }) - wallMinutes(current);

  return Math.floor(now / 60_000) * 60_000 + ahead * 60_000;
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const DATE = String.raw`(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?)?`;

/**
 * When the limit `text` tells of resets, as the tool says it: Claude Code's "resets 3pm (Europe/Madrid)" or "resets Nov 12,
 * 9am", its older "usage limit reached|<epoch seconds>", and Codex's "try again at 3:04 PM", "try again at Nov 13th, 2026
 * 4:02 PM" or "try again in 2 days 3 hours". A time without a zone is the member's (`zone`). Undefined when the text gives
 * no reset, such as an API's rate limit.
 */
function resetOf(text: string, { now, zone }: { now: number; zone: string }): number | undefined {
  const epoch = /limit reached\|(\d{9,13})\b/i.exec(text);

  if (epoch?.[1] !== undefined) return epoch[1].length > 10 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
  const after = /try again in\s+((?:\d+\s+(?:days?|hours?|minutes?|mins?)[\s,]*(?:and\s+)?)+)/i.exec(text);

  if (after?.[1] !== undefined) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
    let total = 0;

    for (const [, count, name = ''] of after[1].matchAll(/(\d+)\s+(d|h|m)/gi)) {
      const letter = name.toLowerCase();
      total += Number(count) * (letter === 'd' ? unit.d : letter === 'h' ? unit.h : unit.m);
    }

    return now + total;
  }

  const at = new RegExp(String.raw`(?:resets|try again at)\s+${DATE}${TIME}(?:\s*\(([^)]+)\))?`, 'i').exec(text);

  if (!at) return undefined;
  const [, month, day, year, hour = '0', minute, meridiem, named] = at;
  const date = month !== undefined && day !== undefined ? { month: MONTHS.indexOf(month.toLowerCase()) + 1, day: Number(day), ...(year !== undefined && { year: Number(year) }) } : undefined;

  return nextWall({ now, zone: named ?? zone, hour: hourOf(hour, meridiem), minute: minute === undefined ? 0 : Number(minute), ...(date && { date }) });
}

/** The member's own time zone, which a tool's times without one are in. */
function memberZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** One tool's limit: since when it holds, when the tool said it resets, when the driver tries it again, and what a person answered. */
interface Limit {
  since: number;
  resetsAt?: number;
  tryAt: number;
  /** Limits in a row with no reset given, which space the tries apart. */
  tries: number;
  isWaitChosen: boolean;
}

/** What the driver does once nothing runs and only usage limits hold the steps left. */
export type WhenIdle =
  | { kind: 'wait'; tool: string; until: number; reason: string }
  | { kind: 'ask'; tool: string; until: number; reason: string }
  | { kind: 'past_cap'; tool: string; reason: string };

/** The usage limits one drive of a run has met, by the tool or instance a step launches. */
export interface UsageLimitBook {
  /** A step on `tool` stopped on its usage limit, saying `message`: the tool is held until the limit resets. */
  hit(input: { tool: string; message: string; now: number }): void;
  /** A step on `tool` ended without its usage limit: the limit is over. */
  ran(tool: string): void;
  /** The tools held at `now`, each with why. */
  held(now: number): Record<string, string>;
  /** The tools held at `now` whose wait is within the cap: the ones a fleet member is not offered yet. */
  heldWithinCap(now: number): Record<string, string>;
  /**
   * What to do once nothing runs and the limits of `tools` hold the steps left: wait, ask a person, or move on.
   * Undefined when no limit of this drive holds any of them.
   */
  whenIdle(now: number, tools: readonly string[], options?: { attended?: boolean }): WhenIdle | undefined;
  /** The person chose to wait for `tool`'s limit, past the cap. */
  answered(tool: string, answer: 'wait'): void;
}

function open({ capMs = WAIT_CAP_MS, zone = memberZone() }: { capMs?: number; zone?: string } = {}): UsageLimitBook {
  const limits = new Map<string, Limit>();

  const clock = (at: number, now: number): string => {
    const wall = wallAt(at, zone);
    const today = wallAt(now, zone);

    if (!wall) return new Date(at).toISOString();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const time = `${pad(wall.hour)}:${pad(wall.minute)}`;
    const isToday = today !== undefined && wall.year === today.year && wall.month === today.month && wall.day === today.day;

    return `${isToday ? time : `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${time}`} (${zone})`;
  };

  const reasonOf = (tool: string, limit: Limit, now: number): string => (limit.resetsAt === undefined
    ? `${tool} hit its usage limit and gave no reset time, so teamai tries it again at ${clock(limit.tryAt, now)}`
    : `${tool} hit its usage limit, which resets at ${clock(limit.resetsAt, now)}`);

  const isPastCap = (limit: Limit, now: number): boolean => now >= limit.since + capMs || limit.tryAt > limit.since + capMs;

  const heldBy = (now: number, keep: (limit: Limit) => boolean): Record<string, string> => Object.fromEntries(
    [...limits].flatMap(([tool, limit]) => (limit.tryAt > now && keep(limit) ? [[tool, reasonOf(tool, limit, now)] as const] : [])),
  );

  return {
    hit({ tool, message, now }) {
      const earlier = limits.get(tool);
      const resetsAt = resetOf(message, { now, zone });
      const tries = resetsAt === undefined ? (earlier?.tries ?? -1) + 1 : 0;
      const tryAt = resetsAt ?? now + Math.min(FIRST_TRY_MS * 2 ** tries, LONGEST_TRY_MS);

      limits.set(tool, { since: earlier?.since ?? now, tryAt, tries, isWaitChosen: false, ...(resetsAt !== undefined && { resetsAt }) });
    },
    ran(tool) {
      limits.delete(tool);
    },
    held(now) {
      return heldBy(now, () => true);
    },
    heldWithinCap(now) {
      return heldBy(now, (limit) => !isPastCap(limit, now));
    },
    whenIdle(now, tools, { attended = false } = {}) {
      const holding = tools.flatMap((tool) => {
        const limit = limits.get(tool);

        return limit ? [{ tool, limit }] : [];
      });

      const [first] = holding.sort((one, other) => one.limit.tryAt - other.limit.tryAt);

      if (!first) return undefined;

      if (attended) {
        const unanswered = holding.find(({ limit }) => !limit.isWaitChosen);

        return unanswered
          ? { kind: 'ask', tool: unanswered.tool, until: unanswered.limit.tryAt, reason: reasonOf(unanswered.tool, unanswered.limit, now) }
          : { kind: 'wait', tool: first.tool, until: first.limit.tryAt, reason: reasonOf(first.tool, first.limit, now) };
      }

      const past = holding.find(({ limit }) => isPastCap(limit, now));

      if (past) return { kind: 'past_cap', tool: past.tool, reason: reasonOf(past.tool, past.limit, now) };

      return { kind: 'wait', tool: first.tool, until: first.limit.tryAt, reason: reasonOf(first.tool, first.limit, now) };
    },
    answered(tool) {
      const limit = limits.get(tool);

      if (limit) limit.isWaitChosen = true;
    },
  };
}

export const UsageLimits = {
  /** When the limit a tool's text tells of resets; undefined when it gives no reset. */
  resetOf,
  /** The usage limits of one drive, empty. */
  open,
} as const;
