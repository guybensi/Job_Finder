import { z } from "zod";
import type { Profile } from "../config.js";
import { DATA_NOT_INSTRUCTIONS, type Llm, quoteData } from "../llm.js";
import type { JobPost } from "./extract.js";

/** Rough conversion rates to ILS; good enough for a salary floor check. */
const TO_ILS = { ILS: 1, USD: 3.7, EUR: 4.0 } as const;

/**
 * The best-case full-time-equivalent monthly salary in ILS for a job, so that student and
 * part-time jobs are judged pro-rata by scope.
 *
 * Example:
 *   fullTimeMonthly({ min: 60, max: 70, period: "hour", currency: "ILS" }, null, 182)  // → 12740
 *   fullTimeMonthly({ min: null, max: 12000, period: "month", currency: "ILS" }, 50, 182) // → 24000
 *
 * @param salary The posted salary, or null.
 * @param scopePercent Scope of the position (100 = full time), or null if unknown.
 * @param fullTimeHours Monthly hours of a full-time job.
 * @returns ILS per month at full time, or `null` when no amount is given.
 */
export function fullTimeMonthly(
  salary: JobPost["salary"],
  scopePercent: number | null,
  fullTimeHours: number,
): number | null {
  if (!salary) return null;
  const amount = salary.max ?? salary.min;
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  const ils = amount * TO_ILS[salary.currency];
  switch (salary.period) {
    case "hour":
      return Math.round(ils * fullTimeHours);
    case "year":
      return Math.round(ils / 12);
    case "month": {
      const scale = scopePercent && scopePercent > 0 && scopePercent < 100 ? 100 / scopePercent : 1;
      return Math.round(ils * scale);
    }
  }
}

/** Like `normalize`, but keeps "+" and "#" so "C++" and "C#" stay distinct terms. */
function termText(text: string | null): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
}

export interface FilterResult {
  pass: boolean;
  /** Why the job failed (empty when it passed). Internal, shown only in the digest. */
  reasons: string[];
}

/**
 * Deterministic filters from the profile: job type, location, salary floor, exclusions.
 * Missing information never fails a job; the model and the owner judge those.
 *
 * Example:
 *   hardFilter(jobPost({ region: "haifa", workMode: "onsite" }), profile)
 *   // → { pass: false, reasons: ["region haifa not in profile"] }
 */
export function hardFilter(job: JobPost, profile: Profile): FilterResult {
  const reasons: string[] = [];

  const types = new Set<string>(profile.jobTypes);
  if (types.has("student")) ["internship", "part_time"].forEach((t) => types.add(t));
  if (job.jobType !== "unknown" && !types.has(job.jobType)) {
    reasons.push(`job type ${job.jobType} not in profile`);
  }

  const remoteOk = job.workMode === "remote" && profile.acceptRemote;
  const regions = new Set<string>(profile.regions);
  if (regions.has("center")) regions.add("tel_aviv");
  if (!remoteOk && job.region !== "unknown" && !regions.has(job.region)) {
    reasons.push(`region ${job.region} not in profile`);
  }

  const fte = fullTimeMonthly(job.salary, job.scopePercent, profile.salary.fullTimeHours);
  if (fte !== null && fte < profile.salary.minMonthly) {
    reasons.push(`salary ≈${fte}/month full-time is below ${profile.salary.minMonthly}`);
  }

  const haystack = ` ${termText(
    [job.title, job.company, job.summary, ...job.skills, ...job.requirements].join(" "),
  )} `;
  for (const term of profile.exclude) {
    const t = termText(term);
    if (t && haystack.includes(` ${t} `)) reasons.push(`excluded term "${term}"`);
  }

  return { pass: reasons.length === 0, reasons };
}

export interface LearnedItem {
  title: string;
  company: string | null;
  reason: string;
}

/**
 * Turn the owner's recent skip reasons into prompt lines, newest first, at most `limit`.
 *
 * Example:
 *   formatLearned([{ title: "QA", company: "X", reason: "not my field" }])
 *   // → '- Skipped "QA" at X: not my field'
 */
