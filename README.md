# GitHub Public Promo-Code Monitoring System

A 24/7 Render-deployable monitoring system for intentionally shared public promo, coupon, and credit codes for SaaS, AI, and developer tools. It is explicitly scoped away from secrets, credentials, crypto/web3 spam, referral farms, and bulk coupon dumps.

## Architecture

| Component | Implementation | Purpose |
| --- | --- | --- |
| `promo-db` | Render Managed PostgreSQL | Stores canonical promo codes, sightings, and scan telemetry |
| `promo-worker` | Node.js + TypeScript background worker | 24/7 GitHub fast lane, slow lane, watchlist, historical backfill, expiry, and alerts |
| `promo-dashboard` | Next.js App Router + Tailwind CSS | Search, filter, copy, source links, health, and admin status management |
| `render.yaml` | Render Blueprint | All-in-one infrastructure deployment |

## Safety pipeline

### Stage 1 — hard secret/credential rejector

Runs in memory before logging or persistence. Matching content is dropped immediately, and only a generic reason label is returned. Rejected shapes include:

- `sk-…` keys
- GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`
- Google keys: `AIza…`
- AWS access keys: `AKIA…`
- Slack tokens: `xoxb-`, `xoxp-`, related `xox*` forms
- JWTs beginning with `eyJ`
- `Bearer …` authorization material
- `.env`-style assignments such as `API_KEY=`, `SECRET=`, `TOKEN=`, `PASSWORD=`, `PRIVATE_KEY=`
- PEM private-key blocks
- High-entropy strings over 24 characters that do not have plausible promo-code structure

### Stage 2 — crypto/web3 and spam exclusion

Excludes crypto, web3, airdrop, tokenomics, Solana, Ethereum, wallet, casino, betting, referral-farm material, bulk coupon-spam repo names such as `free-coupons-*`, and files dumping more than 15 unrelated code-shaped tokens.

### Stage 3 — two-pass extraction and confidence scoring

Pass 1 requires both:

1. a public-sharing cue such as `promo code`, `coupon`, `hackathon credits`, `free credits`, `use code`, `redeem`, or `partner perk`; and
2. a configured SaaS/AI/developer-tool vendor or matching redemption URL.

Pass 1 also blocks generic uppercase stopwords (`README`, `LICENSE`, `OPENAI`, `HTTPS`, etc.), vendor-name tokens, license/CVE identifiers, and common non-promo compounds (`BSD-3-CLAUSE`, `TIME-LIMITED`, `CVE-2026-…`). Codes must appear near the vendor name or domain, and low-confidence hits that only matched a docs URL elsewhere in a large file are dropped.

Pass 2 optionally calls a low-cost LLM structured JSON extractor. `SARVAM_API_KEY` (Sarvam 105B) takes priority, then `OPENAI_API_KEY`, then `GEMINI_API_KEY`. If none is configured, extraction continues with pass 1 only. When the LLM is configured and returns `is_public_promo=false` or no valid code, the candidate is dropped. The expected JSON shape is:

```json
{
  "is_public_promo": true,
  "vendor": "OpenAI",
  "code": "HACK2025",
  "offer_summary": "OpenAI hackathon API credits",
  "redeem_url": "https://platform.openai.com/",
  "expires_at": "2026-02-01",
  "confidence": "high"
}
```

## GitHub polling design

- Vendors from `vendors.json` are bundled into about seven combined `OR` search query groups.
- **Fast lane (default every 90 seconds):** Commits Search sorted by `committer-date` plus Issues Search sorted by `created`.
- **Slow lane (default every 20 minutes):** Code Search over `README.md`, `PERKS.md`, and `docs/`.
- **Watchlist:** Repositories in `watchlist.json` are polled directly with Core REST `GET /repos/{owner}/{repo}/commits`; matching commits are expanded through commit-detail API calls.
- **Historical backfill:** The worker walks backwards through `committer-date:YYYY-MM-DD..YYYY-MM-DD` windows, fetch commit diffs, persists every window in `scan_runs`, and never alerts for historical finds. A window is marked complete only after every query in that window succeeds.
- **Adaptive pacing:** Serializes GitHub requests across lanes, reads `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`, and uses conditional `If-None-Match` requests with ETags. Secondary rate limits / 403 abuse detection wait at least 60 seconds with jitter. Backfill backs off when less than roughly 30% rate-limit budget remains. `/health` reports core, search, and code-search headroom separately.
- **Token pool:** Supports one `GITHUB_TOKEN` or comma-separated `GITHUB_TOKENS`.

## Database schema

`migrations/001_init.sql` creates:

- `promo_codes` with unique `(lower(vendor), upper(code))`, confidence, lifecycle status, expiry, and sighting count
- `promo_sightings` with one row per unique code/source pair
- `scan_runs` with query key, surface, live/backfill mode, cursor window, ETag, hit counts, new-code counts, rate-limit headroom, and run time

The unique vendor/code identity prevents duplicate canonical promo codes while repeated independent source URLs increment `sighting_count`.

## Alerts

Only net-new live `high` or `medium` confidence codes notify. Backfill discoveries never notify. Every channel is optional and skipped cleanly when unset:

- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Discord: `DISCORD_WEBHOOK_URL`
- Slack: `SLACK_WEBHOOK_URL`
- Email: `SMTP_URL`, `EMAIL_FROM`, `EMAIL_TO`

## Dashboard

The dashboard supports:

- Search across code, vendor, repository, and offer text
- Filters for vendor, category, source type, confidence, and status
- Sorting by newest or most sightings
- One-click copy
- Direct GitHub source and redemption links
- Admin-protected status changes through `ADMIN_SECRET`
- Pagination (50 codes per page) that preserves search and filter state
- `/health` plus a worker status bar with last scan time and separate core, search, and code-search rate-limit headroom

## Render deployment

### 1. Push this directory to a GitHub repository

Render Blueprints require a repository containing `render.yaml`.

### 2. Create the Blueprint

In Render, choose **New + → Blueprint**, connect the repository, and select `render.yaml`. Render creates:

1. `promo-db` — managed PostgreSQL
2. `promo-worker` — always-on background worker
3. `promo-dashboard` — Next.js web service

### 3. Set secret environment variables

At minimum configure on `promo-worker`:

- `GITHUB_TOKEN` or `GITHUB_TOKENS`

Configure on `promo-dashboard`:

- `ADMIN_SECRET` — long random value

Optionally configure LLM extraction and alert channels listed in `.env.example`.

`DATABASE_URL` is automatically supplied by the `promo-db` reference in `render.yaml`.

### 4. Verify deployment

- Open the dashboard URL Render assigns to `promo-dashboard`.
- Check `/health`; it returns database status, latest scan time, scan count, and separate core / search / code-search rate-limit headroom.
- Watch `promo-worker` logs for `scan_complete` events.
- Confirm rows appear in `promo_codes` after matching public GitHub content is found.

### Migration behavior

The worker `preDeployCommand` runs `npm run migrate` before each deploy. Migration files are idempotent and tracked in `schema_migrations`. To run manually:

```bash
DATABASE_URL=postgres://... npm run migrate
```

## Local development

Requirements: Node.js 20+ and PostgreSQL.

```bash
cp .env.example .env
# fill DATABASE_URL and optionally GITHUB_TOKEN
npm install
npm run migrate
npm test
npm run build
npm run start:worker
npm run start:dashboard
```

The dashboard listens on `PORT` or `3000`.

## Tests

```bash
npm test
```

Unit coverage includes:

- Secret and credential rejection without echoing secret material
- Crypto/web3/spam exclusions and bulk coupon dumps
- Canonical deduplication by `(lower(vendor), upper(code))`
- Daily expiry and 45-day likely-expiry transitions
- Pass-one extraction requirements, stopwords, confidence, and pre-extraction secret dropping

## Configuration files

- `vendors.json` — target vendors, categories, keywords, and redemption domains
- `watchlist.json` — high-value repositories polled directly through the Core REST API
- `.env.example` — every supported runtime setting
- `render.yaml` — database, worker, and web service blueprint

## Operating notes

- The system intentionally stores only extracted public promo information and source metadata, never rejected credential-bearing text.
- Search noise is reduced by requiring both sharing intent and vendor/redemption context, but `unverified` remains the default initial status.
- Use the admin dashboard control to mark validated codes `active` or false positives `flagged`.
- GitHub API behavior and search indexing are eventual-consistency systems; exact hit timing varies with GitHub indexing latency.
