import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  type proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import type { NewMessage, Store } from "../store.js";

/** Key-value names shared with the bot and health checks. */
export const KV = {
  allowedGroups: "allowed_groups",
  groupNames: "wa_group_names",
  connected: "wa_connected",
  lastEvent: "wa_last_event",
  disconnectedSince: "wa_disconnected_since",
} as const;

const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The text of a WhatsApp message: plain text, extended text, or a media caption, also inside
 * ephemeral / view-once / document-with-caption wrappers.
 *
 * Example:
 *   extractText({ extendedTextMessage: { text: "Hiring!" } })   // → "Hiring!"
 *   extractText({ reactionMessage: { text: "👍" } })            // → null
 */
export function extractText(m: proto.IMessage | null | undefined, depth = 0): string | null {
  if (!m || depth > 3) return null;
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null;
  if (text && text.trim()) return text;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m.editedMessage?.message;
  return inner ? extractText(inner, depth + 1) : null;
}

/** A short, stable pseudonym for a sender; the store never keeps phone numbers of others. */
export function senderTag(participant: string | null | undefined): string {
  if (!participant) return "unknown";
  return createHash("sha256").update(participant).digest("hex").slice(0, 12);
}

/**
 * Turn an incoming WhatsApp message into a store record, or `null` if it must be ignored:
 * not a group, group not allow-listed, sent by the owner, no text, or older than 3 days.
 *
 * Example:
 *   toNewMessage(msg, new Set(["1203@g.us"]), new Map([["1203@g.us", "Jobs"]]), Date.now())
 *   // → { waId: "3EB0...", groupId: "1203@g.us", groupName: "Jobs", text: "...", ... }
 */
export function toNewMessage(
  msg: WAMessage,
  allowed: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
  now: number,
): NewMessage | null {
  const groupId = msg.key.remoteJid;
  if (!groupId?.endsWith("@g.us") || !allowed.has(groupId)) return null;
  if (msg.key.fromMe || !msg.key.id) return null;
  const text = extractText(msg.message);
  if (!text) return null;
  const ts = Number(msg.messageTimestamp ?? 0) * 1000 || now;
  if (now - ts > MAX_AGE_MS) return null;
  return {
    waId: msg.key.id,
    groupId,
    groupName: names.get(groupId) ?? groupId,
    sender: senderTag(msg.key.participant),
    text: text.trim(),
    ts,
  };
}

/**
 * Backoff before reconnecting: 2 s doubling up to 5 minutes.
 *
 * Example: reconnectDelay(0) → 2000, reconnectDelay(3) → 16000, reconnectDelay(20) → 300000
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(300_000, 2000 * 2 ** Math.max(0, attempt));
}

export interface WhatsAppOptions {
  authDir: string;
  /** Owner's number, digits with country code, used to request a pairing code. */
  phone: string;
  store: Store;
  onPairingCode: (code: string) => void;
  onConnected: () => void;
  onLoggedOut: () => void;
  now?: () => number;
}

export interface WhatsApp {
  isConnected(): boolean;
  stop(): void;
}

const PAIRING_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Connect to WhatsApp as a linked device and store messages from allow-listed groups.
 * Read-only: it never sends anything. Reconnects with backoff; after a logout it clears the
 * session and asks for a new pairing code (at most one code per 10 minutes).
 */
export function startWhatsApp(opts: WhatsAppOptions): WhatsApp {
  const now = opts.now ?? Date.now;
  const logger = pino({ level: "warn" });
  let sock: WASocket | null = null;
  let connected = false;
  let stopped = false;
  let attempt = 0;
  let lastPairingAt = 0;

  const setConnected = (value: boolean) => {
    connected = value;
    opts.store.setKv(KV.connected, value);
    if (value) opts.store.setKv(KV.disconnectedSince, null);
    else if (opts.store.getKv<number | null>(KV.disconnectedSince, null) === null) {
      opts.store.setKv(KV.disconnectedSince, now());
    }
  };

  const refreshGroups = async () => {
    if (!sock) return;
    const groups = await sock.groupFetchAllParticipating();
    const names = Object.fromEntries(Object.values(groups).map((g) => [g.id, g.subject]));
    opts.store.setKv(KV.groupNames, names);
  };

  const connect = async () => {
    if (stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    const current = sock;
    current.ev.on("creds.update", saveCreds);

    current.ev.on("connection.update", async (u) => {
      opts.store.setKv(KV.lastEvent, now());
      // The socket is ready for a pairing request once it offers a QR code.
      if (u.qr && !state.creds.registered && now() - lastPairingAt > PAIRING_INTERVAL_MS) {
        try {
          const code = await current.requestPairingCode(opts.phone);
          lastPairingAt = now();
          opts.onPairingCode(code);
        } catch (e) {
          logger.warn({ err: e }, "pairing code request failed");
        }
      }
      if (u.connection === "open") {
        attempt = 0;
        setConnected(true);
        opts.onConnected();
        refreshGroups().catch((e) => logger.warn({ err: e }, "group fetch failed"));
      }
      if (u.connection === "close") {
        setConnected(false);
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          rmSync(opts.authDir, { recursive: true, force: true });
          opts.onLoggedOut();
        }
        if (!stopped) setTimeout(() => void connect(), reconnectDelay(attempt++));
      }
    });

    const onGroupsChanged = () => {
      refreshGroups().catch((e) => logger.warn({ err: e }, "group fetch failed"));
    };
    current.ev.on("groups.update", onGroupsChanged);
    current.ev.on("groups.upsert", onGroupsChanged);

    current.ev.on("messages.upsert", ({ messages }) => {
      opts.store.setKv(KV.lastEvent, now());
      const allowed = new Set(opts.store.getKv<string[]>(KV.allowedGroups, []));
      const names = new Map(
        Object.entries(opts.store.getKv<Record<string, string>>(KV.groupNames, {})),
      );
      for (const m of messages) {
        const record = toNewMessage(m, allowed, names, now());
        if (record) opts.store.insertMessage(record);
      }
    });
  };

  void connect();

  return {
    isConnected: () => connected,
    stop() {
      stopped = true;
      sock?.end(undefined);
    },
  };
}
