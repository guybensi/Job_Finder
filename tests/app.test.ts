import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Mail } from "../src/apply/email.js";
import { createApp, formatCounts } from "../src/app.js";
import { DEFAULT_PROFILE, loadEnv, profileToYaml } from "../src/config.js";
import { renderPdf } from "../src/cv/render.js";
import { saveMaster, loadMaster } from "../src/cv/master.js";
import type { TailoredCv } from "../src/cv/tailor.js";
import { FakeLlm, type LlmRequest } from "../src/llm.js";
import { EXTRACT_SYSTEM, type JobPost } from "../src/pipeline/extract.js";
import { MATCH_SYSTEM } from "../src/pipeline/match.js";
import { openStore } from "../src/store.js";
import type { CardInput } from "../src/telegram/cards.js";
import { T } from "../src/telegram/texts.js";
import { KV } from "../src/whatsapp/listener.js";
import { master, parsedLlm } from "./fixtures/cv.js";
import { jobPost, POST_HE } from "./fixtures/jobs.js";

const LLM = "backend-engineer-python";
const tailored: TailoredCv = {
  variant: LLM,
  headline: "Backend Engineer (Python/APIs)",
  summary: "Backend engineer building LLM-powered services in Python.",
  items: [{ id: "exp-1", bullets: ["Cut API latency by 40% with caching"] }],
  coverMessage:
    "Hello, I'd like to apply for the Backend Engineer role. Best regards, Dana Example",
};

