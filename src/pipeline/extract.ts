import { z } from "zod";
import { JOB_TYPES, REGIONS } from "../config.js";
import { DATA_NOT_INSTRUCTIONS, type Llm, quoteData } from "../llm.js";

export const JobPostSchema = z.object({
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  region: z.enum(REGIONS),
  workMode: z.enum(["onsite", "hybrid", "remote", "unknown"]),
  jobType: z.enum(JOB_TYPES),
  /** Percent of a full-time position (e.g. 50 for a half-time student job). */
  scopePercent: z.number().nullable(),
  salary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      period: z.enum(["hour", "month", "year"]),
      currency: z.enum(["ILS", "USD", "EUR"]),
    })
    .nullable(),
  seniority: z.enum(["student", "junior", "mid", "senior", "lead", "unknown"]),
  yearsExperience: z.number().nullable(),
  skills: z.array(z.string()),
  requirements: z.array(z.string()),
  /** Two or three sentences in English. */
  summary: z.string(),
  apply: z.object({
    kind: z.enum(["email", "link", "phone", "unknown"]),
    target: z.string().nullable(),
  }),
  language: z.enum(["he", "en"]),
});
export type JobPost = z.infer<typeof JobPostSchema>;

const BatchSchema = z.object({
  results: z.array(z.object({ messageId: z.number(), jobs: z.array(JobPostSchema) })),
});

export const EXTRACT_SYSTEM = `You read messages from WhatsApp job groups in Israel (Hebrew or English) and extract job posts.
${DATA_NOT_INSTRUCTIONS}

For every message return its messageId and the list of distinct jobs it advertises (empty if it is not a job post:
questions, chit-chat, people looking for work, ads for courses, events or services).
Rules:
- Copy apply targets (email, URL, phone) exactly as written in the message; never invent or complete them.
  Prefer email when the post offers one; otherwise link, otherwise phone.
- Fill a field only when the message states it; otherwise null / "unknown". Do not guess salary.
- region: tel_aviv for Tel Aviv-Yafo; center for Petah Tikva, Ramat Gan, Givatayim, Bnei Brak, Holon, Bat Yam,
  Rosh HaAyin, Airport City; sharon for Herzliya, Ra'anana, Kfar Saba, Hod HaSharon, Netanya; shfela for
  Rehovot, Rishon LeZion, Ness Ziona, Modi'in, Lod, Ramla, Yavne; abroad for outside Israel.
- jobType "student" for student positions (משרת סטודנט), "internship" for internships.
- salary.period: hour/month/year as stated; amounts are plain numbers (e.g. 30000, not "30k").
- summary: English, two or three sentences, what the role does and who they want.
- language: the language the post is written in.`;

export interface ExtractInput {
  id: number;
  text: string;
}

const EMAIL = /(?<![\w.%+])[A-Za-z0-9][\w.%+-]*@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

/**
 * Make sure the apply target really appears in the message; the model must never invent one.
 *
 * Example:
 *   verifyApply({ kind: "email", target: "jobs@x.com" }, "Send CV to jobs@x.com")
 *   // → { kind: "email", target: "jobs@x.com" }
 *   verifyApply({ kind: "email", target: "hr@x.com" }, "Send CV to jobs@x.com")
 *   // → { kind: "email", target: "jobs@x.com" }   (the only email in the text)
 *
 * @returns The verified target, a replacement found in the text, or `unknown`.
 */
export function verifyApply(apply: JobPost["apply"], text: string): JobPost["apply"] {
  const emails = [...new Set(text.match(EMAIL) ?? [])].map((e) => e.replace(/\.+$/, ""));
  const urls = [...new Set(text.match(URL_RE) ?? [])].map((u) => u.replace(/[.,;]+$/, ""));
  const lower = text.toLowerCase();
  const target = apply.target?.trim() ?? "";

  if (apply.kind === "email") {
    const found = emails.find((e) => e.toLowerCase() === target.toLowerCase());
    if (found) return { kind: "email", target: found };
  } else if (apply.kind === "link" || apply.kind === "phone") {
    if (target && lower.includes(target.toLowerCase())) return { kind: apply.kind, target };
  }
  // Fall back to what the text itself contains, in order of preference.
  if (emails.length === 1) return { kind: "email", target: emails[0]! };
  if (apply.kind !== "phone" && urls.length === 1) return { kind: "link", target: urls[0]! };
  return { kind: "unknown", target: null };
}

/**
 * Extract job posts from a batch of messages with one model call.
 *
 * Example:
 *   await extractJobs(llm, "claude-opus-5-5", [{ id: 1, text: "Hiring a backend dev, cv@x.com" }])
 *   // → Map { 1 => [{ title: "Backend Developer", apply: { kind: "email", target: "cv@x.com" }, ... }] }
 *
 * @param llm The model client.
 * @param model Model id.
 * @param messages Up to ~20 messages; each id must be unique.
 * @returns For every input id, the jobs found in it (empty array if none). Ids the model
 *          invents are ignored; apply targets are checked against the message text.
 * @throws Error on duplicate ids; LlmError from the client.
 */
export async function extractJobs(
  llm: Llm,
  model: string,
  messages: ExtractInput[],
): Promise<Map<number, JobPost[]>> {
  const out = new Map<number, JobPost[]>();
  for (const m of messages) {
    if (out.has(m.id)) throw new Error(`duplicate message id ${m.id}`);
    out.set(m.id, []);
  }
  if (messages.length === 0) return out;

  const prompt = messages
    .map((m) => `messageId: ${m.id}\n${quoteData("post", m.text)}`)
    .join("\n\n");
  const res = await llm.json({
    model,
    system: EXTRACT_SYSTEM,
    prompt,
    schema: BatchSchema,
    effort: "low",
  });

  const byId = new Map(messages.map((m) => [m.id, m.text]));
  for (const r of res.results) {
    const text = byId.get(r.messageId);
    if (text === undefined) continue;
    const jobs = r.jobs
      .filter((j) => j.title.trim() !== "")
      .map((j) => ({ ...j, apply: verifyApply(j.apply, text) }));
    out.set(r.messageId, [...out.get(r.messageId)!, ...jobs]);
  }
  return out;
}
