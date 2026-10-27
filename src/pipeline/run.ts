import { z } from "zod";
import type { Profile } from "../config.js";
import { cvForMatch, type MasterCv } from "../cv/master.js";
import { tailorCv, TailoredCvSchema } from "../cv/tailor.js";
import type { Llm } from "../llm.js";
import type { JobRecord, Store } from "../store.js";
import type { CardInput } from "../telegram/cards.js";
import { T } from "../telegram/texts.js";
import { findDuplicate, fingerprint } from "./dedupe.js";
import { type ExtractedJob, extractJobs, type JobPost, JobPostSchema } from "./extract.js";
import { formatLearned, hardFilter, scoreMatch } from "./match.js";
import { looksLikeJobPost } from "./prefilter.js";

/** What a job that reached the owner carries besides the post: the tailored CV and notes. */
export const DraftSchema = z.object({
  tailored: TailoredCvSchema,
  concerns: z.array(z.string()),
  /** The untouched variant was used because tailoring failed validation. */
  fallback: z.boolean(),
});
export type Draft = z.infer<typeof DraftSchema>;

export interface RunDeps {
  store: Store;
  llm: Llm;
  models: { extract: string; tailor: string };
  profile: Profile;
  master: MasterCv | null;
  /** Send the approval card for a job that is now `ready`. */
  sendCard: (job: JobRecord) => Promise<void>;
  now?: () => number;
}

export interface RunReport {
  messages: number;
  candidates: number;
  jobs: number;
  duplicates: number;
  filtered: number;
  lowScore: number;
  ready: number;
  /** Jobs that wait because there is no CV yet or the per-run limit was reached. */
  waiting: number;
  errors: string[];
}

const BATCH = 10;
const MAX_MESSAGES = 200;
const DEDUPE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
/** Model/API errors are retried on later runs for this long, then given up (bounds the cost). */
const RETRY_FOR = 6 * 60 * 60 * 1000;

/** Parse a stored post; `null` if it no longer matches the schema. */
export function storedPost(job: JobRecord): JobPost | null {
  const r = JobPostSchema.safeParse(job.post);
  return r.success ? r.data : null;
}

/**
 * One pipeline run: new messages → prefilter → extract → dedupe → hard filter → score →
 * tailor → approval card. Jobs left in status `new` (no CV yet, per-run limit, a model error)
 * are picked up again on the next run.
 *
 * Example:
 *   await runPipeline({ store, llm, models, profile, master, sendCard })
 *   // → { messages: 12, candidates: 4, jobs: 3, duplicates: 1, filtered: 1, lowScore: 0, ready: 1, ... }
 *
 * @returns Counts for the run summary; errors are collected, not thrown, so one bad message
 *          or job does not stop the rest.
 */
