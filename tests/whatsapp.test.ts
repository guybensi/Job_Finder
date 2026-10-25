import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { extractText, reconnectDelay, senderTag, toNewMessage } from "../src/whatsapp/listener.js";

const G = "120363000000000001@g.us";
const now = 1_700_000_000_000;
const msg = (over: Partial<WAMessage> = {}, key: Partial<WAMessage["key"]> = {}): WAMessage =>
  ({
    key: { remoteJid: G, id: "ABC", fromMe: false, participant: "111@lid", ...key },
    message: { conversation: "Hiring a backend developer" },
    messageTimestamp: now / 1000,
    ...over,
  }) as WAMessage;

describe("extractText", () => {
  it("variants", () => {
    expect(extractText(null)).toBeNull();
    expect(extractText({})).toBeNull();
    expect(extractText({ conversation: "a" })).toBe("a");
    expect(extractText({ conversation: "  " })).toBeNull();
    expect(extractText({ extendedTextMessage: { text: "b" } })).toBe("b");
    expect(extractText({ imageMessage: { caption: "c" } })).toBe("c");
    expect(extractText({ ephemeralMessage: { message: { conversation: "d" } } })).toBe("d");
    expect(
      extractText({ viewOnceMessageV2: { message: { videoMessage: { caption: "e" } } } }),
    ).toBe("e");
    expect(
      extractText({
        documentWithCaptionMessage: { message: { documentMessage: { caption: "f" } } },
      }),
    ).toBe("f");
    expect(extractText({ reactionMessage: { text: "👍" } })).toBeNull();
  });
});

describe("toNewMessage", () => {
  const allowed = new Set([G]);
  const names = new Map([[G, "Group A"]]);
  it("accepts allow-listed group text", () => {
    expect(toNewMessage(msg(), allowed, names, now)).toEqual({
      waId: "ABC",
      groupId: G,
      groupName: "Group A",
      sender: senderTag("111@lid"),
      text: "Hiring a backend developer",
      ts: now,
    });
  });
  it("rejects: not allowed, private chat, fromMe, no id, no text, too old", () => {
    expect(toNewMessage(msg(), new Set(), names, now)).toBeNull();
    expect(
      toNewMessage(
        msg({}, { remoteJid: "972500000000@s.whatsapp.net" }),
        new Set(["972500000000@s.whatsapp.net"]),
        names,
        now,
      ),
    ).toBeNull();
    expect(toNewMessage(msg({}, { fromMe: true }), allowed, names, now)).toBeNull();
    expect(toNewMessage(msg({}, { id: undefined }), allowed, names, now)).toBeNull();
    expect(toNewMessage(msg({ message: { reactionMessage: {} } }), allowed, names, now)).toBeNull();
    expect(
      toNewMessage(msg({ messageTimestamp: now / 1000 - 4 * 86400 }), allowed, names, now),
    ).toBeNull();
  });
  it("falls back to jid as name and now as ts", () => {
    const r = toNewMessage(msg({ messageTimestamp: undefined }), allowed, new Map(), now)!;
    expect(r.groupName).toBe(G);
    expect(r.ts).toBe(now);
  });
});

describe("helpers", () => {
  it("senderTag hides the number and is stable", () => {
    expect(senderTag("972500000000@s.whatsapp.net")).toMatch(/^[0-9a-f]{12}$/);
    expect(senderTag("x")).toBe(senderTag("x"));
    expect(senderTag(undefined)).toBe("unknown");
  });
  it("reconnectDelay", () => {
    expect(reconnectDelay(0)).toBe(2000);
    expect(reconnectDelay(3)).toBe(16000);
    expect(reconnectDelay(20)).toBe(300000);
    expect(reconnectDelay(-1)).toBe(2000);
  });
});
