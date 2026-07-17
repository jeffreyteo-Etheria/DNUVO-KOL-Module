# API Application Guide — Meta & TikTok Approved Access

This is the walkthrough for getting **approved production access** for the two posting
modules in this repo:

- `src/postMeta.js` — Instagram Reels + Facebook Page videos (Meta Graph API)
- `src/postTikTok.js` — TikTok Direct Post (Content Posting API v2)

Both modules read credentials from environment variables (`.env` locally, Netlify
environment variables in production). Nothing works until the applications below are
approved and the tokens are set.

---

## 1. Meta (Instagram + Facebook)

**Where to apply:** https://developers.facebook.com

### Prerequisites (do these first)

1. **Instagram account must be a Business (or Creator) account**, not personal —
   switch in the Instagram app under Settings → Account type.
2. **The IG account must be linked to a Facebook Page** (Page Settings → Linked
   accounts, or via Meta Business Suite).
3. **A verified Meta Business Portfolio** at https://business.facebook.com —
   Business verification (Settings → Business info → Business verification) requires
   company registration documents (ACRA BizFile works for a Singapore entity) and
   takes a few days. Advanced API access is not granted without it.

### Steps

1. **Create an app** at https://developers.facebook.com/apps → type **Business**.
   Connect it to your verified Business Portfolio.
2. **Add products:** "Instagram" (Graph API) and "Facebook Login for Business".
3. **Request these permissions via App Review** (App Review → Permissions and
   Features → request **Advanced Access**):
   - `instagram_basic`
   - `instagram_content_publish`  ← the one that actually publishes Reels
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`         ← publishes to the Facebook Page
   - `business_management`
   App Review needs a **screencast** showing how your app uses each permission —
   record a short video of the SocialMIND dashboard scheduling/publishing a post,
   plus a written use-case description ("scheduling and publishing approved
   influencer-campaign content to our own brand accounts").
4. **While waiting for review**, you can develop with **Standard Access**: any
   account that has a role on the app (admin/developer/tester) works already. Add
   your own IG/FB accounts as testers and everything in `postMeta.js` is testable
   today.
5. **Get the tokens/IDs** (Graph API Explorer: https://developers.facebook.com/tools/explorer):
   1. Generate a **User token** with the permissions above → exchange it for a
      **long-lived user token** (`GET /oauth/access_token?grant_type=fb_exchange_token...`).
   2. `GET /me/accounts` → copy the **Page ID** and the **Page access token**
      (Page tokens obtained from a long-lived user token do not expire).
   3. `GET /{page-id}?fields=instagram_business_account` → copy the **IG user ID**.
6. **Set the environment variables:**

   ```
   META_ACCESS_TOKEN=<long-lived PAGE access token>
   META_PAGE_ID=<Facebook Page ID>
   META_IG_USER_ID=<Instagram business account ID>
   ```

### Gotchas

- `video_url` passed to the API must be a **publicly reachable HTTPS URL** — Meta's
  servers download it. Localhost or auth-protected URLs fail.
- Reels containers take time to process: poll
  `GET /{container-id}?fields=status_code` until `FINISHED` before calling
  `media_publish` (the current code notes this — add the poll before going live).
- Rate limit: 50 published posts per IG account per rolling 24 h.

---

## 2. TikTok (Content Posting API)

**Where to apply:** https://developers.tiktok.com

### Steps

1. **Register as a developer** and **create an app** (Manage apps → Connect an app).
   Fill in company details — TikTok also reviews the app itself (name, icon,
   description, terms/privacy URLs are required; use your dnuvo/AKA domain).
2. **Add products to the app:**
   - **Login Kit** — needed for the OAuth flow that produces user access tokens.
   - **Content Posting API** — enable the **Direct Post** configuration.
3. **Request the `video.publish` scope** (plus `user.info.basic` for Login Kit).
4. **Verify the domain** that will host the video files: for `PULL_FROM_URL`
   (what `postTikTok.js` uses), the video URL's domain/prefix must be verified
   under the app's URL properties. Verify your Netlify/media domain there.
5. **Submit the app for review, then apply for the audit.** Two levels matter:
   - *App review* — grants the scopes so OAuth works.
   - *Content Posting audit* — **until this audit is approved, every post is forced
     private** (`SELF_ONLY`), which is why the code currently sets
     `privacy_level: 'SELF_ONLY'`. After audit approval, switch to
     `PUBLIC_TO_EVERYONE`.
6. **Get a user access token** via OAuth (Authorization Code flow):
   1. Send the account owner to
      `https://www.tiktok.com/v2/auth/authorize/?client_key=...&scope=video.publish,user.info.basic&response_type=code&redirect_uri=...`
   2. Exchange the code at `https://open.tiktokapis.com/v2/oauth/token/`.
   3. You receive an `access_token` (**expires in 24 h**) and a `refresh_token`
      (valid ~1 year).
7. **Set the environment variables:**

   ```
   TIKTOK_CLIENT_KEY=<from app page>
   TIKTOK_CLIENT_SECRET=<from app page>
   TIKTOK_ACCESS_TOKEN=<user access token>
   TIKTOK_REFRESH_TOKEN=<refresh token>
   ```

### Gotchas

- **The 24-hour access token is the big one.** `postTikTok.js` currently reads a
  static `TIKTOK_ACCESS_TOKEN`, which goes stale daily. Before launch, add a
  refresh step (POST `/v2/oauth/token/` with `grant_type=refresh_token`) in the
  scheduler before each posting run.
- Each creator account posts to **its own profile** — a token only publishes to the
  account that authorized it. For KOL posting you either collect OAuth consent per
  creator or have creators post natively and use Spark Ads for boosting.
- Direct Post has daily quotas per user and per app while unaudited.

---

## Quick status checklist

| Item | Where | Blocking? |
|---|---|---|
| Meta Business verification | business.facebook.com | Yes — gates Advanced Access |
| Meta App Review (`instagram_content_publish`, `pages_manage_posts`) | developers.facebook.com → App Review | Yes, for non-tester accounts |
| IG Business account linked to FB Page | Instagram app / Business Suite | Yes |
| TikTok app review + scopes | developers.tiktok.com | Yes |
| TikTok Content Posting **audit** | developers.tiktok.com | Yes — posts stay private until approved |
| TikTok URL/domain verification | app's URL properties | Yes, for PULL_FROM_URL |
| Token refresh job for TikTok | this repo (scheduler) | Yes — tokens expire daily |
