import { createServer, type Server } from "node:http";
import { T } from "./telegram/texts.js";

export interface HealthInput {
  now: number;
  /** Newest stored group message, or null if none ever. */
  lastMessageAt: number | null;
  /** When the process started (so a fresh deploy is not reported as stuck). */
  startedAt: number;
  waConnected: boolean;
  waDisconnectedSince: number | null;
  allowedGroups: number;
}

export interface Alert {
  key: "no_messages" | "wa_down";
  text: string;
}

const HOUR = 60 * 60 * 1000;
export const NO_MESSAGES_HOURS = 24;
export const WA_DOWN_MINUTES = 15;

/**
 * Health problems worth telling the owner about. A listener can be connected and still stuck,
 * so silence from the groups counts as a problem, not only a dropped connection.
 *
 * Example:
 *   checkHealth({ now, lastMessageAt: now - 30 * HOUR, startedAt: 0, waConnected: true,
 *                 waDisconnectedSince: null, allowedGroups: 3 })
 *   // → [{ key: "no_messages", text: "לא הגיעו הודעות מהקבוצות כבר 30 שעות..." }]
 */
export function checkHealth(h: HealthInput): Alert[] {
  const alerts: Alert[] = [];
  if (h.waDisconnectedSince !== null && !h.waConnected) {
    const minutes = Math.floor((h.now - h.waDisconnectedSince) / 60_000);
    if (minutes >= WA_DOWN_MINUTES) alerts.push({ key: "wa_down", text: T.alertWaDown(minutes) });
  }
  if (h.allowedGroups > 0) {
    const since = Math.max(h.lastMessageAt ?? 0, h.startedAt);
    const hours = Math.floor((h.now - since) / HOUR);
    if (hours >= NO_MESSAGES_HOURS) {
      alerts.push({ key: "no_messages", text: T.alertNoMessages(hours) });
    }
  }
  return alerts;
}

/**
 * Keep only alerts not sent within `cooldownMs`, and record the ones that pass in `sent`.
 *
 * Example:
 *   throttleAlerts([{ key: "wa_down", ... }], { wa_down: now - 1000 }, now, 6 * HOUR)  // → []
 */
export function throttleAlerts(
  alerts: Alert[],
  sent: Record<string, number>,
  now: number,
  cooldownMs: number,
): Alert[] {
  return alerts.filter((a) => {
    if (now - (sent[a.key] ?? Number.NEGATIVE_INFINITY) < cooldownMs) return false;
    sent[a.key] = now;
    return true;
  });
}

/**
 * Serve `GET /healthz` with a JSON status. It answers 200 while the process runs, so Railway
 * does not restart a service that only waits for WhatsApp pairing; problems go to Telegram.
 */
export function startHealthServer(port: number, status: () => Record<string, unknown>): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...status() }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
