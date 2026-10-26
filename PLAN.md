# Job Finder — Plan

## Goal

A personal job-hunting assistant for one owner (Guy), always on, hosted on Railway. It reads job
posts from WhatsApp groups the owner is already in, keeps only the ones that fit the owner's
profile (role, skills, salary expectations, location), writes a version of the owner's CV
tailored to each fitting job, and applies on the owner's behalf **only after the owner approves
each application on Telegram**.

It reuses the ideas of [arielhalevy123/assistant-architecture](https://github.com/arielhalevy123/assistant-architecture):
dumb listeners feeding one stream, one brain, Telegram as the owner's control channel,
memory that survives restarts, health checks that look at message recency, and the rule
"ask before anything outward-facing". What changes: it runs on a server instead of a Mac, so
the brain is a long-running worker that calls the Claude API instead of an interactive
Claude Code session with a Monitor.

## Scope

**In scope (v1)**

- WhatsApp listener (owner's own account, linked device) on an allow-list of groups. Read only.
- Telegram bot that answers only the owner's numeric id: approvals, status, settings, CV upload.
- Scheduled pipeline (default every 60 minutes): classify messages → extract job posts →
  deduplicate (the same job is reposted across groups) → match against the profile.
- Master CV: the owner uploads a CV once; it becomes a structured `cv.json` the owner confirms.
- Tailored CV per job (PDF) + a short cover message.
- Approval card on Telegram: job summary, why it matches, the tailored CV, the draft message,
  and buttons **Apply / Edit / Skip**. Nothing is sent without Apply.
- Apply by email (the most common call to action in group posts). Posts that say "apply via
  link/form" become a card with the link and the tailored CV, and the owner applies by hand.
- Learning from Skip reasons (stored as preferences and fed to the matcher).
- Daily digest, health alerts (WhatsApp disconnected, no job posts seen for 24 h).

**Out of scope (v1)**

- Automatic applications without approval.
- Filling web forms / ATS sites (LinkedIn, Comeet, etc.) — later, maybe.
- Scraping job sites. Only WhatsApp groups for now.
- Sending WhatsApp messages to recruiters (ban risk, see Open questions) — v2, behind approval.
- Multi-user.

## Architecture

```
 WhatsApp groups ─► wa listener ─┐                         ┌─► Telegram card ─► owner
                                 ├─► store (SQLite) ─► pipeline (every N min)
 Telegram owner ──► bot ─────────┘        ▲          classify → extract → dedupe → match
                                          │                    │
                                          │                    ▼
                                          │            tailor CV + draft message
                                          │                    │
                                          └── approvals ◄──────┘
                                                   │ Apply
                                                   ▼
                                             apply/email (SMTP)
```

- **One service, one process, one volume.** Railway volumes are not shared between services,
  so the listener, bot, scheduler and pipeline live in one Node process with SQLite on a
  mounted volume (`/data`). WhatsApp auth state also lives on `/data`.
- **Listeners stay dumb** (Ariel's rule): the WhatsApp listener writes accepted group messages
  to the `messages` table and does nothing else. Only text from allow-listed groups is kept;
  raw messages are deleted after 14 days. Messages that are not job posts are not kept beyond
  that.
- **One brain:** a single scheduler runs the pipeline; a run lock prevents overlap.
- **Claude API** does the judgement calls (is this a job post, extract fields, soft match
  score, tailor CV). Deterministic code does hard filters (salary floor, regions, exclusions),
  dedupe, and validation of the model output.
- **CV tailoring never invents facts.** The master CV is a list of items with ids. The model
  returns a selection/order of ids plus rewordings; a validator rejects any item id that does
  not exist and flags new numbers, employers, degrees or dates not present in the master.
- **Group content is data, not instructions.** Text from WhatsApp is passed to the model as
  quoted data; it can never trigger an action. Only the owner's Telegram id can.
- **Human pace** for anything sent: at most one application per few minutes, randomised.

## Directory layout

```
src/
  config.ts            env + profile loading/validation
  store.ts             SQLite: messages, jobs, decisions, kv
  llm.ts               Claude client (structured output), FakeLlm, quoteData
  whatsapp/listener.ts Baileys connection, allow-list, writes messages
  telegram/            bot.ts (BotCore + grammy wiring), cards.ts, texts.ts (Hebrew)
  pipeline/prefilter.ts cheap keyword/email check before the model
  pipeline/extract.ts  JobPost fields from a batch of posts (also decides "is it a job post")
  pipeline/dedupe.ts   fingerprint + similarity
  pipeline/match.ts    hard filters + model score with reasons
  pipeline/run.ts      one scheduled run: messages → cards
  cv/master.ts         CV upload → merged master cv.json
  cv/tailor.ts         job + master → tailored CV, validateTailored
  cv/render.ts         tailored CV → PDF
  apply/email.ts       application email + human-paced send queue
  scheduler.ts         run lock, timers, digest timing
  health.ts            health alerts (message recency), /healthz
  app.ts               bot handlers, runs, sending, housekeeping (all deps injected)
  main.ts              wires the real services together
tests/                 <module>.test.ts per module, fictional fixtures in tests/fixtures
```

## Modules and public functions

- **config**: `loadEnv`, `loadProfile`, `saveProfile`, `parseProfile`.
- **store**: `openStore(path)` → `insertMessage`, `pendingMessages`, `markProcessed`, `purgeOldMessages`,
  `insertJob`, `updateJob`, `jobsByStatus`, `jobsSince`, `recordDecision`, `hasDecision`,
  `recentDecisions`, `getKv`/`setKv`.
- **llm**: `Llm.json({ model, system, prompt, schema, pdfs })`; `AnthropicLlm`, `FakeLlm`, `quoteData`.
- **whatsapp/listener**: `startWhatsApp(opts)` — pairing code sent to Telegram, allow-listed groups
  only; pure helpers `extractText`, `toNewMessage`.
- **telegram/bot**: `startBot(token, ownerId, handlers)`; `BotCore` holds the conversation logic
  (`/status`, `/scan`, `/pause`, `/resume`, `/groups`, `/profile`, `/setprofile`, `/cv`, Apply / Edit /
  Skip with reasons); any sender but the owner, or a non-private chat, is ignored.
- **pipeline/prefilter**: `looksLikeJobPost(text)`.
- **pipeline/extract**: `extractJobs(llm, model, messages)` → jobs per message; `verifyApply` keeps
  only apply targets that appear in the text.
- **pipeline/dedupe**: `fingerprint(job)`, `findDuplicate(job, recent)`.
- **pipeline/match**: `hardFilter(job, profile)`, `fullTimeMonthly`, `scoreMatch(llm, model, job, ctx)`,
  `formatLearned(skips)`.
- **pipeline/run**: `runPipeline(deps)`, `toCard(job, master)`.
- **cv/master**: `parseCv(llm, model, pdf)`, `mergeCv(master, parsed)`, `sourceWarnings`, `cvForPrompt`.
- **cv/tailor**: `tailorCv(llm, model, master, job, variant)` (one retry, then the untouched variant);
  `validateTailored(master, tailored, job)`.
- **cv/render**: `renderPdf(master, tailored)`.
- **apply/email**: `buildApplication`, `createMailer`, `ApplyQueue`.
- **scheduler**: `Lock`, `isDigestDue`, `startScheduler`.
- **health**: `checkHealth`, `throttleAlerts`, `startHealthServer`.
- **app**: `createApp(deps)` → `handlers`, `runOnce`, `tick`, `queue`.

## Dependencies

- TypeScript, Node 24, pnpm, vitest, eslint/prettier.
- `@whiskeysockets/baileys` — WhatsApp Web protocol without a browser (whatsapp-web.js, which
  Ariel uses, needs Chromium; too heavy for a small Railway container).
- `grammy` — Telegram bot.
- `@anthropic-ai/sdk` — Claude API. Cheap model for classify/extract, stronger model for
  match and tailoring; model ids come from env.
- `node:sqlite` (built into Node 24) — the store, no native build step.
- `zod` — config and model-output validation.
- `pdfkit` — CV PDF rendering.
- `nodemailer` — SMTP.
- `unpdf` — read the uploaded CV PDFs.

## Configuration (Railway variables, never in git)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `ANTHROPIC_API_KEY`, `SMTP_USER`, `SMTP_APP_PASSWORD`,
`WA_PHONE` (for the pairing code), `DATA_DIR=/data`, `SCAN_INTERVAL_MIN=60`.
Non-secret preferences live in `/data/profile.yaml` and are edited through the bot.

## Build order

1. config + store (everything depends on them)
2. telegram/bot (owner channel first, as Ariel says: Telegram, then the rest)
3. pipeline/classify, extract, dedupe, match (testable on sample posts, no WhatsApp needed)
4. cv/master, tailor, render
5. whatsapp/listener (last of the inputs, riskiest)
6. apply/email, scheduler, health, main
7. Dockerfile + Railway deploy, CI

## Risks

- **WhatsApp account ban.** Baileys is unofficial and breaks WhatsApp's terms. Reading only,
  from a linked device, is low-risk but not zero. Recommended: a secondary number that joins
  the job groups, not the owner's main number.
- **Privacy.** Group messages from other people go to the Claude API for classification.
  Only allow-listed job groups are read, and non-job messages are deleted.
- **Cost.** Classification is batched with a cheap model; tailoring runs only for jobs that pass
  the hard filters.

## Decisions (2026-10-25)

1. **Language:** TypeScript, one Node process.
2. **WhatsApp number:** the owner's main number, linked as a device with a pairing code.
   The number is a Railway variable (`WA_PHONE`), never in git.
3. **CV:** the owner has two English CV variants. Both are merged into one master CV with item ids;
   for each job the tailor starts from the closer variant and selects/rewords items. Output: **PDF**
   rendered with `pdfkit` (English text, so no RTL shaping and no LibreOffice needed). The cover
   message follows the post's language.
4. **Apply channels in v1:** email only; link/form posts get a manual card.
5. **Profile:** set by the owner through the bot (`/setprofile`) and stored only in `/data/profile.yaml`:
   job types (student / full-time), regions (plus remote/hybrid), a monthly salary floor and a
   preferred salary; student jobs are judged pro-rata by scope. The values stay out of git; the
   code ships a neutral default that filters nothing.
6. **Models:** `claude-haiku-5-5` for every call by default (changed 2026-10-26 from
   `claude-opus-5-5` to cut cost); `MODEL_EXTRACT` and `MODEL_TAILOR` can switch a step back to a
   stronger model, e.g. tailoring to `claude-opus-5-5`.

## Privacy rule (the repo is public)

No personal data in git: no CV, phone, email, salary, profile or group names. They live only on
the Railway volume and are uploaded through the bot. Tests use fictional fixtures.
