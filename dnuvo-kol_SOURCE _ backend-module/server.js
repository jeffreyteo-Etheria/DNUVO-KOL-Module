// d.nuvo Pipeline Backend — Express server
// Endpoints: /verify-creator, /schedule, /post/tiktok, /post/meta, /kpi
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { verifyCreator } = require('./src/verifyCreator');
const { postTikTok } = require('./src/postTikTok');
const { postInstagram, postFacebook } = require('./src/postMeta');
const { sourceKolMultiActor } = require('./src/apifySource');
const {
  tiktokAuthorizeUrl,
  tiktokExchangeCode,
  metaAuthorizeUrl,
  metaExchangeCode,
  connectionStatus,
} = require('./src/connections');
const {
  initDb,
  getStorageMode,
  peekQuota,
  consumeQuota,
  createOauthState,
  consumeOauthState,
  saveAdvertiser,
  listAdvertisers,
  getAdvertiser,
  getAdvertiserByCode,
  deleteAdvertiser,
  saveCampaign,
  listCampaigns,
  getCampaign,
  deleteCampaign,
  logCampaignAudit,
  listCampaignAudit,
  saveKpiEntry,
  listKpiEntries,
  getLatestKpiEntry,
} = require('./src/db');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // dashboard at http://localhost:3000
const isServerless = Boolean(process.env.NETLIFY) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const runtimeDataDir = isServerless ? path.join(os.tmpdir(), 'dnuvo-data') : path.join(__dirname, 'data');
if (!fs.existsSync(runtimeDataDir)) fs.mkdirSync(runtimeDataDir, { recursive: true });
const SCHEDULE_FILE = path.join(runtimeDataDir, 'schedule.json');
const load = () => fs.existsSync(SCHEDULE_FILE) ? JSON.parse(fs.readFileSync(SCHEDULE_FILE)) : [];
const save = (d) => fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2));

// ── Access control ─────────────────────────────────────────────────────────
// Super admin sees every advertiser and campaign; an advertiser access code
// scopes all campaign data to that advertiser only.
const SUPER_ADMIN_CODE = process.env.SUPER_ADMIN_CODE || 'SOCIALMIND-MASTER';
// Pre-launch open access: requests without a code are treated as super admin.
// Set OPEN_ACCESS=false in the environment to re-enable the access-code gate.
const OPEN_ACCESS = process.env.OPEN_ACCESS !== 'false';

async function resolveAccess(req) {
  const code = String(req.headers['x-access-code'] || '').trim();
  if (!code) return OPEN_ACCESS ? { role: 'superadmin', advertiser: null } : null;
  if (code === SUPER_ADMIN_CODE) return { role: 'superadmin', advertiser: null };
  const advertiser = await getAdvertiserByCode(code);
  if (advertiser) return { role: 'advertiser', advertiser };
  return null;
}

async function requireAccess(req, res) {
  const access = await resolveAccess(req);
  if (!access) {
    res.status(401).json({ error: 'Access code required. Log in as super admin or advertiser.' });
    return null;
  }
  return access;
}

async function requireCampaignAccess(req, res, campaignId) {
  const access = await requireAccess(req, res);
  if (!access) return null;
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    res.status(404).json({ error: 'Campaign not found' });
    return null;
  }
  if (access.role !== 'superadmin' && campaign.advertiserId !== access.advertiser.id) {
    res.status(403).json({ error: 'This campaign belongs to another advertiser.' });
    return null;
  }
  return { access, campaign };
}

// ── Usage quotas (cost control for scraping / AI / verification) ───────────
// Every user gets a fixed budget per window; the paid API tools (Apify, Claude)
// sit behind these. Identity: the true super admin code is exempt, an advertiser
// code is one budget, and anonymous open-access visitors are keyed by the
// browser client id (falling back to IP). Override any limit via env.
const QUOTA_WINDOW_HOURS = Number(process.env.QUOTA_WINDOW_HOURS) || 12;
const QUOTA_WINDOW_MS = QUOTA_WINDOW_HOURS * 60 * 60 * 1000;
const QUOTAS = {
  kol_results:   { limit: Number(process.env.QUOTA_KOL_RESULTS) || 20,   label: 'KOL search results' },
  sourcing_runs: { limit: Number(process.env.QUOTA_SOURCING_RUNS) || 3,  label: 'KOL sourcing runs' },
  ai_calls:      { limit: Number(process.env.QUOTA_AI_CALLS) || 20,      label: 'AI generations' },
  verify_urls:   { limit: Number(process.env.QUOTA_VERIFY_URLS) || 40,   label: 'creator link checks' },
};

