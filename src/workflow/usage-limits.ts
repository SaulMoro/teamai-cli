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

/** The hour of a 12-hour clock with its `meridiem`, or of a 24-hour one without. */
function hourOf({ hour, meridiem }: { hour: string; meridiem: string | undefined }): number {
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

  return nextWall({ now, zone: named ?? zone, hour: hourOf({ hour, meridiem }), minute: minute === undefined ? 0 : Number(minute), ...(date && { date }) });
}

/** The member's own time zone, which a tool's times without one are in. */
function memberZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Whose account a limit is on: this machine's (`here`), which every runtime of the driver launches the tool with, or the
 * fleet's, whose members sign in with their own.
 */
export type LimitedOn = 'here' | 'fleet';

/** One tool's limit: since when it holds, when the tool said it resets, when the driver tries it again, and what a person answered. */
interface Limit {
  tool: string;
  on: LimitedOn;
  since: number;
  /** The last time a step on the tool stopped on it. */
  hitAt: number;
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
  /** A step on `tool`, here or on the fleet, stopped on its usage limit, saying `message`: the tool is held there until the limit resets. */
  hit(input: { tool: string; message: string; now: number; on?: LimitedOn }): void;
  /** A step on `tool` launched at `startedAt` ended without its usage limit: the limit is over there, if it launched after the last hit. */
  ran(tool: string, startedAt: number, on?: LimitedOn): void;
  /** The tools held at `now` on this machine's runtimes, each with why: a fleet member's limit holds none of them. */
  held(now: number): Record<string, string>;
  /** The tools held at `now` on the fleet, by a limit a member met or one met here, while its wait is within the cap: past it, a member is offered the step. */
  heldOnFleet(now: number): Record<string, string>;
  /**
   * What to do once nothing runs and the limits of `tools` hold the steps left: wait, ask a person, or move on.
   * Undefined when no limit of this drive holds any of them.
   */
  whenIdle(now: number, tools: readonly string[], options?: { attended?: boolean }): WhenIdle | undefined;
  /** The person chose to wait for `tool`'s limit, past the cap, until a launch on it ends without the limit. */
  choseWait(tool: string): void;
}

function open({ capMs = WAIT_CAP_MS, zone = memberZone() }: { capMs?: number; zone?: string } = {}): UsageLimitBook {
  const limits = new Map<string, Limit>();

  const clock = ({ at, now }: { at: number; now: number }): string => {
    const wall = wallAt(at, zone);
    const today = wallAt(now, zone);

    if (!wall) return new Date(at).toISOString();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const time = `${pad(wall.hour)}:${pad(wall.minute)}`;
    const isToday = today !== undefined && wall.year === today.year && wall.month === today.month && wall.day === today.day;

    return `${isToday ? time : `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${time}`} (${zone})`;
  };

  const reasonOf = (tool: string, limit: Limit, now: number): string => (limit.resetsAt === undefined
    ? `${tool} hit its usage limit and gave no reset time, so teamai tries it again at ${clock({ at: limit.tryAt, now })}`
    : `${tool} hit its usage limit, which resets at ${clock({ at: limit.resetsAt, now })}`);

  const capText = capMs % 3_600_000 === 0 ? `${capMs / 3_600_000} hour${capMs === 3_600_000 ? '' : 's'}` : `${Math.ceil(capMs / 60_000)} minutes`;

  const pastCapReason = (tool: string, limit: Limit, now: number): string => (limit.resetsAt === undefined
    ? `${tool} hit its usage limit at ${clock({ at: limit.since, now })} and gave no reset time, and it held for the ${capText} an unattended run waits for it`
    : `${tool} hit its usage limit, which resets at ${clock({ at: limit.resetsAt, now })}, past the ${capText} an unattended run waits for it`);

  const isPastCap = (limit: Limit, now: number): boolean => now >= limit.since + capMs || limit.tryAt > limit.since + capMs;

  // A tool held both here and on the fleet is named by the limit it waits for longest.
  const heldBy = (now: number, keep: (limit: Limit) => boolean): Record<string, string> => {
    const longest = new Map<string, Limit>();

    for (const limit of limits.values()) {
      const other = longest.get(limit.tool);

      if (limit.tryAt > now && keep(limit) && (other === undefined || limit.tryAt > other.tryAt)) longest.set(limit.tool, limit);
    }

    return Object.fromEntries([...longest].map(([tool, limit]) => [tool, reasonOf(tool, limit, now)]));
  };

  const keyOf = (tool: string, on: LimitedOn): string => `${on} ${tool}`;

  return {
    hit({ tool, message, now, on = 'here' }) {
      const earlier = limits.get(keyOf(tool, on));
      const resetsAt = resetOf(message, { now, zone });
      const tries = resetsAt === undefined ? (earlier?.tries ?? -1) + 1 : 0;
      const tryAt = resetsAt ?? now + Math.min(FIRST_TRY_MS * 2 ** tries, LONGEST_TRY_MS);

      limits.set(keyOf(tool, on), { tool, on, since: earlier?.since ?? now, hitAt: now, tryAt, tries, isWaitChosen: earlier?.isWaitChosen ?? false, ...(resetsAt !== undefined && { resetsAt }) });
    },
    ran(tool, startedAt, on = 'here') {
      const limit = limits.get(keyOf(tool, on));

      if (limit && startedAt > limit.hitAt) limits.delete(keyOf(tool, on));
    },
    held(now) {
      return heldBy(now, (limit) => limit.on === 'here');
    },
    heldOnFleet(now) {
      return heldBy(now, (limit) => !isPastCap(limit, now));
    },
    whenIdle(now, tools, { attended = false } = {}) {
      const holding = [...limits.values()].flatMap((limit) => (tools.includes(limit.tool) ? [{ tool: limit.tool, limit }] : []));

      const [first] = holding.sort((one, other) => one.limit.tryAt - other.limit.tryAt);

      if (!first) return undefined;

      if (attended) {
        const unanswered = holding.find(({ limit }) => !limit.isWaitChosen);

        return unanswered
          ? { kind: 'ask', tool: unanswered.tool, until: unanswered.limit.tryAt, reason: reasonOf(unanswered.tool, unanswered.limit, now) }
          : { kind: 'wait', tool: first.tool, until: first.limit.tryAt, reason: reasonOf(first.tool, first.limit, now) };
      }

      const past = holding.find(({ limit }) => isPastCap(limit, now));

      if (past) return { kind: 'past_cap', tool: past.tool, reason: pastCapReason(past.tool, past.limit, now) };

      return { kind: 'wait', tool: first.tool, until: first.limit.tryAt, reason: reasonOf(first.tool, first.limit, now) };
    },
    choseWait(tool) {
      for (const limit of limits.values()) if (limit.tool === tool) limit.isWaitChosen = true;
    },
  };
}

export const UsageLimits = {
  /** When the limit a tool's text tells of resets; undefined when it gives no reset. */
  resetOf,
  /** The usage limits of one drive, empty. */
  open,
} as const;
