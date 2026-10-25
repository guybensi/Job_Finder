import { Bot, InlineKeyboard, InputFile } from "grammy";
import {
  type Buttons,
  type CardInput,
  cardButtons,
  decodeAction,
  encodeAction,
  escapeHtml,
  renderCard,
  skipReasonButtons,
} from "./cards.js";
import { T } from "./texts.js";

/** What the bot needs from the rest of the app. Implemented in `main.ts`. */
export interface BotHandlers {
  status(): Promise<string> | string;
  /** Start a pipeline run in the background. `false` if one is already running. */
  scan(): boolean;
  setPaused(paused: boolean): void;
  profileYaml(): string;
  /** Validate and save; throws with a readable message when invalid. */
  saveProfile(yaml: string): void;
  /** Groups the account is in, fetched fresh from WhatsApp when possible. */
  groups(): Promise<{ id: string; name: string; allowed: boolean }[]>;
  toggleGroup(id: string): void;
  /** Parse an uploaded CV into a pending master CV; returns a short summary to confirm. */
  parseCv(file: { name: string; data: Buffer }): Promise<string>;
  /** Save the pending master CV. `false` if nothing is pending. */
  saveCv(): boolean;
  discardCv(): boolean;
  /** The owner pressed Apply. Returns the reply text. */
  apply(jobId: number): Promise<string>;
  markManual(jobId: number): Promise<string>;
  skip(jobId: number, reason: string | null): Promise<string>;
  /** Replace the cover message; returns the updated card or `null` if the job is gone. */
  setCoverMessage(jobId: number, text: string): Promise<CardInput | null>;
}

export interface Reply {
  text: string;
  buttons?: Buttons;
  html?: boolean;
}

export interface CallbackResult {
  /** Short toast shown on the pressed button. */
  toast?: string;
  replies: Reply[];
  /** Remove the buttons from the message that was pressed (it has been handled). */
  removeButtons?: boolean;
}

export const MAX_CV_BYTES = 10 * 1024 * 1024;
export const GROUPS_PER_PAGE = 20;

/** Card message as a reply: rendered text plus its buttons. */
export function cardReply(card: CardInput): Reply {
  return { text: renderCard(card), buttons: cardButtons(card), html: true };
}

/**
 * The bot's conversation logic, free of Telegram I/O so it can be tested directly.
 *
 * It keeps two bits of state: a job waiting for a new cover message (after Edit) and a job
 * waiting for a free-text skip reason (after Skip → Other). Any command cancels both.
 *
 * Example:
 *   const core = new BotCore(handlers);
 *   await core.handleText("/pause");          // → [{ text: "הסריקות הושהו..." }]
 *   await core.handleCallback("a:12");        // → { toast: "...", replies: [...] }
 */
export class BotCore {
  private pendingEdit: number | null = null;
  private pendingSkip: number | null = null;
  /** Name filter of the last /groups command, kept while paging and toggling. */
  private groupFilter = "";

  constructor(private readonly h: BotHandlers) {}