function quotaIdentity(req) {
  const code = String(req.headers['x-access-code'] || '').trim();
  if (code === SUPER_ADMIN_CODE) return null; // real super admin: no limits
  if (code) return `code:${code}`;
  const clientId = String(req.headers['x-client-id'] || '').trim().slice(0, 64);
  if (clientId) return `anon:${clientId}`;
  const fwd = String(req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.ip || '');
  return `ip:${fwd.split(',')[0].trim() || 'unknown'}`;
}

function quotaRejection(res, metric, result) {
  const q = QUOTAS[metric];
  const resetSgt = new Date(result.resetAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: false });
  res.status(429).json({
    error: `Usage limit reached: ${q.limit} ${q.label} per ${QUOTA_WINDOW_HOURS}h. Your allowance resets ${resetSgt} SGT.`,
    quota: { metric, ...result },
  });
}

// Consumes `amount` from the metric; on rejection writes the 429 and returns null.
async function requireQuota(req, res, metric, amount = 1) {
  const userKey = quotaIdentity(req);
  if (!userKey) return { exempt: true };
  const q = QUOTAS[metric];
  const result = await consumeQuota({ userKey, metric, amount, limit: q.limit, windowMs: QUOTA_WINDOW_MS });
  if (!result.allowed) {
    quotaRejection(res, metric, result);
    return null;
  }
  return result;
}

