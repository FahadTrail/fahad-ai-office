# Fahad AI Office

A private multi-agent AI office. Fahad gives one goal to the Chief of Staff;
the office plans it, works it, and returns the result.

**This repository is the source of truth for the code.** The server is built
from `setup.sh`, never edited by hand.

---

## Where we stopped

**Step 3B complete.** Chief of Staff runs end to end on the VPS.

| Piece | State |
|---|---|
| Supabase database (11 tables) | done |
| Row-level security, owner-locked | done |
| Six employees seeded | done |
| Office Runtime, Dockerised | running |
| Chief of Staff | working, tested |
| Other five agents | not built yet — Step 3C |
| Handoffs between agents | not built yet |
| Dashboard / Live Feed | not built yet |
| 3D office | Phase 2 |

**Next step: 3C — add the Research & Strategy agent and the first real handoff.**

---

## What runs where

- **Supabase project `fahad-ai-office`** — database, shared memory, realtime
- **VPS `/opt/fahad-ai-office`** — the Runtime, in its own Docker container
- Completely standalone: own network, own volumes, **no ports exposed**,
  no dependency on anything else on the server

## How it works

1. A row lands in the `jobs` table
2. The Runtime claims it (`claim_next_job()`, safe against double-processing)
3. The Chief of Staff wakes, works, saves a result, and shuts down
4. Every stage is written to `events` — the feed the dashboard and 3D office
   will both read
5. The office idles at zero token cost until the next job

## Install or update the server

    curl -fsSL https://raw.githubusercontent.com/FahadTrail/fahad-ai-office/main/setup.sh | bash

Safe to re-run: it rewrites the code and **never touches `.env`**.

After updating:

    cd /opt/fahad-ai-office
    docker compose build
    docker compose up -d

## Day-to-day commands

    docker compose run --rm runtime npm run selftest   # check everything
    docker compose logs -f                             # watch it work
    docker compose restart                             # restart
    docker compose down                                # stop

## Secrets

Two keys live only in `/opt/fahad-ai-office/.env` on the server, never here:

- `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard, Project Settings, API Keys
- `ANTHROPIC_API_KEY` — console.anthropic.com, Settings, API Keys

`.gitignore` blocks `.env` and every other credential file shape.
If a key is ever exposed, rotate it rather than trying to erase it.
