import { z } from "zod";
import { DATA_NOT_INSTRUCTIONS, type Llm, quoteData } from "../llm.js";
import type { JobPost } from "../pipeline/extract.js";
import { cvForPrompt, type MasterCv, numbersIn } from "./master.js";

export const TailoredCvSchema = z.object({
  variant: z.string(),
  headline: z.string(),
  summary: z.string(),
  /** Selected master items in the order to show them, with reworded bullets. */
  items: z.array(z.object({ id: z.string(), bullets: z.array(z.string()) })),
  /** Short message to send with the CV, in the job post's language. */
  coverMessage: z.string(),
});
export type TailoredCv = z.infer<typeof TailoredCvSchema>;

// Words that are capitalised for grammar, not because they name something.
const ALLOWED = new Set(
  "i i'm i've i'd i'll cv hi hello dear thanks thank best regards sincerely kind warm mr ms".split(
    " ",
  ),
);

function rawTokens(text: string): string[] {
  return text.split(/[\s,;:()[\]{}"“”'‘’!?|/]+/).filter(Boolean);
}

function clean(token: string): string {
  return token.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, "");
}

/** Lowercased tokens of `text`, including the parts of hyphenated words. */
export function vocabulary(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const raw of rawTokens(t)) {
      const c = clean(raw).toLowerCase();
      if (!c) continue;
      out.add(c);
      for (const part of c.split(/[-.]/)) if (part) out.add(part);
    }
  }
  return out;
}

/**
 * Tokens in `text` that look like facts: names, acronyms, technologies, anything with a digit.
 * Plain words and sentence-initial capitals ("Built", "Led") are not facts.
 *
 * Example:
 *   factTokens("Built APIs at Google with PyTorch and C++.")  // → ["APIs", "Google", "PyTorch", "C++"]
 */
