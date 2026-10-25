import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openStore, type NewMessage } from "../src/store.js";

const msg = (over: Partial<NewMessage> = {}): NewMessage => ({
  waId: "W1",
  groupId: "g1@g.us",
  groupName: "Group A",
  sender: "s",
  text: "Hiring a backend developer",
  ts: 1000,
  ...over,
});
const job = { fingerprint: "fp", messageId: null, groupName: "A", post: { title: "Dev" } };

describe("store", () => {
  it("inserts once per waId", () => {
    const s = openStore(":memory:");
    expect(s.insertMessage(msg())).toBe(true);
    expect(s.insertMessage(msg({ text: "other" }))).toBe(false);
    expect(s.pendingMessages(10)).toHaveLength(1);
  });
  it("rejects blank text", () => {
    expect(() => openStore(":memory:").insertMessage(msg({ text: "  " }))).toThrow();
  });
  it("keeps unicode text", () => {
    const s = openStore(":memory:");
    s.insertMessage(msg({ text: "דרוש/ה מפתח/ת 🚀" }));
    expect(s.pendingMessages(1)[0]!.text).toBe("דרוש/ה מפתח/ת 🚀");
  });
  it("pending ordered oldest first, limited, negative limit = 0", () => {
    const s = openStore(":memory:");
    s.insertMessage(msg({ waId: "b", ts: 2 }));
    s.insertMessage(msg({ waId: "a", ts: 1 }));
    s.insertMessage(msg({ waId: "c", ts: 3 }));
    expect(s.pendingMessages(2).map((m) => m.waId)).toEqual(["a", "b"]);
    expect(s.pendingMessages(-5)).toEqual([]);
  });
  it("markProcessed removes from pending; empty list ok", () => {
    const s = openStore(":memory:");
    s.insertMessage(msg());
    s.markProcessed([]);
    const [m] = s.pendingMessages(10);
    s.markProcessed([m!.id, 999]);
    expect(s.pendingMessages(10)).toEqual([]);
    expect(s.getMessage(m!.id)!.processed).toBe(true);
  });
  it("lastMessageAt null when empty", () => {
    const s = openStore(":memory:");
    expect(s.lastMessageAt()).toBeNull();
    s.insertMessage(msg({ ts: 5 }));
    s.insertMessage(msg({ waId: "x", ts: 9 }));
    expect(s.lastMessageAt()).toBe(9);
  });
  it("purge deletes old messages and unlinks jobs", () => {
    const s = openStore(":memory:");
    s.insertMessage(msg({ waId: "old", ts: 0 }));
    s.insertMessage(msg({ waId: "new", ts: 100 }));
    const oldId = s.pendingMessages(10)[0]!.id;
    const jid = s.insertJob({ ...job, messageId: oldId });
    expect(s.purgeOldMessages(50, 100)).toBe(1);
    expect(s.getJob(jid)!.messageId).toBeNull();
    expect(s.pendingMessages(10).map((m) => m.waId)).toEqual(["new"]);
  });
  it("job roundtrip and update", () => {
    const s = openStore(":memory:");
    const id = s.insertJob(job, 10);
    const j = s.getJob(id)!;
    expect(j).toMatchObject({
      status: "new",
      score: null,
      reasons: [],
      draft: null,
      post: job.post,
    });
    const u = s.updateJob(id, { status: "ready", score: 80, reasons: ["fits"] }, 20);
    expect(u).toMatchObject({ status: "ready", score: 80, reasons: ["fits"], updatedAt: 20 });
    expect(s.updateJob(id, { draft: { cover: "hi" } }).draft).toEqual({ cover: "hi" });
    expect(s.updateJob(id, { score: 0 }).score).toBe(0);
    expect(s.updateJob(id, { status: "skipped" }).draft).toEqual({ cover: "hi" });
  });
  it("updateJob errors", () => {
    const s = openStore(":memory:");
    expect(() => s.updateJob(1, { status: "ready" })).toThrow(/not found/);
    const id = s.insertJob(job);
    expect(() => s.updateJob(id, { status: "bogus" as never })).toThrow(/unknown/);
  });
  it("jobsSince / byStatus / statusCounts", () => {
    const s = openStore(":memory:");
    const a = s.insertJob(job, 1);
    const b = s.insertJob(job, 5);
    s.updateJob(b, { status: "ready" });
    expect(s.jobsSince(2).map((j) => j.id)).toEqual([b]);
    expect(s.jobsSince(0).map((j) => j.id)).toEqual([b, a]);
    expect(s.jobsByStatus("new").map((j) => j.id)).toEqual([a]);
    expect(s.statusCounts(0)).toEqual({ new: 1, ready: 1 });
  });
  it("decisions", () => {
    const s = openStore(":memory:");
    expect(() => s.recordDecision(1, "skip")).toThrow(/not found/);
    const id = s.insertJob(job);
    s.recordDecision(id, "skip", "  too far  ", 1);
    s.recordDecision(id, "apply", "   ", 2);
    expect(s.recentDecisions(10)).toEqual([
      { jobId: id, action: "apply", reason: null, ts: 2 },
      { jobId: id, action: "skip", reason: "too far", ts: 1 },
    ]);
    expect(s.recentDecisions(10, "skip")).toHaveLength(1);
    expect(s.hasDecision(id, "apply")).toBe(true);
    expect(s.hasDecision(id, "edit")).toBe(false);
    expect(s.hasDecision(999, "apply")).toBe(false);
  });
  it("kv", () => {
    const s = openStore(":memory:");
    expect(s.getKv("x", [1])).toEqual([1]);
    s.setKv("x", { a: 1 });
    s.setKv("x", { a: 2 });
    expect(s.getKv("x", null)).toEqual({ a: 2 });
    s.setKv("f", false);
    expect(s.getKv("f", true)).toBe(false);
  });
  it("transaction rolls back", () => {
    const s = openStore(":memory:");
    expect(() =>
      s.transaction(() => {
        s.insertMessage(msg());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.pendingMessages(10)).toEqual([]);
  });
  it("persists on disk across reopen, creating parent dirs", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "jf-")), "nested", "db.sqlite");
    const s = openStore(file);
    s.insertMessage(msg());
    s.close();
    expect(openStore(file).pendingMessages(10)).toHaveLength(1);
  });
});
