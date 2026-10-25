import nodemailer from "nodemailer";
import type { Env } from "../config.js";
import type { JobPost } from "../pipeline/extract.js";

export interface Mail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
}

/** The part of a nodemailer transport we use; tests pass a fake. */
export interface Mailer {
  sendMail(mail: Mail): Promise<unknown>;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Build the application email: the cover message as the body and the tailored CV attached.
 * The subject follows the post's language.
 *
 * Example:
 *   buildApplication(job, { name: "Dana", address: "dana@example.com" }, "Hello...", pdf, "Dana_CV.pdf")
 *   // → { to: "jobs@example.com", subject: "Application: Backend Engineer – Example Labs", ... }
 *
 * @throws Error if the job has no valid email apply target or the cover message is empty.
 */
export function buildApplication(
  job: JobPost,
  from: { name: string; address: string },
  coverMessage: string,
  pdf: Buffer,
  fileName: string,
): Mail {
  const to = job.apply.target?.trim() ?? "";
  if (job.apply.kind !== "email" || !EMAIL.test(to)) throw new Error("job has no email address");
  if (!coverMessage.trim()) throw new Error("cover message is empty");
  const subject =
    job.language === "he"
      ? `מועמדות למשרת ${job.title}${job.company ? ` – ${job.company}` : ""}`
      : `Application: ${job.title}${job.company ? ` – ${job.company}` : ""}`;
  return {
    from,
    to,
    subject: subject.replace(/\s+/g, " ").trim(),
    text: coverMessage.trim(),
    attachments: [{ filename: fileName, content: pdf, contentType: "application/pdf" }],
  };
}

/** SMTP transport from the environment (Gmail with an app password by default). */
export function createMailer(env: Env): Mailer {
  if (!env.SMTP_USER || !env.SMTP_APP_PASSWORD) throw new Error("SMTP credentials are not set");
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_APP_PASSWORD },
  });
}

export interface ApplyQueueOptions {
  /** Sends one application; errors are the callback's to report. */
  send: (jobId: number) => Promise<void>;
  /** Gap between two sends, picked uniformly in [minGapMs, maxGapMs] (human pace). */
  minGapMs: number;
  maxGapMs: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Sequential send queue with a randomised gap between sends, so applications never go out in
 * a burst. A job id queued twice is sent once.
 *
 * Example:
 *   const q = new ApplyQueue({ send, minGapMs: 180_000, maxGapMs: 480_000 });
 *   q.push(12); q.push(13);   // 12 now, 13 three to eight minutes later
 */
export class ApplyQueue {
  private readonly queue: number[] = [];
  private running: Promise<void> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: ApplyQueueOptions) {
    if (opts.minGapMs < 0 || opts.maxGapMs < opts.minGapMs) throw new Error("invalid gap range");
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Queue a job; returns its position (0 = next). */
  push(jobId: number): number {
    const existing = this.queue.indexOf(jobId);
    if (existing !== -1) return existing;
    this.queue.push(jobId);
    this.running ??= this.drain().finally(() => (this.running = null));
    return this.queue.length - 1;
  }

  get size(): number {
    return this.queue.length;
  }

  /** Resolves when the queue is empty. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const gap = this.opts.minGapMs + this.random() * (this.opts.maxGapMs - this.opts.minGapMs);
      const wait = this.lastSentAt + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      const jobId = this.queue[0]!;
      try {
        await this.opts.send(jobId);
      } catch {
        // `send` reports its own failures; the queue keeps going.
      }
      this.lastSentAt = this.now();
      this.queue.shift();
    }
  }
}
