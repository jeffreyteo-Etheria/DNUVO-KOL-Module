// Platform connections — TikTok & Meta OAuth, durable token storage, refresh.
// Tokens live in the api_tokens table (SQLite → Netlify Blobs) so they survive
// cold starts. Env vars remain a manual fallback; see API-APPLICATION-GUIDE.md.
const { saveApiToken, getApiToken } = require('./db');

const G = 'https://graph.facebook.com/v21.0';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_SCOPES = 'user.info.basic,video.publish';
const META_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
].join(',');

// ── TikTok ─────────────────────────────────────────────────────────────────

function tiktokAuthorizeUrl({ state, redirectUri }) {
  const key = process.env.TIKTOK_CLIENT_KEY;
  if (!key || !process.env.TIKTOK_CLIENT_SECRET) {
    throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing — add the app credentials from developers.tiktok.com first.');
  }
  const p = new URLSearchParams({
    client_key: key,
    scope: TIKTOK_SCOPES,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
}

async function tiktokTokenRequest(params) {
  const r = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      ...params,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`TikTok token request failed: ${JSON.stringify(d.error || d)}`);
  await saveApiToken('tiktok', {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    openId: d.open_id,
    scope: d.scope,
    expiresAt: Date.now() + (Number(d.expires_in) || 86400) * 1000,
    refreshExpiresAt: Date.now() + (Number(d.refresh_expires_in) || 31536000) * 1000,
  });
  return d.access_token;
}

async function tiktokExchangeCode({ code, redirectUri }) {
  return tiktokTokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
}

// Valid access token for posting: stored OAuth token (auto-refreshed when
// within 10 min of expiry), falling back to the static env token.
async function getTikTokAccessToken() {
  let stored = null;
  try { stored = await getApiToken('tiktok'); } catch (_) { /* db not initialized (bare scheduler) */ }
  if (stored && stored.accessToken) {
    const fresh = Date.now() < Number(stored.expiresAt || 0) - 10 * 60 * 1000;
    if (fresh) return stored.accessToken;
    if (stored.refreshToken && process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) {
      return tiktokTokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refreshToken });
    }
    return stored.accessToken; // stale and unrefreshable — let TikTok reject it explicitly
  }
  if (process.env.TIKTOK_ACCESS_TOKEN) return process.env.TIKTOK_ACCESS_TOKEN;
  throw new Error('TikTok not connected — use Connect TikTok in the dashboard (or set TIKTOK_ACCESS_TOKEN).');
}

// ── Meta (Facebook Page + Instagram Business) ──────────────────────────────

function metaAuthorizeUrl({ state, redirectUri }) {
  const id = process.env.META_APP_ID;
  if (!id || !process.env.META_APP_SECRET) {
    throw new Error('META_APP_ID / META_APP_SECRET missing — add the app credentials from developers.facebook.com first.');
  }
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    state,
    scope: META_SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${p}`;
}

async function metaExchangeCode({ code, redirectUri }) {
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;

  const short = await fetch(`${G}/oauth/access_token?` + new URLSearchParams({
    client_id: id, client_secret: secret, redirect_uri: redirectUri, code,
  })).then((r) => r.json());
  if (!short.access_token) throw new Error(`Meta code exchange failed: ${JSON.stringify(short.error || short)}`);

  const long = await fetch(`${G}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: id, client_secret: secret,
    fb_exchange_token: short.access_token,
  })).then((r) => r.json());
  const userToken = long.access_token || short.access_token;

  // Page tokens minted from a long-lived user token do not expire.
  const pages = await fetch(`${G}/me/accounts?` + new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,access_token,instagram_business_account{id,username}',
  })).then((r) => r.json());
  if (!pages.data || !pages.data.length) {
    throw new Error('No Facebook Pages found on this account. The logging-in user must have a role on the brand Page.');
  }
  const page = pages.data.find((p) => p.instagram_business_account) || pages.data[0];

  await saveApiToken('meta', {
    pageId: page.id,
    pageName: page.name,
    pageToken: page.access_token,
    igUserId: page.instagram_business_account ? page.instagram_business_account.id : null,
    igUsername: page.instagram_business_account ? page.instagram_business_account.username : null,
    pages: pages.data.map((p) => ({ id: p.id, name: p.name, igUserId: p.instagram_business_account ? p.instagram_business_account.id : null })),
    connectedAt: new Date().toISOString(),
  });
  return page;
}

// Posting credentials: stored OAuth connection first, env vars as fallback.
async function getMetaCreds() {
  let stored = null;
  try { stored = await getApiToken('meta'); } catch (_) { /* db not initialized */ }
  if (stored && stored.pageToken) {
    return { token: stored.pageToken, pageId: stored.pageId, igUserId: stored.igUserId };
  }
  return {
    token: process.env.META_ACCESS_TOKEN || null,
    pageId: process.env.META_PAGE_ID || null,
    igUserId: process.env.META_IG_USER_ID || null,
  };
}

// ── Status for the dashboard Connections card ──────────────────────────────
async function connectionStatus() {
  const tiktok = await getApiToken('tiktok');
  const meta = await getApiToken('meta');
  return {
    appsConfigured: {
      tiktok: Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
      meta: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    },
    tiktok: tiktok
      ? {
          connected: true,
          source: 'oauth',
          openId: tiktok.openId || null,
          scope: tiktok.scope || null,
          accessExpiresAt: tiktok.expiresAt ? new Date(tiktok.expiresAt).toISOString() : null,
          refreshExpiresAt: tiktok.refreshExpiresAt ? new Date(tiktok.refreshExpiresAt).toISOString() : null,
          autoRefresh: Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
        }
      : {
          connected: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
          source: process.env.TIKTOK_ACCESS_TOKEN ? 'env' : null,
          autoRefresh: false,
        },
    meta: meta
      ? {
          connected: true,
          source: 'oauth',
          pageId: meta.pageId,
          pageName: meta.pageName,
          igUserId: meta.igUserId,
          igUsername: meta.igUsername,
          connectedAt: meta.connectedAt,
        }
      : {
          connected: Boolean(process.env.META_ACCESS_TOKEN && (process.env.META_IG_USER_ID || process.env.META_PAGE_ID)),
          source: process.env.META_ACCESS_TOKEN ? 'env' : null,
          pageId: process.env.META_PAGE_ID || null,
          igUserId: process.env.META_IG_USER_ID || null,
        },
  };
}

module.exports = {
  tiktokAuthorizeUrl,
  tiktokExchangeCode,
  getTikTokAccessToken,
  metaAuthorizeUrl,
  metaExchangeCode,
  getMetaCreds,
  connectionStatus,
};
