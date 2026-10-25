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
  store/               SQLite schema, migrations, queries
  whatsapp/listener.ts Baileys connection, allow-list, writes messages
  telegram/bot.ts      owner-only bot: commands, approval cards, CV upload
  pipeline/classify.ts is it a job post? (cheap model, batched)
  pipeline/extract.ts  JobPost fields from a post
  pipeline/dedupe.ts   fingerprint + similarity
  pipeline/match.ts    hard filters + model score with reasons
  cv/master.ts         CV upload → structured cv.json
  cv/tailor.ts         job + master → tailored CV (validated)
  cv/render.ts         tailored CV → PDF
  apply/email.ts       send application with attachment
  scheduler.ts         periodic runs, digest, health
  health.ts            /healthz, heartbeat, recency alerts
  main.ts              wires it all together
profile.example.yaml   role, skills, salary, regions, exclusions, languages
tests/                 <module>.test.ts per module
```

## Modules and public functions

- **config**: `loadConfig()` — env vars (secrets) + `profile.yaml` from `/data`, validated with zod.
- **store**: `openStore(path)`, `insertMessage`, `pendingMessages`, `upsertJob`, `recordDecision`,
  `purgeOldMessages`.
- **whatsapp/listener**: `startWhatsApp(store, opts)` — pairing code sent to Telegram, allow-listed
  groups only, heartbeat.
- **telegram/bot**: `startBot(store, opts)` — `/status`, `/groups`, `/profile`, `/cv`, `/scan`,
  `/pause`; approval cards with Apply/Edit/Skip; rejects any sender but the owner id.
- **pipeline/classify**: `classifyBatch(messages)` → which are job posts.
- **pipeline/extract**: `extractJob(text)` → `JobPost` (title, company, location, salary range,
  seniority, requirements, apply channel: email / phone / link, language).
- **pipeline/dedupe**: `fingerprint(job)`, `isDuplicate(job, recent)`.
- **pipeline/match**: `hardFilter(job, profile)` (deterministic), `scoreMatch(job, profile, cv,
learnedPrefs)` → score 0–100 + reasons.
- **cv/master**: `parseUploadedCv(file)` → `MasterCv` (owner confirms on Telegram).
- **cv/tailor**: `tailorCv(master, job)` → `TailoredCv`; `validateTailored(master, tailored)`.
- **cv/render**: `renderPdf(doc)`.
- **apply/email**: `sendApplication(job, files, message)` via SMTP (Gmail app password).
- **scheduler**: `startScheduler(deps, intervalMin)`.
- **health**: `startHealthServer(port)`, `checkRecency(store)`.

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
6. **Models:** `claude-opus-5-5` for every call by default; `MODEL_EXTRACT` and `MODEL_TAILOR`
   variables can switch a step to a cheaper model later.

## Privacy rule (the repo is public)

No personal data in git: no CV, phone, email, salary, profile or group names. They live only on
the Railway volume and are uploaded through the bot. Tests use fictional fixtures.
