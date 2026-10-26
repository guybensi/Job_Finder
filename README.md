# Job Finder

A personal job-hunting assistant for one person. It reads job posts from WhatsApp groups you are
already in, keeps the ones that fit your profile, writes a version of your CV tailored to each
fitting job, and applies by email **only after you press Apply on Telegram**.

```
WhatsApp groups ─► listener ─► SQLite ─► pipeline (every 60 min) ─► Telegram card ─► you
                                         prefilter → extract → dedupe     │
                                         → filter → score → tailor CV     │ Apply
                                                                          ▼
                                                                    email (SMTP)
```

- **Read-only WhatsApp** (Baileys, linked device). Only groups you switch on with `/groups` are read;
  raw messages are deleted after 14 days.
- **Claude API** extracts job fields, scores the fit and tailors the CV. Group text is passed to the
  model as quoted data and can never trigger an action.
- **No invented facts.** The tailored CV can only reorder, select and reword items of your master CV.
  `validateTailored` rejects new numbers, employers, tools or degrees; after one failed retry the
  untouched CV variant is used instead.
- **Nothing is sent without Apply.** Applications go out one at a time, minutes apart.
- **Learns from Skip.** Skip reasons are fed back into scoring.

Design and decisions: [`PLAN.md`](PLAN.md).

## Setup

Needs Node 22.13+ (Node 24 in the Docker image) and pnpm.

```bash
pnpm install
cp .env.example .env   # fill in tokens; never commit .env
pnpm dev
```

| Variable                         | What                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`             | from @BotFather                                                                 |
| `TELEGRAM_OWNER_ID`              | your numeric Telegram id; nobody else can use the bot                           |
| `ANTHROPIC_API_KEY`              | Claude API key                                                                  |
| `WA_PHONE`                       | your WhatsApp number with country code (for the pairing code)                   |
| `SMTP_USER`, `SMTP_APP_PASSWORD` | Gmail address and an app password (optional; without them only manual applying) |
| `DATA_DIR`                       | data directory (`/data` on Railway)                                             |
| `SCAN_INTERVAL_MIN`              | minutes between scans (default 60)                                              |
| `MODEL_EXTRACT`, `MODEL_TAILOR`  | model ids (default `claude-haiku-5-5`)                                          |

### First run (on Telegram)

1. The bot sends a WhatsApp **pairing code**. On the phone: Settings → Linked devices → Link a device →
   Link with phone number, and enter the code.
2. `/groups` — switch on the job groups to scan.
3. `/cv` — send your CV PDFs (one per variant), check the summary, press Save.
4. `/profile` shows the profile; send `/setprofile` followed by the full YAML to change it
   (roles, job types, regions, salary floor, exclusions). It is stored only in `DATA_DIR`.

Then wait for cards, or `/scan` to run now. `/status`, `/pause`, `/resume` do what they say.

## Deploy on Railway

1. New service from this repo (it builds the `Dockerfile`; `railway.json` sets the health check).
2. Add a **volume** mounted at `/data`.
3. Set the variables above. Keep one replica.

Everything personal (CV, profile, WhatsApp session, database) lives on the volume, not in git.

## Development

```bash
pnpm check   # lint + format check + typecheck + tests (what CI runs)
pnpm test    # vitest
pnpm build && pnpm start
```

CI (`.github/workflows/ci.yml`) runs lint, format, typecheck and build on every push. Tests: the
full suite on `main`, and on other branches or PRs only the tests related to changed files
(`scripts/select-tests.mjs` + `vitest related`).

## Layout

```
src/config.ts            env + profile
src/store.ts             SQLite (node:sqlite)
src/llm.ts               Claude client wrapper
src/whatsapp/            listener
src/telegram/            bot, approval cards, Hebrew texts
src/pipeline/            prefilter, extract, dedupe, match, run
src/cv/                  master CV, tailor + validator, PDF render
src/apply/email.ts       application email + send queue
src/scheduler.ts, src/health.ts, src/app.ts, src/main.ts
tests/                   one test file per module, fictional fixtures
```

## Note

WhatsApp does not allow unofficial clients; Baileys is one. Reading only, from a linked device, is
low risk but not zero.