function setup(
  opts: { post?: JobPost; withCv?: boolean; mailer?: boolean; failMail?: boolean } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "jf-app-"));
  writeFileSync(
    path.join(dir, "profile.yaml"),
    profileToYaml({ ...DEFAULT_PROFILE, regions: ["center"] }),
  );
  if (opts.withCv !== false) saveMaster(dir, master);
  const env = loadEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_OWNER_ID: "1",
    WA_PHONE: "10000000000",
    DATA_DIR: dir,
    SMTP_USER: "dana@example.com",
    SMTP_APP_PASSWORD: "x",
  });
  const store = openStore(":memory:");
  const notes: string[] = [];
  const cards: { card: CardInput; pdf: Buffer }[] = [];
  const mails: Mail[] = [];
  let t = Date.parse("2026-01-10T08:00:00Z");
  const llm = new FakeLlm((req: LlmRequest<z.ZodType>) => {
    if (req.system === EXTRACT_SYSTEM) {
      const ids = [...req.prompt.matchAll(/messageId: (\d+)/g)].map((m) => Number(m[1]));
      return {
        results: ids.map((id) => ({
          messageId: id,
          jobs: [opts.post ?? jobPost({ region: "center" })],
        })),
      };
    }
    if (req.system === MATCH_SYSTEM)
      return { score: 88, reasons: ["Python"], concerns: [], variant: LLM };
    if (req.pdfs?.length) return parsedLlm;
    return tailored;
  });
  const app = createApp({
    env,
    store,
    llm,
    notify: async (text) => void notes.push(text),
    sendCard: async (card, pdf) => void cards.push({ card, pdf: pdf.data }),
    mailer:
      opts.mailer === false
        ? null
        : {
            sendMail: async (m: Mail) => {
              if (opts.failMail) throw new Error("smtp down");
              mails.push(m);
            },
          },
    waConnected: () => true,
    now: () => t,
    sendGapMs: { min: 0, max: 0 },
    sleep: async () => {},
  });
  const seed = (text = POST_HE, id = "w1") =>
    store.insertMessage({
      waId: id,
      groupId: "g@g.us",
      groupName: "Group A",
      sender: "s",
      text,
      ts: t,
    });
  return {
    app,
    store,
    notes,
    cards,
    mails,
    seed,
    dir,
    llm,
    advance: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("app flow", () => {
  it("run → card with PDF → apply → one email with the tailored CV", async () => {
    const s = setup();
    s.seed();
    const report = await s.app.runOnce();
    expect(report).toMatchObject({ ready: 1 });
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]!.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(s.notes).toContain(T.runSummary(1, 1));
    expect(s.mails).toHaveLength(0); // nothing outward-facing without Apply

    const jobId = s.cards[0]!.card.jobId;
    expect(await s.app.handlers.apply(jobId)).toBe(T.applyQueued);
    expect(await s.app.handlers.apply(jobId)).toBe(T.applyNotReady);
    await s.app.queue.idle();
    expect(s.mails).toHaveLength(1);
    expect(s.mails[0]).toMatchObject({
      to: "jobs@example.com",
      from: { name: "Dana Example", address: "dana@example.com" },
      text: tailored.coverMessage,
    });
    expect(s.mails[0]!.attachments[0]!.filename).toBe("Dana_Example_CV.pdf");
    expect(s.store.getJob(jobId)!.status).toBe("applied");
    expect(s.notes.at(-1)).toContain(T.applySent("jobs@example.com"));
  });

  it("a job marked applying without an Apply decision is never sent", async () => {
    const s = setup();
    s.seed();
    await s.app.runOnce();
    const jobId = s.cards[0]!.card.jobId;
    s.store.updateJob(jobId, { status: "applying" });
    s.app.queue.push(jobId);
    await s.app.queue.idle();
    expect(s.mails).toHaveLength(0);
  });

  it("apply refuses link posts and missing SMTP", async () => {
    const link = setup({
      post: jobPost({ region: "center", apply: { kind: "link", target: "https://x.example/j" } }),
    });
    link.seed("Hiring a Backend Engineer in Tel Aviv, apply at https://x.example/j");
    await link.app.runOnce();
    expect(await link.app.handlers.apply(link.cards[0]!.card.jobId)).toBe(T.applyNoEmail);
    expect(await link.app.handlers.markManual(link.cards[0]!.card.jobId)).toBe(T.markedManual);
    expect(link.store.getJob(link.cards[0]!.card.jobId)!.status).toBe("manual");

    const noSmtp = setup({ mailer: false });
    noSmtp.seed();
    await noSmtp.app.runOnce();
    expect(await noSmtp.app.handlers.apply(noSmtp.cards[0]!.card.jobId)).toBe(T.applyNoSmtp);
    expect(noSmtp.store.getJob(noSmtp.cards[0]!.card.jobId)!.status).toBe("ready");
  });

  it("mail failure marks job failed and tells the owner", async () => {
    const s = setup({ failMail: true });
    s.seed();
    await s.app.runOnce();
    const jobId = s.cards[0]!.card.jobId;
    await s.app.handlers.apply(jobId);
    await s.app.queue.idle();
    expect(s.store.getJob(jobId)!.status).toBe("failed");
    expect(s.notes.at(-1)).toBe(T.applyFailed("smtp down"));
  });

  it("edited cover message is what gets sent", async () => {
    const s = setup();
    s.seed();
    await s.app.runOnce();
    const jobId = s.cards[0]!.card.jobId;
    const card = await s.app.handlers.setCoverMessage(jobId, "My own words");
    expect(card!.coverMessage).toBe("My own words");
    await s.app.handlers.apply(jobId);
    await s.app.queue.idle();
    expect(s.mails[0]!.text).toBe("My own words");
    expect(await s.app.handlers.setCoverMessage(jobId, "late")).toBeNull();
  });

  it("skip records the reason once", async () => {
    const s = setup();
    s.seed();
    await s.app.runOnce();
    const jobId = s.cards[0]!.card.jobId;
    expect(await s.app.handlers.skip(jobId, "too far")).toBe(T.skipped);
    expect(await s.app.handlers.skip(jobId, "again")).toBe(T.applyNotReady);
    expect(s.store.recentDecisions(5)).toEqual([
      expect.objectContaining({ jobId, action: "skip", reason: "too far" }),
    ]);
    expect(s.store.getJob(jobId)!.status).toBe("skipped");
  });

  it("approved applications resume after a restart", async () => {
    const s = setup();
    s.seed();
    await s.app.runOnce();
    const jobId = s.cards[0]!.card.jobId;
    s.store.recordDecision(jobId, "apply");
    s.store.updateJob(jobId, { status: "applying" });
    const mails: Mail[] = [];
    const again = createApp({
      env: loadEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_OWNER_ID: "1",
        WA_PHONE: "10000000000",
        DATA_DIR: s.dir,
        SMTP_USER: "d@example.com",
        SMTP_APP_PASSWORD: "x",
      }),
      store: s.store,
      llm: s.llm,
      notify: async () => {},
      sendCard: async () => {},
      mailer: { sendMail: async (m: Mail) => void mails.push(m) },
      waConnected: () => true,
      sendGapMs: { min: 0, max: 0 },
      sleep: async () => {},
    });
    await again.queue.idle();
    expect(mails).toHaveLength(1);
  });

  it("no CV: warns once jobs wait", async () => {
    const s = setup({ withCv: false });
    s.seed();
    expect(await s.app.runOnce()).toMatchObject({ waiting: 1 });
    expect(s.notes).toContain(T.noCvWarning);
  });

  it("concurrent runs are refused", async () => {
    const s = setup();
    s.seed();
    const first = s.app.runOnce();
    expect(s.app.handlers.scan()).toBe(false);
    expect(await s.app.runOnce()).toBeNull();
    await first;
  });
});

