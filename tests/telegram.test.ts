import { describe, expect, it } from "vitest";
import { BotCore, isOwner, type BotHandlers, MAX_CV_BYTES } from "../src/telegram/bot.js";
import {
  type CardInput,
  cardButtons,
  decodeAction,
  encodeAction,
  renderCard,
  skipReasonButtons,
} from "../src/telegram/cards.js";
import { T } from "../src/telegram/texts.js";

const card: CardInput = {
  jobId: 7,
  title: "Backend <Engineer>",
  company: "Acme & Co",
  location: "Tel Aviv",
  salary: null,
  score: 82,
  reasons: ["Python match"],
  concerns: [],
  coverMessage: "Hello, I'm interested.",
  apply: { kind: "email", target: "jobs@example.com" },
  cvVariant: "llm",
  group: "Group A",
};

function handlers(over: Partial<BotHandlers> = {}): BotHandlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    status: () => "STATUS",
    scan: () => true,
    setPaused: (p) => void log.push(`paused:${p}`),
    profileYaml: () => "roles: [a<b]",
    saveProfile: (y) => {
      if (y.includes("bad")) throw new Error("roles: invalid");
      log.push("saved");
    },
    groups: () => [
      { id: "1@g.us", name: "A", allowed: true },
      { id: "2@g.us", name: "B", allowed: false },
    ],
    toggleGroup: (id) => void log.push(`toggle:${id}`),
    parseCv: async (f) => `parsed ${f.name}`,
    saveCv: () => true,
    discardCv: () => false,
    apply: async (id) => `apply ${id}`,
    markManual: async (id) => `manual ${id}`,
    skip: async (id, r) => `skip ${id} ${r}`,
    setCoverMessage: async (id, text) => (id === 7 ? { ...card, coverMessage: text } : null),
    ...over,
  };
}

describe("cards", () => {
  it("renders card with escaping, unknown salary, email apply", () => {
    const t = renderCard(card);
    expect(t).toContain("<b>Backend &lt;Engineer&gt;</b> · Acme &amp; Co");
    expect(t).toContain(T.cardSalaryUnknown);
    expect(t).toContain("82/100");
    expect(t).toContain(T.cardApplyEmail("jobs@example.com"));
    expect(t).toContain("<i>Hello, I'm interested.</i>");
    expect(t).not.toContain(T.cardConcerns);
  });
  it("renders link / unknown apply and concerns, no company", () => {
    const t = renderCard({
      ...card,
      company: null,
      concerns: ["Hybrid 3 days"],
      apply: { kind: "link", target: "https://x.y/z" },
    });
    expect(t).toContain(T.cardApplyLink("https://x.y/z"));
    expect(t).toContain("• Hybrid 3 days");
    expect(t.split("\n")[0]).toBe("<b>Backend &lt;Engineer&gt;</b>");
    expect(renderCard({ ...card, apply: { kind: "email", target: null } })).toContain(
      T.cardApplyUnknown,
    );
  });
  it("trims huge cover message under 4096 and doesn't cut an entity", () => {
    const t = renderCard({ ...card, coverMessage: "&".repeat(5000) });
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t).toMatch(/(&amp;)+…<\/i>/);
  });
  it("buttons by apply kind", () => {
    expect(cardButtons(card)[0]!.map((b) => b.data)).toEqual(["a:7", "e:7", "s:7"]);
    expect(
      cardButtons({ ...card, apply: { kind: "link", target: "u" } })[0]!.map((b) => b.data),
    ).toEqual(["m:7", "s:7"]);
  });
  it("skip reason buttons two per row, all decodable", () => {
    const rows = skipReasonButtons(3);
    expect(rows.every((r) => r.length <= 2)).toBe(true);
    for (const b of rows.flat()) expect(decodeAction(b.data)).toMatchObject({ jobId: 3 });
  });
  it("encode/decode roundtrip and rejects junk", () => {
    for (const a of [
      { type: "apply", jobId: 1 },
      { type: "edit", jobId: 22 },
      { type: "skip", jobId: 3 },
      { type: "manual", jobId: 4 },
      { type: "skipReason", jobId: 5, reason: "salary" },
      { type: "cvSave" },
      { type: "cvDiscard" },
      { type: "group", groupId: "120363000000000000@g.us" },
    ] as const) {
      expect(decodeAction(encodeAction(a))).toEqual(a);
    }
    for (const junk of [
      "",
      "a",
      "a:",
      "a:x",
      "a:-1",
      "a:0",
      "a:1.5",
      "a:01",
      "z:1",
      "a:1:2",
      "r:1:bogus",
      "r:1",
      "g:",
    ]) {
      expect(decodeAction(junk)).toBeNull();
    }
    expect(() => encodeAction({ type: "group", groupId: "x".repeat(80) })).toThrow(/64/);
  });
});

