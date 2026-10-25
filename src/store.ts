import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A group message as the WhatsApp listener hands it over. */
export interface NewMessage {
  /** WhatsApp message id; the same id is only stored once. */
  waId: string;
  groupId: string;
  groupName: string;
  sender: string;
  text: string;
  /** Epoch milliseconds. */
  ts: number;
}

export interface StoredMessage extends NewMessage {
  id: number;
  processed: boolean;
}

export const JOB_STATUSES = [
  "new", // extracted, not yet judged
  "duplicate", // same job already seen
  "filtered", // failed a hard filter
  "low_score", // passed filters, model score under the profile minimum
  "ready", // approval card sent, waiting for the owner
  "applying", // owner pressed Apply, queued for sending
  "applied",
  "manual", // link/form post, the owner applies by hand
  "skipped",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface NewJob {
  fingerprint: string;
  messageId: number | null;
  groupName: string;
  /** The extracted job post; stored as JSON, validated by the caller on read. */
  post: unknown;
}

export interface JobRecord extends NewJob {
  id: number;
  status: JobStatus;
  score: number | null;
  reasons: string[];
  /** Tailored CV, cover message and anything else the approval card needs (JSON). */
  draft: unknown;
  createdAt: number;
  updatedAt: number;
}

export type DecisionAction = "apply" | "skip" | "edit";

export interface Decision {
  jobId: number;
  action: DecisionAction;
  reason: string | null;
  ts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages (processed, ts);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  message_id INTEGER,
  group_name TEXT NOT NULL,
  post TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  score INTEGER,
  reasons TEXT NOT NULL DEFAULT '[]',
  draft TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs (fingerprint);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  action TEXT NOT NULL,
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function toMessage(r: Row): StoredMessage {
  return {
    id: Number(r.id),
    waId: String(r.wa_id),
    groupId: String(r.group_id),
    groupName: String(r.group_name),
    sender: String(r.sender),
    text: String(r.text),
    ts: Number(r.ts),
    processed: Number(r.processed) === 1,
  };
}

function toJob(r: Row): JobRecord {
  return {
    id: Number(r.id),
    fingerprint: String(r.fingerprint),
    messageId: r.message_id === null ? null : Number(r.message_id),
    groupName: String(r.group_name),
    post: JSON.parse(String(r.post)),
    status: String(r.status) as JobStatus,
    score: r.score === null ? null : Number(r.score),
    reasons: JSON.parse(String(r.reasons)) as string[],
    draft: r.draft === null ? null : JSON.parse(String(r.draft)),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * The SQLite store: group messages, extracted jobs, the owner's decisions and a small
 * key-value table for settings and runtime state (allow-listed groups, pause flag, heartbeats).
 *
 * Example:
 *   const store = openStore(":memory:");
 *   store.insertMessage({ waId: "A1", groupId: "g@g.us", groupName: "Jobs", sender: "x",
 *                         text: "Hiring a backend dev", ts: Date.now() });   // → true
 *   store.pendingMessages(10).length;                                          // → 1
 */
export class Store {
  constructor(readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Store a group message once.
   *
   * @returns `true` if it was new, `false` if a message with the same `waId` already exists.
   * @throws Error if `text` is empty after trimming.
   */
  insertMessage(m: NewMessage): boolean {
    if (m.text.trim() === "") throw new Error("message text is empty");
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (wa_id, group_id, group_name, sender, text, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(m.waId, m.groupId, m.groupName, m.sender, m.text, m.ts);
    return Number(res.changes) === 1;
  }

  /** Unprocessed messages, oldest first, at most `limit`. */
  pendingMessages(limit: number): StoredMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE processed = 0 ORDER BY ts, id LIMIT ?")
      .all(Math.max(0, Math.floor(limit)))
      .map(toMessage);
  }

  getMessage(id: number): StoredMessage | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return r ? toMessage(r) : undefined;
  }

  markProcessed(ids: readonly number[]): void {
    const stmt = this.db.prepare("UPDATE messages SET processed = 1 WHERE id = ?");
    this.transaction(() => ids.forEach((id) => stmt.run(id)));
  }

  /** Timestamp of the newest stored message, or `null` if there are none. */
  lastMessageAt(): number | null {
    const r = this.db.prepare("SELECT MAX(ts) AS ts FROM messages").get();
    return r?.ts == null ? null : Number(r.ts);
  }

  /**
   * Delete messages older than `maxAgeMs` (raw group text is not kept beyond 14 days).
   *
   * @returns The number of deleted messages.
   */
  purgeOldMessages(maxAgeMs: number, now = Date.now()): number {
    // Jobs keep their extracted post; only the link to the raw message is dropped.
    const cutoff = now - maxAgeMs;
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE jobs SET message_id = NULL WHERE message_id IN (SELECT id FROM messages WHERE ts < ?)",
        )
        .run(cutoff);
      return Number(this.db.prepare("DELETE FROM messages WHERE ts < ?").run(cutoff).changes);
    });
  }

  /** Insert a new job with status `new`. Returns its id. */
  insertJob(job: NewJob, now = Date.now()): number {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (fingerprint, message_id, group_name, post, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(job.fingerprint, job.messageId, job.groupName, JSON.stringify(job.post), now, now);
    return Number(res.lastInsertRowid);
  }

  getJob(id: number): JobRecord | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return r ? toJob(r) : undefined;
  }

  /** Jobs created at or after `since`, newest first (used for dedupe and the digest). */
  jobsSince(since: number): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE created_at >= ? ORDER BY created_at DESC, id DESC")
      .all(since)
      .map(toJob);
  }

  jobsByStatus(status: JobStatus): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at, id")
      .all(status)
      .map(toJob);
  }

  /**
   * Update a job's status and, optionally, its score, reasons or draft.
   *
   * @throws Error if the job does not exist or the status is unknown.
   */
  updateJob(
    id: number,
    patch: { status?: JobStatus; score?: number; reasons?: string[]; draft?: unknown },
    now = Date.now(),
  ): JobRecord {
    const current = this.getJob(id);
    if (!current) throw new Error(`job ${id} not found`);
    if (patch.status && !JOB_STATUSES.includes(patch.status)) {
      throw new Error(`unknown job status: ${patch.status}`);
    }
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, score = ?, reasons = ?, draft = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.status ?? current.status,
        patch.score ?? current.score,
        JSON.stringify(patch.reasons ?? current.reasons),
        "draft" in patch ? JSON.stringify(patch.draft ?? null) : JSON.stringify(current.draft),
        now,
        id,
      );
    return this.getJob(id)!;
  }

  /**
   * Record what the owner did with a job.
   *
   * @throws Error if the job does not exist.
   */
  recordDecision(jobId: number, action: DecisionAction, reason?: string, now = Date.now()): void {
    if (!this.getJob(jobId)) throw new Error(`job ${jobId} not found`);
    this.db
      .prepare("INSERT INTO decisions (job_id, action, reason, ts) VALUES (?, ?, ?, ?)")
      .run(jobId, action, reason?.trim() || null, now);
  }

  /** The most recent decisions, newest first. */
  recentDecisions(limit: number, action?: DecisionAction): Decision[] {
    const rows = action
      ? this.db
          .prepare("SELECT * FROM decisions WHERE action = ? ORDER BY ts DESC, id DESC LIMIT ?")
          .all(action, limit)
      : this.db.prepare("SELECT * FROM decisions ORDER BY ts DESC, id DESC LIMIT ?").all(limit);
    return rows.map((r) => ({
      jobId: Number(r.job_id),
      action: String(r.action) as DecisionAction,
      reason: r.reason === null ? null : String(r.reason),
      ts: Number(r.ts),
    }));
  }

  /** Whether the owner recorded `action` for this job (e.g. pressed Apply). */
  hasDecision(jobId: number, action: DecisionAction): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM decisions WHERE job_id = ? AND action = ? LIMIT 1")
        .get(jobId, action) !== undefined
    );
  }

  /** Count of jobs per status created at or after `since`. */
  statusCounts(since: number): Partial<Record<JobStatus, number>> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY status")
      .all(since);
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  }

  /** Read a JSON value from the key-value table, or `fallback` if missing. */
  getKv<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return r ? (JSON.parse(String(r.value)) as T) : fallback;
  }

  setKv(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  /** Run `fn` inside a transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

/**
 * Open (and create if needed) the SQLite store.
 *
 * @param file Path to the database file, or `":memory:"` for tests.
 */
export function openStore(file: string): Store {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  return new Store(new DatabaseSync(file));
}
