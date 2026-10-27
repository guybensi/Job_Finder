import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createMailer } from "./apply/email.js";
import { createApp, dbPath } from "./app.js";
import { canSendEmail, loadEnv, loadProfile } from "./config.js";
import { startHealthServer } from "./health.js";
import { AnthropicLlm } from "./llm.js";
import { startScheduler } from "./scheduler.js";
import { openStore } from "./store.js";
import { startBot, type TelegramBot } from "./telegram/bot.js";
import { T } from "./telegram/texts.js";
import { startWhatsApp, type WhatsApp } from "./whatsapp/listener.js";

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  loadProfile(env.DATA_DIR); // creates the default profile on first run, fails fast if invalid
  const store = openStore(dbPath(env.DATA_DIR));
  // Every call is added to today's cost (shown in /status and the digest).
  const llm = new AnthropicLlm(new Anthropic(), (u) => app.recordUsage(u));

  // The bot and the app need each other: the bot calls app handlers, the app sends via the bot.
  let bot: TelegramBot | null = null;
  let wa: WhatsApp | null = null;
  const app = createApp({
    env,
    store,
    llm,
    mailer: canSendEmail(env) ? createMailer(env) : null,
    notify: async (text) => {
      await bot?.notify(text);
    },
    sendCard: async (card, pdf) => {
      await bot?.sendCard(card, pdf);
    },
    waConnected: () => wa?.isConnected() ?? false,
    refreshGroups: async () => wa?.refreshGroups(),
  });
  bot = startBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OWNER_ID, app.handlers);
  bot.start((e) => {
    console.error("telegram bot stopped:", e.message);
    process.exit(1);
  });

  wa = startWhatsApp({
    authDir: path.join(env.DATA_DIR, "wa-auth"),
    phone: env.WA_PHONE,
    store,
    onPairingCode: (code) => void bot?.notify(T.waPairingCode(code)),
    onConnected: () => void bot?.notify(T.waConnected),
    onLoggedOut: () => void bot?.notify(T.waLoggedOut),
  });

  const scheduler = startScheduler({
    intervalMin: env.SCAN_INTERVAL_MIN,
    run: async () => void (await app.runOnce()),
    isPaused: app.isPaused,
    tick: app.tick,
    runAtStart: true,
  });

  const health = startHealthServer(env.PORT, () => ({
    whatsapp: wa?.isConnected() ?? false,
    lastMessageAt: store.lastMessageAt(),
    paused: app.isPaused(),
    queue: app.queue.size,
  }));

  console.log(`job-finder started (scan every ${env.SCAN_INTERVAL_MIN} min, port ${env.PORT})`);

  const shutdown = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    scheduler.stop();
    wa?.stop();
    health.close();
    await bot?.stop().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
