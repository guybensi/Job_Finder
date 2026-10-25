import { describe, expect, it } from "vitest";
import { ApplyQueue, buildApplication } from "../src/apply/email.js";
import { jobPost } from "./fixtures/jobs.js";

const from = { name: "Dana Example", address: "dana@example.com" };
const pdf = Buffer.from("%PDF-1.3");

describe("buildApplication", () => {
  it("english subject, body, attachment", () => {
    const m = buildApplication(jobPost(), from, " Hello there \n", pdf, "Dana_Example_CV.pdf");
    expect(m).toEqual({
      from,
      to: "jobs@example.com",
      subject: "Application: Backend Engineer – Example Labs",
      text: "Hello there",
      attachments: [
        { filename: "Dana_Example_CV.pdf", content: pdf, contentType: "application/pdf" },
      ],
    });
  });
  it("hebrew subject, no company, collapses whitespace", () => {
    const m = buildApplication(
      jobPost({ language: "he", company: null, title: "מפתח/ת\nBackend" }),
      from,
      "x",
      pdf,
      "f.pdf",
    );
    expect(m.subject).toBe("מועמדות למשרת מפתח/ת Backend");
  });
  it("rejects non-email apply, invalid address, empty cover", () => {
    expect(() =>
      buildApplication(
        jobPost({ apply: { kind: "link", target: "https://x" } }),
        from,
        "x",
        pdf,
        "f",
      ),
    ).toThrow(/email/);
    expect(() =>
      buildApplication(
        jobPost({ apply: { kind: "email", target: "not an email" } }),
        from,
        "x",
        pdf,
        "f",
      ),
    ).toThrow(/email/);
    expect(() =>
      buildApplication(jobPost({ apply: { kind: "email", target: null } }), from, "x", pdf, "f"),
    ).toThrow(/email/);
    expect(() => buildApplication(jobPost(), from, "  ", pdf, "f")).toThrow(/empty/);
  });
});

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

describe("ApplyQueue", () => {
  it("sends in order with randomised human gaps, first immediately", async () => {
    const c = fakeClock();
    const sent: [number, number][] = [];
    const q = new ApplyQueue({
      send: async (id) => void sent.push([id, c.now()]),
      minGapMs: 100,
      maxGapMs: 300,
      random: () => 0.5,
      sleep: c.sleep,
      now: c.now,
    });
    q.push(1);
    q.push(2);
    q.push(3);
    await q.idle();
    expect(sent).toEqual([
      [1, 0],
      [2, 200],
      [3, 400],
    ]);
  });
  it("dedupes queued ids and keeps going after a failing send", async () => {
    const c = fakeClock();
    const sent: number[] = [];
    const q = new ApplyQueue({
      send: async (id) => {
        if (id === 1) throw new Error("smtp");
        sent.push(id);
      },
      minGapMs: 0,
      maxGapMs: 0,
      sleep: c.sleep,
      now: c.now,
    });
    expect(q.push(1)).toBe(0);
    expect(q.push(2)).toBe(1);
    expect(q.push(2)).toBe(1);
    await q.idle();
    expect(sent).toEqual([2]);
    expect(q.size).toBe(0);
  });
  it("respects gap after an earlier send even when queue was idle", async () => {
    const c = fakeClock();
    const q = new ApplyQueue({
      send: async () => {},
      minGapMs: 1000,
      maxGapMs: 1000,
      sleep: c.sleep,
      now: c.now,
    });
    q.push(1);
    await q.idle();
    c.advance(400);
    q.push(2);
    await q.idle();
    expect(c.sleeps).toEqual([600]);
  });
  it("invalid gaps throw", () => {
    expect(() => new ApplyQueue({ send: async () => {}, minGapMs: 5, maxGapMs: 1 })).toThrow();
    expect(() => new ApplyQueue({ send: async () => {}, minGapMs: -1, maxGapMs: 1 })).toThrow();
  });
});