  /** Handle a text message (command or free text) from the owner. */
  async handleText(text: string): Promise<Reply[]> {
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      this.pendingEdit = this.pendingSkip = null;
      return this.command(trimmed);
    }
    if (this.pendingEdit !== null) {
      const jobId = this.pendingEdit;
      if (!trimmed) return [{ text: T.editAsk }];
      this.pendingEdit = null;
      const card = await this.h.setCoverMessage(jobId, trimmed);
      return card ? [{ text: T.editSaved }, cardReply(card)] : [{ text: T.jobNotFound }];
    }
    if (this.pendingSkip !== null) {
      const jobId = this.pendingSkip;
      this.pendingSkip = null;
      return [{ text: await this.h.skip(jobId, trimmed || null) }];
    }
    return [{ text: T.help }];
  }

  private async command(text: string): Promise<Reply[]> {
    const [head = "", ...rest] = text.split("\n");
    const cmd = (head.split(/\s+/)[0] ?? "").replace(/@.*$/, "").toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        return [{ text: T.help }];
      case "/status":
        return [{ text: await this.h.status() }];
      case "/scan":
        return [{ text: this.h.scan() ? T.scanStarted : T.scanBusy }];
      case "/pause":
        this.h.setPaused(true);
        return [{ text: T.paused }];
      case "/resume":
        this.h.setPaused(false);
        return [{ text: T.resumed }];
      case "/profile":
        return [
          {
            text: `${T.profileTitle}\n<pre>${escapeHtml(this.h.profileYaml())}</pre>`,
            html: true,
          },
          { text: T.setProfileUsage },
        ];
      case "/setprofile": {
        const yaml = rest.join("\n");
        if (!yaml.trim()) return [{ text: T.setProfileUsage }];
        try {
          this.h.saveProfile(yaml);
          return [{ text: T.profileSaved }];
        } catch (e) {
          return [{ text: T.profileInvalid((e as Error).message) }];
        }
      }
      case "/groups":
        this.groupFilter = head.trim().split(/\s+/).slice(1).join(" ");
        return [await this.groupsReply(0)];
      case "/cv":
        return [{ text: T.cvAsk }];
      default:
        return [{ text: T.unknownCommand }];
    }
  }

  /** One page of the group list (Telegram allows at most 100 buttons per message). */
  private async groupsReply(page: number): Promise<Reply> {
    const all = await this.h.groups();
    if (!all.length) return { text: T.noGroups };
    const filter = this.groupFilter.toLowerCase();
    const groups = filter ? all.filter((g) => g.name.toLowerCase().includes(filter)) : all;
    if (!groups.length) return { text: T.noGroupsMatch(this.groupFilter) };
    const pages = Math.ceil(groups.length / GROUPS_PER_PAGE);
    const p = Math.min(Math.max(0, page), pages - 1);
    const buttons: Buttons = groups
      .slice(p * GROUPS_PER_PAGE, (p + 1) * GROUPS_PER_PAGE)
      .map((g) => [
        {
          text: `${g.allowed ? "✅" : "▫️"} ${g.name}`.slice(0, 60),
          data: encodeAction({ type: "group", groupId: g.id, page: p }),
        },
      ]);
    const nav: Buttons[number] = [];
    if (p > 0)
      nav.push({ text: T.btnPrev, data: encodeAction({ type: "groupsPage", page: p - 1 }) });
    if (p < pages - 1) {
      nav.push({ text: T.btnNext, data: encodeAction({ type: "groupsPage", page: p + 1 }) });
    }
    if (nav.length) buttons.push(nav);
    const selected = all.filter((g) => g.allowed).length;
    return { text: T.groupsTitle(groups.length, selected, p, pages, this.groupFilter), buttons };
  }

  /** Handle a button press. Unknown or malformed data is ignored with a toast. */
  async handleCallback(data: string): Promise<CallbackResult> {
    const action = decodeAction(data);
    if (!action) return { toast: T.unknownCommand, replies: [] };
    switch (action.type) {
      case "apply":
        return { replies: [{ text: await this.h.apply(action.jobId) }], removeButtons: true };
      case "manual":
        return { replies: [{ text: await this.h.markManual(action.jobId) }], removeButtons: true };
      case "edit":
        this.pendingEdit = action.jobId;
        this.pendingSkip = null;
        return { replies: [{ text: T.editAsk }] };
      case "skip":
        return {
          replies: [{ text: T.skipAsk, buttons: skipReasonButtons(action.jobId) }],
          removeButtons: true,
        };
      case "skipReason":
        if (action.reason === "other") {
          this.pendingSkip = action.jobId;
          this.pendingEdit = null;
          return { replies: [{ text: T.skipFreeTextAsk }], removeButtons: true };
        }
        return {
          replies: [
            {
              text: await this.h.skip(
                action.jobId,
                action.reason === "none" ? null : T.skipReasons[action.reason],
              ),
            },
          ],
          removeButtons: true,
        };
      case "cvSave":
        return {
          replies: [{ text: this.h.saveCv() ? T.cvSaved : T.cvNothingPending }],
          removeButtons: true,
        };
      case "cvDiscard":
        return {
          replies: [{ text: this.h.discardCv() ? T.cvDiscarded : T.cvNothingPending }],
          removeButtons: true,
        };
      case "group":
        this.h.toggleGroup(action.groupId);
        return { replies: [await this.groupsReply(action.page)], removeButtons: true };
      case "groupsPage":
        return { replies: [await this.groupsReply(action.page)], removeButtons: true };
    }
  }

  /** Handle an uploaded file (expected: a CV as PDF). */
  async handleDocument(doc: {
    name: string;
    mime: string | undefined;
    size: number | undefined;
    download: () => Promise<Buffer>;
  }): Promise<Reply[]> {
    const isPdf = doc.mime === "application/pdf" || doc.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) return [{ text: T.cvNotPdf }];
    if ((doc.size ?? 0) > MAX_CV_BYTES) return [{ text: T.cvTooBig }];
    try {
      const data = await doc.download();
      if (data.length > MAX_CV_BYTES) return [{ text: T.cvTooBig }];
      const summary = await this.h.parseCv({ name: doc.name, data });
      return [
        {
          text: T.cvParsed(summary),
          buttons: [
            [
              { text: T.btnSave, data: encodeAction({ type: "cvSave" }) },
              { text: T.btnDiscard, data: encodeAction({ type: "cvDiscard" }) },
            ],
          ],
        },
      ];
    } catch (e) {
      return [{ text: T.cvFailed((e as Error).message) }];
    }
  }
}

