import path from "node:path";
import { ApplyQueue, buildApplication, type Mailer } from "./apply/email.js";
import { type Env, loadProfile, profileToYaml, saveProfile } from "./config.js";
import {
  cvSummary,
  loadMaster,
  type MasterCv,
  mergeCv,
  parseCv,
  pdfText,
  saveMaster,
  sourceWarnings,
} from "./cv/master.js";
import { cvFileName, renderPdf } from "./cv/render.js";
import { checkHealth, throttleAlerts } from "./health.js";
import type { Llm } from "./llm.js";
import { DraftSchema, type RunReport, runPipeline, storedPost, toCard } from "./pipeline/run.js";
import { isDigestDue, Lock } from "./scheduler.js";
import type { JobRecord, JobStatus, Store } from "./store.js";
import type { BotHandlers } from "./telegram/bot.js";
import type { CardInput } from "./telegram/cards.js";
import { T } from "./telegram/texts.js";
import { KV } from "./whatsapp/listener.js";

export interface AppDeps {
  env: Env;
  store: Store;
  llm: Llm;
  notify: (text: string) => Promise<void>;
  sendCard: (card: CardInput, pdf: { name: string; data: Buffer }) => Promise<void>;
  /** `null` when SMTP is not configured. */
  mailer: Mailer | null;
  waConnected: () => boolean;
  now?: () => number;
  /** Gap between two applications (human pace). */
  sendGapMs?: { min: number; max: number };
  sleep?: (ms: number) => Promise<void>;
  digestHour?: number;
  timeZone?: string;
}

export interface App {
  handlers: BotHandlers;
  /** One pipeline run, or `null` if one is already running. */
  runOnce(): Promise<RunReport | null>;
  /** Housekeeping: daily digest, health alerts, purge of old messages. */
  tick(): Promise<void>;
  isPaused(): boolean;
  queue: ApplyQueue;
}

const DAY = 24 * 60 * 60 * 1000;
const MESSAGE_RETENTION_MS = 14 * DAY;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Hebrew "N label" lines for job counts. */
export function formatCounts(counts: Partial<Record<JobStatus, number>>): string {
  const lines = Object.entries(counts)
    .filter(([, n]) => n && n > 0)
    .map(([status, n]) => `${T.statusLabels[status] ?? status}: ${n}`);
  return lines.length ? lines.join("\n") : T.noActivity;
}

/**
 * The application: bot handlers, pipeline runs, sending and housekeeping, with every outside
 * service injected so it can be tested end to end with fakes.
 *
 * Example:
 *   const app = createApp({ env, store, llm, notify, sendCard, mailer, waConnected });
 *   await app.runOnce();                       // cards go to Telegram
 *   await app.handlers.apply(12);               // owner pressed Apply → queued
 */
