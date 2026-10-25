import type { JobPost } from "./extract.js";

/** Lowercase, keep letters (any script) and digits, collapse whitespace. */
export function normalize(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

/** Jaccard similarity of two token sets; 0 when both are empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

/**
 * A stable key for a job: company, title and apply target, normalised.
 *
 * Example:
 *   fingerprint({ company: "Example Labs", title: "Backend Engineer!",
 *                 apply: { kind: "email", target: "Jobs@Example.com" }, ... })
 *   // → "example labs|backend engineer|jobs example com"
 */
export function fingerprint(job: JobPost): string {
  return [normalize(job.company), normalize(job.title), normalize(job.apply.target)].join("|");
}

/**
 * Find whether `job` is the same job as one already seen (posts are reposted across groups, often
 * with small edits).
 *
 * Same job when any of these hold against a recent job:
 * - identical fingerprint;
 * - same apply target (email or link) and similar titles (Jaccard ≥ 0.5);
 * - same known company and near-identical titles (Jaccard ≥ 0.8);
 * - near-identical content overall (title, company, skills, requirements; Jaccard ≥ 0.85).
 *
 * Example:
 *   findDuplicate(jobPost({ title: "Senior Backend Engineer" }), [jobPost({ title: "Backend Engineer" })])
 *   // → 0 (same email, similar title)
 *
 * @param job The newly extracted job.
 * @param recent Jobs seen recently (e.g. the last 30 days).
 * @returns The duplicate's index in `recent`, or -1.
 */
export function findDuplicate(job: JobPost, recent: readonly JobPost[]): number {
  const fp = fingerprint(job);
  const title = tokens(job.title);
  const target = normalize(job.apply.target);
  const company = normalize(job.company);
  const content = tokens(
    [job.title, job.company, ...job.skills, ...job.requirements].filter(Boolean).join(" "),
  );

  return recent.findIndex((r) => {
    if (fingerprint(r) === fp) return true;
    const titleSim = jaccard(title, tokens(r.title));
    if (target && target === normalize(r.apply.target) && titleSim >= 0.5) return true;
    if (company && company === normalize(r.company) && titleSim >= 0.8) return true;
    const other = tokens(
      [r.title, r.company, ...r.skills, ...r.requirements].filter(Boolean).join(" "),
    );
    return jaccard(content, other) >= 0.85;
  });
}
