# d.nuvo Pipeline Backend

Companion to `dnuvo-pipeline-dashboard.html`. Handles the three things a browser cannot:
creator link verification, real auto-posting (TikTok + Meta), and scheduled execution.

Now includes persistent campaign storage in SQLite (`data/pipeline.db`) so setup, creator outputs, verification results, schedule drafts, and budget state can be saved/loaded in the dashboard.

## Setup
```bash
npm install
cp .env.example .env     # fill after API approval — see API-APPLICATION-GUIDE.md
npm start                # API server on :3000
npm run scheduler        # cron loop, posts queued items every 5 min
```

Add `ANTHROPIC_API_KEY` in `.env` so the dashboard can generate creator/content modules through `POST /ai/generate` without exposing secrets in the browser.

Add `APIFY_TOKEN` plus actor IDs in `.env` to enable high-accuracy multi-actor KOL sourcing via `POST /apify/kol-source`.

## Deploy to Netlify (preview + production)
This project is configured for Netlify using:
- static publish directory: `public/`
- serverless API function: `netlify/functions/api.js`
- route rewrites in `netlify.toml`

### Netlify UI settings
- Base directory: `dnuvo-kol_SOURCE _ backend-module` (if deploying monorepo/workspace)
- Build command: `npm install`
- Publish directory: `public`
- Functions directory: `netlify/functions`

### Required Netlify Environment Variables
Add in Site settings > Environment variables:
- `ANTHROPIC_API_KEY`
- `APIFY_TOKEN`
- `APIFY_ACTOR_DISCOVERY`
- `APIFY_ACTOR_TIKTOK`
- `APIFY_ACTOR_INSTAGRAM`
- `APIFY_WAIT_SECS`
- `APIFY_SG_LOCAL_CONFIDENCE_MIN`
- `APIFY_MIN_FOLLOWERS_NANO`
- `APIFY_MIN_FOLLOWERS_MICRO`
- `APIFY_MIN_FOLLOWERS_MID`
- `APIFY_MIN_FOLLOWERS_MACRO`
- `APIFY_MIN_FOLLOWERS_MEGA`
- `TIKTOK_ACCESS_TOKEN` (if auto-posting enabled)
- `META_ACCESS_TOKEN` (if auto-posting enabled)

If `APIFY_TOKEN` is missing, Step 1 now falls back to AI-only draft sourcing for preview/testing and shows a warning banner.

## Workflow with the dashboard
1. Dashboard → Section 1 generates creator candidates (all marked "pending link check")
   - Source path uses Apify multi-actor stack for higher accuracy (discovery + TikTok enrichment), then AI only for outreach ordering.
2. Dashboard → Creator Link Verification Queue (or `POST /verify-creator {"urls": [...]}`) for live / dead / redirected verdict per profile
3. Dashboard → Save Campaign Snapshot (`POST /campaigns/save`) to persist your current state
4. Dashboard → build schedule → `Send To Live Queue` (or `POST /schedule`)
5. Dashboard → `Refresh Queue Status` (`GET /schedule/summary`) and optional `Run Due Posts Now` (`POST /schedule/process-now`)
6. Dashboard → Save KPI actuals (`POST /campaigns/:id/kpi`) and load KPI history (`GET /campaigns/:id/kpi`)
7. Dashboard → Review campaign audit trail (`GET /campaigns/:id/audit`) for operational actions
8. Dashboard → Load existing campaign (`GET /campaigns`, `GET /campaigns/:id`) to continue from previous work
9. `npm run scheduler` posts each queued item at its date+time (SGT):
   - TikTok → Content Posting API (starts SELF_ONLY until app audit passes)
   - Instagram → Graph API Reels container → publish
   - Facebook → Page video post
   - Shopee / Lazada / Shopify → marked `manual` (no public posting APIs; use Seller Centre)

## Campaign persistence endpoints
- `GET /campaigns` → list saved campaigns
- `GET /campaigns/:id` → load full campaign snapshot
- `POST /campaigns/save` → create/update snapshot

## KPI and audit endpoints
- `POST /campaigns/:id/kpi` → save KPI actuals row for a campaign
- `GET /campaigns/:id/kpi` → latest KPI + KPI history rows
- `GET /campaigns/:id/audit` → recent campaign action log

## Apify sourcing endpoint
- `POST /apify/kol-source` → runs multi-actor KOL sourcing and returns scored shortlist + backups

Default actors:
- discovery: `alizarin_refrigerator-owner/influencer-discovery---find-influencers-across-social-platforms`
- TikTok enrichment: `alizarin_refrigerator-owner/tiktok-creator-scraper`
- Instagram enrichment (third pass): `seemuapps/instagram-related-profiles-scraper`

Stricter SG-local filtering:
- `APIFY_SG_LOCAL_CONFIDENCE_MIN` controls shortlist gate for Singapore campaigns (default `0.70`).
- Candidates below the threshold are dropped before shortlist ranking.

Hard candidate gates:
- Candidate must have a `profileUrl`.
- Candidate must have follower count and pass minimum floor for inferred tier.
- Follower floors are configurable via:
   - `APIFY_MIN_FOLLOWERS_NANO`
   - `APIFY_MIN_FOLLOWERS_MICRO`
   - `APIFY_MIN_FOLLOWERS_MID`
   - `APIFY_MIN_FOLLOWERS_MACRO`
   - `APIFY_MIN_FOLLOWERS_MEGA`

## Honesty guarantees
- No mock data anywhere. Every endpoint fails loudly if credentials are missing.
- Verification verdicts are real HTTP checks, with an explicit `blocked` state when
  platforms bot-wall the request (then check manually or via official API).
