import { describe, expect, it } from "vitest";
import { isDigestDue, localTime, Lock } from "../src/scheduler.js";

const HOUR = 3600_000;
const TZ = "Asia/Jerusalem";

describe("Lock", () => {
  it("refuses while running and frees after error", async () => {
    const lock = new Lock();
    let release!: () => void;
    const p = lock.tryRun(() => new Promise<number>((r) => (release = () => r(1))));
    expect(lock.running).toBe(true);
    expect(lock.tryRun(async () => 2)).toBeNull();
    release();
    expect(await p).toBe(1);
    expect(lock.running).toBe(false);
    await expect(lock.tryRun(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(lock.running).toBe(false);
  });
});

describe("digest timing", () => {
  it("localTime in Israel (winter UTC+2, summer UTC+3)", () => {
    expect(localTime(Date.parse("2026-01-10T18:30:00Z"), TZ)).toEqual({
      date: "2026-01-10",
      hour: 20,
    });
    expect(localTime(Date.parse("2026-07-10T21:30:00Z"), TZ)).toEqual({
      date: "2026-07-11",
      hour: 0,
    });
  });
  it("isDigestDue", () => {
    const at2030 = Date.parse("2026-01-10T18:30:00Z");
    expect(isDigestDue(at2030, null, 20, TZ)).toBe(true);
    expect(isDigestDue(at2030, null, 21, TZ)).toBe(false);
    expect(isDigestDue(at2030, at2030 - HOUR / 2, 20, TZ)).toBe(false);
    expect(isDigestDue(at2030, at2030 - 24 * HOUR, 20, TZ)).toBe(true);
  });
});