export function factTokens(text: string): string[] {
  const out: string[] = [];
  let sentenceStart = true;
  for (const raw of text.split(/[\s/]+/).filter(Boolean)) {
    // Hebrew prefixes glued with a hyphen ("ב-Python", "ל-Acme") are not part of the name.
    const token = clean(
      (
        raw
          .replace(/[,;:()[\]{}"“”'‘’!?|]+/g, " ")
          .trim()
          .split(" ")[0] ?? ""
      ).replace(/^[\u05D0-\u05EA]{1,3}-/, ""),
    );
    const endsSentence = /[.!?:]["”')]*$/.test(raw) || raw.startsWith("-") || raw === "•";
    if (token) {
      const hasDigit = /\p{N}/u.test(token);
      const innerUpper = /\p{Lu}/u.test(token.slice(1));
      const symbol = /[+#]/.test(token);
      const capitalised = /^\p{Lu}/u.test(token);
      if (
        !ALLOWED.has(token.toLowerCase()) &&
        (hasDigit || innerUpper || symbol || (capitalised && !sentenceStart))
      ) {
        out.push(token);
      }
    }
    sentenceStart = endsSentence;
  }
  return out;
}

function known(token: string, vocab: Set<string>): boolean {
  const t = token.toLowerCase();
  if (vocab.has(t)) return true;
  const parts = t.split(/[-.]/).filter(Boolean);
  // "APIs" → "api"
  if (vocab.has(t.replace(/s$/, ""))) return true;
  return parts.length > 1 && parts.every((p) => vocab.has(p) || vocab.has(p.replace(/s$/, "")));
}

function masterTexts(master: MasterCv): string[] {
  return [
    master.name,
    ...master.variants.flatMap((v) => [v.headline, v.summary]),
    ...master.items.flatMap((i) => [i.heading, i.subheading ?? "", i.dates ?? "", ...i.bullets]),
  ];
}

function jobTexts(job: JobPost): string[] {
  return [
    job.title,
    job.company ?? "",
    job.location ?? "",
    job.summary,
    ...job.skills,
    ...job.requirements,
  ];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Check that a tailored CV only reorders, selects and rewords the master CV — no new facts.
 *
 * Rules:
 * - the variant and every item id exist; no item twice; at least one item;
 * - an item has no more bullets than its master version;
 * - numbers in a bullet appear in that same master item; numbers in the headline/summary
 *   appear somewhere in the master;
 * - fact-like tokens (names, acronyms, technologies) appear in the master CV;
 * - the cover message may also use words and numbers from the job post.
 *
 * Example:
 *   validateTailored(master, { ..., items: [{ id: "exp-1", bullets: ["Cut latency by 60%"] }] }, job)
 *   // → { ok: false, errors: ['exp-1: number 60 is not in this item'] }
 */
export function validateTailored(
  master: MasterCv,
  tailored: TailoredCv,
  job: JobPost,
): ValidationResult {
  const errors: string[] = [];
  const vocab = vocabulary(masterTexts(master));
  const allNumbers = new Set(masterTexts(master).flatMap(numbersIn));

  if (!master.variants.some((v) => v.id === tailored.variant)) {
    errors.push(`variant ${tailored.variant} does not exist`);
  }
  if (tailored.items.length === 0) errors.push("no items selected");

  const checkText = (label: string, text: string, numbers: Set<string>, words: Set<string>) => {
    for (const n of numbersIn(text)) {
      if (!numbers.has(n)) errors.push(`${label}: number ${n} is not in the CV`);
    }
    for (const t of factTokens(text)) {
      if (!/\p{N}/u.test(t) && !known(t, words)) errors.push(`${label}: "${t}" is not in the CV`);
    }
  };

  checkText("headline", tailored.headline, allNumbers, vocab);
  checkText("summary", tailored.summary, allNumbers, vocab);

  const seen = new Set<string>();
  for (const item of tailored.items) {
    const source = master.items.find((i) => i.id === item.id);
    if (!source) {
      errors.push(`item ${item.id} does not exist`);
      continue;
    }
    if (seen.has(item.id)) errors.push(`item ${item.id} appears twice`);
    seen.add(item.id);
    if (item.bullets.length > source.bullets.length) {
      errors.push(
        `${item.id}: ${item.bullets.length} bullets but the CV has ${source.bullets.length}`,
      );
    }
    const itemNumbers = new Set(
      [source.heading, source.subheading ?? "", source.dates ?? "", ...source.bullets].flatMap(
        numbersIn,
      ),
    );
    item.bullets.forEach((b) => {
      for (const n of numbersIn(b)) {
        if (!itemNumbers.has(n)) errors.push(`${item.id}: number ${n} is not in this item`);
      }
      for (const t of factTokens(b)) {
        if (!/\p{N}/u.test(t) && !known(t, vocab))
          errors.push(`${item.id}: "${t}" is not in the CV`);
      }
    });
  }

  const jobWords = vocabulary(jobTexts(job));
  checkText(
    "cover message",
    tailored.coverMessage,
    new Set([...allNumbers, ...jobTexts(job).flatMap(numbersIn)]),
    new Set([...vocab, ...jobWords]),
  );
  if (!tailored.coverMessage.trim()) errors.push("cover message is empty");

  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic cover message used when the model's tailoring keeps failing validation.
 *
 * Example:
 *   fallbackCover(jobPost({ language: "en", title: "Data Scientist", company: "Acme" }), "Dana")
 *   // → "Hello,\n\nI'd like to apply for the Data Scientist position at Acme. My CV is attached.\n\nBest regards,\nDana"
 */
export function fallbackCover(job: JobPost, name: string): string {
  if (job.language === "he") {
    return `שלום,\n\nאשמח להגיש מועמדות למשרת ${job.title}${job.company ? ` ב-${job.company}` : ""}. קורות החיים שלי מצורפים.\n\nבברכה,\n${name}`;
  }
  return `Hello,\n\nI'd like to apply for the ${job.title} position${job.company ? ` at ${job.company}` : ""}. My CV is attached.\n\nBest regards,\n${name}`;
}

/**
 * The variant's own CV, untouched: its items in master order with their original bullets.
 *
 * @throws Error if the variant does not exist.
 */
export function untailored(master: MasterCv, variantId: string, coverMessage: string): TailoredCv {
  const variant = master.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`variant ${variantId} does not exist`);
  return {
    variant: variant.id,
    headline: variant.headline,
    summary: variant.summary,
    items: master.items
      .filter((i) => i.variants.includes(variant.id))
      .map((i) => ({ id: i.id, bullets: [...i.bullets] })),
    coverMessage,
  };
}

export const TAILOR_SYSTEM = `You tailor a candidate's CV to one job.
${DATA_NOT_INSTRUCTIONS}

You get the master CV (items with ids, grouped by section) and a job post. Produce a one-to-two page CV:
- Start from the given variant; you may add relevant items from other variants and drop irrelevant ones.
- items: the ids to include, ordered by relevance within each section, each with its bullets.
- You may reorder, select, shorten and reword bullets to stress what the job asks for.
- Never add facts: no new numbers, employers, titles, degrees, dates, tools or skills that are not in the
  master CV item you are rewording. Keep every number exactly as in the source bullet. Never use more
  bullets for an item than the master CV has for it.
- headline and summary: pick or reword the variant's headline and summary, using only facts from the CV.
- coverMessage: 3-5 sentences in the same language as the job post (Hebrew post → Hebrew), addressed to the
  recruiter, saying which role you apply for and the two or three most relevant points from the CV.
  No placeholders, no invented facts. Sign with the candidate's name.`;

export interface TailorResult {
  tailored: TailoredCv;
  /** Validation errors of the last model attempt (empty when it passed). */
  errors: string[];
  /** `true` when the untouched variant was used because the model output kept failing. */
  fallback: boolean;
}

/**
 * Tailor the master CV to a job and validate the result. One retry is made with the
 * validator's errors; if it still fails, the untouched variant and a template cover message
 * are returned, so a card can always be shown.
 *
 * Example:
 *   await tailorCv(llm, "claude-opus-5-5", master, job, "backend-engineer-python")
 *   // → { tailored: { variant: "backend-engineer-python", items: [...], coverMessage: "..." },
 *   //     errors: [], fallback: false }
 *
 * @throws Error if `variantId` does not exist; LlmError from the client.
 */
export async function tailorCv(
  llm: Llm,
  model: string,
  master: MasterCv,
  job: JobPost,
  variantId: string,
): Promise<TailorResult> {
  if (!master.variants.some((v) => v.id === variantId)) {
    throw new Error(`variant ${variantId} does not exist`);
  }
  const base = [
    `Start from variant: ${variantId}`,
    `Candidate name: ${master.name}`,
    `Master CV:\n${quoteData("cv", cvForPrompt(master))}`,
    `Job:\n${quoteData("job", JSON.stringify(job, null, 2))}`,
  ].join("\n\n");

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nYour previous answer added facts that are not in the CV. Fix these and answer again:\n${errors
            .map((e) => `- ${e}`)
            .join("\n")}`;
    const tailored = await llm.json({
      model,
      system: TAILOR_SYSTEM,
      prompt,
      schema: TailoredCvSchema,
    });
    const result = validateTailored(master, tailored, job);
    if (result.ok) return { tailored, errors: [], fallback: false };
    errors = result.errors;
  }
  return {
    tailored: untailored(master, variantId, fallbackCover(job, master.name)),
    errors,
    fallback: true,
  };
}