describe("app handlers", () => {
  it("cv upload → pending summary → save", async () => {
    const s = setup({ withCv: false });
    const pdf = await renderPdf(master, {
      ...tailored,
      items: master.items.map((i) => ({ id: i.id, bullets: i.bullets })),
    });
    const summary = await s.app.handlers.parseCv({ name: "cv.pdf", data: pdf });
    expect(summary).toContain("Dana Example");
    expect(loadMaster(s.dir)).toBeNull();
    expect(s.app.handlers.saveCv()).toBe(true);
    expect(loadMaster(s.dir)!.variants[0]!.id).toBe(LLM);
    expect(s.app.handlers.saveCv()).toBe(false);
    expect(s.app.handlers.discardCv()).toBe(false);
  });
  it("groups list and toggle", async () => {
    const s = setup();
    s.store.setKv(KV.groupNames, { "a@g.us": "Alpha", "b@g.us": "Beta" });
    s.app.handlers.toggleGroup("b@g.us");
    expect(await s.app.handlers.groups()).toEqual([
      { id: "b@g.us", name: "Beta", allowed: true },
      { id: "a@g.us", name: "Alpha", allowed: false },
    ]);
    s.app.handlers.toggleGroup("b@g.us");
    expect(s.store.getKv(KV.allowedGroups, ["x"])).toEqual([]);
  });
  it("profile show/save and pause", () => {
    const s = setup();
    expect(s.app.handlers.profileYaml()).toContain("center");
    expect(() => s.app.handlers.saveProfile("roles: []")).toThrow();
    s.app.handlers.setPaused(true);
    expect(s.app.isPaused()).toBe(true);
    expect(String(s.app.handlers.status())).toContain("⏸");
  });
});

describe("tick", () => {
  it("digest once per day after 20:00 local; health alert throttled; purge", async () => {
    const s = setup();
    s.store.setKv(KV.allowedGroups, ["g@g.us"]);
    s.seed("old message text that is long enough to be stored", "old");
    await s.app.tick(); // 10:00 local: no digest, no alert yet
    expect(s.notes).toEqual([]);
    s.advance(11 * 3600_000); // 21:00 local
    await s.app.tick();
    expect(s.notes.filter((n) => n.startsWith("סיכום יומי"))).toHaveLength(1);
    await s.app.tick();
    expect(s.notes.filter((n) => n.startsWith("סיכום יומי"))).toHaveLength(1);
    s.advance(20 * 3600_000); // >24h since last message and start
    await s.app.tick();
    await s.app.tick();
    expect(s.notes.filter((n) => n.includes("לא הגיעו הודעות"))).toHaveLength(1);
    s.advance(14 * 24 * 3600_000);
    await s.app.tick();
    expect(s.store.lastMessageAt()).toBeNull();
  });
  it("formatCounts", () => {
    expect(formatCounts({})).toBe(T.noActivity);
    expect(formatCounts({ ready: 2, skipped: 0 })).toBe("ממתינות לאישורך: 2");
  });
});

function groupApp(refreshGroups?: () => Promise<void>) {
  const store = openStore(":memory:");
  const env = loadEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_OWNER_ID: "1",
    WA_PHONE: "10000000000",
    DATA_DIR: mkdtempSync(path.join(tmpdir(), "jf-g-")),
  });
  const a = createApp({
    env,
    store,
    llm: new FakeLlm(() => ({})),
    notify: async () => {},
    sendCard: async () => {},
    mailer: null,
    waConnected: () => true,
    refreshGroups,
  });
  return { a, store };
}

describe("group list refresh", () => {
  it("/groups fetches fresh list (new group appears)", async () => {
    let calls = 0;
    const { a, store } = groupApp(async () => {
      calls++;
      store.setKv(KV.groupNames, { "a@g.us": "Alpha", "new@g.us": "New Jobs" });
    });
    store.setKv(KV.groupNames, { "a@g.us": "Alpha" });
    const list = await a.handlers.groups();
    expect(calls).toBe(1);
    expect(list.map((g) => g.name)).toEqual(["Alpha", "New Jobs"]);
  });
  it("refresh failure still returns the stored list", async () => {
    const { a, store } = groupApp(async () => {
      throw new Error("not connected");
    });
    store.setKv(KV.groupNames, { "a@g.us": "Alpha" });
    expect((await a.handlers.groups()).map((g) => g.name)).toEqual(["Alpha"]);
  });
  it("tick refreshes too", async () => {
    let calls = 0;
    const { a } = groupApp(async () => void calls++);
    await a.tick();
    expect(calls).toBe(1);
  });
});
