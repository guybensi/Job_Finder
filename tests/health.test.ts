import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { checkHealth, startHealthServer, throttleAlerts } from "../src/health.js";

const HOUR = 3600_000;

describe("checkHealth", () => {
  const now = 100 * HOUR;
  const base = {
    now,
    lastMessageAt: now - HOUR,
    startedAt: 0,
    waConnected: true,
    waDisconnectedSince: null,
    allowedGroups: 2,
  };
  it("healthy", () => {
    expect(checkHealth(base)).toEqual([]);
  });
  it("no messages for a day, even while connected", () => {
    expect(checkHealth({ ...base, lastMessageAt: now - 30 * HOUR }).map((a) => a.key)).toEqual([
      "no_messages",
    ]);
    expect(checkHealth({ ...base, lastMessageAt: null }).map((a) => a.key)).toEqual([
      "no_messages",
    ]);
  });
  it("fresh start or no groups → no silence alert", () => {
    expect(checkHealth({ ...base, lastMessageAt: null, startedAt: now - HOUR })).toEqual([]);
    expect(checkHealth({ ...base, lastMessageAt: null, allowedGroups: 0 })).toEqual([]);
  });
  it("wa down for 15+ minutes", () => {
    expect(
      checkHealth({ ...base, waConnected: false, waDisconnectedSince: now - 10 * 60_000 }),
    ).toEqual([]);
    expect(
      checkHealth({ ...base, waConnected: false, waDisconnectedSince: now - 20 * 60_000 })[0]!.key,
    ).toBe("wa_down");
  });
  it("throttle", () => {
    const sent: Record<string, number> = {};
    const a = [{ key: "wa_down" as const, text: "x" }];
    expect(throttleAlerts(a, sent, 1000, HOUR)).toHaveLength(1);
    expect(throttleAlerts(a, sent, 2000, HOUR)).toHaveLength(0);
    expect(throttleAlerts(a, sent, 1000 + HOUR, HOUR)).toHaveLength(1);
  });
});

describe("health server", () => {
  it("serves /healthz and 404 elsewhere", async () => {
    const server = startHealthServer(0, () => ({ wa: true }));
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, wa: true });
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    server.close();
  });
});
