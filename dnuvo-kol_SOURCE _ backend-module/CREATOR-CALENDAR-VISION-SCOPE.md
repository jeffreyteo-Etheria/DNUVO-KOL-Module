# Vision Scope — Creator Management & Sourcing Dashboard (Calendar-Centric)

Status: **Scope for approval — no build started.** This organizes the new requirements
into a structured spec so you can approve/adjust before implementation begins. Builds
on the gaps identified in [GAP-ANALYSIS-KOL-PLATFORM.md](GAP-ANALYSIS-KOL-PLATFORM.md).

## Boundary

This dashboard is scoped to **creator-facing activity only**: UGC production, livestream,
and paid boost/amplification of creator content. It is explicitly **not** a general
marketing calendar (no non-creator media, no owned-channel content). Everything in it
should be usable as a single "Creator Management & Sourcing" agent skill — one place
that covers sourcing → scheduling → messaging → budget → delivery → ROI for creators.

## 0. Creator Activity Calendar (the umbrella view)

A calendar is the top-level surface everything else feeds into — one place to see
what every creator is doing and when, across both activity types.

- Month/week view, filterable by: creator, platform, activity type (UGC / Livestream / Paid Boost), campaign, status (scheduled / confirmed / delivered / overdue).
- Each calendar entry shows: creator name + contact channel, activity type, product/SKU, status, linked budget line.
- Two activity lanes feed it, detailed in #1 and #2 below.
- Overdue/at-risk entries (past due date, no delivery submitted) should visually flag on the calendar, not just in a table.

**Depends on:** the proof-of-delivery module (from the earlier gap analysis) to know
what "delivered" means, and the CRM messaging module to show last-contact status per entry.

## 1. UGC Post Track

**Input:** a confirmed, selected creator for a UGC post.

**Produces:**
- A calendar entry (post due date, platform, SKU/product).
- A linked contact card: platform handles, preferred contact channel (email/WhatsApp/DM), last message, current outreach stage.
- One-click access to send/continue messaging for that creator (ties into the CRM messaging automation gap already scoped).

