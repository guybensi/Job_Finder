/** Runs at most one task at a time; a second call while one runs is refused, not queued. */
export class Lock {
  private busy = false;

  get running(): boolean {
    return this.busy;
  }

  /**
   * Run `fn` unless a task is already running.
   *
   * Example:
   *   lock.tryRun(runPipeline)  // → Promise of the result, or null if a run is in progress
   */
  tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
    if (this.busy) return null;
    this.busy = true;
    return fn().finally(() => {
      this.busy = false;
    });
  }
}

/** Calendar date (YYYY-MM-DD) and hour of `ts` in a time zone. */
export function localTime(ts: number, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * Whether the daily digest should go out now: it is at or after `hour` local time and none
 * was sent yet today (local date).
 *
 * Example:
 *   isDigestDue(Date.parse("2026-10-25T18:30:00Z"), null, 20, "Asia/Jerusalem")  // → true (20:30 local)
 */
export function isDigestDue(
  now: number,
  lastSentAt: number | null,
  hour: number,
  timeZone: string,
): boolean {
  const today = localTime(now, timeZone);
  if (today.hour < hour) return false;
  return lastSentAt === null || localTime(lastSentAt, timeZone).date !== today.date;
}

export interface SchedulerOptions {
  intervalMin: number;
  /** One pipeline run; skipped while paused. */
  run: () => Promise<void>;
  isPaused: () => boolean;
  /** Housekeeping every 10 minutes: digest, health checks, purge. */
  tick: () => Promise<void>;
  /** Run once shortly after start instead of waiting a full interval. */
  runAtStart?: boolean;
}

export interface Scheduler {
  stop(): void;
}

const TICK_MS = 10 * 60 * 1000;

/** Start the periodic pipeline and housekeeping timers. Errors are logged, never thrown. */
export function startScheduler(opts: SchedulerOptions): Scheduler {
  const safe = (name: string, fn: () => Promise<void>) => () => {
    fn().catch((e) => console.error(`${name} failed:`, e));
  };
  const run = safe("run", async () => {
    if (!opts.isPaused()) await opts.run();
  });
  const timers = [
    setInterval(run, opts.intervalMin * 60 * 1000),
    setInterval(safe("tick", opts.tick), TICK_MS),
  ];
  const first = opts.runAtStart ? setTimeout(run, 30_000) : null;
  return {
    stop() {
      timers.forEach(clearInterval);
      if (first) clearTimeout(first);
    },
  };
}
