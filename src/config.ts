import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-5-5";

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  WA_PHONE: z
    .string()
    .transform((s) => s.replace(/\D/g, ""))
    .pipe(z.string().regex(/^\d{8,15}$/, "WA_PHONE must be digits with country code")),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_APP_PASSWORD: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  SCAN_INTERVAL_MIN: z.coerce.number().int().min(5).max(1440).default(60),
  MODEL_EXTRACT: z.string().default(DEFAULT_MODEL),
  MODEL_TAILOR: z.string().default(DEFAULT_MODEL),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Read and validate the process environment.
 *
 * Empty strings count as unset, so a blank Railway variable falls back to its default.
 *
 * Example:
 *   loadEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "42", WA_PHONE: "+972 50-000-0000" })
 *   // → { ..., TELEGRAM_OWNER_ID: 42, WA_PHONE: "972500000000", SCAN_INTERVAL_MIN: 60, ... }
 *
 * @param env Variables, usually `process.env`.
 * @returns The validated environment with defaults applied.
 * @throws Error listing every missing or invalid variable (values are never echoed).
 */
export function loadEnv(env: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
  }
  return result.data;
}

/** `true` when both SMTP credentials are present, so email applications can be sent. */
export function canSendEmail(env: Env): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_APP_PASSWORD);
}

export const JOB_TYPES = [
  "full_time",
  "student",
  "part_time",
  "internship",
  "freelance",
  "unknown",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const REGIONS = [
  "center",
  "tel_aviv",
  "sharon",
  "shfela",
  "jerusalem",
  "haifa",
  "north",
  "south",
  "abroad",
  "unknown",
] as const;
export type Region = (typeof REGIONS)[number];

export const ProfileSchema = z.object({
  roles: z.array(z.string()).min(1),
  jobTypes: z.array(z.enum(JOB_TYPES)).min(1),
  regions: z.array(z.enum(REGIONS)).min(1),
  acceptRemote: z.boolean().default(true),
  salary: z
    .object({
      minMonthly: z.number().int().nonnegative(),
      preferredMonthly: z.number().int().nonnegative(),
      /** Monthly hours of a full-time job, used to turn hourly rates into monthly ones. */
      fullTimeHours: z.number().positive().default(182),
    })
    .refine((s) => s.preferredMonthly >= s.minMonthly, "preferredMonthly must be ≥ minMonthly"),
  exclude: z.array(z.string()).default([]),
  minScore: z.number().int().min(0).max(100).default(60),
  maxTailoredPerRun: z.number().int().min(1).max(50).default(8),
  notes: z.string().default(""),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Neutral starting profile written on first run, so nothing is filtered out by mistake.
 * The owner's real roles, regions and salary are set through the bot (`/setprofile`) and
 * live only in `profile.yaml` on the data volume, never in git.
 */
export const DEFAULT_PROFILE: Profile = {
  roles: ["Software engineer"],
  jobTypes: ["full_time"],
  regions: REGIONS.filter((r) => r !== "abroad" && r !== "unknown"),
  acceptRemote: true,
  salary: { minMonthly: 0, preferredMonthly: 0, fullTimeHours: 182 },
  exclude: [],
  minScore: 60,
  maxTailoredPerRun: 8,
  notes: "Set your real profile with /setprofile",
};

/**
 * Parse and validate a profile written in YAML.
 *
 * Example:
 *   parseProfile("roles: [ML engineer]\njobTypes: [student]\nregions: [center]\n" +
 *                "salary: {minMonthly: 15000, preferredMonthly: 18000}")
 *   // → { roles: ["ML engineer"], ..., minScore: 60 }
 *
 * @param text YAML document.
 * @returns The profile with defaults applied.
 * @throws Error with the YAML or validation problem.
 */
export function parseProfile(text: string): Profile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new Error(`Profile is not valid YAML: ${(e as Error).message}`);
  }
  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid profile:\n  ${problems.join("\n  ")}`);
  }
  return result.data;
}

/** Serialise a profile to YAML (the format the owner edits). */
export function profileToYaml(profile: Profile): string {
  return stringifyYaml(profile);
}

/**
 * Load `profile.yaml` from the data directory, creating it from `DEFAULT_PROFILE` if missing.
 *
 * @param dataDir Data directory (the Railway volume).
 * @returns The validated profile.
 * @throws Error if the file exists but is invalid.
 */
export function loadProfile(dataDir: string): Profile {
  const file = path.join(dataDir, "profile.yaml");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, profileToYaml(DEFAULT_PROFILE));
    return DEFAULT_PROFILE;
  }
  return parseProfile(readFileSync(file, "utf8"));
}

/** Validate and save a profile to `profile.yaml`. Throws before writing if invalid. */
export function saveProfile(dataDir: string, text: string): Profile {
  const profile = parseProfile(text);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profile.yaml"), profileToYaml(profile));
  return profile;
}
