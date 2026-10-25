import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  canSendEmail,
  loadEnv,
  loadProfile,
  parseProfile,
  profileToYaml,
  saveProfile,
} from "../src/config.js";

const baseEnv = { TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_OWNER_ID: "42", WA_PHONE: "972500000000" };

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(baseEnv);
    expect(env.TELEGRAM_OWNER_ID).toBe(42);
    expect(env.SCAN_INTERVAL_MIN).toBe(60);
    expect(env.MODEL_TAILOR).toBe("claude-opus-5-5");
    expect(env.DATA_DIR).toBe("./data");
  });

  it("normalises a formatted phone number to digits", () => {
    expect(loadEnv({ ...baseEnv, WA_PHONE: "+972 50-000-0000" }).WA_PHONE).toBe("972500000000");
  });

  it("treats blank variables as unset", () => {
    expect(loadEnv({ ...baseEnv, SCAN_INTERVAL_MIN: "  " }).SCAN_INTERVAL_MIN).toBe(60);
  });

  it("lists every problem without echoing secrets", () => {
    const run = () => loadEnv({ TELEGRAM_BOT_TOKEN: "secret-value", TELEGRAM_OWNER_ID: "abc" });
    expect(run).toThrow(/TELEGRAM_OWNER_ID/);
    expect(run).toThrow(/WA_PHONE/);
    expect(run).not.toThrow(/secret-value/);
  });

  it("rejects a scan interval below 5 minutes", () => {
    expect(() => loadEnv({ ...baseEnv, SCAN_INTERVAL_MIN: "1" })).toThrow(/SCAN_INTERVAL_MIN/);
  });

  it("canSendEmail needs both SMTP credentials", () => {
    expect(canSendEmail(loadEnv(baseEnv))).toBe(false);
    expect(canSendEmail(loadEnv({ ...baseEnv, SMTP_USER: "a@b.c" }))).toBe(false);
    expect(canSendEmail(loadEnv({ ...baseEnv, SMTP_USER: "a@b.c", SMTP_APP_PASSWORD: "x" }))).toBe(
      true,
    );
  });
});

describe("parseProfile", () => {
  const minimal =
    "roles: [ML engineer]\njobTypes: [student]\nregions: [center]\n" +
    "salary: {minMonthly: 15000, preferredMonthly: 18000}\n";

  it("fills defaults", () => {
    const p = parseProfile(minimal);
    expect(p.minScore).toBe(60);
    expect(p.salary.fullTimeHours).toBe(182);
    expect(p.acceptRemote).toBe(true);
  });

  it("round-trips through YAML", () => {
    expect(parseProfile(profileToYaml(DEFAULT_PROFILE))).toEqual(DEFAULT_PROFILE);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseProfile("roles: [unclosed")).toThrow(/not valid YAML/);
  });

  it("rejects unknown regions and empty roles", () => {
    expect(() => parseProfile(minimal.replace("[center]", "[mars]"))).toThrow(/regions/);
    expect(() => parseProfile(minimal.replace("[ML engineer]", "[]"))).toThrow(/roles/);
  });

  it("rejects preferred salary below the minimum", () => {
    expect(() => parseProfile(minimal.replace("18000", "1000"))).toThrow(/preferredMonthly/);
  });

  it("rejects an empty document", () => {
    expect(() => parseProfile("")).toThrow(/Invalid profile/);
  });
});

describe("loadProfile / saveProfile", () => {
  it("creates the default profile on first run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jf-"));
    expect(loadProfile(dir)).toEqual(DEFAULT_PROFILE);
    expect(readFileSync(path.join(dir, "profile.yaml"), "utf8")).toContain("minMonthly: 0");
  });

  it("does not overwrite the file when the new profile is invalid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jf-"));
    loadProfile(dir);
    expect(() => saveProfile(dir, "roles: []")).toThrow();
    expect(loadProfile(dir)).toEqual(DEFAULT_PROFILE);
  });

  it("throws on a corrupted existing file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jf-"));
    writeFileSync(path.join(dir, "profile.yaml"), "roles: 5");
    expect(() => loadProfile(dir)).toThrow(/Invalid profile/);
  });
});