export async function runPipeline(deps: RunDeps): Promise<RunReport> {
  const { store, llm, models, profile, master } = deps;
  const now = deps.now ?? Date.now;
  const report: RunReport = {
    messages: 0,
    candidates: 0,
    jobs: 0,
    duplicates: 0,
    filtered: 0,
    lowScore: 0,
    ready: 0,
    waiting: 0,
    errors: [],
  };

  // 1. Messages → job posts.
  const pending = store.pendingMessages(MAX_MESSAGES);
  report.messages = pending.length;
  // Chit-chat, and posts already seen (the same post forwarded to several groups), never reach
  // the model.
  const seenTexts = new Set<string>();
  const candidates = pending.filter((m) => {
    if (!looksLikeJobPost(m.text)) return false;
    const key = m.text.trim().replace(/\s+/g, " ").toLowerCase();
    if (seenTexts.has(key) || store.hasProcessedText(m.text)) {
      report.duplicates++;
      return false;
    }
    seenTexts.add(key);
    return true;
  });
  report.candidates = candidates.length;
  const candidateIds = new Set(candidates.map((m) => m.id));
  store.markProcessed(pending.filter((m) => !candidateIds.has(m.id)).map((m) => m.id));

  const recent = store
    .jobsSince(now() - DEDUPE_DAYS * DAY)
    .map(storedPost)
    .filter((p): p is JobPost => p !== null);

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    let extracted: Map<number, ExtractedJob[]>;
    try {
      extracted = await extractJobs(llm, models.extract, batch, profile.roles);
    } catch (e) {
      // Left unprocessed so the next run tries again, but not forever.
      report.errors.push(`extract: ${(e as Error).message}`);
      store.markProcessed(batch.filter((m) => now() - m.ts > RETRY_FOR).map((m) => m.id));
      continue;
    }
    for (const m of batch) {
      for (const { post, relevant } of extracted.get(m.id) ?? []) {
        if (findDuplicate(post, recent) !== -1) {
          report.duplicates++;
          continue;
        }
        recent.push(post);
        report.jobs++;
        const id = store.insertJob(
          { fingerprint: fingerprint(post), messageId: m.id, groupName: m.groupName, post },
          now(),
        );
        const filter = relevant
          ? hardFilter(post, profile)
          : { pass: false, reasons: ["not related to the target roles"] };
        if (!filter.pass) {
          store.updateJob(id, { status: "filtered", reasons: filter.reasons }, now());
          report.filtered++;
        }
      }
    }
    store.markProcessed(batch.map((m) => m.id));
  }

  // 2. Jobs that passed the filters → score → tailor → card.
  const waiting = store.jobsByStatus("new");
  if (!master) {
    report.waiting = waiting.length;
    return report;
  }
  const variants = master.variants.map((v) => ({ id: v.id, label: v.label }));
  const learned = formatLearned(
    store
      .recentDecisions(30, "skip")
      .map((d) => {
        const post = storedPost(store.getJob(d.jobId)!);
        return post && d.reason
          ? { title: post.title, company: post.company, reason: d.reason }
          : null;
      })
      .filter((x) => x !== null),
  );
  const cvText = cvForMatch(master);

  let tailored = 0;
  for (const job of waiting) {
    if (tailored >= profile.maxTailoredPerRun) {
      report.waiting++;
      continue;
    }
    const post = storedPost(job);
    if (!post) {
      store.updateJob(job.id, { status: "failed", reasons: ["stored post is invalid"] }, now());
      continue;
    }
    try {
      const match = await scoreMatch(llm, models.tailor, post, {
        profile,
        cv: cvText,
        variants,
        learned,
      });
      if (match.score < profile.minScore) {
        store.updateJob(
          job.id,
          { status: "low_score", score: match.score, reasons: match.reasons },
          now(),
        );
        report.lowScore++;
        continue;
      }
      const t = await tailorCv(llm, models.tailor, master, post, match.variant);
      tailored++;
      const draft: Draft = { tailored: t.tailored, concerns: match.concerns, fallback: t.fallback };
      const updated = store.updateJob(
        job.id,
        { status: "ready", score: match.score, reasons: match.reasons, draft },
        now(),
      );
      report.ready++;
      await deps.sendCard(updated);
    } catch (e) {
      // Model/API errors are often transient: retry on later runs, then give up.
      report.errors.push(`job ${job.id}: ${(e as Error).message}`);
      if (now() - job.createdAt > RETRY_FOR) {
        store.updateJob(job.id, { status: "failed", reasons: [(e as Error).message] }, now());
      }
    }
  }
  return report;
}

/**
 * Salary as a short display string.
 *
 * Example: formatSalary({ min: 30000, max: 35000, period: "month", currency: "ILS" }) → "30,000–35,000 ₪/month"
 */
export function formatSalary(salary: JobPost["salary"]): string | null {
  if (!salary || (salary.min == null && salary.max == null)) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const symbol = { ILS: "₪", USD: "$", EUR: "€" }[salary.currency];
  const amount =
    salary.min != null && salary.max != null && salary.min !== salary.max
      ? `${fmt(salary.min)}–${fmt(salary.max)}`
      : fmt((salary.max ?? salary.min)!);
  return `${amount} ${symbol}/${salary.period}`;
}

/**
 * Build the approval card for a `ready` job.
 *
 * @returns The card, or `null` when the job has no valid post or draft.
 */
export function toCard(job: JobRecord, master: MasterCv | null): CardInput | null {
  const post = storedPost(job);
  const draft = DraftSchema.safeParse(job.draft);
  if (!post || !draft.success) return null;
  const variant = master?.variants.find((v) => v.id === draft.data.tailored.variant);
  const location = [post.location, post.workMode !== "unknown" ? post.workMode : null]
    .filter(Boolean)
    .join(", ");
  return {
    jobId: job.id,
    title: post.title,
    company: post.company,
    location: location || null,
    salary: formatSalary(post.salary),
    score: job.score ?? 0,
    reasons: job.reasons,
    concerns: draft.data.fallback ? [...draft.data.concerns, T.cvNotTailored] : draft.data.concerns,
    coverMessage: draft.data.tailored.coverMessage,
    apply: post.apply,
    cvVariant: variant?.label ?? null,
    group: job.groupName,
  };
}