describe("BotCore", () => {
  it("isOwner requires owner id and private chat", () => {
    expect(isOwner({ id: 1 }, { type: "private" }, 1)).toBe(true);
    expect(isOwner({ id: 2 }, { type: "private" }, 1)).toBe(false);
    expect(isOwner({ id: 1 }, { type: "group" }, 1)).toBe(false);
    expect(isOwner(undefined, undefined, 1)).toBe(false);
  });
  it("commands", async () => {
    const h = handlers();
    const core = new BotCore(h);
    expect((await core.handleText("/help"))[0]!.text).toBe(T.help);
    expect((await core.handleText("/status@my_bot"))[0]!.text).toBe("STATUS");
    expect((await core.handleText("/scan"))[0]!.text).toBe(T.scanStarted);
    expect((await new BotCore(handlers({ scan: () => false })).handleText("/scan"))[0]!.text).toBe(
      T.scanBusy,
    );
    await core.handleText("/pause");
    await core.handleText("/RESUME");
    expect(h.log).toEqual(["paused:true", "paused:false"]);
    expect((await core.handleText("/nope"))[0]!.text).toBe(T.unknownCommand);
    expect((await core.handleText("hello"))[0]!.text).toBe(T.help);
  });
  it("profile show escapes; setprofile saves / reports errors / usage", async () => {
    const h = handlers();
    const core = new BotCore(h);
    expect((await core.handleText("/profile"))[0]!.text).toContain("a&lt;b");
    expect((await core.handleText("/setprofile"))[0]!.text).toBe(T.setProfileUsage);
    expect((await core.handleText("/setprofile\nroles: [x]"))[0]!.text).toBe(T.profileSaved);
    expect((await core.handleText("/setprofile\nbad"))[0]!.text).toContain("roles: invalid");
  });
  it("groups list and toggle", async () => {
    const h = handlers();
    const core = new BotCore(h);
    const [r] = await core.handleText("/groups");
    expect(r!.buttons!.flat().map((b) => b.text)).toEqual(["✅ A", "▫️ B"]);
    const res = await core.handleCallback("g:2@g.us");
    expect(h.log).toContain("toggle:2@g.us");
    expect(res.replies[0]!.buttons).toBeDefined();
    expect((await new BotCore(handlers({ groups: () => [] })).handleText("/groups"))[0]!.text).toBe(
      T.noGroups,
    );
  });
  it("apply / manual remove buttons", async () => {
    const core = new BotCore(handlers());
    expect(await core.handleCallback("a:7")).toEqual({
      replies: [{ text: "apply 7" }],
      removeButtons: true,
    });
    expect((await core.handleCallback("m:7")).replies[0]!.text).toBe("manual 7");
  });
  it("edit flow: next text becomes cover; empty text asks again; missing job", async () => {
    const core = new BotCore(handlers());
    await core.handleCallback("e:7");
    expect((await core.handleText("   "))[0]!.text).toBe(T.editAsk);
    const replies = await core.handleText("New message");
    expect(replies[0]!.text).toBe(T.editSaved);
    expect(replies[1]!.text).toContain("<i>New message</i>");
    expect((await core.handleText("again"))[0]!.text).toBe(T.help);
    await core.handleCallback("e:99");
    expect((await core.handleText("x"))[0]!.text).toBe(T.jobNotFound);
  });
  it("a command cancels a pending edit", async () => {
    const core = new BotCore(handlers());
    await core.handleCallback("e:7");
    await core.handleText("/status");
    expect((await core.handleText("text"))[0]!.text).toBe(T.help);
  });
  it("skip flow: reasons, none, other → free text", async () => {
    const core = new BotCore(handlers());
    const s = await core.handleCallback("s:7");
    expect(s.replies[0]!.buttons).toBeDefined();
    expect((await core.handleCallback("r:7:salary")).replies[0]!.text).toBe("skip 7 שכר");
    expect((await core.handleCallback("r:7:none")).replies[0]!.text).toBe("skip 7 null");
    expect((await core.handleCallback("r:7:other")).replies[0]!.text).toBe(T.skipFreeTextAsk);
    expect((await core.handleText("too far away"))[0]!.text).toBe("skip 7 too far away");
  });
  it("cv save / discard", async () => {
    const core = new BotCore(handlers());
    expect((await core.handleCallback("cv:save")).replies[0]!.text).toBe(T.cvSaved);
    expect((await core.handleCallback("cv:discard")).replies[0]!.text).toBe(T.cvNothingPending);
  });
  it("bad callback", async () => {
    expect(await new BotCore(handlers()).handleCallback("zzz")).toEqual({
      toast: T.unknownCommand,
      replies: [],
    });
  });
  it("documents: pdf parsed, non-pdf, too big, download error", async () => {
    const core = new BotCore(handlers());
    const ok = async () => Buffer.from("%PDF");
    const r = await core.handleDocument({ name: "cv.PDF", mime: undefined, size: 4, download: ok });
    expect(r[0]!.text).toContain("parsed cv.PDF");
    expect(r[0]!.buttons!.flat().map((b) => b.data)).toEqual(["cv:save", "cv:discard"]);
    expect(
      (
        await core.handleDocument({
          name: "a.docx",
          mime: "application/msword",
          size: 1,
          download: ok,
        })
      )[0]!.text,
    ).toBe(T.cvNotPdf);
    expect(
      (
        await core.handleDocument({
          name: "a.pdf",
          mime: "application/pdf",
          size: MAX_CV_BYTES + 1,
          download: ok,
        })
      )[0]!.text,
    ).toBe(T.cvTooBig);
    const failing = async (): Promise<Buffer> => {
      throw new Error("net");
    };
    expect(
      (
        await core.handleDocument({
          name: "a.pdf",
          mime: "application/pdf",
          size: 1,
          download: failing,
        })
      )[0]!.text,
    ).toBe(T.cvFailed("net"));
  });
});