app.get('/quota', async (req, res) => {
  try {
    const userKey = quotaIdentity(req);
    if (!userKey) return res.json({ exempt: true, windowHours: QUOTA_WINDOW_HOURS, metrics: {} });
    const metrics = {};
    for (const [metric, q] of Object.entries(QUOTAS)) {
      metrics[metric] = {
        label: q.label,
        ...(await peekQuota({ userKey, metric, limit: q.limit, windowMs: QUOTA_WINDOW_MS })),
      };
    }
    res.json({ exempt: false, windowHours: QUOTA_WINDOW_HOURS, metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const code = String((req.body || {}).accessCode || '').trim();
    if (!code) {
      if (OPEN_ACCESS) return res.json({ role: 'superadmin', advertiser: null, openAccess: true });
      return res.status(400).json({ error: 'accessCode required' });
    }
    if (code === SUPER_ADMIN_CODE) return res.json({ role: 'superadmin', advertiser: null });
    const advertiser = await getAdvertiserByCode(code);
    if (advertiser) return res.json({ role: 'advertiser', advertiser });
    res.status(401).json({ error: 'Invalid access code' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', async (_, res) => {
  let dbOk = false;
  try {
    await listCampaigns();
    dbOk = true;
  } catch (_) {
    dbOk = false;
  }

  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    services: {
      backend: true,
      database: dbOk,
      storage: getStorageMode(),
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      apifyConfigured: Boolean(process.env.APIFY_TOKEN),
      tiktokConfigured: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
      metaConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    },
  });
});

function sgtToDate(date, time) {
  return new Date(`${date}T${time}:00+08:00`); // SGT
}

async function processQueuedPosts(now = new Date()) {
  const all = load();
  let processed = 0;
  for (const post of all) {
    if (post.status !== 'queued') continue;
    if (sgtToDate(post.date, post.time) > now) continue;
    processed += 1;
    try {
      if (post.platform === 'TikTok') post.result = await postTikTok(post);
      else if (post.platform === 'Instagram') post.result = await postInstagram(post);
      else if (post.platform === 'Facebook') post.result = await postFacebook(post);
      else {
        post.status = 'manual';
        post.note = `${post.platform}: post via Seller Centre (no public posting API)`;
        continue;
      }
      post.status = 'posted';
      post.postedAt = now.toISOString();
    } catch (e) {
      post.status = 'failed';
      post.error = e.message;
    }
  }
  save(all);
  return { processed, total: all.length };
}

// ── Creator link verification ─────────────────────────────────────────────
// POST /verify-creator { "urls": ["https://www.tiktok.com/@handle", ...] }
// Returns per-URL: live (HTTP 200), redirected, dead, or blocked.
app.post('/verify-creator', async (req, res) => {
  const urls = (req.body.urls || []).slice(0, 20); // hard cap per request
  if (!urls.length) return res.status(400).json({ error: 'urls[] required' });
  if (!(await requireQuota(req, res, 'verify_urls', urls.length))) return;
  const results = await Promise.all(urls.map(verifyCreator));
  res.json({ checkedAt: new Date().toISOString(), results });
});

// ── Apify multi-actor KOL sourcing ────────────────────────────────────────
app.post('/apify/kol-source', async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(500).json({ error: 'APIFY_TOKEN missing in .env' });

  const {
    campaignId,
    setup,
    tiers,
    backup = 5,
    maxResults = 40,
  } = req.body || {};

  if (!setup || !setup.loc || !Array.isArray(setup.platforms)) {
    return res.status(400).json({ error: 'setup with loc and platforms[] is required' });
  }

  // Quota: one sourcing run consumed up front; result count clamped to the
  // user's remaining KOL allowance so a single run can't drain the Apify budget.
  const userKey = quotaIdentity(req);
  let kolCap = maxResults;
  if (userKey) {
    if (!(await requireQuota(req, res, 'sourcing_runs', 1))) return;
    const kolQuota = await peekQuota({
      userKey, metric: 'kol_results',
      limit: QUOTAS.kol_results.limit, windowMs: QUOTA_WINDOW_MS,
    });
    if (!kolQuota.remaining) return quotaRejection(res, 'kol_results', kolQuota);
    kolCap = Math.min(Number(maxResults) || 40, kolQuota.remaining);
  }

  const actors = {
    discovery: process.env.APIFY_ACTOR_DISCOVERY || 'alizarin_refrigerator-owner/influencer-discovery---find-influencers-across-social-platforms',
    tiktok: process.env.APIFY_ACTOR_TIKTOK || 'alizarin_refrigerator-owner/tiktok-creator-scraper',
    instagram: process.env.APIFY_ACTOR_INSTAGRAM || 'seemuapps/instagram-related-profiles-scraper',
  };

  try {
    const out = await sourceKolMultiActor({ token, setup, tiers, backup, maxResults: kolCap, actors });
    const delivered = (out.shortlist?.length || 0) + (out.backups?.length || 0);
    let quota = null;
    if (userKey && delivered) {
      quota = await consumeQuota({
        userKey, metric: 'kol_results', amount: delivered,
        limit: QUOTAS.kol_results.limit, windowMs: QUOTA_WINDOW_MS, force: true,
      });
    }
    if (campaignId) {
      await logCampaignAudit({
        campaignId: Number(campaignId),
        action: 'apify_multi_source_run',
        details: {
          actorsUsed: out.actorsUsed,
          totalCandidates: out.totalCandidates,
          shortlist: out.shortlist.length,
          backups: out.backups.length,
        },
      });
    }
    res.json({
      sourcedAt: new Date().toISOString(),
      ...out,
      quota: quota ? { kolResults: { used: quota.used, limit: quota.limit, remaining: quota.remaining, resetAt: quota.resetAt } } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Advertisers (master network layer) ─────────────────────────────────────
app.get('/advertisers', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    if (access.role === 'superadmin') return res.json({ items: await listAdvertisers() });
    res.json({ items: [access.advertiser] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/advertisers', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    const { id, company, brand, logo } = req.body || {};
    if (!company || !brand) return res.status(400).json({ error: 'company and brand are required' });

    if (id) {
      // Only super admin may amend other advertisers; an advertiser may update its own profile.
      if (access.role !== 'superadmin' && access.advertiser.id !== Number(id)) {
        return res.status(403).json({ error: 'Only super admin can amend other advertisers.' });
      }
      await saveAdvertiser({ id: Number(id), company, brand, logo });
      return res.json({ saved: true, advertiser: await getAdvertiser(Number(id)) });
    }

    if (access.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only super admin can create new advertisers.' });
    }
    const newId = await saveAdvertiser({ company, brand, logo });
    res.json({ saved: true, advertiser: await getAdvertiser(newId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/advertisers/:id', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    if (access.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only super admin can delete advertisers.' });
    }
    const id = Number(req.params.id);
    const advertiser = await getAdvertiser(id);
    if (!advertiser) return res.status(404).json({ error: 'Advertiser not found' });
    const deleted = await deleteAdvertiser(id);
    res.json({ deleted, id, brand: advertiser.brand });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Campaign persistence (scoped by advertiser access) ─────────────────────
app.get('/campaigns', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    const scope = access.role === 'superadmin' ? null : access.advertiser.id;
    res.json({ items: await listCampaigns(scope), role: access.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id', async (req, res) => {
  try {
    const ctx = await requireCampaignAccess(req, res, Number(req.params.id));
    if (!ctx) return;
    res.json(ctx.campaign);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/campaigns/:id', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    if (access.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only super admin can delete campaigns. Campaigns remain in the repository until super admin deletion.' });
    }
    const id = Number(req.params.id);
    const campaign = await getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const deleted = await deleteCampaign(id);
    res.json({ deleted, id, name: campaign.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id/audit', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const ctx = await requireCampaignAccess(req, res, campaignId);
    if (!ctx) return;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const items = await listCampaignAudit(campaignId, limit);
    res.json({ campaignId, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/campaigns/:id/kpi', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const ctx = await requireCampaignAccess(req, res, campaignId);
    if (!ctx) return;
    const { spend = 0, revenue = 0, orders = 0, leads = 0, views = 0, clicks = 0, notes = '' } = req.body || {};
    const id = await saveKpiEntry({ campaignId, spend, revenue, orders, leads, views, clicks, notes });
    const latest = await getLatestKpiEntry(campaignId);
    await logCampaignAudit({
      campaignId,
      action: 'kpi_saved',
      details: { kpiEntryId: id, spend, revenue, orders, leads, views, clicks },
    });
    res.json({ saved: true, entry: latest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/campaigns/:id/kpi', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const ctx = await requireCampaignAccess(req, res, campaignId);
    if (!ctx) return;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 200));
    const latest = await getLatestKpiEntry(campaignId);
    const history = await listKpiEntries(campaignId, limit);
    res.json({ campaignId, latest, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/campaigns/save', async (req, res) => {
  try {
    const access = await requireAccess(req, res);
    if (!access) return;
    const { id, name, status, snapshot, advertiserId } = req.body || {};
    if (!snapshot || !snapshot.setup) {
      return res.status(400).json({ error: 'snapshot.setup is required' });
    }

    // Every campaign is filed under an advertiser in the repository.
    let ownerAdvertiserId;
    if (access.role === 'superadmin') {
      ownerAdvertiserId = Number(advertiserId) || null;
      if (!id && !ownerAdvertiserId) {
        return res.status(400).json({ error: 'Super admin must select an advertiser before saving a new campaign.' });
      }
    } else {
      ownerAdvertiserId = access.advertiser.id;
    }

    if (id) {
      const existing = await getCampaign(Number(id));
      if (!existing) return res.status(404).json({ error: 'Campaign not found' });
      if (access.role !== 'superadmin' && existing.advertiserId !== access.advertiser.id) {
        return res.status(403).json({ error: 'Only super admin can amend campaigns of another advertiser.' });
      }
    }

    const campaignId = await saveCampaign({
      id,
      advertiserId: ownerAdvertiserId,
      name,
      status,
      setup: snapshot.setup,
      creators: snapshot.creators,
      content: snapshot.content,
      budget: snapshot.budget,
      schedule: snapshot.schedule,
      verifications: snapshot.verifications,
    });
    await logCampaignAudit({
      campaignId,
      action: id ? 'campaign_updated' : 'campaign_created',
      actor: access.role === 'superadmin' ? 'superadmin' : `advertiser:${access.advertiser.brand}`,
      details: {
        name,
        status,
        setupReady: Boolean(snapshot?.setup),
        creatorsReady: Boolean(snapshot?.creators),
        contentBlocks: Array.isArray(snapshot?.content) ? snapshot.content.length : 0,
        scheduleRows: Array.isArray(snapshot?.schedule) ? snapshot.schedule.length : 0,
      },
    });
    const campaign = await getCampaign(campaignId);
    res.json({ saved: true, campaign });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI proxy (keeps API keys server-side) ──────────────────────────────────
app.post('/ai/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing in .env' });
  }
  const { prompt, system, maxTokens } = req.body || {};
  if (!prompt || !system) {
    return res.status(400).json({ error: 'prompt and system are required' });
  }
  if (!(await requireQuota(req, res, 'ai_calls', 1))) return;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.max(200, Math.min(Number(maxTokens) || 1000, 2000)),
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || 'AI request failed', raw: data });
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Schedule CRUD (accepts CSV rows exported from the dashboard) ──────────
app.post('/schedule', (req, res) => {
  const posts = req.body.posts || [];
  const all = load();
  posts.forEach(p => all.push({ ...p, id: Date.now() + Math.random(), status: 'queued' }));
  save(all);
  if (req.body.campaignId) {
    logCampaignAudit({
      campaignId: Number(req.body.campaignId),
      action: 'schedule_queued',
      details: { queued: posts.length },
    }).catch(() => {});
  }
  res.json({ queued: posts.length, total: all.length });
});
app.get('/schedule', (_, res) => res.json(load()));

app.get('/schedule/summary', (_, res) => {
  const items = load();
  const counts = items.reduce((acc, post) => {
    const k = post.status || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const queued = items
    .filter((p) => p.status === 'queued')
    .sort((a, b) => sgtToDate(a.date, a.time) - sgtToDate(b.date, b.time));
  res.json({
    total: items.length,
    counts,
    nextQueuedPost: queued[0] || null,
    checkedAt: new Date().toISOString(),
  });
});

// Real posting to connected brand accounts is super-admin only: in open-access
// mode anyone can reach the dashboard, but only the true code triggers posts.
// (scheduler.js is unaffected — it calls the posting functions in-process.)
function requireSuperCode(req, res) {
  const code = String(req.headers['x-access-code'] || '').trim();
  if (code === SUPER_ADMIN_CODE) return true;
  res.status(403).json({ error: 'Publishing to connected accounts requires the super admin access code. Log in with it via the gate to run posts.' });
  return false;
}

app.post('/schedule/process-now', async (req, res) => {
  if (!requireSuperCode(req, res)) return;
  const result = await processQueuedPosts(new Date());
  res.json({ ...result, runAt: new Date().toISOString() });
});

// ── Direct post endpoints (used by scheduler.js or manually) ──────────────
app.post('/post/tiktok', async (req, res) => {
  if (!requireSuperCode(req, res)) return;
  try { res.json(await postTikTok(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/post/meta', async (req, res) => {
  if (!requireSuperCode(req, res)) return;
  try {
    const { platform } = req.body; // "instagram" | "facebook"
    const fn = platform === 'facebook' ? postFacebook : postInstagram;
    res.json(await fn(req.body));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Platform connections (TikTok / Meta OAuth) ─────────────────────────────
// Flow: super admin clicks Connect → /connect/:provider/start returns the
// authorize URL → platform redirects to /connect/:provider/callback → tokens
// stored in the repository DB. Callbacks are public but CSRF-state-validated.

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

app.get('/connections', async (req, res) => {
  if (!requireSuperCode(req, res)) return;
  try {
    res.json(await connectionStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/connect/:provider/start', async (req, res) => {
  if (!requireSuperCode(req, res)) return;
  const provider = req.params.provider;
  if (provider !== 'tiktok' && provider !== 'meta') return res.status(400).json({ error: 'provider must be tiktok or meta' });
  try {
    const redirectUri = `${requestBaseUrl(req)}/connect/${provider}/callback`;
    const state = await createOauthState(provider);
    const url = provider === 'tiktok'
      ? tiktokAuthorizeUrl({ state, redirectUri })
      : metaAuthorizeUrl({ state, redirectUri });
    res.json({ url, redirectUri });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/connect/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const back = (msg, ok) => res.redirect(`/?connect_${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`);
  if (provider !== 'tiktok' && provider !== 'meta') return back('Unknown provider', false);
  const { code, state, error, error_description: errorDescription } = req.query || {};
  if (error) return back(`${provider}: ${errorDescription || error}`, false);
  if (!code || !state) return back(`${provider}: missing code/state in callback`, false);
  try {
    if (!(await consumeOauthState(String(state), provider))) {
      return back(`${provider}: state check failed — start the connect flow again from the dashboard`, false);
    }
    const redirectUri = `${requestBaseUrl(req)}/connect/${provider}/callback`;
    if (provider === 'tiktok') {
      await tiktokExchangeCode({ code: String(code), redirectUri });
      return back('TikTok connected — tokens stored and auto-refreshing', true);
    }
    const page = await metaExchangeCode({ code: String(code), redirectUri });
    return back(`Meta connected — Page "${page.name}"${page.instagram_business_account ? ' + Instagram' : ' (no IG business account linked)'}`, true);
  } catch (e) {
    return back(`${provider}: ${e.message}`, false);
  }
});

// ── KPI pull stubs (fill after API approval) ──────────────────────────────
app.get('/kpi/tiktok', async (_, res) => {
  // TikTok Business API: /v2/video/list + /v2/research endpoints once approved
  res.json({ note: 'Requires approved TikTok API scopes: video.list. See API-APPLICATION-GUIDE.md' });
});
app.get('/kpi/meta', async (_, res) => {
  // Graph API insights: /{ig-user-id}/insights, /{page-id}/insights
  res.json({ note: 'Requires instagram_manage_insights + read_insights permissions.' });
});

let initPromise;
function ensureInitialized() {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

if (require.main === module) {
  ensureInitialized()
    .then(() => {
      app.listen(process.env.PORT || 3000, () =>
        console.log(`d.nuvo backend running on :${process.env.PORT || 3000}`));
    })
    .catch((e) => {
      console.error('Failed to initialize SQLite DB:', e.message);
      process.exit(1);
    });
}

module.exports = { app, ensureInitialized };
