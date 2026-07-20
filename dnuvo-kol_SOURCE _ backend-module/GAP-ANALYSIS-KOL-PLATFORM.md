# Gap Analysis — End-to-End KOL Management Platform

Compares the target vision (creator sourcing → CRM messaging automation → content
briefing/building → delivery submission → reporting) against what's actually
implemented in this repo today. No code changed as part of this doc.

## 1. Creator Sourcing

**Vision:** Apify-based sourcing and selection.

**Status: Built.**
- `POST /apify/kol-source` — multi-actor sourcing (discovery + TikTok/Instagram enrichment), tier floors, SG-local confidence gate, AI-only fallback if `APIFY_TOKEN` missing.
- `creator_sources` table + CRUD (`GET/POST/DELETE /creator-sources`) — persistent creator library per advertiser, with platform handles (TikTok/Instagram/Meta/Line), tier, rate note, niche.
- `POST /verify-creator` / `POST /creator-sources/verify` — live/dead/redirected link verification.

Nothing missing here for a v1.

## 2. Creator CRM — Stage Tracking

**Vision:** CRM communication with automation response based on stages of acceptance → confirmation, across TikTok/Shopee/Instagram/Facebook.

**Status: Partially built — data model and manual UI exist; automation does not.**
- `creator_sources.outreach_stage` column with values `not_contacted → messaged → replied → confirmed` (`public/index.html:1792`).
- Dashboard has a stage filter/dropdown per creator and a `Creator Contact & Outreach` panel with merge-field message templates (`MESSAGE_TEMPLATES` in `public/index.html:1915`) that render open/DM copy the user manually copies and pastes.
- `updateCreatorStage()` is a manual dropdown action, not a webhook/reply-driven transition.

**Gaps:**
- No outbound send integration for email or WhatsApp (no SMTP/SendGrid, no WhatsApp Business API/Twilio). Templates are generated for copy-paste only.
- No inbound listener to detect a creator's reply and auto-advance the stage (e.g., WhatsApp webhook, Gmail thread parsing, IG/TikTok DM webhook).
- No per-channel automation for TikTok/Shopee/Instagram/Facebook — the platform fields exist on the creator record, but there's no send/receive integration for any of them, and Shopee has no public messaging API to hook into (would need Seller Centre manual bridge, same constraint the README already notes for posting).
- No sequencing/cadence engine (e.g., "auto follow-up after 3 days of no reply, max 1 follow-up").

**This is the largest gap relative to the vision** — the CRM has a data model and manual workflow, but "automation response based on stage" doesn't exist yet.

## 3. Content Brief & Content Builder

**Vision:** Automated content builder to produce a KOL brief of the product, and content briefs by format (livestream, UGC post) to hand to creators.

**Status: Mostly built at the campaign level; not yet built as a per-creator/per-format deliverable.**
- Pre-Campaign Brief (mandatory, gated at ≥75/100 quality score) captures audience, KOL personas, content brief, guardrails (`public/index.html:242-259`).
- AI UGC Content Builder generates video scripts by SKU/persona/length (`public/index.html:484`, `buildEditBrief()`/script generation around `:2189`).
- Edit Brief From Footage: turns raw uploaded/described footage into a cut-by-cut edit brief with timestamps, hook, captions, export spec (`public/index.html:509-513`, `:2201`).
- Livestream is acknowledged as a partnership type (`Livestream co-hosts` checkbox, `:451`) but has no dedicated brief generator — only UGC scripts and footage-based edit briefs exist as generators.

**Gaps:**
- No livestream-specific brief format (talking points, must-hit segments/timestamps for a live session, product placement cues, comment-response guidance) — today livestream is just a partnership-type checkbox, not a brief output.
- No per-creator "product brief" packet (product one-pager, key claims, do's/don'ts, assets/links) generated and sent to an individual confirmed creator — the content brief today lives at campaign level, used internally to drive AI generation, not exported/sent to creators.
- No structured content-brief template library the team can pick from and hand off (currently freeform textarea + AI generation, no saved reusable templates per format).

## 4. Delivery Submission (Proof of Delivery)

**Vision:** Creators submit proof of delivery (posted content, links, screenshots) for verification/approval.

**Status: Not built.**
- No table, endpoint, or UI for creators to submit a post URL/screenshot, no approval/rejection state, no linkage from a confirmed creator + content brief to an expected deliverable and its submission.
- Existing `schedule` + `post/tiktok` + `post/meta` endpoints handle *brand-initiated* auto-posting (when the brand controls the account), which is a different flow from a *creator* submitting proof of their own post.

This is a fully greenfield module.

## 5. Reporting

**Vision:** Reporting across the pipeline.

**Status: Partially built.**
- `campaign_kpi_entries` + `POST/GET /campaigns/:id/kpi` — manual KPI actuals entry and history.
- `campaign_audit_logs` + `GET /campaigns/:id/audit` — operational action log.
- `GET /kpi/tiktok`, `GET /kpi/meta` — platform KPI pulls (where connected).
- Budget allocation and cost-per-tier breakdowns exist in the dashboard.

**Gaps:**
- No reporting tied to creator-level delivery status (e.g., "X of Y confirmed creators have submitted proof of delivery," "content is Z days late").
- No CRM funnel reporting (stage conversion rates: not_contacted → messaged → replied → confirmed, response time, drop-off).
- No unified per-campaign report combining sourcing → outreach → delivery → performance in one export.

## Summary Table

| Stage | Vision | Status |
|---|---|---|
| Sourcing (Apify) | ✅ | Built |
| Selection / creator library | ✅ | Built |
| CRM stage tracking (data model) | ✅ | Built |
| CRM messaging automation (send/receive, stage-triggered) | ❌ | **Not built — biggest gap** |
| Multi-channel automation (TikTok/Shopee/IG/FB) | ❌ | Not built (Shopee has no public messaging API regardless) |
| Campaign-level content brief + AI content builder | ✅ | Built |
| Per-creator product brief packet | ❌ | Not built |
| Livestream-specific brief format | ❌ | Not built (livestream only exists as a partnership-type toggle) |
| UGC post brief format | ✅ (via AI script generator) | Built |
| Delivery submission / proof of delivery | ❌ | Not built — greenfield |
| KPI/audit reporting | ✅ | Built |
| CRM funnel / delivery reporting | ❌ | Not built |

## Suggested Build Order

Given what already exists, the lowest-effort-to-value path is:
1. **CRM messaging automation** — pick one channel first (email is easiest: SMTP/SendGrid, no platform approval needed) and wire `outreach_stage` transitions to actual sends, since the data model and templates already exist.
2. **Proof-of-delivery submission** — new table (`creator_deliverables`: campaign_id, creator_id, expected_format, submitted_url, screenshot, status, submitted_at) + a simple creator-facing submission form and an internal approval view.
3. **Per-creator brief packet + livestream brief format** — extend the existing AI content builder with two more generator modes, reusing the same `ai()` call pattern already in `public/index.html`.
4. **CRM funnel + delivery reporting** — once stages and deliverables produce real data, add the aggregate views.