/** Only the owner, and only in a private chat, may drive the bot. */
export function isOwner(
  from: { id: number } | undefined,
  chat: { type: string } | undefined,
  ownerId: number,
): boolean {
  return from?.id === ownerId && chat?.type === "private";
}

function keyboard(buttons: Buttons | undefined): InlineKeyboard | undefined {
  if (!buttons) return undefined;
  return InlineKeyboard.from(
    buttons.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))),
  );
}

export interface TelegramBot {
  /** Send a text message to the owner. */
  notify(text: string): Promise<void>;
  /** Send an approval card, with the tailored CV attached first when given. */
  sendCard(card: CardInput, pdf?: { name: string; data: Buffer }): Promise<void>;
  /** Start long polling; `onFatal` is called if polling stops for good (e.g. a bad token). */
  start(onFatal: (e: Error) => void): void;
  stop(): Promise<void>;
}

/**
 * Wire `BotCore` to Telegram with grammy (long polling). Messages from anyone but the owner
 * are dropped without a reply.
 */
export function startBot(token: string, ownerId: number, handlers: BotHandlers): TelegramBot {
  const bot = new Bot(token);
  const core = new BotCore(handlers);
  let stopping = false;

  const send = async (r: Reply) => {
    await bot.api.sendMessage(ownerId, r.text, {
      parse_mode: r.html ? "HTML" : undefined,
      reply_markup: keyboard(r.buttons),
      link_preview_options: { is_disabled: true },
    });
  };

  bot.use(async (ctx, next) => {
    if (isOwner(ctx.from, ctx.chat, ownerId)) await next();
  });

  bot.on("message:text", async (ctx) => {
    for (const r of await core.handleText(ctx.message.text)) await send(r);
  });

  bot.on("message:document", async (ctx) => {
    const d = ctx.message.document;
    const replies = await core.handleDocument({
      name: d.file_name ?? "cv.pdf",
      mime: d.mime_type,
      size: d.file_size,
      download: async () => {
        await send({ text: T.cvParsing });
        const file = await ctx.getFile();
        const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      },
    });
    for (const r of replies) await send(r);
  });

  bot.on("callback_query:data", async (ctx) => {
    const result = await core.handleCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(result.toast ? { text: result.toast } : undefined);
    if (result.removeButtons) await ctx.editMessageReplyMarkup().catch(() => undefined);
    for (const r of result.replies) await send(r);
  });

  bot.catch((err) => console.error("telegram error:", err.error));

  return {
    notify: (text) => send({ text }),
    async sendCard(card, pdf) {
      if (pdf) await bot.api.sendDocument(ownerId, new InputFile(pdf.data, pdf.name));
      await send(cardReply(card));
    },
    start(onFatal) {
      bot.start().catch((e: unknown) => {
        if (!stopping) onFatal(e instanceof Error ? e : new Error(String(e)));
      });
    },
    stop() {
      stopping = true;
      return bot.stop();
    },
  };
}