export function createApp(d: AppDeps): App {
  const now = d.now ?? Date.now;
  const dataDir = d.env.DATA_DIR;
  const startedAt = now();
  const lock = new Lock();
  let pendingCv: { master: MasterCv; warnings: string[] } | null = null;
  const alertsSent: Record<string, number> = {};

  const ago = (ts: number | null) =>
    ts === null ? T.never : T.ago(Math.max(0, Math.round((now() - ts) / 60_000)));

  const pdfFor = async (job: JobRecord, master: MasterCv) => {
    const draft = DraftSchema.parse(job.draft);
    return { name: cvFileName(master.name), data: await renderPdf(master, draft.tailored) };
  };

  const sendCardFor = async (job: JobRecord) => {
    const master = loadMaster(dataDir);
    const card = toCard(job, master);
    if (!card || !master) throw new Error(`job ${job.id} has no card`);
    await d.sendCard(card, await pdfFor(job, master));
  };

  /** Send one approved application. Only a job the owner pressed Apply on is ever sent. */
  const sendApplication = async (jobId: number) => {
    const job = d.store.getJob(jobId);
    if (!job || job.status !== "applying" || !d.store.hasDecision(jobId, "apply")) return;
    try {
      const post = storedPost(job);
      const master = loadMaster(dataDir);
      if (!post || !master) throw new Error("job or CV missing");
      if (!d.mailer || !d.env.SMTP_USER) throw new Error(T.applyNoSmtp);
      const draft = DraftSchema.parse(job.draft);
      const pdf = await pdfFor(job, master);
      const mail = buildApplication(
        post,
        { name: master.name, address: d.env.SMTP_USER },
        draft.tailored.coverMessage,
        pdf.data,
        pdf.name,
      );
      await d.mailer.sendMail(mail);
      d.store.updateJob(jobId, { status: "applied" }, now());
      await d.notify(`${post.title}: ${T.applySent(mail.to)}`);
    } catch (e) {
      d.store.updateJob(jobId, { status: "failed", reasons: [(e as Error).message] }, now());
      await d.notify(T.applyFailed((e as Error).message));
    }
  };

  const queue = new ApplyQueue({
    send: sendApplication,
    minGapMs: d.sendGapMs?.min ?? 3 * 60_000,
    maxGapMs: d.sendGapMs?.max ?? 8 * 60_000,
    sleep: d.sleep,
    now,
  });
  // Applications approved before a restart are still waiting.
  for (const job of d.store.jobsByStatus("applying")) queue.push(job.id);

  const runOnce = async (): Promise<RunReport | null> => {
    const run = lock.tryRun(async () => {
      const master = loadMaster(dataDir);
      const report = await runPipeline({
        store: d.store,
        llm: d.llm,
        models: { extract: d.env.MODEL_EXTRACT, tailor: d.env.MODEL_TAILOR },
        profile: loadProfile(dataDir),
        master,
        sendCard: sendCardFor,
        now,
      });
      d.store.setKv("last_run", { at: now(), errors: report.errors });
      if (report.ready > 0 || report.errors.length) {
        await d.notify(T.runSummary(report.jobs, report.ready));
      }
      for (const err of report.errors.slice(0, 3)) await d.notify(T.alertRunFailed(err));
      if (!master && report.waiting > 0) await d.notify(T.noCvWarning);
      return report;
    });
    return run ?? null;
  };

  const readyJob = (jobId: number) => {
    const job = d.store.getJob(jobId);
    return job && job.status === "ready" ? job : null;
  };

  const handlers: BotHandlers = {
    status() {
      const lastRun = d.store.getKv<{ at: number } | null>("last_run", null);
      return T.status({
        paused: d.store.getKv("paused", false),
        waConnected: d.waConnected(),
        lastMessageAgo: ago(d.store.lastMessageAt()),
        lastRunAgo: ago(lastRun?.at ?? null),
        groups: d.store.getKv<string[]>(KV.allowedGroups, []).length,
        hasCv: loadMaster(dataDir) !== null,
        today: formatCounts(d.store.statusCounts(now() - DAY)).replace(/\n/g, ", "),
      });
    },
    scan() {
      if (lock.running) return false;
      void runOnce().catch((e) => d.notify(T.alertRunFailed((e as Error).message)));
      return true;
    },
    setPaused: (paused) => d.store.setKv("paused", paused),
    profileYaml: () => profileToYaml(loadProfile(dataDir)),
    saveProfile: (yaml) => void saveProfile(dataDir, yaml),
    groups() {
      const names = d.store.getKv<Record<string, string>>(KV.groupNames, {});
      const allowed = new Set(d.store.getKv<string[]>(KV.allowedGroups, []));
      const ids = new Set([...Object.keys(names), ...allowed]);
      return [...ids]
        .map((id) => ({ id, name: names[id] ?? id, allowed: allowed.has(id) }))
        .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name));
    },
    toggleGroup(id) {
      const allowed = new Set(d.store.getKv<string[]>(KV.allowedGroups, []));
      if (allowed.has(id)) allowed.delete(id);
      else allowed.add(id);
      d.store.setKv(KV.allowedGroups, [...allowed]);
    },
    async parseCv(file) {
      const parsed = await parseCv(d.llm, d.env.MODEL_TAILOR, file.data);
      const warnings = sourceWarnings(parsed, await pdfText(file.data));
      const base = pendingCv?.master ?? loadMaster(dataDir);
      pendingCv = {
        master: mergeCv(base, parsed),
        warnings: [...(pendingCv?.warnings ?? []), ...warnings],
      };
      return cvSummary(pendingCv.master, pendingCv.warnings);
    },
    saveCv() {
      if (!pendingCv) return false;
      saveMaster(dataDir, pendingCv.master);
      pendingCv = null;
      return true;
    },
    discardCv() {
      const had = pendingCv !== null;
      pendingCv = null;
      return had;
    },
    async apply(jobId) {
      const job = readyJob(jobId);
      if (!job) return T.applyNotReady;
      const post = storedPost(job);
      if (post?.apply.kind !== "email" || !post.apply.target) return T.applyNoEmail;
      if (!d.mailer) return T.applyNoSmtp;
      d.store.recordDecision(jobId, "apply", undefined, now());
      d.store.updateJob(jobId, { status: "applying" }, now());
      queue.push(jobId);
      return T.applyQueued;
    },
    async markManual(jobId) {
      if (!readyJob(jobId)) return T.applyNotReady;
      d.store.recordDecision(jobId, "apply", "manual", now());
      d.store.updateJob(jobId, { status: "manual" }, now());
      return T.markedManual;
    },
    async skip(jobId, reason) {
      if (!readyJob(jobId)) return T.applyNotReady;
      d.store.recordDecision(jobId, "skip", reason ?? undefined, now());
      d.store.updateJob(jobId, { status: "skipped" }, now());
      return T.skipped;
    },
    async setCoverMessage(jobId, text) {
      const job = readyJob(jobId);
      if (!job) return null;
      const draft = DraftSchema.parse(job.draft);
      const updated = d.store.updateJob(
        jobId,
        { draft: { ...draft, tailored: { ...draft.tailored, coverMessage: text } } },
        now(),
      );
      d.store.recordDecision(jobId, "edit", undefined, now());
      return toCard(updated, loadMaster(dataDir));
    },
  };

  const tick = async () => {
    d.store.purgeOldMessages(MESSAGE_RETENTION_MS, now());

    const lastDigest = d.store.getKv<number | null>("last_digest", null);
    if (isDigestDue(now(), lastDigest, d.digestHour ?? 20, d.timeZone ?? "Asia/Jerusalem")) {
      d.store.setKv("last_digest", now());
      await d.notify(T.digest(formatCounts(d.store.statusCounts(now() - DAY))));
    }

    const alerts = checkHealth({
      now: now(),
      lastMessageAt: d.store.lastMessageAt(),
      startedAt,
      waConnected: d.waConnected(),
      waDisconnectedSince: d.store.getKv<number | null>(KV.disconnectedSince, null),
      allowedGroups: d.store.getKv<string[]>(KV.allowedGroups, []).length,
    });
    for (const a of throttleAlerts(alerts, alertsSent, now(), ALERT_COOLDOWN_MS)) {
      await d.notify(T.healthAlert(a.text));
    }
  };

  return {
    handlers,
    runOnce,
    tick,
    isPaused: () => d.store.getKv("paused", false),
    queue,
  };
}

/** Database file inside the data directory. */
export function dbPath(dataDir: string): string {
  return path.join(dataDir, "job-finder.sqlite");
}