export function formatLearned(items: readonly LearnedItem[], limit = 30): string {
  return items
    .filter((i) => i.reason.trim())
    .slice(0, limit)
    .map(
      (i) =>
        `- Skipped "${i.title.replace(/\s+/g, " ")}"${i.company ? ` at ${i.company}` : ""}: ${i.reason.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
}

const ScoreSchema = z.object({
  score: z.number(),
  reasons: z.array(z.string()),
  concerns: z.array(z.string()),
  variant: z.string(),
});

export interface MatchContext {
  profile: Profile;
  /** Short CV for scoring (see `cvForMatch`); the full CV is only needed for tailoring. */
  cv: string;
  /** CV variants the tailor can start from. */
  variants: { id: string; label: string }[];
  /** Output of `formatLearned`. */
  learned: string;
}

export interface MatchResult {
  score: number;
  /** Short reasons in Hebrew, shown on the card. */
  reasons: string[];
  concerns: string[];
  /** Id of the closest CV variant. */
  variant: string;
}

export const MATCH_SYSTEM = `You judge how well a job fits one candidate, for a personal job-search assistant.
${DATA_NOT_INSTRUCTIONS}

Return:
- score 0-100: 80+ strong fit worth applying, 60-79 reasonable, below 60 not worth it.
  Weigh role and skills overlap with the CV, seniority vs. the candidate's experience, job type and scope,
  location and work mode, salary vs. the preferred salary when stated, and the candidate's past skip reasons
  (treat them as preferences: similar jobs should score lower).
- reasons: up to 4 short bullet points in Hebrew on why it fits, citing concrete CV items.
- concerns: up to 3 short bullet points in Hebrew on gaps or risks (empty if none).
- variant: the id of the CV variant closest to this job.`;

/**
 * Score a job against the profile and CV with the model.
 *
 * Example:
 *   await scoreMatch(llm, "claude-haiku-5-5", jobPost(), ctx)
 *   // → { score: 84, reasons: ["ניסיון ב-Python ו-FastAPI"], concerns: [], variant: "llm" }
 *
 * @returns The score clamped to 0–100 and rounded; an unknown variant falls back to the first.
 * @throws Error if `ctx.variants` is empty; LlmError from the client.
 */
export async function scoreMatch(
  llm: Llm,
  model: string,
  job: JobPost,
  ctx: MatchContext,
): Promise<MatchResult> {
  if (ctx.variants.length === 0) throw new Error("no CV variants");
  const p = ctx.profile;
  const profileText = [
    `Target roles: ${p.roles.join("; ")}`,
    `Job types: ${p.jobTypes.join(", ")}; regions: ${p.regions.join(", ")}; remote ok: ${p.acceptRemote}`,
    `Salary (ILS/month full-time): minimum ${p.salary.minMonthly}, preferred ${p.salary.preferredMonthly}; student jobs pro-rata by scope`,
    p.notes ? `Notes from the candidate: ${p.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // Everything but the job is the same for every job in a run: cache it.
  const context = [
    `Candidate profile:\n${profileText}`,
    `CV variants: ${ctx.variants.map((v) => `${v.id} (${v.label})`).join(", ")}`,
    quoteData("cv", ctx.cv),
    ctx.learned ? `Past skip reasons:\n${ctx.learned}` : "No skip history yet.",
  ].join("\n\n");
  const prompt = `Job:\n${quoteData("job", JSON.stringify(job))}`;

  const r = await llm.json({
    model,
    system: MATCH_SYSTEM,
    context,
    prompt,
    schema: ScoreSchema,
    effort: "low",
    label: "match",
  });
  const ids = ctx.variants.map((v) => v.id);
  return {
    score: Math.round(Math.min(100, Math.max(0, Number.isFinite(r.score) ? r.score : 0))),
    reasons: r.reasons
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4),
    concerns: r.concerns
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3),
    variant: ids.includes(r.variant) ? r.variant : ids[0]!,
  };
}