**Open question:** does "create schedule" here mean the *content posting* schedule
(same as the existing `/schedule` + scheduler that posts to TikTok/Meta), or a
*creator due-date* schedule (when the creator is expected to post, which the brand
doesn't control)? These are different mechanics — the first only works for
brand-owned accounts, the second is what proof-of-delivery is for. Confirm before build.

## 2. Livestream Track

**Input:** a creator selected for livestream, plus:
- **GMV data** — needs a source. Likely Shopee LIVE / TikTok Shop LIVE seller-side GMV exports (no public API for this per platform; would be manual import or Seller Centre export unless you have API access). Confirm data source.
- **Profile data** — assumed to mean the creator's existing profile stats (followers, engagement, past livestream performance) already partially captured in `creator_sources` (followers, tier) but GMV/livestream track record is a new field set.

**Produces:**
- Calendar entry for the livestream session (date/time, platform, co-host or solo).
- Creator performance snapshot (historical GMV, if available) surfaced at selection time to inform the booking decision.

**New data needed on the creator record:** livestream GMV history, past livestream count/dates, average watch time if available.

## 3. Media Budget Utilization + Creator Payment Plan

- Track budget allocated vs. spent per campaign, broken out by creator.
- Payment plan per creator: rate (flat / commission / hybrid), payment schedule (e.g., 50% on confirmation, 50% on delivery), payment status (pending / paid / overdue).
- Should roll up into the existing budget-echo/tier-allocation logic already in the dashboard, not replace it — this adds a **creator-level** ledger under the campaign-level budget that already exists.

**Open question:** do you want payment status tracked as data-entry only (manual mark-as-paid), or does this need to integrate with an actual payment/invoicing system? Assumed manual for v1 unless you say otherwise.

## 4. Spend / ROI / KPI Tracking — split by UGC vs. Livestream

- Extends the existing `campaign_kpi_entries` table/endpoints, but the current KPI model doesn't distinguish activity type. Needs a dimension: `activity_type: ugc | livestream`.
- Metrics per type:
  - UGC: spend, views, engagement rate, CTR, conversions/sales attributed, cost-per-result.
  - Livestream: spend, GMV, viewers, average watch time, conversion rate, cost-per-GMV-dollar.
- Roll-up view: total spend vs. total ROI, split by activity type, at campaign and creator level.

## 5. Import Creator List → Jul–Sep Campaign

You referenced an attached list, but **no file came through with this message** — please
re-attach it (CSV/Excel or paste the list) and I'll map it into `creator_sources` fields
(name, platform, handle, followers, tier, rate, contact channel).

Once imported, each creator needs to be assigned to the **Jul–Sep (3-month) campaign**
with:
- Budget allocation per creator (or per tier).
- Activity plan: UGC, Livestream, or both, with target dates across the 3 months.
- This is really "bulk-add creators to a campaign with a plan" — a new bulk-assign flow on top of existing `creator_sources` + `campaigns` tables, not a new data model.

## 6. Media Plan — UGC Video Boost / Paid Promotion

- Separate from organic creator posting: this is spend to **amplify** existing UGC content (e.g., Spark Ads/Whitelisting on TikTok, boosted posts on Meta).
- Needs: which UGC pieces are eligible for boost, boost budget per piece, flight dates, target audience/objective, and performance tracking distinct from the organic KPI (own line item under #4's ROI tracking, tagged `paid_boost`).
- This is the "Paid Boost" activity type referenced in the dashboard's stated boundary — should be a third calendar lane/activity type alongside UGC and Livestream.

## 7. Product Pricing, Bundle & Promotion Strategy

- A dedicated section for: base pricing, bundle configurations, and promo mechanics (BAU discount cadence, flash sales, livestream-exclusive offers) — this determines net margin per SKU, which is why it needs to sit next to spend/ROI rather than live only in a separate pricing doc.
- The dashboard already has partial promo-calendar content in `public/index.html` (flash sale cadence, end-of-month sale, 9.9 mega sale mechanics) — this section should formalize that into a structured table (SKU, price, bundle, promo type, discount depth, dates, expected margin impact) rather than the current freeform text blocks.
- Net profit calc should combine: product margin (from this section) minus creator cost + paid boost spend (from #3/#6) = true campaign profitability — this is the piece that ties pricing to creator ROI.

## 8. Reporting — Revenue & Spend vs. ROI vs. Industry Benchmark

- Recurring reporting table (cadence: weekly/monthly — confirm which) showing: revenue, spend, ROI/ROAS, split by UGC/Livestream/Paid Boost.
- Industry benchmark comparison — needs a source for benchmark figures. Options: (a) manually entered benchmark constants you provide per channel/activity type, (b) no external benchmark API is assumed available. Confirm what benchmark figures you want used, since there's no live "industry benchmark" data feed to pull from automatically.

## New Data Model (summary — not yet built)

| Concept | New or extends existing |
|---|---|
| Calendar entries (UGC/Livestream/Paid Boost) | New table, references `creator_sources` + `campaigns` |
| Creator livestream GMV/profile history | Extends `creator_sources` |
| Creator payment plan/ledger | New table |
| KPI activity-type dimension | Extends `campaign_kpi_entries` |
| Bulk creator import → campaign assignment | New flow over existing tables |
| Paid boost tracking | New table or KPI dimension |
| Pricing/bundle/promo table | New table |
| Benchmark constants | New config table or manual entry |

## Open Items Before Build

1. **Attached creator list** — not received; please resend.
2. UGC "schedule" meaning — brand-posting schedule vs. creator due-date schedule (see #1).
3. GMV/livestream data source — manual import vs. API (see #2).
4. Payment plan — manual tracking vs. system integration (see #3).
5. Reporting cadence — weekly or monthly (see #8).
6. Industry benchmark source — manual constants you supply (see #8).

Once you confirm/adjust the scope above (and resend the creator list), I'll turn this into an implementation plan.
