import { T } from "./texts.js";

/** A framework-neutral inline button; `bot.ts` turns these into grammy keyboards. */
export interface Button {
  text: string;
  data: string;
}
export type Buttons = Button[][];

export type ApplyKind = "email" | "link" | "phone" | "unknown";

/** Everything the approval card shows. Built by `main.ts` from a stored job. */
export interface CardInput {
  jobId: number;
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  score: number;
  reasons: string[];
  concerns: string[];
  coverMessage: string;
  apply: { kind: ApplyKind; target: string | null };
  cvVariant: string | null;
  group: string;
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_MESSAGE = 4096;

/**
 * Render the approval card text (HTML parse mode).
 *
 * Example:
 *   renderCard({ jobId: 7, title: "Backend Engineer", company: "Acme", score: 82, ... })
 *   // → "<b>Backend Engineer</b> · Acme\n📍 Tel Aviv · 💰 25-30k\nציון התאמה: 82/100\n..."
 *
 * Long cover messages are trimmed so the card fits Telegram's 4096-character limit.
 *
 * @param c Card content; all strings are escaped here.
 * @returns The card text.
 */
export function renderCard(c: CardInput): string {
  const head = `<b>${escapeHtml(c.title)}</b>${c.company ? ` · ${escapeHtml(c.company)}` : ""}`;
  const meta = [
    c.location ? `📍 ${escapeHtml(c.location)}` : null,
    `💰 ${escapeHtml(c.salary ?? T.cardSalaryUnknown)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [head, meta, T.cardScore(c.score)];
  if (c.reasons.length) lines.push("", T.cardWhy, ...c.reasons.map((r) => `• ${escapeHtml(r)}`));
  if (c.concerns.length) {
    lines.push("", T.cardConcerns, ...c.concerns.map((r) => `• ${escapeHtml(r)}`));
  }
  const target = c.apply.target ? escapeHtml(c.apply.target) : "";
  const applyLine =
    c.apply.kind === "email" && target
      ? T.cardApplyEmail(target)
      : c.apply.kind === "link" && target
        ? T.cardApplyLink(target)
        : c.apply.kind === "phone" && target
          ? T.cardApplyPhone(target)
          : T.cardApplyUnknown;
  const tail = ["", applyLine];
  if (c.cvVariant) tail.push(T.cardCvVariant(escapeHtml(c.cvVariant)));
  tail.push(T.cardSource(escapeHtml(c.group)));

  const fixed = [...lines, "", T.cardMessage, "", ...tail].join("\n").length;
  let cover = escapeHtml(c.coverMessage);
  const room = MAX_MESSAGE - fixed - "<i></i>".length - 1;
  if (cover.length > room)
    cover = cover.slice(0, Math.max(0, room - 1)).replace(/&[a-z]*$/, "") + "…";
  return [...lines, "", T.cardMessage, `<i>${cover}</i>`, ...tail].join("\n");
}

/**
 * Buttons under the card: Apply/Edit/Skip when the job can be applied to by email,
 * otherwise "I applied myself"/Skip.
 */
export function cardButtons(c: Pick<CardInput, "jobId" | "apply">): Buttons {
  if (c.apply.kind === "email" && c.apply.target) {
    return [
      [
        { text: T.btnApply, data: encodeAction({ type: "apply", jobId: c.jobId }) },
        { text: T.btnEdit, data: encodeAction({ type: "edit", jobId: c.jobId }) },
        { text: T.btnSkip, data: encodeAction({ type: "skip", jobId: c.jobId }) },
      ],
    ];
  }
  return [
    [
      { text: T.btnAppliedManually, data: encodeAction({ type: "manual", jobId: c.jobId }) },
      { text: T.btnSkip, data: encodeAction({ type: "skip", jobId: c.jobId }) },
    ],
  ];
}

export const SKIP_REASONS = Object.keys(T.skipReasons) as (keyof typeof T.skipReasons)[];
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Reason buttons shown after Skip, two per row. */
export function skipReasonButtons(jobId: number): Buttons {
  const buttons = SKIP_REASONS.map((reason) => ({
    text: T.skipReasons[reason],
    data: encodeAction({ type: "skipReason", jobId, reason }),
  }));
  const rows: Buttons = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export type Action =
  | { type: "apply" | "edit" | "skip" | "manual"; jobId: number }
  | { type: "skipReason"; jobId: number; reason: SkipReason }
  | { type: "cvSave" | "cvDiscard" }
  | { type: "group"; groupId: string };

const CODES = { apply: "a", edit: "e", skip: "s", manual: "m" } as const;

/**
 * Encode a button action as callback data (Telegram allows at most 64 bytes).
 *
 * Example: encodeAction({ type: "apply", jobId: 12 }) → "a:12"
 *
 * @throws Error if the encoded data is longer than 64 bytes.
 */
export function encodeAction(a: Action): string {
  let out: string;
  switch (a.type) {
    case "skipReason":
      out = `r:${a.jobId}:${a.reason}`;
      break;
    case "cvSave":
      out = "cv:save";
      break;
    case "cvDiscard":
      out = "cv:discard";
      break;
    case "group":
      out = `g:${a.groupId}`;
      break;
    default:
      out = `${CODES[a.type]}:${a.jobId}`;
  }
  if (Buffer.byteLength(out) > 64) throw new Error("callback data longer than 64 bytes");
  return out;
}

/**
 * Decode callback data produced by `encodeAction`.
 *
 * Example: decodeAction("r:12:salary") → { type: "skipReason", jobId: 12, reason: "salary" }
 *
 * @returns The action, or `null` for anything malformed (stale or forged buttons).
 */
export function decodeAction(data: string): Action | null {
  if (data === "cv:save") return { type: "cvSave" };
  if (data === "cv:discard") return { type: "cvDiscard" };
  if (data.startsWith("g:") && data.length > 2) return { type: "group", groupId: data.slice(2) };
  const parts = data.split(":");
  const jobId = Number(parts[1]);
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || parts[1] !== String(jobId)) return null;
  if (parts[0] === "r" && parts.length === 3) {
    const reason = parts[2] as SkipReason;
    return SKIP_REASONS.includes(reason) ? { type: "skipReason", jobId, reason } : null;
  }
  if (parts.length !== 2) return null;
  const type = (Object.keys(CODES) as (keyof typeof CODES)[]).find((k) => CODES[k] === parts[0]);
  return type ? { type, jobId } : null;
}
