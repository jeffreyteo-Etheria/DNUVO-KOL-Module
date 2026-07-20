# KOL List — Extracted from `aka-os-dnuvo-complete_1.html`

Extracted only the creator/KOL list from the attached AKA OS dashboard (Creators & Reserves
page + KOL Shortlist & Scoring page). Pricing/promo/bundle content from that deck was
**not** re-extracted here — it's already covered by the campaign brief's pricing section,
and can be pulled in separately if you want it merged into the Pricing & Promo module.

**Carry-forward warning from the source deck itself** (Creators page banner): *"Handles and
follower counts from public sources (Hashmeta, Favikon, Modash, StarNgage, 987FM). Confirm
live rate, current follower count, and SG audience % via each creator's media kit before
contracting."* Several rows below also have their own explicit audit flags. Per this
project's existing "no mock data" rule (`README.md`), these are **sourced-but-unverified**
figures from the deck — not live-verified data — until run through `/verify-creator` or a
media kit.

Two names ended up in two different sections of the source deck with different numbers
(follower counts / rate ranges don't match between the "Creators & Reserves" page and the
"KOL Shortlist & Scoring" page). Both figures are kept below rather than silently picked
between — flagged accordingly.

## Group A — UGC / Hero content creators

| Name | Handle | Platform | Followers | SG audience | ER | Rate | Niche / brief | Code | Score | Role | Flags |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dr Samuel GP | @drsamuelgp | Unconfirmed | — | ⚠ 91% US (audit) | — | S$2,000–3,500 | Clinical authority · 2 posts + endorsement + Spark rights | DRSAMUEL15 | 6.4 | UGC macro/authority | Audience skews US — deploy Spark Ads geo-targeted SG only, don't rely on organic reach |
| Christabel Chua | @bellywellyjelly | Instagram | 260K | ≥85% | 3.1% | S$1,500 flat + 10% commission + 90-day Spark whitelist | Skincare science | BELLY15 | — | Hero KOL — Month 1; rolls as Reserve 2 for Month 2 | — |
| Joanna Ee | @joannaskincaresg | Instagram | ~180K | ≥85% | 3.8% | S$1,300 flat + 12% commission + Spark whitelist | Sensitive skin × K-beauty | JOANNA15 | — | Hero KOL — Month 2; can also host Month 2 livestream | — |
| Dr Teo Wan Lin | @drteowanlin | Instagram (120K) / YouTube (45K) | 120K IG / 45K YT | ≥90% | — | S$1,500 flat + 10% commission | Clinical/dermatologist authority | DRTEO15 | — | Hero KOL — Month 3 | ⚠ Handle needs direct verification (per source) |
| graceglazee | @graceglazee | Unconfirmed | — | ⚠ ER 1.11% below floor | 1.11% | S$700–1,200 | 30-day diary D0/D14/D30 | GRACE10 | 5.1 | UGC mid | Verify audience in Modash; weight deal to 20% commission if proceeding |
| lifewithmils | @lifewithmils | Unconfirmed | — | 70–85% (est) | — | S$600–1,000 | Routine integration narrative | MILS10 | 6.2 | UGC mid | Activate Month 1 |
| evelynnexie | @evelynnexie | Unconfirmed | 15K (Creators page) | 85%+ (est, Modash-confirmed micro) | 8.4% (diary, Creators page) | S$120–250 (Shortlist page) | Micro — first-impression unboxing; also diary format reserve for Joanna | EVELYNN10 | 6.0 | UGC micro; also Reserve 1 for Month 2 | Two source sections disagree on follower count/rate — reconcile before contracting |
| annnicoleng__ | @annnicoleng__ | Instagram | 145K | — | 4.2% | — | Fragrance × beauty | — | — | Reserve 1 — Month 1 | — |
| glennice | @glennice | Instagram | 20K | — | 6.1% | — | Micro | — | — | Reserve 2 — Month 1; also proposed Live #1 beta host | — |
| Nano creator pool ×9 | (TBD — sourced via #sgskintok / #kbeautysg / Modash SG) | Mixed | — | SG-based accounts only (bio + hashtag signal) | — | Product + S$120–350 each | Authentic reviews — feeds the 15-review gate | NANO01–09 | 7+ | Nano seeding pool | Individual handles not yet identified — placeholder group, not real records |

## Group B — LIVE selling specialists

| Name | Handle | Platform | Followers | SG audience | ER | Rate | Format / timing | Code | Score | Flags |
|---|---|---|---|---|---|---|---|---|---|---|
| gaga_beauty | @gaga_beauty | TikTok | 333K | — | 1.19% | S$600–900 | Co-hosted LIVE · 10 Jul, 7pm SGT | GAGA10 | 5.0 | LIVE-only role — session-based, bypasses low post ER |
| vedawinfam | @vedawinfam | Unconfirmed | — | ⚠ 35–55% (est) | — | S$2,000 (3-part series incl. 1 LIVE — not S$8K/stream) | 3-part series | VEDA10 | 5.3 | Request media kit before contract; cap package at ≤S$2,000 |
| d.nuvo brand LIVE (self-hosted) | @dnuvo.sg | Self-owned | — | — | — | S$0 + S$200 boost | 3×/week from June — builds owned LIVE audience | — | — | Not a KOL — brand's own account |
| jannatul_mitsuisen | @jannatul_mitsuisen | Unconfirmed | — | ⚠ 91% US (live audit) | 1.23% | Max S$2,500 | August only, after 50+ reviews | — | 3.8 | **Recommend DECLINE at any fee** per source's own live audit note |

## What's ready to import vs. not

- **Ready with caveats** (name, platform reasonably inferable, rate/handle present): bellywellyjelly, joannaskincaresg, drteowanlin, annnicoleng__, glennice, gaga_beauty — these map cleanly to `creator_sources` fields (name, platform, handle, followers, rate_note, niche).
- **Missing a required field for this system's `creator_sources` table**: `profile_url` is `NOT NULL` in the schema, and the source deck gives handles, not links, for every row here — none should be fabricated. Real profile URLs need to be attached (or run through `/apify/kol-source` / `/verify-creator` to resolve and verify) before these become real records, consistent with this project's no-mock-data rule.
- **Not real creator records**: the "Nano creator pool ×9" and "d.nuvo brand LIVE" rows are placeholders/owned-channel entries, not individual creators to onboard.
- **Flagged for likely exclusion**: jannatul_mitsuisen — source's own audit recommends declining regardless of fee.

A CSV shaped to this project's `creator_sources` columns is at
`data/imports/kol_list_from_deck.csv` for when you're ready to load these in (profile_url
left blank where not knowable — needs filling before any import, since the table requires it).
